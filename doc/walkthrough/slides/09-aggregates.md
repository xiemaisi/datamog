---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 9
## Aggregates

`count`, `sum`, `avg`, `min`, `max`, `concat`, `list` — the other non-monotone operator

---

# Why aggregates need stratification

Negation is non-monotone: `orphan` can disappear when a `has_parent` row is added.

Aggregation is too: a `count` can go up, an `avg` can shift, a `min` or `max` can change.

→ **Same stratification discipline as negation.** Aggregation cannot live inside recursion; aggregate predicates are computed *after* the relations they aggregate over.

---

# The seven aggregates

`count`, `sum`, `avg`, `min`, `max`, `concat`, `list`.

Spelled as function calls in the **rule head**:

```prolog
input predicate scores(student: string, subject: string, score: integer).

student_avg(Student, avg(Score))   :- scores(Student, _, Score).
best(Student, max(Score))          :- scores(Student, _, Score).
num_subjects(Student, count(Subject)) :- scores(Student, Subject, _).
total(count(*))                    :- scores(_, _, _).
```

---

# The grouping rule

> **Non-aggregate head arguments become the implicit `GROUP BY` columns.**

In `student_avg(Student, avg(Score))`:

- `Student` is plain → grouping column.
- `avg(Score)` is an aggregate → reduced over the group.

→ "one row per distinct value of `Student`"

Same mental model as SQL: any `SELECT` column not inside an aggregate function becomes part of the implicit `GROUP BY`.

---

# `count(*)` is `COUNT(*)`

The special form `count(*)` counts rows — irrespective of column.

- `count(*)` → `COUNT(*)`
- `count(X)` counts every row where `X` has a value, `null` included, so it equals `count(*)`

For ordinary Datalog programs the two coincide. `count(*)` is the **idiomatic** "how many rows".

---

# `concat`

```prolog
subjects_of(Student, concat(Subject)) :-
    scores(Student, Subject, _).
```

Concatenates textual values per group with a fixed `,` separator:

```
("alice", "math,science,english")
```

Compiles to:

- `GROUP_CONCAT(..., ',')` on SQLite / sql.js
- `STRING_AGG(...::TEXT, ',')` on Postgres

---

# `list` — list comprehension over `value`s

Primitive args auto-lift to a `value`; or build a `value` per row, then aggregate:

```prolog
all_scores(Student, list(Score)) :- scores(Student, _, Score).

record(Student, {"subject": Subject, "score": Score}) :-
    scores(Student, Subject, Score).
all_records(Student, list(R)) :- record(Student, R).
```

→ `all_scores` is one row per student, second column an array `value` of integers; `all_records` swaps in object `value`s.

- Primitive args (`integer`, `float`, `string`, `boolean`) auto-lift to a `value`.
- Sort key: **natural value** for primitives (numeric / lex), **canonical text** for `value` arguments — same array on every backend.
- Compiles to `JSON_GROUP_ARRAY(json(...))` (SQLite / sql.js) or `JSONB_AGG(...)` (Postgres).

---

# Restrictions on aggregate rules

1. **Cannot be recursive.** An aggregate predicate cannot appear (positively or negatively) in its own rule body, nor in a cycle. Mirrors negation: aggregation is non-monotone.

2. **Consistent across rules.** If a predicate has multiple rules (rare for aggregates), they must use the **same aggregate function in the same head position**. `num(S, count(X))` + `num(S, sum(X))` is rejected.

Both are enforced at analysis time — targeted error, not silently-wrong SQL.

---

# Filter after aggregate — the canonical pattern

```prolog
worst_score(Student, min(Score)) :- scores(Student, _, Score).

strong(Student) :- worst_score(Student, W), W > 80.
```

`strong` is an **ordinary non-aggregate rule** that reads `worst_score`. Stratification guarantees `worst_score` is already finished by the time `strong`'s rule fires.

This is *the* idiom for "filter by an aggregate value". Two strata: aggregate, then filter.

---

# Logic lens

Aggregation, like negation, sits **outside pure Horn-clause Datalog** — both are non-monotone.

Standard treatment: at the aggregate's stratum, take the (already monotonically-computed) ungrouped relation and reduce each group.

That's why aggregates can't recurse — they'd break the monotonicity that fixed-point iteration relies on. Stratification lets aggregation and recursion coexist as long as they sit in **different layers**.

---

# SQL lens

```sql
CREATE OR REPLACE VIEW "student_avg" AS
  SELECT __b0."student" AS col1,
         AVG(__b0."score") AS col2
  FROM "scores" AS __b0
  GROUP BY __b0."student";
```

Almost direct translation:

- "non-aggregate head var → grouping column" rule maps to SQL's `GROUP BY`.
- `count(*)` → `COUNT(*)` with no grouping (single-row result).
- `concat` and `list` pick the right per-backend spelling, with explicit `ORDER BY` for deterministic output.

---

# Imperative lens

```python
from collections import defaultdict
from statistics  import mean

by_student = defaultdict(list)
for (s, _, score) in scores:
    by_student[s].append(score)

student_avg = {s: mean(xs) for s, xs in by_student.items()}
best        = {s: max(xs)  for s, xs in by_student.items()}
num_subj    = {s: len(xs)  for s, xs in by_student.items()}
```

Three passes for three aggregates. Datalog's form is the same idea — the engine decides grouping and re-use. It also **composes**: filter-by-aggregate is one extra rule.

---

# Recap

- Aggregates go in the **rule head**; non-aggregate head args become **implicit `GROUP BY` columns**.
- `count(*)` is `COUNT(*)`; the others take a column expression.
- Aggregate predicates cannot be recursive; multi-rule heads must agree on aggregate position and function.
- **Filter by aggregate** = a downstream non-aggregate rule reading the aggregate IDB. Stratification handles the order.
- All three lenses agree: "compute the ungrouped relation, then reduce each group".

---

# Where to next

This finishes the **language tour**. Part IV zooms out:

- **Modelling** — when to split into predicates, EDB vs. IDB heuristics, debugging with `--dry-run`.
- **Puzzles** — generate-and-test in action.
- **Program analysis** — Datalog as a static-analysis specification language.
- **Graphs** — closures, paths, BoMs.

[Chapter 10. Modelling with Datalog →](10-modelling.md)
