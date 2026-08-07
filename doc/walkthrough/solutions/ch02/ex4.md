# Exercise 2.4 — Read the SQL

Starting rule:

```prolog
cousin_of_greg(X) :- parent(P, X), parent(P, Y), grandparent(G, Y), Y = "greg".
```

## Predictions

1. **FROM aliases: three.** One per body atom: two for the two
   `parent(...)` uses, one for `grandparent(...)`. The equality
   `Y = "greg"` is not a body atom; it's a condition and does not
   introduce a new alias.

2. **WHERE conditions: three.**
   - Shared variable `P`: `__b0."parent_name" IS __b1."parent_name"`.
   - Shared variable `Y`: `__b1."child_name" IS __b2."col2"` (the
     second column of the `grandparent` view).
   - Constant-through-equality `Y = "greg"`: appears as a literal
     filter on whichever alias binds `Y`. In practice Datamog will
     inline the constant into one of the existing equalities —
     `__b1."child_name" = 'greg'` — and also require the
     `grandparent` alias's second column to equal `'greg'`.

3. Of those conditions: `P` and `Y` come from shared variables;
   the `'greg'` comparison comes from the explicit equality atom
   in the rule body.

## Checking

Write the rule into a file (extending `family.dl`), run with
`--dry-run`, and compare against the predictions. The shape will be
as above even if Datamog's exact normalisation differs slightly —
for example, it may choose to push the `Y = "greg"` constraint into
whichever equality it likes.

## Moral

Once you can do this exercise in your head, you've internalised the
core translation rule: **body atom → FROM alias, shared variable →
WHERE equality, constant → WHERE equality against a literal**. Every
non-recursive rule you see for the rest of the tutorial follows this
same pattern.
