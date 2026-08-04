---
title: "Safety and binding"
kind: content
section: "From Rules to Answers"
tight: true
---

A variable is **bound** by a positive predicate atom, or by an **equality** `X = e` once every variable in `e` is bound.

Other comparisons (`<`, `>`, `<>`, …) and negated atoms only **test** variables; they never bind them.

A rule is **safe** when every variable in the head, in a comparison, and under `not` is bound.

- ✓ `divisor(D, N) :- num(D), num(M), D > 1, M > 1, N = D * M`: `num` binds `D` and `M`, then the equality `N = D * M` binds `N`.
- ✗ `prime(N) :- not composite(N)`: `N` appears only under `not`, so it is never bound.

<div class="note">
Positive atoms and binding equalities <strong>generate</strong> values; the other comparisons and negation only <strong>filter</strong> them.
</div>
