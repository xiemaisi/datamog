---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 2
## Rules, variables, and joins

Defining new predicates from old ones — and how a shared variable is a SQL join in disguise

---

# The setup

A small three-generation family in `parent.csv`:

```
parent_name,child_name
alice,erin       bob,erin
cecil,frank      diana,frank
erin,greg        erin,helen
frank,greg       frank,helen
```

Four people on top, two in the middle, two at the bottom. Just enough structure to play with.

---

# Your first rule

```prolog
has_a_parent(C) :- parent(_, C).
```

Read `:-` as **"if"**:

> `C` has a parent, if there is *someone — we don't care who —* whose child is `C`.

- **Head** (left of `:-`) — the new predicate we're defining.
- **Body** (right of `:-`) — what must hold for the head to be true.

`has_a_parent` is **intensional**: defined by a rule, not by data.

---

# EDB and IDB

- **EDB** (Extensional Database) — predicates given by enumeration. `parent`.
- **IDB** (Intensional Database) — predicates defined by rules. `has_a_parent`, `grandparent`, ...

A typical program: a few EDBs supplying raw facts, a stack of IDBs computing derived relations.

---

# Multi-atom bodies are joins

```prolog
grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
```

> `X` is a grandparent of `Z` if `X` is a parent of **some** `Y`, and that `Y` is a parent of `Z`.

The comma is **logical AND**. The shared variable `Y` is the join — it must take the same value in both atoms.

Result: 8 grandparent pairs (4 top-gen × 2 bottom-gen).

---

# Variables, constants, `_`

- **Variables** start with an uppercase letter. (`Greg` is a variable; `"greg"` is a string.)
- **String literals** are double-quoted.
- **Underscore `_`** is a fresh anonymous variable each time. The two `_`s in `parent(_, _)` are not the same variable.

---

# Asking a directed question

```prolog
?- grandparent(X, "greg").
```

> "Who are Greg's grandparents?" → `alice`, `bob`, `cecil`, `diana`.

A constant in any argument position acts as a filter. The same `grandparent` rule answers:

- forward — Alice's grandchildren
- backward — Greg's grandparents
- both ends free — every pair
- both ends fixed — yes/no

---

# Longer chains

```prolog
great_grandparent(X, W) :-
    parent(X, Y), parent(Y, Z), parent(Z, W).
```

Three body atoms, two shared variables. Returns no rows on our data — the tree is only three deep.

That's a feature: a rule has meaning whether or not the data satisfies it. Add a fourth generation and `great_grandparent` lights up — without changing the rule.

---

# Logic lens

Every rule is a universally quantified **Horn clause**:

```
∀X, Y, Z. (parent(X, Y) ∧ parent(Y, Z)) → grandparent(X, Z)
```

A Horn clause has at most **one positive head atom** — that's what gives Datalog its nice properties (terminating, unique least model). We'll lean harder on this in Chapter 4.

---

# SQL lens

```sql
CREATE OR REPLACE VIEW "grandparent" AS
  SELECT __b0."parent_name" AS col1,
         __b1."child_name"  AS col2
  FROM   "parent" AS __b0, "parent" AS __b1
  WHERE  (__b0."child_name" IS NOT DISTINCT FROM __b1."parent_name");
```

- A rule → a view.
- Each body atom → a `FROM` alias.
- Shared variables → `WHERE` equalities.
- Head variables → `SELECT` columns (positional `col1`, `col2`).

Once you see it, every rule looks like a `SELECT` in disguise.

---

# Imperative lens

In Python, "Alice's grandchildren" and "Greg's grandparents" are *different loops* (forward vs. backward traversal). Each new direction = another function.

```prolog
?- grandparent("alice", X).      # forward
?- grandparent(X, "greg").       # backward
?- grandparent(X, Y).            # all pairs
?- grandparent("alice", "greg"). # yes/no
```

**One rule, four queries.** A relation has no preferred direction; the engine picks the iteration order.

---

# Order doesn't matter

- The two rules of a predicate can appear in either order.
- Inside a body, atoms can be reordered: `parent(Y, Z), parent(X, Y)` is the same as `parent(X, Y), parent(Y, Z)`.

The meaning of a Datalog program is its **least fixed point** — depends only on the *set* of rules and their logical content, not on syntactic ordering. We'll make this precise in Chapter 4.

---

# Recap

- A **rule** `head :- body.` defines an IDB predicate from existing ones; multiple body atoms are AND.
- A **shared variable** across two body atoms is a join.
- **Logic lens** — every rule is a Horn clause.
- **SQL lens** — every rule is `CREATE VIEW ... SELECT`; shared vars become `WHERE` equalities.
- **Imperative lens** — one rule replaces several direction-specific Python functions.

---

# Where to next

We've defined predicates with one rule. What if a concept has *several* cases?

Multiple rules for the same predicate is how Datalog expresses **disjunction** — and it's the last non-recursive ingredient before we unlock recursion.

[Chapter 3. Multiple rules and disjunction →](03-disjunction.md)
