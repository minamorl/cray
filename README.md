# @minamorl/cray

A composable, type-safe workflow engine built on optics. Define tasks, sequences, parallel steps, branches, and error recovery — then compile and execute them as directed graphs.

## Overview

Cray models workflows as composable functions (`Cray<S, E>`) that operate on shared state through a [`Focus`](https://github.com/minamorl/lay) (an optic from `@minamorl/lay`). Each workflow step receives a `Focus<S>` and returns a `Result<S, E>` — either `Success` or `Failure`.

Workflows can be:
- **Composed** into sequences via `cray([step1, step2, ...])`
- **Recovered** with `else_()` / `elseCray()` error handlers
- **Parallelized** with `parallel()` and optional reducers
- **Branched** conditionally with `branch().when(...).otherwise(...)`
- **Compiled** into a directed graph with `compile()` for structured execution
- **Visualized** as Mermaid diagrams with `toMermaid()`
- **Bridged** to reactive state via `attachCray()` (connects to `@minamorl/root-core`)

## Installation

```bash
npm install @minamorl/cray
```

## Core Concepts

### Result type

Every workflow step produces a `Result<S, E>`:

```typescript
type Result<S, E> = Success<S> | Failure<S, E>;

interface Success<S> { readonly ok: true; readonly state: S; }
interface Failure<S, E> { readonly ok: false; readonly state: S; readonly error: E; }
```

### Cray function

A `Cray<S, E>` is a function that takes a `Focus<S>` and returns `Promise<Result<S, E>>`:

```typescript
type Cray<S, E> = (focus: Focus<S>) => Promise<Result<S, E>>;
```

Steps can also return just `S` (treated as success), `void` (current state preserved as success), or throw (caught as failure).

## API

### `cray(step | steps[])`

Create a single task or a sequential pipeline:

```typescript
import { cray } from '@minamorl/cray';

// Single task
const increment = cray<{ count: number }>(focus => ({
  ok: true,
  state: { count: focus.get().count + 1 },
}));

// Sequence — stops on first failure
const pipeline = cray([
  focus => ({ ...focus.get(), step1: true }),
  focus => ({ ...focus.get(), step2: true }),
]);
```

### `else_(handler, task)` / `elseCray(handler, task)`

Attach error recovery to a workflow step. If the inner step fails, the handler receives the error and the current focus:

```typescript
import { cray, else_ } from '@minamorl/cray';

const safe = else_(
  (error, focus) => ({ ...focus.get(), recovered: true }),
  cray(focus => { throw new Error('boom'); }),
);
```

`else_` is curried — you can pass just the handler to get a wrapper function.

### `parallel(steps[], reducer?)`

Run steps concurrently. Without a reducer, the last successful result wins. With a reducer, you control how results are aggregated:

```typescript
import { parallel } from '@minamorl/cray';

const both = parallel([taskA, taskB], (acc, current) => {
  if (!current.ok) return acc;
  return { ...acc.state, ...current.state };
});
```

### `branch().when(predicate, step).otherwise(step)`

Conditional execution with a builder pattern:

```typescript
import { branch } from '@minamorl/cray';

const workflow = branch<{ mode: string }>()
  .when(focus => focus.get().mode === 'fast', fastPath)
  .when(focus => focus.get().mode === 'safe', safePath)
  .otherwise(defaultPath);
```

### `compile(steps[])` and `execute(graph, initial, hooks?)`

Compile a workflow into a directed graph, then execute it with lifecycle hooks:

```typescript
import { compile, execute } from '@minamorl/cray';

const graph = compile([step1, step2, step3]);

const result = await execute(graph, { count: 0 }, {
  onStart: (node, state) => console.log(`→ ${node.id}`),
  onEnd: (node, result) => console.log(`← ${node.id}: ${result.ok}`),
  onError: (node, failure) => console.error(node.id, failure.error),
});
```

`execute` accepts either a raw state `S` or an existing `Focus<S>`.

### `toMermaid(graph)`

Generate a Mermaid diagram from a compiled graph:

```typescript
import { compile } from '@minamorl/cray';
import { toMermaid } from '@minamorl/cray';

const graph = compile([step1, step2]);
console.log(toMermaid(graph));
// graph TD
//   n0[task]
//   n0 -->|ok| n1
//   n1[task]
```

### `attachCray(root, workflow, options)`

Bridge a Cray workflow to a `Root` instance from `@minamorl/root-core`. Subscribes to state changes, executes the workflow reactively, and commits results back:

```typescript
import { attachCray } from '@minamorl/cray';

const unsubscribe = attachCray(root, myWorkflow, {
  stateTransform: (rootState) => ({ count: rootState.count as number }),
  target: 'computed',
  runOnSubscribe: true,
  debounce: 100,
  onError: (err) => console.error(err),
});

// Later: unsubscribe() to stop
```

### `lift(step)`

Convert a plain step function into a normalized `Cray<S, E>`. This is the natural transformation from `Step` to `Cray` — it wraps raw return values (`S`, `void`, thrown errors) into proper `Result<S, E>` values:

```typescript
import { lift } from '@minamorl/cray';

// A plain function that just returns state
const step = (focus: Focus<{ count: number }>) => ({
  count: focus.get().count + 1,
});

// lift turns it into a full Cray function
const lifted = lift(step);
// lifted: Cray<{ count: number }, unknown>
// Returns Result<S, E> with ok: true
```

`lift` handles all `Step` return types:
- **Returns `S`** → wrapped as `Success<S>`
- **Returns `void`/`undefined`** → current state preserved as `Success<S>`
- **Returns `Result<S, E>`** → passed through unchanged
- **Throws** → caught and wrapped as `Failure<S, E>`

This is useful when you want to use plain functions in contexts that expect `Cray<S, E>`, or when building higher-order workflow combinators.

### `definitionOf(cray)`

Introspect the structural definition of a cray function. Returns `CrayDefinition` with `kind` (`'task'`, `'sequence'`, `'else'`, `'parallel'`, `'branch'`) and relevant metadata.

## Dependencies

- **[@minamorl/lay](https://www.npmjs.com/package/@minamorl/lay)** — Optics library providing `Focus<S>` for shared state access
- **[@minamorl/root-core](https://www.npmjs.com/package/@minamorl/root-core)** — Reactive state container (used by `attachCray` bridge)

## License

MIT
