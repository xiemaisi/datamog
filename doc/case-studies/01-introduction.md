# Introduction to Datamog

> Adapted from the [CodeQL QL tutorials](https://codeql.github.com/docs/writing-codeql-queries/ql-tutorials/).

Datamog is an educational Datalog implementation. You write logic programs in
Datalog, and Datamog either compiles them to SQL and runs them against a
database, or evaluates them directly with an in-memory interpreter, then shows
you the results.

This tutorial introduces the core building blocks of the language: **facts**,
**rules**, and **queries**.

## Facts

The simplest Datamog program consists of **facts** — things that are
unconditionally true. A fact looks like a predicate name followed by arguments
in parentheses, terminated by a period:

```prolog
color("sky", "blue").
color("grass", "green").
color("fire", "red").
```

Each fact declares that a certain relationship holds between its arguments.
Here, `color("sky", "blue")` says the sky is blue.

Arguments can be **strings** (in double quotes), **integers**, or **float
numbers**:

```prolog
flight("london", "new_york", 9.0).
flight("madrid", "paris", 1.5).
flight("paris", "new_york", 10.0).
```

## Rules

A **rule** derives new facts from existing ones. It has a **head** (the
conclusion) and a **body** (the conditions), separated by `:-` (read as "if"):

```prolog
european_city(City) :- flight(City, _, _).
european_city(City) :- flight(_, City, _).
```

This says: `City` is a European city if it appears as either endpoint of a
flight. (We cheat a bit — New York sneaks in. We will fix that later.)

Notice the **variables** `City` — they start with an **uppercase letter**.
The **underscore** `_` is a special "don't care" variable that matches anything
without creating a binding.

When multiple rules share the same head predicate, they act as alternatives —
a fact is derived if **any** of the rules fires. This is how Datamog expresses
disjunction (logical "or").

## Queries

A **query** asks Datamog to evaluate a predicate and show the results:

```prolog
?- european_city(X).
```

Variables in queries become output columns. Running this would display all
values of `X` for which `european_city(X)` holds.

## A complete program

Putting it all together — save this as `flights.dl`:

```prolog
flight("london", "new_york", 9.0).
flight("madrid", "paris", 1.5).
flight("paris", "new_york", 10.0).

# Routes: direct or multi-hop
travel(X, Y, T) :- flight(X, Y, T).
travel(X, Y, T) :- flight(X, Z, T1), travel(Z, Y, T2), T = T1 + T2.

?- travel(X, Y, T).
```

Run it:

```bash
bun run datamog flights.dl
```

The `travel` predicate has two rules:
1. A direct flight is a travel route.
2. If there is a flight from `X` to `Z`, and a travel route from `Z` to `Y`,
   then there is a route from `X` to `Y` whose time is the sum of the legs.

The second rule is **recursive** — `travel` refers to itself. Datamog handles
this by generating a SQL recursive view. We will explore recursion in depth in
[Tutorial 4](04-crown-the-rightful-heir.md).

Lines starting with `#` are **comments**.

## Conditions in rule bodies

A rule body can contain several kinds of conditions, separated by commas
(logical "and"):

**Atoms** — references to other predicates:
```prolog
travel(X, Y, T) :- flight(X, Y, T).
```

**Comparisons** — `<`, `>`, `<=`, `>=`, `<>`:
```prolog
long_flight(X, Y) :- flight(X, Y, T), T > 5.0.
```

**Bindings** — compute a value and bind it to a variable:
```prolog
doubled(X, D) :- scores(X, S), D = S * 2.
```

**Negation** — `not` checks that something does *not* hold:
```prolog
no_flight_to(X) :- flight(X, _, _), not flight(_, X, _).
```

## Extensional predicates

So far, we have defined data inline as facts. For larger datasets, you can
declare an **extensional predicate** and load data from a CSV file:

```prolog
input predicate scores(student: string, subject: string, score: integer).
```

This tells Datamog to look for a file named `scores.csv` in the same directory,
with columns `student`, `subject`, and `score`. The supported column types are
`string`, `integer`, `float`, `boolean`, and `value` (for JSON-shaped data).

## Exercises

Try writing short Datamog programs for each of these.

### Exercise 1

Define facts for three countries and their capitals. Write a query that lists
all capitals.

<details>
<summary>Solution</summary>

```prolog
capital("france", "paris").
capital("germany", "berlin").
capital("japan", "tokyo").

?- capital(_, City).
```

</details>

### Exercise 2

Using the `flight` facts from above, write a rule `short_flight(X, Y)` that
finds flights taking less than 5 hours. Query for all short flights.

<details>
<summary>Solution</summary>

```prolog
flight("london", "new_york", 9.0).
flight("madrid", "paris", 1.5).
flight("paris", "new_york", 10.0).

short_flight(X, Y) :- flight(X, Y, T), T < 5.0.

?- short_flight(X, Y).
```

Result: `madrid -> paris` (1.5 hours).

</details>

### Exercise 3

Write a program that defines number facts and computes their squares.

<details>
<summary>Solution</summary>

```prolog
number(1).
number(2).
number(3).
number(4).
number(5).

square(X, S) :- number(X), S = X * X.

?- square(X, S).
```

</details>

### Exercise 4

Define a directed graph using `edge` facts, and write a rule `two_hops(X, Y)`
that finds nodes reachable in exactly two steps.

<details>
<summary>Solution</summary>

```prolog
edge("a", "b").
edge("b", "c").
edge("c", "d").
edge("a", "d").

two_hops(X, Y) :- edge(X, Z), edge(Z, Y).

?- two_hops(X, Y).
```

</details>

## Next steps

You now know the basics of Datamog. In the next tutorial, you will put these
skills to use as a detective solving a mystery:
[Find the thief](02-find-the-thief.md).
