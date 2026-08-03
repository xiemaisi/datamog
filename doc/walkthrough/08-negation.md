# Chapter 8 — Negation and stratification

Everything we've written so far has been **monotone**: adding more
facts to the input can only add more rows to the output, never
remove them. That property is what makes Datalog's fixed-point
semantics clean, and what makes seminaive evaluation correct.

Sometimes, though, you really do want to say "not this". Negation
breaks monotonicity, and the engine has to treat it specially.
This chapter introduces **stratified negation**, which is
Datamog's — and most mainstream Datalog dialects' — answer: you
can use negation, but only on predicates that can be computed
before the rule using them fires.

## Orphans

From [`code/ch08/orphans.dl`](code/ch08/orphans.dl):

```prolog
input predicate parent(parent_name: string, child_name: string).

person(P) :- parent(P, _).
person(P) :- parent(_, P).

has_parent(X) :- parent(_, X).

orphan(X) :- person(X), not has_parent(X).
```

Three IDB predicates, plus one that uses negation. The rule for
`orphan` reads: "`X` is an orphan if `X` is a person **and** `X`
does not have a parent". Run it and you get the four top-generation
names: `alice`, `bob`, `cecil`, `diana`. They're the only rows of
`person` for which `has_parent` contains no matching row.

**[Open this program in the playground →](https://max-schaefer.github.io/datamog/#p=parent(%22alice%22%2C%20%22erin%22).%0Aparent(%22bob%22%2C%20%22erin%22).%0Aparent(%22cecil%22%2C%20%22frank%22).%0Aparent(%22diana%22%2C%20%22frank%22).%0Aparent(%22erin%22%2C%20%22greg%22).%0Aparent(%22erin%22%2C%20%22helen%22).%0Aparent(%22frank%22%2C%20%22greg%22).%0Aparent(%22frank%22%2C%20%22helen%22).%0A%23%20Tutorial%2C%20chapter%208%20%E2%80%94%20negation.%0A%23%0A%23%20Find%20%22orphans%22%20in%20our%20family%20tree%3A%20people%20who%20appear%20somewhere%0A%23%20in%20the%20parent%20table%20but%20have%20no%20parent%20themselves%20%E2%80%94%20i.e.%2C%20the%0A%23%20top%20generation.%0A%0Aperson(P)%20%3A-%20parent(P%2C%20_).%0Aperson(P)%20%3A-%20parent(_%2C%20P).%0A%0Ahas_parent(X)%20%3A-%20parent(_%2C%20X).%0A%0Aorphan(X)%20%3A-%20person(X)%2C%20not%20has_parent(X).%0A%0A%3F-%20orphan(X).%0A)**

## The safety rule for negation

A negated atom `not p(X)` filters already-bound variables; it
doesn't bind them. In our orphan rule, `X` is bound first by
`person(X)`; only then does `not has_parent(X)` filter the result.

If you try

```prolog
q(X, Y) :- r(X), not r(Y).
```

Datamog rejects it:

```
Unsafe variable 'Y' in 'not r(...)'
```

`Y` is only ever mentioned inside a negation, which can't bind it.
The fix is to bind `Y` first with a positive atom, then negate:

```prolog
q(X, Y) :- r(X), r(Y), not forbidden(Y).
```

Now `Y` is drawn from `r`; `not forbidden(Y)` filters it.

## Stratification

The second restriction is where things get interesting.

Negation is not monotone: adding a fact to `has_parent` can *remove*
a row from `orphan`. Seminaive evaluation relies on monotonicity:
"new facts only come from previously-new facts". That's exactly
what negation breaks.

The fix is to compute the predicate being negated *to completion*
before any rule that negates it runs. That's **stratification**.

Datamog builds a **dependency graph** where each node is a
predicate and each edge `A → B` means "there's a rule for `A` with
`B` in its body", tagged *positive* or *negative*. It then checks
whether the graph can be partitioned into numbered **strata** such
that:

- Every positive edge goes to the same or a lower stratum.
- Every negative edge goes to a *strictly* lower stratum.

If it can, the program is **stratified**: compute stratum 0 first
to its fixed point, then stratum 1 (which may negate stratum 0),
and so on. If a negative edge lies inside a cycle of the
dependency graph — i.e., `p` is reachable from `p` via a path that
includes a negative step — the program is **unstratifiable** and
Datamog refuses to compile it:

```prolog
p(X) :- r(X), not q(X).
q(X) :- r(X), not p(X).
```

gives

```
Negation of 'q' in rules for 'p' is not stratifiable (they are mutually
recursive). Recursion through negation needs the two sides to have opposite
polarity: mark exactly one of them maximal with '^'
```

Ignore the advice in the second sentence for now — it points at
[Chapter 17](17-parity.md), which is about the one shape of recursion
through negation that *does* have a well-defined meaning. Everything in
this chapter holds without it.

The directly-self-referential case

```prolog
p(X) :- r(X), not p(X).
```

is rejected for the same reason — `p` mutually recursive with
itself through a negative edge.

### Why this matters

Unstratifiable programs don't have a well-defined meaning under
the standard Datalog semantics. "`p(x)` holds iff not `p(x)`" has
no consistent interpretation — it's logically paradoxical. Rather
than let you write such a thing, Datamog refuses to compile it.
(Some exotic Datalog dialects extend to *well-founded* or *stable
model* semantics, which handle some unstratifiable programs, but
at considerable cost in complexity and explainability. Datamog
stops at stratified, with one carefully bounded exception:
[Chapter 17](17-parity.md) covers cycles that cross an *even*
number of negations, where the two negations cancel and a least
fixed point exists after all.)

## A subtle limit: set difference is fine; "closures excluding X" is harder

Negation in Datalog is **negation-as-failure**: a ground atom is
considered false exactly when it does not appear in the computed
relation. That's the **closed-world assumption**. It lets you
cleanly express "set difference":

```prolog
only_in_a(X) :- a(X), not b(X).
```

But it makes certain "recursive closures with an exception"
awkward. You'd want

```prolog
reach_avoiding(Src, Goal, Bad) :-
    edge(Src, Goal), Goal <> Bad.
reach_avoiding(Src, Goal, Bad) :-
    edge(Src, Mid), Mid <> Bad, reach_avoiding(Mid, Goal, Bad).
```

That's fine: there's no `not p(...)` in the body at all — the
"avoid this node" test is just a body-level inequality (`Goal <>
Bad`), which doesn't recurse. (Datamog's `not` only attaches to
predicate atoms; a `not X = Y` form does not exist as syntax.)
But if you wanted "reachable without touching any node in a
separately-computed set" and the set itself depended on
reachability, you'd have a negative edge inside a cycle. Datamog
would reject it, and you'd need to restructure the problem
(often by adding an extra argument so the recursion is by set
rather than against it).

