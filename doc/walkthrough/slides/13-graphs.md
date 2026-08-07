---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 13
## Case study — graph algorithms

Closures, shortest paths, bills of materials — three classic patterns

---

# Why graphs fit Datalog

Datalog outperforms expectations on:

- reachability
- transitive closure
- shortest paths
- bill-of-materials
- anything that looks like "**propagate along edges until stable**"

This chapter is a tour of three idiomatic examples — running code lives in `packages/cli/examples/`.

---

# Transitive closure — the one-liner

```prolog
reach(X, Y) :- edge(X, Y).
reach(X, Y) :- edge(X, Z), reach(Z, Y).
```

An enormous fraction of "find all X that can eventually affect Y" questions reduce to transitive closure on some graph:

- organisational hierarchies
- dependency graphs
- citation networks
- protein interaction networks

The two-rule program above is the **one-size-fits-all answer**.

---

# Shortest path

```prolog
road("castle", "village", 2).  road("castle", "forest", 5).  # ...

# Termination bound (sum of all edge weights).
max_cost(sum(W)) :- road(_, _, W).

# All paths, bounded.
path(X, Y, C) :- road(X, Y, C).
path(X, Y, C) :-
    path(X, Z, C0), road(Z, Y, C1),
    max_cost(Max), C0 < Max,
    C = C0 + C1.

# Shortest per (X, Y).
shortest(X, Y, min(C)) :- path(X, Y, C).
```

---

# Shortest path — three strata

1. `max_cost` — one aggregate over the input. Computes a termination bound.
2. `path` — recursive transitive closure with arithmetic, bounded by `max_cost` so it terminates.
3. `shortest` — `min` aggregate over `path`, one row per `(X, Y)`.

**Stratification makes this just work** — `max_cost` sits in a strictly lower stratum than `path`, so by the time `path` is computed, `max_cost` is frozen.

This is "Bellman-Ford at the conceptual level" — every iteration extends current paths by one edge.

---

# Bill-of-materials

"Part X contains part Y in some quantity. What's the full expanded parts list for an assembly?"

```prolog
all_subparts(Part, Sub) :- assembly(Part, Sub, _).
all_subparts(Part, Sub2) :-
    all_subparts(Part, Sub1), assembly(Sub1, Sub2, _).

basic_subparts(B, B) :- part_cost(B, _, _, _).
basic_subparts(Prt, B) :-
    assembly(Prt, Sub, _), basic_subparts(Sub, B).
```

Two transitive closures, one per "role" (all subparts; leaf subparts).

The rest of `bom.dl` layers arithmetic and aggregation on top — fastest suppliers per basic part, sum up delivery times along chains, longest-lead-time sub-chain. **Each extension is one or two rules.**

---

# A note on performance

Datalog graph implementations are usually less efficient than specialised imperative algorithms — by **constant factors**, not complexity classes.

You trade those constants for:

- **Composability** — every intermediate is a named, queryable relation. "Reachability modulo a blacklist, counted" is three rules.
- **Correctness** — rules *are* the spec. No gap between spec and implementation.
- **Portability** — same rules compile to Postgres, SQLite, or in-memory evaluator.

Production-grade engines (Soufflé) close much of the perf gap with indexing and code generation.

---

# Recap

- **Transitive closure** is a two-line program; an enormous number of real-world questions reduce to it.
- **Shortest path** combines `min`-aggregation with bounded recursion. The bound is itself computed as a prior stratum.
- **Bill-of-materials** layers multiple transitive closures and aggregates in clean strata. Each new question is one more rule.
- Datalog trades performance for **composability and clarity**. For graph-heavy production work you'd reach for Soufflé or a specialised graph DB; for everything else, the vanilla rules are usually enough.

---

# Done!

This closes the sliced chapters. If you've worked through here, you know enough Datalog to:

- tackle production analyses
- read the academic literature
- recognise constraint-shaped, fixed-point-shaped, and graph-shaped problems for what they are

The written chapters carry on: values, proof terms, modules, and recursion through negation, then the appendices.

Thanks for reading.
