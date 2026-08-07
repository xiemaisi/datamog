# Chapter 9 — Aggregates

Negation lets you say "not in a set". Aggregation lets you say
"how many", "what's the total", "what's the largest". Both are
non-monotone — add facts, and a `count` can go up, an `avg` can
shift, a `min` or `max` can change — which means both need the
same stratification discipline, and neither can live inside
recursion.

Aggregates are Datamog's way of doing anything statistical. They
are spelled as function calls in the rule head, and they cause the
non-aggregate head arguments to become group-by columns
automatically.

## The seven aggregates

Datamog supports seven aggregate functions: `count`, `sum`, `avg`,
`min`, `max`, `concat`, and `list`. From
[`code/ch09/aggregates.dl`](code/ch09/aggregates.dl):

```prolog
input predicate scores(student: string, subject: string, score: integer).

student_avg(Student, avg(Score)) :- scores(Student, _, Score).

best(Student, max(Score)) :- scores(Student, _, Score).

num_subjects(Student, count(Subject)) :- scores(Student, Subject, _).

total(count(*)) :- scores(_, _, _).
```

Running it gives what you'd expect: `student_avg` has one row per
student with their average across the three subjects; `best` has
the max; `num_subjects` counts 3 for everyone (each student took
three subjects); `total` is a single row with 12 — the total number
of records.

