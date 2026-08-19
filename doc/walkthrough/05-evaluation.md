# Chapter 5 — How Datalog runs: naive and seminaive evaluation

Chapter 4 said "Datalog applies the rules until nothing new shows
up". That's true, but it hides an engineering problem: a naive
implementation of that idea re-does an enormous amount of work on
every round. Real Datalog engines — including Datamog's pure
in-memory backends — use a cleverer scheme called **seminaive
evaluation**. This chapter opens the engine, shows the difference
by hand, and then uses Datamog's two non-SQL backends (`native` and
`seminaive`) to run both strategies on the same program.

Readers happy to treat the engine as a black box can skim this
chapter and skip to Chapter 6. But if you ever want to *debug*
a Datalog program — or trust that "it will terminate" — the
mental model in this chapter is what you need.

## A minimal chain

Our running example for this chapter is deliberately tiny. From
[`code/ch05/chain.dl`](code/ch05/chain.dl):

```prolog
parent("a", "b").
parent("b", "c").
parent("c", "d").

ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).

?- ancestor(X, Y).
```

Three facts arranged as a chain `a → b → c → d`. The right answer
has six rows — every pair `(a,b), (b,c), (c,d), (a,c), (b,d),
(a,d)`.

**[Open this program in the playground →](https://xiemaisi.github.io/datamog/#p=%23%20Tutorial%2C%20chapter%205%20%E2%80%94%20a%20small%20chain%20to%20trace%20by%20hand.%0A%23%0A%23%20%20%20a%20-%3E%20b%20-%3E%20c%20-%3E%20d%0A%23%0A%23%20Small%20enough%20to%20walk%20through%20the%20fixed-point%20iteration%20on%20paper%2C%0A%23%20big%20enough%20for%20naive%20and%20seminaive%20evaluation%20to%20differ%20on.%0A%0Aparent(%22a%22%2C%20%22b%22).%0Aparent(%22b%22%2C%20%22c%22).%0Aparent(%22c%22%2C%20%22d%22).%0A%0Aancestor(X%2C%20Y)%20%3A-%20parent(X%2C%20Y).%0Aancestor(X%2C%20Y)%20%3A-%20parent(X%2C%20Z)%2C%20ancestor(Z%2C%20Y).%0A%0A%3F-%20ancestor(X%2C%20Y).%0A)**

## Naive evaluation, by hand

Here is *exactly* what naive evaluation computes, round by round:

**Round 0.** `ancestor` is empty.

**Round 1.** We apply every rule whose body is satisfied by what we
know so far. The first rule fires for each `parent(X, Y)`:

| after round 1 |          |
| ------------- | -------- |
| `(a, b)`      | *(base)* |
| `(b, c)`      | *(base)* |
| `(c, d)`      | *(base)* |

The second rule's body needs a non-empty `ancestor`, so on round 1
it contributes nothing new.

**Round 2.** Both rules fire. The first re-derives the three base
rows (they're already there). The second fires for every `(X, Z)`
in `parent` paired with every `(Z, Y)` in the current `ancestor`:

| after round 2  |                          |
| -------------- | ------------------------ |
| `(a, b)`       | *(re-derived)*           |
| `(b, c)`       | *(re-derived)*           |
| `(c, d)`       | *(re-derived)*           |
| `(a, c)`       | *(new: via (a,b) + (b,c))* |
| `(b, d)`       | *(new: via (b,c) + (c,d))* |

**Round 3.** Same drill. Every base row gets re-derived. The
recursive rule now reaches further:

| after round 3 |                              |
| ------------- | ---------------------------- |
| `(a, b)`      | *(re-derived, again)*        |
| `(b, c)`      | *(re-derived, again)*        |
| `(c, d)`      | *(re-derived, again)*        |
| `(a, c)`      | *(re-derived)*               |
| `(b, d)`      | *(re-derived)*               |
| `(a, d)`      | *(new: via (a,b) + (b,d))*   |

**Round 4.** We run the rules one more time to check for changes.
Nothing new appears. The fixed point is reached; we stop.

Notice how much work rounds 3 and 4 are doing to re-derive the same
old rows. On a chain of length *n* this procedure does roughly
*n²* work per round and needs *n* rounds, for an *n³* total — most
of it wasted on re-deriving.

## Seminaive: only use new tuples

The fix is the observation that, after round 1, any *genuinely new*
row must have been derived using at least one row that appeared in
the previous round. Every other derivation path has already been
explored.

Seminaive evaluation exploits that by maintaining a **delta**
(`Δancestor`) of "rows added in the previous iteration". The
recursive rule is rewritten to fire with one body atom bound to the
delta and the others bound to the full accumulated relation. On our
chain:

**Priming (iteration 0).** Run every rule naively against whatever
is already accumulated (which is nothing). The base rule fires:

- `Δancestor = {(a,b), (b,c), (c,d)}`, `ancestor = Δancestor`.

**Iteration 1.** Fire each recursive rule once per recursive body
atom, with that atom reading from the previous delta. Here the
recursive rule is linear, so there's only one such variant. We
need derivations `parent(X, Z), Δancestor(Z, Y)`:

- `parent(a, b)` joins with `Δancestor(b, c)` → `(a, c)`.
- `parent(b, c)` joins with `Δancestor(c, d)` → `(b, d)`.
- New `Δancestor = {(a, c), (b, d)}`, `ancestor` grows to 5 rows.

**Iteration 2.** Same variant:

- `parent(a, b)` joins with `Δancestor(b, d)` → `(a, d)`.
- New `Δancestor = {(a, d)}`, `ancestor` grows to 6 rows.

**Iteration 3.** `parent(X, Z), Δancestor(Z, Y)` — but `Δ` only
contains `(a, d)`, and no `parent(_, a)` exists. `Δancestor = ∅`,
we stop.

Three real iterations, each doing only as much work as there were
*new* rows in the previous one. Same answer, far less work.

That's the entirety of the seminaive trick. The bookkeeping gets
hairier when a rule has multiple recursive body atoms (you fire
the rule once per "where is Δ" position, with the other recursive
atoms reading from the accumulated relation) — but since Datamog
rejects non-linear recursion, we don't have to worry about that.

## Try it yourself

Datamog ships two in-memory, non-SQL evaluators. Both implement the
same `Backend` interface used by the SQL backends; they just skip
the translate-to-SQL step.

```bash
bun run datamog --backend native    doc/walkthrough/code/ch05/chain.dl
bun run datamog --backend seminaive doc/walkthrough/code/ch05/chain.dl
```

Both print the same six rows. On this size of problem you won't
notice any performance difference. On a larger graph, seminaive
will be visibly faster.

The [playground][pg] exposes a "step" control that lets you advance
the seminaive iteration one round at a time and inspect the delta
— useful if you want to *see* the rounds rather than trace them on
paper.

## Stratification

One more piece of machinery. When a program has several predicates,
some referring to each other, the engine needs to know in what
*order* to compute them.

- If `B` is defined using `A`, then `A` must be computed first —
  otherwise `B`'s rules look at an empty `A` and derive too few
  facts.
- If `A` and `B` refer to each other (mutual recursion), they
  form a **strongly connected component** in the dependency graph
  and must be computed together, as a single iterative block.
- Negation and aggregation, which we'll meet in Chapters 8 and 9,
  introduce an extra constraint: a rule using `not p(...)` must
  come in a *strictly later* stratum than `p` itself, so that `p`
  is fully settled before we ask "what's missing from it".

The engine topologically sorts the components (Tarjan's SCC
algorithm) and evaluates them one after another — the iteration
inside each component handles recursion; the order between
components ensures dependencies are respected. The same
stratification that drives the SQL view-creation order also drives
the native/seminaive evaluation order.

For this chapter, every predicate sits in a single stratum (a
single recursive component, in fact), so stratification doesn't
do much. Chapter 8 is where it matters.

> **Logic lens.** Seminaive evaluation is a *performance*
> refinement; it computes the exact same least fixed point as
> naive evaluation. Formally, one shows that the delta-based
> iteration converges to the same `lfp(Tₚ)` as the full iteration
> — every derivable fact is eventually derived, because every
> derivation path uses at least one "new" fact at some round. The
> minimality (no *extra* facts beyond what's strictly forced by
> the rules) is preserved, because both strategies only ever
> *add* tuples.
>
> Mathematically this matters for Chapter 8: when we introduce
> negation, seminaive's delta trick doesn't extend directly,
> because "not in `p`" isn't monotone. That's what stratification
> is for — it lets us compute `p` to completion before any rule
> that depends on `not p` ever fires.

> **SQL lens.** The SQL dialects' `WITH RECURSIVE` is close to
> naive evaluation in spirit — every iteration runs the step query
> against the full accumulated result so far. Modern engines
> internally optimise this toward seminaive-style delta joins, but
> the surface semantics are naive. That's why non-linear recursion
> (two recursive references) breaks on SQL: the "working table"
> convention pins both references to the same snapshot, and
> derivations that should combine "old" and "new" are silently
> dropped. The seminaive formulation — one recursive reference
> bound to Δ, others bound to the accumulated relation — is
> precisely the fix, and it's why Datamog's pure-Datalog
> `seminaive` backend *can* compute non-linear recursion correctly
> even though every SQL backend can't.

> **Imperative lens.** Seminaive evaluation is a worklist
> algorithm in disguise: "Δ" is the worklist, and each iteration
> drains Δ and computes the next one. The direct Python analogue
> for our ancestor program would be something like:
>
> ```python
> ancestor = set()
> delta = {(p, c) for (p, c) in parent}      # priming
> while delta:
>     ancestor |= delta
>     delta = {(x, y)
>              for (x, z) in parent
>              for (z2, y) in delta
>              if z == z2} - ancestor
> ```
>
> Compare this to the explicit worklist loop from Chapter 4's
> imperative lens. Seminaive Datalog *is* worklist-style
> evaluation; you just don't write the worklist code yourself.

## Recap

- **Naive evaluation** applies every rule in every round until
  nothing changes. Correct but wasteful: it re-derives known rows
  on every pass.
- **Seminaive evaluation** threads a delta of "newly derived" rows
  through the iteration; each recursive rule fires once per
  position, with exactly one body atom reading from the delta.
  Same answer, orders of magnitude less work.
- **Stratification** handles inter-predicate dependencies, letting
  the engine compute each strongly connected component to its
  fixed point before moving on to the next.
- Through all three lenses, these are *execution strategies* for
  the same declarative specification — no one strategy changes
  what the program *means*.

## Exercises

### Exercise 5.1 — Hand-trace on a tree ★

Take this slightly richer input:

```prolog
parent("a", "b").
parent("a", "c").
parent("b", "d").
parent("c", "d").
```

(Note: `d` has two parents — a diamond, not a tree.) Trace naive
evaluation by hand until the fixed point is reached. How many
rounds? How many *distinct* `ancestor` rows end up in the result?
Then trace seminaive. At which iteration is `(a, d)` derived?
Write your traces out; compare against
[`solutions/ch05/ex1.md`](solutions/ch05/ex1.md).

### Exercise 5.2 — Same program, different backend ★

Starter: [`code/ch05/ex2-backends.dl`](code/ch05/ex2-backends.dl)

Run the chain program under each backend and confirm the answers
match:

```bash
for b in sqlite sqljs native seminaive; do
    echo "=== $b ==="
    bun run datamog --backend "$b" doc/walkthrough/code/ch05/ex2-backends.dl
done
```

What varies between backends — answers, output order, timing?
(The Datalog *semantics* is fixed; only representation choices
differ.)

### Exercise 5.3 — The cost of chain length ★★

Starter: [`code/ch05/ex3-long-chain.dl`](code/ch05/ex3-long-chain.dl)

Extend the starter's chain to length 10, 20, 50, and 100. For each
length, run the program under `--backend native` and
`--backend seminaive` with `time`. How does the runtime grow? Why
does naive scale worse? (Use `time bun run datamog ...` or any
profiler you prefer.)

### Exercise 5.4 — Why can't seminaive handle negation directly? ★★★

Consider a predicate defined as `orphan(X) :- person(X), not
has_parent(X).` Seminaive iteration tracks a Δ of "newly derived
positive facts". Suppose at iteration `k`, we derive a *new*
`has_parent(x)` row. How should `orphan` react?

Write a short paragraph explaining why the monotone "add tuples
to Δ" trick breaks when rules can reference the *absence* of a
fact — and why stratification is the standard fix (Chapter 8
will develop this in full). Check your thinking against
[`solutions/ch05/ex4.md`](solutions/ch05/ex4.md).

---

Next: **[Chapter 6 — Arithmetic, ranges, and strings](06-arithmetic.md)**.
Time to do something besides pattern-match facts. We'll introduce numeric
expressions, range atoms that generate values on the fly, and the
string-manipulation operators that make Datamog practical for real data —
plus the cross-backend invariants that keep `a / 0` consistently *without a value*
everywhere.

[pg]: https://xiemaisi.github.io/datamog/
