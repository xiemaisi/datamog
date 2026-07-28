---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 10
## Modelling with Datalog

The craft of using the language well — schema choices, predicate factoring, debugging

---

# Beyond features — into craft

Parts I–III introduced every language feature.

This chapter is about how to actually **shape a problem into Datalog**: schemas, predicate factoring, and the `--dry-run` debugging reflex.

It's shorter and more advisory than the foundational chapters. The patterns here are habits you build up.

---

# A small schema, written carefully

```prolog
input predicate employee(id: integer, name: string, salary: integer).
input predicate in_department(emp_id: integer, dept_id: integer).
input predicate manages(manager: integer, report: integer).
```

Notice what's **not** there:

- **No nullable manager column.** Nullable EDB columns exist (`type?`), but optional relationships usually read better as separate predicates. An employee with no manager just isn't in `manages`.
- **No embedded structure.** A department is a separate predicate linked by `id`, not a nested object.
- **No hidden composite keys.** Keys are columns with a role.

---

# EDB vs. IDB — practical heuristic

| Use an **EDB** when... | Use an **IDB** when... |
| --- | --- |
| Data is *given* — loaded, entered, upstream | Data is *derived* — computable from other predicates |
| It's the boundary with the outside world | It's an abstraction that composes |

If you want to materialise an IDB for caching, do that at engine level — Datalog has no notion of a "stored IDB". Workaround: dump rows to CSV, declare extensional in a follow-up run.

---

# Splitting concerns into predicates

```prolog
is_manager(M)    :- manages(M, _).
reports_to(R, M) :- manages(M, R).
reports_to(R, M) :- manages(M, X), reports_to(R, X).
ic(E)            :- employee(E, _, _), not is_manager(E).
```

`is_manager` could have been inlined into `ic`. Keeping it separate buys:

- **Reusability** — likely referenced elsewhere.
- **Debuggability** — query intermediates directly.
- **Readability** — `ic` reads as "an employee who isn't a manager".

The tradeoff: too many intermediates obscure flow.

---

# Rule of thumb for factoring

> **Factor out any concept that has a name in the domain.**

- "Is a manager" → predicate. Clear concept.
- "Is an employee neither in finance nor HR who has been here >5 years" → just a body of a rule.

If it doesn't have a name, it's probably not earning a predicate.

---

# Keys are a convention — until you enforce one

`id` is `employee`'s key "because other predicates refer to it". Nothing in the declaration says so, and no data file is obliged to agree.

An **integrity constraint** is a predicate asserted to be empty. Its tuples are the counterexamples.

```prolog
error predicate unknown_department_member(EmpId) :-
  in_department(EmpId, _), not employee(EmpId, _, _).
```

A **foreign key**. You don't state the invariant — you state what breaking it looks like, and assert there is no such thing.

---

# Primary keys and set semantics

"No two rows share an id" can't be written directly. But two identical rows *are* one row, so two tuples share an id only if something else differs:

```prolog
error predicate duplicate_employee_id(Id) :-
  employee(Id, N1, S1), employee(Id, N2, S2), N1 <> N2 || S1 <> S2.
```

Not recursion — the head isn't in the body — so it runs on every backend.

> **`<>`, not `!=`.** `null <> "bob"` is true; `null != "bob"` is `null`, so a duplicate with a null name is silently missed.

`!-` takes a conjunction directly when the constraint needs no name:

```prolog
!- manages(M, M).
```

---

# What a violation does

Checked at the fixed point, **before any output is produced**:

```
hr.dl: Constraint 'duplicate_employee_id' is violated by 1 row:
  Id = 2
Constraint 'unknown_manages_party' is violated by 1 row:
  Who = 7
```

Then nothing else — no query results, non-zero exit. Results derived from data the program calls invalid are worse than no results, because they look fine.

- **Put the witness in the head.** `bad(Id)` beats `bad()`.
- **Constrain the EDBs.** The data you don't control is the data worth checking.

---

# Recursion inside a domain model

`reports_to` is a recursive IDB with clear domain meaning: "transitively, who do you report up to?"

Recursion is fine in the middle of a schema as long as you remember Chapter 4's rules:

- One base case, at least one recursive step.
- Linear recursion only.
- Recursion must be monotone — no `not reports_to(...)` inside a `reports_to` rule.

For something that feels like negation inside recursion, push the negated concept to a different stratum.

---

# Aggregate-over-recursion — the canonical idiom

```prolog
reports_to(R, M) :- manages(M, R).
reports_to(R, M) :- manages(M, X), reports_to(R, X).

report_count(M, count(R)) :- reports_to(R, M).
big_team_manager(M) :- report_count(M, C), C >= 2.
```

Three strata:

1. `reports_to` (recursive) — over EDB.
2. `report_count` (aggregate) — over `reports_to`.
3. `big_team_manager` (filter) — over `report_count`.

Each stratum reads only from strictly lower strata. Reach for this whenever a problem asks "how many X satisfy a recursive property".

---

# `--dry-run` as a debugger

When a rule produces wrong answers, run `--dry-run` and read the SQL.

Common things you'll spot:

- A "join" rule turns into a `CROSS JOIN` — the supposedly-shared variable isn't actually shared. Look for the missing `WHERE` equality.
- A filter rule returns everything — the comparison got optimised away because one side collapsed to a constant.
- A recursive view compiles to plain `SELECT` — no longer recognised as recursive.

Every Datalog programmer develops the `--dry-run` reflex. The 30 seconds usually save 30 minutes.

---

# A brief word on performance

This isn't a perf guide, but rules of thumb once you build something non-trivial:

- **Indices.** SQL backends inherit from the underlying DB. Add indices on heavily-joined columns (Postgres). SQLite indices help but Datamog doesn't create them for you.
- **Recursion width.** Recursive views are expensive — each iteration materialises intermediates. Consider factoring or constraining inputs.
- **Aggregates.** Aggregates read every row of their group. If you compute over a million rows and use the aggregate once, restructure to aggregate over a smaller set.

---

# Recap

- **EDB** for boundary data; **IDB** for derived data. Flatten instead of nest. Prefer separate predicates for optional relationships.
- **Factor** named concepts into predicates; **inline** unnamed ones.
- **Constrain** what the schema assumes. Foreign key = `not` over the referent; primary key = self-join on the key, rest must differ (with `<>`).
- **Aggregate-over-recursion** is a three-stratum idiom (recursive IDB → aggregate IDB → filter rule).
- **`--dry-run`** is your debugger. Read the generated SQL when answers look wrong.

---

# Where to next

We've covered every feature plus how to use them. Time to put them to work.

Next up: a small whodunit puzzle, in three predicates and a query. The **generate-and-test** pattern is what lets Datalog handle constraint-shaped problems with surprising grace.

[Chapter 11. Search and puzzles →](11-puzzles.md)
