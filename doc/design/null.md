# Design notes: why Datamog has NULL

Status: **superseded by [null-as-a-value.md](./null-as-a-value.md)**, which is
implemented. Kept because the reasoning is why the alternatives are not
reopened, and because two of its arguments turned out to be wrong in
instructive ways.

What changed. This doc describes a language where NULL does two jobs, marking
an undefined operation and carrying missing data. Those are now separate: an
undefined operation has **no value at all**, and `null` is an ordinary value
with its own type. So `1 / 0` withholds its row rather than storing a NULL, and
`X = null` binds rather than failing to type. The normative rules are spec §5.4,
now titled "Partiality and NULL".

What survives unchanged. There is still one equality, `=`/`<>` is still total and
null-aware over values, and §4's insistence that a shared variable and a
spelled-out `=` mean the same thing still holds. Read §4 as written.

What was wrong, beyond the framing. Four things, each marked in place below:

- **§5's ordering table.** `<`, `<=`, `>` and `>=` are now strict at a `null`: they
  have **no value** there, so `null <= null` is not true and an ordering bound to a
  variable derives no tuple. The wart §5 apologises for is deleted rather than
  defended. The connectives went the same way: `null && true` has no value, though
  `false && e` is still `false`.
- **§7's verdict that `null` cannot be a type.** It is one. The argument turns on
  putting `null` *below* the primitives; the successor makes it a sibling, and
  §7's objection does not reach that design.
- **§8's summary of what NULL does.** `count(e)` counts a `null`, `list` collects
  one, an **empty** group yields the fold's identity rather than `null`, and
  a JSON `null` leaf no longer collapses: `type_of` of one is `"null"`, and an
  absent key is distinguishable from a present-but-null one. An *all-null* group is
  not the empty case and does not take the identity: its nulls are contributions
  like any other, so `count` counts them and `list` collects them. For
  `sum`/`avg`/`min`/`max`/`concat` the case cannot arise at all, a nullable operand
  there being a static error.
- **§3's dismissal of partial expressions**, which answers a proposal nobody makes,
  and its rejection of option types, refuted by partiality being the case analysis
  it says a rule body has nowhere to put.

§6's Postgres warning still applies, to genuinely nullable columns only, which are
now rare.

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
(spec §1.5, and see §7 below), so no column is declared as "integer, or
maybe not".

That does not make NULL free. The cost is real, but it is a different cost
from the one the reflex is reaching for, and §6 states it exactly.

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

That paragraph is wrong, and
[partial-expressions.md](./partial-expressions.md) §1 says why: it answers
"partial expressions that abort", which nobody proposes, and misses "an
expression denotes the graph of the function it computes", which is what CodeQL
does and which leaves every property §2 asks for intact. That doc also disputes
the option-type rejection below, partiality being the case analysis this one says
a rule body has nowhere to put. Its conclusion is nonetheless to keep NULL, so
this section's verdict stands on other grounds than the ones it gives.

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

## 4. One notion of sameness

The obvious way to get NULL wrong is to end up with several answers to
"are these two values the same". SQL has that problem: `GROUP BY` folds
NULLs together, `DISTINCT` folds them together, and `=` does not. Datamog
has one answer, used everywhere, under which `null` equals itself and
nothing else.

**Tuple identity, used by set semantics.** Two NULLs are the same tuple, so
they deduplicate:

```prolog
q(X) :- X = 1 / 0.
q(X) :- X = 2 / 0.
q(7).
?- q(X).                  % {null, 7}: one null row, not two
```

**Aggregate grouping.** `GROUP BY` puts all the NULLs of a group key in one
group, on every backend and in both interpreters.

**The `=` and `<>` operators**, and body-level Equality. `null = null` is
true. Both are total: they return true or false, never NULL, which is what
makes `X <> null` a usable guard.

**Atom matching**, meaning a repeated variable across two atoms and a
literal argument against a column. A repeated variable and an explicit
equality are therefore interchangeable, which is what a variable *means* in
Datalog: `p(X), q(X)` is `∃x. p(x) ∧ q(x)`, and writing the equality out is
a meaning-preserving refactor.

```prolog
p(1). p(X) :- X = 1 / 0.
q(2). q(X) :- X = 1 / 0.
output predicate shared(X)  :- p(X), q(X).             % {null}
output predicate spelled(X) :- p(X), q(Y), X = Y.      % {null}, the same
```

