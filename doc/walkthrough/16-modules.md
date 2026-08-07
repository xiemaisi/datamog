# Chapter 16 — Modules

Every program so far has been one file. That is fine for a self-contained
example, but real work wants reuse: a transitive-closure you can point at a road
network today and a flight network tomorrow, without copying the two recursive
rules and renaming everything by hand.

Datamog gets there by re-reading two things you already have. A file's `input
predicate`s are its parameters; its `output predicate`s and its unnamed `?-`
default are its results. So a **file is a function from input relations to output
relations**. To reuse one, you *instantiate* it: wire its inputs to relations you
have and give its outputs local names. That is the whole module system — no
separate `import` construct, just a way to bind an input to a source.

## A file is a function

Here is generic reachability, parameterised by an edge relation. Nothing about
it mentions roads or flights:

```prolog
# reach.dl
input predicate edge(src: integer, dst: integer).

output predicate reach(X, Y) :- edge(X, Y).
output predicate reach(X, Z) :- reach(X, Y), edge(Y, Z).
```

Read as a function, `reach.dl` takes one relation, `edge`, and returns one,
`reach`. `edge` is a *parameter*: on its own the file has no data for it, and
running `reach.dl` directly would load `edge.csv` by convention (Chapter 1). An
importer supplies it instead.

The tool for that is the **`:=` binding** on an input predicate. It reads as a
pun on `:-`: where `:-` means "defined by rules", `:=` means "bound to a
source". A binding is one of two things, and a single rule tells them apart:
**`from` present means another module; a bare string means a data file.**

## Binding an input to a data file

Start with the simpler half. You already know that a free input auto-loads from
`<name>.csv` in the program's directory. A `:=` data binding names the file
explicitly instead:

```prolog
input predicate airport(code: string, name: string) := "data/airports.tsv" as csv.
```

The source is resolved relative to the importing file, and may equally be a URL
or a `gh:` shorthand (the same set `--input` accepts). The loader is normally
chosen by the extension; `as <format>` (`csv`, `jsonl`, `json`, `mermaid`)
forces it when the extension lies — here a `.tsv` file that is really CSV. That
is all there is to data bindings; the interesting half is modules.

## Importing a module

A module binding instantiates another file and wires this input to one of its
outputs:

```prolog
# main.dl
input predicate road(src: integer, dst: integer).
input predicate road_reach(a: integer, b: integer) := reach from "reach.dl"(edge = road).

?- road_reach(1, X).
```

Read the right-hand side left to right:

- **`reach`** selects a named output of the module — its `output predicate
  reach`.
- **`from "reach.dl"`** is the module, resolved relative to `main.dl`.
- **`(edge = road)`** supplies the module's inputs by name: the callee's `edge`
  is wired to `main.dl`'s `road`. An actual is always just a predicate name from
  the importing file's scope (here a leaf input; it could be any predicate).

The local name `road_reach` *is* the instance's `reach` output, so the rest of
`main.dl` uses it like any predicate. With `road.csv` holding the edges
`1→2→3→4`:

```
?- road_reach(1, X).
X = 2
X = 3
X = 4
```

Unlike every earlier chapter, these are multi-file programs: run them with the
CLI (`datamog doc/walkthrough/code/ch16/main.dl`), which resolves `from
"reach.dl"` from disk relative to `main.dl`. The browser playground has no
filesystem, so it runs single-file programs only.

> **Imperative lens.** `reach.dl` is a generic function over a relation, and the
> binding is a call: `road_reach = reach(edge = road)`. It is the parametric
> polymorphism you would reach a generic or a template for in another language —
> write the algorithm once, apply it to many arguments.

## Instantiate it more than once

The payoff is reuse. Bind the same module a second time, to a different relation:

```prolog
# main.dl (continued)
input predicate flight(src: integer, dst: integer).
input predicate flight_reach(a: integer, b: integer) := reach from "reach.dl"(edge = flight).
```

Now `road_reach` and `flight_reach` are two independent transitive closures, both
from the one `reach.dl`. `datamog --all main.dl` runs every output:

```
-- road_reach          -- flight_reach
 a │ b                  a  │ b
 1 │ 2                  1  │ 10
 2 │ 3                  10 │ 20
 3 │ 4                  1  │ 20
 1 │ 3
 2 │ 4
 1 │ 4
