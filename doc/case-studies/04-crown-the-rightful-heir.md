# Crown the rightful heir

> Adapted from [Crown the rightful heir](https://codeql.github.com/docs/writing-codeql-queries/crown-the-rightful-heir/) in the CodeQL QL tutorials.

King Basil has died without naming a successor. The kingdom is in turmoil.
As the village's trusted detective, you are asked to consult the royal family
records and determine who should inherit the crown.

You will learn how to use **recursion** in Datamog to traverse family trees and
answer questions about ancestry.

## The royal family

Here is the family tree:

```
              King Basil +
             /     |      \
    Prince Edmund+ Diana  Prince George+
       /    \     / \         |
    Alice  Bob+  Eve Frank   Henry
            |
          Carol
```

Names marked with `+` are deceased. Define this as facts:

```prolog
parent("basil", "edmund").
parent("basil", "diana").
parent("basil", "george").
parent("edmund", "alice").
parent("edmund", "bob").
parent("diana", "eve").
parent("diana", "frank").
parent("george", "henry").
parent("bob", "carol").

deceased("basil").
deceased("edmund").
deceased("bob").
deceased("george").
```

`parent(X, Y)` means X is a parent of Y.

## Step 1: Finding children

The simplest family query: who are King Basil's children?

```prolog
?- parent("basil", X).
```

Result: edmund, diana, george.

To define "child" as its own predicate (reversing the direction of `parent`):

```prolog
child(X, Y) :- parent(Y, X).
```

Now `child(X, Y)` means X is a child of Y.

## Step 2: Finding grandchildren

Grandchildren are children of children:

```prolog
grandchild(X, Y) :- child(X, Z), child(Z, Y).
```

### Exercise

Query for King Basil's grandchildren.

<details>
<summary>Solution</summary>

```prolog
?- grandchild(X, "basil").
```

Result: alice, bob, eve, frank, henry.

</details>

But what about great-grandchildren? You could define `great_grandchild` with
yet another join. And great-great-grandchildren? This quickly gets tedious. You
need **recursion**.

## Step 3: Ancestors with recursion

An **ancestor** of someone is either:
1. Their parent (base case), or
2. A parent of someone who is already known to be an ancestor (recursive case).

In Datamog:

```prolog
ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
```

The first rule handles the base case. The second rule says: if X is a parent of
Z, and Z is an ancestor of Y, then X is an ancestor of Y.

This is **recursive** — `ancestor` appears in both the head and the body.
Datamog compiles this to a SQL recursive view (Postgres `CREATE RECURSIVE
VIEW`, SQLite/sql.js `CREATE VIEW … AS WITH RECURSIVE`) that iterates until
no new facts are discovered.

### Exercise

Query for all ancestors of carol.

<details>
<summary>Solution</summary>

```prolog
?- ancestor(X, "carol").
```

Result: bob, edmund, basil. The full line of ancestry from carol back to the
king.

</details>

## Step 4: Descendants

The reverse of ancestor — all people descended from a given person:

```prolog
descendant(X, Y) :- ancestor(Y, X).
```

Note the elegant trick: we just flip the arguments. No new recursion needed
since `ancestor` is already recursive.

### Exercise

Query for all descendants of King Basil.

<details>
<summary>Solution</summary>

```prolog
?- descendant(X, "basil").
```

Result: edmund, diana, george, alice, bob, eve, frank, henry, carol.

</details>

## Step 5: Siblings

Two people are siblings if they share a parent:

```prolog
sibling(X, Y) :- parent(P, X), parent(P, Y), X <> Y.
```

The `X <> Y` condition prevents a person from being their own sibling.

### Exercise

Query for all sibling pairs.

<details>
<summary>Solution</summary>

```prolog
?- sibling(X, Y).
```

Result includes: (edmund, diana), (edmund, george), (diana, george), (eve,
frank), (alice, bob), and their symmetric pairs.

</details>

## Step 6: Living descendants

Not all descendants can inherit — some are deceased. Filter them out using
negation:

```prolog
living_descendant(X) :- descendant(X, "basil"), not deceased(X).
```

### Exercise

Query for King Basil's living descendants.

<details>
<summary>Solution</summary>

```prolog
?- living_descendant(X).
```

Result: diana, alice, eve, frank, henry, carol.

</details>

## Step 7: The rightful heir

But wait — frank was caught starting the fire in the
[previous tutorial](03-catch-the-fire-starter.md)! He has a criminal record:

```prolog
criminal("frank").
```

The council decrees that only living descendants **without criminal records**
may inherit:

```prolog
eligible_heir(X) :- living_descendant(X), not criminal(X).
```

### Exercise

Query for all eligible heirs.

<details>
<summary>Solution</summary>

```prolog
?- eligible_heir(X).
```

Result: **diana, alice, eve, henry, carol**.

Diana, as Basil's only surviving child, would likely take the crown.

</details>

## The complete program

```prolog
parent("basil", "edmund").
parent("basil", "diana").
parent("basil", "george").
parent("edmund", "alice").
parent("edmund", "bob").
parent("diana", "eve").
parent("diana", "frank").
parent("george", "henry").
parent("bob", "carol").

deceased("basil").
deceased("edmund").
deceased("bob").
deceased("george").

criminal("frank").

child(X, Y) :- parent(Y, X).
ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
descendant(X, Y) :- ancestor(Y, X).
sibling(X, Y) :- parent(P, X), parent(P, Y), X <> Y.
living_descendant(X) :- descendant(X, "basil"), not deceased(X).
eligible_heir(X) :- living_descendant(X), not criminal(X).

?- eligible_heir(X).
```

## Challenge exercises

These are more open-ended. Try them on your own.

### Challenge 1: Relatives

Two people are **relatives** if they share a common ancestor. Define a
`relative(X, Y)` predicate.

<details>
<summary>Hint</summary>

X and Y are relatives if there exists some ancestor A such that A is an
ancestor of both X and Y.

</details>

<details>
<summary>Solution</summary>

```prolog
relative(X, Y) :- ancestor(A, X), ancestor(A, Y), X <> Y.
```

</details>

### Challenge 2: Nearest heir

Among the eligible heirs, who is **closest** to King Basil (fewest generations
of separation)? Can you write rules that compute the generational distance?

<details>
<summary>Hint</summary>

Define a predicate `distance(X, Y, D)` where D is the number of parent links
between X and Y. The base case has distance 1, and each recursive step adds 1.

</details>

<details>
<summary>Solution</summary>

```prolog
distance(X, Y, 1) :- parent(X, Y).
distance(X, Y, D) :- parent(X, Z), distance(Z, Y, D1), D = D1 + 1.

heir_distance(X, D) :- eligible_heir(X), distance("basil", X, D).
min_distance(min(D)) :- heir_distance(_, D).
nearest_heir(X) :- heir_distance(X, D), min_distance(D).

?- nearest_heir(X).
```

Result: diana (distance 1 — she is Basil's daughter).

</details>

## Aside: Three ways to write transitive closure

> This aside is adapted from the transitive closure examples in the
> [Datalog Educational System (DES)](http://des.sourceforge.net/)
> by Fernando Saenz-Perez.

Our `ancestor` rule uses **right recursion** — the recursive call comes after
the base atom:

```prolog
ancestor(X, Y) :- parent(X, Y).                       # base case
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).       # right-recursive
```

You can also write it with **left recursion** (recursive call first):

```prolog
ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- ancestor(X, Z), parent(Z, Y).       # left-recursive
```

Or even **double recursion** (recursive on both sides):

```prolog
ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- ancestor(X, Z), ancestor(Z, Y).     # double-recursive — non-linear
```

All three produce the same results logically. The first two are *linear* —
each recursive rule body mentions `ancestor` once — and compile via
`WITH RECURSIVE` on every backend. The double-recursive form is *non-linear*
(two `ancestor` atoms in one body); SQL's `WITH RECURSIVE` semantics can't
express it, so every SQL backend rejects it at translation time. The pure
in-memory evaluators `--backend native` and `--backend seminaive` accept it,
since their delta-aware iteration computes the correct fixed point either way.

## Concepts introduced

- **Recursion**: a predicate defined in terms of itself, with a base case to
  terminate; compiles to `WITH RECURSIVE` in SQL
- **Base case + recursive case**: the standard pattern for recursive
  definitions
- **Reusing recursion**: once `ancestor` is defined recursively, `descendant`
  can just flip its arguments — no extra recursion needed
- **Combining recursion with negation**: filter recursive results with `not`
  (Datamog handles the evaluation order via stratification)

The complete program is [`packages/cli/examples/crown-the-rightful-heir/`](../../packages/cli/examples/crown-the-rightful-heir/).

## What's next?

You have mastered recursion. Next you will push it to the limit by encoding a
classic logic puzzle as a Datamog program:
[Cross the river](05-cross-the-river.md).
