# datamog-parquet

*Part of the [Datamog](../../../README.md) monorepo.*

Apache Parquet loader plugin for Datamog. Populates extensional predicate tables from `.parquet` files, reading them with [hyparquet](https://github.com/hyparam/hyparquet) (pure JS, no WASM, no native addon).

## Usage

```ts
import { DatamogExecutor } from "datamog-engine";
import { ParquetLoader } from "datamog-parquet";

const executor = new DatamogExecutor(backend, [
  new ParquetLoader({ directory: "./data" }),
]);
```

The loader looks for `<predicate>.parquet` in the configured directory (e.g. `data/trips.parquet` for an `input predicate trips(...)` declaration).

Only the declared columns are decoded, which is what makes a columnar format worth reading: a program naming three columns of a hundred-column file pays for three. Column names are matched by exact name, undeclared columns in the file are ignored, and a declared column the file lacks is a load error naming the file.

Values are type-checked, not coerced, as in the JSONL loader.

## Type mapping

| Parquet | Datamog |
|---------|---------|
| `BOOLEAN` | `boolean` |
| `INT32`, `INT64` | `integer` |
| `FLOAT`, `DOUBLE`, `DECIMAL` | `float` |
| `BYTE_ARRAY` with `UTF8`, `UUID` | `string` |
| `JSON`, `LIST`, `MAP`, struct | `value` |
| `DATE`, `TIMESTAMP` | `string` (ISO 8601) |
| `NULL` in the file | needs a nullable column (`type?`) |

Three cases are load errors rather than conversions:

- an `INT64` outside `[-(2^53 - 1), 2^53 - 1]`, since an `integer` is a safe JS integer and rounding it silently would lose the value;
- raw bytes (a `FIXED_LEN_BYTE_ARRAY` carrying no logical type), which have no representation in the value model;
- a compression codec other than uncompressed or Snappy.

Snappy is what pyarrow, DuckDB and Spark write by default, so the codec limit rarely bites. Supporting gzip, brotli, zstd, lz4 and lzo means passing hyparquet's `compressors` option the `hyparquet-compressors` package; nothing here does that yet.

## Platform-neutral parsing

The root entry reads files, so it imports `node:path` and `Bun.file`. A consumer that already holds the bytes imports `datamog-parquet/parse-content` instead, which exports `parseParquetContent(buffer, decl)` and pulls in nothing Bun-specific.
