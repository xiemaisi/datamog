# Chapter 17 — Recursion through negation

Chapter 8 drew a hard line: a negative edge inside a dependency cycle makes a
program unstratifiable, and Datamog refuses it. The reason given was that
`p(x)` holds iff not `p(x)` has no consistent reading. That reason is right,
and it is about cycles crossing *one* negation. This chapter is about cycles
crossing *two*, where the line turns out to be in slightly the wrong place.

## The rule you keep wanting to write

Constant folding, in a compiler:

> An expression is constant if it is a literal, or it is composite and **every**
> child is constant.

Datalog has no `forall`. The standard move is to name the counterexample and
negate it, exactly the way you write set difference:

```prolog
constant(E) :- literal(E).
constant(E) :- composite(E), not has_nonconstant_child(E).
has_nonconstant_child(E) :- child(E, C), not constant(C).
```

Read the second and third rules together and they say what you want: `E` is
constant when no child of it fails to be constant. Run it and Datamog says no.

```
Negation of 'has_nonconstant_child' in rules for 'constant' is not stratifiable
(they are mutually recursive).
```

Which is fair. `constant` depends on `has_nonconstant_child`, which depends
back on `constant`, and both edges are negative, so the cycle has a negative
edge in it and Chapter 8's rule fires.

And yet nothing here is paradoxical. Follow the loop and count: `constant`
depends on itself through **two** negations. Two negations cancel. If more
things are constant, then fewer children fail to be constant, so fewer
expressions have a non-constant child, so more things are constant. Growing the
input grows the output. That is monotonicity, which is the property least fixed
points need, and it was there all along — Chapter 8's check just could not see
it, because it looks at one edge at a time.

**Logic lens.** The formula `∀c. child(e,c) → constant(c)` is equivalent to
`¬∃c. child(e,c) ∧ ¬constant(c)`, which is where the two negations come from:
one for the `¬∃`, one for the `¬constant`. A universal quantifier *is* a double
negation, so recursion through `forall` is always recursion through two `not`s.
Datalog's restriction to Horn clauses is what forces the middle of that formula
to become a named predicate instead of staying inside one rule.

## Marking the odd one out

The fix is one character. Write `^` after the helper's name, everywhere it
appears:

```prolog
constant(E) :- literal(E).
constant(E) :- composite(E), not has_nonconstant_child^(E).

has_nonconstant_child^(E) :- child(E, C), not constant(C).
```

That is the whole feature. The program now runs.

```bash
bun run datamog --backend native doc/walkthrough/code/ch17/constant.dl
```

The sigil marks the predicate **maximal**. `constant` is *minimal*, like every
predicate you have written so far: it starts out holding of nothing and grows.
`has_nonconstant_child^` starts out holding of *everything* and shrinks. One
side works up from below, the other down from above, and the sigil says which
is which.

The rule Datamog checks is the same shape as Chapter 8's, with polarity added.
Inside one cycle:

- a **positive** call must be to a predicate of the **same** polarity;
- a **negated** call must be to one of the **opposite** polarity.

Write no `^` anywhere and the second clause can never hold, so you are back to
"no negation inside a cycle" and every program you have written still means
what it did. Write `^` in the right place and a cycle crossing two negations
becomes legal, because it alternates polarity twice and comes home.

Note what stays rejected. `p(X) :- r(X), not p(X).` still fails, and no sigil
helps: a predicate cannot have a polarity different from its own. One negation
around a cycle is still a paradox, which is exactly what Chapter 8 said.

The sigil is **not part of the name**, which is why every occurrence has to
carry it. `bad` and `bad^` are one predicate, not two, so this is an error and
not a way to get an unmarked copy:

```prolog
output predicate bad(E) :- bad^(E).   # ERROR: 'bad' is a maximal predicate
```

That is a second rule for `bad` with the polarity left off. If you want to
print a maximal predicate, mark its own rules `output predicate` and it prints
under the name you wrote, sigil included.

## How it runs

You know from Chapter 5 that a stratum is evaluated by repeating a pass until
nothing new appears. A cycle with two polarities in it needs one more loop
outside that one.

