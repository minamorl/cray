import { lay, Focus } from '@minamorl/lay';
import { cray, Cray, Result, parallel, elseCray, branch } from '../src/core';

// New Focus-based API tests

describe('Focus-based Cray API', () => {
  describe('basic operations', () => {
    it('should receive Focus as argument and read state', async () => {
      const task: Cray<{ count: number }> = cray((focus) => {
        const count = focus.get().count;
        return { count: count + 1 };
      });

      const state = lay({ count: 0 });
      const result = await task(state);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.count).toBe(1);
      }
    });

    it('should allow focus.set() to modify state', async () => {
      const task: Cray<{ value: string }> = cray((focus) => {
        focus.set({ value: 'modified' });
      });

      const state = lay({ value: 'initial' });
      const result = await task(state);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.value).toBe('modified');
      }
    });

    it('should allow focus.using() for nested updates', async () => {
      type State = { user: { name: string; age: number } };

      const task: Cray<State> = cray((focus) => {
        focus.using('user').using('age').set(31);
      });

      const state = lay<State>({ user: { name: 'Alice', age: 30 } });
      const result = await task(state);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.user.age).toBe(31);
        expect(result.state.user.name).toBe('Alice');
      }
    });

    it('should allow focus.update() for functional updates', async () => {
      const task: Cray<{ count: number }> = cray((focus) => {
        focus.using('count').update((c) => c * 2);
      });

      const state = lay({ count: 5 });
      const result = await task(state);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.count).toBe(10);
      }
    });
  });

  describe('sequence with Focus', () => {
    it('should pass same Focus through sequence', async () => {
      type State = { steps: string[] };

      const step1: Cray<State> = cray((focus) => {
        focus.using('steps').update((s) => [...s, 'step1']);
      });

      const step2: Cray<State> = cray((focus) => {
        focus.using('steps').update((s) => [...s, 'step2']);
      });

      const sequence = cray<State>([step1, step2]);
      const state = lay<State>({ steps: [] });
      const result = await sequence(state);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.steps).toEqual(['step1', 'step2']);
      }
    });

    it('should accumulate state changes across steps', async () => {
      const increment: Cray<{ count: number }> = cray((focus) => {
        focus.using('count').update((c) => c + 1);
      });

      const sequence = cray<{ count: number }>([
        increment,
        increment,
        increment,
      ]);
      const state = lay({ count: 0 });
      const result = await sequence(state);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.count).toBe(3);
      }
    });
  });

  describe('error handling with Focus', () => {
    it('should capture errors and preserve state', async () => {
      const failing: Cray<{ value: number }, Error> = cray((focus) => {
        focus.using('value').set(42);
        throw new Error('boom');
      });

      const state = lay({ value: 0 });
      const result = await failing(state);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('boom');
        expect(result.state.value).toBe(42); // state was modified before error
      }
    });

    it('should recover with elseCray', async () => {
      const failing: Cray<{ value: number }, Error> = cray<
        { value: number },
        Error
      >(() => {
        throw new Error('fail');
      });

      const recovered = elseCray<{ value: number }, Error>((error, focus) => {
        return { value: focus.get().value + 100 };
      }, failing);

      const state = lay({ value: 5 });
      const result = await recovered(state);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.value).toBe(105);
      }
    });
  });

  describe('parallel with Focus', () => {
    it('should run tasks in parallel with shared Focus', async () => {
      type State = { a: number; b: number };

      const taskA: Cray<State> = cray((focus) => {
        focus.using('a').set(10);
      });

      const taskB: Cray<State> = cray((focus) => {
        focus.using('b').set(20);
      });

      const parallelTask = parallel<State>([taskA, taskB]);
      const state = lay<State>({ a: 0, b: 0 });
      const result = await parallelTask(state);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Both modifications should be visible
        expect(result.state.a).toBe(10);
        expect(result.state.b).toBe(20);
      }
    });
  });

  describe('branch with Focus', () => {
    it('should evaluate predicates using focus.get()', async () => {
      type State = { value: number };

      const task = branch<State>()
        .when(
          (focus) => focus.get().value > 10,
          (focus) => {
            focus.using('value').set(100);
          },
        )
        .when(
          (focus) => focus.get().value > 5,
          (focus) => {
            focus.using('value').set(50);
          },
        )
        .otherwise((focus) => {
          focus.using('value').set(0);
        });

      const state = lay<State>({ value: 7 });
      const result = await task(state);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.value).toBe(50);
      }
    });
  });

  describe('edge cases', () => {
    describe('null and undefined handling', () => {
      it('should handle null state values', async () => {
        type State = { value: string | null };
        const task: Cray<State> = cray((focus) => {
          focus.using('value').set(null);
        });

        const state = lay<State>({ value: 'initial' });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.value).toBe(null);
        }
      });

      it('should handle undefined state values', async () => {
        type State = { value: string | undefined };
        const task: Cray<State> = cray((focus) => {
          focus.using('value').set(undefined);
        });

        const state = lay<State>({ value: 'initial' });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.value).toBe(undefined);
        }
      });

      it('should handle deeply nested null', async () => {
        type State = { a: { b: { c: string | null } } };
        const task: Cray<State> = cray((focus) => {
          focus.using('a').using('b').using('c').set(null);
        });

        const state = lay<State>({ a: { b: { c: 'value' } } });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.a.b.c).toBe(null);
        }
      });
    });

    describe('array handling', () => {
      it('should handle array push via update', async () => {
        type State = { items: number[] };
        const task: Cray<State> = cray((focus) => {
          focus.using('items').update((items) => [...items, 4]);
        });

        const state = lay<State>({ items: [1, 2, 3] });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.items).toEqual([1, 2, 3, 4]);
        }
      });

      it('should handle array index access with using', async () => {
        type State = { items: string[] };
        const task: Cray<State> = cray((focus) => {
          focus.using('items').using(0).set('modified');
        });

        const state = lay<State>({ items: ['a', 'b', 'c'] });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.items).toEqual(['modified', 'b', 'c']);
        }
      });

      it('should handle empty array', async () => {
        type State = { items: number[] };
        const task: Cray<State> = cray((focus) => {
          focus.using('items').set([]);
        });

        const state = lay<State>({ items: [1, 2, 3] });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.items).toEqual([]);
        }
      });
    });

    describe('sequence edge cases', () => {
      it('should handle empty sequence', async () => {
        type State = { value: number };
        const emptySequence = cray<State>([]);

        const state = lay<State>({ value: 42 });
        const result = await emptySequence(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.value).toBe(42);
        }
      });

      it('should stop sequence on first error', async () => {
        type State = { steps: string[] };
        const step1: Cray<State, Error> = cray((focus) => {
          focus.using('steps').update((s) => [...s, 'step1']);
        });

        const failingStep: Cray<State, Error> = cray((focus) => {
          focus.using('steps').update((s) => [...s, 'failing']);
          throw new Error('stopped');
        });

        const step3: Cray<State, Error> = cray((focus) => {
          focus.using('steps').update((s) => [...s, 'step3']);
        });

        const sequence = cray<State, Error>([step1, failingStep, step3]);
        const state = lay<State>({ steps: [] });
        const result = await sequence(state);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.state.steps).toEqual(['step1', 'failing']);
          // step3 should NOT have run
          expect(result.state.steps).not.toContain('step3');
        }
      });

      it('should handle deeply nested sequences', async () => {
        type State = { count: number };
        const inc: Cray<State> = cray((focus) => {
          focus.using('count').update((c) => c + 1);
        });

        const innerSeq = cray<State>([inc, inc]);
        const outerSeq = cray<State>([innerSeq, innerSeq, inc]);

        const state = lay<State>({ count: 0 });
        const result = await outerSeq(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.count).toBe(5);
        }
      });
    });

    describe('parallel edge cases', () => {
      it('should handle empty parallel', async () => {
        type State = { value: number };
        const emptyParallel = parallel<State>([]);

        const state = lay<State>({ value: 42 });
        const result = await emptyParallel(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.value).toBe(42);
        }
      });

      it('should handle all tasks failing in parallel', async () => {
        type State = { value: number };
        const fail1: Cray<State, Error> = cray<State, Error>(() => {
          throw new Error('fail1');
        });
        const fail2: Cray<State, Error> = cray<State, Error>(() => {
          throw new Error('fail2');
        });

        const parallelTask = parallel<State, Error>([fail1, fail2]);
        const state = lay<State>({ value: 0 });
        const result = await parallelTask(state);

        expect(result.ok).toBe(false);
      });

      it('should handle mixed success/failure in parallel', async () => {
        type State = { a: number; b: number };
        const success: Cray<State, Error> = cray((focus) => {
          focus.using('a').set(100);
        });
        const failure: Cray<State, Error> = cray<State, Error>(() => {
          throw new Error('failed');
        });

        const parallelTask = parallel<State, Error>([success, failure]);
        const state = lay<State>({ a: 0, b: 0 });
        const result = await parallelTask(state);

        // Should return last success
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.a).toBe(100);
        }
      });

      it('should handle parallel with custom reducer', async () => {
        type State = { values: number[] };
        const task1: Cray<State> = cray((focus) => {
          focus.using('values').update((v) => [...v, 1]);
        });
        const task2: Cray<State> = cray((focus) => {
          focus.using('values').update((v) => [...v, 2]);
        });

        const reducer = (
          acc: Result<State>,
          curr: Result<State>,
        ): Result<State> => {
          if (!acc.ok) return curr;
          if (!curr.ok) return acc;
          return {
            ok: true,
            state: {
              values: [...acc.state.values, ...curr.state.values],
            },
          };
        };

        const parallelTask = parallel<State>([task1, task2], reducer);
        const state = lay<State>({ values: [] });
        const result = await parallelTask(state);

        expect(result.ok).toBe(true);
      });
    });

    describe('branch edge cases', () => {
      it('should handle async predicates', async () => {
        type State = { value: number };
        const task = branch<State>()
          .when(
            async (focus) => {
              await new Promise((r) => setTimeout(r, 10));
              return focus.get().value > 50;
            },
            (focus) => focus.using('value').set(100),
          )
          .otherwise((focus) => focus.using('value').set(0));

        const state = lay<State>({ value: 60 });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.value).toBe(100);
        }
      });

      it('should handle many branches', async () => {
        type State = { value: number };
        const task = branch<State>()
          .when(
            (f) => f.get().value === 1,
            (f) => f.using('value').set(10),
          )
          .when(
            (f) => f.get().value === 2,
            (f) => f.using('value').set(20),
          )
          .when(
            (f) => f.get().value === 3,
            (f) => f.using('value').set(30),
          )
          .when(
            (f) => f.get().value === 4,
            (f) => f.using('value').set(40),
          )
          .when(
            (f) => f.get().value === 5,
            (f) => f.using('value').set(50),
          )
          .otherwise((f) => f.using('value').set(-1));

        const state = lay<State>({ value: 4 });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.value).toBe(40);
        }
      });

      it('should handle predicate throwing error', async () => {
        type State = { value: number };
        const task = branch<State, Error>()
          .when(
            () => {
              throw new Error('predicate error');
            },
            (f) => f.using('value').set(100),
          )
          .otherwise((f) => f.using('value').set(0));

        const state = lay<State>({ value: 50 });

        await expect(task(state)).rejects.toThrow('predicate error');
      });
    });

    describe('error recovery edge cases', () => {
      it('should handle recovery that also throws', async () => {
        type State = { value: number };
        const failing: Cray<State, Error> = cray<State, Error>(() => {
          throw new Error('original');
        });

        const badRecovery = elseCray<State, Error>(() => {
          throw new Error('recovery failed');
        }, failing);

        const state = lay<State>({ value: 0 });
        const result = await badRecovery(state);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toBe('recovery failed');
        }
      });

      it('should chain multiple elseCray handlers', async () => {
        type State = { attempts: number };
        const failing: Cray<State, Error> = cray<State, Error>((focus) => {
          focus.using('attempts').update((a) => a + 1);
          throw new Error('fail');
        });

        const recovered = elseCray<State, Error>(
          () => ({ attempts: 100 }),
          elseCray<State, Error>(() => {
            throw new Error('still failing');
          }, failing),
        );

        const state = lay<State>({ attempts: 0 });
        const result = await recovered(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.attempts).toBe(100);
        }
      });
    });

    describe('async step edge cases', () => {
      it('should handle async steps with delays', async () => {
        type State = { log: string[] };
        const asyncStep = (msg: string, delay: number): Cray<State> =>
          cray(async (focus) => {
            await new Promise((r) => setTimeout(r, delay));
            focus.using('log').update((l) => [...l, msg]);
          });

        const sequence = cray<State>([
          asyncStep('first', 20),
          asyncStep('second', 10),
          asyncStep('third', 5),
        ]);

        const state = lay<State>({ log: [] });
        const result = await sequence(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.log).toEqual(['first', 'second', 'third']);
        }
      });

      it('should handle Promise rejection as error', async () => {
        type State = { value: number };
        const rejecting: Cray<State, Error> = cray(async () => {
          return Promise.reject(new Error('rejected'));
        });

        const state = lay<State>({ value: 0 });
        const result = await rejecting(state);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toBe('rejected');
        }
      });
    });

    describe('state consistency', () => {
      it('should maintain state consistency after error in sequence', async () => {
        type State = { a: number; b: number; c: number };
        const sequence = cray<State, Error>([
          (focus) => focus.using('a').set(10),
          (focus) => focus.using('b').set(20),
          () => {
            throw new Error('boom');
          },
          (focus) => focus.using('c').set(30),
        ]);

        const state = lay<State>({ a: 0, b: 0, c: 0 });
        const result = await sequence(state);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.state.a).toBe(10);
          expect(result.state.b).toBe(20);
          expect(result.state.c).toBe(0); // not modified
        }
      });

      it('should reflect focus changes immediately in same step', async () => {
        type State = { value: number };
        const task: Cray<State> = cray((focus) => {
          focus.using('value').set(10);
          const mid = focus.get().value;
          focus.using('value').set(mid * 2);
        });

        const state = lay<State>({ value: 0 });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.value).toBe(20);
        }
      });
    });

    describe('re-entrancy and mutation', () => {
      it('should handle step that calls another cray', async () => {
        type State = { value: number };
        const inner: Cray<State> = cray((focus) => {
          focus.using('value').update((v) => v + 10);
        });

        const outer: Cray<State> = cray(async (focus) => {
          focus.using('value').set(5);
          await inner(focus);
          focus.using('value').update((v) => v * 2);
        });

        const state = lay<State>({ value: 0 });
        const result = await outer(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.value).toBe(30); // (5 + 10) * 2
        }
      });
    });

    describe('complex state shapes', () => {
      it('should handle Map-like state', async () => {
        type State = { users: Record<string, { name: string; age: number }> };
        const task: Cray<State> = cray((focus) => {
          focus.using('users').update((users) => ({
            ...users,
            user1: { name: 'Alice', age: 30 },
          }));
        });

        const state = lay<State>({ users: {} });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.users.user1).toEqual({ name: 'Alice', age: 30 });
        }
      });

      it('should handle nested arrays of objects', async () => {
        type Item = { id: number; done: boolean };
        type State = { lists: Item[][] };
        const task: Cray<State> = cray((focus) => {
          focus.using('lists').using(0).using(1).using('done').set(true);
        });

        const state = lay<State>({
          lists: [
            [
              { id: 1, done: false },
              { id: 2, done: false },
            ],
            [{ id: 3, done: false }],
          ],
        });
        const result = await task(state);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.state.lists[0][1].done).toBe(true);
          expect(result.state.lists[0][0].done).toBe(false);
        }
      });
    });
  });
});
