# Appendix A — The three lenses cheat sheet

A side-by-side mapping of Datalog syntax to each of the three
views we've developed across the tutorial.

## Atoms, rules, and predicates

| Datalog               | Logic (FOL)                       | SQL                              | Python                           |
| --------------------- | --------------------------------- | -------------------------------- | -------------------------------- |
| `p(a, b).`            | `p(a, b)` — atomic formula        | row `(a, b)` in table `p`        | `p.append((a, b))`               |
| `p(X, Y)` (body atom) | positive atom in rule body        | `FROM p` alias                   | iteration over `p`               |
| `h(X) :- b1, b2.`     | `∀X. (b1 ∧ b2) → h(X)`            | `CREATE VIEW h AS SELECT ...`    | `def h(): return [X for ...]`    |
| `?- q(X).`            | `∃X. q(X)` (with witness)         | `SELECT DISTINCT * FROM q`       | `list_of_rows_satisfying(q)`     |
| `input predicate e(...).` | base relation / EDB               | `CREATE TABLE e`                 | initial data list                |
| two rules, same head  | ∨ at predicate level              | `UNION` inside the view          | two loops, results concatenated  |

## Variables

| Datalog            | Logic                                | SQL                       | Python                       |
| ------------------ | ------------------------------------ | ------------------------- | ---------------------------- |
| `X` (uppercase)    | universally-quantified variable      | `SELECT` column alias     | loop variable                |
| `_` (don't-care)   | existentially-quantified / anonymous | `SELECT` with col ignored | `_` (same convention)        |
| shared `X` in body | unification (same value)             | `WHERE a.c1 IS NOT DISTINCT FROM b.c2` | `if x1 == x2:` in the loop   |
| constant `"s"`     | ground term                          | `WHERE col = 's'`         | `if x == "s":`               |

## Recursion, negation, aggregation

| Datalog                       | Logic                                  | SQL                                       | Python                                   |
| ----------------------------- | -------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| recursive predicate           | least fixed point of `Tₚ`              | `WITH RECURSIVE`                          | worklist / seminaive loop                |
| mutually recursive predicates | shared least fixed point / SCC         | multi-CTE `WITH RECURSIVE` (or combined)  | interleaved worklists                    |
| `not p(X)`                    | negation-as-failure / closed world     | `NOT EXISTS (...)` / anti-join            | `x not in p`                             |
| stratified program            | stratified model                       | view creation in topological order        | per-stratum loop in dependency order     |
| `count(X)` / `sum(X)` in head | set cardinality / sum                  | `GROUP BY` + aggregate function           | `len(group)` / `sum(group)` per key      |
| `count(*)`                    | cardinality                            | `COUNT(*)`                                | `len(...)`                               |
| aggregate + recursion         | *not in Horn-clause Datalog*           | (rejected by analyser: "Aggregate predicate ... cannot be recursive") | would need a "compute then aggregate" loop |

## Expressions and built-ins

| Datalog                        | Logic / math                                | SQL                                         | Python                                   |
| ------------------------------ | ------------------------------------------- | ------------------------------------------- | ---------------------------------------- |
| `X + Y` (integers)             | `+` on integers                             | `"X" + "Y"`                                 | `X + Y`                                  |
| `X + Y` (string, at least one)   | string concat                               | `"X" \|\| "Y"`                                | `X + Y`                                  |
| `X / Y` (integers)             | integer division                            | `/` (truncating on every shipped backend)   | `X // Y`                                 |
| `X % Y`                        | modulo                                      | `%` (divide-by-zero has no value)           | `X % Y`                                  |
| `X in [lo .. hi]`              | `X ∈ {lo, lo+1, ..., hi}`                   | `generate_series(lo, hi)` or recursive CTE  | `for X in range(lo, hi+1):`              |
| `length(W)`, `W[i]`, `W[i:j]`  | string operations                           | dialect-specific functions                  | `len(W)`, `W[i]`, `W[i:j]`               |
| `J["k"]`, `J[i]`, `object_entry(J, K, V)`, `as_string(J)` | `value` destructuring                       | `json_extract` / `jsonb_each` / `jsonb_typeof` | `J["k"]`, `J[i]`, `J.items()`, `str(J)`   |

## Safety and typing

| Datalog concept            | Logic view                    | SQL view                                    |
| -------------------------- | ----------------------------- | ------------------------------------------- |
| safety (every head var bound) | domain independence           | guarantees a finite `FROM` clause           |
| column types (`string`/`integer`/`float`/`boolean`/`value`/`null`) | single-sorted model | standard SQL column types                   |
| `integer → float` widening  | numerical embedding           | implicit cast / `CAST AS REAL`              |
| `x: integer?`               | the column's domain is the integers plus one more value | nullable column (no `NOT NULL`) |
| a partial expression (`10 / X`) | ⊥: no value at all, so no tuple | `NULL` plus a definedness guard that drops the row |
| `_: Y > X` (refinement)     | a proposition the predicate guarantees | a `SELECT` that must return no rows |

## Part V concepts

| Datalog                     | Logic                                  | SQL                                        |
| --------------------------- | -------------------------------------- | ------------------------------------------ |
| `p(...) :: Ctor`            | a named rule is a proof constructor (Curry-Howard) | an extra JSON column holding the derivation |
| `V : p(...)`                | capture the proof term as a value      | select that JSON column                     |
| `:= from "m.dl"(...)`       | a file as a function from its inputs to its outputs | the module's views, freshened per instance |
| module `!-` law             | an axiom the instance must satisfy     | a `SELECT` run per instance                 |
| `bad^(E)` (maximal)         | the anti-monotone side of an even-parity recursion | no translation: needs a loop that can delete |

## What each lens is best at

- **Logic lens** — understanding what a program *means*, why it
  terminates, and why certain restrictions (linearity,
  stratification) are there.
- **SQL lens** — debugging a surprising answer (`--dry-run` is
  your friend), understanding performance, integrating with
  existing database infrastructure.
- **Imperative lens** — explaining Datalog to someone coming from
  mainstream programming, estimating how much code Datalog is
  "saving" you, and spotting where Datalog *isn't* a good fit.
