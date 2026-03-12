import type { Focus } from '@minamorl/lay';
import { lay } from '@minamorl/lay';
import {
  Cray,
  Result,
  definitionOf,
  ParallelDefinition,
  BranchDefinition,
  ElseDefinition,
  TaskDefinition,
  Predicate,
  Reducer,
  Failure,
} from './core';

type Edge<S> =
  | { readonly kind: 'ok'; readonly target: string }
  | { readonly kind: 'err'; readonly target: string }
  | {
      readonly kind: 'branch';
      readonly target: string;
      readonly predicate: Predicate<S>;
    }
  | { readonly kind: 'otherwise'; readonly target: string };

export type Node<S, E> =
  | {
      readonly id: string;
      readonly kind: 'task';
      readonly run: Cray<S, E>;
      readonly succ: Edge<S>[];
      readonly meta?: {
        readonly name?: string;
        readonly pure?: boolean;
        readonly effects?: readonly string[];
      };
    }
  | {
      readonly id: string;
      readonly kind: 'else';
      readonly handler: ElseDefinition<S, E>['handler'];
      readonly succ: Edge<S>[];
    }
  | {
      readonly id: string;
      readonly kind: 'branch';
      readonly succ: Edge<S>[];
    }
  | {
      readonly id: string;
      readonly kind: 'parallel';
      readonly steps: readonly Cray<S, E>[];
      readonly reducer?: Reducer<S, E>;
      readonly succ: Edge<S>[];
    };

export type Graph<S, E> = {
  readonly entry: string;
  readonly nodes: Map<string, Node<S, E>>;
};

type BuildFragment = {
  entry: string;
  ok: string[];
  err: string[];
};

export type ExecuteHooks<S, E> = {
  readonly onStart?: (
    node: Node<S, E>,
    current: Result<S, E>,
  ) => void | Promise<void>;
  readonly onEnd?: (
    node: Node<S, E>,
    result: Result<S, E>,
  ) => void | Promise<void>;
  readonly onError?: (
    node: Node<S, E>,
    result: Failure<S, E>,
  ) => void | Promise<void>;
};

function isResult<S, E>(value: unknown): value is Result<S, E> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

