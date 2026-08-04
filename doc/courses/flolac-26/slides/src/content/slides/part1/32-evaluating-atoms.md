---
title: "Evaluating atoms"
kind: content
section: "From Rules to Answers"
tight: true
---

An **atom** is either
- a **predicate atom** (a predicate applied to expressions, like `even(N)`), or
- a **comparison** of two expressions (`=`, `<>`, `<`, `>`, `<=`, `>=`).

They differ in how they are evaluated:
- A **predicate atom** is matched against that predicate's relation: variables are **bound** to the matching values, while constants and the don't-care `_` only filter.
  - `num(N)` → `N ∈ {1, 2, 3, 4, 5, 6}`
  - `even(N)` → `N ∈ {2, 4, 6}`
  - `divisor(_, 6)` succeeds, `divisor(_, 5)` fails; `_` and the constant bind nothing
- A **comparison** is a **test** on already-bound values: `D > 1` holds exactly when `D` exceeds 1.
