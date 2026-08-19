---
title: "Evaluate while parsing"
kind: content
section: "Parsing"
tight: true
---

We can evaluate while parsing by adding head variables `A` (assignment) and `V` (value):

```prolog
atom(F, T, A, V) :- char(F, C), prop_var(C, I), assignment(A), T = F + 1, V = (A >> I) & 1.
lit(F, T, A, V)  :- char(F, "~"), lit(F + 1, T, A, VC), V = 1 - VC.
conj(F, T, A, V) :- conj(F, M, A, VL), char(M, "&"), lit(M + 1, T, A, VR), V = VL & VR.
disj(F, T, A, V) :- disj(F, M, A, VL), char(M, "|"), conj(M + 1, T, A, VR), V = VL | VR.
impl(F, T, A, V) :- disj(F, M, A, VL), char(M, "-"), char(M + 1, ">"), impl(M + 2, T, A, VR), V = (1 - VL) | VR.

formula(A, V) :- impl(0, T, A, V), len(T).
satisfies(A)  :- formula(A, 1).
?- satisfies(A).
```

Try it live in the <a href="https://xiemaisi.github.io/datamog/#example=Evaluate%20a%20Formula" target="_blank" rel="noopener">playground</a>.
