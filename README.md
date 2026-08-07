# Datamog

<p align="center">
  <img src="datamog.jpg" alt="Datamog" width="300" />
</p>

<p align="center">
  <b>An educational Datalog you can run in your terminal, your browser, or your notebook.</b>
</p>

<p align="center">
  <a href="https://max-schaefer.github.io/datamog/">Playground</a> ·
  <a href="doc/spec.md">Language spec</a> ·
  <a href="doc/walkthrough/README.md">Walkthrough</a> ·
  <a href="DEVELOPMENT.md">Development</a>
</p>

Datamog is a small Datalog dialect built for **learning how Datalog works**. You
write Horn-clause rules over relations, and Datamog runs them on the backend of
your choice (three SQL databases or two pure-TypeScript in-memory evaluators),
all honouring the same language semantics. On top of the classic core
(recursion, stratified negation, aggregates) it adds first-class support for
JSON, algebraic data types, and a module system, and it ships with a
browser playground, a VS Code extension, a REPL, and a Jupyter magic.

It is a teaching tool, not a production database. If you want to understand
recursion, stratified negation, seminaive evaluation, or how Datalog compiles to
SQL, and to learn it by reading, running, and stepping through code, this is for
you.

## Example

```prolog
# ancestor.dl: who descends from whom
input predicate parent(name: string, child: string).

ancestor(X, Y) :- parent(X, Y).                  # base case
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).  # recursive case

?- ancestor("alice", X).
```

```bash
bun run datamog ancestor.dl   # parent data loads from ./parent.csv by convention
```

