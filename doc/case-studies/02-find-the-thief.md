# Find the thief

> Adapted from [Find the thief](https://codeql.github.com/docs/writing-codeql-queries/find-the-thief/) in the CodeQL QL tutorials.

A village is divided into four quarters — north, south, east, and west —
surrounding a castle at its center. One night, a thief breaks into the castle
tower and steals the king's golden crown.

You are a detective. You have a list of all 20 villagers with their name, age,
hair color, height, and the quarter where they live. By questioning witnesses,
you collect a series of yes/no clues about the thief's appearance. Your task:
write a Datamog program that combines all the clues to identify the culprit.

## The village data

The villager data is stored in a CSV file (`person.csv`):

| name  | age | hair  | height | location |
|-------|-----|-------|--------|----------|
| anna  | 25  | blond | 170    | north    |
| brian | 45  | brown | 185    | north    |
| clara | 68  | gray  | 155    | north    |
| derek | 35  | black | 178    | north    |
| emma  | 28  | red   | 162    | north    |
| frank | 50  | bald  | 180    | south    |
| gina  | 22  | blond | 148    | south    |
| henry | 40  | brown | 172    | south    |
| iris  | 55  | gray  | 160    | south    |
| jake  | 32  | black | 192    | south    |
| kate  | 52  | brown | 165    | east     |
| leo   | 45  | blond | 180    | east     |
| mia   | 29  | black | 168    | east     |
| nick  | 33  | brown | 175    | east     |
| olive | 48  | red   | 156    | east     |
| peter | 33  | blond | 188    | west     |
| quinn | 27  | brown | 163    | west     |
| rosa  | 58  | black | 145    | west     |
| sam   | 44  | brown | 177    | west     |
| tara  | 36  | red   | 170    | west     |

Declare this as an extensional predicate:

```prolog
input predicate person(name: string, age: integer, hair: string, height: integer, location: string).
```

## The clues

You question witnesses around the village and collect these answers about the
thief:

| #  | Question                                    | Answer |
|----|---------------------------------------------|--------|
| 1  | Is the thief taller than 150 cm?            | Yes    |
| 2  | Does the thief have blond hair?             | No     |
| 3  | Is the thief bald?                          | No     |
| 4  | Is the thief younger than 30?               | No     |
| 5  | Does the thief live in the east?            | Yes    |
| 6  | Does the thief have black or brown hair?    | Yes    |
| 7  | Is the thief's height between 180 and 190?  | No     |
| 8  | Is the thief the oldest person in the village? | No  |
| 9  | Is the thief the tallest person in the village? | No |
| 10 | Is the thief shorter than the average villager? | Yes |
| 11 | Is the thief the oldest person in the east? | Yes    |

## Exercise 1: Simple conditions

Start with clues 1 through 6. Each clue translates to one or more conditions
in a rule body.

Write a rule `suspect(Name)` that selects every person matching clues 1--6:

- **Clue 1** (taller than 150): `Height > 150`
- **Clue 2** (not blond): `Hair <> "blond"`
- **Clue 3** (not bald): `Hair <> "bald"`
- **Clue 4** (not younger than 30): `Age >= 30`
- **Clue 5** (lives east): `"east"` goes directly in the atom

For **clue 6** (black or brown hair), we hit something new. In Datamog, a rule
body uses commas for "and" — there is no `or` keyword. How do you express
"black **or** brown"?

One approach: write two separate rules for `suspect`, one for each color. But
that would duplicate all the other conditions. A cleaner solution is to define
a small **helper predicate**:

```prolog
dark_hair("black").
dark_hair("brown").
```

Then in the rule body, just write `dark_hair(Hair)`.

<details>
<summary>Hint</summary>

Your rule should look like this, with blanks filled in:

```prolog
suspect(Name) :-
  person(Name, Age, Hair, Height, ___),
  Height > ___,
  Hair <> ___,
  Hair <> ___,
  Age >= ___,
  dark_hair(Hair).
```

</details>

<details>
<summary>Solution</summary>

```prolog
input predicate person(name: string, age: integer, hair: string, height: integer, location: string).

dark_hair("black").
dark_hair("brown").

suspect(Name) :-
  person(Name, Age, Hair, Height, "east"),
  Height > 150,
  Hair <> "blond",
  Hair <> "bald",
  Age >= 30,
  dark_hair(Hair).

?- suspect(X).
```

This narrows it down to two suspects: **kate** and **nick**.

</details>

## Exercise 2: Aggregates and negation

Clues 7--11 involve village-wide properties (oldest, tallest, average). In
Datamog, aggregate functions appear in the **head** of a rule, not inline in
conditions. You need to define helper predicates that compute these values,
then reference them in the main rule.

### Clue 7: Height not between 180 and 190

The condition "height is between 180 and 190" combines two comparisons with
"and". Since we need to **negate** this compound condition, define a helper:

```prolog
height_180_190(Name) :- person(Name, _, _, Height, _), Height > 180, Height < 190.
```

Then use `not height_180_190(Name)` in the suspect rule. This is a common
Datamog pattern: **define a predicate for the condition you want to negate,
then negate the predicate**.

### Clues 8 & 9: Not the oldest / not the tallest

Use the `max` aggregate to compute the maximum age and height:

```prolog
max_age(max(Age)) :- person(_, Age, _, _, _).
max_height(max(Height)) :- person(_, _, _, Height, _).
```

Then in the suspect rule: `max_age(MaxAge), Age <> MaxAge` ensures the suspect
is not the oldest.

### Clue 10: Shorter than average

Use the `avg` aggregate:

```prolog
avg_height(avg(Height)) :- person(_, _, _, Height, _).
```

Then: `avg_height(AvgH), Height < AvgH`.

### Clue 11: Oldest person in the east

Compute the maximum age among east residents only:

```prolog
max_east_age(max(Age)) :- person(_, Age, _, _, "east").
```

Then: `max_east_age(MaxEAge), Age = MaxEAge`.

Now combine everything into the final suspect rule.

<details>
<summary>Hint</summary>

You need to add clue 7--11 conditions to your rule from Exercise 1. The body
will reference the aggregate helper predicates to bring their computed values
into scope.

</details>

<details>
<summary>Solution</summary>

```prolog
input predicate person(name: string, age: integer, hair: string, height: integer, location: string).

dark_hair("black").
dark_hair("brown").

height_180_190(Name) :- person(Name, _, _, Height, _), Height > 180, Height < 190.

max_age(max(Age)) :- person(_, Age, _, _, _).
max_height(max(Height)) :- person(_, _, _, Height, _).
avg_height(avg(Height)) :- person(_, _, _, Height, _).
max_east_age(max(Age)) :- person(_, Age, _, _, "east").

suspect(Name) :-
  person(Name, Age, Hair, Height, "east"),
  Height > 150,
  Hair <> "blond",
  Hair <> "bald",
  Age >= 30,
  dark_hair(Hair),
  not height_180_190(Name),
  max_age(MaxAge), Age <> MaxAge,
  max_height(MaxH), Height <> MaxH,
  avg_height(AvgH), Height < AvgH,
  max_east_age(MaxEAge), Age = MaxEAge.

?- suspect(X).
```

The thief is **kate**!

</details>

## Concepts introduced

- **Conjunction**: comma-separated conditions in a rule body mean "and"
- **Disjunction**: use a helper predicate with multiple facts (or multiple rules for the same head) to express "or"
- **Comparisons**: `>`, `<`, `>=`, `<=`, `<>` in rule bodies
- **Negation**: `not predicate(...)` — define what you want to negate as a predicate, then negate it
- **Aggregates**: `max`, `min`, `avg`, `count`, `sum` appear in rule heads; reference the derived values in other rules

## What's next?

The thief is behind bars, but trouble is not over. Continue to
[Catch the fire starter](03-catch-the-fire-starter.md) to learn about
composing derived predicates.
