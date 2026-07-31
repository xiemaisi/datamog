# Postgres backend alignment

Every backend is meant to compute the same answer for the same program. Running
the example suite on Postgres (`packages/cli/test/examples.test.ts`, gated on
`DATABASE_URL`) showed that it does not. This note records what diverges, why,
and what a fix would take. Findings were checked against PostgreSQL 16.13.

Of the 21 examples that failed when the block was first added, 10 are fixed
(see *Numeric result columns*), 1 is inherent, and 10 remain. The remaining ones
are listed in `POSTGRES_KNOWN_FAILURES` and marked `test.failing`, so the suite
stays green and a fix forces the entry's removal.

## Only one recursive term, referenced once

8 examples: bridge-crossing, collatz, grammar, hanoi, jugs, mutual-exclusion,
petri-net, river-crossing.

A predicate with more than one recursive rule emits

```sql
WITH RECURSIVE "chain"(col1, col2) AS (
  <base>          -- chain(N, N, 0) :- seed(N).
  UNION
  <recursive 1>   -- halve an even value
  UNION
  <recursive 2>   -- treble an odd one
)
```

Postgres rejects it with `recursive reference to query "chain" must not appear
within its non-recursive term`. `A UNION B UNION C` parses as `(A UNION B) UNION
C`, so the non-recursive term is `(base UNION recursive 1)`, which references the
CTE.

Reordering the rules does not help, and neither does parenthesising: with
`base UNION (recursive 1 UNION recursive 2)` the split is right and Postgres then
reports `recursive reference to query "chain" must not appear more than once`. It
allows exactly one recursive term containing exactly one reference to the CTE.
SQLite accepts the flat multi-branch form, which is why every one of these
examples passes there.

A `LATERAL` encoding satisfies both restrictions, verified directly:

```sql
WITH RECURSIVE t(n) AS (
  SELECT 1
  UNION
  SELECT s.m FROM t, LATERAL (
    SELECT t.n + 1 AS m WHERE t.n < 5
    UNION
    SELECT t.n + 10 AS m WHERE t.n < 3
  ) s
) SELECT * FROM t;          -- 1,2,3,4,5,11,12, which is correct
```

The CTE is named once, in `FROM t`; each recursive rule becomes a branch of the
`LATERAL` subquery, reading the previous iteration through `t`'s columns rather
than through another mention of `t`. Recursion in Datamog is linear, checked by
the analyzer, so every recursive rule has exactly one recursive body atom and
this shape always applies. The rest of a rule's body joins inside the subquery.

This is a real change to `createRecursiveView` in the Postgres dialect: rules
have to be split into base and recursive sets, and each recursive rule
re-projected against `t`'s columns instead of an aliased self-join.

## Mutual recursion

2 examples: mutual-recursion, parity.

`mutual recursion between WITH items is not implemented` — Postgres has never
supported two `WITH` items referencing each other, so the multiple-CTE shape the
dialect emits cannot work. Documented in `doc/spec.md` 6.5.

The fix is SQLite's encoding: one CTE for the whole SCC with a `__tag`
discriminator, then a non-recursive view per predicate filtering by tag. That
CTE will have one recursive branch per rule across the SCC, so it runs into the
restriction above and needs the `LATERAL` treatment too. **Unverified**: no
experiment was run on a tagged CTE under Postgres. Do that before committing to
the approach, since a tag column also has to satisfy the anchor/recursive type
agreement described next.

## Anchor and recursive column types must agree

1 example: proof-term-fold.

`recursive query "list_sum" column 2 has type integer in non-recursive term but
type bigint overall`. The base case projects an `integer` literal; the recursive
term sums, and Postgres types `sum(integer)` as `bigint`. SQLite is untyped
enough not to care.

Fixable by casting the anchor's columns to the type the recursion settles on.
`analyzed.columnTypes` gives Datamog's own type, but not the SQL type Postgres
will infer for an aggregate, so the cast has to be driven from the emitted
expression rather than from the Datalog type. Casting every `integer` anchor
column to `BIGINT` would work and is blunt; it also interacts with the numeric
coercion below, which is what keeps that from being visible to users.

## Numeric result columns (fixed)

10 examples: aggregates, flights, guardians, integrity-constraints, json-events,
map-colouring, n-queens, parse-json, primitive-conversions, shannon-entropy.

`Bun.sql` returns `BIGINT` and `NUMERIC` as JS strings, so that values too large
for a double are not silently rounded. `count(*)` therefore arrived as `"4"`
where every other backend gives `4` — a wrong answer rather than an error, and
so the worst of the four classes.

`coerceNumericColumns` in `engine/src/result-coerce.ts` now converts at columns
whose declared type is `integer` or `float`, alongside the existing boolean and
`value` coercions, and is applied to constraint rows as well as query rows.
Magnitudes above `Number.MAX_SAFE_INTEGER` lose precision in the conversion,
which is inherent in having one result shape: the interpreters compute in JS
numbers, so no backend was exact up there.

## Last-bit float differences (inherent)

shannon-entropy's entropy sum comes out as `2.0403733936884962` against
SQLite's `2.0403733936884967`. Floating-point addition is not associative and
`LN` is not specified to the ulp, so a 1-ulp difference across two engines is
expected. It stays listed rather than being hidden behind a float tolerance on
every other example's comparison.

## Not Postgres: sql.js

For contrast, sql.js diverges in exactly one place. Its stock SQLite WASM build
omits the math extension `bun:sqlite` enables, so `LN` is missing, which takes
out `ln` and `**` (whose overflow guard is `EXP(exp * LN(base))`). `SQRT`,
`EXP`, `ABS`, and `ROUND` are all present. Note also that sql.js defines `LOG`
as the natural logarithm where SQLite's extension makes it base 10; nothing
emits `LOG` today, so that one is a trap for later rather than a current bug.
