# Datamog — Project Instructions

Educational Datalog implementation with multiple evaluation backends — SQL (Postgres, SQLite via bun:sqlite, sql.js/WASM) and pure-TS in-memory interpreters (naive, seminaive). Every backend honours the same language semantics; the SQL ones go via a translator, the interpreters evaluate the AST directly. TypeScript/Bun monorepo. Uses **bun** as package manager and runtime — do not use pnpm/npm/yarn.

Before running anything, verify `bun` is on PATH (`which bun`). If it is not, install via `curl -fsSL https://bun.sh/install | bash` and add `$HOME/.bun/bin` to PATH for the session (`export PATH="$HOME/.bun/bin:$PATH"`). The installer does not persist PATH, so export it on every new shell.

## Working in this repository

This is the canonical shared instruction file for coding agents. Root `CLAUDE.md`
imports it; keep shared rules here rather than maintaining tool-specific copies.

Read [DEVELOPMENT.md](DEVELOPMENT.md) for setup and validation workflows. Before
changing a subsystem, read the relevant sections of the
[development reference](doc/development-reference.md), which covers architecture,
runtime invariants, SQL dialects, interpreters, editors, examples, and tutorials.
Consult the [language specification](doc/spec.md) for current semantics and the
[design index](doc/design/README.md) for proposal status and remaining work.

## Essential commands and validation

Run commands from the repository root. Bun 1.3 or newer is required.

```bash
bun install --frozen-lockfile
bun test
bun run test:pg           # full suite with a throwaway Postgres cluster
bun run typecheck
bun run check
bun run generate:parser  # after grammar changes
bun run build:cli
bun run docs:html
```

Run tests and checks appropriate to the change. Use `bun:test` for TypeScript
tests. Run `bun run e2e` for playground behavior changes and the separate Python
suite for notebook magic changes (see DEVELOPMENT.md). `bun test` skips Postgres
suites when `DATABASE_URL` is unset: use `bun run test:pg` for backend validation,
and report any skipped coverage. Real Postgres is required; `pg-mem` is not a
substitute. Use only a dedicated test database because tests reset its schema.
See the development reference for additional commands and Postgres setup.

## Adding a new language feature

Typical touch points (in dependency order):

1. **Grammar** (`parser/src/datamog.langium`): add/modify rules; run `bun run generate:parser` from the repository root to regenerate `parser/src/generated/`
2. **Post-processing** (`parser/src/post-process.ts`): add transforms if the new feature needs AST normalization (name desugaring, type rewriting, …)
3. **Core re-exports** (`core/src/ast.ts`, `core/src/index.ts`): re-export new types from the generated AST; if the post-processed shape differs from the raw grammar shape (`AggregateCall`, `Subscript`/`Slice`), widen the relevant union here
4. **Analyzer** (`core/src/analyzer.ts`): update `checkSafety()` — phase 1 collects safe vars (fixed-point iteration over atoms + equalities + ranges), phase 2 walks body elements and reports unsafe variables with a source position
5. **Type inference** (`core/src/types.ts`): update var-type environment building in the fixed-point loop, add validation if needed. Column types must unify to a single basic type; `unifyColumnType` reports conflicts
6. **SQL translator** (`engine/src/translator.ts`): update `translateRule()` — Pass 1 registers bindings from positive atoms, Pass 2 iterates to a fixed point over equalities / range atoms; comparisons and non-binding equalities are collected and emitted as WHERE conditions at the end
7. **In-memory interpreters** (`backend/native/src/{planner,values}.ts`): mirror the new feature in the planner/value model so the native and seminaive backends produce the same results. `planner.ts` is shared with seminaive; `values.ts` is the place to land any new runtime invariant (NULL propagation, partial function, etc.)
8. **Lexical surface**, if the feature adds a keyword or operator: `core/src/keywords.ts` (feeds the playground highlighter and completion), `playground/src/lib/highlight.ts` (the CodeMirror stream tokenizer, which needs a hand-written branch for anything that is not a plain keyword), and `vscode-extension/syntaxes/datamog.tmLanguage.json` (hard-codes its keyword alternation, so it does not pick up `keywords.ts` automatically)

## Language Specification

`doc/spec.md` is the detailed language specification. Keep it in sync when adding or changing language features, semantic rules, type system behavior, or SQL translation logic.

## Documentation style

- Fence Datalog / Datamog source code in Markdown as ```` ```prolog ```` — it's not really Prolog, but the Prolog highlighter is a close enough fit to syntax-colour atoms, variables, and operators correctly. Keep other fences language-appropriate (```` ```sql ````, ```` ```bash ````, ```` ```csv ```` or plain ```` ``` ```` for tabular data).
- Always capitalise "Datamog" in prose (the product name), including mid-sentence. The CLI command and package names stay lowercase as code identifiers (`datamog`, `datamog-*`).
- Prefer ```` ```mermaid ```` diagrams over ASCII art for graphs, trees, and other structural pictures. GitHub renders them natively, and a `graph TD`/`graph LR` Mermaid block doubles as valid input for Datamog's own `MermaidLoader` — so the same source can be an illustration and a data file.

## Conventions

- Parser uses Langium grammar (`datamog.langium`) with generated lexer/parser/AST; post-processing in `post-process.ts`
- Source positions available via Langium's `$cstNode` on AST nodes
- `ParseError` with line/column for user-facing error messages, `AnalyzerError` for semantic errors
- Tests use `bun:test` with TDD approach
- `Backend` is the abstraction for evaluation targets — implement it to add new databases (with `sqlDialect` + `execute`) or new non-SQL evaluators (with `evaluateProgram` + `insertRows`)
- Loaders use `coerceValue` (string → typed, for CSV/GSheet) or `checkValue` (native type validation, for JSONL)
- Example tests (`cli/test/examples.test.ts`) auto-generate `expected.json` if missing; delete it to regenerate. Examples no SQL backend can run (non-linear recursion, parity-stratified recursion) carry an empty `native-only` marker file in their dir: the sqlite run is skipped and seminaive becomes the canonical `expected.json` source
- The examples suite also runs every example on **sqljs**, whose one gap is recorded in `SQLJS_KNOWN_FAILURES`: sql.js's stock WASM build omits SQLite's math extension, so `LN` is missing, which takes out `ln`, `**` and `exp` (the last two guard against overflow with `LN(MAX_FLOAT)`). sql.js also defines `LOG` as the natural log where SQLite's extension makes it base 10; nothing emits `LOG`, so that one is latent
- The examples suite also runs every example on **postgres** when `DATABASE_URL` is set (skipped otherwise). That block shares one backend on a dedicated `new Bun.SQL(...)` connection (the global `Bun.sql` belongs to `backend/postgres/test`, and a closed connection cannot be reopened) and wipes the `public` schema between examples, since Postgres keeps tables and views across runs. Examples Postgres cannot run are listed in `POSTGRES_KNOWN_FAILURES` with the reason and marked `test.failing`, so the suite stays green and a fix forces the entry's removal. One entry is left, `shannon-entropy`, a last-bit float difference that will not be fixed; see `doc/design/postgres-alignment.md`
- Examples run through `prepareElaborated`, so one may import modules with `:=` (see `examples/modular-order`). Keep the imported `.dl` files in the same directory; the entry point is then `<dir>.dl`, since a directory with several `.dl` files is otherwise ambiguous. The playground has no module resolver, so a module example cannot carry a `playground.json`
