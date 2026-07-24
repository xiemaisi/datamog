# Chapter 11 — Search and puzzles

Logic puzzles are surprisingly well-suited to Datalog. The core
pattern is **generate-and-test**: enumerate all candidate answers
with positive rules, then filter them down with constraints
(comparisons, negations, aggregates). Because Datalog evaluates
declaratively, you state the constraints and let the engine work
out which candidates survive — no manual search code, no
backtracking, no if-trees.

This chapter walks through a small whodunit puzzle to nail down
the pattern, then turns to a second kind of search: exploring the
reachable states of a system that evolves one step at a time.
Exercises extend it with number puzzles and a map-coloring-style
constraint check.

## Who broke the vase?

Someone broke the vase. You have four suspects and two clues:

1. The culprit was drinking **tea** at the time.
2. The culprit is **right-handed**.

From [`code/ch11/thief.dl`](code/ch11/thief.dl):

```prolog
input predicate person(name: string).
input predicate drinks(name: string, beverage: string).
input predicate hand(name: string, handedness: string).

drinks_tea(N)  :- drinks(N, "tea").
right_handed(N) :- hand(N, "right").

suspect(N) :-
    person(N),
    drinks_tea(N),
    right_handed(N).

?- suspect(X).
```

The answer is Dave. Alice and Bob drink coffee; Carol is
left-handed. Only Dave satisfies both clues.

