import type { Focus } from '@minamorl/lay';

export type Result<S = Record<string, unknown>, E = unknown> =
  | Success<S>
  | Failure<S, E>;

export interface Success<S = Record<string, unknown>> {
  readonly ok: true;
  readonly state: S;
}

export interface Failure<S = Record<string, unknown>, E = unknown> {
  readonly ok: false;
  readonly state: S;
  readonly error: E;
}

export type Cray<S = Record<string, unknown>, E = unknown> = (
  focus: Focus<S>,
) => Promise<Result<S, E>>;

type StepReturn<S = Record<string, unknown>, E = unknown> =
  | Result<S, E>
  | S
  | void
  | Promise<Result<S, E> | S | void>;
type Step<S = Record<string, unknown>, E = unknown> = (
  focus: Focus<S>,
) => StepReturn<S, E>;

export type Reducer<S = Record<string, unknown>, E = unknown> = (
  accumulator: Result<S, E>,
  current: Result<S, E>,
  index: number,
  results: readonly Result<S, E>[],
) => Result<S, E> | S | void | Promise<Result<S, E> | S | void>;

export type Predicate<S = Record<string, unknown>> = (
  focus: Focus<S>,
) => boolean | Promise<boolean>;

const CRAY_META = Symbol('cray:meta');

export type TaskDefinition<S = Record<string, unknown>, E = unknown> = {
  readonly kind: 'task';
  readonly step: Step<S, E>;
};

export type SequenceDefinition<S = Record<string, unknown>, E = unknown> = {
  readonly kind: 'sequence';
  readonly steps: readonly Cray<S, E>[];
};

export type ElseDefinition<S = Record<string, unknown>, E = unknown> = {
  readonly kind: 'else';
  readonly handler: (error: E, focus: Focus<S>) => StepReturn<S, E>;
  readonly inner: Cray<S, E>;
};

export type ParallelDefinition<S = Record<string, unknown>, E = unknown> = {
  readonly kind: 'parallel';
  readonly steps: readonly Cray<S, E>[];
  readonly reducer?: Reducer<S, E>;
};

export type BranchDefinition<S = Record<string, unknown>, E = unknown> = {
  readonly kind: 'branch';
  readonly cases: readonly { predicate: Predicate<S>; step: Cray<S, E> }[];
  readonly otherwise: Cray<S, E>;
};

export type CrayDefinition<S = Record<string, unknown>, E = unknown> =
  | TaskDefinition<S, E>
  | SequenceDefinition<S, E>
  | ElseDefinition<S, E>
  | ParallelDefinition<S, E>
  | BranchDefinition<S, E>;

export type AnnotatedCray<S = Record<string, unknown>, E = unknown> = Cray<
  S,
  E
> & {
  [CRAY_META]?: CrayDefinition<S, E>;
};

function withDefinition<S, E>(
  cray: Cray<S, E>,
  definition: CrayDefinition<S, E>,
): AnnotatedCray<S, E> {
  const annotated = cray as AnnotatedCray<S, E>;
  annotated[CRAY_META] = definition;
  return annotated;
}

export function definitionOf<S, E>(
  cray: Cray<S, E>,
): CrayDefinition<S, E> | undefined {
  return (cray as AnnotatedCray<S, E>)[CRAY_META];
}

function isResult<S, E>(value: unknown): value is Result<S, E> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

function toResult<S, E>(
  value: Result<S, E> | S | void,
  fallback: S,
): Result<S, E> {
  if (isResult<S, E>(value)) {
    return value;
  }

  if (typeof value === 'undefined') {
    return { ok: true, state: fallback };
  }

  return { ok: true, state: value as S };
}

async function runStep<S, E>(
  step: Step<S, E>,
  focus: Focus<S>,
): Promise<Result<S, E>> {
  try {
    const value = await step(focus);
    return toResult<S, E>(value, focus.get());
  } catch (error) {
    return { ok: false, state: focus.get(), error: error as E };
  }
}

function normalizeStep<S, E>(step: Step<S, E> | Cray<S, E>): Cray<S, E> {
  const annotated = step as AnnotatedCray<S, E>;
  if (annotated[CRAY_META]) {
    return annotated;
  }

  const wrapped: Cray<S, E> = (focus: Focus<S>) => runStep(step, focus);
  return withDefinition(wrapped, { kind: 'task', step: step as Step<S, E> });
}

export function cray<S = Record<string, unknown>, E = unknown>(
  fnOrSteps: Step<S, E> | Array<Step<S, E> | Cray<S, E>>,
): Cray<S, E> {
  if (Array.isArray(fnOrSteps)) {
    const steps = fnOrSteps.map((step) => normalizeStep<S, E>(step));

    const sequence = async (focus: Focus<S>) => {
      let lastResult: Result<S, E> = { ok: true, state: focus.get() };

      for (const step of steps) {
        const result = await step(focus);
        lastResult = result;
        // Focus is already mutated by the step, sync it if result has different state
        if (result.ok) {
          focus.set(result.state);
        }

        if (!result.ok) {
          return result;
        }
      }

      return lastResult;
    };

    return withDefinition(sequence, { kind: 'sequence', steps });
  }

  return normalizeStep<S, E>(fnOrSteps);
}

