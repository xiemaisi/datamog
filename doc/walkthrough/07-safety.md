# Chapter 7 — Safety and the type system

Every rule we've written so far has followed an unspoken discipline.
This chapter names it, and explains what the engine does when you
break it.

There are two static checks that every Datamog program passes
through before it runs: **safety** (variables must be bound by
something) and **type inference** (columns of each predicate must
have a consistent type). Both run before a single SQL statement is
generated, and both reject programs rather than let them fail at
runtime.

## The safety rule

A rule is **safe** when every variable in its head, and every
variable used in a comparison, arithmetic expression, or negation,
is *bound* by at least one positive body atom.

"Positive body atom" means any of:

- a reference to an extensional or intensional predicate:
  `parent(X, Y)`, `edge(X, Y)`, `reach(A, B)`;
- a range atom: `N in [lo .. hi]`;
- an equality whose other side is already safe:
  `Y = 2 * X` and `2 * X = Y` are both safe if `X` is already safe.

Ordering comparisons (`X > 0`, `A < B`) do not bind; they *filter*.
Body-level equality can bind a bare variable on either side when the
other side is already safe, and becomes a logical-equality filter once
both sides are bound.

### Watching safety fail

Consider

```prolog
unsafe(X, Y) :- Y = X + 1.
```

`X` never appears in a positive body atom. Where should it come
from? The set of all integers? Datamog rejects the rule:

```
Unsafe variable 'X' in equality 'Y = ...'
```

A fix is to bind `X` first:

```prolog
unsafe_fixed(X, Y) :- X in [0 .. 10], Y = X + 1.
```

Now `X` is drawn from a specific finite range; `Y` is computed from
it. Both are safe.

Equality is not an assignment statement, so the binding side can be
written either way:

```prolog
also_safe(X, Y) :- X in [0 .. 10], X + 1 = Y.
```

Here the safe expression `X + 1` binds `Y`. Datamog does not solve
arithmetic backwards: if only `Y` were safe, `X + 1 = Y` would not
infer `X`.

### Why the rule exists

Without safety, the meaning of a rule could depend on "the set of
all strings" or "the set of all integers", which is infinite — and
so the answer would be infinite too. SQL can't represent that; a
naive evaluator can't enumerate it. The safety rule is exactly the
check that guarantees the answer is finite *and* computable from the
data you've actually got.

Mathematically, safety is equivalent to **domain independence**: the
answer doesn't change if you extend the domain of discourse beyond
what appears in the input. Safe rules are domain-independent;
unsafe rules aren't. (In Chapter 8 we'll see that negated body
atoms have the same flavour of requirement: you can't safely say
"not `p(X)`" unless `X` is already bound.)

## The type system

Datamog gives every column of every predicate a type drawn from
five basic types:

- `string` — strings,
- `integer` — whole numbers,
- `float` — floating-point,
- `boolean` — `true` / `false`,
- `value` — the union of `null`, booleans, integers, floats,
  strings, arrays, and objects; opaque to the type system but
  destructurable via subscript and the iteration primitives. See
  the [working with values chapter](14-json.md) for the full story.

Extensional declarations state column types explicitly. Intensional
predicates have their column types **inferred** by a fixed-point
walk across the rules — each head variable gets its type from how
it's used in the body.

### One concrete inference

Consider:

```prolog
input predicate person(name: string, age: integer).

grown_up(Name) :- person(Name, A), A >= 18.
```

The inferencer walks the rule body: `person(Name, A)` fixes `Name`
as `string` and `A` as `integer`. `A >= 18` is consistent (integer vs.
integer literal). The head `grown_up(Name)` therefore has column 1
of type `string`. No explicit `input predicate grown_up(name: string).` is
needed.

### Combining types across rules

What if two rules for the same predicate produce different column
types? Each rule contributes to the column, so the column takes the
*join* (least upper bound) of the contributions. Numeric types widen:

```prolog
input predicate a(x: integer).
input predicate b(x: float).

c(X) :- a(X).
c(X) :- b(X).
```

Column 1 of `c` is `float`. And when the contributions have no common
numeric type (one rule gives a `string`, another an `integer`), the
column widens all the way to `value`, holding whichever shape each row
carries as JSON:

```prolog
input predicate a(x: integer).
input predicate b(x: string).

c(X) :- a(X).    % c's column is value: integers from a and
c(X) :- b(X).    % strings from b, side by side as JSON
```

