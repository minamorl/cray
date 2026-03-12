import fc from 'fast-check';
import { lay } from '@minamorl/lay';
import { branch, cray, elseCray, parallel, Cray, Result } from '../src/core';

type NumCray = Cray<number, string>;

type NumResult = Result<number, string>;

type NumStep = (
  focus: ReturnType<typeof lay<number>>,
) => number | Promise<number> | NumResult;

const pure = (value: number): NumCray => cray<number, string>(() => value);

const bind = (task: NumCray, fn: (value: number) => NumCray): NumCray =>
  cray<number, string>([task, (focus) => fn(focus.get())(focus)]);

const stepArb = fc
  .tuple(fc.integer({ min: -10, max: 10 }), fc.boolean())
  .map<NumStep>(([delta, isAsync]) => {
    const resolver = (focus: ReturnType<typeof lay<number>>) =>
      focus.get() + delta;
    return isAsync
      ? async (focus: ReturnType<typeof lay<number>>) =>
          await Promise.resolve(resolver(focus))
      : (focus: ReturnType<typeof lay<number>>) => resolver(focus);
  });

const successTaskArb = fc
  .array(stepArb, { minLength: 1, maxLength: 4 })
  .map<NumCray>((steps) => cray<number, string>(steps));

const functionArb = fc
  .tuple(
    fc.integer({ min: -5, max: 5 }),
    fc.integer({ min: -20, max: 20 }),
    fc.boolean(),
  )
  .map<(value: number) => NumCray>(([factor, offset, isAsync]) => {
    return (value: number) =>
      cray<number, string>([
        isAsync
          ? async (focus: ReturnType<typeof lay<number>>) =>
              await Promise.resolve(focus.get() + value * factor + offset)
          : (focus: ReturnType<typeof lay<number>>) =>
              focus.get() + value * factor + offset,
      ]);
  });

describe('Cray monad laws', () => {
  test('left identity', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), functionArb, async (value, fn) => {
        const left = await bind(pure(value), fn)(lay(value));
        const right = await fn(value)(lay(value));
        expect(left).toEqual(right);
      }),
    );
  });

  test('right identity', async () => {
    await fc.assert(
      fc.asyncProperty(successTaskArb, fc.integer(), async (task, initial) => {
        const left = await bind(task, pure)(lay(initial));
        const right = await task(lay(initial));
        expect(left).toEqual(right);
      }),
    );
  });

  test('associativity', async () => {
    await fc.assert(
      fc.asyncProperty(
        successTaskArb,
        functionArb,
        functionArb,
        fc.integer(),
        async (task, f, g, initial) => {
          const left = await bind(bind(task, f), g)(lay(initial));
          const right = await bind(task, (x) => bind(f(x), g))(lay(initial));
          expect(left).toEqual(right);
        },
      ),
    );
  });
});

describe('Cray monoid laws for sequential composition', () => {
  const identity: NumCray = cray<number, string>([]);
  const concat = (a: NumCray, b: NumCray): NumCray =>
    cray<number, string>([a, b]);

  test('identity element', async () => {
    await fc.assert(
      fc.asyncProperty(successTaskArb, fc.integer(), async (task, initial) => {
        const leftIdentity = await concat(identity, task)(lay(initial));
        expect(leftIdentity).toEqual(await task(lay(initial)));

        const rightIdentity = await concat(task, identity)(lay(initial));
        expect(rightIdentity).toEqual(await task(lay(initial)));
      }),
    );
  });

  test('associativity of composition', async () => {
    await fc.assert(
      fc.asyncProperty(
        successTaskArb,
        successTaskArb,
        successTaskArb,
        fc.integer(),
        async (a, b, c, initial) => {
          const left = await concat(concat(a, b), c)(lay(initial));
          const right = await concat(a, concat(b, c))(lay(initial));
          expect(left).toEqual(right);
        },
      ),
    );
  });
});

describe('parallel composition', () => {
  const stepsArrayArb = fc.array(successTaskArb, { maxLength: 4 });
  const reducer = async (
    acc: NumResult,
    next: NumResult,
    index: number,
    all: readonly NumResult[],
  ): Promise<NumResult> => {
    void index;
    void all;
    const outcome = next.ok ? next : acc;
    return await Promise.resolve(outcome);
  };

  const evaluateDefault = (
    results: NumResult[],
    initial: number,
  ): NumResult => {
    if (results.length === 0) {
      return { ok: true, state: initial };
    }

    const successes = results.filter((result) => result.ok);
    if (successes.length > 0) {
      return successes[successes.length - 1];
    }

    return results[results.length - 1];
  };

  test('default reducer matches last success semantic', async () => {
    await fc.assert(
      fc.asyncProperty(stepsArrayArb, fc.integer(), async (steps, initial) => {
        const task = parallel(steps);
        const result = await task(lay(initial));
        const manualResults = await Promise.all(
          steps.map((step) => step(lay(initial))),
        );
        expect(result).toEqual(evaluateDefault(manualResults, initial));
      }),
    );
  });

  test('custom reducer behaves like manual aggregation', async () => {
    await fc.assert(
      fc.asyncProperty(stepsArrayArb, fc.integer(), async (steps, initial) => {
        const task = parallel(steps, reducer);
        const result = await task(lay(initial));
        const manualResults = await Promise.all(
          steps.map((step) => step(lay(initial))),
        );
        let manual: NumResult = { ok: true, state: initial };

        for (let index = 0; index < manualResults.length; index += 1) {
          manual = await reducer(
            manual,
            manualResults[index],
            index,
            manualResults,
          );
        }

        expect(result).toEqual(manual);
      }),
    );
  });
});

describe('error handling', () => {
  test('cray captures thrown errors', async () => {
    const error = new Error('boom');
    const task = cray<number, Error>(() => {
      throw error;
    });

    const result = await task(lay(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(error);
      expect(result.state).toBe(0);
    }
  });

  test('elseCray recovers from errors', async () => {
    const failing = cray<number, Error>(() => {
      throw new Error('fail');
    });

    const recovered = elseCray<number, Error>(() => 1, failing);

    const result = await recovered(lay(0));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe(1);
    }
  });

  test('parallel collects errors in results', async () => {
    const errorTask = cray<number, Error>(() => {
      throw new Error('bad');
    });

    const successTask = cray<number, Error>(() => 5);
    const combined = parallel([errorTask, successTask]);
    const result = await combined(lay(0));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe(5);
    }
  });
});

describe('branching', () => {
  test('evaluates predicates in order', async () => {
    const trace: string[] = [];
    const task = branch<number, string>()
      .when(
        async (focus) => {
          trace.push('first');
          return await Promise.resolve(focus.get() > 10);
        },
        () => 20,
      )
      .when(
        (focus) => {
          trace.push('second');
          return focus.get() > 5;
        },
        () => 10,
      )
      .otherwise(() => 0);

    const result = await task(lay(6));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe(10);
    }
    expect(trace).toEqual(['first', 'second']);
  });

  test('falls back to otherwise when no predicates match', async () => {
    const task = branch<number, string>()
      .when(
        () => false,
        () => 1,
      )
      .otherwise(() => 2);

    const result = await task(lay(0));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe(2);
    }
  });
});
