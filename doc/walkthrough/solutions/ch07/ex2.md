# Exercise 7.2 — Type errors

- **(a)** `emp(name: string, salary: integer)`, then
  `S2 = S + 0.10`. `S` is `integer`; `0.10` is `float`. The
  addition widens to `float`, so `S2` is `float`. The head
  `raise(N, S2)` has columns (`string`, `float`). **Accepted** —
  the tolerated numeric widening.

- **(b)** `both(X) :- a(X), b(X).` — the same variable `X` is
  being unified with `integer` (from `a`) and `string` (from `b`).
  These can't unify (a variable meet). **Rejected** with
  `Variable 'X' has conflicting types 'integer' and 'string'`.

- **(c)**
  - `expensive(X) :- item(X, P), P > 100.` — `P` is `float`,
    compared against literal `100` (integer, widened to float).
    **Accepted.**
  - `labelled(X) :- item(X, P), P > "threshold".` — `P` is
    `float`, compared against `string`. **Rejected** as incompatible
    comparison types.

Two sub-rules for the same predicate stack into one column, which takes
the *join* of their contributions. If you named both rules `expensive`,
its head column would combine one rule's `float` with the other's
`string` and widen to `value` (their least upper bound), not conflict.
Only a shared variable *within a single rule*, as in (b), can fail to
unify.
