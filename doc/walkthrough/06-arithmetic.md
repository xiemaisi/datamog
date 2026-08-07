# Chapter 6 — Arithmetic, ranges, and strings

So far our Datalog programs have pattern-matched facts and joined
them together. That's enough for classical logical examples but
hits a wall the moment you need to do anything numeric — a running
total, a computed threshold, "the next integer". This chapter adds
the three pieces Datamog provides for that: **arithmetic
expressions** in rule bodies, **range atoms** that generate values
on the fly, and **string operations** for turning textual data into
usable fields.

Along the way we meet a small subtlety: these features can *create*
values outside the active domain, so "every Datalog program
terminates" (Chapter 0's footnote) becomes a property you have to
maintain yourself.

## Arithmetic expressions

From [`code/ch06/arithmetic.dl`](code/ch06/arithmetic.dl):

```prolog
input predicate score(student: string, subject: string, points: integer).

out_of_ten(Student, Subject, P10) :-
    score(Student, Subject, P), P10 = P / 10.

above_threshold(Student, Subject, P) :-
    score(Student, Subject, P), P > 75.

bonus(Student, Subject, P2) :-
    score(Student, Subject, P), P2 = P + 5.
```

A few things at once:

- **Equalities bind variables.** `P10 = P / 10` makes `P10` refer to
  the computed value. `P10` must not already be bound to something
  else; a rule with `P10 = P / 10` and `P10 = 0` as two body atoms
  would be fine only if it happens that `P / 10` equals `0`.
- **Comparisons filter.** `P > 75` is a body atom that succeeds
  when `P` is greater than 75 and fails otherwise. Comparisons
  don't bind variables — `P` has to already be bound by some atom
  *before* the comparison (or via a body-level equality).
- **Arithmetic is the usual set:** `+`, `-`, `*`, `/`, `%`, and `**`
  (exponentiation, right-associative and always float-valued). `+`
  overloads on strings (concatenation).

