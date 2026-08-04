# Chapter 10 — Modelling with Datalog

Part I–III introduced the core of the language. This chapter is
about the *craft* of using it: how to shape a problem into Datalog,
when to split a concept into multiple predicates, how to state a
schema's invariants so the program enforces them, and how to use
`--dry-run` output as a debugging tool. It's shorter than the
foundational chapters and more advisory — the patterns here are
habits you build up. The one new piece of syntax it introduces,
integrity constraints, belongs here because deciding *what* to
constrain is a modelling question.

## A small schema, written carefully

From [`code/ch10/hr.dl`](code/ch10/hr.dl):

```prolog
input predicate employee(id: integer, name: string, salary: integer).
input predicate in_department(emp_id: integer, dept_id: integer).
input predicate manages(manager: integer, report: integer).
```

Three EDBs, each a simple flat relation. Notice what's **not**
there:

- **No nullable manager column.** Nullable EDB columns exist (`type?`)
  for externally sourced partial data, but they are not the default
  modelling tool. An employee without a manager simply doesn't appear
  in `manages`, which fits naturally with Datalog's set semantics.
- **No embedded structure** in the relational layer. A department
  is not a nested object inside an employee; it's a separate
  predicate linked by `id`. Datalog has no record types beyond flat
  tuples, and this is usually the *right* shape — it lets any
  predicate participate in joins with any other. (When you genuinely
  need to ingest deeply-nested data without flattening it first,
  Datamog does have a `value` column type that supports
  destructuring; see [Chapter 14](14-json.md). The "destructure-only"
  design keeps the rest of this chapter's advice intact —
  `value` columns are an escape hatch for opaque payloads, not a
  replacement for flat-tuple modelling.)
- **No composite keys hidden inside the schema.** Keys are just
  columns with a role. `id` in `employee` is the key because other
  predicates refer to it.

### EDB vs. IDB — a practical heuristic

- **Use an EDB** when the data is *given* — loaded from a file,
  entered by a user, coming from an upstream system. EDBs are the
  boundary between Datalog and the outside world.
- **Use an IDB** when the data is *derived* — computable from other
  predicates via a rule. IDBs compose, and because each is a named
  view, they're the unit of abstraction for a Datalog program.