Stacking rules never fails: across rules a column always has a least
upper bound (`value` at worst).

### When types really do conflict

The genuine error is a single *variable* forced into two incompatible
types *within one rule*. There the variable must be one value that
satisfies every position at once (a meet, not a join), and no value is
both a string and an integer:

```prolog
input predicate a(x: integer).
input predicate b(x: string).

both(X) :- a(X), b(X).    % X must be a's integer AND b's string
```

Datamog rejects this at translation time, before any SQL is emitted:

```
Variable 'X' has conflicting types 'integer' and 'string'
```

So stacking rules *widens* a column (up to `value`); sharing a variable
across atoms *intersects* its types, and incompatible primitives have
no common value.

### The tolerated widenings

`integer` → `float` is silently widened wherever needed. `integer +
integer` stays `integer`, but `integer + float` is `float`.

Primitive values also embed automatically into `value` slots:
`t(5)` can match a `value` column containing the numeric leaf `5`,
`J = 5` works when `J : value`, and `type_of(5)` first treats `5`
as a `value` leaf. Other primitive mismatches widen to `value` across
sibling rules (above), but within a rule and in comparisons they still
require compatible types.

### Type-driven rejection of bad operations

Some errors show up as "type" errors rather than "safety" or "logic"
errors. Negative subscripts are one example:

```prolog
r(W, C) :- w(W), C = W[-1].
```

produces:

```
Negative subscript index is not supported; indices must be non-negative
```

This is a check at the term level: `W[i]` requires `i` to be a
non-negative integer, and if a literal `-1` is written, Datamog
refuses. The same rule applies inside slices: `W[-1:5]` is rejected.

### Comparison compatibility

Two values can be compared only if their types agree, are related by
numeric widening, or use equality against a `value` slot where the
primitive side can auto-lift. Ordering over `value` is still rejected.
`X > "hello"` where `X` is an `integer` is rejected:

```
Cannot compare 'integer' and 'string' in comparison
```

This avoids a class of hard-to-debug nonsense results like "is `3`
less than `'apple'`?"

### Booleans are equality-only

`true` and `false` are reserved words; they may appear anywhere a
term is expected:

```prolog
input predicate account(name: string, active: boolean).

live(N)    :- account(N, true).
disabled(N) :- account(N, false).
```

But `<`/`<=`/`>`/`>=` are rejected on booleans — Datalog has no
canonical "true is bigger than false" ordering, and silently
compiling to a SQL comparison would give per-backend results
(SQLite stores `true` as 1; Postgres treats `false < true`):

```prolog
?- account(N, B1), account(M, B2), B1 > B2.   # ERROR
```

```
Operator '>' does not order booleans
```

The equality operators (`=`, `<>`) work on booleans — equality is
well-defined on every type. There is only the one pair, and it is
null-aware: `null = null` is `true`. We'll come back to what that
means once `null` shows up in Chapter 8.

## Putting safety and typing together

In practice you encounter these two checks at the same time, because
both run as part of the same pre-translation pipeline. A concrete
mental checklist when you write a rule:

1. **Head variables.** Each one must appear in some positive body
   atom, a range, or a body equality with an already-safe other side.
2. **Comparisons.** Each variable used in an ordering comparison must
   be safe. Body equality is the exception: it can bind an unbound
   bare variable from a safe expression on either side.
3. **Types.** Variables inherit types from the predicates they
   match. Multiple occurrences of the same variable must end up
   with compatible types.
4. **Literals.** Negative integers aren't legal in subscript/slice
   positions; `true`/`false` aren't legal where a number is
   expected; etc.

If any of the four fails, Datamog refuses to translate the program.
You never get a runtime-SQL "column c.col1 is of type string, expected
integer" — because the translator wouldn't have emitted that SQL in
the first place.

> **Logic lens.** Safety ↔ **domain independence**: the value of
> a safe formula `φ(x̄)` on a structure `M` depends only on which
> tuples populate the *relations* in `M`, not on which other
> objects happen to sit in `M`'s universe. Unsafe formulas can
> change truth value when you enlarge the universe (because
> "some `x` such that `P(x)`" starts having to quantify over
> more), so they have no well-defined meaning in a "schema first,
> data later" world.
>
> The type system is a shallow Hindley-Milner-style inference:
> one type per column, with `integer ⊑ float` and primitive
> `⊑ value` as the only subtyping edges. That minimalism is
> deliberate — a richer type
> system (say, with per-column constraints or refinement types)
> would let you express more, but it would also make the
> translation to SQL much harder, since SQL's type system is
> equally minimal.