function asResult<S, E>(
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

class Builder<S, E> {
  private counter = 0;
  readonly nodes = new Map<string, Node<S, E>>();

  compileSteps(steps: readonly Cray<S, E>[]): Graph<S, E> {
    const fragment = this.sequence(steps);
    return { entry: fragment.entry, nodes: this.nodes };
  }

  private sequence(steps: readonly Cray<S, E>[]): BuildFragment {
    if (steps.length === 0) {
      return this.identity();
    }

    const [first, ...rest] = steps;
    let fragment = this.cray(first);

    for (const step of rest) {
      const nextFragment = this.cray(step);
      this.connectOk(fragment.ok, nextFragment.entry);
      fragment = {
        entry: fragment.entry,
        ok: nextFragment.ok,
        err: [...fragment.err, ...nextFragment.err],
      };
    }

    return fragment;
  }

  private cray(cray: Cray<S, E>): BuildFragment {
    const definition = definitionOf(cray);

    if (!definition) {
      return this.task(cray);
    }

    switch (definition.kind) {
      case 'task':
        return this.task(cray, definition);
      case 'sequence':
        return this.sequence(definition.steps);
      case 'else':
        return this.else(definition);
      case 'parallel':
        return this.parallel(cray, definition);
      case 'branch':
        return this.branch(definition);
      default:
        return this.task(cray);
    }
  }

  private identity(): BuildFragment {
    const id = this.nextId();
    const task: Node<S, E> = {
      id,
      kind: 'task',
      run: (focus) => Promise.resolve({ ok: true, state: focus.get() }),
      succ: [],
    };
    this.nodes.set(id, task);
    return { entry: id, ok: [id], err: [id] };
  }

  private task(
    cray: Cray<S, E>,
    definition?: TaskDefinition<S, E>,
  ): BuildFragment {
    const id = this.nextId();
    const node: Node<S, E> = {
      id,
      kind: 'task',
      run: cray,
      succ: [],
      meta: { name: definition?.step.name || undefined },
    };
    this.nodes.set(id, node);
    return { entry: id, ok: [id], err: [id] };
  }

  private else(definition: ElseDefinition<S, E>): BuildFragment {
    const inner = this.cray(definition.inner);
    const handlerId = this.nextId();
    const handlerNode: Node<S, E> = {
      id: handlerId,
      kind: 'else',
      handler: definition.handler,
      succ: [],
    };
    this.nodes.set(handlerId, handlerNode);

    this.connectErr(inner.err, handlerId);

    return {
      entry: inner.entry,
      ok: [...inner.ok, handlerId],
      err: [handlerId],
    };
  }

  private branch(definition: BranchDefinition<S, E>): BuildFragment {
    const branchId = this.nextId();
    const node: Node<S, E> = { id: branchId, kind: 'branch', succ: [] };
    this.nodes.set(branchId, node);

    const cases = definition.cases.map((branchCase) => ({
      predicate: branchCase.predicate,
      fragment: this.cray(branchCase.step),
    }));
    const fallback = this.cray(definition.otherwise);

    for (const { predicate, fragment } of cases) {
      node.succ.push({ kind: 'branch', target: fragment.entry, predicate });
    }
    node.succ.push({ kind: 'otherwise', target: fallback.entry });

    return {
      entry: branchId,
      ok: [...cases.flatMap(({ fragment }) => fragment.ok), ...fallback.ok],
      err: [...cases.flatMap(({ fragment }) => fragment.err), ...fallback.err],
    };
  }

  private parallel(
    cray: Cray<S, E>,
    definition: ParallelDefinition<S, E>,
  ): BuildFragment {
    const id = this.nextId();
    const node: Node<S, E> = {
      id,
      kind: 'parallel',
      steps: definition.steps,
      reducer: definition.reducer,
      succ: [],
    };
    this.nodes.set(id, node);
    return { entry: id, ok: [id], err: [id] };
  }

  private connectOk(ids: readonly string[], target: string): void {
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      node.succ.push({ kind: 'ok', target });
    }
  }

  private connectErr(ids: readonly string[], target: string): void {
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      node.succ.push({ kind: 'err', target });
    }
  }

  private nextId(): string {
    const id = `n${this.counter}`;
    this.counter += 1;
    return id;
  }
}

export function compile<S, E>(steps: readonly Cray<S, E>[]): Graph<S, E> {
  const builder = new Builder<S, E>();
  return builder.compileSteps(steps);
}

function selectNext<S, E>(
  edges: readonly Edge<S>[],
  result: Result<S, E>,
): string | undefined {
  if (result.ok) {
    return edges.find((edge) => edge.kind === 'ok')?.target;
  }

  return edges.find((edge) => edge.kind === 'err')?.target;
}

function selectBranch<S>(
  edges: readonly Edge<S>[],
  focus: Focus<S>,
): Promise<string | undefined> {
  const branchEdges = edges.filter(
    (
      edge,
    ): edge is { kind: 'branch'; target: string; predicate: Predicate<S> } =>
      edge.kind === 'branch',
  );
  const otherwise = edges.find((edge) => edge.kind === 'otherwise');

  return (async () => {
    for (const edge of branchEdges) {
      if (await edge.predicate(focus)) {
        return edge.target;
      }
    }
    return otherwise?.target;
  })();
}