```

Notice the result columns are `a` and `b` — the names *you* declared on
`road_reach`, not the `X`/`Y` the module happened to use internally. The
declared columns are the instance's public face.

> **Logic lens.** A module is a parameterised theory, and instantiation is
> substitution: `reach.dl` states "for all binary relations `edge`, `reach` is
> its transitive closure", and each binding picks a particular `edge`. This is
> exactly an ML *functor* (a module parameterised by a module) or a Soufflé
> *component*, with relations as the parameters.

## Under the hood: elaboration

Before anything runs, a program with bindings is **elaborated** into one flat
program, which then goes through the ordinary pipeline (Chapter 5) unchanged — so
the backends need no module machinery at all. For each instantiation Datamog
takes a fresh copy of the module, substitutes the wired inputs, and *freshens*
every other name with a per-instance prefix so two copies never collide. Your
declared name is then bound to the output you selected by a one-line **alias
rule**, whose head variables are your declared columns:

```prolog
road_reach(a, b) :- road_reach$0$reach(a, b).       # generated, not written
```

Everything merges into one program with one least fixed point.

> **SQL lens.** Elaboration is monomorphisation: each instance becomes its own
> set of views, with a thin view per import site on top. `datamog --dry-run
> main.dl` shows the two closures compiled to two independent recursive views,
> each over its own edge table:
>
> ```sql
> CREATE VIEW IF NOT EXISTS "road_reach$0$reach" AS
>   WITH RECURSIVE "road_reach$0$reach"(col1, col2) AS (
>     SELECT __b0."src", __b0."dst" FROM "road" AS __b0
>     UNION
>     SELECT __b0."col1", __b1."dst" FROM "road_reach$0$reach" __b0, "road" __b1
>       WHERE (__b0."col2" IS __b1."src")
>   ) SELECT * FROM "road_reach$0$reach";
>
> CREATE VIEW IF NOT EXISTS "road_reach" AS      -- the alias
>   SELECT DISTINCT __b0."col1" AS col1, __b0."col2" AS col2
>     FROM "road_reach$0$reach" AS __b0;
>
> CREATE VIEW IF NOT EXISTS "flight_reach$1$reach" AS ...  -- the same, over "flight"
> ```

`road_reach` and `flight_reach` are two copies because they are wired to
different relations. Two bindings wired the *same* way are a different matter:
Datamog **shares** them, expanding the module once and giving each binding its
own alias. An instance is identified by its module plus the predicates its inputs
are wired to, and in a language with no side effects equal inputs mean equal
outputs, so there is nothing to tell two such instances apart. You will see this
pay off in the next section.

> **Logic lens.** The ML jargon for this is that Datamog's functors are
> **applicative**, not **generative**: writing `F(A)` twice denotes one instance,
> where a generative functor would mint a fresh one each time (which is why
> Standard ML's `functor` gives you two unrelated types if you apply it twice).
> Applicative is the only defensible reading here, because nothing you can write
> distinguishes two instantiations with the same arguments — making them different
> would be an artefact of how elaboration happens to work, not a fact about your
> program. Different arguments still give different instances, and that difference
> is real.

## Composing modules

A module can itself import a module: `reach.dl` could wire its `edge` input to a
`filter.dl` that keeps only some edges. Bindings compose to any depth, resolved
relative to each file in turn.

There is one rule. The **instantiation graph must be acyclic**: two modules whose
inputs each default to an instance of the other are rejected, because expansion
would copy them forever. Keep this separate from recursion *within* a module,
which is completely fine — that is an ordinary least fixed point over the merged
program (`reach` is recursive, after all). The practical consequence: mutually
recursive predicates must live in the same file. Recursion inside a module, yes;
a recursive *wiring* cycle between modules, no.

## The default output

A module need not name its outputs. A library with a single `?-` query exposes
that query as its **default output**; select it by omitting the export name:

```prolog
input predicate ordered(lo: integer, hi: integer) := from "asc.dl"(p = road).
```

Everything else is the same: `from "asc.dl"` with no name ahead of it takes the
`?-` result, wired here through `p = road`. A named export is the norm for a
reusable library; the default is the convenient one-result case.

## Boundary types

The declared columns on the importing input are a **contract**, checked against
what the module actually produces. Declare `road_reach(a: string, b: string)` for
an integer closure, or wire a string relation to the integer `edge`, and you get
a static error naming the offending column — before anything runs. The check is
one-directional: the type you declare must equal or widen what the module
publishes, so a wider declaration (up to `value`) passes but a narrower one is
rejected. That is a subtype check, not the symmetric cross-rule widening from
Chapter 7.

## A poor-man's higher-order type

A module parameterises over *relations*, and a unary relation is just a set of
values — a type. So a module can parameterise over a **type**. Here is `Option`
built that way, using the proof terms of Chapter 15 for its two cases:

```prolog
# option.dl
input predicate elem(v: value).           # the element type, as a set of values
output predicate opt() :: None.             # None, and...
output predicate opt() :: Some :- elem(V).  # ...Some(v) for each element v
```

`elem` is declared `value`, so the element type is whatever an importer wires
in; `opt`'s proof terms are the `Option` values, `None()` and `Some(v)`.

Instantiate it at two element types, and — the useful part — pattern-match the
cases of *both*:

```prolog
# option-demo.dl
n(1). n(2).
colour("red").
input predicate int_opt(o: value)    := opt from "option.dl"(elem = n).
input predicate colour_opt(o: value) := opt from "option.dl"(elem = colour).

