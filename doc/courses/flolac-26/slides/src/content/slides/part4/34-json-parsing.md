---
title: "Building a syntax tree"
kind: content
section: "JSON"
tight: true
---

The Part 2 parser only **checked** a formula's syntax.
Give each nonterminal one extra argument, and the same rules **build** the tree in that schema:

```prolog
atom(F, T, {"type": "var", "name": C})      :- char(F, C), prop_var(C), T = F + 1.
conj(F, T, {"type": "and", "args": [L, R]}) :- conj(F, M, L), char(M, "&"), lit(M + 1, T, R).
```

Parsing `p & q` now yields the tree itself:

```json
{"type": "and", "args": [{"type": "var", "name": "p"}, {"type": "var", "name": "q"}]}
```

<div class="note">
Nested objects and arrays: exactly <strong>JSON</strong>.
The <code>value</code> type lets a rule assemble structured data and pass it along.
Carried all the way to a theorem verdict, this is <code>examples/parse-to-cnf</code>.
</div>