> **SQL lens.** Safety is exactly what guarantees the generated
> SQL is *finite*. Every body atom becomes a `FROM` alias drawn
> from a finite source (a table or a generated series); an unsafe
> variable would be a column with no `FROM` alias at all, which
> SQL can't express. Types become SQL column types (`TEXT`,
> `INTEGER`, `REAL`, `BOOLEAN`) in the generated `CREATE TABLE`
> and in the implicit schema of each intensional view. The
> translator uses the inferred types to decide e.g. whether to
> wrap an operand in `::TEXT` for `STRING_AGG` (Postgres) or pick
> the right `+`-vs-`||` overload (SQLite). A rejected-by-typing rule
> is a rule Datamog *can't* compile, not a rule that compiles
> badly.

## Recap

- A rule is **safe** when every head variable (and every variable
  used in a comparison or arithmetic) is bound by a positive body
  atom, a range, or an equality with an already-safe side.
- Safety is equivalent to domain-independence: the answer doesn't
  depend on what values exist "out there in the universe",
  only on what's in the input.
- Datamog has five column types (`string`, `integer`, `float`,
  `boolean`, `value`) and two widenings (`integer → float`, and
  primitive → `value` via auto-lift). Types are inferred by
  fixed-point walk; mismatches are reported before translation.
- Both checks run *before* any SQL is emitted. Programs that
  pass them are guaranteed to have finite, well-typed SQL behind
  them; programs that don't are rejected with a line-numbered
  error.

## Exercises

### Exercise 7.1 — Spot the unsafe variable ★

For each of the following rules, decide whether it's safe. If not,
point to the offending variable.

```prolog
# (a)
a1(X, Y) :- edge(X, Y), Y > X.

# (b)
a2(X, Z) :- edge(X, Y), Z = Y + 1.

# (c)
a3(X, Y) :- Y > X, edge(X, _).

# (d)
a4(N, M) :- N in [0..10], M = N * N.

# (e)
a5(X, Y) :- edge(X, _), edge(_, Y), X = Y.
```

Check your answers against
[`solutions/ch07/ex1.md`](solutions/ch07/ex1.md).

### Exercise 7.2 — Spot the type error ★

For each of the following, predict whether Datamog accepts or
rejects it, and why.

```prolog
# (a) — one extensional
input predicate emp(name: string, salary: integer).
raise(N, S2) :- emp(N, S), S2 = S + 0.10.

# (b) — conflicting extensional usage
input predicate a(x: integer).
input predicate b(x: string).
both(X) :- a(X), b(X).

# (c) — per-column inference in an IDB
input predicate item(name: string, price: float).
expensive(X) :- item(X, P), P > 100.
labelled(X) :- item(X, P), P > "threshold".
```

See [`solutions/ch07/ex2.md`](solutions/ch07/ex2.md).

### Exercise 7.3 — Fix the unsafe rule ★★

Starter: [`code/ch07/ex3-fix.dl`](code/ch07/ex3-fix.dl)

The starter program is rejected as unsafe. Add a range atom (or
any other safety-preserving binding) to make it compile, without
changing the head.

### Exercise 7.4 — Strict vs. loose ★★

Datamog rejects `integer` vs. `string` comparisons but silently
accepts `integer` vs. `float`. What's the reasoning for treating
the two cases differently? What would go wrong if Datamog tried
to accept more kinds of cross-type comparison (say, with some
coercion)? Write your take (~150 words); compare with
[`solutions/ch07/ex4.md`](solutions/ch07/ex4.md).

### Exercise 7.5 — An eligible variable binding chain ★★★

Starter: [`code/ch07/ex5-chain.dl`](code/ch07/ex5-chain.dl)

The safety analyser iterates to a fixed point over the rule body.
Write a rule with four variables `A, B, C, D` such that none of them
is bound *individually* by a single body atom, but all four become
safe once you consider the body as a whole. Run it through Datamog
to confirm.

---

Next: **[Chapter 8 — Negation and stratification](08-negation.md)**. Safety
is half the story for handling "the absence of a fact". The other half — why
negation needs its own extra discipline, and how stratification makes it
coexist with recursion — is what Chapter 8 covers.