**Negation**, whose inner comparison is atom matching, so negation is
complementation:

```prolog
q(X) :- X = 1 / 0.  q(7).
p(1). p(X) :- X = 3 / 0.
output predicate negated(X) :- p(X), not q(X).         % {1}
```

The NULL row of `p` is excluded, because `q` has one too.

### Why this departs from SQL

SQL would give `{}` for `shared` and `{1, null}` for `negated`, because its
join equality is three-valued: NULL matches nothing, including itself.
Datamog does not follow it, for two reasons.

**Datamog's NULL does not mean "unknown".** It means "this operation has no
defined result", which is a definite fact about a definite value. `1 / 0`
and `2 / 0` denote the same thing. Three-valued equality encodes the
unknown-value reading, and that reading is simply not what §2 produces.

**SQL is not an authority here, because it never faced the question.** SQL
has no repeated variables, so it never had to make an implicit equality
agree with an explicit one. Datalog does, and its semantics says the two are
the same thing. Following SQL would mean `p(X), q(X)` and
`p(X), q(Y), X = Y` denote different relations, with no way to write the
first one's behaviour out longhand.

The cost of departing is real and lands on one backend. §6 states it.

## 5. Comparison is total

No comparison operator ever returns NULL. That is the single rule; the rest
of this section is what it forces.

### One equality, not two

SQL needs two equalities because its `=` is three-valued and unusable
against NULL, so it bolts on `IS NOT DISTINCT FROM`. Datamog's `=` is
null-aware from the start, so the second one has nothing left to do.
A three-valued `==` would differ from `=` only in its null behaviour, and
that behaviour is gone, so there is no second family. Write `=` and `<>`.

`!=` is accepted as a spelling of `<>`, since it is what most programmers
type first. It is not a second operator: `parseRaw` rewrites it, so nothing
past parsing can tell the two apart and they cannot drift. There is
deliberately no `==` alias for `=`, because `=` at body level also *binds*
an unbound variable, and a second spelling for it would invite the
expectation that one of them only compares.

This also removes the one spelling that could make an implicit and an
explicit equality disagree, which is what §4 is about.

### Ordering: null is an isolated point

> **Superseded.** The orderings are now **strict** at a `null`: they have no value
> there, so every ordering cell below that involves a `null` is "no value" rather
> than true or false, and `null <= null` in particular is not true. The successor
> keeps this section's diagnosis, that `null` is outside the order, and draws the
> other conclusion from it: an operator that needs an order has nothing to say
> where its operand is not in one. The comparison of `=`/`<>` in the first two
> columns is unchanged. See null-as-a-value.md §4.1.

The non-null values keep their total order. `null` sits outside it,
comparable only to itself:

| left | right | `=` | `<>` | `<` | `<=` | `>` | `>=` |
|--------|--------|-------|-------|-------|-------|-------|-------|
| `5` | `5` | true | false | false | true | false | true |
| `5` | `6` | false | true | true | true | false | false |
| `5` | `null` | false | true | false | false | false | false |
| `null` | `5` | false | true | false | false | false | false |
| `null` | `null` | true | false | false | true | false | true |

This is a partial order and it satisfies the laws you would want of one:
`<=` is reflexive (including at null), antisymmetric, and transitive, and
`a < b` is equivalent to `a <= b ∧ a <> b` in every cell. What fails is
trichotomy, deliberately: an undefined number is neither below 2 nor
at-or-above it.

The alternative was to give null a position in the order, bottom being the
obvious pick, which would restore trichotomy. It is rejected because it
contradicts the aggregates: `min` and `max` skip NULLs on every backend
(spec §2.7), so `min` over `{1, null}` is `1`. If null were the bottom of
the order, that answer would be wrong. Treating null as outside the order
is what the aggregates already assume.

### What that fixes, and what it does not

**Fixed: `not` is complementation over comparisons.** A comparison is now
always true or false, so negating it always flips it:

```prolog
p(1). p(X) :- X = 3 / 0.
output predicate lo(X) :- p(X), X < 2.          % {1}
output predicate hi(X) :- p(X), not (X < 2).    % {null}
```

`lo` and `hi` partition `p`.