**[Try it in the browser, no install needed](https://max-schaefer.github.io/datamog/)**

## Highlights

- **Five backends, one language.** The same program runs on Postgres, SQLite, or
  sql.js through a SQL translator, or on the pure-TypeScript `native` /
  `seminaive` evaluators with no SQL at all, which is handy for tracing the
  semantics step by step. See the [language spec](doc/spec.md).
- **Nested data, first-class.** A `value` type is the union of every JSON shape
  (null, primitives, arrays, objects) with subscript, slice, iteration, and
  structural equality that agree byte-for-byte across every backend. See
  [Working with values](doc/walkthrough/14-json.md).
- **Algebraic data types via proof terms.** Name a rule `p(...) :: Ctor` and the
  predicate becomes an ADT whose derivations are its values: enums, pairs, Peano
  naturals, lists, parse trees. See [Proof terms](doc/walkthrough/15-proof-terms.md).
- **A module system.** A file is a function from its input predicates to its
  outputs; bind an input with `:=` to a data file or to an instance of another
  module. See [Modules](doc/walkthrough/16-modules.md).
- **Optional, checked contracts.** Column types are inferred; annotate a column
  or a rule head when you want to pin one down, including whether it may be
  NULL. A head position can carry a *proposition* rather than a type
  (`span(X, Y, _: Y > X)`), which is checked against the tuples the predicate
  derives and costs nothing at runtime otherwise.
- **Integrity constraints.** Declare a conjunction that must have no solutions
  (`!- p(X), not q(X).`) and its tuples become the counterexamples, reported
  before any query runs. See the [language spec](doc/spec.md).
- **Parity-stratified recursion.** A `^` sigil marks the anti-monotone side of a
  recursion through an even number of negations, evaluated by an alternating
  fixed point, which is what a `forall`-shaped rule needs. See
  [Parity](doc/walkthrough/17-parity.md).
- **Diagnostics that explain.** Safety, arity, stratification, and finiteness
  checks report the offending source span, and the playground visualises a
  rejected negation or finiteness cycle.

## Getting started

Datamog is a Bun/TypeScript project. You need [Bun](https://bun.sh) 1.3 or newer.

```bash
bun install                          # install workspace dependencies
bun run datamog                      # start the interactive REPL
bun run datamog path/to/program.dl   # run a program (in-memory SQLite by default)
```

Choose a backend, or preview the generated SQL without running it:

```bash
bun run datamog --backend native program.dl    # in-memory evaluator, easy to trace
bun run datamog --backend sqljs  program.dl     # SQLite compiled to WebAssembly
bun run datamog --dry-run        program.dl     # print the generated SQL, don't execute
DATABASE_URL=postgres://localhost/mydb bun run datamog --backend postgres program.dl
```

The CLI loads each input predicate `p` from a like-named data file next to the
program (`p.csv`, `p.jsonl`, `p.json`, `p.mmd`), or from a file/URL/Google
Sheet/GitHub path you pass explicitly. The [CLI README](packages/cli/README.md)
covers data loading, output formats, and the flags; `datamog --help` is the
authoritative list.

Seventy-nine runnable programs live in
[`packages/cli/examples/`](packages/cli/examples/), covering transitive closure,
stratified negation, aggregates, puzzles, JSON handling, proof-term ADTs, and
Boolean-circuit solvers:

```bash
bun run datamog packages/cli/examples/family/family.dl
```

## Playground

The [playground](https://max-schaefer.github.io/datamog/) is a zero-install,
fully client-side IDE: write a program, attach CSV/JSONL data, and run the whole
pipeline (parse, analyze, translate, execute) in your browser. SQL runs on
sql.js (SQLite compiled to WASM); the `native` / `seminaive` evaluators run
directly in JavaScript. It offers live diagnostics, jump-to-definition, a
dependency-graph view, and a step-through trace of the in-memory evaluators. It
is redeployed on every push to `main`.

```bash
bun run playground:dev     # run it locally
```

## Packages

Datamog is a Bun-workspace monorepo. The pieces, from foundation to frontend:

| Package | Description |
|---------|-------------|
| [`datamog-parser`](packages/parser) | Langium grammar, generated parser, and AST types |
| [`datamog-core`](packages/core) | Analyzer (safety, dependency graph, recursion), type inference |
| [`datamog-engine`](packages/engine) | SQL translator, executor, and the `Backend` / loader interfaces |
| [`datamog-backend-postgres`](packages/backend/postgres) | Postgres backend (via `Bun.sql`) |
| [`datamog-backend-sqlite`](packages/backend/sqlite) | SQLite backend (via `bun:sqlite`, in-memory by default) |
| [`datamog-backend-sqljs`](packages/backend/sqljs) | sql.js backend (SQLite compiled to WASM) |
| [`datamog-backend-native`](packages/backend/native) | In-memory naive evaluator (no SQL) |
| [`datamog-backend-seminaive`](packages/backend/seminaive) | In-memory seminaive evaluator (no SQL) |
| [`datamog-csv`](packages/loader/csv) | CSV loader |
| [`datamog-jsonl`](packages/loader/jsonl) | JSONL loader |
| [`datamog-json`](packages/loader/json) | Whole-file JSON loader (single-row tables) |
| [`datamog-gsheet`](packages/loader/gsheet) | Google Sheets loader |
| [`datamog-mermaid`](packages/loader/mermaid) | Mermaid graph/flowchart loader |
| [`datamog-repl`](packages/repl) | Incremental REPL session engine |
| [`datamog-cli`](packages/cli) | Command-line interface |
| [`datamog-playground`](packages/playground) | Browser playground (Preact + sql.js, no server) |
| [`datamog-vscode`](packages/vscode-extension) | VS Code extension (highlighting, diagnostics, completion, go-to-definition, run command) |

A sibling Python package, [`datamog-magic`](python/datamog-magic), provides a
`%%datamog` IPython/Jupyter cell magic that drives the CLI.

## Documentation

- [Language specification](doc/spec.md): the full reference for syntax,
  semantics, the type system, and SQL translation.
- [Language walkthrough](doc/walkthrough/README.md): the feature-by-feature
  tutorial (chapters 00-17 plus appendices), with runnable code and exercises.
- [Case studies](doc/case-studies/README.md): a puzzle-driven companion that
  builds end-to-end solutions to bigger problems.
- [Comparison with other Datalog systems](doc/comparison.md): how Datamog
  relates to Soufflé, CodeQL, Datomic, DES, Flix, and others.
- [Jupyter notebook tutorial](doc/jupyter/README.md): runnable `%%datamog`
  cells with pandas DataFrame binding.
- [Embed tutorials](doc/embed-tutorials/README.md): Markdown whose code blocks
  render as live, editable mini-playgrounds.
- [FLOLAC 2026 course slides](https://max-schaefer.github.io/datamog/slides/):
  *Introduction to Logic Programming with Datalog*.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full guide. The essentials, run from
the repository root:

```bash
bun test             # run all tests
bun run typecheck    # tsc -b across the workspace
bun run check        # lint and format check (biome); check:fix to auto-fix
bun run e2e          # Playwright e2e suite for the playground
```

## License

[MIT](LICENSE) © 2026 Max Schaefer.

## Trademarks

The Datamog mascot is original art, a play on the Mercedes-Benz Unimog;
"Mercedes-Benz" and "Unimog" are trademarks of Mercedes-Benz Group AG. The
Part 1 course material uses Pokémon as a running example; "Pokémon" and Pokémon
names, types, moves, and abilities are trademarks of Nintendo, Creatures Inc.,
and GAME FREAK inc. All such marks are used only nominatively, for educational
illustration; this project is not affiliated with or endorsed by their owners.
