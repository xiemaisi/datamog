---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 4
## Recursion and transitive closure

Letting a predicate refer to itself — and unlocking the rest of Datalog

---

# Why this chapter is the pivot

Everything in Chapters 1–3 fits in plain SQL: a few `JOIN`s and a `UNION` or two.

Letting a predicate appear in **its own body** changes that. Now Datalog can express:

- transitive closure
- reachability
- shortest paths
- anything with "base case + step until stable"

SQL handles it too — with `WITH RECURSIVE` and careful gymnastics. Datalog just lets you write it.

---

# Ancestor — the canonical example

```prolog
input predicate parent(parent_name: string, child_name: string).

ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).

?- ancestor("alice", X).
```

- **Base case** — every parent is an ancestor.
- **Recursive step** — a parent of an ancestor is also an ancestor.

The second rule is recursive because `ancestor` appears in both head and body.

---

# What it computes, intuitively

Round by round:

- **Round 0.** `ancestor` is empty.
- **Round 1.** Base rule fires → every one-generation pair.
- **Round 2.** Recursive rule fires → every two-generation pair.
- **Round k.** Every up-to-*k*-generation pair.
- **Eventually.** No new rows. Stop.

This is **naive evaluation**. Apply rules until nothing changes. Chapter 5 unpacks it.

---

# The same pattern outside families

```prolog
input predicate edge(src: string, dst: string).

reach(X, Y) :- edge(X, Y).
reach(X, Y) :- edge(X, Z), reach(Z, Y).
```

Blur your eyes: this is `ancestor` with `parent`/`ancestor` renamed.

> **Base case + linear recursive step = transitive closure.**

Every recursion in this tutorial is a variant of it.

---

# Anatomy of a recursive predicate

A well-formed recursive Datalog predicate needs:

1. **A base case** — at least one rule whose body doesn't reference the predicate. Without one, recursion has nowhere to start; Datamog inserts an empty anchor so you get zero rows rather than a malformed query.
2. **A recursive step** — at least one rule whose body mentions the predicate.
3. **Linear, on SQL backends** — at most one self-reference per rule body.

---

# Linear vs. non-linear

```prolog
tc(X, Z) :- edge(X, Y), tc(Y, Z).       # linear — accepted
tc(X, Z) :- tc(X, Y), tc(Y, Z).         # non-linear — rejected on SQL
```

**Why?** SQL's recursive CTE pins both references to the same snapshot, silently losing derivations. The pure-Datalog backends `native` and `seminaive` do compute non-linear recursion correctly.

For SQL portability, split the recursion by joining with an EDB atom (the linear form above).

---

# Forward vs. backward recursion

```prolog
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).   # step at top
ancestor(X, Y) :- ancestor(X, Z), parent(Z, Y).   # step at bottom
```

These are **logically equivalent** — same answers.

In Prolog the second form would loop forever (top-down SLD resolution). In Datalog there's no such asymmetry: evaluation is **bottom-up**, filling the relation in round by round. Recursive body atoms just look up a finite already-computed set.

---

# Logic lens — least fixed point

The meaning of a recursive program is the **least fixed point** of the immediate-consequence operator `Tₚ`:

```
I₀ = ∅
I₁ = Tₚ(I₀)
I₂ = Tₚ(I₁)
...
```

- Rules are monotone → sequence is increasing.
- Active domain is finite → sequence stabilises.

The fixed point is the **minimal Herbrand model** — Datalog's answer.

It's also **unique** — a property you lose when disjunction sneaks into rule bodies.

---

# SQL lens — `WITH RECURSIVE`

```sql
CREATE OR REPLACE VIEW "ancestor" AS
  WITH RECURSIVE "ancestor"(col1, col2) AS (
    SELECT __b0."parent_name", __b0."child_name"
    FROM "parent" AS __b0
    UNION
    SELECT __b0."parent_name", __b1."col2"
    FROM "parent" AS __b0, "ancestor" AS __b1
    WHERE (__b0."child_name" IS NOT DISTINCT FROM __b1."col1")
  )
  SELECT * FROM "ancestor";
```

Base rule = anchor; recursive rule = step. SQL iterates the step until no new rows. That's naive evaluation in SQL.

---

# Imperative lens

```python
def descendants_of(anc):
    worklist = [c for (p, c) in parent if p == anc]
    seen = set()
    while worklist:
        x = worklist.pop()
        if x in seen: continue
        seen.add(x)
        worklist.extend(c for (p, c) in parent if p == x)
    return seen
```

Three explicit moves: **worklist**, **seen-set**, **termination check**. Datalog leaves all three implicit.

Bonus: swap the question (`ancestors_of`) and you'd rewrite the whole loop. The Datalog rule answers both directions unchanged.

---

# Recap

- A predicate is **recursive** if at least one rule references it in the body.
- Recursive rules must be **linear** on SQL backends; `native`/`seminaive` accept non-linear.
- The meaning is the **least fixed point**: iterate "one more step" until nothing new appears.
- **Logic lens** — minimal Herbrand model.
- **SQL lens** — `WITH RECURSIVE` with anchor + step.
- **Imperative lens** — worklist/seen-set loop, written for you.

---

# Where to next

Now that recursion works, **how** does it work? Chapter 5 opens the engine: naive vs. seminaive evaluation, stratification, and Datamog's two pure-Datalog backends.

If you want to trust "it terminates" or debug a slow recursion, that's the chapter.

[Chapter 5. How Datalog runs →](05-evaluation.md)
