# Appendix C — Backend cheatsheet

Datamog ships five backends. This appendix summarises their
tradeoffs so you can pick the right one for your use case.

## SQL backends

These compile Datalog to SQL and execute against a SQL engine.
They all share Datamog's cross-backend runtime guarantees (see
Appendix B) — division-by-zero is `NULL`, `sqrt(-x)` is `NULL`,
etc.

| Backend      | Where it runs                        | Best for                                   | Notes                                     |
| ------------ | ------------------------------------ | ------------------------------------------ | ----------------------------------------- |
| `sqlite`     | native SQLite via `bun:sqlite`       | the CLI default; very small deployments    | combined recursive CTE with `__tag` for mutual recursion |
| `sqljs`      | WASM SQLite in-process               | browser-portable; the playground default   | same CTE encoding as `sqlite`             |
| `postgres`   | external Postgres (`DATABASE_URL`)   | production / shared data; native JSON      | `CREATE RECURSIVE VIEW`; `JSONB` columns give native structural equality; no mutual recursion |

Differences that matter:

- **Mutual recursion**: SQLite/sql.js use a combined-CTE + `__tag`
  encoding, computing the whole SCC through a single CTE. The
  translator emits multiple CTEs in one `WITH RECURSIVE` block for
  Postgres, which the server refuses: two `WITH` items may not
  reference each other, so it reports `mutual recursion between
  WITH items is not implemented`. Run a mutually recursive program
  on `sqlite`, `sqljs`, `native`, or `seminaive`.
- **Ranges**: Postgres uses `generate_series`. SQLite and sql.js
  emit a recursive CTE with a literal or fixed-cap bound.
- **`concat`**: SQLite/sql.js use `GROUP_CONCAT(expr, ',' ORDER BY expr)`.
  Postgres uses `STRING_AGG(expr::TEXT, ',' ORDER BY expr)`. The
  explicit `ORDER BY` makes per-group output deterministic and
  identical across backends.
- **`CREATE VIEW`**: Postgres uses `CREATE OR REPLACE VIEW`;
  SQLite/sql.js use `CREATE VIEW IF NOT EXISTS`.
- **`value` equality**: Postgres `jsonb` compares structurally
  natively. SQLite/sql.js store `value`s as TEXT and would
  compare textually, so Datamog canonicalises (sorts object keys,
  normalises numbers) on insert — making textual equality
  coincide with structural equality. The one v1 cross-backend
  variance is `parse_json` on SQLite/sql.js: `json()` minifies but
  does not sort object keys, so two textually-different but
  structurally-equal parse results don't unify under SQLite/sql.js's
  textual equality. EDB-loaded values and Postgres `parse_json`
  results are unaffected.

## Non-SQL backends

These are pure in-memory Datalog evaluators. They share a
`Backend` interface with the SQL backends, but skip the SQL
translation entirely — useful when you want to see what's
happening under the hood, and for understanding the evaluator
directly.

| Backend      | Strategy                  | Best for                                       |
| ------------ | ------------------------- | ---------------------------------------------- |
| `native`     | naive evaluation          | clarity; pedagogical; small data               |
| `seminaive`  | seminaive evaluation      | better performance; what a "real" Datalog engine uses |

Both are single-threaded, in-process, and hold all data in
JavaScript data structures. For larger data, prefer a SQL
backend.

## Default choice

If you're developing locally and don't care about the specifics:
use `sqlite` (the CLI default — runs in-process via `bun:sqlite`,
no external server needed). For production use against an
existing database, use `postgres`. For browser deployments, use
`sqljs`.

## Feature support matrix

|                       | sqlite | sqljs | postgres | native | seminaive |
| --------------------- | :----: | :---: | :------: | :----: | :-------: |
| Core Datalog          | ✓      | ✓     | ✓        | ✓      | ✓         |
| Aggregates            | ✓      | ✓     | ✓        | ✓      | ✓         |
| Negation (stratified) | ✓      | ✓     | ✓        | ✓      | ✓         |
| Linear recursion      | ✓      | ✓     | ✓        | ✓      | ✓         |
| Mutual recursion      | ✓      | ✓     | ✗        | ✓      | ✓         |
| Non-linear recursion  | ✗      | ✗     | ✗        | ✓      | ✓         |

The `native` and `seminaive` backends don't go through SQL, so
they're the only ones that can correctly compute non-linear
recursion — and they accept it out of the box. Every SQL backend
rejects non-linear recursion at translation time (their recursive
CTE semantics would silently produce wrong results), so a program
that uses two recursive body atoms is portable only across the
in-memory backends.

Mutual recursion is the one gap that is not a considered design
choice: the translator emits SQL that Postgres declines to run.
The failure is loud, an error from the server rather than a wrong
answer, but it does mean `postgres` is the only backend that does
not implement the whole language.