output predicate present(V) :- P : int_opt,    P = int_opt::Some(V).
output predicate present(V) :- Q : colour_opt, Q = colour_opt::Some(V).
?- present(V).       # 1, 2, "red"
```

Note the `o: value` column on each declaration. A proof-carrying predicate has an
implicit trailing `value` column holding the derivation (Chapter 15), and the
receiving declaration counts it, so it is always one wider than the output's own
arguments: `opt()` takes none, hence one column. Omit it and you get an arity error
at the boundary. The names you declare label the value columns; the proof column's
name is never printed, since a query hides the proof.

An imported instance's constructors are qualified by its predicate: `int_opt`'s
is `int_opt::Some`, `colour_opt`'s is `colour_opt::Some`. Constructors are scoped
to their predicate (Chapter 15), so the two `Some`s are genuinely distinct — no
clash — and you match each with its qualified name. (A bare `Some(V)` also works
whenever exactly one predicate in scope declares a `Some`; with two Options in
play you must qualify.) So one program can match against several instantiations
of the same type at once: `Option<Int>` and `Option<String>` from the one
`option.dl`. That is a poor-man's higher-order type — `option.dl` is `Option<_>`,
applied to an element predicate at each binding.

What makes these two types distinct is that they are applied to *different*
element predicates. Bind `option.dl` twice at the same element predicate and you
get one type with one `Some`, since there would be nothing to tell the two apart:
`Option<Int>` is `Option<Int>` however many times you write it.

If you would rather keep the representation abstract, don't import `opt` at all:
export *operations* over it from `option.dl` — matching the constructors
*inside* the module — and let the importer use those. Same module, ML-style:
expose a type through functions, or expose its constructors; your call.

## A module is an interface

Turn the picture around. A module's inputs are its parameters, so they are also
its **requirements**: what an importer must supply for the module's rules to mean
anything. That is an interface, and Datamog gives you all three parts of one out
of features you already have:

| Interface element | Datamog feature |
| --- | --- |
| the operations you must supply | `input predicate`, with its column types |
| the operations you get for free | `output predicate`, derived from them |
| the laws they must obey | integrity constraints ([Chapter 10](10-modelling.md)) |

Here is a strict order over the elements of a cover relation:

```prolog
# order.dl
input predicate cover(a: integer, b: integer).
input predicate lt(a: integer, b: integer) := reach from "reach.dl"(edge = cover).

!- lt(X, X).
!- lt(X, Y), lt(Y, X).
!- lt(X, Y), lt(Y, Z), not lt(X, Z).

elem(X) :- cover(X, _).
elem(X) :- cover(_, X).

output predicate minimal(X) :- elem(X), not lt(_, X).
output predicate maximal(X) :- elem(X), not lt(X, _).
```

Instantiating it is nothing new — wire the covers, take the `minimal` output:

```prolog
# order-demo.dl
cover(1, 2). cover(1, 3). cover(2, 4). cover(3, 4).
input predicate bottom(x: integer) := minimal from "order.dl"(cover = cover).
?- bottom(X).            # 1
```

The new part is the three `!-` lines. A module's constraints survive elaboration
and are checked **once per instance, against the data actually wired in** — and,
as in Chapter 10, before any query runs, so a violation yields no results at all.
`order.dl` therefore does not merely document what it wants of an order; it
enforces it at every use site. Point it at covers that form a cycle and its laws
fire, all of them, not just the first:

```
$ datamog order-cycle.dl
order-cycle.dl: Constraint `!- lt(X, X).` is violated by 3 rows:
  X = 1
  X = 2
  X = 3
Constraint `!- lt(X, Y), lt(Y, X).` is violated by 9 rows:
  X = 1, Y = 2
  ... and 8 more
