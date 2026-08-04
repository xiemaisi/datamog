# Design proposal: constructing values

Status: **proposal, nothing implemented.** Two small gaps that together make the
`value` type read-mostly. Independent of everything else in this directory, and
cheaper than any of it.

The shape of the hole: a program can destructure a `value` arbitrarily deeply
(subscript, slice, `array_element`, `object_entry`, the coercion builtins) but can
only *construct* fixed shapes. Nothing built from data can have a computed key or a
chosen element order.

## Gap 1: object keys must be literals

`ObjectEntry ::= STRING ':' Expression` (spec §2.6), so a computed key does not
parse:

```prolog
renamed(O) :- pair(K, V), O = {"x_" + K: V}.
# Expecting token of type ':' but found `+`
```

No rename, no key derived from data, no object whose key set comes from the input.

## Gap 2: `list` sorts by its argument

`list(expr)` orders by the argument itself (spec §2.7) and there is no `ORDER BY`
escape, so an array cannot be rebuilt in a chosen order. The obvious workaround,
collecting index/value pairs, fails because `value` arguments sort by canonical
text, which puts index 10 between 1 and 2:

```prolog
tagged(list([I, W])) :- doubled(I, W).
# [[0,6],[1,2],[10,22],[2,4],[3,14],[4,8],...]
```

`concat` has the same restriction for the same reason.

## What the two cost together

`map`, `filter`, `reverse`, `zip` and `sort_by` over a JSON array are all
inexpressible, since each needs to emit elements in an order the values themselves
do not determine. Deep JSON transformation (redact every value under a key,
increment every number, rename keys throughout) needs both halves and is therefore
flatly impossible.

The one escape hatch is to abandon arrays for nested two-element arrays as cons
cells:

```prolog
acc(0, null) :- doc(_).
acc(I + 1, [V, A]) :- acc(I, A), doc(D), array_element(D, I, V).
# [10, [2, [1, [3, null]]]]
```

That reverses correctly but leaves the result in a representation that
`array_element`, `length` and integer subscript no longer understand, and there is
no way back to a flat array without the ordered aggregate that does not exist.

## The fix

Both halves are small, and the backends already support what is needed.

**An explicit ordering key on `list` and `concat`.** `list(V) order by K`. SQLite
and Postgres both take an ordering expression inside the aggregate already; the
translator currently hardcodes the argument as the key.

```sql
SELECT json_group_array(json(x) ORDER BY k) FROM (SELECT 1 AS x, 2 AS k UNION SELECT 2, 1)
-- [2,1]
```

**Computed object keys.** Relax `ObjectEntry` to accept an expression, require the
key expression to type as `string`, and pass it through to the existing
`jsonb_build_object` / `json_object` call, both of which already take expressions.

Duplicate keys become a runtime condition rather than a parse-time one. Spec §2.9
says the last occurrence wins before canonicalisation; with computed keys that rule
has to be enforced by the backend's object builder rather than by the parser, so
its cross-backend behaviour needs pinning by a test.

## Two NULL decisions

Neither can be defaulted, because the backends disagree.

**A NULL ordering key has no inherited position.** Null is an isolated point in the
order rather than a bottom (`null.md` §5, which rejects bottom because `min` skips
NULLs), so the order itself does not say where a NULL key sorts. The backends
answer differently on their own: SQLite puts NULLs first, Postgres puts them last
for `ASC`.

```sql
SELECT json_group_array(json(x) ORDER BY k) FROM (SELECT 1 AS x, NULL AS k UNION SELECT 2, 1)
-- [1,2]   SQLite, nulls first
```

So the rule has to be written down and emitted explicitly. Skipping those elements
matches what the rest of the aggregate family does with NULLs and what `list`
already does with a NULL argument; parking them at a fixed end with an explicit
`NULLS FIRST` / `NULLS LAST` is the alternative.

**A NULL key is an error, not a NULL object.** SQLite refuses it outright rather
than propagating:

```
SELECT json_object(NULL, 1)   -- ERROR: json_object() labels must be TEXT
```

So a guard is required either way. Yielding NULL for the whole object matches "NULL
propagates through operations" (`null.md` §5); skipping the entry is the
alternative and is harder to justify, since it silently produces an object of a
different shape.

## Where this leaves the bigger proposals

Closing both gaps makes one-level `map`, `filter` and `reverse` expressible on
every backend, with no new language concepts. It does *not* make deep
transformation pleasant: rebuilding a nested document bottom-up relationally needs
node identity, and JSON has none, so the traversal has to be keyed by path. That
part is what [`functional-sublanguage.md`](./functional-sublanguage.md) is about,
and the cons-cell workaround above is the hint that the answer there is a
constructor rather than more JSON builtins.
