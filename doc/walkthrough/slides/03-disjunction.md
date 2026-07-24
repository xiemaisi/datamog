---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 3
## Multiple rules and disjunction

How Datalog expresses "or" — and why it lives at the predicate level, not inside a body

---

# Two rules, one predicate

A new EDB: `marriage(p1, p2)`. Each marriage is recorded **once**, in some order.

```prolog
spouse(X, Y) :- marriage(X, Y).
spouse(X, Y) :- marriage(Y, X).
```

Two rules, same head predicate, same arity. Read together:

> `X` is a spouse of `Y` if `marriage(X, Y)` is a fact, **or if** `marriage(Y, X)` is a fact.

That "or" is what multiple rules give you.

---

# No body-level "or"

Pure Datalog has no `;` or `|` inside rule bodies. Disjunction lives at the **predicate** level — you write it by providing several rules.

```prolog
spouse(X, Y) :- marriage(X, Y) ; marriage(Y, X).   # NOT ALLOWED
```

You write the two rules out separately.

---

# Union of sources

Rules don't have to be symmetry flips — they can draw from completely different predicates:

```prolog
close_kin(X, Y) :- parent(X, Y).
close_kin(X, Y) :- parent(Y, X).
close_kin(X, Y) :- spouse(X, Y).
```

Three rules, one head. `close_kin` holds if either is the other's parent, **or** they are spouses.

`?- close_kin("erin", X).` → her parents, her children, her spouse.

---

# Consistency requirements

When a predicate has multiple rules, Datamog enforces:

- **Same arity.** All rules of a predicate have the same number of head args.
- **Column types unify by widening.** Across rules, `integer`/`float` → `float` and other mismatches → `value`; this always succeeds.
- **Set semantics.** The relation is the *union of sets* — duplicate tuples appear once.

All three follow from "a predicate is a relation, and relations are sets".

---

# Logic lens

Two rules with the same head are two implications with a shared conclusion:

```
∀X, Y. marriage(X, Y) → spouse(X, Y)
∀X, Y. marriage(Y, X) → spouse(X, Y)
```

Read forwards: `spouse(X, Y)` if **any** rule fires.

The dual reading — the **Clark completion** — flips this into a biconditional:

```
∀X, Y. spouse(X, Y) ↔ (marriage(X, Y) ∨ marriage(Y, X))
```

That "iff" reading is the **closed-world** view; it matters once we add negation in Chapter 8.

---

# SQL lens

```sql
CREATE OR REPLACE VIEW "spouse" AS
  SELECT __b0."p1" AS col1, __b0."p2" AS col2 FROM "marriage" AS __b0
  UNION
  SELECT __b0."p2" AS col1, __b0."p1" AS col2 FROM "marriage" AS __b0;
```

- Each rule → one `SELECT`.
- Multiple rules → joined with `UNION` inside one view.
- *N* rules → an *N*-way `UNION`.

`UNION` (without `ALL`) deduplicates — matches Datalog's set semantics for free.

---

# Why no body-level "or"?

Two reasons.

**Pragmatic.** Every Datalog rule maps to one SQL `SELECT`. Forcing disjunction up to the predicate level keeps the mapping one-to-one.

**Theoretical.** In FOL, `A ∨ B → C` is equivalent to `(A → C) ∧ (B → C)`. Distributing disjunction over multiple rules *is* the **Horn-clause normal form**. Pure Datalog requires that form.

Some dialects offer `|` or `;` as sugar that desugars to multiple rules. Datamog doesn't — you write them out.

---

# Recap

- A predicate can have **multiple rules**; the relation is the **union** of what each rule derives.
- No body-level disjunction in Datamog — multiple rules is how you do "or".
- **Logic lens** — each rule is one Horn clause; the set of rules is a conjunction of implications with a shared conclusion.
- **SQL lens** — multiple rules compile to a `UNION` of `SELECT`s inside a single view.

---

# Where to next

We have facts, single-rule definitions, and predicate-level disjunction. The last big move: let a predicate refer to **itself** in its body.

That single change turns Datalog from "a tidy front end for joins" into a general-purpose fixed-point engine.

[Chapter 4. Recursion and transitive closure →](04-recursion.md)
