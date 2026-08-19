# datamog-playground

*Part of the [Datamog](../../README.md) monorepo.*

The browser-based Datamog playground: a zero-install, fully client-side IDE for
writing and running Datamog programs. There is no backend server; the whole
pipeline (parse, analyze, translate, execute) runs in your browser.

**Live: [xiemaisi.github.io/datamog](https://xiemaisi.github.io/datamog/)**

## Features

- **CodeMirror editor** with Datamog syntax highlighting, jump-to-definition,
  recursive-call markers, smart auto-complete, and live diagnostics (parse
  errors, arity mismatches, unsafe variables, unstratifiable negation,
  finiteness warnings, nullness risks, and inert `^` sigils and refinement
  contracts).
- **Cycle visualiser**: a rejected negation or finiteness cycle carries a "Show
  cycle" action that highlights the predicates and rules involved.
- **Backend picker**: run on SQLite (via sql.js), the `native` / `seminaive`
  in-memory evaluators, or generate PostgreSQL SQL (shown, not executed).
- **Tabbed results**: query rows, generated SQL, a Mermaid dependency graph,
  and a per-iteration step trace for the in-memory evaluators.
- **Data panel**: paste CSV/JSONL or fetch a CORS-enabled CSV URL per input
  predicate; rows are held in memory as the EDB.
- **Example dropdown** of the runnable programs that opt in with a
  `playground.json`, and a toolbar link to the rendered language spec.

SQL runs on [sql.js](https://sql.js.org/) (SQLite compiled to WASM); the
`native` / `seminaive` evaluators run directly in JavaScript. Execution happens
in a Web Worker so the UI stays responsive.

## Running it

From the repository root:

```bash
bun run playground:dev     # start the Vite dev server
bun run playground:build   # production build (static files in dist/)
```

The playground is redeployed to GitHub Pages on every push to `main`.

## Embeddable variant

A lightweight embed (`src/embed/`) turns the ```` ```datamog ```` code blocks in a
Markdown tutorial into live, editable mini-playgrounds. It runs on the main
thread with the pure-TypeScript `native` / `seminaive` backend (no Web Worker, no
WASM), so many instances can share one page. See
[`doc/embed-tutorials/`](../../doc/embed-tutorials/README.md).

## Tech stack

Preact, Vite, CodeMirror 6, and sql.js. Built as a static single-page app.
