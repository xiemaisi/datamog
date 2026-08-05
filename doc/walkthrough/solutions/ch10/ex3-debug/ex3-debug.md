# Exercise 10.3 — Diagnosis

The buggy rule was

```prolog
grandparent(X, Z) :- parent(X, Y), parent(Z, W), Y = W.
```

Run under `--dry-run`, the generated SQL contains

```sql
WHERE (__b0."child_name" IS __b1."child_name")
```

i.e. "`X`'s child and `Z`'s child are the same". That's the
condition for `X` and `Z` being *co-parents of the same child*,
not for `X` being a grandparent of `Z`.

## The fix

The intended meaning — "`X` has a child `Y` who is a parent of
`Z`" — needs `Y` to both be `X`'s child *and* `Z`'s parent:

```prolog
grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
```

The intermediate variable `Y` appears twice, once as "`X`'s
child" and once as "`Z`'s parent", which is the one shared
variable that makes the join chain through two generations. The
original rule introduced two separate variables `Y` and `W` and
then joined them, which turns out to express a weaker condition
(they just have to be equal, they don't have to be *the same
individual in the middle*).

## Why `--dry-run` catches it

When you expected a grandparent relation, you'd expect the SQL
to look like
`FROM parent a, parent b WHERE a.child = b.parent`.
Instead it's
`WHERE a.child = b.child` — obviously wrong. The generated SQL
makes the mistake visible, where the Datalog form was subtly
misleading.
