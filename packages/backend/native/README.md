# datamog-backend-native

*Part of the [Datamog](../../../README.md) monorepo.*

Native in-memory backend for Datamog. Interprets Datalog directly with a
naive bottom-up evaluator; no SQL is generated. Intended for teaching
the semantics: strata are computed in topological order and each stratum
is re-run until its fixed point is reached.

Cross-backend invariants (divide-by-zero / domain-error NULLs, slice
bounds, integer-vs-float division) match the SQL backends.

## Usage

```ts
import { DatamogExecutor } from "datamog-engine";
import { create } from "datamog-backend-native";

const backend = await create();
const executor = new DatamogExecutor(backend);
const results = await executor.execute(source);
await backend.close();
```

`--dry-run` is not available for this backend since there's no SQL to
preview.

## Options

`create(options?)` accepts:

- `trace` — a callback invoked with stratum / iteration / rule events during evaluation, which is what the playground's step-through view is built on.
- `maxIterations` — cap the fixed-point passes per stratum instead of running to convergence (the CLI's `--max-iterations`).
- `onIterationCap` — called once if a stratum hit that cap; the partial results are still returned.

This backend and `datamog-backend-seminaive` are also the only two that accept **non-linear recursion** and **parity-stratified recursion** (the `^` sigil); every SQL backend rejects both at translation time.
