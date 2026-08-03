# Design notes: why Datamog has NULL

Status: implemented. The normative rules are spec §5.4 (sources,
propagation, three-valued logic) and §2.6 (the two comparison families).
This note is the rationale, the alternatives rejected, and the sharp edges,
because none of that survives in a rule list. §5 records one specified
behaviour that is worth revisiting, and why it was left alone.

## 1. The reflex, and why it misfires

"Null is the billion-dollar mistake" is about null *references*: a language
where every reference type is implicitly nullable, dereferencing is
unchecked, and the failure mode is a crash at a site far from the mistake.
None of those three hold here.

Datamog's NULL cannot crash anything. Every operation is defined on it and
returns a value, so there is no dereference to get wrong and no exception to
propagate. The closer
analogy is IEEE `NaN`, or an option type flattened into the value domain
with all the plumbing done for you. The type system is also not implicitly
nullable in the way Hoare's target was: `null` has no type of its own
(spec §1.5, and see §6 below), so no column is declared as "integer, or
maybe not".

That does not make NULL free. The cost is real, but it is a different cost
from the one the reflex is reaching for, and §4 states it exactly.

## 2. Totality is the reason

Datamog's expression sublanguage is total by construction: spec §5.3
requires that an expression map an assignment of values to its free
variables to exactly one value, never diverging, never aborting, never
set-valued. Every operation that would be partial in the host language or
the database returns NULL instead: `1 / 0`, `x % 0`, `sqrt(-1)`,
`ln(0)`, `0 ** -1`, an overflowing `exp`, a malformed `parse_json`, a
missing `value` key, a wrong-shape accessor.

Totality is not a stylistic preference. It is what makes the language
declarative in the sense that matters:

- **A rule is a function of its data, not of its evaluation order.** If an
  expression could fail, whether a program succeeded would depend on which
  rows the engine happened to touch and in what order, which for a
  bottom-up fixed point is an implementation detail.
- **Backends must agree.** Datamog compiles the same program to Postgres,
  SQLite, sql.js and two interpreters. Postgres raises on division by zero;
  SQLite returns NULL; JavaScript returns `Infinity`. Picking NULL and
  enforcing it everywhere (`NULLIF` wrappers, `CASE` guards,
  matching checks in `values.ts`) is what makes those five agree. Picking
  "error" would mean picking *whose* error.
- **A fixed point needs every rule to be a total function.** Least fixed
  points are computed by applying rules until nothing changes. A rule that
  can abort partway is not a monotone function on relations, and the
  standard theory stops applying.

So your instinct is right, and it is worth stating the alternative sharply,
because it is not really available.

## 3. The alternatives, and why each is worse

**Partial expressions that abort.** The question is what a rule does when
one row's expression fails. Aborting the whole query makes success
data-dependent: adding a row to a CSV turns a working program into a
crashing one, with no static warning. Dropping the offending row instead is
*exactly* NULL plus a three-valued filter, only implicit and unspecified.
So this option either collapses into what we have or is strictly worse than
it.

**Totality by typing.** Rule out `1 / 0` statically, with a refinement type
saying the divisor is non-zero. This needs a solver in the analyzer, and
it cannot work anyway: divisors come from EDB columns, so the obligation is
about data the compiler never sees. You would end up with a runtime check,
which needs a value to produce when it fails, which is NULL.

**An explicit option type.** A real `Maybe` in the value domain, unwrapped
at each use. Datalog rule bodies have nowhere to put the case analysis:
there is no `match`, and a body is a conjunction of atoms, not a sequence
of statements. Every arithmetic expression would need an accompanying rule
for the failure branch, roughly doubling every program that divides.

**Defaults.** `1 / 0 = 0`, a failed parse gives `""`. This is the one
genuinely worse option: it makes wrong answers indistinguishable from right
ones, where NULL at least propagates and is visible in the output.

## 4. What it actually costs: three notions of sameness

Here is the real price, and it is sharper than "null is untidy". NULL is a
value for some purposes and not for others, and Datamog ends up with three
distinct notions of "the same".

**Tuple identity, used by set semantics.** Two NULLs are the same tuple, so
they deduplicate:

```prolog
q(X) :- X = 1 / 0.
q(X) :- X = 2 / 0.
q(7).
?- q(X).                  % {null, 7}: one null row, not two
```

**Logical equality `=` / `<>`, null-aware by design** (spec §2.6,
`IS NOT DISTINCT FROM` on Postgres, `IS` on the SQLite family). `null = null`
is true, and a filter built from it is total: it returns true or false,
never NULL. This is what makes `X <> null` a usable guard.

