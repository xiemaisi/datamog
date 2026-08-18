# datamog-backend-seminaive

*Part of the [Datamog](../../../README.md) monorepo.*

Semi-naive in-memory backend for Datamog. Like the `datamog-backend-native`
package it interprets Datalog directly rather than compiling to SQL, but
inside each recursive stratum it only re-derives tuples that could have
produced new results: at every iteration, each rule is forced to read
from the previous iteration's *delta* on at least one body atom. Non-
recursive strata are evaluated in a single pass.

The planner, atom matcher, aggregate reducer and term evaluator are shared
with `datamog-backend-native`; only the fixed-point driver differs.
Cross-backend invariants (divide-by-zero and domain errors having no value, slice
bounds, integer-vs-float division) match the other backends.

## Usage

```ts
import { DatamogExecutor } from "datamog-engine";
import { create } from "datamog-backend-seminaive";

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

This backend and `datamog-backend-native` are also the only two that accept **non-linear recursion** and **parity-stratified recursion** (the `^` sigil); every SQL backend rejects both at translation time.
