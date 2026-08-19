# Chapter 3 — Multiple rules and disjunction

In Chapter 2 we defined an IDB predicate by giving it *one* rule. In
Exercise 2.2 we sneakily gave `person` *two* rules with the same
head. This chapter pulls that trick into daylight: **multiple rules
for the same predicate** is how Datalog expresses disjunction.

It's a small idea. But combined with what we already have — facts
and one-rule-per-predicate joins — it's the last non-recursive
ingredient. Once we add recursion in Chapter 4, everything that
"pure Datalog" can do is on the table.

## Two rules, one predicate

Our family gets a new extensional predicate: `marriage`. Look at
[`code/ch03/marriage.csv`](code/ch03/marriage.csv):

```csv
p1,p2
alice,bob
cecil,diana
erin,frank
```

Three marriages. Notice that `marriage(alice, bob)` is there but
`marriage(bob, alice)` isn't — the CSV records each marriage once,
in whichever order we happened to write it. That's a deliberate
choice, and it sets up our first use of multiple rules.

From [`code/ch03/family.dl`](code/ch03/family.dl):

```prolog
spouse(X, Y) :- marriage(X, Y).
spouse(X, Y) :- marriage(Y, X).
```

Two rules, same head predicate `spouse`, same arity. Read together,
they say:

> `X` is a spouse of `Y` **if** `marriage(X, Y)` is a fact, **or if**
> `marriage(Y, X)` is a fact.

That "or" is exactly what multiple rules give you. There is no `or`
or `;` inside a rule body in pure Datalog; disjunction lives at the
*predicate* level — you write it by providing several rules.

Run the program:

```bash
bun run datamog doc/walkthrough/code/ch03/family.dl
```

