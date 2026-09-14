---
title: "Proofs have types too"
kind: content
section: "JSON"
tight: true
---

Naming a rule makes its derivations values. The predicate's name also names their type.

```datamog
nat(0) :: Zero().
nat(N + 1) :: Succ(P: nat) :- P : nat(N), N < 2.
selected(P: nat) :- P : nat(_).
?- selected(P).
```

`:: Succ(P: nat)` checks the constructor payload. `P : nat(_)` captures a proof;
`P: nat` in the head declares its type. Aliases and nested types work too: `[nat?]`.

<div class="note">
Contracts do not cast JSON into proofs. Derive a tuple to build a proof;
constructor terms are matches. Module wiring preserves the producer's identity.
</div>
