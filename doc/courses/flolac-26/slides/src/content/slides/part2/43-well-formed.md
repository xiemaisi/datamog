---
title: "Is it a formula?"
kind: content
section: "Parsing"
tight: true
---

The whole input is a formula when the start symbol `impl` spans it, from `0` to its full length:

```prolog
formula() :- impl(0, T), len(T).
?- formula().
```

- `yes` for `~(p|q)&r|p` or `p->q->r`
- `no` for `p&|q` or `(p|q`.

Try it live in the <a href="https://xiemaisi.github.io/datamog/#example=Recognise%20a%20Formula" target="_blank" rel="noopener">playground</a>.

<div class="note">
This only <strong>recognises</strong> well-formed formulas; it does not yet build the tree.

For that we need a way to deal with structured data (Part 4).
</div>