**Three-valued equality, used everywhere else.** `==`, the ordering
operators, the implicit equality of a repeated variable, and negation all
treat NULL as SQL's "unknown", so NULL matches nothing, including itself.

Two consequences follow that no amount of documentation makes comfortable.

**A filter and its negation do not partition.** Verified on native and
sqlite:

```prolog
p(1). p(X) :- X = 3 / 0.
output predicate lo(X) :- p(X), X < 2.          % {1}
output predicate hi(X) :- p(X), not (X < 2).    % {}
```

The NULL row is in neither. This one is irreducible: asking whether an
undefined number is below 2 has no good answer, and every SQL user already
lives with it. The mitigation is a `<> null` guard, not a language change.

**Negation is not complementation.** With `q` containing a NULL row, that
row is still in `not q`:

```prolog
q(X) :- X = 1 / 0.  q(7).
p(1). p(X) :- X = 3 / 0.
output predicate negated(X) :- p(X), not q(X).  % {1, null}
```

`null` appears in the result even though `q` contains `null`.

## 5. A specified divergence worth revisiting

This one is a decision, not an oversight. Spec §5.4 states it:

> Atom matching keeps SQL-style 3VL join semantics — a literal `null` in an
> atom argument never matches, and a shared variable across two atoms
> doesn't join NULL to NULL. Use an explicit body Equality
> (`atom(N, V), V = null`) when null-aware matching is wanted.

