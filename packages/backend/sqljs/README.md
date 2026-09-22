# datamog-backend-sqljs

*Part of the [Datamog](../../../README.md) monorepo.*

[sql.js](https://sql.js.org/) (WASM SQLite) backend for Datamog. Runs entirely in-memory with no native dependencies. Datamog uses it in browser bundles and through its Bun workspace; direct Node.js consumption is not a supported package entry point. Reuses the SQLite SQL dialect from `datamog-backend-sqlite`.

This is the playground's SQL option; the playground defaults to `native`.
The stock sql.js build lacks `LN`, so Datamog's `ln`, `exp`, and `**` operations
fail on this backend. See the [backend limitations](../../../doc/spec.md#61-overview).

## Usage

```ts
import { DatamogExecutor } from "datamog-engine";
import { create } from "datamog-backend-sqljs";

const backend = await create();
const executor = new DatamogExecutor(backend);
const results = await executor.execute(source);
backend.close();
```
