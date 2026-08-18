---
marp: true
theme: default
paginate: true
size: 16:9
---

# Chapter 7
## Safety and the type system

The two static checks every Datamog program passes through before it runs

---

# Two pre-translation checks

Every program is rejected or accepted before any SQL is emitted by:

- **Safety** — every variable must be bound by something.
- **Type inference** — every column has one consistent basic type.

If either check fails, you get a line-numbered error. You never see a runtime SQL "type mismatch" — because the SQL was never generated.

---

# What "safe" means

A rule is **safe** when every variable in:

- the head,
- a comparison,
- an arithmetic expression,
- a negation

is bound by at least one **positive body atom** — a predicate reference, a range atom, or an equality with an already-safe other side.

Ordering comparisons (`X > 0`) and negations (`not p(X)`) **filter** — they don't bind. Body equality can bind a bare variable on either side.

---

# Watching safety fail

```prolog
unsafe(X, Y) :- Y = X + 1.
```

Where should `X` come from? The set of all integers? Datamog refuses:

```
Unsafe variable 'X' in equality 'Y = ...'
```

Fix: bind `X` first.

```prolog
unsafe_fixed(X, Y) :- X in [0 .. 10], Y = X + 1.
also_safe(X, Y)     :- X in [0 .. 10], X + 1 = Y.
```

Now `X` is drawn from a finite range; `Y` is computed from it. Equality is not assignment: `Y = X + 1` and `X + 1 = Y` behave the same when `X` is safe.

---

# Why the rule exists

Without safety, the answer of a rule could depend on "the set of all strings" — infinite.

Safety is equivalent to **domain independence**: the answer doesn't change if you extend the universe of discourse. Safe rules are domain-independent; unsafe rules aren't.

A negated body atom has the same flavour: `not p(X)` requires `X` to be bound elsewhere first.

---

# The five basic types (plus `null`)

| Type | Meaning |
| --- | --- |
| `string` | Strings |
| `integer` | Whole numbers |
| `float` | Floating-point |
| `boolean` | `true` / `false` |
| `value` | union of `null` / boolean / integer / float / string / array / object (destructured via subscript, iteration, coercion) |

EDBs declare types explicitly. IDBs have types **inferred** by a fixed-point walk over the rules.

---

# Inference in action

```prolog
input predicate person(name: string, age: integer).

grown_up(Name) :- person(Name, A), A >= 18.
```

The inferencer walks the body:

- `person(Name, A)` → `Name: string`, `A: integer`.
- `A >= 18` is consistent (integer vs. integer literal).
- Head `grown_up(Name)` therefore has column 1 of type `string`.

No explicit `input predicate grown_up(...)` declaration needed.

---

# Combining vs conflicting types

Across sibling rules a column takes the **join**: `integer`+`float` → `float`, incompatible primitives widen to `value`.

```prolog
c(X) :- a(X).    % a: integer
c(X) :- b(X).    % b: string, so c's column is value
```

The real conflict is a variable at two incompatible positions **within one rule** (a meet):

```prolog
both(X) :- a(X), b(X).
```

```
Variable 'X' has conflicting types 'integer' and 'string'
```

---

# The allowed widenings

`integer → float` is silently widened wherever needed.

- `integer + integer` stays `integer`
- `integer + float` becomes `float`
- Primitive values embed into `value` slots

So `t(5)` can match a `value` column containing JSON number `5`, and `type_of(5)` is valid.
Within a rule and in comparisons, other primitive mismatches need compatible types.

`X > "hello"` where `X` is `integer`?

```
Cannot compare 'integer' and 'string' in comparison
```

---

# Booleans are equality-only

`true` / `false` are reserved words. Equality and inequality work fine:

```prolog
input predicate account(name: string, active: boolean).

live(N)     :- account(N, true).
disabled(N) :- account(N, false).
```

But ordering comparisons are rejected — Datalog has no canonical "true > false":

```prolog
?- account(N, B1), account(M, B2), B1 > B2.
```

```
Operator '>' does not order booleans
```

---

# Extra term-level checks

Some errors show up as **type** errors at the term level:

```prolog
r(W, C) :- w(W), C = W[-1].
```

```
Negative subscript index is not supported; indices must be non-negative
```

`W[i]` and `W[i:j]` require non-negative integer literal bounds (runtime negatives just produce `""`).

---

# Claiming more than a type

A `_` head position can carry a **proposition** over the other positions instead of a type:

```prolog
slot(R, S, E, _: S < E) :- booking(R, S, E).
```

Checked against the tuples the rules derive. The position **is not a column**: what would live there is a witness that the proposition holds, which says nothing beyond "it holds", so it erases. `slot` is ternary.

A contract is the **disjunction over a predicate's rules**, so an unannotated sibling makes it vacuous:

```prolog
r(X, Y, _: Y > X) :- p(X, Y).
r(X, Y) :- q(X, Y).             # claims nothing, so `r` claims nothing
```

Datamog warns; `--strict-contracts` makes it fatal.

---

# Proving it, not just checking it

`--verify` hands each obligation to an SMT solver you install, so the claim holds for *every* input, not just the data at hand:

```bash
brew install z3
datamog --verify binary-search.dl     # 14/14 discharged.
```

A rule may assume the contract of every predicate it calls positively, **its own included** — the induction hypothesis.

What will not discharge usually needs a precondition nobody stated:

```
FAILED   probe rule 1: M <= H
         ((M (- 1)) (H (- 2)) (N (- 1)) ...)
```

An array of size -1. `size(7 as N, _: 1 <= N)` fixes it, itself a refinement.

---

# Mental checklist when you write a rule

1. **Head variables** — each in some positive body atom, range, or equality with a safe other side.
2. **Comparisons** — ordering comparisons filter; body equality can bind a bare variable on either side.
3. **Types** — variables inherit types from predicates; multiple occurrences of the same variable must unify.
4. **Literals** — negative integers aren't allowed in `[...]` subscripts; `true`/`false` aren't allowed where a number is expected.

If any fails, Datamog refuses to translate.

---

# Logic lens

Safety ↔ **domain independence**. The truth of a safe formula `φ(x̄)` on a structure `M` depends only on the *relations* in `M`, not on which other objects sit in `M`'s universe.

The type system is a shallow Hindley-Milner-style inference: one type per column, with `integer ⊑ float` and primitive `⊑ value` as the only subtyping edges.

The minimalism is deliberate — a richer type system would express more, but make SQL translation harder. SQL's type system is equally minimal.

Refinements are the escape hatch, and a **refinement type** in the usual sense: the witness is proof-irrelevant, so it erases, which is exactly why the position cannot be a column.

---

# SQL lens

Safety guarantees the generated SQL is **finite**: every body atom becomes a `FROM` alias drawn from a finite source. An unsafe variable would be a column with no `FROM` alias — SQL can't express that.

Types become SQL column types in the `CREATE TABLE` and in each view's implicit schema. Inferred types decide things like `+` vs. `||` for the concatenation overload, or `::TEXT` casts inside `STRING_AGG`.

A type-rejected rule is one Datamog *can't* compile, not one that compiles badly.

---

# Recap

- A rule is **safe** when every head variable (and every variable in a comparison, arithmetic, or negation) is bound by a positive body atom, range, or equality with a safe other side.
- Safety ↔ domain independence — answer depends only on the data, not on the universe.
- Datamog has **five basic types**: `string`, `integer`, `float`, `boolean`, `value`, plus `null` for the literal and a `?` for a column that can hold one. Two widenings: `integer → float`, and primitive → `value` via auto-lift.
- A `_` head position can carry a **proposition** instead of a type. It is checked against the derived tuples and erases; `--verify` proves it instead. A contract is the disjunction over a predicate's rules, so one unannotated sibling makes it vacuous.
- Both checks run **before** SQL is emitted. Bad programs get line-numbered errors, not runtime nonsense.

---

# Where to next

Safety handles "the variable must be bound somewhere". Negation needs more: a stratification discipline so the engine knows when to compute `p` before consulting `not p`.

[Chapter 8. Negation and stratification →](08-negation.md)
