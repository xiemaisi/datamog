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

## Empty cells and `?`

An empty cell is a `null`, and a column has to say it accepts one. Declare it with a `?` suffix (`age: integer?`) and the empty cell loads as the `null` value; on a non-nullable column it is a **hard load error** naming the file, line and column, not a silently missing value.

`string` is the exception, at both spellings. An empty cell is the empty string, which is a perfectly good `string` — and it stays the empty string under `string?` too, because `""` is a value of that type and a nullable type has to accept everything its base type does. So **no CSV cell puts a `null` in a `string?` column**: the format cannot tell a quoted `""` from a bare empty cell. Use the JSONL or JSON loader, which carry a real `null`, where a nullable text column needs one.

## Platform-neutral parsing

The root entry reads files, so it imports `node:path` and `Bun.file`. Consumers that already hold the text — the browser playground, the VS Code extension — import `datamog-csv/parse-content` instead, which exports `csvRowsFromKeyed` and `csvRowsFromPositional` and pulls in nothing Bun-specific.

## Structural contracts

Columns can declare closed records and homogeneous arrays, directly or through
`type` aliases. They retain `value` storage and are validated on loading; errors
identify the column and nested field/index path. Optional fields (`age?: integer`)
and nullable fields (`age: integer?`) have different meanings. Nominal proof
types are not valid external input contracts, including inside arrays or optional
fields. See [the language specification](../../../doc/spec.md#22-extensional-declarations).
