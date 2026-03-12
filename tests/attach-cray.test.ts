import { cray } from '../src/index';
import { attachCray } from '../src/attach-cray';

// Test types
interface MockEvent {
  type: string;
  id?: string;
  value?: unknown;
}

interface MockSubscriber {
  (ev: MockEvent): void;
}

class MockRoot {
  private currentState: Record<string, unknown> = {};
  private subscribers = new Set<MockSubscriber>();

  commit(input: MockEvent): void {
    if (input.type) {
      this.applyEvent(input);
      // Notify subscribers immediately
      this.subscribers.forEach((fn) => fn(input));
    }
  }

  private applyEvent(event: MockEvent): void {
    switch (event.type) {
      case 'Create':
      case 'Update':
        if (event.id) {
          this.currentState[event.id] = event.value;
        }
        break;
      case 'Delete':
        if (event.id) {
          delete this.currentState[event.id];
        }
        break;
    }
  }

  state(): Record<string, unknown> {
    return { ...this.currentState };
  }

  subscribe(fn: MockSubscriber): () => void {
    this.subscribers.add(fn);
    // Send initial snapshot
    fn({ type: 'Snapshot' });
    return () => {
      this.subscribers.delete(fn);
    };
  }

  // Mock methods to satisfy interface
  history() {
    return [];
  }
  undo() {}
  redo() {}
  compact() {}
}

const createTestRoot = () => new MockRoot();

// Helper to wait for async operations
const waitForAsync = (ms = 10) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Type helper for tests
const asRoot = (mockRoot: MockRoot) =>
  mockRoot as unknown as import('@minamorl/root-core').Root;

