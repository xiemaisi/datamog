# datamog-jsonl

*Part of the [Datamog](../../../README.md) monorepo.*

JSONL (JSON Lines) loader plugin for Datamog. Populates extensional predicate tables from `.jsonl` files.

## Usage

```ts
import { DatamogExecutor } from "datamog-engine";
import { JsonlLoader } from "datamog-jsonl";

const executor = new DatamogExecutor(backend, [
  new JsonlLoader({ directory: "./data" }),
]);
```

The loader looks for `<predicate>.jsonl` in the configured directory (e.g. `data/follows.jsonl` for an `input predicate follows(...)` declaration). Each line is a JSON object containing the declared column names; extra keys are ignored:

```jsonl
{"user":"alice","friend":"bob"}
{"user":"carol","friend":"dave"}
```

Values are type-checked against the declared column types (e.g. a JSON string is rejected for an `integer` column). Unlike the CSV loader, no coercion is performed -- values must already have the correct JSON type.

## Platform-neutral parsing

The root entry reads files, so it imports `node:path` and `Bun.file`. Consumers that already hold the text — the browser playground, the VS Code extension — import `datamog-jsonl/parse-content` instead, which exports `parseJsonlContent` and pulls in nothing Bun-specific.