and [planner.ts:674](../../packages/backend/native/src/planner.ts#L674)
repeats it in code. The rest of this section is the case for revisiting it,
not a bug report.

A repeated variable and an explicit `=` are otherwise interchangeable. That
is what a variable *means* in Datalog: `p(X), q(X)` is `∃x. p(x) ∧ q(x)`,
and writing the equality out is a meaning-preserving refactor. Here they
differ, identically on native and sqlite:

```prolog
p(1). p(X) :- X = 1 / 0.
q(2). q(X) :- X = 1 / 0.
output predicate shared(X)        :- p(X), q(X).             % {}
output predicate logical(X)       :- p(X), q(Y), X = Y.      % {null}
output predicate computational(X) :- p(X), q(Y), X == Y.     % {}
```

The repeated variable compiles to a plain SQL `=` (three-valued), while the
`=` operator compiles to `IS NOT DISTINCT FROM` (null-aware).

Which one should move? The argument favours making the join null-aware,
because **Datamog's NULL does not mean "unknown"**. It means "this
operation has no defined result", which is a definite fact about a definite
value. `1 / 0` and `2 / 0` denote the same thing. Two of the three notions
of sameness in §4 already agree with that reading: dedup treats NULLs as one
tuple, and `=` treats them as equal. Only the join dissents, and the spec's
stated reason is fidelity to SQL. But SQL is the wrong authority on this
particular point: SQL has no repeated variables, so it never has to make an
implicit equality agree with an explicit one. Datalog does, and its
semantics says they are the same thing.

One change would align it, and it fixes two of the three sharp edges at
once, since negation's inner comparison is the same equality:

- `shared` would become `{null}`, matching `logical`, so the refactor is
  meaning-preserving again.
- `negated` would become `{1}`, so negation is complementation again.
- The `lo`/`hi` partition failure stays, because that is about ordering
  rather than equality, and it is genuinely irreducible.

Doing it unconditionally is nonetheless ruled out, by a measured margin.
`IS NOT DISTINCT FROM` is not a hashable or mergeable join predicate on
Postgres, so it collapses a hash join into a nested loop. On a 50k × 50k
integer join:

| join condition | plan | execution |
| --- | --- | --- |
| `t1.x = t2.x` | Hash Join | 6 ms |
| `t1.x IS NOT DISTINCT FROM t2.x` | Nested Loop | 32,557 ms |

Three to four orders of magnitude slower, and quadratic, so worse at scale.
The ratio varies by machine and the absolute numbers are not the claim; the
plan shapes are, and they are stable. Whatever happens here cannot be a
blanket substitution.

That leaves emitting the null-aware form only where a column can actually
hold NULL. EDB columns already carry the information: they are `NOT NULL`
unless declared `?`, so an EDB-only join keeps its hash join and is
semantically unaffected, there being no NULLs to disagree about. IDB columns
do not: nothing in the language tracks which of them can produce a NULL, and
any rule can (`1 / 0` suffices). So the precise fix needs a nullability
analysis over IDB columns, and that is the prerequisite for reopening any of
this.

Such an analysis is a per-(predicate, column) boolean, computed as a least
fixed point over the dependency graph from "not nullable" upward, the same
shape as type inference. It originates at the NULL sources in §5.4 (an EDB
column declared `?`, a partial operation in a head expression, a bare `null`
head argument) and propagates through any head expression mentioning a
nullable variable. Aggregates propagate rather than originate: a group exists
only because a row exists, so `sum(X)` is NULL only where `X` is nullable and
some group is entirely NULL.

It is not built, because with the decision below it would have no consumer.
Its standing cost is a coupling to the builtin registry: adding a partial
builtin without marking it as a NULL source would silently under-approximate.
That failure mode is benign here, since under-approximating means emitting a
plain `=`, which is what happens today, but the analysis would only ever be as
trustworthy as that list.

The remaining cost, whichever way it goes: a nullable-column join pays the
nested loop. One `1 / 0` in a recursive predicate would poison its column
and make a large recursive join quadratic, which is a sharp edge of its own.

**Decision: leave the behaviour as specified.** The semantics argument above
does not carry enough weight to justify either a new analysis or a
performance cliff that appears when someone adds a division to a rule. The
divergence stays, spec §5.4 stays normative, and the workaround it documents
(write the equality out when null-aware matching is wanted) is the answer.
The nullability analysis stays unbuilt for the same reason, and separately:
warning on a nullable-column join was considered and declined too, so it
would have no consumer. Both were weighed rather than missed.

## 6. Why the static story stays clean

None of the above leaks into the type system, which is worth saying because
it is what keeps the cost contained.

NULL is a runtime phenomenon. There is no `null` type: the literal is
polymorphic and acquires a type from context, every column has a non-null
declared base type, and inference never sees nullability.

Where there is no context to acquire a type from, the literal is rejected
rather than allowed through untyped. A bare `null` cannot ground a variable,
so `q(X) :- X = null.` leaves `X` unsafe. Name the type to write a NULL:
`as_integer(null)`, `as_string(null)`, `as_float(null)`, `as_boolean(null)`,
or `parse_json("null")` for a `value`. As a head argument
it is fine, since a sibling rule can type the column: `q(1). q(null).` yields
both rows. See spec §2.5 and
[typing-and-safety-constraints.md](typing-and-safety-constraints.md) §8.

An EDB column may
be declared nullable with a `?` suffix (`age: integer?`), which changes only
whether the generated table gets `NOT NULL` and whether loaders may pass a
NULL through; the Datamog base type used for inference is identical.

Adding `null` as a *type* below the primitives does not work, and the reason
is worth recording so nobody re-derives it. For `p(X), X = null` to keep
working, `null` would have to be below every primitive. But then
`string ⊓ integer` is inhabited by it, so a variable shared between a string
column and an integer column stops being a type error and becomes a
null-typed, always-empty predicate. See
[typing-and-safety-constraints.md](typing-and-safety-constraints.md) §2,
which also covers why the analyser's "no type information" element sits
*above* `value` rather than below the primitives.

## 7. Writing programs that survive NULL

- Guard with `<> null` when a column can hold one. It is total, so it never
  silently drops the row you meant to keep.
- Reach for `=` when you want null-aware matching and `==` when you want
  SQL's three-valued behaviour. The spelling difference is the whole
  interface; there is no flag.
- A shared variable joins three-valued, so it does not match NULL to NULL.
  When you want a join that does, write the equality out: `p(X), q(Y), X = Y`
  rather than `p(X), q(X)`. See §5, which is the one place the two are not
  interchangeable.
- Remember that `count(*)` counts rows while `count(expr)` counts rows where
  `expr` is non-null, and that `list` filters NULLs out of the array
  entirely. So `length(list(V))` is not the row count; `count(*)` is. An
  all-NULL or empty group gives `null`, not `[]`.

  `list` skips NULLs to match the rest of the aggregate family (spec §2.7),
  every member of which does, and because a kept NULL would be
  unobservable: a JSON `null` leaf collapses to SQL NULL, and the runtime
  expression model cannot distinguish it from an absent element (spec §2.9).
  Note that the SQL `FILTER` has to test the *raw* argument rather than the
  lifted one, since `json_quote(NULL)` yields the text `'null'` and would
  otherwise slip a JSON `null` into the array.
- A `value` column's JSON `null` leaf collapses to SQL NULL for
  cross-backend uniformity (spec §2.9), so `type_of` on it returns NULL
  rather than the string `"null"`. There is one NULL, not two.