**[Open this program in the playground →](https://max-schaefer.github.io/datamog/#p=scores(%22alice%22%2C%20%22math%22%2C%2092).%0Ascores(%22alice%22%2C%20%22science%22%2C%2088).%0Ascores(%22alice%22%2C%20%22english%22%2C%2095).%0Ascores(%22bob%22%2C%20%22math%22%2C%2078).%0Ascores(%22bob%22%2C%20%22science%22%2C%2085).%0Ascores(%22bob%22%2C%20%22english%22%2C%2072).%0Ascores(%22carol%22%2C%20%22math%22%2C%2096).%0Ascores(%22carol%22%2C%20%22science%22%2C%2091).%0Ascores(%22carol%22%2C%20%22english%22%2C%2089).%0Ascores(%22dave%22%2C%20%22math%22%2C%2065).%0Ascores(%22dave%22%2C%20%22science%22%2C%2070).%0Ascores(%22dave%22%2C%20%22english%22%2C%2080).%0A%23%20Tutorial%2C%20chapter%209%20%E2%80%94%20aggregates.%0A%0A%23%20Average%20score%20per%20student.%20Non-aggregate%20head%20variable%20%60Student%60%0A%23%20becomes%20the%20GROUP%20BY%20column%3B%20the%20aggregate%20%60avg(Score)%60%20fills%20the%0A%23%20second%20column.%0Astudent_avg(Student%2C%20avg(Score))%20%3A-%20scores(Student%2C%20_%2C%20Score).%0A%0A%23%20Highest%20score%20per%20student.%0Aoutput%20predicate%20best(Student%2C%20max(Score))%20%3A-%20scores(Student%2C%20_%2C%20Score).%0A%0A%23%20Number%20of%20subjects%20each%20student%20took.%0Aoutput%20predicate%20num_subjects(Student%2C%20count(Subject))%20%3A-%20scores(Student%2C%20Subject%2C%20_).%0A%0A%23%20Total%20records%20%E2%80%94%20count(*)%20means%20%22count%20the%20rows%22%2C%20like%20COUNT(*).%0Aoutput%20predicate%20total(count(*))%20%3A-%20scores(_%2C%20_%2C%20_).%0A%0A%3F-%20student_avg(S%2C%20A).%0A)**

### The grouping rule

When an aggregate appears in a rule head, the **non-aggregate
head arguments become the `GROUP BY` columns**. In the
`student_avg` rule, the head is `student_avg(Student, avg(Score))`;
`Student` is a plain variable, `avg(Score)` is an aggregate, so
the implied grouping is "one row per distinct value of
`Student`".

This is the same mental model as SQL's `SELECT student,
AVG(score) FROM scores GROUP BY student` — the implicit `GROUP BY`
is determined by which columns in the `SELECT` list aren't inside
an aggregate function.

Two refinements of that rule are worth knowing.

**A constant argument is not a grouping column.** A literal, or a
variable the body binds to one, does not vary per group, so it is
carried along rather than grouped by:

```prolog
totals("all", count(*)) :- scores(_, _, _).
totals(G, count(*)) :- scores(_, _, _), G = "all".   # the same rule
```

You notice the difference only over empty input. A rule with no
grouping columns still derives one row there, matching SQL's
`SELECT COUNT(*) FROM <empty>`: every `count` is `0` and every other
aggregate is `NULL`. A rule that does group derives nothing, there
being no group to reduce.

**An aggregate can sit inside an expression.** It does not have to be
the whole argument, so a rank counted from one becomes a 0-based index
without a second predicate:

```prolog
var_index(Name, count(Other) - 1) :- varname(Name), varname(Other), Other <= Name.
```

The argument is a grouping column exactly when it contains no
aggregate, so `Name` groups and the second argument does not. One
rule comes with it: beside an aggregate you may mention only grouping
variables, since anything else has no single value within the group.
`bad(X, sum(S) + Y) :- scores(X, S, Y).` is rejected for that reason.

### Naming a head argument

When one value is wanted twice, or when something outside the
expression needs to refer to the column it computes, give the
argument a name with `as`:

```prolog
p(count(*) as N, N + 1) :- q(_).
```

The name belongs to the head alone: it is invisible below the `:-`,
so it cannot collide with a body variable, and order does not matter,
`p(N + 1, count(*) as N)` deriving the same thing. It is the
intensional counterpart of the column names an `input predicate`
declaration already gives its columns.

### `count(*)` is `COUNT(*)`

The special form `count(*)` counts rows without caring about a
specific column. It compiles to SQL's `COUNT(*)`. `count(X)` where
`X` is a regular variable compiles to `COUNT("x")`, which counts
only non-`NULL` values — for normal Datalog programs over non-null
data the two are equivalent, but the `count(*)` form is the
idiomatic way to ask "how many".

### `concat` for textual aggregation

`concat(W)` concatenates textual values in a group with a
fixed `,` separator:

```prolog
subjects_of(Student, concat(Subject)) :-
    scores(Student, Subject, _).
```

produces rows like `("alice", "math,science,english")`. The
separator is always `,`; Datamog's SQL dialect emits
`GROUP_CONCAT(..., ',')` on SQLite/sql.js and `STRING_AGG(..., ',')`
on Postgres.

### `list` for list-comprehension-style aggregation

`list(X)` collects values into an array `value` — the closest the
language gets to a list comprehension. Primitive arguments are
auto-lifted (numbers become numeric leaves, strings string leaves,
booleans `true` / `false` leaves), so the simplest form just
collects a column directly:

```prolog
all_scores(Student, list(Score)) :- scores(Student, _, Score).
```

`all_scores` is one row per student, second column an array
`value` of integers — every score that student earned.

For richer per-element shapes, build the value in a non-aggregate
rule (an object or array literal) and then aggregate it:

```prolog
records(Student, {"subject": Subject, "score": Score}) :-
    scores(Student, Subject, Score).

all_records(Student, list(R)) :- records(Student, R).
```

Now each row's second column is an array `value` of
`{"subject": ..., "score": ...}` objects.

Per-element order depends on the argument's type:

- **Primitive arguments** sort by their natural value — numeric
  for numbers, lex for strings, false-before-true for booleans
  (matching SQL's `ORDER BY` on the raw column).
- **`value` arguments** sort by their canonical-text form (object
  keys sorted, no whitespace). Backends agree because the
  canonical form is the one structure they all preserve.

SQL `NULL` inputs are skipped, and an all-`NULL` or empty group
yields `NULL` — matching `concat` and the rest of the family.

Pair `list` with chapter 14's destructuring (`X[0]`,
`object_entry`) to round-trip relational data through structured
payloads.

## Restrictions on aggregate rules

A predicate with an aggregate rule must obey two extra constraints:

1. **Cannot be recursive.** A predicate that uses an aggregate can
   not appear (positively or negatively) in its own rule body, nor
   in a cycle through any other predicate. The reason mirrors
   negation: aggregation is not monotone, so it can't coexist with
   fixed-point iteration.
2. **Consistent aggregate positions across rules.** If the
   predicate has multiple rules (which is unusual for aggregates,
   but allowed), they must all use an aggregate in the same head
   position, and the same aggregate function. `num(Student,
   count(S))` in one rule and `num(Student, sum(S))` in another
   would be rejected.

Datamog enforces both at analysis time, and will print a targeted
error rather than generate silently-wrong SQL.

## Filter after aggregate

A pattern you'll reach for a lot: compute an aggregate, then
filter by it. For instance, "students whose worst subject score
is still above 80":

```prolog
worst_score(Student, min(Score)) :- scores(Student, _, Score).

strong(Student) :- worst_score(Student, W), W > 80.
```

The `strong` rule is an ordinary non-aggregate rule that *reads*
`worst_score` — that IDB is already computed and appears in the
dependency graph as a predicate `strong` can use. No special
syntax; stratification handles the ordering.

> **Logic lens.** Aggregation sits outside pure Horn-clause
> Datalog in exactly the same way negation does: both are
> non-monotone operators. The standard move is to treat an
> aggregate rule as a monotone-plus-projection operation at a
> higher stratum — essentially, "compute the ungrouped relation
> exactly, then apply the aggregate". That's why aggregates
> can't be recursive: they'd break the monotonicity that
> fixed-point iteration relies on. Stratification lets them
> coexist with recursion elsewhere in the program, as long as
> the recursion and the aggregation sit in different layers.

> **SQL lens.** Aggregates compile almost directly:
>
> ```sql
> CREATE OR REPLACE VIEW "student_avg" AS
>   SELECT __b0."student" AS col1,
>          AVG(__b0."score") AS col2
>   FROM "scores" AS __b0
>   GROUP BY __b0."student"
> ;
> ```
>
> The implicit `GROUP BY student` matches the "non-aggregate head
> variables become grouping columns" rule exactly. `count(*)`
> becomes `COUNT(*)` with no `GROUP BY` at all (single-row
> result). The interesting cases are `concat` and `list`,
> which both pick different spellings across backends —
> `GROUP_CONCAT(expr, ',' ORDER BY expr)` and
> `JSON_GROUP_ARRAY(json(expr) ORDER BY expr)` on SQLite / sql.js,
> `STRING_AGG(expr::TEXT, ',' ORDER BY expr)` and
> `JSONB_AGG(expr ORDER BY expr::TEXT)` on Postgres — and
> Datamog's dialect interface picks the right one. The explicit
> `ORDER BY` is what makes the per-group output deterministic and
> identical across every backend.

> **Imperative lens.** In Python, aggregation looks like this:
>
> ```python
> from collections import defaultdict
> from statistics import mean
>
> by_student = defaultdict(list)
> for (student, _, score) in scores:
>     by_student[student].append(score)
>
> student_avg = {s: mean(xs) for s, xs in by_student.items()}
> best       = {s: max(xs)  for s, xs in by_student.items()}
> num_subj   = {s: len(xs)  for s, xs in by_student.items()}
> ```
>
> Three passes, one per aggregate, each re-iterating the
> grouped data. Datalog's form is the same idea, with the engine
> deciding the grouping structure and re-use on your behalf. It
> also composes: defining `strong` as "students whose `min`
> is > 80" is one extra rule in Datalog, whereas in Python you'd
> write either a nested comprehension or another pass over the
> `by_student` dict.

## Recap

- Aggregates — `count`, `sum`, `avg`, `min`, `max`,
  `concat`, `list` — go in the rule head. The non-aggregate
  head arguments become the implicit group-by columns.
- `list` collects `value`s into an array `value`; build the
  per-row `value` in a non-aggregate rule, then aggregate it.
  This is the language's list-comprehension idiom.
- `count(*)` is `COUNT(*)`; other aggregates take a specific
  column expression.
- Aggregate predicates can't be recursive, and (for multi-rule
  predicates) all rules must agree on aggregate positions and
  functions.
- Filtering by an aggregate is done in a second, downstream rule
  that reads the aggregate predicate as a plain IDB —
  stratification handles the order.
- Through all three lenses, aggregation is "compute the
  ungrouped relation, then reduce each group" — no special
  machinery beyond what stratification already provides.

## Exercises

### Exercise 9.1 — Simple counts ★

Starter: [`code/ch09/ex1-counts.dl`](code/ch09/ex1-counts.dl)

Given `scores(student, subject, score)`, define:

- `subject_count(Subject, count(*))` — number of students who
  took each subject;
- `total_students` — how many distinct students appear (hint:
  `count(Student)` would count one row per record, so collect the
  students into their own relation first, then `count(*)`);
- `perfect_scores(count(*))` — number of rows with `score = 100`.

### Exercise 9.2 — Ranks via filtering ★★

Starter: [`code/ch09/ex2-ranks.dl`](code/ch09/ex2-ranks.dl)

Define:

- `avg_by_subject(Subject, avg(Score))`;
- `top_subject(Subject)` — subjects whose average is above 83.

You'll need the two-step pattern from this chapter: aggregate
first, filter in a second rule.

### Exercise 9.3 — Why can't aggregates recurse? ★★

Consider this program:

```prolog
tree_size(Node, count(Child)) :- child(Node, Child).
tree_size(Node, count(Child)) :-
    child(Node, Sub), tree_size(Sub, _), Child = "?".
```

Predict what Datamog will do. Explain in your own words why the
"size of a subtree" is a natural recursion but can't be expressed
as an aggregate + recursion in stratified Datalog. What would a
correct tree-size definition look like? (Hint: two rules, no
aggregate in the recursive one; then a second aggregate predicate
on top.)

### Exercise 9.4 — Read the SQL ★★

Starter: [`code/ch09/ex4-sql.dl`](code/ch09/ex4-sql.dl)

Run `--dry-run` on the starter and identify, in the generated SQL:

1. Which view contains the `GROUP BY`?
2. How does `count(*)` compile on your chosen backend?
3. How does `concat(...)` compile on Postgres vs. SQLite / sql.js?

### Exercise 9.5 — Min / max / avg all at once ★★

Starter: [`code/ch09/ex5-summary.dl`](code/ch09/ex5-summary.dl)

Define a summary predicate `subject_stats(Subject, min(Score),
avg(Score), max(Score))` in a single rule. Datamog does accept
multiple aggregates in one head; predict the SQL before running
`--dry-run` to confirm.

---

This finishes the "language-proper" tour. Part IV — **[Chapter 10 —
Modelling with Datalog](10-modelling.md)** onwards — zooms out to
how you'd actually design a Datalog program, from schema choices through
"when to split into predicates" to worked case studies in program
analysis and graph algorithms.