> **Logic lens.** Negation-as-failure (NAF) reflects the
> **closed-world assumption**: a ground atom is false unless
> proven true. Stratified negation gives a well-defined semantics
> for NAF even in the presence of recursion: the *canonical model*
> is built up stratum by stratum, each stratum's minimal model
> becoming the ground truth against which the next stratum's
> negations are evaluated.
>
> The **Clark completion** we previewed in Chapter 3 is formally
> relevant here: a stratified program's minimal model is
> equivalent to the standard (two-valued) logical model of its
> Clark-completed form. That's the sense in which Datamog's
> programs *are* first-order logic, as long as they're stratified
> — and it's why "`p :- not p`" has to be rejected: its Clark
> completion is `p ↔ ¬p`, which is a contradiction.

> **SQL lens.** Negation compiles to `WHERE NOT EXISTS (...)` or
> to an anti-join `LEFT JOIN ... WHERE other.col IS NULL`, as you
> saw for the `orphan` view:
>
> ```sql
> CREATE OR REPLACE VIEW "orphan" AS
>   SELECT __b0."col1" AS col1
>   FROM "person" AS __b0
>   WHERE NOT EXISTS (
>     SELECT 1 FROM "has_parent" WHERE "col1" = __b0."col1"
>   )
> ;
> ```
>
> Because `has_parent` is computed by its own view, SQL picks up
> stratification for free: by the time `orphan`'s view is queried,
> `has_parent` is already a fully-materialisable view the engine
> can read from. The Datalog-level stratification check ensures
> we *build* views in the right order — Datamog emits
> `CREATE VIEW` statements in topological order of the dependency
> graph, so `has_parent`'s `CREATE VIEW` always appears before
> `orphan`'s.