export function elseCray<S = Record<string, unknown>, E = unknown>(
  handler: (error: E, focus: Focus<S>) => StepReturn<S, E>,
  task: Step<S, E> | Cray<S, E>,
): Cray<S, E>;
export function elseCray<S = Record<string, unknown>, E = unknown>(
  handler: (error: E, focus: Focus<S>) => StepReturn<S, E>,
): (inner: Step<S, E> | Cray<S, E>) => Cray<S, E>;
export function elseCray<S = Record<string, unknown>, E = unknown>(
  handler: (error: E, focus: Focus<S>) => StepReturn<S, E>,
  task?: Step<S, E> | Cray<S, E>,
): Cray<S, E> | ((inner: Step<S, E> | Cray<S, E>) => Cray<S, E>) {
  const wrap = (inner: Step<S, E> | Cray<S, E>): Cray<S, E> => {
    const normalized = normalizeStep(inner);

    const wrapped: Cray<S, E> = async (focus: Focus<S>) => {
      const result = await normalized(focus);

      if (result.ok) {
        return result;
      }

      // Update focus with error state, then call handler
      focus.set(result.state);
      try {
        const recovery = await handler(result.error, focus);
        return toResult<S, E>(recovery, focus.get());
      } catch (error) {
        return { ok: false, state: focus.get(), error: error as E };
      }
    };

    return withDefinition(wrapped, {
      kind: 'else',
      handler,
      inner: normalized,
    });
  };

  if (task) {
    return wrap(task);
  }

  return wrap;
}

export const else_: {
  <S = Record<string, unknown>, E = unknown>(
    handler: (error: E, focus: Focus<S>) => StepReturn<S, E>,
    task: Step<S, E> | Cray<S, E>,
  ): Cray<S, E>;
  <S = Record<string, unknown>, E = unknown>(
    handler: (error: E, focus: Focus<S>) => StepReturn<S, E>,
  ): (inner: Step<S, E> | Cray<S, E>) => Cray<S, E>;
} = elseCray;

export function parallel<S = Record<string, unknown>, E = unknown>(
  steps: readonly (Step<S, E> | Cray<S, E>)[],
  reducer?: Reducer<S, E>,
): Cray<S, E> {
  const normalized = steps.map((step) => normalizeStep<S, E>(step));

  const runParallel: Cray<S, E> = async (focus: Focus<S>) => {
    if (normalized.length === 0) {
      return { ok: true, state: focus.get() };
    }

    // All parallel tasks share the same Focus
    const results = await Promise.all(normalized.map((step) => step(focus)));

    if (reducer) {
      let accumulator: Result<S, E> = { ok: true, state: focus.get() };

      for (let index = 0; index < results.length; index += 1) {
        const reduced = await reducer(
          accumulator,
          results[index],
          index,
          results,
        );
        accumulator = toResult<S, E>(reduced, accumulator.state);
      }

      return accumulator;
    }

    const successful = results.filter(
      (result): result is Success<S> => result.ok,
    );

    if (successful.length > 0) {
      return successful[successful.length - 1];
    }

    return results[results.length - 1];
  };

  return withDefinition(runParallel, {
    kind: 'parallel',
    steps: normalized,
    reducer,
  });
}

interface BranchBuilder<S = Record<string, unknown>, E = unknown> {
  when(
    predicate: Predicate<S>,
    step: Step<S, E> | Cray<S, E>,
  ): BranchBuilder<S, E>;
  otherwise(step: Step<S, E> | Cray<S, E>): Cray<S, E>;
}

export function branch<
  S = Record<string, unknown>,
  E = unknown,
>(): BranchBuilder<S, E> {
  const branches: Array<{ predicate: Predicate<S>; step: Cray<S, E> }> = [];

  const builder: BranchBuilder<S, E> = {
    when(predicate: Predicate<S>, step: Step<S, E> | Cray<S, E>) {
      branches.push({ predicate, step: normalizeStep<S, E>(step) });
      return builder;
    },
    otherwise(step: Step<S, E> | Cray<S, E>) {
      const fallback = normalizeStep<S, E>(step);

      const branchCray: Cray<S, E> = async (focus: Focus<S>) => {
        for (const { predicate, step: branchStep } of branches) {
          if (await predicate(focus)) {
            return branchStep(focus);
          }
        }

        return fallback(focus);
      };

      return withDefinition(branchCray, {
        kind: 'branch',
        cases: branches.map(({ predicate, step: branchStep }) => ({
          predicate,
          step: branchStep,
        })),
        otherwise: fallback,
      });
    },
  };

  return builder;
}