If you find yourself wanting to "materialise" an IDB as an EDB (for
caching, or because it's expensive), do that at the engine level —
Datalog doesn't have a notion of "stored IDB". In Datamog you can
simulate it by writing the IDB's rows into a CSV, then declaring
it extensional in a follow-up run.

### Splitting concerns into predicates

The same rule above uses three intermediate predicates:

```prolog
is_manager(M) :- manages(M, _).

reports_to(R, M) :- manages(M, R).
reports_to(R, M) :- manages(M, X), reports_to(R, X).

ic(E) :- employee(E, _, _), not is_manager(E).
```

You could have inlined `is_manager` into `ic`. Keeping it separate
has three payoffs:

- **Reusability.** `is_manager` is likely to be referenced
  elsewhere in the program.
- **Debuggability.** When the answer for `ic` looks wrong, you can
  query `is_manager` directly to check the intermediate.
- **Readability.** The rule for `ic` reads as "an individual
  contributor is an employee who isn't a manager" — closer to
  English than a deeply-nested single rule would be.

The tradeoff: too many intermediate predicates make a program hard
to follow. The rule of thumb is to factor out any concept that
*has a name* in the domain. "Is a manager" is a clear concept;
invent a predicate. "Is neither an executive nor an intern and has
over five years of tenure" might just be a body-of-a-rule.

## Keys, and enforcing them

The schema above says `id` is `employee`'s key "because other
predicates refer to it". That's a convention held in your head — the
declaration doesn't say it, and nothing stops a data file from
breaking it. **Integrity constraints** turn the convention into a
check the program enforces on every run.

A constraint is a predicate asserted to be empty. Write one as a rule
prefixed `error predicate`; its tuples are the counterexamples, so
give it arguments naming what went wrong:

```prolog
error predicate unknown_department_member(EmpId) :-
  in_department(EmpId, _), not employee(EmpId, _, _).
```

That's a **foreign key**: every `emp_id` in `in_department` must
resolve to an `employee`. It reads as the definition of a violation,
which is the whole trick — you don't state the invariant, you state
what it would mean to break it, and assert there is no such thing.
The negation is the same safe negation from
[Chapter 8](08-negation.md): `EmpId` is bound by the positive atom
before `not` narrows it.

A **primary key** takes one more thought. The obvious reading, "no
two rows share an id", can't be written directly — but remember set
semantics from [Chapter 1](01-facts-and-queries.md): two identical
rows *are* one row. So two tuples can only share an id if some other
column differs, and that is exactly what to look for:

```prolog
error predicate duplicate_employee_id(Id) :-
  employee(Id, N1, S1), employee(Id, N2, S2), N1 <> N2 || S1 <> S2.
```

Two atoms of the same predicate, joined on the key, requiring the
rest to disagree. This is not recursion — `duplicate_employee_id`
doesn't mention itself — so the linear-recursion restriction doesn't
apply and it runs on every backend.

> **Nullable columns behave here.** `<>` is null-aware, so
> `null <> "bob"` is true and a duplicate id where one row has a null
> name still gets flagged. Datamog has no second, three-valued
> inequality to reach for by mistake. See
> [Chapter 7](07-safety.md).

A **composite key** is the same shape: join on every key column, and
require some non-key column to differ. If `(emp_id, dept_id)` were the
key of a membership table carrying a `role`, that is:

```prolog
error predicate duplicate_membership(E, D) :-
  membership(E, D, R1), membership(E, D, R2), R1 <> R2.
```

Several rules for one constraint union their violations, which is how
you cover more than one way to break the same invariant:

```prolog
error predicate unknown_manages_party(Who) :-
  manages(Who, _), not employee(Who, _, _).
error predicate unknown_manages_party(Who) :-
  manages(_, Who), not employee(Who, _, _).
```

For a one-off assertion that doesn't deserve a name, `!-` takes a
conjunction directly, with the same implicit projection a `?-` query
has:

```prolog
!- manages(M, M).           # nobody manages themselves
```

### What happens when one fails

Constraints are checked at their fixed point, after everything is
evaluated and **before any output is produced**. Every violated
constraint is reported, with its counterexample rows:

```
hr.dl: Constraint 'duplicate_employee_id' is violated by 1 row:
  Id = 2
Constraint 'unknown_manages_party' is violated by 1 row:
  Who = 7
```

And then nothing else — no query results at all, and a non-zero exit
status. That's deliberate: results derived from data the program
itself declares invalid are worse than no results, because they look
fine. It also makes constraints useful in a pipeline, where the exit
status is what a build step checks.

Two habits worth forming. **Put the witness in the head.** A nullary
`error predicate bad()` tells you only that something is wrong;
`bad(Id)` tells you which row, which is the difference between a
report you can act on and one you have to investigate. **Constrain
the EDBs, not just the IDBs.** The invariants most worth stating are
the ones about data arriving from outside, since that's the data you
don't control.

### One caveat: nullable references

Suppose the schema had taken the other route and given `employee` a
nullable `mgr` column. An optional reference needs the null case
excluded explicitly, or "absent" reads as "dangling":

```prolog
input predicate employee(id: integer, name: string, mgr: integer?).

error predicate dangling_manager(Id, M) :-
  employee(Id, _, M), M <> null, not employee(M, _, _).
```

Without `M <> null`, every employee with no manager is reported as a
violation. The better fix is usually further upstream, and it's the
first bullet of this chapter: model "has a manager" as a separate
relation that simply omits the row, the way `manages` does, and the
question never arises.

## Recursion inside a domain model

`reports_to` is a recursive IDB with a clear domain meaning:
"transitively, who do you report up to?". It's safe to introduce
recursion in the middle of a schema as long as you remember the
rules from Chapter 4:

- One base case, at least one recursive step.
- Linear recursion only on the SQL backends (each recursive body
  mentions the predicate once). The `native` and `seminaive`
  evaluators accept non-linear recursion too, so it's a backend
  restriction rather than a language restriction.
- The recursion must be monotone (no `not reports_to(...)` in a
  rule for `reports_to`).

If you need something that feels like negation inside the
recursion, define the negated concept at a different stratum (as
we do with `is_manager` → `ic`).

## Aggregation on top of recursion — the pattern

The `big_team_manager` definition is the canonical "aggregate over
a recursive closure" idiom:

```prolog
report_count(M, count(R)) :- reports_to(R, M).
output predicate big_team_manager(M) :- report_count(M, C), C >= 2.
```

Three strata: `manages` (EDB) → `reports_to` (recursive) →
`report_count` (aggregate) → `big_team_manager` (filter). Each
stratum reads only from strictly lower strata; each is either
monotone or non-recursive.

**[Open this program in the playground →](https://max-schaefer.github.io/datamog/#p=employee(1%2C%20%22alice%22%2C%20120000).%0Aemployee(2%2C%20%22bob%22%2C%2095000).%0Aemployee(3%2C%20%22carol%22%2C%20110000).%0Aemployee(4%2C%20%22dave%22%2C%2085000).%0Aemployee(5%2C%20%22eve%22%2C%2075000).%0Aemployee(6%2C%20%22frank%22%2C%2090000).%0Ain_department(1%2C%2010).%0Ain_department(2%2C%2010).%0Ain_department(3%2C%2020).%0Ain_department(4%2C%2020).%0Ain_department(5%2C%2010).%0Ain_department(6%2C%2030).%0Amanages(1%2C%202).%0Amanages(1%2C%205).%0Amanages(3%2C%204).%0Amanages(3%2C%206).%0A%23%20Tutorial%2C%20chapter%2010%20%E2%80%94%20a%20small%20HR-style%20schema.%0A%0A%23%20---%20Keys%2C%20enforced%20---------------------------------------------------------%0A%23%20%60employee.id%60%20is%20the%20schema's%20primary%20key.%20Two%20rows%20can%20only%20share%20an%20id%20if%0A%23%20some%20other%20column%20differs%2C%20so%20that%20is%20exactly%20what%20to%20look%20for.%0Aerror%20predicate%20duplicate_employee_id(Id)%20%3A-%0A%20%20employee(Id%2C%20N1%2C%20S1)%2C%20employee(Id%2C%20N2%2C%20S2)%2C%20N1%20%3C%3E%20N2%20%7C%7C%20S1%20%3C%3E%20S2.%0A%0A%23%20%60in_department.emp_id%60%20and%20both%20columns%20of%20%60manages%60%20are%20foreign%20keys%20into%0A%23%20%60employee%60.%20Every%20reference%20must%20resolve.%0Aerror%20predicate%20unknown_department_member(EmpId)%20%3A-%0A%20%20in_department(EmpId%2C%20_)%2C%20not%20employee(EmpId%2C%20_%2C%20_).%0A%0Aerror%20predicate%20unknown_manages_party(Who)%20%3A-%0A%20%20manages(Who%2C%20_)%2C%20not%20employee(Who%2C%20_%2C%20_).%0Aerror%20predicate%20unknown_manages_party(Who)%20%3A-%0A%20%20manages(_%2C%20Who)%2C%20not%20employee(Who%2C%20_%2C%20_).%0A%0A%23%20Nobody%20manages%20themselves.%20A%20one-off%20assertion%2C%20so%20it%20needs%20no%20name.%0A!-%20manages(M%2C%20M).%0A%0A%23%20Anyone%20who%20manages%20someone.%0Ais_manager(M)%20%3A-%20manages(M%2C%20_).%0A%0A%23%20Transitively%3A%20employees%20who%20report%20up%20(directly%20or%20indirectly)%0A%23%20to%20a%20given%20manager.%0Areports_to(R%2C%20M)%20%3A-%20manages(M%2C%20R).%0Areports_to(R%2C%20M)%20%3A-%20manages(M%2C%20X)%2C%20reports_to(R%2C%20X).%0A%0A%23%20An%20individual%20contributor%20has%20no%20reports.%0Aic(E)%20%3A-%20employee(E%2C%20_%2C%20_)%2C%20not%20is_manager(E).%0A%0A%23%20Head%20count%20per%20department.%0Aoutput%20predicate%20head_count(Dept%2C%20count(E))%20%3A-%20in_department(E%2C%20Dept).%0A%0A%23%20A%20%22big%20team%22%20manager%20is%20one%20who%20directly%20or%20indirectly%20manages%0A%23%20at%20least%202%20reports.%20Two%20strata%3A%20compute%20report_count%20first%2C%0A%23%20then%20filter.%0Areport_count(M%2C%20count(R))%20%3A-%20reports_to(R%2C%20M).%0Aoutput%20predicate%20big_team_manager(M)%20%3A-%20report_count(M%2C%20C)%2C%20C%20%3E%3D%202.%0A%0A%3F-%20ic(E).%0A)**

This separation is why the pattern works, and why you should reach
for it every time a problem asks "how many X satisfy some recursive
property".

## Using `--dry-run` as a debugger

When a rule produces the wrong answer, the first thing to do is
run `--dry-run` and read the generated SQL. Common things you'll
spot:

- A rule that looks like "join this predicate on this variable"
  turns into a `CROSS JOIN` instead — the variable isn't actually
  shared across two atoms the way you thought. Look for your
  `WHERE` conditions in the generated SQL; if they aren't there,
  the variables aren't aliased.
- A rule that should filter produces all rows anyway — the
  comparison got optimised away because one side of an equality
  collapsed to a constant. Look at what's going into the
  `WHERE`.
- A recursive view compiles to `SELECT DISTINCT ... FROM "x"`
  instead of `WITH RECURSIVE` — it's no longer seen as recursive,
  maybe because one of the rules got deleted or its head doesn't
  match.

Every Datalog programmer develops a reflex of running `--dry-run`
when something looks off. The extra 30 seconds often save 30
minutes.

## A brief word on performance

This tutorial is not a performance guide, but a few rules of
thumb worth knowing once you're building something non-trivial:

- **Indices.** Datamog's SQL backends inherit indices from the
  underlying database. For Postgres, add indices on the columns
  you join on heavily; for SQLite, indices matter but Datamog
  doesn't create them for you (the EDB declarations
  only say "the column exists", not "the column is indexed").
- **Recursion width.** Recursive views are expensive because each
  iteration materialises intermediate rows. Datamog's `seminaive`
  backend implements seminaive evaluation directly; the SQL
  backends rely on whatever their `WITH RECURSIVE` engine does
  (Postgres optimises toward seminaive-style delta joins
  internally). Beyond that, consider factoring the recursion or
  constraining its input.
- **Aggregates.** Aggregates read every row in their group. If
  you find yourself computing an aggregate over a million-row
  predicate and using only the aggregate's value once,
  restructure so the aggregate runs over a smaller set.

## Recap

- EDB for boundary data, IDB for derived data. Flatten instead of
  nest; prefer separate predicates over nullable columns for optional
  relationships.
- Factor named concepts into separate IDBs; inline unnamed ones.
- State a schema's key invariants as constraints rather than leaving
  them a convention. A foreign key is `not` over the referenced
  predicate; a primary key joins the predicate to itself on the key
  and requires the rest to differ (with `<>`, which is null-aware). Put the
  offending values in the constraint's head — those are what a
  violation reports.
- A violated constraint suppresses every output and exits non-zero,
  so constraints are what makes a Datamog run safe to use in a
  pipeline.
- Aggregate-over-recursion is a three-stratum pattern (recursive
  IDB → aggregate IDB → filter).
- `--dry-run` is a debugger — read the generated SQL when things
  look wrong.

## Exercises

### Exercise 10.1 — Port a schema ★★

Starter: [`code/ch10/ex1-schema/`](code/ch10/ex1-schema/)

A small library schema is given: `book(id, title, author_id)`,
`author(id, name, country)`, `checkout(book_id, borrower_id,
date)`. Add Datalog rules for:

- `available(Book)` — books not currently checked out (careful:
  use negation on the current-checkout relation);
- `local_author(Author)` — authors from a country passed in via a
  parameter;
- `most_borrowed(Book, count(Ev))` — aggregate over checkouts.

### Exercise 10.2 — Shrink to fit ★★

Take the `hr.dl` program and see which of its intermediate
predicates you can inline *without* hurting readability. Where's
the line? Write ~100 words comparing the inlined vs. factored
forms — see
[`solutions/ch10/ex2.md`](solutions/ch10/ex2.md) for one take.

### Exercise 10.3 — Read a strange answer ★★★

Starter: [`code/ch10/ex3-debug/`](code/ch10/ex3-debug/)

The starter contains a rule that produces surprising output. Use
`--dry-run` to figure out why, then fix it. (The bug is realistic
— it's one that catches people.)

---

Next: **[Chapter 11 — Search and puzzles](11-puzzles.md)**. We'll use every
ingredient so far (generate-and-test, negation, aggregation) to encode a
small logic puzzle — the kind of thing Datalog is surprisingly good at.
