# Chapter 0 — Why Datalog?

> *"Whatever can be stated logically as a fact about data can in
> principle be queried logically."*

Datalog is a small declarative language for querying and deriving
relations from facts. You can think of it as sitting between SQL and
Prolog, and it inherits something from each:

- From SQL, the mindset that everything is a relation (a set of
  rows over typed columns).
- From Prolog, the rule-based style of definition — you give the
  general principle once and the machine works out the specific
  consequences.

Critically, Datalog gives up some of Prolog's power (no function
symbols, no cuts, no arbitrary terms) in exchange for two very nice
properties: **every program terminates**[^termination], and **the
meaning of a program does not depend on the order in which you wrote
the rules**.

[^termination]: Textbook Datalog terminates because its rules can
    only ever derive tuples over values that already appear in the
    input — the so-called *active domain* is finite, so the
    fixed-point iteration must stop. Datamog adds arithmetic and
    string operations (`+`, `sqrt`, slice, …) that can manufacture
    values outside the active domain, so a pathological recursive
    rule like `s("").  s(Y) :- s(X), Y = X + "a".` will loop forever.
    We'll flag these situations as they come up; for ordinary
    "textbook" Datalog programs the termination guarantee still
    holds.

This tutorial teaches Datalog using [Datamog][datamog], a small educational
implementation that compiles Datalog to SQL — so every example can be
understood from either side: as a logical specification or as a piece
of relational machinery.

[datamog]: ../../README.md

## Three tastes of what Datalog can do

Read these with an open mind — we will build them all up from scratch
later. For now, let them wash over you.

### 1. Ancestors (recursion)

```prolog
input predicate parent(name: string, child: string).

ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).

?- ancestor("alice", X).
```

Two rules. The first says "parents are ancestors". The second says "a
parent of an ancestor is also an ancestor". From those, Datalog
computes the full transitive closure — all of Alice's descendants, to
any depth. You don't write a loop. You don't write a join yourself.
You state the principle and the engine does the rest.

### 2. A logic puzzle (search)

```prolog
# A small family of logic puzzles: find X such that some
# combination of constraints holds.
suspect("alice").   suspect("bob").   suspect("carol").

alibi("alice").
drove_the_car("bob").
# ... more facts ...

guilty(S) :- suspect(S), not alibi(S), drove_the_car(S).

?- guilty(X).
```

Declarative search, straight out of the textbook. Give the engine
facts and constraints, and the set of solutions falls out of the
definition of `guilty`.

### 3. Program analysis (real world)

Static analyses like *reaching definitions* or *points-to* are
naturally expressed as fixed-point computations over relations —
exactly what Datalog is built for. Industrial frameworks like
Soufflé use Datalog because a single short program can replace
hundreds of lines of imperative analysis code, and because the
compiler can generate very efficient code from the declarative
specification.

We will walk through a real example in Chapter 12.

## The three lenses

Throughout the tutorial we will pause after each feature and look at
it through three viewpoints:

> **Logic lens.** What is this, formally? Datalog is a fragment of
> first-order logic; every program corresponds to a set of *Horn
> clauses*, and its answer is the *least model* of those clauses.
> When you see a `Logic lens` callout, we are connecting the syntax
> back to this underlying mathematics.

> **SQL lens.** What does the engine actually do? Datamog compiles
> Datalog to SQL, and in most chapters we will run the same program
> with `--dry-run` to see the generated SQL. When you see a `SQL
> lens` callout, we are explaining how the Datalog-side concept
> becomes a relational-database concept.

> **Imperative lens.** What would this look like in Python? A Datalog
> rule describes *what* a relation is; an imperative program describes
> *how* to compute it. The gap between those is where Datalog's
> leverage lives — a single rule typically replaces several specialised
> functions, because a relation has no preferred direction and no
> preferred iteration order. When you see an `Imperative lens`
> callout, we are contrasting the Datalog against the hand-written
> Python you'd otherwise reach for.

The three lenses agree on the answers — that's the whole point.
Datalog's special relationship with formal logic and relational
algebra is what makes it *interesting*; its distance from imperative
code is what makes it *useful*. Not every chapter calls out all three
lenses; we only add a callout where that angle actually illuminates
something new.

## Getting set up

Datamog is a Bun project. If you have not already:

```bash
git clone https://github.com/xiemaisi/datamog.git
cd datamog
bun install
```

The single command you will use most is:

```bash
bun run datamog <some-file>.dl
```

Two flags worth knowing now:

- **`--dry-run`** prints the generated SQL instead of executing the
  program. This is how we will look through the SQL lens.
- **`--backend <name>`** picks the engine. Datamog ships several:
  `sqlite` (via `bun:sqlite`; the CLI default), `sqljs` (WASM
  SQLite; the [playground][pg]'s default), `postgres`, and two
  non-SQL pure-Datalog evaluators: `native` and `seminaive`. Most of the
  tutorial works with any SQL backend; chapters that depend on a
  particular backend say so up front.

There is also an in-browser [playground][pg] that runs the full
pipeline client-side. It's convenient for quick experiments; you
don't need a local clone to use it.

## How the chapters work

Each chapter is self-contained and progresses from a motivating
problem to a worked Datalog solution, then steps back to look at
the new feature through both lenses, and finishes with exercises.

- **Exercises** live at the end of the chapter. They're rated:

  - ★ — direct application of what the chapter covered.
  - ★★ — combines several ideas, or needs a small insight.
  - ★★★ — substantive; don't be surprised if one of these takes
    half an hour.

  Each runnable exercise has a starter file in
  `doc/walkthrough/code/chNN/`; analytical exercises ("predict the
  output", "read the SQL") have only a reference solution under
  `doc/walkthrough/solutions/chNN/`. Try each one before peeking.

- **Runnable code.** Every chapter corresponds to a folder of `.dl`
  files you can run directly. The string tells you which file to
  open and often asks you to modify it.

- **No magic.** When a feature looks surprising, we will show why
  it works from the logic side and why it works from the SQL side.
  Nothing in Datalog is magic; it's just logic aimed at data.

## What this tutorial is not

- **Not a reference.** For the exact grammar, semantics, and typing
  rules, see [`doc/spec.md`](../spec.md).
- **Not a tour of every Datalog dialect.** We use Datamog's syntax
  and stick to features Datamog supports. Differences from other
  dialects are noted where they matter.
- **Not a performance guide.** Datamog is educational; it prioritises
  clarity over speed. Real-world Datalog engines (Soufflé in
  particular) go much further.

## Where to start

Turn to [Chapter 1](01-facts-and-queries.md) and we will write our
first Datalog program: a tiny database of facts and some queries
over it. No recursion yet — just enough to get a feel for the shape
of the language.

[pg]: https://xiemaisi.github.io/datamog/
