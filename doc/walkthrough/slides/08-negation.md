---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 8
## Negation and stratification

Saying "not this" — and the discipline that lets it coexist with recursion

---

# Why negation needs care

Everything we've seen so far has been **monotone**: more facts in → more rows out, never fewer.

Monotonicity is what makes Datalog's fixed-point semantics clean and seminaive evaluation correct.

Negation breaks it. Add `has_parent("erin")` and an `orphan("erin")` row *disappears*.

Datamog's answer: **stratified negation**. You may use `not`, but only on predicates that can be computed before the rule using them fires.

---

# Orphans

```prolog
input predicate parent(parent_name: string, child_name: string).

person(P) :- parent(P, _).
person(P) :- parent(_, P).

has_parent(X) :- parent(_, X).

orphan(X) :- person(X), not has_parent(X).
```

> `X` is an orphan if `X` is a person **and** `X` does not have a parent.

Result: the four top-generation names (`alice`, `bob`, `cecil`, `diana`).

---

# Negation doesn't bind

`not p(X)` filters; it doesn't bind. `X` must already be bound by something positive.

```prolog
q(X, Y) :- r(X), not r(Y).     # rejected
```

```
Unsafe variable 'Y' in head of rule for 'q'
```

Fix:

```prolog
q(X, Y) :- r(X), r(Y), not forbidden(Y).
```

Now `Y` is drawn from `r`; `not forbidden(Y)` filters it.

---

# Stratification — the rule

Datamog builds a **dependency graph**: nodes are predicates, edges `A → B` mean "a rule for `A` mentions `B`", tagged positive or negative.

The graph must split into numbered **strata** such that:

- Every **positive** edge goes to the same or a lower stratum.
- Every **negative** edge goes to a **strictly lower** stratum.

If it does, compute stratum 0 to fixed point, then stratum 1 (which may negate stratum 0), and so on.

If a negative edge sits inside a cycle, the program is **unstratifiable** — Datamog refuses.

---

# Unstratifiable examples

```prolog
p(X) :- r(X), not q(X).
q(X) :- r(X), not p(X).
```

```
Negation of 'q' in rules for 'p' is not stratifiable
(they are mutually recursive). ... mark exactly one
of them maximal with '^'
```

And the direct case:

```prolog
p(X) :- r(X), not p(X).
```

Same rejection — `p` is mutually recursive with itself through a negative edge.

---

# Why reject these?

`p ↔ ¬p` has no consistent interpretation. It's logically paradoxical.

Some exotic Datalog dialects extend to **well-founded** or **stable model** semantics, which can give meaning to *some* unstratifiable programs — at significant cost in complexity and explainability.

Datamog stops at stratified.

---

# Negation-as-failure

Datalog's negation is **negation-as-failure** under the **closed-world assumption**: a ground atom is false exactly when it does not appear in the computed relation.

It cleanly expresses **set difference**:

```prolog
only_in_a(X) :- a(X), not b(X).
```

It's awkward for "recursive closure with an exception" — that's where you may need to restructure the problem (often by adding an extra argument).

---

# Logic lens

Stratified negation gives a well-defined semantics for negation-as-failure even with recursion: the **canonical model** is built up stratum by stratum.

The **Clark completion** from Chapter 3 is formally relevant: a stratified program's minimal model coincides with the standard logical model of its Clark-completed form.

That's the sense in which Datamog programs *are* first-order logic, as long as they're stratified — and why `p :- not p` has to be rejected: its completion is `p ↔ ¬p`, a contradiction.

---

# SQL lens

Negation compiles to `NOT EXISTS` (or an anti-join):

```sql
CREATE OR REPLACE VIEW "orphan" AS
  SELECT __b0."col1" AS col1
  FROM "person" AS __b0
  WHERE NOT EXISTS (
    SELECT 1 FROM "has_parent" WHERE "col1" = __b0."col1"
  );
```

SQL picks up stratification for free: by the time `orphan`'s view is queried, `has_parent` is already a materialisable view.

Datamog emits `CREATE VIEW` statements in **topological order** of the dependency graph.

---

# Imperative lens

```python
people     = {n for row in parent for n in (row[0], row[1])}
has_parent = {c for (_p, c) in parent}
orphans    = people - has_parent
```

Python's set difference does the same thing — and is shorter, because Python has no monotone fixed-point contract to maintain.

What you get from Datalog's discipline: the freedom to **mix negation with arbitrary recursion elsewhere** in the program, plus the guarantee that adding rules will never silently change existing answers.

---

# Recap

- `not p(...)` is **negation-as-failure** under the **closed-world assumption**.
- Negation **filters**; variables inside `not` must be bound elsewhere first.
- **Stratification** splits predicates into layers — each layer fully computed before any rule that negates it fires.
- Cycles through negation are rejected.
- **Logic lens** — well-defined model. **SQL lens** — `NOT EXISTS`, view-creation order. **Imperative lens** — set difference, more freely than Python because Datalog protects against paradox.

---

# Where to next

Aggregates (`count`, `sum`, `avg`, `min`, `max`, `concat`) are the other non-monotone operator.

Same stratification machinery handles them, with one extra constraint: aggregate predicates cannot themselves be recursive.

[Chapter 9. Aggregates →](09-aggregates.md)
