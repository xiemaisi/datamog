# Catch the fire starter

> Adapted from [Catch the fire starter](https://codeql.github.com/docs/writing-codeql-queries/catch-the-fire-starter/) in the CodeQL QL tutorials.

After solving the crown theft, you have earned the trust of the villagers. Now
they come to you with a new problem: someone set fire to the crops in the north
field, and the harvest is ruined.

A reliable informant tells you that the criminals live in the **south** quarter.
You also learn that the king recently decreed that **children under 10 are not
allowed to leave their home quarter**. Finally, a witness who spotted two
figures fleeing the scene says they were both **bald**.

This tutorial teaches you how to define **derived predicates** — rules that
give names to useful concepts — and how to **compose** them to build complex
queries from simple building blocks.

## The village data

For this investigation, you have a smaller set of people in the village (some
have moved away since the theft). Define the data directly as facts:

```prolog
person("anna", 35, "brown", "north").
person("brian", 8, "blond", "north").
person("clara", 42, "black", "south").
person("derek", 6, "brown", "south").
person("emma", 55, "bald", "south").
person("frank", 38, "bald", "south").
person("gina", 28, "red", "south").
person("henry", 9, "black", "south").
person("iris", 47, "brown", "east").
person("jake", 31, "blond", "west").
```

Each fact gives a person's name, age, hair color, and home quarter.

## Step 1: Who lives in the south?

Your informant says the criminals live in the south. Start by defining a
predicate that identifies southerners:

```prolog
southerner(X) :- person(X, _, _, "south").
```

This is a **derived predicate** — Datamog compiles it to a SQL view. Think of
it as giving a name to a useful concept. You can now use `southerner(X)` in
other rules without repeating the filter condition.

### Exercise

Query for all southerners.

<details>
<summary>Solution</summary>

```prolog
?- southerner(X).
```

Result: clara, derek, emma, frank, gina, henry.

</details>

## Step 2: Who is a child?

The king's decree restricts children under 10. Define another derived
predicate:

```prolog
child(X) :- person(X, Age, _, _), Age < 10.
```

### Exercise

Query for all children.

<details>
<summary>Solution</summary>

```prolog
?- child(X).
```

Result: brian (8), derek (6), henry (9).

</details>

## Step 3: Who could travel to the north?

Now comes the interesting part: composing predicates. A southerner can travel
to the north **unless** they are a child. You already have predicates for both
concepts, so you can combine them:

```prolog
can_travel_north(X) :- southerner(X), not child(X).
```

Read this as: "X can travel north if X is a southerner and X is **not** a
child."

The `not` operator here uses **stratified negation** — Datamog evaluates
`child` first, then uses the results to filter `southerner`. Under the hood,
this becomes a `NOT EXISTS` subquery in SQL.

### Exercise

Query for all people who can travel north.

<details>
<summary>Solution</summary>

```prolog
?- can_travel_north(X).
```

Result: clara, emma, frank, gina. (derek and henry are children, so they
cannot leave the south.)

</details>

## Step 4: Who is bald?

The witness saw bald people. Define a predicate for baldness:

```prolog
bald(X) :- person(X, _, "bald", _).
```

## Step 5: Find the fire starters

Now put it all together. The fire starters are people who:
1. Could travel to the north (`can_travel_north`)
2. Are bald (`bald`)

### Exercise

Write a `fire_starter` rule and query for the culprits.

<details>
<summary>Hint</summary>

Combine the two predicates you already defined. No new conditions needed.

</details>

<details>
<summary>Solution</summary>

```prolog
fire_starter(X) :- can_travel_north(X), bald(X).

?- fire_starter(X).
```

Result: **emma** and **frank**.

</details>

## The complete program

```prolog
person("anna", 35, "brown", "north").
person("brian", 8, "blond", "north").
person("clara", 42, "black", "south").
person("derek", 6, "brown", "south").
person("emma", 55, "bald", "south").
person("frank", 38, "bald", "south").
person("gina", 28, "red", "south").
person("henry", 9, "black", "south").
person("iris", 47, "brown", "east").
person("jake", 31, "blond", "west").

southerner(X) :- person(X, _, _, "south").
child(X) :- person(X, Age, _, _), Age < 10.
can_travel_north(X) :- southerner(X), not child(X).
bald(X) :- person(X, _, "bald", _).
fire_starter(X) :- can_travel_north(X), bald(X).

?- fire_starter(X).
```

## Concepts introduced

- **Derived predicates**: rules that name useful concepts (`southerner`,
  `child`, `bald`), compiled to SQL views
- **Rule composition**: building complex predicates from simpler ones
  (`can_travel_north` uses `southerner` and `child`;
  `fire_starter` uses `can_travel_north` and `bald`)
- **Stratified negation**: `not predicate(...)` excludes matches;
  Datamog evaluates predicates in dependency order so negation is well-defined

### A note on design

In a language like CodeQL, you might model "southerner" or "child" as
**classes** that override behavior. Datamog takes a different approach: every
concept is a **predicate**, and you compose them using rules. This is the
essence of Datalog — everything is a logical relation, and complex queries are
built by chaining simple relations together.

The complete program is [`packages/cli/examples/catch-the-fire-starter/`](../../packages/cli/examples/catch-the-fire-starter/).

## What's next?

Emma and frank are locked up. But now the kingdom faces a succession crisis.
Continue to [Crown the rightful heir](04-crown-the-rightful-heir.md) to learn
about recursion and transitive closure.