> **Imperative lens.** Negation in Python is cheap — just an `if
> ... not in ...` test or a set difference:
>
> ```python
> people = {name for row in parent for name in (row[0], row[1])}
> has_parent = {c for (_p, c) in parent}
> orphans = people - has_parent
> ```
>
> The Python code does exactly what Datalog does under the hood,
> and the reason it's so simple is that Python has no monotone
> fixed-point contract to maintain. What Datalog gives you in
> exchange for its stratification discipline is the ability to
> mix negation with arbitrary recursion elsewhere in the program,
> *and* the guarantee that adding rules will never silently
> change existing answers — because you can't write the paradoxes
> that break that guarantee in the first place.

## Recap

- `not p(...)` is **negation-as-failure**: `p(...)` is considered
  false exactly when it's not in the computed relation (closed-world
  assumption).
- A negated atom *filters* — it doesn't bind. Variables inside
  `not` must be bound elsewhere first.
- **Stratification** splits predicates into layers; each layer is
  computed to completion before the next layer, which may negate
  it, runs. Cycles through negation are rejected.
- Through the **logic lens**, stratified negation gives Datalog
  programs a well-defined model-theoretic meaning. Through the
  **SQL lens**, negation compiles to `NOT EXISTS` and
  stratification falls out of view-creation order.

## Exercises

### Exercise 8.1 — Leaf nodes ★

Starter: [`code/ch08/ex1-leaves.dl`](code/ch08/ex1-leaves.dl)

Given a directed graph `edge(src, dst)`, define `leaf(X)` — nodes
with no outgoing edges. You'll need an intermediate predicate for
"has outgoing" and a negation against it.

### Exercise 8.2 — Courses with no prerequisites ★

Starter: [`code/ch08/ex2-roots.dl`](code/ch08/ex2-roots.dl)

A small `prereq(course, requires)` relation is given. Define
`starter_course(C)` for courses that have no prerequisites.

### Exercise 8.3 — Set difference ★★

Starter: [`code/ch08/ex3-diff.dl`](code/ch08/ex3-diff.dl)

Given two EDBs `a(x)` and `b(x)` (both unary over `string`), define
`only_in_a(X)`, `only_in_b(X)`, and `in_both(X)`. Only `only_in_a`
and `only_in_b` need negation; `in_both` is a plain positive join.

### Exercise 8.4 — Spot the unstratifiable program ★★

For each of the following, say whether Datamog will accept it.

```prolog
# (a)
p(X) :- r(X), not q(X).
q(X) :- s(X), not r(X).

# (b)
p(X) :- r(X), not q(X).
q(X) :- s(X), not p(X).

# (c)
p(X) :- r(X), not r_negated(X).
r_negated(X) :- t(X).

# (d)
a(X) :- r(X).
b(X) :- a(X), not c(X).
c(X) :- r(X), not a(X).
```

Check your answers against
[`solutions/ch08/ex4.md`](solutions/ch08/ex4.md).

### Exercise 8.5 — Emulating negation without `not` ★★★

Can you write `orphan` without using the `not` keyword at all?
Hint: you can't, in pure stratified Datalog without negation.
Set difference fundamentally requires either explicit negation or
aggregation (which we'll meet in Chapter 9). Try it; write up
what you notice. See
[`solutions/ch08/ex5.md`](solutions/ch08/ex5.md).

---

Next: **[Chapter 9 — Aggregates](09-aggregates.md)**. Another kind of
non-monotone computation — `count`, `sum`, `avg`, `min`, `max`, and
`concat` — with the same stratification machinery keeping recursion and
aggregation playing nicely together.
