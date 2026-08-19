---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 0
## Why Datalog?

A Datalog tutorial with Datamog

---

> *"Whatever can be stated logically as a fact about data can in
> principle be queried logically."*

---

# What is Datalog?

A small declarative language for **querying** and **deriving relations** from facts.

Sits between SQL and Prolog:

- **From SQL** — everything is a relation (rows over typed columns).
- **From Prolog** — rules state the principle once; the engine works
  out the consequences.

---

# The trade-off

Datalog gives up some of Prolog's power...

- no function symbols
- no cuts
- no arbitrary terms

...in exchange for two very nice properties:

- **Every program terminates.**
- **Rule order doesn't matter.**

<!-- Datamog adds arithmetic, so a pathological recursive rule can
manufacture fresh values and loop forever — flagged as we go. -->

---

# Three tastes of what Datalog can do

We will build all of these from scratch later. For now, let them wash over you.

1. **Recursion** — ancestors
2. **Search** — a logic puzzle
3. **Real-world** — program analysis

---

# 1. Ancestors (recursion)

```prolog
input predicate parent(name: string, child: string).

ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).

?- ancestor("alice", X).
```

Two rules. Datalog computes the **full transitive closure** — all of
Alice's descendants, to any depth.

No loops. No hand-written joins. State the principle; the engine does the rest.

---

# 2. A logic puzzle (search)

```prolog
suspect("alice").  suspect("bob").  suspect("carol").

alibi("alice").
drove_the_car("bob").
# ... more facts ...

guilty(S) :- suspect(S), not alibi(S), drove_the_car(S).

?- guilty(X).
```

Declarative search. The set of solutions falls out of the
**definition** of `guilty`.

---

# 3. Program analysis (real world)

Static analyses — *reaching definitions*, *points-to* — are
**fixed-point computations over relations**. Exactly Datalog's sweet spot.

Industrial frameworks (Soufflé, ...) use Datalog because:

- one short program replaces hundreds of lines of imperative analysis code
- the compiler can generate very efficient code from the spec

A real example follows in **Chapter 12**.

---

# The three lenses

After each new feature we pause and look at it from three viewpoints:

| Lens | Question | Connects to |
| --- | --- | --- |
| **Logic** | What is this, formally? | Horn clauses, least models |
| **SQL** | What does the engine actually do? | `--dry-run` SQL output |
| **Imperative** | What would this be in Python? | The hand-written code you'd otherwise reach for |

The three lenses **agree** on the answers — that's the whole point.

---

# Logic lens

> Datalog is a fragment of first-order logic. Every program is a set
> of **Horn clauses**, and its answer is the **least model** of those
> clauses.

`Logic lens` callouts connect the syntax back to this underlying mathematics.

---

# SQL lens

> Datamog compiles Datalog to SQL. Most chapters run the same program
> with `--dry-run` to show the generated SQL.

```bash
bun run datamog --dry-run program.dl
```

`SQL lens` callouts explain how the Datalog concept becomes a relational one.

---

# Imperative lens

> A Datalog rule says **what** a relation is; an imperative program
> says **how** to compute it.

The gap is where Datalog's leverage lives:

- a relation has no preferred direction
- a relation has no preferred iteration order
- one rule typically replaces several specialised functions

---

# Getting set up

```bash
git clone https://github.com/xiemaisi/datamog.git
cd datamog
bun install
```

The single command you'll use most:

```bash
bun run datamog <some-file>.dl
```

Two flags worth knowing now:

- `--dry-run` — print the generated SQL
- `--backend <name>` — `sqlite`, `sqljs`, `postgres`,
  `native`, `seminaive`

---

# How the chapters work

Each chapter follows the same shape:

1. **Motivating problem** — stated in prose.
2. **A Datalog solution** — built up incrementally.
3. **Lens callouts** — added where they illuminate something new.
4. **Exercises** — rated ★ / ★★ / ★★★.
5. **Recap** — three bullets tying it together.

Starter files: `doc/walkthrough/code/chNN/`
Solutions: `doc/walkthrough/solutions/chNN/`

---

# What this tutorial is *not*

- **Not a reference** — for grammar, semantics, and typing rules see
  `doc/spec.md`.
- **Not a tour of every Datalog dialect** — we use Datamog and flag
  divergences.
- **Not a performance guide** — Datamog is educational; real-world
  engines (Soufflé) go much further.

---

# Where to start

Turn to **Chapter 1** and we'll write our first Datalog program: a
tiny database of facts and some queries over it.

No recursion yet — just enough to get a feel for the shape of the language.

[Chapter 1. Facts, queries, and predicates →](01-facts-and-queries.md)
