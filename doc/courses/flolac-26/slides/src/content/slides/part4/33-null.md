---
title: "Missing data, and the null that is data"
kind: content
section: "JSON"
tight: true
---

Reaching past what is there gives **no value**, and a rule derives no tuple where one of its expressions has none.
Reaching a key that is *present and null* gives the `null` value, and the row stays:

```datamog
input predicate tree(t: value).

kind(T["nope"])            :- tree(T).   # no such key: no row at all
deep(T["args"][9]["name"]) :- tree(T).   # index off the end: no row
internal(N)                :- tree(T), N = T["name"].   # present: the value, null included

?- internal(N).
```

So the two are distinguishable, which is the point: `null` is one of the `value` shapes and an ordinary value, while an absent key has no value at all. Ask for the rows an expression lost with `not defined(e)`.

<div class="note">
Both notions are <strong>Datamog-specific</strong>: standard Datalog has only flat, atomic values, no <code>null</code>, and total expressions.
</div>
