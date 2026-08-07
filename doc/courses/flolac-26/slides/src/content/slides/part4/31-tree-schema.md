---
title: "Syntax trees as JSON"
kind: content
section: "JSON"
tight: true
---

Standard Datalog has only flat, atomic values.
**Datamog** adds one more type, `value`: the union of every JSON shape (null, numbers, strings, booleans, **arrays** and **objects**), enough to hold a whole **syntax tree**.

Make each node an **object** tagged with its `type`, put its children in an **args** array, and let a variable carry its `name`.
So `p & q` becomes:

```json
{"type": "and",
 "args": [{"type": "var", "name": "p"},
          {"type": "var", "name": "q"}]}
```

<div class="note">
Objects for nodes, arrays for children.
One column type holds data of any shape; the next slides read such a tree, then build it.
</div>
