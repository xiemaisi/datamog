---
title: "Shapes are checked contracts"
kind: content
section: "JSON"
tight: true
---

Inference retains known fields; a declaration can publish the shape callers may use.

```datamog
type Person = {name: string, age?: integer}.
person({"name": "Ada", "age": 41}: Person).
next_age(P["age"] + 1) :- person(P).
?- next_age(N).
```

`age?: integer` permits a **missing** field; `age: integer?` permits **null**.
Records are closed; `[Person]` describes an array. Input contracts validate loaded JSON.

<div class="note">
Structures keep JSON storage. An explicit <code>value</code> contract hides field
precision; callers then need extraction such as <code>as_integer</code>.
</div>
