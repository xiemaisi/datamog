# Find the shortest path

> Adapted from the shortest-path examples in the
> [Datalog Educational System (DES)](http://des.sourceforge.net/)
> by Fernando Saenz-Perez.

Queen Diana has been crowned and peace has returned to the kingdom. Her first
act is to improve the road network connecting the kingdom's towns. She
commissions you to find the shortest route between every pair of towns.

This tutorial teaches you how to combine **recursion** and **aggregates** to
solve graph optimization problems — a pattern that comes up whenever you need
to find a best path, cheapest route, or minimum cost.

## The road network

The kingdom has five locations connected by one-way roads, each with a travel
cost (in hours):

```
          2            4
  castle ───> village ───> bridge
    │  ↑  3      ↑          ↑
    │  └─────────┘          │
    │ 5          1          │ 2
    ↓            │          │
  forest ───> river ────────┘
          3
```

```prolog
road("castle", "village", 2).
road("castle", "forest", 5).
road("village", "bridge", 4).
road("village", "castle", 3).
road("forest", "river", 3).
road("river", "village", 1).
road("river", "bridge", 2).
```

Notice the **cycle**: castle → village → castle. This is important — it means
naive path enumeration would loop forever.

## Step 1: Enumerate all paths

A path between two towns is either a direct road, or a road followed by a
path:

```prolog
path(X, Y, C) :- road(X, Y, C).
path(X, Y, C) :- path(X, Z, C0), road(Z, Y, C1), C = C0 + C1.
```

But this program will not terminate! The cycle castle → village → castle
generates paths of ever-increasing cost: 5, 10, 15, 20, ...

## Step 2: Add a termination bound

We need to stop exploring paths once they are too long to be useful. A safe
upper bound: the sum of all edge weights. Any shortest path visits each edge at
most once, so it cannot exceed this total.

```prolog
max_cost(sum(W)) :- road(_, _, W).
```

For our network, `max_cost` is 2+5+4+3+3+1+2 = 20.

Now add the bound to the recursive rule:

```prolog
path(X, Y, C) :- road(X, Y, C).
path(X, Y, C) :-
  path(X, Z, C0), road(Z, Y, C1),
  max_cost(Max), C0 < Max,
  C = C0 + C1.
```

The condition `C0 < Max` ensures we never extend a path whose cost already
exceeds the total weight of the network. Since each road has a positive cost,
path costs strictly increase, and the recursion terminates.

### Exercise

Why do we check `C0 < Max` rather than `C < Max`?

<details>
<summary>Answer</summary>

We check `C0` (the cost so far) rather than `C` (the final cost) because `C`
has not been computed yet at the point where we need to decide whether to
continue. The bound on `C0` ensures we do not extend paths that are already
too long. The final cost `C = C0 + C1` may exceed `Max`, but that is fine —
those paths will simply lose to shorter ones in the next step.

</details>

## Step 3: Extract shortest paths

The `path` predicate now contains all bounded paths, including many suboptimal
ones. Use the `min` aggregate to keep only the shortest:

```prolog
shortest(X, Y, min(C)) :- path(X, Y, C).
```

This groups by `(X, Y)` — the source and destination — and keeps the minimum
cost.

### Exercise

Write the full program and query for all shortest paths.

<details>
<summary>Solution</summary>

```prolog
road("castle", "village", 2).
road("castle", "forest", 5).
road("village", "bridge", 4).
road("village", "castle", 3).
road("forest", "river", 3).
road("river", "village", 1).
road("river", "bridge", 2).

max_cost(sum(W)) :- road(_, _, W).

path(X, Y, C) :- road(X, Y, C).
path(X, Y, C) :-
  path(X, Z, C0), road(Z, Y, C1),
  max_cost(Max), C0 < Max,
  C = C0 + C1.

shortest(X, Y, min(C)) :- path(X, Y, C).

?- shortest(X, Y, C).
```

Selected results:

| X | Y | C |
|---|---|---|
| castle | village | 2 |
| castle | bridge | 6 |
| castle | forest | 5 |
| castle | river | 8 |
| forest | bridge | 5 |
| river | village | 1 |
| river | bridge | 2 |

The shortest route from castle to bridge is 6 hours (castle → village →
bridge), beating the scenic route through the forest (5 + 3 + 2 = 10).

</details>

## The pattern: recursion + aggregation

This tutorial demonstrates a fundamental pattern for optimization in Datalog:

1. **Enumerate** all candidates with recursion (bounded to ensure termination)
2. **Select** the best with an aggregate (`min`, `max`, etc.)

The same pattern applies to many problems:
- Shortest path → `min` over path costs
- Cheapest product assembly → `min` over component costs
- Longest chain → `max` over chain lengths
- Most popular route → `count` over path usage

## Exercises

### Exercise 1: Unreachable pairs

Some pairs of towns have no connecting path (e.g., bridge to castle — there is
no road out of bridge). Write a rule `unreachable(X, Y)` that finds all pairs
where X and Y are towns but no path exists from X to Y.

<details>
<summary>Hint</summary>

First define `town(X)` to collect all towns that appear in any road. Then
use negation: a pair is unreachable if both are towns but there is no path
between them.

</details>

<details>
<summary>Solution</summary>

```prolog
town(X) :- road(X, _, _).
town(X) :- road(_, X, _).

unreachable(X, Y) :- town(X), town(Y), X <> Y, not shortest(X, Y, _).

?- unreachable(X, Y).
```

Result: bridge is unreachable from itself and has no outgoing roads, so
every pair `(bridge, Y)` with `Y <> bridge` appears.

</details>

### Exercise 2: Shortest round trips

A round trip starts and ends at the same town. Find the shortest round trip
from each town.

<details>
<summary>Hint</summary>

Look at the `shortest` results where `X = Y`.

</details>

<details>
<summary>Solution</summary>

```prolog
round_trip(X, min(C)) :- path(X, X, C).

?- round_trip(X, C).
```

Result: castle has a round trip of cost 5 (castle → village → castle).

</details>

### Exercise 3: Add bidirectional roads

The villagers petition Queen Diana to make all roads bidirectional. Add reverse
edges and find the new shortest paths. How does the result change?

<details>
<summary>Hint</summary>

Define a `biroad` predicate that includes both directions:

```prolog
biroad(X, Y, C) :- road(X, Y, C).
biroad(Y, X, C) :- road(X, Y, C).
```

Then rewrite `path` to use `biroad` instead of `road`.

</details>

## What's next?

So far, every tutorial has used Datalog to query **data** — facts about people,
roads, or puzzle states. In the [next tutorial](07-analyze-a-program.md), you
will use Datalog to analyze **programs** — a domain where it has been
remarkably successful in practice.
