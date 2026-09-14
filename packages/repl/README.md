# datamog-repl

*Part of the [Datamog](../../README.md) monorepo.*

Incremental REPL session engine for Datamog. It accumulates declarations, rules,
and queries across inputs (each `input predicate`, rule, or `?-` query adds to a
growing session) and re-runs affected outputs as the program evolves. This is
the shared core behind the interactive CLI REPL and the `--repl --json` protocol
that programmatic clients (such as the [`datamog-magic`](../../python/datamog-magic)
Jupyter cell magic) speak.

## API

`DatamogRepl` drives a session: feed it source text, get back a list of typed
events describing what happened (a predicate declared, a rule added, query
results, generated SQL, an error, and so on).

```ts
import { DatamogRepl, type ReplEvent } from "datamog-repl";

const repl = new DatamogRepl(sessionFactory, options);
const events: ReplEvent[] = await repl.feed("input predicate parent(a, b).");
await repl.feed("?- parent(X, Y).");
await repl.close();
```

The `sessionFactory` supplies a backend/executor pair (so the same engine works
over SQLite, sql.js, or the in-memory evaluators), and `feed` returns the events
produced by that chunk. The event union (`DeclaredEvent`, `RuleEvent`,
`ResultEvent`, `SqlEvent`, `SchemaEvent`, `ErrorEvent`, and so on) is exported for
consumers that render or serialise it.

`boundary.ts` also exports helpers for line-oriented input handling, used by the
CLI to decide when to submit a multi-line entry: `isInputComplete` (has a full
statement been typed?) and `offsetToLineColumn`.

## Type contracts across chunks

Successful chunks make their type aliases and predicate names available to later
type annotations. Failed chunks publish neither, and reset clears the context.
For example, after `nat(0) :: Zero.`, a later chunk can declare `type N = nat.`.
Proof capture and constructor-match lowering still needs the producer in the same
chunk; cross-chunk type-name resolution does not remove that limitation.

## Drivers

- [`packages/cli/src/repl-driver.ts`](../cli/src/repl-driver.ts) wraps this
  engine for interactive terminal use.
- `datamog --repl --json` emits one JSON event per line for programmatic clients.
