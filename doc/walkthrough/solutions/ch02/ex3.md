# Exercise 2.3 — Self-parent

The rule

```prolog
self_parent(X) :- parent(X, X).
```

is perfectly legal but almost certainly returns no rows: it asks for
everyone who is their own parent. Nothing in our (or any realistic)
dataset satisfies that.

The generated SQL makes the condition explicit:

```sql
CREATE OR REPLACE VIEW "self_parent" AS
  SELECT __b0."parent_name" AS col1
  FROM   "parent" AS __b0
  WHERE  (__b0."parent_name" IS NOT DISTINCT FROM __b0."child_name")
;
```

The two occurrences of `X` in the single body atom *do* become a
`WHERE` equality — just within the same alias rather than between
two different ones. That equality is what makes the result empty.

## The takeaway

A repeated variable always compiles to equality. Whether the
equality is across two aliases (a join) or within one alias (a
self-constraint on a row) depends on how many body atoms it
spans — not on the variable itself.
