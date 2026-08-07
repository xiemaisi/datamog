# Exam Answers: Introduction to Logic Programming with Datalog

**Marks**: 100 + 20 extra credit

---

## Question 1 — Checking a Sudoku [26+5]

**(a)** [8]

  - `⟨1⟩`: `not grid(R, _, N)`
  - `⟨2⟩`: `not grid(_, C, N)`
  - `⟨3⟩`: `not in_box(B, N)`

**(b)** [4]: `⟨4⟩`: `missing(_)`

**(c)** [5 **optional**] For a correct grid, the query evaluates to `{()}` (printed as `yes` in Datamog). For an incorrect grid, the query evaluates to `{}` (printed as `no` in Datamog).

**(d)** [14] The program is not recursive, so it is trivially stratifiable.

---

## Question 2 — Greatest common divisor [42+5]

**(a)** [12]

  - `⟨1⟩`: `num(A)`
  - `⟨2⟩`: `A - B`
  - `⟨3⟩`: `B - A`

**(b)** [16] For safety: `A` is a head variable, and hence must appear at least once as a direct argument in a positive predicate atom (like `num(A)`) or in an equality (but there are no equalities here).

**(c)** [4]

  `num(2). num(4). num(6).`

**(d)** [10]

  | round | `gcd` |
  | --- | --- |
  | 0 | `{}` |
  | 1 | `{ (2, 2, 2), (4, 4, 4), (6, 6, 6) }` |
  | 2 | `{ ..., (4, 2, 2), (2, 4, 2) }` |
  | 3 | `{ ..., (6, 2, 2), (2, 6, 2), (6, 4, 2), (4, 6, 2) }` |

**(e)** [5 **optional**] Round 4 does not add any new tuples and hence reaches the fixed point.

---

## Question 3 — Perfect numbers [32+0]

**(a)** [9] `N % D = 0`

**(b)** [9] `sum(D)`

**(c)** [14] `sum_divisor(N, N)`

---

## Extra credit [0+10]

Yes; the rule for `p` is safe and there is no negation, so stratification is not an issue. `p` evaluates to the empty set.