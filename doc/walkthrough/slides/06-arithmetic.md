---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 6
## Arithmetic, ranges, and strings

The pieces that take Datalog from "join engine" to "useful for real data"

---

# What this chapter adds

Three new building blocks for rule bodies:

- **Arithmetic expressions** — `+`, `-`, `*`, `/`, `%`.
- **Range atoms** — generate values on the fly: `N in [lo .. hi]`.
- **String operations** — concat, length, indexing, slicing.

A subtlety appears: these features can manufacture values outside the active domain, so termination is no longer free.

---

# Arithmetic in rule bodies

```prolog
input predicate score(student: string, subject: string, points: integer).

out_of_ten(Student, Subject, P10) :-
    score(Student, Subject, P), P10 = P / 10.

above_threshold(Student, Subject, P) :-
    score(Student, Subject, P), P > 75.
```

- **Equalities bind variables** — `P10 = P / 10`.
- **Comparisons filter** — `P > 75`. Variables in comparisons must already be bound.
- **`+` overloads** on strings (concatenation).

---

# Integer vs. float division

`/` does **integer division** when both operands are integers:

```
92 / 10 = 9     (not 9.2)
```

Real division: make at least one operand a float (`P / 10.0`).

SQLite and Postgres both truncate integer `/` natively, so Datamog emits `/` directly. Same answer everywhere.

---

# Partial operations have no value

Datamog normalises partial operations across all backends. "No value" means the row is not derived:

| | |
| --- | --- |
| `a / 0`, `a % 0` | no value |
| `sqrt(-x)`, `ln(0)`, `ln(-x)` | no value |
| `0 ** -n`, `-x ** fractional` | no value |
| `W[5:2]` (start ≥ end) | `""` |

The conjunct does not hold, so the row goes: `Y = 10 / X` with `X = 0` derives nothing. Distinct from `null`, which is an ordinary value and keeps its row.

---

# Range atoms — generating values

```prolog
num(N)       :- N in [1 .. 10].
square(N, S) :- N in [1 .. 10], S = N * N.
```

`N in [lo .. hi]` binds `N` to each integer in `[lo, hi]` (inclusive). Bounds can be literals or already-bound variables.

**The first body atom you've seen that doesn't reference any predicate.**

---

# Generate-and-filter

Ranges enable the canonical **generate-and-filter** style:

1. Use a range to generate candidate values.
2. Use later body atoms (arithmetic, comparisons, predicate lookups) to cull the unwanted ones.

We'll lean on this heavily in Chapter 11 (puzzles).

---

# String operations

```prolog
greeting(G)      :- words(W), G = "hello, " + W.
length_of(W, N)  :- words(W), N = length(W).
first_char(W, C) :- words(W), C = W[0].
prefix3(W, P)    :- words(W), length(W) >= 3, P = W[:3].
```

| op | syntax |
| --- | --- |
| concat | `"a" + "b"` |
| length | `length(W)` |
| index | `W[i]` |
| slice | `W[i:j]`, `W[:j]`, `W[i:]` |

Negative literals are rejected at type-check time. Out-of-range subscripts and bad slices return `""`.

---

# Fibonacci — putting it all together

```prolog
fib_step(1, 0, 1).
fib_step(I + 1, Curr, Prev + Curr) :-
    fib_step(I, Prev, Curr), I < 10.

fibonacci(I, V) :- fib_step(I, _, V).
```

Linearly recursive; arithmetic in the head (`I + 1`); `I < 10` bounds the recursion.

**Without the bound the program loops forever** — every iteration produces a fresh larger integer that extends the active domain.

---

# Termination is your job now

In pure Datalog the active domain is finite, so iteration must stop.

Adding `+`, `*`, `length`, and friends breaks that — they manufacture values not in the input.

Datamog's static **finiteness check** flags this:

```bash
bun run datamog --warn-finiteness fibonacci.dl
```

```
warning: Column 1 of predicate 'fib_step' is on a value-producing
recursion cycle and may grow without bound
```

The check is conservative — even sound bounds (like `I < 10`) get warnings. Treat it as "double-check your bound is real".

---

# Logic lens

Arithmetic, ranges, and string functions are **built-in predicates** — infinitely-large relations we can look up but not enumerate.

- `N in [1..10]` is the relation `{(1), (2), ..., (10)}`.
- `P10 = P / 10` is a 3-place predicate `divides_to(P, 10, P10)`.

The underlying theory (terminating, unique LFP, stratifiable) is unchanged **as long as** your active domain stays finite. The moment a rule manufactures values without bound, that guarantee is on you to maintain.

---

# SQL lens

Arithmetic compiles to SQL expressions directly: `P / 10` → `"P" / 10`.

Ranges compile differently per backend:

- **Postgres** — `generate_series(lo, hi)`.
- **SQLite / sql.js** — recursive CTE counting `lo..hi` (literal bounds inlined; correlated bounds capped at 1 000 000 since SQLite has no `LATERAL`).

Cross-backend invariants — `NULLIF` around division, `CASE` around `sqrt`/`ln`/`**`/slice — keep behaviour identical across backends.

---

# Imperative lens

Python list comprehensions are the closest match:

```python
squares  = [(n, n*n) for n in range(1, 11)]
prefixes = [(w, w[:3]) for w in words if len(w) >= 3]
```

For unbounded generation you'd write a `for i in range(...)` loop and pick out winners.

Datalog states the bound and the condition; the engine figures out the iteration. The win is composition: "ints in `[1..n]` that are prime and divide a Fibonacci under 10000" is one query in Datalog and three careful loops in Python.

---

# Recap

- **Arithmetic** and **comparisons** in bodies and heads. Equality binds, comparison filters.
- **Range atoms** `N in [lo..hi]` generate integers — the canonical "values not in any EDB" entry point.
- **Strings**: `+`, `length`, indexing, slicing. Out-of-range / wrong-way slices return `""`, which is a value.
- These features can break finite-active-domain — recursive programs that use them need a user-supplied termination bound.

---

# Where to next

Every rule we've written has obeyed an unspoken discipline: variables must be **safely bound** by the body. Chapter 7 names that discipline, shows what goes wrong without it, and meets Datamog's strict column-type system.

[Chapter 7. Safety and the type system →](07-safety.md)