> **Superseded, and the example no longer runs this way.** `X = 3 / 0` now derives
> no tuple at all, so `p` is `{1}` and `hi` is empty. Write `p(null).` for the row
> this was reaching for; then `lo` is `{1}` and `hi` is `{null}` as shown, because
> the ordering has no value at the null and `not` holds of anything that does not
> hold. What is *not* fixed is complementation itself: `not` complements failure,
> so it holds where a comparison has no value, and only expression-level `!` is
> strict. See null-as-a-value.md §4.4.

**Not fixed: `not (X < 2)` is not `X >= 2`.** The NULL row is in the first
and not the second, because it is in neither `<` nor `>=`. That follows
from incomparability and no ordering design avoids it without inventing a
position for null in the order. Guard with `<> null` when it matters.

### What stays three-valued

The boolean connectives. `!null` is `null`, `null && true` is `null`, and
the rest of the table in spec §5.4 stands. Comparisons no longer *produce* a
NULL boolean, but one can still arrive from a nullable `boolean?` column,
from `as_boolean(null)`, or from any expression that propagates a NULL into
boolean position. Killing 3VL in the connectives would not remove NULL from
the language, only hide it, so the connectives keep propagating.

The line to draw: NULL propagates through *operations* and is absorbed by
*comparisons*.

> **Superseded.** Nothing stays three-valued. `!null` and `null && true` have no
> value, a null being no truth value, and a connective is non-strict only at its
> dominating operand, where `false && e` is still `false`. `as_boolean(null)` has no
> value either, a null being no boolean. What killed 3VL in the connectives was not
> a wish to hide NULL: it was that a connective which propagated a null while also
> being able to lack a value made a SQL NULL ambiguous between the two readings.
> The line this section draws survives one notch out: an operation that *computes*
> requires a non-null operand, and the constructs that *test* take one and fail.
> See null-as-a-value.md §15.26.

## 6. The price: null-aware joins on Postgres

> ⚠️ **WARNING — read before running a large join on the Postgres backend.**
> A join between two columns that can hold NULL compiles to
> `IS NOT DISTINCT FROM`, which Postgres cannot hash or merge. The plan
> degrades to a nested loop, which is quadratic. On a 50k × 50k integer
> join this is roughly five thousand times slower. The other four backends
> are unaffected. If you hit it, the fix is to make the columns non-nullable
> or to shrink the input; there is no flag.

Null-aware joins are what §4 buys, and they are not free everywhere.
Measured, on a 50k × 50k integer join:

| backend | plain `=` | null-aware | verdict |
| --- | --- | --- | --- |
| native, seminaive | scan | scan | free |
| sqlite, sql.js | 13 ms, automatic covering index | 13 ms, same plan | free |
| postgres | 6 ms, Hash Join | 32,557 ms, Nested Loop | ~5000× |

The interpreters are free because there is nothing to lose: the atom step
in `planner.ts` is a scan over `rel.tuples` with a per-tuple match, so the
equality predicate is called the same number of times either way. The
SQLite family is free because SQLite has no hash join to give up and builds
an automatic covering index for `IS` exactly as it does for `=`. Postgres is
the only engine whose planner has a strategy that the null-aware operator
cannot use.

Absolute numbers vary by machine and are not the claim. The plan shapes are,
and they are stable.

**Why this is accepted.** Datamog is a teaching implementation. Postgres is
its optional backend, skipped entirely unless `DATABASE_URL` is set, while
SQLite is the CLI default and sql.js is the playground. Paying a
large-join penalty on the one backend nobody runs by default, in exchange
for a language with a single notion of equality, is the right trade for
what this codebase is for. A production Datalog would decide differently.

**The escape hatch, if anyone ever needs it.** Emit the null-aware form
only where a column can actually hold NULL. EDB columns already carry the
information: they are `NOT NULL` unless declared `?`, so an EDB-only join
could keep its hash join with no semantic difference, there being no NULLs
to disagree about. IDB columns do not, since nothing tracks which of them
can produce a NULL and any rule can (`1 / 0` suffices). The missing piece is
a nullability analysis over IDB columns: a per-(predicate, column) boolean,
computed as a least fixed point over the dependency graph from "not
nullable" upward, the same shape as type inference. It originates at the
NULL sources in spec §5.4 (an EDB column declared `?`, a partial operation
in a head expression, a bare `null` head argument) and propagates through
any head expression mentioning a nullable variable. Aggregates propagate
rather than originate: a group exists only because a row exists, so `sum(X)`
is NULL only where `X` is nullable and some group is entirely NULL.