and you'll see `spouse("alice", X)` returns `bob`, while `spouse(X,
"frank")` returns `erin` — both directions work, because each
marriage contributes two facts to `spouse` via the two rules.

**[Open this program in the playground →](https://xiemaisi.github.io/datamog/#p=parent(%22alice%22%2C%20%22erin%22).%0Aparent(%22bob%22%2C%20%22erin%22).%0Aparent(%22cecil%22%2C%20%22frank%22).%0Aparent(%22diana%22%2C%20%22frank%22).%0Aparent(%22erin%22%2C%20%22greg%22).%0Aparent(%22erin%22%2C%20%22helen%22).%0Aparent(%22frank%22%2C%20%22greg%22).%0Aparent(%22frank%22%2C%20%22helen%22).%0Amarriage(%22alice%22%2C%20%22bob%22).%0Amarriage(%22cecil%22%2C%20%22diana%22).%0Amarriage(%22erin%22%2C%20%22frank%22).%0A%23%20Tutorial%2C%20chapter%203%20%E2%80%94%20multiple%20rules%20and%20disjunction.%0A%23%0A%23%20Same%20family%20as%20ch02%2C%20now%20with%20marriages%3A%0A%23%0A%23%20%20%20alice%20-%20bob%20%20%20%20%20%20cecil%20-%20diana%0A%23%20%20%20%20%20%20%20%5C%20%20%2F%20%20%20%20%20%20%20%20%20%20%20%20%20%20%5C%20%20%2F%0A%23%20%20%20%20%20%20%20erin%20-----------%20frank%0A%23%20%20%20%20%20%20%20%20%20%20%20%20%20%20%2F%20%20%20%20%20%20%5C%0A%23%20%20%20%20%20%20%20%20%20%20%20greg%20%20%20%20%20helen%0A%0A%23%20Symmetric%20relation%3A%20two%20rules%20that%20flip%20the%20argument%20order.%0Aspouse(X%2C%20Y)%20%3A-%20marriage(X%2C%20Y).%0Aspouse(X%2C%20Y)%20%3A-%20marriage(Y%2C%20X).%0A%0A%23%20Union%20of%20three%20sources%3A%20X%20and%20Y%20are%20close%20kin%20if%20either%20is%20the%0A%23%20other's%20parent%2C%20or%20if%20they%20are%20spouses.%0Aclose_kin(X%2C%20Y)%20%3A-%20parent(X%2C%20Y).%0Aclose_kin(X%2C%20Y)%20%3A-%20parent(Y%2C%20X).%0Aclose_kin(X%2C%20Y)%20%3A-%20spouse(X%2C%20Y).%0A%0A%3F-%20spouse(%22alice%22%2C%20X).%0A%0Aoutput%20predicate%20frank_spouse(X)%20%3A-%20spouse(X%2C%20%22frank%22).%0Aoutput%20predicate%20erin_kin(X)%20%3A-%20close_kin(%22erin%22%2C%20X).%0A)**

## Union of sources

You don't need the two rules to be "symmetry flips" of each other;
they can draw from completely different predicates. Continuing in
`family.dl`:

```prolog
close_kin(X, Y) :- parent(X, Y).
close_kin(X, Y) :- parent(Y, X).
close_kin(X, Y) :- spouse(X, Y).
```

Three rules, one head. `close_kin(X, Y)` holds if `X` is a parent of
`Y`, **or** `Y` is a parent of `X`, **or** `X` and `Y` are spouses.

Querying Erin's close kin returns her two parents, her two children,
and her spouse:

```
frank  alice  bob  helen  greg
```

The same predicate compresses three ways of being related into one
conceptual relation. That's the value of disjunction at the
predicate level: it lets you name a concept whose definition has
several cases.

## A few ground rules (no pun intended)

When a predicate has multiple rules, Datamog enforces a couple of
consistency requirements:

- **Same arity.** All rules for `close_kin` define a binary
  predicate; you cannot mix in a third rule like
  `close_kin(X) :- ...`.
- **Column types combine, never clash.** The head-argument types from
  each rule are joined: `integer`/`float` widen to `float`, and any other
  primitive mismatch (say an `integer` first column from one rule and a
  `string` from another) widens to `value`, holding both shapes as JSON.
  Unlike an arity mismatch, this never rejects the program.
- **Set semantics.** The resulting relation is the *union of sets*.
  If two rules would derive the same tuple, it appears once in the
  output, not twice.

None of these should surprise you; they're all the natural
"predicate is a relation, and relations are sets" discipline from
Chapter 1.

> **Logic lens.** A rule like `spouse(X, Y) :- marriage(X, Y).` is
> a universally-quantified Horn clause:
>
> ```
> ∀X, Y. marriage(X, Y) → spouse(X, Y)
> ```
>
> Two rules for the same head give you two implications with the
> same conclusion:
>
> ```
> ∀X, Y. marriage(X, Y) → spouse(X, Y)
> ∀X, Y. marriage(Y, X) → spouse(X, Y)
> ```
>
> Read "forwards", that's disjunction: `spouse(X, Y)` is true if
> *any* of its rules fires. Read "backwards" — looking at what is
> *required* for `spouse` to be true — there's a dual view called
> the **Clark completion**, which says `spouse(X, Y)` holds *iff*
> at least one of the rule bodies holds:
>
> ```
> ∀X, Y. spouse(X, Y) ↔ (marriage(X, Y) ∨ marriage(Y, X))
> ```
>
> That biconditional is the "closed-world" reading of a Datalog
> program. We don't need it yet, but it matters the moment we
> introduce negation in Chapter 8.

> **SQL lens.** Run with `--dry-run` and look at `spouse`:
>
> ```sql
> CREATE VIEW IF NOT EXISTS "spouse" AS
>   SELECT __b0."p1" AS col1, __b0."p2" AS col2 FROM "marriage" AS __b0
>   UNION
>   SELECT __b0."p2" AS col1, __b0."p1" AS col2 FROM "marriage" AS __b0
> ;
> ```
>
> Each rule becomes a `SELECT`; multiple rules are joined with
> `UNION`. That's why a predicate with *N* rules compiles to an
> *N*-way UNION inside one view. `close_kin` is exactly the same
> pattern with three branches:
>
> ```sql
> CREATE VIEW IF NOT EXISTS "close_kin" AS
>   SELECT __b0."parent_name" AS col1, __b0."child_name" AS col2 FROM "parent" AS __b0
>   UNION
>   SELECT __b0."child_name" AS col1, __b0."parent_name" AS col2 FROM "parent" AS __b0
>   UNION
>   SELECT __b0."col1" AS col1, __b0."col2" AS col2 FROM "spouse" AS __b0
> ;
> ```
>
> (That's the default SQLite output — Postgres uses `CREATE OR REPLACE VIEW` instead. The view body is identical.)
>
> SQL's `UNION` (without `ALL`) deduplicates by default — matching
> Datalog's set semantics for free.

## Why disjunction lives at the predicate level

One reasonable reaction: "why can't I just write
`spouse(X, Y) :- marriage(X, Y) ; marriage(Y, X).` with a `;` for
disjunction inside the body?" Prolog does allow that. Pure Datalog
doesn't, and neither does Datamog. There are two reasons, one
pragmatic and one theoretical:

- **Pragmatic.** Every Datalog rule compiles to one SQL `SELECT`.
  Forcing disjunction to the predicate level keeps that mapping
  one-to-one, which makes the translation simple to read and reason
  about.
- **Theoretical.** In first-order logic, `A ∨ B → C` is equivalent
  to `(A → C) ∧ (B → C)` — two separate implications. Writing the
  disjunction at the head level and distributing it over multiple
  rules is the *normal form* for Horn clauses. Pure Datalog
  requires that normal form.

You sometimes see Datalog variants with a `|` or `;` body operator
as sugar that desugars to multiple rules before analysis. Datamog
doesn't, so you write the rules out.

## Recap

- A predicate can be defined by **several rules** with the same head;
  the predicate's extent is the *union* of what each rule derives.
- There is no body-level `∨` / `;` in Datamog. Disjunction is always
  expressed by having multiple rules.
- Through the **logic lens**, each rule is one Horn clause; the
  set of rules is a conjunction of implications with a shared
  conclusion. Through the **SQL lens**, multiple rules for one
  head compile to a `UNION` of `SELECT`s inside a single view.

## Exercises

### Exercise 3.1 — In-laws ★

Starter: [`code/ch03/ex1-inlaws.dl`](code/ch03/ex1-inlaws.dl)

Define `in_law(X, Y)` meaning "`X` is an in-law of `Y`" via three
rules:

1. a parent of `Y`'s spouse,
2. a child of `Y`'s spouse,
3. the spouse of `Y`'s parent (and not `Y`'s own parent).

You don't need inequality for (3); `spouse` excludes "self" already,
because we never wrote `marriage(alice, alice)`. Query `?-
in_law(X, "erin").` and check you get reasonable results.

### Exercise 3.2 — Union with overlap ★★

Starter: [`code/ch03/ex2-overlap.dl`](code/ch03/ex2-overlap.dl)

Define `involved_in_family(P)` via *two* rules:

1. `P` is a parent (appears on the left of `parent`).
2. `P` is a spouse (appears in a `marriage` fact, either column).

Everyone in our data appears in *at least one* of those — most
appear in both. Show that even when rules overlap, the result has
no duplicates, by counting the distinct rows in the answer. Compare
the generated SQL with and without the second rule (cut it out,
`--dry-run`, then paste it back).

### Exercise 3.3 — Symmetric closure ★★

Given a directed `edge(X, Y)` relation, define `undirected(X, Y)` —
the symmetric closure, which contains both `(X, Y)` and `(Y, X)` for
every edge. Write it using multiple rules. (Starter:
[`code/ch03/ex3-undirected.dl`](code/ch03/ex3-undirected.dl), which
declares a small `edge` EDB with its own `edge.csv`.)

### Exercise 3.4 — Read the SQL ★★

Take the three-rule `close_kin` definition from `family.dl` and
mentally (then with `--dry-run`) work out:

1. How many `SELECT`s appear inside the `close_kin` view?
2. Why is one of them reading from `"spouse"` rather than
   `"marriage"`, even though `spouse` itself was defined by two
   rules on top of `marriage`?
3. What would change in the SQL if we added a fourth rule
   `close_kin(X, X) :- parent(X, _).` (everyone is their own close
   kin, say)? Predict the shape of the generated `SELECT`.

### Exercise 3.5 — Disjunction as multiple predicates ★★★

Starter: [`code/ch03/ex5-refactor/`](code/ch03/ex5-refactor/)

Take this "one predicate, three rules" definition:

```prolog
can_see(X, Y) :- same_room(X, Y).
can_see(X, Y) :- same_room(Y, X).
can_see(X, Y) :- connected_window(X, Y).
```

and refactor it into three *separate* predicates
(`in_room_with_reflexive`, `spots_through_window`, …) plus a fourth
`can_see` that takes the union. What are the tradeoffs? When does
the three-rules-in-one-predicate form read better, and when does
the refactored form? (No single "right" answer — jot down the
tradeoffs; the solution file compares both.)

---

Next: **[Chapter 4 — Recursion and transitive closure](04-recursion.md).**
Our rules so far have been "one step". Once we allow a predicate to refer to
*itself* in its body, we can define unboundedly deep relationships — ancestors,
reachability, shortest paths — and the language suddenly becomes a general-purpose
fixed-point engine.