describe('attachCray', () => {
  describe('Basic Functionality', () => {
    it('should return unsubscribe function', () => {
      const root = createTestRoot();
      const workflow = cray(() => ({ ok: true, state: {} }));

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
      });

      expect(typeof unsubscribe).toBe('function');
      unsubscribe(); // Clean up
    });

    it('should execute workflow when Root state changes', async () => {
      const root = createTestRoot();
      let executionCount = 0;

      const workflow = cray(() => {
        executionCount++;
        return { ok: true, state: { computed: 'result' } };
      });

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
      });

      root.commit({ type: 'Create', id: 'test', value: 'data' });
      await waitForAsync();

      expect(executionCount).toBe(1);
      unsubscribe();
    });

    it('should stop executing after unsubscribe', async () => {
      const root = createTestRoot();
      let executionCount = 0;

      const workflow = cray(() => {
        executionCount++;
        return { ok: true, state: {} };
      });

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
      });
      unsubscribe();

      root.commit({ type: 'Create', id: 'test', value: 'data' });
      await waitForAsync();

      expect(executionCount).toBe(0);
    });
  });

  describe('runOnSubscribe Option', () => {
    it('should execute workflow on initial subscription when runOnSubscribe is true', async () => {
      const root = createTestRoot();
      root.commit({ type: 'Create', id: 'initial', value: 'data' });

      let executionCount = 0;
      const workflow = cray(() => {
        executionCount++;
        return { ok: true, state: {} };
      });

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
        runOnSubscribe: true,
      });

      await waitForAsync();
      expect(executionCount).toBe(1);
      unsubscribe();
    });

    it('should not execute workflow on initial subscription by default', async () => {
      const root = createTestRoot();
      root.commit({ type: 'Create', id: 'initial', value: 'data' });

      let executionCount = 0;
      const workflow = cray(() => {
        executionCount++;
        return { ok: true, state: {} };
      });

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
      });

      await waitForAsync();
      expect(executionCount).toBe(0);
      unsubscribe();
    });
  });

  describe('Result Commit', () => {
    it('should commit workflow result to Root', async () => {
      const root = createTestRoot();
      const workflow = cray(() => ({
        ok: true,
        state: { result: 'computed' },
      }));

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
      });
      root.commit({ type: 'Create', id: 'trigger', value: 'data' });

      await waitForAsync();
      const state = root.state();
      expect(state.computed).toEqual({ result: 'computed' });
      unsubscribe();
    });

    it('should commit to custom target', async () => {
      const root = createTestRoot();
      const workflow = cray(() => ({
        ok: true,
        state: { result: 'computed' },
      }));

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
        target: 'custom',
      });
      root.commit({ type: 'Create', id: 'trigger', value: 'data' });

      await waitForAsync();
      const state = root.state();
      expect(state.custom).toEqual({ result: 'computed' });
      unsubscribe();
    });
  });

  describe('Error Handling', () => {
    it('should call onError callback when workflow fails', async () => {
      const root = createTestRoot();
      const workflow = cray(() => ({
        ok: false,
        state: { test: 'data' },
        error: 'test error',
      }));

      let errorCalled = false;
      const onError = (error: unknown, state: unknown) => {
        errorCalled = true;
        expect(error).toBe('test error');
        expect(state).toEqual({ test: 'data' });
      };

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
        onError,
      });
      root.commit({ type: 'Create', id: 'trigger', value: 'data' });

      await waitForAsync();
      expect(errorCalled).toBe(true);
      unsubscribe();
    });

    it('should commit error when commitError is true', async () => {
      const root = createTestRoot();
      const workflow = cray(() => ({
        ok: false,
        state: {},
        error: 'test error',
      }));

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
        commitError: true,
      });
      root.commit({ type: 'Create', id: 'trigger', value: 'data' });

      await waitForAsync();
      const state = root.state();
      expect(state['workflow:error']).toBeDefined();
      expect((state['workflow:error'] as Record<string, unknown>).error).toBe(
        'test error',
      );
      unsubscribe();
    });
  });

  describe('Debounce Functionality', () => {
    it('should debounce rapid state changes', async () => {
      const root = createTestRoot();
      let executionCount = 0;
      const workflow = cray(() => {
        executionCount++;
        return { ok: true, state: {} };
      });

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (state) => state,
        debounce: 20,
      });

      root.commit({ type: 'Create', id: 'test1', value: 'data1' });
      root.commit({ type: 'Update', id: 'test1', value: 'data2' });
      root.commit({ type: 'Update', id: 'test1', value: 'data3' });

      await waitForAsync(5);
      expect(executionCount).toBe(0);

      await waitForAsync(30);
      expect(executionCount).toBe(1);
      unsubscribe();
    });
  });

  describe('Concurrent Updates', () => {
    it('should process latest state when updates occur during execution', async () => {
      const root = createTestRoot();
      const workflow = cray<{ count: number }, unknown>(async (focus) => {
        await waitForAsync(20);
        return { ok: true, state: focus.get() };
      });

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (rootState) => ({
          count: (rootState.count as number) ?? 0,
        }),
        runOnSubscribe: true,
      });

      root.commit({ type: 'Update', id: 'count', value: 1 });
      setTimeout(() => {
        root.commit({ type: 'Update', id: 'count', value: 2 });
      }, 5);

      await waitForAsync(50);

      const state = root.state();
      expect((state.computed as { count: number }).count).toBe(2);
      unsubscribe();
    });
  });

  describe('Type Safety & Semantic Correctness', () => {
    it('should handle type-safe state transformation', async () => {
      interface TestState {
        count: number;
        name: string;
      }

      const root = createTestRoot();
      root.commit({ type: 'Create', id: 'count', value: 42 });
      root.commit({ type: 'Create', id: 'name', value: 'test' });

      const workflow = cray<
        { doubled: number; count: number; name: string },
        unknown
      >((focus) => {
        const state = focus.get();
        return {
          ok: true,
          state: { ...state, doubled: state.count * 2 },
        };
      });

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: (rootState) => ({
          count: (rootState.count as number) ?? 0,
          name: (rootState.name as string) ?? '',
          doubled: 0,
        }),
      });

      root.commit({ type: 'Update', id: 'count', value: 50 });
      await waitForAsync();

      const state = root.state();
      expect((state.computed as Record<string, unknown>).doubled).toBe(100);
      unsubscribe();
    });

    it('should handle state transformation errors', async () => {
      const root = createTestRoot();
      const workflow = cray<Record<string, unknown>, unknown>((focus) => ({
        ok: true,
        state: focus.get(),
      }));

      let errorCalled = false;
      const onError = () => {
        errorCalled = true;
      };

      const unsubscribe = attachCray(asRoot(root), workflow, {
        stateTransform: () => {
          throw new Error('Transform error');
        },
        onError,
        commitError: true,
      });

      root.commit({ type: 'Create', id: 'test', value: 'data' });
      await waitForAsync();

      expect(errorCalled).toBe(true);
      const state = root.state();
      expect(state['workflow:error']).toBeDefined();
      unsubscribe();
    });
  });
});