**[Open this program in the playground →](https://max-schaefer.github.io/datamog/#p=person(%22alice%22).%0Aperson(%22bob%22).%0Aperson(%22carol%22).%0Aperson(%22dave%22).%0Adrinks(%22alice%22%2C%20%22coffee%22).%0Adrinks(%22bob%22%2C%20%22coffee%22).%0Adrinks(%22carol%22%2C%20%22tea%22).%0Adrinks(%22dave%22%2C%20%22tea%22).%0Ahand(%22alice%22%2C%20%22right%22).%0Ahand(%22bob%22%2C%20%22right%22).%0Ahand(%22carol%22%2C%20%22left%22).%0Ahand(%22dave%22%2C%20%22right%22).%0A%23%20Tutorial%2C%20chapter%2011%20%E2%80%94%20a%20small%20%22who%20did%20it%3F%22%20puzzle.%0A%23%0A%23%20The%20vase%20is%20broken.%20We%20know%3A%0A%23%20%20%201.%20The%20culprit%20was%20drinking%20tea%20at%20the%20time.%0A%23%20%20%202.%20The%20culprit%20is%20right-handed.%0A%23%20Who%20did%20it%3F%0A%0A%23%20Encode%20each%20clue%20as%20a%20predicate%20that%20characterises%20who%20could%0A%23%20have%20done%20it%20based%20on%20that%20clue%20alone.%0Adrinks_tea(N)%20%3A-%20drinks(N%2C%20%22tea%22).%0Aright_handed(N)%20%3A-%20hand(N%2C%20%22right%22).%0A%0A%23%20The%20suspect%20satisfies%20every%20clue.%0Asuspect(N)%20%3A-%0A%20%20%20%20person(N)%2C%0A%20%20%20%20drinks_tea(N)%2C%0A%20%20%20%20right_handed(N).%0A%0A%3F-%20suspect(X).%0A)**

The pattern is exactly:

- **Generate.** `person(N)` enumerates every candidate.
- **Test.** Each additional body atom (`drinks_tea(N)`,
  `right_handed(N)`) applies one constraint.

If you have more candidates, add more data to `person`. If you
have more clues, add more body atoms to `suspect`. The structure
stays the same.

## Encoding "negative" clues

What if the clue were "the culprit is **not** bald"? Straight
into negation:

```prolog
bald(N) :- hair(N, "bald").
suspect(N) :-
    person(N),
    drinks_tea(N),
    not bald(N).
```

`not bald(N)` filters by absence — `N` must already be bound
(here by `person(N)`), and then the negation checks that `bald(N)`
is not in the computed relation.

"The culprit is not the tallest" would be:

```prolog
max_height(max(H)) :- person(N), height(N, H).
tallest(N) :- height(N, H), max_height(H).

suspect(N) :-
    person(N),
    drinks_tea(N),
    not tallest(N).
```

Aggregation and stratified negation stack neatly on top of the
generate-and-test skeleton.

## A second puzzle: a number constraint

```prolog
pair(X, Y) :-
    X in [1 .. 10],
    Y in [1 .. 10],
    X * X + Y = 30.
```

Ranges generate candidates; the arithmetic comparison filters. The
answer is every pair `(X, Y)` with `X² + Y = 30`. You can read the
rule as stating the *specification* of the solution set, and the
engine enumerates the solutions.

## Beyond generate-and-test: searching a state space

Generate-and-test enumerates a *static* set of candidates. A
second kind of search explores the *reachable configurations* of a
system that changes one step at a time — the shape behind
river-crossing puzzles, sliding tiles, and checking that a
concurrency protocol behaves.

The encoding is the recursion of Chapter 4, but the recursing
relation now holds **states**: represent a configuration as a
tuple, assert the initial state as a fact, and write one rule per
transition, each deriving a successor state from a reachable one.
The reachable set is the least fixed point.

```prolog
# A robot on a 3x3 grid, stepping east or north. State is pos(X, Y).
pos(0, 0).                                     # start in the corner
pos(X1, Y) :- pos(X, Y), X1 = X + 1, X1 <= 2.  # step east
pos(X, Y1) :- pos(X, Y), Y1 = Y + 1, Y1 <= 2.  # step north

?- pos(2, 2).                                  # can it reach the far corner?
```

Two moves in place of two `edge` facts, but it is the same fixed
point we computed for transitive closure — now over structured
states instead of graph nodes.

This is also how you **check a property**. A safety question ("can
the system ever reach a bad state?") becomes a query for a
reachable bad state: if it returns no rows, the property holds
across the entire reachable space — a small model checker.
`packages/cli/examples/mutual-exclusion/` verifies Peterson's
mutual-exclusion algorithm this way (no reachable state has both
processes in the critical section at once), and
`packages/cli/examples/petri-net/` checks that a Petri net stays
within capacity and never deadlocks midway. The
[river-crossing case study](../case-studies/05-cross-the-river.md)
applies the same pattern to a puzzle.

One caveat: the reachable state space must be finite. A transition
that keeps manufacturing new states (an unbounded counter, an
ever-growing list) never reaches a fixed point; Datamog's
finiteness checker (`--warn-finiteness`) flags exactly these.

## When is Datalog good at this?

- **Constraint-satisfaction shaped problems** (whodunit, colour
  assignments, "who sits where") — yes, excellent. Every feature
  we've covered participates naturally.
- **Small search spaces** — yes. Datalog enumerates the whole
  candidate set, so if candidates are bounded and numerous but
  not astronomical, this scales fine.
- **Reachable-state search over a bounded space** (puzzles,
  protocols, Petri nets) — yes, and idiomatic: it is recursion
  over states, so the fixed point does the exploring, provided
  the state space is finite.
- **Problems needing backtracking with pruning** — not natively.
  Datalog doesn't prune; it generates the entire candidate space
  and filters. For large problems you'd want a dedicated SAT or
  CSP solver.
- **Problems needing novel values** — tricky. Ranges can
  generate integers, but Datalog can't invent new strings or
  compound structures that weren't somewhere in the input. Use
  aggregates or a pre-processing step to widen the candidate
  pool.

The art is spotting when your problem is constraint-shaped. Once
you do, the encoding is usually two or three predicates long.

## Recap

- The core pattern is **generate-and-test**: one atom per
  candidate, one body atom per constraint.
- Negation and aggregation work naturally as filters; their
  stratification ensures they fire *after* the candidate set
  stabilises.
- Ranges generate integer candidates; EDBs generate domain
  objects (people, cities, subjects). Both are just "sources of
  rows" from the rule's point of view.
- A second pattern, **state-space search**, puts states in the
  recursing relation and one transition per rule; a safety check
  becomes a query for a reachable bad state (no rows = safe), as
  long as the state space is finite.
- Datalog is strong on small, declarative constraint problems
  and weak on large search problems that benefit from pruning.

## Exercises

### Exercise 11.1 — A harder whodunit ★★

Starter: [`code/ch11/ex1-extra-clues.dl`](code/ch11/ex1-extra-clues.dl)

Add three more people and three more clues. Use at least one
negation and one comparison. Adjust until the program returns a
unique suspect.

### Exercise 11.2 — Sum of three cubes ★★

Starter: [`code/ch11/ex2-cubes.dl`](code/ch11/ex2-cubes.dl)

Define `triple(A, B, C)` for `A, B, C ∈ [1..10]` such that
`A³ + B³ + C³ = 99`. Check what you get. (You can do this in
Python in two lines of nested comprehensions; the Datalog
version is also two or three lines of rules.)

### Exercise 11.3 — Who sits where ★★★

Starter: [`code/ch11/ex3-seating/`](code/ch11/ex3-seating/)

Three people — Alice, Bob, Carol — sit in a row of three seats.
Clues:

1. Alice does not sit in seat 1.
2. Bob sits to the left of Carol (lower-numbered seat).
3. Carol does not sit in seat 3.

Encode the constraints as rules, generate candidate seatings, and
produce the unique solution.

Hint: use ranges for seat numbers `[1..3]`, generate `seating(A,
B, C)` with distinct seat assignments (you'll need comparisons to
enforce distinctness — inequality between variables is `!=`),
then filter by the clues.

---

Next: **[Chapter 12 — Case study: program analysis](12-program-analysis.md)**.
We'll walk through a real reaching-definitions analysis from the
`packages/cli/examples/` folder and see why Datalog became the
language of choice for static analysis frameworks like Soufflé.