**[Open this program in the playground →](https://max-schaefer.github.io/datamog/#p=score(%22alice%22%2C%20%22math%22%2C%2092).%0Ascore(%22alice%22%2C%20%22science%22%2C%2080).%0Ascore(%22bob%22%2C%20%22math%22%2C%2065).%0Ascore(%22bob%22%2C%20%22science%22%2C%2072).%0Ascore(%22carol%22%2C%20%22math%22%2C%2088).%0Ascore(%22carol%22%2C%20%22science%22%2C%2095).%0A%23%20Tutorial%2C%20chapter%206%20%E2%80%94%20arithmetic%20in%20rule%20bodies.%0A%0A%23%20Arithmetic%20in%20the%20rule%20head%3A%20convert%20points%20out%20of%20100%20to%20points%0A%23%20out%20of%2010%20(integer%20division%20%E2%80%94%20more%20on%20that%20below).%0Aout_of_ten(Student%2C%20Subject%2C%20P10)%20%3A-%0A%20%20%20%20score(Student%2C%20Subject%2C%20P)%2C%20P10%20%3D%20P%20%2F%2010.%0A%0A%23%20A%20filter%20using%20a%20comparison.%0Aoutput%20predicate%20above_threshold(Student%2C%20Subject%2C%20P)%20%3A-%0A%20%20%20%20score(Student%2C%20Subject%2C%20P)%2C%20P%20%3E%2075.%0A%0A%23%20Arithmetic%20with%20multiple%20operands.%0Aoutput%20predicate%20bonus(Student%2C%20Subject%2C%20P2)%20%3A-%0A%20%20%20%20score(Student%2C%20Subject%2C%20P)%2C%20P2%20%3D%20P%20%2B%205.%0A%0A%3F-%20out_of_ten(N%2C%20S%2C%20P).%0A)**

### Integer vs. float division

`/` is **integer division** when both operands are integers. Our
`P / 10` above truncates: `92 / 10 = 9`, not `9.2`. If you want
float division, make at least one operand a float (a literal with a
decimal point works): `P / 10.0`. SQLite and Postgres both truncate
integer `/` natively, so Datamog emits `/` directly on every
backend it ships.

### Divisions and domain errors return `NULL`

Datamog is careful to make partial operations consistent across
backends:

- `a / 0` and `a % 0` return `NULL` everywhere (SQLite's natural
  behaviour; Postgres would raise without the `NULLIF` wrapper).
- `sqrt(-x)`, `ln(0)` or `ln(-x)`, `0 ** -n`, `-x ** fractional`
  also return `NULL` (wrapped in a `CASE` in the generated SQL).
- **Integer arithmetic that leaves the integer domain** returns
  `NULL` too. That domain is `[-(2^53 - 1), 2^53 - 1]`, the range
  JavaScript numbers represent exactly, and it is the same on every
  backend rather than whatever width the database happens to use.
  So `X + 1` is a partial operation like the others: exact while the
  answer fits, `NULL` when it does not.
- Slice bounds going the wrong way (`W[5:2]`) return the empty
  string.

A `NULL` from one of these flows on through the rule rather than
killing it: `Y = 10 / X` with `X = 0` binds `Y` to `NULL`, and the
row still appears with the `NULL` in it. Add `Y <> null` if you want
badly computed rows gone.

Overflow is worth a second look, because it is the one that surprises.
Every arithmetic column is potentially nullable for this reason, even
one built only from non-null inputs, which is why a guard sometimes
looks redundant and is not:

```prolog
big(9007199254740991).
step(N + 1) :- big(N).      # derives NULL, not 9007199254740992
```

The alternative would be to pick a width and let each backend disagree
at the edges, or to raise. Returning `NULL` keeps the same program
meaning the same thing everywhere, which is the trade the whole
chapter has been making.

## Range atoms: generating values

Pattern-matching existing facts is one thing; conjuring up values
that aren't in any table is quite another. For that you use a
**range atom** — see [`code/ch06/ranges.dl`](code/ch06/ranges.dl):

```prolog
num(N) :- N in [1 .. 10].

square(N, S) :- N in [1 .. 10], S = N * N.
```

`N in [lo .. hi]` binds `N` to each integer in the inclusive range
`[lo, hi]`. It's the first rule body atom you've seen that doesn't
reference any predicate — ranges are their own kind of body
element. The bounds can be literals or already-bound variables
(so you can generate a range whose length depends on other facts).

Ranges are what give Datalog programs their "generate-and-filter"
shape: produce candidate values with a range, then let later body
atoms (arithmetic, comparisons, predicate lookups) cull the
unwanted ones. We'll lean on this pattern heavily once we hit
puzzles in Chapter 11.

## Strings

Datamog treats strings as a first-class type with a small but
practical operator set. From
[`code/ch06/strings.dl`](code/ch06/strings.dl):

```prolog
greeting(G)     :- words(W), G = "hello, " + W.
length_of(W, N) :- words(W), N = length(W).
first_char(W, C):- words(W), C = W[0].
prefix3(W, P)   :- words(W), length(W) >= 3, P = W[:3].
```

Summary:

| operation | syntax      | notes                                   |
| --------- | ----------- | --------------------------------------- |
| concat    | `"a" + "b"` | `+` overloads on string                   |
| length    | `length(W)` | in characters                           |
| index     | `W[i]`      | a single character                      |
| slice     | `W[i:j]`    | from `i` inclusive to `j` exclusive     |
|           | `W[:j]`     | from the start                          |
|           | `W[i:]`     | to the end                              |

Indexing and slicing use non-negative integer bounds (negative
literals are rejected at type-check time). An out-of-range
subscript and a "bad" slice (start ≥ end, or either bound negative
at runtime) both return `""`; only `NULL` propagating into the
operand turns the result into `NULL`.

## A complete example: Fibonacci

Putting it together. From
[`packages/cli/examples/fibonacci/fibonacci.dl`](../../packages/cli/examples/fibonacci/fibonacci.dl):

```prolog
fib_step(1, 0, 1).
fib_step(I + 1, Curr, Prev + Curr) :- fib_step(I, Prev, Curr), I < 10.

fibonacci(I, V) :- fib_step(I, _, V).

?- fibonacci(I, V).
```

The second rule is *linearly recursive* and uses arithmetic in the
head (`I + 1`, `Prev + Curr`). The body bounds `I < 10`; without
that bound the program would loop forever — every iteration
produces a *new* larger integer that extends the active domain.

This is the "termination is your job" point from Chapter 0 made
concrete: because `+` can manufacture values not in the input, the
finite-active-domain guarantee doesn't automatically hold. Adding
`I < 10` (or any other fact that bounds the recursion) restores
termination.

Datamog ships an opt-in static check that flags this pattern. Run

```bash
bun run datamog --warn-finiteness packages/cli/examples/fibonacci/fibonacci.dl
```

and you'll see one warning per predicate column whose value flows
around a cycle that includes an arithmetic or string operation:

```
warning: Column 1 of predicate 'fib_step' is on a value-producing
recursion cycle and may grow without bound
```

The check is conservative — it can't see that `I < 10` keeps the
recursion finite, so it warns about Fibonacci even though the rule
*does* terminate. Treat it as a "double-check your bound is real"
hint, not a hard error. The playground's editor pane runs the same
analysis automatically and underlines the offending head with a
yellow squiggle.

> **Logic lens.** In pure Datalog, arithmetic operators, ranges,
> and string functions are handled as a family of **built-in
> predicates** — infinitely-large relations that we don't
> enumerate but can look up. `N in [1..10]` is literally the
> extensional predicate with rows `{(1), (2), ..., (10)}`; `P10 =
> P / 10` is a three-place predicate `divides_to(P, 10, P10)`
> whose set of tuples is closed under the operation. Treating
> them this way is what keeps the underlying theory (terminating,
> unique least-fixed-point, stratifiable) unchanged — provided
> your program's active domain stays finite. The moment a rule
> can manufacture new values without bound, you're outside that
> guarantee and it's your job to put a bound in.

> **SQL lens.** Arithmetic compiles to SQL expressions directly,
> with the divisor wrapped in `NULLIF` for cross-backend
> divide-by-zero parity (recall §5.4): `P = points / 10` becomes
> `(__b0."points" / NULLIF(10, 0))`. Comparisons become `WHERE`
> conditions.
>
> Ranges compile differently depending on the backend. On
> Postgres, `N in [lo..hi]` becomes a `generate_series` call —
> a lateral table expression that generates rows on the fly. On
> SQLite/sql.js, which have no `generate_series`, Datamog
> emits a recursive CTE that counts from `lo` to `hi`; if the
> bounds are literals they're inlined, and if they're correlated
> to the outer query Datamog uses a fixed cap of 1 000 000 (since
> SQLite also has no `LATERAL`). The spec's §6.7 has the
> gritty detail.
>
> The cross-backend normalisations (`NULLIF` around division,
> `CASE` around `sqrt`/`ln`/`**`, explicit `CASE` for slice
> bounds) are what make these operators behave *identically*
> across every backend. Runtime semantics parity is a design goal
> — it's the reason you can develop locally on sqljs and deploy on
> Postgres without meaning changing underfoot.

> **Imperative lens.** Python list comprehensions are the closest
> match:
>
> ```python
> squares = [(n, n * n) for n in range(1, 11)]
> prefixes = [(w, w[:3]) for w in words if len(w) >= 3]
> ```
>
> For unbounded generation (primes up to a limit, values satisfying
> some property) you'd typically write a `for i in range(...)` loop
> and pick out the ones you want. Datalog does this *declaratively*
> — you state the bound and the condition; the engine figures out
> the iteration. This is no faster than the Python for small
> inputs, but it scales to *compositions* that would be hard to
> hand-code: "integers in `[1..n]` that are also primes and which
> divide at least one Fibonacci number under 10 000" is one query
> in Datalog and three careful loops in Python.

## Recap

- **Arithmetic** and **comparisons** are expressions in rule
  bodies and heads. Equality binds, comparison filters.
- **Range atoms** `N in [lo..hi]` generate integers on the fly —
  the canonical way to introduce values not in any extensional
  predicate.
- **Strings** have concat (`+`), `length`, indexing, and slicing.
  Out-of-bounds indexing and "wrong-way" slices return `""`
  consistently across backends; `NULL` only enters when an operand
  is itself `NULL`.
- These features can break the finite-active-domain guarantee;
  recursive programs that use them need a user-supplied termination
  bound. Runtime partials (`/0`, `sqrt(-)`, bad slice) are
  normalised to `NULL`/`""` everywhere.

## Exercises

### Exercise 6.1 — Grading bands ★

Starter: [`code/ch06/ex1-bands.dl`](code/ch06/ex1-bands.dl)

Given `score(student, subject, points)`, define:

- `grade_a(Student, Subject)` — points ≥ 90,
- `grade_b(Student, Subject)` — 80 ≤ points < 90,
- `grade_c(Student, Subject)` — 70 ≤ points < 80,
- `grade_f(Student, Subject)` — points < 70.

Use constants and comparisons; no ranges needed. How many of these
rules fire for each student?

### Exercise 6.2 — Running sums via recursion ★★

Starter: [`code/ch06/ex2-sum.dl`](code/ch06/ex2-sum.dl)

Define `sum_to(N, S)` meaning "the sum 1 + 2 + ... + N is S", for
`N` from 1 to 20. You'll need a base case (`sum_to(1, 1)`) and a
linearly-recursive step that adds one more integer per iteration.
Watch out for termination — put an explicit upper bound on `N` in
the recursive body.

### Exercise 6.3 — All prefixes ★★

Starter: [`code/ch06/ex3-prefixes.dl`](code/ch06/ex3-prefixes.dl)

Define `prefix(W, P)` — `P` is a (possibly empty, possibly whole)
prefix of `W`. Use a range atom to enumerate prefix lengths and
slicing to cut `W`. Run it against the words CSV and check every
word produces `length(W) + 1` prefixes (including `""` and the full
string).

(You might have reached for palindromes; that's a natural idea but
the tractable formulation in Datalog wants negation or aggregation,
both later chapters.)

### Exercise 6.4 — Range with computed bounds ★★

Write a rule that, for each number `N` in a small input predicate,
generates the sequence `1, 2, ..., N`. You'll need a range with
one correlated bound. Check the generated SQL on both Postgres
(`generate_series` with a lateral reference) and sqljs (recursive
CTE with a literal cap). What's the implicit assumption about the
size of `N`?

### Exercise 6.5 — Deliberately divergent ★★★

Starter: [`code/ch06/ex5-divergent.dl`](code/ch06/ex5-divergent.dl)

Write a rule that genuinely fails to terminate on `native` — a
recursive predicate that manufactures an integer on each step
*without* a termination bound. Observe the behaviour (the process
will spin until you kill it). Then add a bound and confirm
termination. This exercise's point is to internalise that
"Datalog always terminates" has hidden premises — and that the
engine will not save you from an unbounded rule.

---

Next: **[Chapter 7 — Safety and the type system](07-safety.md)**.
Every rule we've written has been "safe" without us noticing. Next chapter we
state the rule explicitly, see what goes wrong if you break it, and meet
Datamog's strict column-type system — which catches a surprising amount of
silliness before the program ever runs.