Round 1 starts the maximal side at ⊤ — everything. So every `not
has_nonconstant_child^(...)` fails, the second rule for `constant` never fires,
and the first pass finds just the literals. Then the maximal side is rebuilt
from scratch against that: with only literals known constant, almost everything
has a non-constant child. Round 2 runs `constant` again, now with a smaller
helper to get past, and `add` gets in. And so on, until the maximal side stops
changing.

For the tree in `code/ch17/constant.dl` — `(1 + 2) * x` and `(1 + 2) * 4`
sharing the subterm `1 + 2` — it goes:

```
round 1: constant = n1, n2, n4                helper = mul_4, mul_x
round 2: constant = n1, n2, n4, add           helper = mul_x
round 3: constant = n1, n2, n4, add, mul_4    helper = mul_x
```

One level of the tree per round, which is the shape you would expect from a
bottom-up traversal. `mul_x` never becomes constant, because `x` is a variable:
neither a literal nor composite, so no rule can ever derive it.

Two details worth pinning down, because both look alarming and neither is:

- **The maximal side is thrown away and rebuilt every round.** Facts survive
  this. A fact is a rule with an empty body, so it is re-derived on the first
  pass of every round.
- **⊤ is never actually built.** A relation over `integer` holding "everything"
  is infinite. It never has to exist, because the polarity rule guarantees that
  the only atoms which can look at a maximal predicate while it means ⊤ are
  *negated* ones, and those just fail. Nothing enumerates it. This is also why
  safety (Chapter 7) needs no new rules here.

**SQL lens.** Try `--backend sqlite` on that program and it is rejected. A
recursive CTE computes one least fixed point of a monotone body; it has no way
to express an outer loop that empties a table and refills it between rounds.
This is the second thing (after non-linear recursion, Chapter 4) that the
in-memory evaluators can do and SQL cannot.

## The interesting part: which side gets the sigil

Here is a purity analysis. A function is pure if it writes nothing and every
function it calls is pure — `forall` again, so the same shape:

```prolog
output predicate pure(F) :- func(F), not calls_impure^(F), not writes(F).
calls_impure^(F) :- calls(F, G), not pure(G).
```

Now let `f` and `g` call each other, and let neither write anything. Are they
pure?

Run it (`code/ch17/purity.dl`) and the answer is no: only `leaf` comes out
pure. `pure` is minimal, so it starts empty and every tuple has to be *earned*
by a finite derivation. `f` is pure if `g` is, and `g` is pure if `f` is, and
neither ever gets a first foothold.

Now move the sigil to the other side, leaving the rules otherwise identical:

```prolog
output predicate pure_opt^(F) :- func(F), not calls_impure_opt(F), not writes(F).
calls_impure_opt(F) :- calls(F, G), not pure_opt^(G).
```

Now `f` and `g` are both pure. `pure_opt^` starts holding of everything and
only loses what gets refuted, and nothing in that cycle writes, so nothing
refutes them.

Both answers are defensible. The first is what a conservative analysis wants:
never claim purity you cannot prove. The second is what a real purity analysis
wants: assume pure, and let evidence take it away. Same two rules, one
character moved.

This is why Datamog makes you write the sigil instead of working it out. A
compiler *can* tell which predicates could be marked — that is just a
two-colouring of the cycle — but both colourings are consistent, and they
answer different questions. Only you know which one you meant.

**Imperative lens.** The optimistic version is what you would hand-write as
"assume every function is pure, then repeatedly walk the call graph removing
any function that calls an impure one, until a pass removes nothing". The
conservative version is the other loop: "start with nothing, repeatedly add any
function all of whose callees are already known pure". Both are natural
programs, and it is not obvious from the loops that they answer differently on
cyclic input. Written as rules, the difference is one sigil.

## A game, and the draws in the middle

The textbook rule for a two-player game is one line:

```prolog
win(P) :- move(P, Q), not win(Q).
```

You win if you can move to a position your opponent loses from. One negation
around the cycle, so it is rejected, and marking `win` maximal cannot help.

But you can ask the question from both sides at once. Duplicate the predicate
and let each negate the other:

```prolog
win(P)       :- move(P, Q), not not_lost^(Q).
not_lost^(P) :- move(P, Q), not win(Q).
```

Both rules say the same thing about the same game, so this is not two analyses.
It is one analysis with its two bounds named separately: `win` grows from
below and collects the positions with a forced win, `not_lost^` shrinks from
above and keeps the positions that are not definitely lost. Where the two
agree, the position is settled. Where they disagree, neither player can force
anything, and the game goes on forever: a draw.

Nim (`code/ch17/nim.dl`) has no draws, since every move takes matches off the
table and the game has to end. So the two bounds meet, and you can *check* that
they meet with an integrity constraint (Chapter 8's `!-`):

```prolog
!- not_lost^(A, B), not win(A, B).
```

Read: "no position is un-decided". It passes. Change the game to one where two
positions move to each other forever and it fails, reporting exactly the drawn
positions.

**Logic lens.** The two bounds are the well-founded semantics that Chapter 8
mentioned as an exotic extension. The gap between them is its third truth
value, "undefined". Datamog has not grown a third truth value; you named the
two bounds yourself and read the gap. That works because a *single*
self-negating predicate can be split by hand, and it does not generalise to a
whole program — but where you need it, it is available.

## Sigils that do nothing

A `^` only means something when the predicate is read while it still means ⊤,
which only happens inside a cycle containing both polarities. Two shapes make
it inert, and Datamog warns about both:

```prolog
sink^(X) :- node(X), not has_outgoing(X).
```

no cycle at all, so nothing ever sees it at ⊤; and

```prolog
tc^(X, Z) :- edge(X, Y), tc^(Y, Z).
```

a cycle where everything is maximal, so there is no minimal side to alternate
against. Both compute exactly what they would without the sigil. The warning is
worth heeding anyway: a reader takes `^` at a call site as the sign that a
negation inside a cycle is deliberate, so a decorative one is misinformation.

## Recap

- A cycle crossing **one** negation is a paradox and stays rejected. A cycle
  crossing **two** is monotone overall, and is exactly what recursion through
  `forall` looks like once Horn clauses force the middle of the formula into a
  named predicate.
- The `^` sigil marks the anti-monotone side of such a cycle: it starts at ⊤
  and shrinks while the other side grows. Write it at every occurrence, so a
  reader can tell at the call site that the negation is deliberate. Inside a
  cycle, a positive call needs matching polarity and a negated call needs
  opposite polarity.
- Which side you mark is a modelling decision, not bookkeeping. Both
  colourings type-check and they answer different questions, as `pure` and
  `pure_opt^` show on the same call graph.

## Exercises

### Exercise 17.1 — Where does the sigil go? ★

`code/ch17/reachable-all.dl` wants "a node is *safe* if it is a sink, or every
node it points at is safe". It is written with the helper unmarked and is
rejected. Add the sigil in the right place and run it. Then move it to the
other predicate and say what goes wrong — before running it.

### Exercise 17.2 — Two readings of one graph ★★

Take `code/ch17/purity.dl` and add a function `w` that both writes and is
called by `f`. Predict what happens to `pure` and to `pure_opt^` before
running. Then remove the `writes` fact for `w` and predict again.

### Exercise 17.3 — Find the draws ★★

Change `code/ch17/nim.dl` into a game with a cycle: add positions `p` and `q`
with moves to each other, and delete the Sprague-Grundy constraints (they are
about Nim, not about games in general). Which constraint now fails, and what
does it report? Which of `win` and `not_lost^` would you show a user?

### Exercise 17.4 — Why not just infer it? ★★

The polarity assignment for a cycle is a two-colouring, and a compiler could
find one without being told. Write down, for the purity example, both
colourings and the answer each gives. Then argue for or against making the
compiler pick.

### Exercise 17.5 — Even/odd, revisited ★★★

Chapter 8 rejected mutually recursive `even`/`odd` defined through negation.
Can you write a working `even`/`odd` over a `succ` chain where each negates the
other? If not, say precisely which check stops you, and whether the program you
were trying to write has a meaning at all.

---

Next: **[Appendix A — The three lenses cheat sheet](A-lenses.md)**.