It is not built. Its standing cost would be a coupling to the builtin
registry, since adding a partial builtin without marking it as a NULL source
would silently under-approximate. That failure mode is benign, because
under-approximating means emitting a plain `=` and getting SQL's answer, but
it means the analysis is only ever as trustworthy as that list. Not worth
carrying until someone has a program that needs it.

It has since been built, with a surface syntax and a per-rule refinement rule on
top: see [nullness-tracking.md](./nullness-tracking.md) and spec §5.4. The
coupling objection is answered by making the declaration a required field on
`Overload`, so a new builtin that omits it does not compile, and by defaulting to
nullable where a default is unavoidable. That also disputes "benign" above:
emitting a plain `=` where a NULL can arrive is SQL's three-valued join, which is
what §4 refuses, so an under-approximation would change results rather than only
plans, and the analysis is built to over-approximate for exactly that reason.

The escape hatch is therefore open. A join takes the plain `=` when either side
cannot hold a NULL, which is most joins against extensional data, since an EDB
column is non-null unless declared `?`.

## 7. Why the static story stays clean

> **Superseded, and this is the argument that turned out to be wrong.** There *is*
> a `null` type: the literal has one, `X = null` binds `X`, and the type is checked
> like any other. The final paragraph below is the load-bearing mistake, and it is
> load-bearing on one word: it requires `null` to sit *below* the primitives, and
> then correctly shows that this makes `string ⊓ integer` inhabited. Making it a
> **sibling** of the primitives costs nothing and answers the objection, since
> nothing was added below them. What that buys is a static error where `X = null`
> is asked of a type that cannot hold one. The nullness *bit* survives beside the
> base type, exactly as this section describes it. See null-as-a-value.md §2 and
> §3.

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

Nullness *is* tracked, as a second component beside the base type rather than an
element within it: inferred per column, refined per rule from the guards that
imply non-nullness, and writable on a rule head as the same `?` suffix. That
leaves this section's verdict on a `null` *type* intact, the bit not being a
member of the base lattice and so unable to inhabit a base-type conflict. See
[nullness-tracking.md](./nullness-tracking.md) and spec §5.4.

Adding `null` as a *type* below the primitives does not work, and the reason
is worth recording so nobody re-derives it. For `p(X), X = null` to keep
working, `null` would have to be below every primitive. But then
`string ⊓ integer` is inhabited by it, so a variable shared between a string
column and an integer column stops being a type error and becomes a
null-typed predicate that silently carries NULL rows, since a shared
variable joins NULL to NULL (§4). See
[typing-and-safety-constraints.md](typing-and-safety-constraints.md) §2,
which also covers why the analyser's "no type information" element sits
*above* `value` rather than below the primitives.

## 8. Writing programs that survive NULL

> **Superseded in its last three bullets.** `count(e)` counts a `null`, so
> `count(X)` equals `count(*)` for any variable; `list` collects nulls, sorting a
> null first, so `length(list(V))` *is* the count of values; an empty or all-null
> group yields the fold's identity, `[]` for `list`, `0` for `sum`, `""` for
> `concat`; and a JSON `null` leaf no longer collapses, so `type_of` of one is the
> string `"null"` and an absent key is distinguishable from a present-but-null one.
> The reason given for the old behaviour, that a kept null would be unobservable,
> is what stopped being true. The first four bullets stand, with `<>` now also
> warned about over a partial operand. See null-as-a-value.md §7 and §8.

- Guard with `<> null` when a column can hold one. It is total, so it never
  silently drops the row you meant to keep. This is the answer to the one
  residual oddity in §5: `X < 2` and `X >= 2` do not cover the NULL row
  between them.
- There is one equality. `=` and `<>` are it, with `!=` accepted as a
  spelling of `<>`. There is no `==`.
- A shared variable and a spelled-out `=` mean the same thing, so refactor
  between them freely.
- On the Postgres backend, a large join over nullable columns is quadratic.
  See the warning in §6.
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