```

The message quotes the law as *the module author* wrote it, over the *importer's*
data. That is a different kind of check from the boundary types above: a type says
what shape may cross the boundary, a law says what must be true of what actually
crossed.

> **Imperative lens.** An interface with default methods, whose contract is
> executable. A Java interface can demand a `compareTo`; its documentation can
> *ask* you to make it a total order; nothing checks that you did. Here the ask
> is a constraint, and it runs on your data.

### Overriding a default

Look again at `lt`. It is an input — a parameter — but it carries a `:=` binding,
so an importer who says nothing about it gets the transitive closure of `cover`,
computed by the `reach.dl` from the start of this chapter. That makes the binding
a **default**: wire an actual for that input and yours wins instead.

```prolog
# order-override.dl -- we already know the order, so skip the closure
cover(1, 2). cover(1, 3). cover(2, 4). cover(3, 4).
known(1, 2). known(1, 3). known(1, 4). known(2, 4). known(3, 4).
input predicate bottom(x: integer) := minimal from "order.dl"(cover = cover, lt = known).
?- bottom(X).            # 1, as before
```

Same answer, less machinery: `--dry-run` on `order-demo.dl` shows a recursive view
for the closure, and on `order-override.dl` shows none, because an overridden
default is never instantiated at all. The laws still apply — wire a `lt` that is
not a strict order and `order.dl` rejects it exactly as it rejects bad covers.

So importing a module is not all-or-nothing. It supplies an algorithm, plus
defaults for the parts it can work out by itself; you supply the parts only you
know, and replace any default you can do better. That is the abstract class with
overridable hooks, written entirely with `input predicate`s.

### One import, several operations

An import site selects **one** output, which looks thin for an interface with
several operations. It is not: bind the module once per output you want, wired the
same way each time, and the instances are shared. `order.dl` already exports a
`maximal` alongside its `minimal`, so take both:

```prolog
# order-both.dl
input predicate lo(x: integer) := minimal from "order.dl"(cover = cover).
input predicate hi(x: integer) := maximal from "order.dl"(cover = cover).
?- lo(L), hi(H).
```

`--dry-run` shows one closure, one `elem`, one `minimal`, one `maximal`, and two
alias views. The algorithm is paid for once no matter how many of its outputs you
take, which is what makes an interface with a dozen operations practical.

There is still a reason to hand back several operations as *one* relation, tagging
each with a constructor ([Chapter 15](15-proof-terms.md)): a single relation is a
single value you can pass on as one actual, where several outputs would need
several inputs.

```prolog
# ops.dl
input predicate cover(a: integer, b: integer).

lt(X, Y) :- cover(X, Y).
lt(X, Z) :- lt(X, Y), cover(Y, Z).

elem(X) :- cover(X, _).
elem(X) :- cover(_, X).

output predicate op() :: Lt(X, Y)   :- lt(X, Y).
output predicate op() :: Minimal(X) :- elem(X), not lt(_, X).
```

One import, and the constructors come qualified by the name you gave it, so the
importer unpacks whichever operations it wants:

```prolog
# ops-demo.dl
cover(1, 2). cover(1, 3). cover(2, 4). cover(3, 4).
input predicate ord(o: value) := op from "ops.dl"(cover = cover).

