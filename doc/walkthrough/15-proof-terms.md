# Chapter 15 — Proof terms

Every query so far has answered a *what*: which tuples are in a
predicate. Datalog is also, quietly, tracking a *how* — the way
each tuple was derived. A fact might follow from a single rule
application or from a long chain of them, and often more than
one chain reaches the same fact. That derivation is real
information, and Datamog lets you name it, capture it, and
compute with it.

The mechanism is small: give a rule a name, and its predicate
starts carrying **proof terms**, one per derivation. This is the
Curry-Howard reading of a Horn clause taken literally: a
predicate (fixed by its arguments) is a *proposition*, each
named rule is a *constructor*, and a proof term is an
*inhabitant*. So a named predicate is an algebraic datatype and
its proof terms are the values of that type. We'll build up to
that with four small datatypes.

## Naming a rule

Write a constructor name after the head with `::`:

```prolog
colour() :: Red.
colour() :: Green.
colour() :: Blue.
```

`colour` is a nullary predicate with three rules, now named
`Red`, `Green`, and `Blue`. Ask for its proof terms by capturing
them with the `:` prefix; read `C : colour()` as "C is a proof
of `colour()`":

```prolog
?- C : colour().
```

```
Red()
Green()
Blue()
```

Three rules, three proof terms: an enum. Each constructor is
nullary because the rules have empty bodies.

## Constructors with arguments

A rule with a body carries the witnesses of its **existential
body variables** — the variables that appear in the body but not
the head:

```prolog
num(1). num(2).
num_pair() :: MkPair :- num(Left), num(Right).

?- P : num_pair().
```

```
MkPair(1, 1)
MkPair(1, 2)
MkPair(2, 1)
MkPair(2, 2)
```

`num_pair()` is still nullary, but each *derivation* picks a
`Left` and a `Right`, so each proof term records that choice. The
proof terms are exactly the pairs.

Give a predicate a base case and a witnessed case and you get an
optional-like type:

```prolog
num_opt() :: None.
num_opt() :: Some :- num(Val).

?- P : num_opt().
```

```
None()
Some(1)
Some(2)
```

## Recursion: the proof terms *are* the data

When a rule's body refers to a proof-carrying predicate, that
atom's proof term is included as a **sub-proof**. Recursion
therefore nests:

```prolog
num(7).
num_list(0) :: Nil.
num_list(n + 1) :: Cons :- num(Car), n <= 3, num_list(n).

?- Xs : num_list(Len).
```

```
Nil()
Cons(7, Nil())
Cons(7, Cons(7, Nil()))
...
```

Nothing in the `Cons` rule mentions the sub-proof explicitly:
every positive proof-carrying body atom contributes one
automatically, in body order, after the existential-variable
witnesses. So `Cons` takes two arguments, `Car` (an existential
value) and the sub-proof of `num_list(n)`. The proof terms of
`num_list` *are* the lists of numbers, a length-indexed list
datatype built for free out of the derivation structure.

Under the hood a proof term is an ordinary `value` (Chapter 14):
the object `{"$proof": "num_list::Cons", "args": [7, ...]}`, with a
reserved `$proof` key so it can't be mistaken for your own data.
The CLI and playground tables print it in the friendlier
constructor form; `to_json` or the JSON output show the raw object.

## Capturing and suppressing

There are three ways to treat a proof-carrying body atom:

- **bare** `num_list(n)` — its sub-proof is included anonymously
  (what the `Cons` rule above does).
- **capture** `V : num_list(n)` — bind the sub-proof to `V` so
  you can output it or pass it along (what the queries above do).
- **suppress** `_ : num_list(n)` — drop the sub-proof, keeping it
  out of the enclosing constructor.

When you capture a proof and don't care about the declared columns,
drop the parentheses: `V : num_list` is shorthand for
`V : num_list(_)`, and `?- C : colour` reads as plainly as "C is a
colour". The parens can only be dropped after a `V :` or `_ :`
capture; a bare `p` on its own is still a variable, so ordinary
atoms keep them.

Suppression is about more than tidiness. A derivation set can be
*infinite* even when the fact set is finite: transitive closure
over a cyclic graph proves the same reachabilities in endlessly
many ways, so the nested proof term grows without bound. That is
the same value growth the finiteness lens (Chapter 5, spec §5.8)
warns about, and `--warn-finiteness` flags the proof column.
Suppressing the recursive sub-proof cuts the nesting:

```prolog
reach(X, Y) :: Direct :- edge(X, Y).
reach(X, Z) :: Step   :- edge(X, Y), _ : reach(Y, Z).
```

A `Step` proof now records only the intermediate node, not the
whole sub-derivation, so `reach` stays finite over any graph.

## Taking proof terms apart

Capturing gives you a whole proof term; often you want to look *inside* one. Put
a constructor on one side of an equality and it becomes a **pattern**:

```prolog
opt_value(V) :- P = Some(V).
```

`P = Some(V)` matches `P` against the `Some` constructor and binds `V` to its
argument; the `None` proofs don't match, so `opt_value` collects the values that
were wrapped in `Some`. The pattern also range-restricts `P` to proofs of
`num_opt` for you, so no separate `P : num_opt()` capture is needed. In a
pattern a variable binds, a literal has to match, `_` ignores a position, and a
nested pattern like `Cons(_, Cons(X, _))` reaches deeper in.

Because each rule matches one constructor, ordinary rule disjunction gives you
case analysis, and recursion gives you folds. A pattern works just as well in a
rule *head*, where it reads as an implicit equality against that column, so
summing a list proof term takes two rules and no scratch variable:

```prolog
list_sum(Nil(), 0).
list_sum(Cons(H, T), S + as_integer(H)) :- list_sum(T, S).
```

