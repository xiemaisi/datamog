---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 11
## Search and puzzles

The generate-and-test pattern, applied to constraint-shaped problems

---

# Why Datalog is good at puzzles

Logic puzzles are constraint-satisfaction problems. The fit with Datalog is natural:

- **Generate** — enumerate candidate answers with positive rules (EDBs, ranges).
- **Test** — filter them with constraints (comparisons, negations, aggregates).

You state the constraints; the engine works out which candidates survive. No manual search code, no backtracking, no if-trees.

---

# Who broke the vase?

Four suspects. Two clues:

1. The culprit was drinking **tea**.
2. The culprit is **right-handed**.

```prolog
input predicate person(name: string).
input predicate drinks(name: string, beverage: string).
input predicate hand(name: string, handedness: string).

drinks_tea(N)   :- drinks(N, "tea").
right_handed(N) :- hand(N, "right").

suspect(N) :- person(N), drinks_tea(N), right_handed(N).

?- suspect(X).
```

The answer is Dave — only he satisfies both clues.

---

# The pattern

Look at the `suspect` rule:

```prolog
suspect(N) :- person(N), drinks_tea(N), right_handed(N).
```

- `person(N)` — **generate** every candidate.
- Each additional body atom — **test** one constraint.

More candidates? Add data to `person`. More clues? Add body atoms to `suspect`. Structure stays the same.

---

# Negative clues

"The culprit is **not** bald" — straight into negation:

```prolog
bald(N) :- hair(N, "bald").

suspect(N) :- person(N), drinks_tea(N), not bald(N).
```

`not bald(N)` filters by absence — `N` must already be bound (here, by `person(N)`).

---

# Clues that need aggregation

"The culprit is not the tallest":

```prolog
max_height(max(H)) :- person(N), height(N, H).
tallest(N) :- height(N, H), max_height(H).

suspect(N) :-
    person(N), drinks_tea(N), not tallest(N).
```

Aggregation and stratified negation **stack neatly** on top of the generate-and-test skeleton.

---

# A second puzzle: a number constraint

```prolog
pair(X, Y) :-
    X in [1 .. 10],
    Y in [1 .. 10],
    X * X + Y = 30.
```

- Ranges generate candidates.
- The arithmetic equality filters.

Every pair `(X, Y)` with `X² + Y = 30` falls out. Read the rule as a *specification* of the solution set; the engine does the enumeration.

---

# A different kind of search: reachability

Generate-and-test enumerates *static* candidates. The other pattern explores the **reachable states** of a system that changes step by step — river crossings, protocols, Petri nets.

Same fixed point as transitive closure, but the recursing relation holds **states**: the initial state is a fact, each transition a rule.

```prolog
# A robot on a 3x3 grid. State is pos(X, Y).
pos(0, 0).
pos(X1, Y) :- pos(X, Y), X1 = X + 1, X1 <= 2.   # step east
pos(X, Y1) :- pos(X, Y), Y1 = Y + 1, Y1 <= 2.   # step north
?- pos(2, 2).                                    # reach the far corner?
```

**Model checking:** a safety check is a query for a reachable *bad* state — no rows means safe. See the `mutual-exclusion` (Peterson's) and `petri-net` examples. The reachable space must be finite (`--warn-finiteness`).

---

# When is Datalog good at this?

| Problem shape | Verdict |
| --- | --- |
| Constraint-satisfaction (whodunit, colour assignments, "who sits where") | Excellent |
| Small / bounded search spaces | Yes — handles fine |
| Reachable-state search over a bounded space (puzzles, protocols, Petri nets) | Yes — idiomatic recursion over states |
| Backtracking with **pruning** | Not natively — Datalog enumerates the whole candidate set |
| Problems needing **novel values** | Tricky — can't invent strings or compounds; ranges only generate ints |

The art is spotting when your problem is constraint-shaped. Once you do, the encoding is usually two or three predicates.

---

# Recap

- Core pattern: **generate-and-test**. One atom per candidate, one body atom per constraint.
- Negation and aggregation work as filters; stratification ensures they fire *after* the candidate set stabilises.
- **Ranges** generate integer candidates; **EDBs** generate domain objects (people, cities, subjects). Both are just "sources of rows".
- A second pattern, **state-space search**: states in the recursing relation, transitions as rules; a safety check is a query for a reachable bad state (no rows = safe), for a finite space.
- Datalog excels on small declarative constraint problems; it's weak on large search spaces that benefit from pruning.

---

# Where to next

Time for a real-world case study: **reaching definitions**, a textbook static program analysis, written in six lines of Datalog.

This is why Soufflé and friends became the language of choice for production analysis frameworks.

[Chapter 12. Case study — program analysis →](12-program-analysis.md)
