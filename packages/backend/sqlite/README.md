# datamog-backend-sqlite

*Part of the [Datamog](../../../README.md) monorepo.*

SQLite backend for Datamog, using `bun:sqlite`. Uses an in-memory database by default.

## Usage

```ts
import { DatamogExecutor } from "datamog-engine";
import { create } from "datamog-backend-sqlite";

// In-memory (default)
const backend = await create();

// Or with a file path
const backend = await create("./my-database.sqlite");

const executor = new DatamogExecutor(backend);
const results = await executor.execute(source);
backend.close();
```

## Dialect subpath

`datamog-backend-sqlite/dialect` exports the `SqlDialect` without the root entry's `bun:sqlite` import. `datamog-backend-sqljs` consumes it for exactly that reason: it shares SQLite's SQL but runs on WASM, where `bun:sqlite` does not exist.