The `Nil` rule is the base case; the `Cons` rule matches off the head `H`,
recurses on the tail `T` for its sum `S`, and adds the two right in the head. A
matched component comes out as a `value`, so `H` needs an explicit `as_integer`
before the arithmetic. `list_sum`'s first column already ranges over `num_list`
proofs, so pairing each list with its sum needs no capture:

```prolog
?- list_sum(Xs, S).
```

Under the hood a pattern is sugar for the JSON accessors of Chapter 14 — the tag
`["$proof"]` and the components `["args"][i]` — plus the implicit `: num_list`
capture that makes the matched value range over the datatype's proofs.

## Relating lists

The same head patterns turn the list operations into near-Prolog. There is no
separate "construction" mode: a constructor term is always a match, so
`Cons(H, R)` in an *output* position relates that column to a `num_list` proof
rather than building a fresh value. append concatenates two lists:

```prolog
append(Nil(), B, B) :- B : num_list.
append(Cons(H, T), B, Cons(H, R)) :- append(T, B, R).
```

The first argument's `Cons(H, T)` peels a head `H` and tail `T`; the third's
`Cons(H, R)` relates the result to the list made of `H` and the appended tail
`R`. Both are matches against `num_list` proofs. `reverse`, `member`, and
sublist predicates fall out the same way (see the *List Operations* example).

Because the output is matched against `num_list` too, append relates lists the
datatype already enumerates rather than inventing new ones. If `num_list` is
capped at some length, concatenating two lists whose result exceeds the cap
produces no matching proof, and that row drops out — append computes the append
*relation restricted to the enumerated universe*; widen the cap to admit longer
results. (The base case keeps `B : num_list` because `B` is a plain variable
with no constructor term to range-restrict it.)

These recursive programs thread proofs through several matches, which the SQL
backends translate into nested accessor chains that can outgrow a SQL engine's
parser limit, so run them on `native` / `seminaive`.

## Beyond lists

The same three moves — name the rules, capture proofs, match constructors —
build any inductive datatype. Two more live in the examples.

**Peano naturals** are the list datatype with the payload removed: `Zero()` and
`Succ(n)`. Addition is structural, the same shape as `append` (and clipped the
same way):

```prolog
nat(0) :: Zero.
nat(n + 1) :: Succ :- nat(n), n <= 2.

plus(Zero(), B, B) :- B : nat.
plus(Succ(A), B, Succ(C)) :- plus(A, B, C).
```

**An expression parser and evaluator.** Feed a token sequence in through an
extensional and a chart parser turns it into AST proof terms — only the trees
the input allows. Each grammar production is a constructor. Naming its arguments
explicitly, `:: Add(L, R)`, makes the proof term carry exactly the two captured
sub-parses, keeping the parser's split position out of the AST:

```prolog
ast(i, i + 1) :: Lit(V) :- token(i, "num", V).
ast(i, k) :: Add(L, R) :- L : ast(i, j), token(j, "plus", _), R : ast(j + 1, k).

eval(Lit(N), as_integer(N)).
eval(Add(L, R), A + B) :- eval(L, A), eval(R, B).
```

(`:: Ctor(...)` is the explicit form of the head annotation; bare `:: Ctor`
auto-derives the arguments as the witnesses followed by the sub-proofs.) The
evaluator is a fold over the proof term — a definitional interpreter in Datalog.
The grammar is ambiguous, so `2 + 3 * 4` yields both parses: `(2+3)*4 = 20` and
`2+(3*4) = 14`.

Both examples thread proofs through recursion (the parser also branches on two
sub-spans), so run them on `native` / `seminaive`. See the *Peano Naturals* and
*Expression Evaluator* examples.

## A few rules of the road

- Naming is all-or-nothing: name every rule for a predicate, or
  none.
- A constructor is scoped to its predicate: its full name is
  `predicate::Ctor`, unique within that predicate but free to recur
  across predicates. Reference it bare (`Cons(...)`) when only one
  predicate declares the tag, or qualified (`num_list::Cons(...)`)
  otherwise.
- A proof-carrying predicate can't also aggregate.
- A proof mark applies only to a positive, proof-carrying atom,
  not to an extensional predicate and not to a negated atom.

Proof terms desugar to one extra `value` column that named rules
fill in, plus accessor matches wherever a constructor term
appears, so they run on every backend. As with any recursion,
though, a *non-linearly* recursive proof predicate is rejected by
the SQL backends and runs only on `native` and `seminaive`.

## Exercises

### Exercise 15.1 — Booleans as a datatype ★

Define a nullary predicate `bit()` with two constructors, `O` and
`I`, and query its proof terms. You have just built `Bool`.

### Exercise 15.2 — Binary trees ★★

With `num(1). num(2).`, define `tree(depth)` whose proof terms
are complete binary trees of numbers: a `Leaf` carrying a number
at depth 0, and a `Node` joining two depth-`d` subtrees into one
of depth `d + 1`. Cap the depth with a guard. (Two recursive body
atoms make this non-linear, so run it on `--backend native`.)
What do the proof terms look like?

### Exercise 15.3 — Included vs. suppressed ★★★

Take the `reach` example over a small cyclic graph. Run it once
with the recursive sub-proof *included* and `--warn-finiteness`,
and observe the warning. Then suppress it with `_ :` and compare.
What does each `Step` proof term tell you, and what does it leave
out?

### Exercise 15.4 — Length by folding ★★

Building on the `num_list` datatype, define `list_len(P, N)` that computes the
length `N` of a list proof term `P` by pattern-matching (`Nil` gives 0, `Cons`
adds 1 to the tail's length). Confirm it agrees with the index the list is built
at.

---

Next: **[Chapter 16 — Modules](16-modules.md)**.
