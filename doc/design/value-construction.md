# Design proposal: constructing values

Status: **unimplemented proposal for computed keys and ordered aggregates.** Two gaps that arrived together and should
not ship together: the ordered aggregate (gap 2) is implementation-ready, while
computed object keys (gap 1) need runtime object canonicalisation on SQLite and belong
in their own proposal. See [the recommendation](#recommendation-ship-gap-2-split-gap-1-out).

The remaining gaps are computed object keys and caller-selected aggregate order.
Programs already construct arrays and objects from expressions, and `list` collects
a data-dependent number of elements in its defined canonical order. This proposal
would add control over keys and ordering; it does not introduce value construction
itself. Structural contracts and nominal proof annotations are implemented separately
in [semantic types](semantic-types.md) and do not fill these two gaps.

## Gap 1: object keys must be literals

`ObjectEntry ::= STRING ':' Expression` (spec §2.6), so a computed key does not
parse:

```prolog
renamed(O) :- pair(K, V), O = {"x_" + K: V}.
# Expecting token of type ':' but found `+`
```

No fixed-shape rename and no key derived from data. A computed key would let a
fixed number of object entries take data-dependent labels. It would not collect
rows into one object whose key set grows with the input.

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
do not determine. Fixed-arity object renames also need computed keys. Rebuilding an
object with an arbitrary number of entries needs another operation, such as an
object aggregate or object merge, so these two changes alone do not provide general
deep JSON transformation.

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

## Implementation cost: the two halves are not comparable

**Gap 2 is nearly free.** Aggregate `ORDER BY` is already in use: `list` and `concat`
emit `JSON_GROUP_ARRAY(... ORDER BY ...)` and `GROUP_CONCAT(... ORDER BY ...)` today,
sqljs runs on the same `SqliteSqlDialect`, and the examples suite passes there. So the
capability is proven on every backend and the change is to stop hardcoding the
argument as the key.

**Gap 1 is not a grammar relaxation.** Two costs, one of them structural.

Changing `ObjectEntry.key` from a string to an expression reaches every walker that
enumerates expressions: analysis, type and nullness inference, finiteness, navigation,
completion, SQL translation and native evaluation.

The harder one is SQLite's object semantics. Its dialect builds an object literal by
deduplicating keys **last-write-wins into a `Map`** and then **sorting them with
`compareJsonbObjectKeys`**, both at translation time. It has to: `json_object` emits
entries in argument order into TEXT, so without sorting, two literals differing only
in source key order would fail dedup, joins and `=` on SQLite while unifying
everywhere else, since Postgres gets the canonical form for free from `jsonb`. Both
operations need the keys statically. With computed keys neither can happen at
translation time, so SQLite has to dedupe and sort at *runtime*, which means a scalar
subquery per object literal carrying each entry's key, value and source position.
Handing expressions to `json_object` does not preserve Datamog's object semantics.

That is why the recommendation below is to ship gap 2 and split gap 1 out.

## The proposed fixes

**An explicit ordering key on `list` and `concat`.** `list(V) order by K`. SQLite
and Postgres both take an ordering expression inside the aggregate already; the
translator currently hardcodes the argument as the key.

```sql
SELECT json_group_array(json(x) ORDER BY k) FROM (SELECT 1 AS x, 2 AS k UNION SELECT 2, 1)
-- [2,1]
```

The surface needs a portable ordering contract, since none of it can be inherited
from the backends. The whole rule:

- Ascending, with the key restricted to `string`, `integer`, `float`, or `boolean`.
  The formal `PrimitiveType` set also includes `value`, so "primitive" alone does
  not state this restriction. `value` keys would need a canonical-text comparison,
  which is what made the index-pair workaround above give the wrong answer.
- String keys go through `dialect.stringOrder`, which already exists and is already
  applied to the aggregate ordering key when the argument is a string
  (`translator.ts`), emitting `COLLATE "C"` on Postgres and `COLLATE BINARY` on
  SQLite. This is a reuse rather than new work: a raw Postgres `ORDER BY` would use
  the database's collation and disagree with SQLite and the interpreters, which is
  the bug that wrapper already prevents for `list` and `concat`.
- **NULLs last**, emitted explicitly. Null is an isolated point in the order rather
  than a bottom (`null.md` §5, which rejects bottom because `min` skips NULLs), so the
  order does not place it, and the backends disagree left to themselves: SQLite sorts
  NULLs first, Postgres last for `ASC`.

  ```sql
  SELECT json_group_array(json(x) ORDER BY k) FROM (SELECT 1 AS x, NULL AS k UNION SELECT 2, 1)
  -- [1,2]   SQLite, nulls first
  ```

  A row whose key is NULL is **kept**, not skipped. That is not the same case as
  `list` skipping a NULL argument: here the value may be perfectly good and only its
  ordering key is missing.
- The existing aggregate-argument ordering as a secondary key, so ties are
  deterministic across backends rather than left to the engine.

**Computed object keys.** Relax `ObjectEntry` to accept an expression, require the
key expression to type as `string`, and evaluate it before object assembly. This
only provides fixed-cardinality dynamic labels. A variable-sized object needs a
separate aggregate or merge operation and should not be implied by this change.

Duplicate keys become a runtime condition rather than a parse-time one. Spec §2.9
says the last occurrence wins before canonicalisation; with computed keys that rule
has to be enforced by the backend's object builder rather than by the parser, so
its cross-backend behaviour needs pinning by a test.

### A NULL object key yields a NULL object

One rule is needed, because SQLite refuses a NULL key outright rather than
propagating:

```
SELECT json_object(NULL, 1)   -- ERROR: json_object() labels must be TEXT
```

So a guard is required wherever the key may be NULL, and the nullness analysis
([`nullness-tracking.md`](./nullness-tracking.md)) says where that is, the same
reasoning that lets the translator emit a plain `=` against a provably non-null side.
The rule is that a NULL key yields NULL for the whole object. That matches "NULL
propagates through operations" (`null.md` §5), it is the same answer `3 / 0` gives,
and it is portable. The alternative, skipping the entry, silently changes the
object's shape and is the worse failure.

## Recommendation: ship gap 2, split gap 1 out

They are not one change. Gap 2 is a surface addition over a capability every backend
already has, and it is what makes one-level `map`, `filter` and `reverse` expressible.
Gap 1 needs runtime object canonicalisation on SQLite and touches every expression
walker, and what it buys is narrower than it first looks: fixed-arity labels from
data, not an object assembled from rows.

Neither change assembles an arbitrary object from rows. Deep transformation needs
path-keyed traversal *and* an object aggregate or merge, so it stays out of reach of
both. The traversal question belongs with
[`functional-sublanguage.md`](./functional-sublanguage.md); object assembly is its own
proposal if a corpus case ever justifies one, and no example in the corpus does today.
