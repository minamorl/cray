import fc from 'fast-check';
import { lay } from '@minamorl/lay';
import { branch, cray, else_, parallel, Cray, Result } from '../src/core';
import { compile, execute, Graph } from '../src/graph';
import { toMermaid } from '../src/graphViz';

type NumState = number;
type NumError = unknown;
type NumCray = Cray<NumState, NumError>;

type NumResult = Result<NumState, NumError>;

const simpleStepArb = fc
  .tuple(fc.integer({ min: -5, max: 5 }), fc.boolean())
  .map<NumCray>(([delta, asyncFn]) => {
    const fn = (state: NumState) => state + delta;
    return cray<NumState, NumError>(
      asyncFn
        ? async (focus) => await Promise.resolve(fn(focus.get()))
        : (focus) => fn(focus.get()),
    );
  });

const sequentialArb = fc.array(simpleStepArb, { minLength: 1, maxLength: 5 });

async function runSequential(
  steps: readonly NumCray[],
  initial: NumState,
): Promise<NumResult> {
  return cray<NumState, NumError>([...steps])(lay(initial));
}

function allEdges<S, E>(graph: Graph<S, E>): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  for (const node of graph.nodes.values()) {
    for (const edge of node.succ) {
      edges.push([node.id, edge.target]);
    }
  }
  return edges;
}

function hasCycle<S, E>(graph: Graph<S, E>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    const node = graph.nodes.get(id);
    if (node) {
      for (const edge of node.succ) {
        if (visit(edge.target)) {
          return true;
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return visit(graph.entry);
}

describe('graph compilation and execution', () => {
  test('sequential cray steps execute identically', async () => {
    await fc.assert(
      fc.asyncProperty(sequentialArb, fc.integer(), async (steps, initial) => {
        const graph = compile(steps);
        const graphResult = await execute(graph, initial);
        const sequentialResult = await runSequential(steps, initial);
        expect(graphResult).toEqual(sequentialResult);
      }),
    );
  });

  test('branch nodes route according to predicates', async () => {
    const choose = branch<NumState, NumError>()
      .when(
        async (focus) => await Promise.resolve(focus.get() > 10),
        () => 99,
      )
      .when(
        (focus) => focus.get() > 5,
        () => 50,
      )
      .otherwise(() => 0);

    const graph = compile([choose]);
    const nine = await execute(graph, 9);
    const two = await execute(graph, 2);

    expect(nine.ok && nine.state).toBe(50);
    expect(two.ok && two.state).toBe(0);
  });

  test('else nodes recover from error states', async () => {
    const failing = cray<NumState, unknown>(() => {
      throw new Error('boom');
    });

    const recovered = else_<NumState, unknown>(async (error) => {
      expect(error).toBeInstanceOf(Error);
      return await Promise.resolve(5);
    }, failing);

    const graph = compile([recovered]);
    const result = await execute(graph, 0);

    expect(result.ok && result.state).toBe(5);
  });

  test('parallel nodes aggregate child results', async () => {
    const inc = cray<NumState, NumError>((focus) => focus.get() + 1);
    const dbl = cray<NumState, NumError>((focus) => focus.get() * 2);
    const fan = parallel([inc, dbl]);
    const graph = compile([fan]);
    const result = await execute(graph, 3);

    expect(result.ok && result.state).toBe(6);
  });

  test('observation hooks trigger per node', async () => {
    const inc = cray<NumState, NumError>((focus) => focus.get() + 1);
    const dbl = cray<NumState, NumError>((focus) => focus.get() * 2);
    const graph = compile([inc, dbl]);

    const starts: string[] = [];
    const ends: string[] = [];
    const errors: string[] = [];

    await execute(graph, 1, {
      onStart: (node) => {
        starts.push(node.id);
      },
      onEnd: (node) => {
        ends.push(node.id);
      },
      onError: (node) => {
        errors.push(node.id);
      },
    });

    expect(starts).toEqual(ends);
    expect(errors).toHaveLength(0);
    expect(starts.length).toBeGreaterThan(0);
  });
});

describe('graph structural properties', () => {
  test('toMermaid renders with edge labels', () => {
    const inc = cray<NumState, NumError>((focus) => focus.get() + 1);
    const graph = compile([inc]);
    const mermaid: string = toMermaid<NumState, NumError>(graph);
    expect(mermaid).toContain('graph TD');
    expect(mermaid.includes('n0')).toBe(true);
  });

  test('compiled graphs are acyclic', async () => {
    await fc.assert(
      fc.asyncProperty(sequentialArb, fc.integer(), async (steps, initial) => {
        const graph = compile(steps);
        expect(hasCycle(graph)).toBe(false);
        await execute(graph, initial);
      }),
    );
  });

  test('graph edges reference known nodes', () => {
    const inc = cray<NumState, NumError>((focus) => focus.get() + 1);
    const dbl = cray<NumState, NumError>((focus) => focus.get() * 2);
    const graph = compile([inc, dbl]);
    for (const [from, to] of allEdges(graph)) {
      expect(graph.nodes.has(from)).toBe(true);
      expect(graph.nodes.has(to)).toBe(true);
    }
  });
});

describe('Focus integration in graph execution', () => {
  test('execute accepts Focus directly', async () => {
    const inc = cray<NumState, NumError>((focus) => focus.get() + 1);
    const graph = compile([inc]);

    const focus = lay(5);
    const result = await execute(graph, focus);

    expect(result.ok && result.state).toBe(6);
    // Focus should be updated
    expect(focus.get()).toBe(6);
  });

  test('shared Focus maintains state across sequential steps', async () => {
    const inc = cray<NumState, NumError>((focus) => focus.get() + 1);
    const dbl = cray<NumState, NumError>((focus) => focus.get() * 2);
    const graph = compile([inc, dbl]);

    const focus = lay(3);
    const result = await execute(graph, focus);

    // (3 + 1) * 2 = 8
    expect(result.ok && result.state).toBe(8);
    expect(focus.get()).toBe(8);
  });

  test('Focus reflects can observe state changes during execution', async () => {
    type State = { count: number };
    const observed: State[] = [];

    const inc = cray<State, unknown>((focus) => ({
      count: focus.get().count + 1,
    }));
    const dbl = cray<State, unknown>((focus) => ({
      count: focus.get().count * 2,
    }));
    const graph = compile([inc, dbl]);

    const focus = lay<State>({ count: 1 });

    // Subscribe to root focus changes (not using() child focus)
    const unsubscribe = focus.reflect((value) => {
      observed.push(value);
    });

    await execute(graph, focus);
    unsubscribe();

    // reflect fires after inc (2), then after dbl (4) - not on initial subscribe
    expect(observed.map((s) => s.count)).toEqual([2, 4]);
  });
});
