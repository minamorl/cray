import { lay } from '@minamorl/lay';
import { lift, cray, definitionOf } from '../src/core';
import type { Cray } from '../src/core';

describe('lift', () => {
  test('normalizes a plain step into Cray', async () => {
    type State = { value: number; doubled: number };
    const step = (focus: ReturnType<typeof lay<State>>) => ({
      ...focus.get(),
      doubled: focus.get().value * 2,
    });
    const task = lift<State>(step);
    const focus = lay<State>({ value: 21, doubled: 0 });
    const result = await task(focus);
    expect(result).toEqual({ ok: true, state: { value: 21, doubled: 42 } });
  });

  test('attaches CRAY_META with kind "task"', () => {
    const step = () => ({ x: 1 });
    const task = lift(step);
    const def = definitionOf(task);
    expect(def).toBeDefined();
    expect(def?.kind).toBe('task');
  });

  test('is idempotent — lifting an already-lifted Cray returns the same value', () => {
    const step = () => ({ x: 1 });
    const first = lift(step);
    const second = lift(first);
    expect(first).toBe(second);
  });

  test('captures thrown errors as Failure', async () => {
    const error = new Error('boom');
    const step = () => {
      throw error;
    };
    const task = lift<{ x: number }, Error>(step);
    const result = await task(lay({ x: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(error);
    }
  });

  test('handles async steps', async () => {
    const step = async (focus: ReturnType<typeof lay<{ n: number }>>) => {
      await Promise.resolve();
      return { n: focus.get().n + 10 };
    };
    const task = lift(step);
    const result = await task(lay({ n: 5 }));
    expect(result).toEqual({ ok: true, state: { n: 15 } });
  });

  test('handles void return (uses current state as fallback)', async () => {
    const step = () => {
      // side-effect only, no return
    };
    const task = lift<{ x: number }>(step);
    const result = await task(lay({ x: 42 }));
    expect(result).toEqual({ ok: true, state: { x: 42 } });
  });

  test('lifted step works inside cray() sequence', async () => {
    const addOne = lift<number, string>((focus) => focus.get() + 1);
    const double = lift<number, string>((focus) => focus.get() * 2);
    const pipeline = cray<number, string>([addOne, double]);
    const result = await pipeline(lay(3));
    // (3 + 1) = 4, then 4 * 2 = 8
    expect(result).toEqual({ ok: true, state: 8 });
  });

  test('lift and cray produce equivalent results for single steps', async () => {
    const step = (focus: ReturnType<typeof lay<number>>) => focus.get() * 3;
    const fromLift = lift<number, string>(step);
    const fromCray = cray<number, string>(step);

    const resultLift = await fromLift(lay(7));
    const resultCray = await fromCray(lay(7));
    expect(resultLift).toEqual(resultCray);
  });
});
