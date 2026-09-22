# A Datalog tutorial with Datamog

A hands-on introduction to Datalog that develops three parallel
intuitions alongside the language itself:

- a **logic** view — Datalog as a restricted fragment of first-order
  logic, evaluated to its least fixed point;
- a **SQL** view — Datalog as a very high-level surface syntax for
  relational views, including recursive ones;
- an **imperative** view — Datalog as what you'd otherwise hand-write
  as a nest of Python loops, except that one Datalog rule often
  covers several Python functions because a relation has no
  preferred query direction.

Every runnable snippet in this tutorial is an executable `.dl` program
under `doc/walkthrough/code/`. You can run each one directly, inspect the
SQL it compiles to, or paste it into the [playground][pg].

## Who this is for

You should be comfortable reading some code and have seen `SELECT ...
FROM ... WHERE ...` before. Prior exposure to first-order logic helps
but is not required — we introduce the pieces we use as we go.

## How to read it

Chapters are meant to be read in order. Each one follows the same shape:

1. **A motivating problem.** Stated in prose before any code.
2. **A Datalog solution.** Built up incrementally.
3. **"Lens" callouts.** `Logic lens.` connects the feature to
   first-order logic, fixed points, or model theory. `SQL lens.`
   connects it to SQL (usually via `--dry-run` output).
   `Imperative lens.` contrasts against the hand-written Python you'd
   otherwise reach for. Not every chapter uses all three — we add a
   callout only where that angle illuminates something new.
4. **Exercises.** Rated ★ (straightforward), ★★ (needs thought),
   ★★★ (non-trivial). Starter programs live under
   `code/chNN/`; solutions under `solutions/chNN/`.
5. **Recap.** Three bullets tying the new idea back to both lenses.

Skip any "lens" aside you already know — the main thread runs through
the chapter body.

## How to run the code

From the repo root:

```bash
bun run datamog doc/walkthrough/code/ch01/people.dl
```

Useful flags while working through the tutorial:

- `--dry-run` — print the generated SQL instead of executing it.
- `--backend <name>` — pick a backend. `sqlite` (via `bun:sqlite`)
  is the CLI default unless `DATABASE_URL` selects Postgres.
  `native` is the [playground][pg] default; it and `seminaive` run
  in-memory evaluators with no SQL. `sqljs` provides WASM SQLite.

The [playground][pg] runs the same pipeline client-side in a Web
Worker — useful when you want to tweak a program without leaving
the browser.

## Table of contents

### Part I — Getting started

- [Chapter 0. Why Datalog?](00-intro.md)
- [Chapter 1. Facts, queries, and predicates](01-facts-and-queries.md)
- [Chapter 2. Rules, variables, and joins](02-rules-and-joins.md)

### Part II — The heart of Datalog

- [Chapter 3. Multiple rules and disjunction](03-disjunction.md)
- [Chapter 4. Recursion and transitive closure](04-recursion.md)
- [Chapter 5. How Datalog runs: naive and seminaive evaluation](05-evaluation.md)
- [Chapter 6. Arithmetic, ranges, and strings](06-arithmetic.md)

### Part III — Beyond pure Horn clauses

- [Chapter 7. Safety and the type system](07-safety.md)
- [Chapter 8. Negation and stratification](08-negation.md)
- [Chapter 9. Aggregates](09-aggregates.md)

### Part IV — Putting it to work

- [Chapter 10. Modelling with Datalog](10-modelling.md)
- [Chapter 11. Search and puzzles](11-puzzles.md)
- [Chapter 12. Case study — program analysis](12-program-analysis.md)
- [Chapter 13. Case study — graph algorithms](13-graphs.md)
- [Chapter 14. Working with values](14-json.md)

### Part V — Extensions

- [Chapter 15. Proof terms](15-proof-terms.md)
- [Chapter 16. Modules](16-modules.md)
- [Chapter 17. Recursion through negation](17-parity.md)

### Companion tutorials

Three standalone tutorials live alongside this walkthrough:

- [Checking and proving invariants](../invariants/README.md) — compare types,
  runtime selection, integrity constraints, refinements, solver verification,
  proof captures, and module contracts through runnable examples.
- [Case studies](../case-studies/README.md) — a puzzle-driven companion
  track adapted from the CodeQL, DES, and Soufflé tutorials (detective,
  heir, river crossing, shortest path, points-to analysis, and more).
  Read after Parts I–IV when you want to see the language applied
  end-to-end on bigger problems, or as a motivation-first alternative
  entry point.
- [Datamog in a Jupyter notebook](../jupyter/README.md) — a runnable
  notebook that drives Datamog from IPython via the `datamog-magic`
  cell magic.

### Appendices

- [A. The three lenses cheat sheet](A-lenses.md)
- [B. Datamog quick reference](B-quickref.md)
- [C. Backend cheatsheet](C-backends.md)
- [D. Further reading](D-reading.md)
- [E. Solutions index](E-solutions.md)

## A note on scope

This tutorial teaches *Datamog*-flavoured Datalog. Most of what you
learn transfers directly to other Datalog dialects (Soufflé, LogicBlox,
`datalog` in Clojure, Cozo, ...). Places where Datamog diverges from
"textbook Datalog" — e.g. its SQL backends' rejection of non-linear recursion,
or its strict type system — are flagged in the relevant chapter.

For a precise description of the language, see
[`doc/spec.md`](../spec.md). This tutorial is the friendly front door;
the spec is the source of truth.

[pg]: https://xiemaisi.github.io/datamog/
