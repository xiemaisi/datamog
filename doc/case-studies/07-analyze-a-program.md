# Analyze a program

> Adapted from the
> [Soufflé tutorial](https://souffle-lang.github.io/tutorial)
> and from Smaragdakis & Bravenboer,
> ["Using Datalog for Fast and Easy Program Analysis"](https://yanniss.github.io/doop-datalog2.0.pdf),
> Springer, 2011.

Queen Diana's kingdom is prospering, and her scribes have begun writing
programs to manage the treasury. But bugs keep creeping in. She commissions you
to build tools that analyze programs **before** they run, catching errors early.

This tutorial shows how Datalog can be used for **static program analysis** — a
domain where it has been remarkably successful in practice. Frameworks like
[Doop](https://bitbucket.org/yanniss/doop/) and
[Soufflé](https://souffle-lang.github.io/) use Datalog to analyze millions of
lines of code.

## Part 1: Reaching definitions

### The problem

A **reaching definition** analysis answers: "which variable assignments could
still be in effect when execution reaches this point?" This is one of the most
fundamental analyses in compiler design — it drives optimizations like dead code
elimination and constant propagation.

Consider this small program with four basic blocks forming a loop:

```
start → b1 → b2 → b4 → b1 (loop back)
             b3 ↗     ↘ end
```

- Block **b2** assigns variable `x` (definition `d1`)
- Block **b4** assigns variable `x` (definition `d2`)
- Block **b4** **kills** definition `d1` (overwrites `x`)
- Block **b2** **kills** definition `d2` (overwrites `x`)

### Modeling the control-flow graph

We represent the program's control flow as a directed graph:

```prolog
cfg("start", "b1").
cfg("b1", "b2").
cfg("b1", "b3").
cfg("b2", "b4").
cfg("b3", "b4").
cfg("b4", "b1").
cfg("b4", "end").
```

Each block can **generate** a new definition or **kill** an existing one:

```prolog
gen("b2", "d1").
gen("b4", "d2").

kill("b4", "d1").
kill("b2", "d2").
```

### Writing the analysis

A definition reaches a block in two ways:

1. The block **generates** it (base case)
2. It reaches a **predecessor** block and is **not killed** there (recursive case)

```prolog
reaches(D, U) :- gen(U, D).
reaches(D, V) :- cfg(U, V), reaches(D, U), not kill(U, D).
```

That's it — two rules. The recursion follows control-flow edges, and negation
handles the kill sets. Datamog computes the fixed point automatically.

### Exercise 1

Write the full program and predict which definitions reach each block before
running it.

<details>
<summary>Hint</summary>

Trace the definitions manually:
- `d1` is generated at `b2`. Does it survive to `b4`? (Check: does `b2` kill `d1`?)
- `d2` is generated at `b4`. Does it survive to `b1`? (Check: does `b4` kill `d2`?)

</details>

<details>
<summary>Solution</summary>

```prolog
cfg("start", "b1").
cfg("b1", "b2").
cfg("b1", "b3").
cfg("b2", "b4").
cfg("b3", "b4").
cfg("b4", "b1").
cfg("b4", "end").

gen("b2", "d1").
gen("b4", "d2").

kill("b4", "d1").
kill("b2", "d2").

reaches(D, U) :- gen(U, D).
reaches(D, V) :- cfg(U, V), reaches(D, U), not kill(U, D).

?- reaches(Def, Block).
```

Results:

| Def | Block |
|-----|-------|
| d1 | b2 |
| d1 | b4 |
| d2 | b4 |
| d2 | b1 |
| d2 | b2 |
| d2 | b3 |
| d2 | end |

Key observations:
- `d1` reaches `b4` (via b2 → b4, and b2 does not kill d1), but `d1` does
  **not** reach `b1` because b4 kills it.
- `d2` propagates around the loop: b4 → b1 → b2, b1 → b3, and b4 → end.
  It survives everywhere except at `b2`, where it arrives but gets killed
  (overwritten). But wait — `d2` still **reaches** `b2`! It arrives from `b1`,
  and `b1` does not kill `d2`. The kill at `b2` only prevents `d2` from
  propagating **out** of `b2`.

</details>

### Exercise 2

Add a new block `b5` between `b4` and `end` that generates a definition `d3`
for a different variable (one that is never killed). Predict which blocks `d3`
reaches.

<details>
<summary>Solution</summary>

Add:
```prolog
cfg("b4", "b5").
cfg("b5", "end").
gen("b5", "d3").
```

And remove `cfg("b4", "end")`. Definition `d3` reaches `b5` and `end`. Since
nothing kills it and there is no edge back into the loop, it does not reach any
other block.

</details>

## Part 2: Points-to analysis

### The problem

A **points-to analysis** determines which memory locations each pointer variable
may refer to. This is essential for understanding aliasing — when two variables
refer to the same memory.

### Modeling pointer operations

We model two basic operations:

- `address_of(V, L)` — variable `V` is assigned the address of location `L`
  (i.e., `V = &L`)
- `assign(V, W)` — variable `V` is copied from variable `W` (i.e., `V = W`)

Here is a small example program:

```
p = &x;  q = &y;  r = &z;
a = p;   b = a;   c = q;   a = r;
```

In Datamog:

```prolog
address_of("p", "x").
address_of("q", "y").
address_of("r", "z").
assign("a", "p").
assign("b", "a").
assign("c", "q").
assign("a", "r").
```

### Writing the analysis

The analysis has just two rules:

```prolog
points_to(V, L) :- address_of(V, L).
points_to(V, L) :- assign(V, W), points_to(W, L).
```

The first rule handles direct address assignments. The second propagates
points-to information through variable copies — if `V = W` and `W` may point
to `L`, then `V` may also point to `L`.

Notice this is a **may-analysis**: a variable can point to multiple locations.
Variable `a` is assigned both `p` (which points to `x`) and `r` (which points
to `z`), so `a` may point to either `x` or `z`.

### Exercise 3

Write the full program and query the points-to relation. Which variables may
alias (i.e., point to the same location)?

<details>
<summary>Hint</summary>

Two variables **may alias** if they may both point to the same location:

```prolog
may_alias(X, Y) :- points_to(X, L), points_to(Y, L), X <> Y.
```

</details>

<details>
<summary>Solution</summary>

```prolog
address_of("p", "x").
address_of("q", "y").
address_of("r", "z").
assign("a", "p").
assign("b", "a").
assign("c", "q").
assign("a", "r").

points_to(V, L) :- address_of(V, L).
points_to(V, L) :- assign(V, W), points_to(W, L).

output predicate may_alias(X, Y) :- points_to(X, L), points_to(Y, L), X <> Y.

?- points_to(Var, Location).
```

Points-to results:

| Var | Location |
|-----|----------|
| p | x |
| q | y |
| r | z |
| a | x |
| a | z |
| b | x |
| b | z |
| c | y |

Variable `a` may point to both `x` and `z` because it is assigned both `p`
and `r`. Variable `b` inherits both targets from `a` through the copy `b = a`.

Alias results include: `(p, a)`, `(p, b)`, `(r, a)`, `(r, b)`, `(a, b)`,
`(q, c)` (and their symmetric pairs).

</details>

### Exercise 4

Add an assignment `d = b` and a new address `address_of("d", "w")`. What does
`d` point to? Who are its aliases?

<details>
<summary>Solution</summary>

Add:
```prolog
assign("d", "b").
address_of("d", "w").
```

Now `d` may point to `x` (from b→x), `z` (from b→z), and `w` (from
address_of). Variable `d` aliases with `p` and `b` (via `x`), `r` and `a`
(via `z`), and any future variable that gets `&w`.

</details>

## The pattern: programs as data

Both analyses in this tutorial follow the same pattern:

1. **Encode the program as facts** — control-flow edges, definitions, pointer
   operations become extensional data
2. **Express the analysis as recursive rules** — the analysis logic is just a
   few Datalog rules
3. **Let the engine compute the fixed point** — Datamog (or any Datalog engine)
   handles iteration automatically

This is why Datalog has been so successful for program analysis: analyses that
would require hundreds of lines of imperative code reduce to a handful of
declarative rules. The Doop framework for Java pointer analysis, written
entirely in Datalog, runs faster than hand-coded Java implementations while
being far more concise.

The complete program is [`packages/cli/examples/reaching-defs/`](../../packages/cli/examples/reaching-defs/).

## What's next?

The final chapter puts the whole language to work: [Prove a
theorem](08-prove-a-theorem.md) builds a propositional theorem prover —
parser and all — in Datamog itself. Here is a summary of what you have learned:

| Tutorial | Concepts |
|----------|----------|
| [Introduction](01-introduction.md) | Facts, rules, queries |
| [Find the thief](02-find-the-thief.md) | Comparisons, negation, aggregates |
| [Catch the fire starter](03-catch-the-fire-starter.md) | Derived predicates, rule composition |
| [Crown the rightful heir](04-crown-the-rightful-heir.md) | Recursion, transitive closure |
| [Cross the river](05-cross-the-river.md) | State-space search |
| [Find the shortest path](06-find-the-shortest-path.md) | Recursion + aggregation for optimization |
| **Analyze a program** | Static analysis, data-flow, pointer analysis |
| [Prove a theorem](08-prove-a-theorem.md) | CNF, value invention, parsing, non-linear recursion, sequent calculus |

Use `--dry-run` on any of the examples to see the SQL that Datamog generates —
it is a great way to deepen your understanding of how logic programs map to
relational queries.