async function runParallel<S, E>(
  node: Extract<Node<S, E>, { kind: 'parallel' }>,
  focus: Focus<S>,
): Promise<Result<S, E>> {
  if (node.steps.length === 0) {
    return { ok: true, state: focus.get() };
  }

  // Each parallel step gets a snapshot of current state via its own Focus
  // The results are then aggregated
  const currentState = focus.get();
  const results = await Promise.all(
    node.steps.map((step) => {
      const childFocus = lay(currentState);
      return step(childFocus);
    }),
  );

  if (node.reducer) {
    let accumulator: Result<S, E> = { ok: true, state: currentState };

    for (let index = 0; index < results.length; index += 1) {
      const reduced = await node.reducer(
        accumulator,
        results[index],
        index,
        results,
      );
      accumulator = asResult(reduced, accumulator.state);
    }

    // Update the shared focus with final result
    focus.set(accumulator.state);
    return accumulator;
  }

  const successes = results.filter((result) => result.ok);
  if (successes.length > 0) {
    const lastSuccess = successes[successes.length - 1];
    focus.set(lastSuccess.state);
    return lastSuccess;
  }

  const lastResult = results[results.length - 1];
  focus.set(lastResult.state);
  return lastResult;
}

/**
 * Execute a compiled graph with a Focus.
 * The Focus is shared across all nodes, maintaining state continuity.
 */
function isFocus<S>(value: S | Focus<S>): value is Focus<S> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    'set' in value &&
    'using' in value
  );
}

export async function execute<S, E>(
  graph: Graph<S, E>,
  initial: S | Focus<S>,
  hooks: ExecuteHooks<S, E> = {},
): Promise<Result<S, E>> {
  // Create or use existing Focus - this is the shared state container
  const focus: Focus<S> = isFocus(initial) ? initial : lay(initial);

  let currentId: string | undefined = graph.entry;
  let currentResult: Result<S, E> = { ok: true, state: focus.get() };

  while (currentId) {
    const node = graph.nodes.get(currentId);
    if (!node) {
      return currentResult;
    }

    if (hooks.onStart) {
      await hooks.onStart(node, currentResult);
    }

    switch (node.kind) {
      case 'task': {
        // Pass the shared Focus to the task
        const next = await node.run(focus);
        currentResult = next;
        // Sync focus state with result
        focus.set(currentResult.state);
        if (hooks.onEnd) {
          await hooks.onEnd(node, currentResult);
        }
        if (!currentResult.ok && hooks.onError) {
          await hooks.onError(node, currentResult);
        }
        currentId = selectNext(node.succ, currentResult);
        break;
      }
      case 'else': {
        if (currentResult.ok) {
          currentId = selectNext(node.succ, currentResult);
          if (hooks.onEnd) {
            await hooks.onEnd(node, currentResult);
          }
          break;
        }

        try {
          const recovered = await node.handler(currentResult.error, focus);
          currentResult = asResult(
            recovered as Result<S, E> | S | void,
            focus.get(),
          );
          focus.set(currentResult.state);
        } catch (error) {
          currentResult = { ok: false, state: focus.get(), error: error as E };
        }

        if (hooks.onEnd) {
          await hooks.onEnd(node, currentResult);
        }
        if (!currentResult.ok && hooks.onError) {
          await hooks.onError(node, currentResult);
        }

        currentId = selectNext(node.succ, currentResult);
        break;
      }
      case 'branch': {
        if (!currentResult.ok) {
          currentId = selectNext(node.succ, currentResult);
          if (hooks.onEnd) {
            await hooks.onEnd(node, currentResult);
          }
          break;
        }

        const target = await selectBranch(node.succ, focus);
        currentId = target;
        if (hooks.onEnd) {
          await hooks.onEnd(node, currentResult);
        }
        break;
      }
      case 'parallel': {
        const next: Result<S, E> = await runParallel(node, focus);
        currentResult = next;
        if (hooks.onEnd) {
          await hooks.onEnd(node, currentResult);
        }
        if (!currentResult.ok && hooks.onError) {
          await hooks.onError(node, currentResult);
        }
        currentId = selectNext(node.succ, currentResult);
        break;
      }
      default:
        return currentResult;
    }
  }

  return currentResult;
}
