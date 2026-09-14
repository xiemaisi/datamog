# Chapter 13 — Case study: graph algorithms

The other corner of the problem space where Datalog outperforms
expectations is **graph algorithms**: reachability, transitive
closure, shortest paths, bill-of-materials — anything that looks
like "propagate along edges until stable". This chapter is a short
tour through three classic examples. The running code lives
under [`packages/cli/examples/`](../../packages/cli/examples/)
rather than in the tutorial tree; the point here is to connect
what you've learned to real idiomatic programs.

## Transitive closure: the one-liner

We've seen this one many times:

```prolog
reach(X, Y) :- edge(X, Y).
reach(X, Y) :- edge(X, Z), reach(Z, Y).
```

It turns out an enormous fraction of "find all X that can eventually
affect Y" queries across domains reduce to transitive closure on
some extensional graph. Organizational hierarchies, dependency
graphs, citation networks, protein interaction networks — all of
them. The two-rule Datalog program above is the one-size-fits-all
answer.

## Shortest path

[`packages/cli/examples/shortest-path/shortest-path.dl`](../../packages/cli/examples/shortest-path/shortest-path.dl)
computes shortest paths in a weighted graph using the three-stratum
pattern from Chapter 10:

```prolog
road("castle",  "village", 2).
road("castle",  "forest",  5).
# ...

# Upper bound to ensure termination (see chapter 6 on arithmetic
# in recursion).
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

Three predicates, each in its own stratum:

1. `max_cost` — one aggregate over the input, producing a
   termination bound.
2. `path` — recursive transitive closure with arithmetic, bounded
   by `max_cost` so it terminates.
3. `shortest` — aggregate `min` over `path`, producing one row per
   `(X, Y)` pair.

Notice the use of `max_cost` *inside* the recursive rule for
`path`. That's fine: `max_cost` is in a strictly lower stratum (it
depends only on EDB), so by the time `path` is computed,
`max_cost` is frozen. Stratification makes this just work.

This is "Bellman-Ford at the conceptual level" — every iteration
extends current paths by one edge, up to the bound, and `min`
picks the shortest. The implementation is much less efficient than
a dedicated shortest-path algorithm, but the code is shorter by
far.

## Bill-of-materials

Given "part X contains part Y in some quantity", find the full
expanded parts list for a top-level assembly.
[`packages/cli/examples/bill-of-materials/bom.dl`](../../packages/cli/examples/bill-of-materials/bom.dl)
does this and more:

```prolog
all_subparts(Part, Sub) :- assembly(Part, Sub, _).
all_subparts(Part, Sub2) :-
    all_subparts(Part, Sub1), assembly(Sub1, Sub2, _).

basic_subparts(B, B) :- part_cost(B, _, _, _).
basic_subparts(Prt, B) :-
    assembly(Prt, Sub, _), basic_subparts(Sub, B).
```

Two transitive closures, one over each of the two "roles" (all
subparts, leaf subparts). The rest of `bom.dl` layers arithmetic
and aggregation on top: find fastest suppliers per basic part, sum
up delivery times along a manufacturing chain, identify the
longest-lead-time sub-chain. Each extension is one or two more
rules.

## A note on performance

Datalog's graph-algorithm implementations are almost always less
efficient than a specialised imperative algorithm — by constant
factors (sometimes large ones), not by complexity class. What you
gain is:

- **Composability.** Every intermediate relation is named and
  queryable. Chaining "reachability modulo a blacklist and
  counted" is three rules, not a whole new algorithm.
- **Correctness.** The rules are the specification; no gap
  between spec and implementation.
- **Portability across backends.** Same rules, compile to
  Postgres, SQLite, or the in-memory evaluator. Want to use your
  organisation's existing Postgres? Switch the backend.

For graph-heavy programs where performance matters, production
Datalog engines like Soufflé add indexing, seminaive evaluation,
and code generation that close much of the performance gap —
though specialised graph databases still win on pure graph
workloads.

## Recap

- Transitive closure is a two-line Datalog program; an enormous
  number of real-world "what can reach what" questions reduce to
  it.
- Shortest paths combine `min`-aggregation with bounded recursion
  — the bound is itself computed as a prior stratum.
- The bill-of-materials pattern layers multiple transitive
  closures and aggregates in clean strata; each new question is
  one more rule.
- Datalog trades some performance for composability and clarity.
  For graph-heavy production work you'd reach for Soufflé or a
  specialised graph database; for everything else the vanilla
  rules are usually enough.

## Exercises

### Exercise 13.1 — Count reachable nodes ★

Given the graph from `reach.dl`, define `reach_count(X, count(Y))`
— how many distinct nodes are reachable from each source. Use the
recurse-then-aggregate pattern.

### Exercise 13.2 — Unreachable pairs ★★

Given `node(X)` (all nodes) and `reach(X, Y)` (transitive closure),
define `unreachable(X, Y)` — every pair `(X, Y)` for which `Y` is
*not* reachable from `X`. Start from the full cross product and
filter.

### Exercise 13.3 — Path reconstruction ★★★

Extend the shortest-path example to also return *one* representative
path (as a string of node names joined by `->`) for each shortest
distance. You'll need `concat` or careful recursion. Note: the
path is non-unique in general; just produce *a* shortest path, not
the unique one.

---

Next: **[Chapter 14 — Working with values](14-json.md)**, which
adds the `value` column type and a toolkit for reading, constructing, and checking
ingesting heterogeneous nested data — useful when the records you
receive arrive as deeply-nested blobs and you don't want to flatten
them in some other language first.

After that, [Part V](README.md) covers proof terms, modules, and
parity-stratified recursion, and the appendices close the tutorial
out. If you've worked through everything to here, you know enough
Datalog to tackle production analyses and to understand the academic
literature on the language.
