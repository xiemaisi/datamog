# datamog-cli

*Part of the [Datamog](../../README.md) monorepo.*

Command-line interface for running Datamog programs. Uses in-memory SQLite (`bun:sqlite`) by default, or Postgres when `DATABASE_URL` is set.

## Usage

```bash
# Start the interactive REPL
bun run datamog

# Start the ndjson REPL used by integrations
bun run datamog --json

# Run with in-memory SQLite (no database setup needed)
bun run datamog program.dl

# Evaluate a named `output predicate` instead of the `?-` default
bun run datamog program.dl reachable

# Run against Postgres
DATABASE_URL=postgres://localhost:5432/mydb bun run datamog program.dl

# Select a backend explicitly
bun run datamog --backend sqlite program.dl
bun run datamog --backend postgres program.dl
bun run datamog --backend sqljs program.dl
bun run datamog --backend native program.dl
bun run datamog --backend seminaive program.dl

# Specify a separate data directory
bun run datamog --data-dir ./data program.dl

# Load a predicate from a specific file or HTTP(S) URL (input flags follow the program)
bun run datamog program.dl --parent /path/to/parents.csv
bun run datamog program.dl --parent https://example.com/parents.csv

# Load a predicate from a Google Sheet (requires GOOGLE_API_KEY)
GOOGLE_API_KEY=... bun run datamog \
  program.dl \
  --scores https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit

# Multiple explicit sources
bun run datamog \
  program.dl \
  --edges graph.csv \
  --weights weights.jsonl

# Preview generated SQL without executing
bun run datamog --dry-run program.dl
```

## Loading data

By default, the CLI looks for data files in the data directory (the directory containing the `.dl` file, or the directory given by `--data-dir`). You can override an individual input predicate `p` with a like-named flag `--p source` (placed after the program; a kebab flag like `--road-network` aliases the predicate `road_network`), or `--input name=source` for a name no flag can express, where `source` is a local path, an HTTP(S) URL ending in a supported extension, a Google Sheets share URL, or a GitHub shorthand (`github:OWNER/REPO/PATH[#REF]`, `gh:` alias; `REF` defaults to `HEAD`).

A program can also name its own sources with `:=` bindings, either a data file (`input predicate p(...) := "parents.csv"`) or an instance of another module (`:= from "mod.dl"(...)`, resolved relative to the program file). Precedence: an explicit `--<input>` flag beats a `:=` data binding, which beats auto-loading by convention.

Five formats are supported:

### CSV

Place a file named `<predicate>.csv` in the data directory. The first row is treated as a header by default.

```
name,child
alice,bob
bob,carol
```

### JSONL

Place a file named `<predicate>.jsonl` in the data directory. Each line is a JSON object containing the declared columns; extra fields are ignored. Values should use native JSON types (numbers, booleans), not strings.

```jsonl
{"name": "alice", "follows": "bob"}
{"name": "bob", "follows": "carol"}
```

A single-`value`-column extensional consumes each line as the column's whole contents (any JSON shape goes), bypassing the field-mapping step.

### JSON (whole file)

Place a file named `<predicate>.json` in the data directory. The extensional declaration must have exactly one `value`-typed column; the file is parsed and inserted as a single row. This is the natural shape for config blobs and manifests.

### Mermaid

Place a file named `<predicate>.mmd` (a Mermaid `graph TD` / `graph LR` block) in the data directory. The loader extracts edges as `(source, target)` pairs, a convenient way to author small graph EDBs that double as illustrations in markdown.

### Google Sheets

Pass a Google Sheets share URL as the input predicate's source:

```bash
# Public spreadsheets work without any auth configuration
bun run datamog \
  program.dl \
  --scores https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit

# For private sheets, set GOOGLE_API_KEY or service account credentials
GOOGLE_API_KEY=... bun run datamog \
  program.dl \
  --scores https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

The sheet must have a header row with column names matching the `input predicate` declaration. Public spreadsheets are fetched via CSV export and require no credentials. For private sheets, set `GOOGLE_API_KEY` or `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`.

## Options

The one positional argument after the program picks which output to evaluate: an `output predicate` name, or `default` for the `?-` query. Omitted, it evaluates the `?-` default.

| Option | Description |
|--------|-------------|
| `--<input> source` | Supply data for input predicate `<input>` from a local file or HTTP(S) URL (`.csv`, `.jsonl`, `.json`, `.mmd`), a Google Sheets URL, or a GitHub shorthand `github:OWNER/REPO/PATH[#REF]` (`gh:` alias). Placed after the program; a kebab flag aliases a snake_case predicate |
| `--input name=source` | Same, with an explicit predicate name (escape hatch for names no flag can express) |
| `--data-dir <path>` | Base directory loaders read from (defaults to the program's directory; the current working directory in `--repl` mode) |
| `--all` | Evaluate every output (the default `?-` plus every named output) instead of a single one |
| `--output-format <format>` | Output format: `table` (default), `csv`, `jsonl`, `jsonl-flat`, `mermaid`, or `ascii-graph` |
| `--csv-no-header` | CSV files have no header row (columns are matched by position) |
| `--dry-run` | Print generated SQL without executing |
| `--obligations` | Print the refinement proof obligations as SMT-LIB 2 instead of evaluating |
| `--verify` | Discharge those obligations with an SMT solver |
| `--solver <command>` | Solver to run for `--verify` (default `z3 -in`); implies `--verify` |
| `--strict-contracts` | Treat refinement-contract advisories as errors |
| `--warn-finiteness` | Print a warning for each predicate column whose values may grow unboundedly across iterations |
| `--max-iterations <n>` | Cap fixed-point passes per stratum and stop with a note instead of looping (native/seminaive only) |
| `--repl` | Start the REPL explicitly (this is the default when no `program.dl` is given) |
| `--json` | In REPL mode, emit one ndjson event per declaration, rule, query, or command |
| `--backend <postgres\|sqlite\|sqljs\|native\|seminaive>` | Backend (default: auto-detected from `DATABASE_URL`) |
| `-h`, `--help` | Show help message |

## Examples

The `examples/` directory holds 79 runnable programs covering transitive closure, stratified negation, aggregates, mutual recursion, classic puzzles, JSON/`value` handling, propositional logic, and Boolean-circuit solvers. Run any of them with:

```bash
bun run datamog packages/cli/examples/<name>/<name>.dl
```

Some use non-linear recursion (rejected by the SQL backends); those carry a `native-only` marker file and run on `--backend native` or `--backend seminaive`.
