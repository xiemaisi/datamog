# datamog-csv

*Part of the [Datamog](../../../README.md) monorepo.*

CSV loader plugin for Datamog. Populates extensional predicate tables from CSV files.

## Usage

```ts
import { DatamogExecutor } from "datamog-engine";
import { CsvLoader } from "datamog-csv";
import { create as createBackend } from "datamog-backend-sqlite";

const backend = await createBackend();
const executor = new DatamogExecutor(backend, [
  new CsvLoader({ directory: "./data" }),
]);
```

The loader looks for `<predicate>.csv` in the configured directory (e.g. `data/parent.csv` for an `input predicate parent(...)` declaration). CSV files have a header row by default; the header must contain the declared column names, and extra header columns are ignored.

## Options

```ts
new CsvLoader({
  directory: "./data",   // where to find CSV files (required)
  hasHeader: true,       // whether CSVs have a header row (default: true)
  delimiter: ",",        // field delimiter (default: ",")
});
```

Values are automatically coerced to match the declared column types (`string`, `integer`, `float`, `boolean`, `value`). Numeric coercion is strict (canonical decimal form only, with no exponent syntax); a `value` column parses each cell as JSON.

## Platform-neutral parsing

The root entry reads files, so it imports `node:path` and `Bun.file`. Consumers that already hold the text — the browser playground, the VS Code extension — import `datamog-csv/parse-content` instead, which exports `csvRowsFromKeyed` and `csvRowsFromPositional` and pulls in nothing Bun-specific.
