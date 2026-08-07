# Cross the river

> Adapted from [Cross the river](https://codeql.github.com/docs/writing-codeql-queries/cross-the-river/) in the CodeQL QL tutorials.

A farmer needs to ferry a wolf, a goat, and a cabbage across a river. The boat
can carry the farmer plus at most one item. If left unattended, the wolf eats
the goat, and the goat eats the cabbage. Can the farmer get everything across
safely?

This classic logic puzzle is a perfect fit for Datamog: model the state space
as facts and rules, then let the database engine find the solution through
recursive exploration.

## Step 1: Model the shores

Each entity (farmer, wolf, goat, cabbage) is on one of two shores. Define the
shores and a way to get the opposite shore:

```prolog
shore("n").
shore("s").

opp("n", "s").
opp("s", "n").
```

## Step 2: Represent state

A state is a 4-tuple `(Farmer, Wolf, Goat, Cabbage)` recording which shore
each entity is on. The initial state has everyone on the north shore:

```prolog
state("n", "n", "n", "n").
```

This is a fact — the starting configuration of the puzzle.

## Step 3: Define safety

A state is **safe** if no unattended eating can occur. The danger cases are:
- The wolf is alone with the goat (farmer elsewhere) — wolf eats the goat
- The goat is alone with the cabbage (farmer elsewhere) — goat eats the cabbage

A state is safe if:
1. The farmer is with the goat — then neither threat applies (the farmer
   prevents both), or
2. The farmer is **not** with the goat — then the wolf and cabbage must both
   be with the farmer (so neither predator is near its prey).

```prolog
# Case 1: farmer is with the goat — wolf and cabbage can be anywhere
safe(X, Y, X, V) :- shore(X), shore(Y), shore(V).

# Case 2: farmer is not with the goat — wolf and cabbage must be with farmer
safe(X, X, G, X) :- opp(X, G).
```

In case 1, the farmer and goat share position `X`. The wolf (`Y`) and cabbage
(`V`) can be on any shore.

In case 2, the farmer, wolf, and cabbage are all at position `X`, while the
goat is on the opposite shore `G`.

### Exercise

Think about why case 2 requires `opp(X, G)` instead of just `shore(X), shore(G)`.

<details>
<summary>Answer</summary>

We said case 2 applies when the farmer is **not** with the goat. Using
`opp(X, G)` ensures the goat is on the **other** shore from the farmer. If we
used `shore(X), shore(G)` we would also include the case where `X = G`, which
would mean the farmer IS with the goat — that is already covered by case 1 and
could lead to unsafe states being marked safe.

</details>

## Step 4: Transitions

The farmer can make four kinds of moves:
1. Take the wolf across
2. Take the goat across
3. Take the cabbage across
4. Cross alone (empty boat)

Each move flips the farmer to the opposite shore. If the farmer takes an item,
that item also flips. The new state must be safe.

```prolog
# Farmer takes the wolf
state(X, X, U, V) :- safe(X, X, U, V), opp(X, X1), state(X1, X1, U, V).

# Farmer takes the goat
state(X, Y, X, V) :- safe(X, Y, X, V), opp(X, X1), state(X1, Y, X1, V).

# Farmer takes the cabbage
state(X, Y, U, X) :- safe(X, Y, U, X), opp(X, X1), state(X1, Y, U, X1).

# Farmer crosses alone
state(X, Y, U, V) :- safe(X, Y, U, V), opp(X, X1), state(X1, Y, U, V).
```

Look at the pattern carefully. Take the first rule (farmer takes the wolf):
- The **new** state is `(X, X, U, V)` — farmer and wolf are both at position X
- We require `safe(X, X, U, V)` — the new state must be safe
- We require `opp(X, X1)` — X1 is the opposite shore
- We require `state(X1, X1, U, V)` — in the **previous** state, farmer and
  wolf were both at X1, while goat (U) and cabbage (V) stayed put

This is **recursive** — `state` is defined in terms of itself. Datamog keeps
applying these rules until no new states are discovered, effectively performing
a breadth-first exploration of the state space.

## Step 5: Query for the goal

The goal is to get everyone to the south shore:

```prolog
?- state("s", "s", "s", "s").
```

If this returns a result, the puzzle is solvable!

## The complete program

```prolog
shore("n").
shore("s").

opp("n", "s").
opp("s", "n").

state("n", "n", "n", "n").

state(X, X, U, V) :- safe(X, X, U, V), opp(X, X1), state(X1, X1, U, V).
state(X, Y, X, V) :- safe(X, Y, X, V), opp(X, X1), state(X1, Y, X1, V).
state(X, Y, U, X) :- safe(X, Y, U, X), opp(X, X1), state(X1, Y, U, X1).
state(X, Y, U, V) :- safe(X, Y, U, V), opp(X, X1), state(X1, Y, U, V).

safe(X, Y, X, V) :- shore(X), shore(Y), shore(V).
safe(X, X, G, X) :- opp(X, G).

?- state("s", "s", "s", "s").
```

Run this with `bun run datamog river-crossing.dl`. If it produces a row, the
puzzle has a solution. (You can find this program at
`packages/cli/examples/river-crossing/river-crossing.dl`.)

## How it works under the hood

Datamog translates this into a **recursive SQL view**. The database engine:

1. Starts with the initial state `("n", "n", "n", "n")`.
2. Applies all four transition rules to generate new safe states.
3. Adds any genuinely new states to the view.
4. Repeats until no new states appear (fixed point).
5. The query checks whether `("s", "s", "s", "s")` is in the final set.

Use `--dry-run` to see the generated SQL:

```bash
bun run datamog --dry-run packages/cli/examples/river-crossing/river-crossing.dl
```

## Exercises

### Exercise 1: Enumerate all reachable states

Modify the query to list **all** safe states reachable from the start.

<details>
<summary>Solution</summary>

```prolog
?- state(F, W, G, C).
```

This shows every state the farmer can reach through legal moves.

</details>

### Exercise 2: A harder crossing

Imagine an additional constraint: the farmer cannot cross alone (the boat is
too heavy to row without cargo). Which transition rule would you remove?
Does the puzzle remain solvable?

<details>
<summary>Hint</summary>

Remove the "farmer crosses alone" rule (the last `state` rule). Then query
for the goal state and see if it still appears.

</details>

<details>
<summary>Solution</summary>

Remove:
```prolog
state(X, Y, U, V) :- safe(X, Y, U, V), opp(X, X1), state(X1, Y, U, V).
```

The puzzle becomes **unsolvable** — no result is returned for
`?- state("s", "s", "s", "s")`.

The key insight: the farmer must sometimes cross alone to reposition. Without
that move, there is no way to ferry all three items safely.

</details>

### Exercise 3: Counting reachable states

Use an aggregate to count how many distinct safe states are reachable.

<details>
<summary>Solution</summary>

```prolog
num_states(count(*)) :- state(_, _, _, _).

?- num_states(N).
```

</details>

## Challenge: Bridge crossing

> Adapted from the bridge-crossing example in the
> [Datalog Educational System (DES)](http://des.sourceforge.net/)
> by Fernando Saenz-Perez.

Four fugitives must cross a bridge at night. They have one torch, and the
bridge holds at most two people at a time. The torch must accompany every
crossing. Each person has a different crossing speed:

| Person | Time |
|--------|------|
| 1      | 1 min |
| 2      | 2 min |
| 3      | 5 min |
| 4      | 10 min |

When two cross together, they move at the slower person's speed. Warriors
arrive in 19 minutes. Can all four escape?

This extends the river-crossing pattern with **time tracking** and **pair
moves**. The state becomes a 6-tuple:
`state(P1, P2, P3, P4, Torch, ElapsedTime)`.

Key additions:
- A `slower(X, Y, Max)` helper picks the larger of two crossing times.
- Ten transition rules: four solo crossings plus six pair crossings.
- A `bound(19)` fact and `T < B` check prune states that exceed the time limit.

<details>
<summary>Solution</summary>

```prolog
shore("n").
shore("s").
opp("n", "s").
opp("s", "n").

time(1, 1).
time(2, 2).
time(3, 5).
time(4, 10).

bound(19).

slower(X, Y, X) :- time(_, X), time(_, Y), X >= Y.
slower(X, Y, Y) :- time(_, X), time(_, Y), X < Y.

state("n", "n", "n", "n", "n", 0).

# Solo crossings
state(X, Y, U, V, X, T) :-
  opp(X, X1), state(X1, Y, U, V, X1, TT),
  time(1, T1), T = TT + T1, bound(B), T < B.
state(X, Y, U, V, Y, T) :-
  opp(Y, Y1), state(X, Y1, U, V, Y1, TT),
  time(2, T1), T = TT + T1, bound(B), T < B.
state(X, Y, U, V, U, T) :-
  opp(U, U1), state(X, Y, U1, V, U1, TT),
  time(3, T1), T = TT + T1, bound(B), T < B.
state(X, Y, U, V, V, T) :-
  opp(V, V1), state(X, Y, U, V1, V1, TT),
  time(4, T1), T = TT + T1, bound(B), T < B.

# Pair crossings
state(X, X, U, V, X, T) :-
  opp(X, X1), state(X1, X1, U, V, X1, TT),
  time(1, T1), time(2, T2), slower(T1, T2, MT), T = TT + MT, bound(B), T < B.
state(X, Y, X, V, X, T) :-
  opp(X, X1), state(X1, Y, X1, V, X1, TT),
  time(1, T1), time(3, T2), slower(T1, T2, MT), T = TT + MT, bound(B), T < B.
state(X, Y, U, X, X, T) :-
  opp(X, X1), state(X1, Y, U, X1, X1, TT),
  time(1, T1), time(4, T2), slower(T1, T2, MT), T = TT + MT, bound(B), T < B.
state(X, Y, Y, V, Y, T) :-
  opp(Y, Y1), state(X, Y1, Y1, V, Y1, TT),
  time(2, T1), time(3, T2), slower(T1, T2, MT), T = TT + MT, bound(B), T < B.
state(X, Y, U, Y, Y, T) :-
  opp(Y, Y1), state(X, Y1, U, Y1, Y1, TT),
  time(2, T1), time(4, T2), slower(T1, T2, MT), T = TT + MT, bound(B), T < B.
state(X, Y, U, U, U, T) :-
  opp(U, U1), state(X, Y, U1, U1, U1, TT),
  time(3, T1), time(4, T2), slower(T1, T2, MT), T = TT + MT, bound(B), T < B.

fastest(min(T)) :- state("s", "s", "s", "s", "s", T).

?- fastest(T).
```

Result: **17 minutes**. The optimal strategy:

1. Persons 1 and 2 cross together (2 min)
2. Person 1 returns with the torch (1 min)
3. Persons 3 and 4 cross together (10 min)
4. Person 2 returns with the torch (2 min)
5. Persons 1 and 2 cross together (2 min)

Total: 2 + 1 + 10 + 2 + 2 = 17 minutes.

</details>

## Concepts introduced

- **State-space modeling**: representing a problem's states as Datalog facts
- **Recursive exploration**: transition rules that generate new states from
  existing ones until a fixed point
- **Safety constraints**: filtering states with auxiliary predicates
- **Constraint-based problem solving**: instead of programming an algorithm,
  you **declare** the rules and let the database engine find the answer

## What's next?

Next up: [Find the shortest path](06-find-the-shortest-path.md)
shows how to combine recursion with aggregates to solve graph optimization
problems.
