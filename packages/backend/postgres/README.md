# datamog-backend-postgres

*Part of the [Datamog](../../../README.md) monorepo.*

Postgres backend for Datamog, using `Bun.sql`.

## Usage

```ts
import { DatamogExecutor } from "datamog-engine";
import { create } from "datamog-backend-postgres";

const backend = await create();
const executor = new DatamogExecutor(backend);
const results = await executor.execute(source);
await backend.close();
```

Requires the `DATABASE_URL` environment variable to be set (Bun.sql reads it automatically).

`create(sql = Bun.sql)` takes an explicit connection. Pass a dedicated `new Bun.SQL(url)` when you need one that is independent of the global — a closed `Bun.sql` cannot be reopened, so sharing it across suites couples their lifetimes.

The `datamog-backend-postgres/dialect` subpath exports the `SqlDialect` on its own, without the `Bun.sql` import, for consumers that only translate.