output predicate below(X, Y) :- P : ord, P = ord::Lt(X, Y).
output predicate bottom(X)   :- P : ord, P = ord::Minimal(X).
?- bottom(X).            # 1
```

A method dictionary, passed as a relation. It costs a `value` column and a match
per use. Note that `ord` carries nothing but its proof term, so read it with a
capture (`P : ord`) and print the operations you derive from it, not `ord` itself.

One wrinkle in how this is bound. Because a constructor is qualified by the
predicate it lands on, `ops.dl`'s output is *renamed* to `ord` rather than aliased,
so that you can write `ord::Lt`. An alias rule could not do the job: a pass-through
rule does not inherit proof-carrying-ness, so `q(X, Y) :- p(X, Y).` quietly drops
`p`'s proof, and capturing from `q` is an error. Bind the same module twice the
same way and the second name simply *becomes* the first predicate — one relation,
one `Lt` — at the price of the second declaration's column labels, and the shared
relation printing once. Wire them differently and you get two instances with
distinct constructors, which is what the `option.dl` example above relies on.

## A few rules of the road

- **`from` distinguishes the two bindings.** `from` present is a module; a bare
  string is a data file. `from`, `as` (and `input`/`output`/`predicate`) are
  contextual keywords — you can still name a column `from` or `to`.
- **One output per import.** An instance exposes only the output you select; the
  module's other outputs and its `?-` default stay internal.
- **A `:=` binding on an input is a default.** An actual the importer wires for
  that input overrides it, and the default is then not instantiated. An actual
  naming something that is not an input of the module is an error, not a silent
  no-op — otherwise a typo would quietly leave the default in place.
- **A module's constraints travel with it.** Its `!-` and `error predicate` rules
  are checked once per instance against the wired data (its `?-` default, by
  contrast, is dropped unless you select it).
- **Every distinct wiring is a fresh copy**, freshened so instances never
  collide. Freshened names contain `$`, which no source identifier can, so they
  never clash with yours. That covers an input the module bound to a data file
  too: each instance loads its own copy, under a name you never see.
- **Identical wirings share one copy.** Same module, same actuals, same instance.
  For a plain output each binding gets its own alias and its own column labels; for
  a proof-carrying one the second binding adopts the first's predicate outright, so
  the constructor is shared, the second declaration's labels go unused, and the one
  relation prints once under the first name rather than once per binding. For your
  own labels on it, project it: `mine(derivation) :- derivation : a.`
- **The instantiation graph must be acyclic.** Mutually recursive predicates
  share a file.
- **A module never auto-loads its inputs.** Every input of an imported module
  must be *supplied* — wired with an actual, or bound with `:= "file"` (resolved
  relative to the module). An input that is neither is an error, not an empty
  relation. Auto-loading `<name>.csv` by convention is a convenience the CLI (and
  the playground) offer for the *entry* program's own inputs only, so a module is
  self-contained and behaves the same wherever it is imported.

## Exercises

### Exercise 16.1 — Point it somewhere new ★

Add a third relation to `main.dl` — say a `friend` graph in `friend.csv` — and a
third binding `friend_reach := reach from "reach.dl"(edge = friend)`. Confirm
`--all` now reports three closures from the one `reach.dl`.

### Exercise 16.2 — A data-file binding ★

Rename `road.csv` to `roads.tsv` (still comma-separated) and bind `road` to it
explicitly with `:= "roads.tsv" as csv`. Why is the `as csv` needed here, and
what happens without it?

### Exercise 16.3 — Filter, then reach ★★★

Write `filter.dl` with an input `raw(a: integer, b: integer)` and an output
`kept` that drops self-loops (`a <> b`). In `main.dl`, bind a `clean` input to an
instance of `filter.dl`, then wire `reach.dl`'s `edge` to `clean` instead of
straight to `road`, so the closure runs over the filtered edges. (This chains two
modules — `filter`'s output into `reach`'s input; the instantiation graph is a
chain, not a cycle, so it is fine.)

### Exercise 16.4 — Break the contract ★★

Declare `road_reach(a: string, b: string)` and run it. Read the error. Then wire
`edge` to a relation whose columns are strings and run again. Which boundary does
each error name, and at what point in the pipeline is it caught?

### Exercise 16.5 — A parameterised pair ★★★

Following `option.dl`, write `pair.dl` parameterised over *two* element
predicates `left` and `right`, whose proof terms are `Pair(l, r)` for each `l`
in `left` and `r` in `right`. Instantiate it as `pr` and match its constructor
(`pr::Pair(L, R)`) to recover the pairs — a poor-man's two-argument type
constructor, `Pair<A, B>`. What happens if you wire both parameters to the same
relation?

### Exercise 16.6 — Break a law ★

In `order-override.dl`, wire `lt` to a relation that is not transitive (drop
`known(1, 4)`). Which of `order.dl`'s three laws catches it, and what does the
error say? Then make it reflexive as well and see how many fire at once.

### Exercise 16.7 — Watch sharing appear and disappear ★★

Run `--dry-run` on `order-both.dl` and count the views: two bindings, one copy of
the module. Now change one binding to wire `cover` to a different relation (add
`other(5, 6).` and wire that) and count again. Explain both counts. Finally, give
`ops.dl` a third operation, `Maximal(X)`, recover it in `ops-demo.dl`, and say
which of the two styles you would rather write.

### Exercise 16.8 — A law that only the importer can state ★★★

`order.dl` cannot know whether its order should be *total*. Add that law
(`!- elem(X), elem(Y), X <> Y, not lt(X, Y), not lt(Y, X).`) to a copy of the
module and instantiate it against the diamond covers from `order-demo.dl`. Why
does it fire? Where should such a law live — in the module, or in the importer?

---

Next: **[Chapter 17 — Recursion through negation](17-parity.md)**. The one
place Datamog relaxes Chapter 8's ban on negation inside a cycle, and why
"every child is constant" needs it.
