# Design notes: null as an ordinary value, undefinedness as partiality

Status: **in progress.** Stages 1 and 2 of §15.1 are built and green; partiality is next. This is the design
[partial-expressions.md](./partial-expressions.md) should have found and did not.
It supersedes that doc's recommendation: where that one concluded "keep NULL, at
most forbid it in columns", this one concludes "split NULL's two jobs apart, and
the objections to both halves dissolve".

The proposal in one paragraph. Today's NULL does two unrelated jobs: it is the
marker an undefined operation returns, and it is the value that missing data
carries. Give the second job to an ordinary value `null` with its own type, give
the first job to genuine partiality, and neither job needs the other's
machinery. Undefinedness stops being a value, so it stops needing a place in the
value domain, a position in the order, or a bit beside the type. `null` stops
being magic, so it stops needing three-valued comparison, a polymorphic literal
with no type, or `as_integer(null)` to write one down.

## 1 The rules

**Values.** The value domain gains `null` as an ordinary inhabitant, on a par
with `1`, `"a"` and `true`. Written as the literal `null`. Its type is `null`.

**Undefinedness.** An expression either denotes a value or is **undefined**.
Undefined is *not* a value: there is no `undefined` literal, no column can hold
it, and no variable can be bound to it. An operation is undefined when an operand
is undefined or when the operation has no result at those arguments: `1 / 0`,
`X % 0`, `sqrt(-1)`, `ln(0)`, integer overflow, a missing `value` key, a failed
`as_*` projection, a malformed `parse_json`.

**Where definedness is required.** Compositionally, per conjunct, which is what
makes this work:

| construct | holds when |
|---|---|
| atom `p(e₁ … eₙ)` | every `eᵢ` is defined **and** ⟨⟦e₁⟧ … ⟦eₙ⟧⟩ ∈ p |
| equality `e = f` | both defined and equal as values |
| filter `e` | `e` is defined and true |
| `not φ` | `φ` does not hold, for any reason including undefinedness |
| head | a tuple is derived only where every head expression is defined |

Stating it per conjunct rather than per rule is the detail that matters. An
earlier attempt (partial-expressions.md §2.3) said "a tuple is derived only when
every expression in the rule is defined", which is not compositional: it makes
`q() :- not p(1 / 0).` derive nothing, where these rules correctly derive `q()`,
because the undefined expression belongs to the negated subformula and its
failure is what `not` complements.

**Consequences the rules give for free.**

- `not (e = f)` holds when either side is undefined, so `e <> f` is not
  `not (e = f)`. Accepted; §4 shows the divergence is narrower than it sounds.
- `not (e = e)` holds exactly when `e` is undefined. The language gets a
  definedness test with no new syntax (§4.3).
- `p(1 / 0)` never holds and `not p(1 / 0)` always does, whatever `p` contains.

**Types.** The lattice gains `null` and the joins `T ⊔ null`, spelled `T?` (§3).
Types describe values, so **definedness is not a type-system notion at all**: an
expression of type `integer` denotes an integer wherever it is defined, and the
type says nothing about where that is. Type errors are static, domain errors are
runtime-partial, and the two stop being the same thing.

## 2 This answers the objection that killed a `null` type

null.md §7 records, at length and with instructions not to re-derive it, why
`null` cannot be a type:

> For `p(X), X = null` to keep working, `null` would have to be below every
> primitive. But then `string ⊓ integer` is inhabited by it, so a variable shared
> between a string column and an integer column stops being a type error and
> becomes a null-typed predicate that silently carries NULL rows.

The whole argument rests on that first premise, and this proposal removes it.
`null` is a **sibling** of the primitives, not a subtype of them, so:

- `string ⊓ integer` is still ⊥, still a static error, for the same reason as
  today. Nothing was added below the primitives.
- `string? ⊓ integer?` is `null`, which is **correct**, not a hole: a variable
  that must inhabit a nullable string column and a nullable integer column can
  only be null.

What made `null`-as-a-type look impossible was requiring `X = null` to type-check
for any `X`. It does not need to. `X = null` type-checks when `X`'s type has
`null` in it, which is what `?` means, and is a static error otherwise. That is
strictly better than today, where `X = null` is legal on any column and simply
never matches.

So the sibling placement is the missing move, and the verdict null.md §7 asks
nobody to reopen was correct about the design it considered and does not reach
this one.

## 3 The lattice

Add `null` as a fifth atom under `value` and close under join. `T?` is not a new
kind of type, it is a spelling of `T ⊔ null`.

```mermaid
graph BT
    bot["⊥"]
    int["integer"]
    flt["float"]
    str["string"]
    bool["boolean"]
    nul["null"]
    inq["integer?"]
    flq["float?"]
    stq["string?"]
    boq["boolean?"]
    val["value"]
    valq["value?<br/>the top"]

    bot --> int
    bot --> str
    bot --> bool
    bot --> nul
    int --> flt
    int --> inq
    flt --> flq
    str --> stq
    bool --> boq
    nul --> inq
    nul --> stq
    nul --> boq
    inq --> flq
    flt --> val
    str --> val
    bool --> val
    val --> valq
    flq --> valq
    stq --> valq
    boq --> valq
```

Twelve elements, height five, so inference still terminates by the same argument
as today. Checks worth having done:

- `integer ⊔ null = integer?`, `integer? ⊓ float = integer`, `integer? ⊑ float?`.
- `integer ⊔ string = value`, as today: the join stays total and incompatible
  primitives still widen rather than erroring.

### 3.1 Two corrections from building it

The lattice is implemented in `core/src/column-type.ts` and its laws are a test
(`core/test/column-type.test.ts`, which checks commutativity, associativity and
monotonicity over all twelve elements). Two claims above did not survive that.

**`value` and `value?` are distinct, so the lattice has twelve elements.** An
earlier draft had eleven, with `value` as the top admitting a null, and recorded
the resulting `integer ⊔ string` as an accepted over-approximation. There is
nothing to accept: `(value, false)` is a real element, "any JSON shape, never
null", and it is exactly what that join yields. The imprecision was an artifact of
presenting the lattice flattened. So `?` means the same thing on every base type,
`value` stops being a special case, and §11.4's question dissolves: `value?` is an
ordinary type, worth writing when JSON data can carry a null, and neither a
synonym nor an error. That is the third answer this point has had and the first
one arrived at by construction rather than by argument.

**`undefined` cannot be the meet's identity.** `meetTypes` in `types.ts` returns
`b` for `meetTypes(undefined, b)`, treating ⊥ as the meet's unit, which
type-lattice.md describes as `undefined` wearing two hats. That is not a lattice:
it breaks associativity and makes `meet(a, b) ⊑ a` fail, both of which the law
test catches immediately. The units are genuinely two different elements. The
join's is ⊥ and the meet's is the top, `value?`, which is a real element and
already behaves as the unit, since a `value?` slot accepts whatever the other side
requires. Consequence for the wiring: **a variable solve seeds at `value?`, not at
⊥**, and "this variable was never constrained" has to be tracked by the caller
rather than read off the seed.

Two things this changes for the better.

**Better: nullness-tracking.md's product collapses into the base lattice.** That
doc's componentwise meet, componentwise join, `publishedNullness` beside
`publishedTypes`, and the nullness halves of `checkHeadAnnotations` and
`checkModuleBoundaries` all become the ordinary meet, join, published type and
type checks. The parallel structure the user objects to is not simplified, it is
deleted, and this is the proposal's largest structural win.

**Better: nullability stops being infectious.** nullness-tracking.md §7 declined
the Kotlin reading (requiring `?` where a column can be null) on cost:
"every rule head containing a division, a `to_*`, an `as_*`, or a `value`
accessor would need an annotation, which is most non-trivial programs". That cost
was entirely an artifact of division producing NULL. Under partiality it does not:
`X = A / B` derives no tuple where `B` is zero, so the column's type is `integer`,
not `integer?`. **Nullability now arises only from an actual `null`**, meaning the
literal, a `?`-declared input column, or JSON data. Across the corpus that is one
column (`examples/expr-eval`) and one example's literals
(`examples/relational-algebra`). So partiality is what makes a `null` type
affordable, and the two halves of this proposal are not independent: each pays for
the other.

**Better: nullness-tracking.md §7's reason 1 is answered outright.** That
objection was that a flattened lattice launders nullness away at
`integer ⊔ string?`, leaving two `value` columns to join with a plain `=` and drop
the null-to-null match. The pair cannot lose the bit, because the bit has its own
join: `integer ⊔ string?` is `value?` and stays null-aware, while
`integer ⊔ string` is `value` and joins plainly. Both are exact. §3.1 records that
this is why the twelfth element has to exist.

## 4 Comparison, equality and negation

### 4.1 `=` and `<>` are total on values; the orderings are strict

`=` compares values. `null = null` is true because it is the same value;
`null = 1` is false because they are different values. Nothing three-valued, no
`IS NOT DISTINCT FROM` in the semantics, and `X = null` is an ordinary test rather
than a special form. `<>` is its complement **on defined operands**.

The orderings need an order, and `null` is not in one. Under §5's recommended
position they accept a `T?` operand and are **undefined** at `null`.

Compare against today's table (null.md §5). Rows that change are marked:

| left | right | `=` | `<>` | `<` | `<=` |
|---|---|---|---|---|---|
| `5` | `5` | true | false | false | true |
| `5` | `6` | false | true | true | true |
| `5` | `null` | false | true | *undef* | *undef* |
| `null` | `null` | true | false | *undef* | *undef* |

**In filter position nothing changes at all.** Undefined does not hold and false
does not hold, so every row that survives today survives, and vice versa. Under
`not`, `5 < null` was false and is now undefined, and `not` holds of both. The
only genuine divergences are:

- `null <= null`, today true and now undefined. That deletes the wart null.md §5
  apologises for, where `<=` was "true only when both are" null.
- a comparison **bound to a variable**, since `C = (5 < X)` had a value and now
  derives nothing. Narrow (§4.4).

So this proposal is very nearly observationally conservative on comparison, which
is worth knowing for migration: the corpus's filters and negations do not move.

### 4.2 The `<>` divergence, priced

`e <> f` requires both sides defined; `not (e = f)` does not. The divergence needs
an **undefined operand**, so it cannot arise between variables or literals:
`X <> null` and `not (X = null)` are interchangeable, and that is the guard people
actually write. It takes a compound partial expression, `A <> 100 / B` against
`not (A = 100 / B)`, which no corpus program writes.

Recommend a warning on `<>` with a partial operand, naming `not (a = b)` as the
other reading. That is the whole mitigation and it should be on by default.

### 4.3 `not (e = e)` is a definedness test

It falls out of the rules and it is worth documenting rather than leaving for
someone to discover, because it answers the one diagnostic complaint against
partiality. `divs(Q) :- s(V), Q = 10 / V.` silently omits the rows where `V` is
zero, and

```prolog
?- s(V), not (10 / V = 10 / V).      # the rows divs lost
```

names them. Obscure as an idiom, and it has a readable spelling as an ordinary
builtin, `not defined(e)`, provided the polarity goes the right way round. §11.6
works it out: `undefined(e)` cannot be a builtin and `defined(e)` can, because
strictness works for the second and against the first.

### 4.4 `not` and `!` stop agreeing, and `&&` must stay non-strict

Two places where the third outcome persists rather than disappearing, and both
must be stated because "partiality removes three-valued logic" is not one of this
proposal's benefits.

**`not` against `!`.** A comparison is a first-class expression in Datamog:
`C = (A = 100 / B)` binds `C` to a boolean and stores it in a column (verified
today, `C` is `false` at `B = 0`). Under this proposal the expression is undefined
there, so the rule derives nothing, while `not (A = 100 / B)` holds. Formula-level
`not` complements failure; expression-level `!` propagates undefinedness. They
agree today and cannot afterwards. Programs that never put a comparison in
expression position do not notice, which is nearly all of them.

**That distinction has an implementation consequence, and the implementation
currently goes the wrong way.** `post-process.ts` desugars a negated filter by
rewriting it into the other operator:

> Desugar negated filters (`not X = Y`) into `!(...)` over the same expression.
> Predicate-call literals are negated via `Literal.negated` and are left untouched
> here.

So today's `not` over a filter *is* `!`, which is sound precisely because
comparison is total and the two coincide. Under this proposal they do not, so the
rewrite silently gives `not` the wrong semantics on any filter with a partial
subexpression, and `not defined(e)` (§11.6) is the case where it matters most:
rewritten to `!defined(e)`, it is undefined exactly where it must hold. **Deleting
that rewrite is a prerequisite**, and a negated filter has to keep its `negated`
flag through to the backends, the way a negated atom already does.

**`&&` and `||` short-circuit over undefinedness.** `false && e` is `false` even
where `e` is undefined, and `true || e` is `true`. Required, not cosmetic: it is
what makes `X <> 0 && 10 / X > 0` bind a value rather than being undefined at the
case the guard exists to exclude, and it mirrors both SQL and today's table
(`null && false = false`). So the connectives remain non-strict in undefinedness
exactly as they are non-strict in NULL today. The absorbing boundary moved from
comparison outward to `not` and the connectives; it did not go away.

## 5 The central decision: what may an operation take a `T?`?

The proposal does not say, and everything downstream turns on it. Three coherent
positions.

**Position 1, strict.** `T?` is not `T`. Any operation requiring `T` rejects `T?`
statically, comparisons included. Narrow with a guard first. Nulls can never
silently vanish, because nothing can be applied to one. Cost: `X < 5` on a
nullable column becomes an error.

**Position 2, permissive.** `T?` goes wherever `T` does; applying an operation to
`null` is undefined, so the row drops. Nothing to narrow, nothing breaks. Cost:
the `null` type is documentation, and nulls silently drop rows, which is the
failure mode the type was introduced to expose.

**Position 3, hybrid. Decided.** Comparisons accept `T?` and are strict at
null. Everything else, arithmetic, string operations, `sum`, `min`, `max`,
requires narrowing.

Position 3 is the one that follows the language's own grain. null.md §5 already
draws a line in this exact place, "NULL propagates through *operations* and is
absorbed by *comparisons*", and Position 3 draws it one notch differently:
comparisons *accept* null and fail, operations *reject* it statically. The
justification is what each construct is for. A comparison is a guard, and a guard
failing is it doing its job. An arithmetic operation is a computation, and a
computation silently contributing no row is the bug you wanted the type for.

It also makes the corpus migration nearly free, since a comparison on a nullable
column keeps working and arithmetic on one appears once. And it is what keeps §9's
storage story single-valued, which was not part of the case for it and is the
stronger reason: it is the rule that stops a `T?`-typed expression from ever being
undefined, so a SQL NULL in a `T?` context has exactly one reading.

**Narrowing.** Per rule, order-independent, over the body's conjuncts, which is
the shape `refineBody` already has and for the same stated reason: a body is a
conjunction with no control flow, so a guard written last narrows an atom written
first. What narrows `X : T?` to `T`:

| conjunct | because |
|---|---|
| `X <> null`, `null <> X`, `not (X = null)` | direct |
| `X = e` where `e : T` | the equality holds only on a `T` value |
| positive atom position whose column is `T` | the value came from there |
| `X < e`, `X <= e`, and the rest of the orderings | strict at null, so holding implies non-null |
| `X in [lo .. hi]` | same |
| `f₁ && f₂` | whatever either narrows |
| `f₁ \|\| f₂` | whatever both narrow |

This is `refineBody`'s table with `nonnull` replaced by "type minus `null`", and
one row deleted: `<=` and `>=` now narrow, where today they prove nothing because
they were true of two nulls. A narrowing that lands on ⊥ is a static error and one
that lands on `null` is legal and worth warning about, being a rule that can only
ever fire on nulls.

## 6 Representation: do not extend `PrimitiveType`

The tempting implementation is to make `PrimitiveType` a ten-member union.
**Do not.** nullness-tracking.md §7 reasons 2 and 4 priced this and the price is
unchanged: `PrimitiveType` is compared against a literal string at **146 sites
across 25 files** outside tests, from `sqlTypeFor` and `liftToJsonIfNeeded` to
`coerceJsonColumns`, the loaders and both dialects. TypeScript reports the
exhaustive switches and says nothing about
`decl.columns.filter((c) => c.type === "value")`, which would quietly stop seeing
nullable `value` columns.

The saving observation is that **the semantics this proposal wants does not
require that representation.** nullness-tracking.md §7 already establishes that
the ten-element lattice is order-isomorphic to the product of the five-element
base lattice and the two-element nullness lattice. So keep the pair. What changes
is not the shape of the representation but what the second component *means*:

| | today | this proposal |
|---|---|---|
| the bit | SQL NULL may appear in this column | `null` is in this type's value set |
| set by | a `?` declaration, or any partial operation in a head | a `?` declaration, or an actual `null` |
| computed by | `nullness.ts`, a second fixed point beside inference | type inference, since it is part of the type |

And one element changes meaning rather than being added. nullness-tracking.md §7
reason 3 dismissed `(⊥, nullable)` as junk, "a nullness bit on an uninhabited type
denotes nothing". Under this proposal it is exactly the `null` type: the empty
base set plus `null`. So the product needs no new elements at all, only the
reinterpretation of the one it already had and called junk.

Practical consequence: `columnTypes` and `columnNullness` can stay two maps or
become one map of pairs. Merging them is a mechanical refactor with no semantic
content, worth doing for clarity, and not on the critical path.

## 7 Aggregates

- **Empty group. Decided (§11.5).** An aggregate folds a monoid, so over an empty
  group it returns that monoid's identity where one exists in the domain and is
  undefined where none does:

  | aggregate | folds with | empty group | today |
  |---|---|---|---|
  | `count(*)`, `count(e)` | `+` | `0` | `0`, unchanged |
  | `sum(e)` | `+` | `0` | `null` |
  | `concat(e)` | `++` | `""` | `null` |
  | `list(e)` | append | `[]` | `null` |
  | `min(e)`, `max(e)` | none in the domain | undefined, no tuple | `null` |
  | `avg(e)` | none, being `0 / 0` | undefined, no tuple | `null` |

  `count` is the one that does not move, which is worth stating because it is the
  aggregate people reach for when asking about this corner. Everything else drops
  a `null` it could not have stored anyway.

  This removes null.md §8's complaint that an empty `list` yields `null` rather
  than `[]`, and it is the same rule as the non-empty case rather than a special
  one: a group of rows whose arguments are all undefined has no contributions
  either, so `sum` is `0` there too and `min` is undefined there too. Nothing
  special-cases emptiness.

  **The accepted cost is about `count`, though its value is unchanged.** A head
  mixing `count(*)` with `min(V)` derives nothing over empty input, because one
  undefined head expression withholds the whole tuple, so the count becomes
  unobservable and the rule has to be split. That is a change in a corner spec
  §2.7 pins, and it is the price of the row being all-or-nothing.

  `isGroupingArg` and `hasGroupingColumns` survive untouched: they still answer
  "is this rule ungrouped", and the table above decides only what goes in the row.
  Worth saying because that function has been wrong twice
  (nullness-tracking.md §6) and this change does not reopen it.
- **Undefined argument.** A row whose aggregate argument is undefined contributes
  to no aggregate that mentions it and still counts for `count(*)`. Unchanged from
  today's NULL filtering, but it needs saying, since the natural reading of "the
  body must hold" would drop the row from every aggregate in the head.
- **The emit has an ordering trap, which is §9's collision again.** SQL's `SUM`
  returns NULL over no rows, and the integer domain guard returns NULL on
  overflow. Under this proposal those must go opposite ways, `0` and undefined, so
  **coalesce first and guard second**: `COALESCE(SUM(x), 0)` supplies the identity,
  then the domain check on that result withholds the tuple on overflow. Reversed,
  an overflow would silently become `0`. The same shape applies to `concat`
  (`COALESCE(..., '')`) and to Postgres `JSONB_AGG` (`COALESCE(..., '[]'::jsonb)`).

  SQLite goes the other way and gets a deletion: `JSON_GROUP_ARRAY` already
  returns `'[]'` over an empty group, and the dialect currently wraps it in
  `NULLIF(..., '[]')` specifically to turn that into NULL. That wrapper is
  today's behaviour implemented on purpose, so it simply goes.
- **`sum`, `avg`, `min`, `max` on `T?`** are static errors under Position 3.
  Narrowing works naturally inside an aggregate rule, since the guard is a body
  conjunct: `q(sum(X)) :- p(X), X <> null.` type-checks.
- **`count(e)` counts every row where `e` is defined, including where it is
  `null`. Decided**, on consistency: `count` counts values, and `null` is one, so
  skipping it would be special-casing the value this proposal exists to
  de-special-case. Three consequences to carry, none of them fatal but all needing
  a spec note. It diverges from SQL's `COUNT(col)` and from today. It makes
  `count(X)` equal `count(*)` for any variable, so the shorter spelling is always
  the better one and `count(X)` becomes a smell. And the old behaviour is awkward
  to recover, because Datamog has no filtered-aggregate syntax: a `X <> null`
  guard drops the row from the group entirely, which also changes `count(*)`
  beside it, so a rule wanting both counts has to be split. That last one is the
  real cost, and a filtered aggregate is the general fix if it ever bites.
- **`list`** collects defined values including nulls, so `length(list(V))` finally
  equals the count of defined `V`. Its sort key needs a position for `null`; put
  it first, and say so, since the aggregate's determinism is specified.
- **Grouping and dedup** treat `null` as the value it is, so nulls group together
  and deduplicate. Already true today and now true for a simpler reason.

## 8 JSON gains something it cannot express today

Today a JSON `null` leaf collapses to SQL NULL on read (spec §2.9), so an absent
key and a present-but-null key are indistinguishable, and `type_of` on a JSON null
returns NULL rather than `"null"`. null.md §8 records that as accepted rather than
liked.

Verified on `native`, over `{"k": null}`, `{}` and `{"k": 7}`:

```prolog
lookup(Id, X)  :- doc(Id, J), X = J["k"].              # today: null, null, 7
shape(Id, T)   :- doc(Id, J), T = type_of(J["k"]).     # today: null, null, "number"
present(Id)    :- doc(Id, J), X = J["k"], X = X.       # today: all three rows
```

Rows 1 and 2 are identical in all three, so the language cannot currently see the
difference between a field that is absent and a field whose value is null.

This proposal separates them:

| `J` | `X = J["k"]` | `type_of(J["k"])` | `X = X` |
|---|---|---|---|
| `{"k": null}` | defined, `X` is `null` | `"null"` | holds |
| `{}` | undefined, no tuple | undefined, no tuple | fails |

So `type_of(null)` is `"null"`, spec §2.9's collapse is deleted, a program can
distinguish "no such field" from "field present, value null", and §4.3's
definedness test does the distinguishing without new syntax. Real JSON makes that
distinction constantly and Datamog currently cannot see it.

## 9 Storage, and the two spellings of null

The one genuinely awkward consequence, and it needs stating plainly because it is
where the design meets SQL.

### 9.1 The problem

SQL has one NULL. This proposal gives it two jobs to distinguish:

- **undefined**, where the row must be dropped;
- **the `null` value**, where the row must be kept with `null` in the column.

Today there is nothing to distinguish, because both are the same thing. That
conflation is what the proposal removes, so the translator now has to decide,
for every SQL expression that can produce a NULL, which of the two it means.

### 9.2 The static type decides, and for four types it decides cleanly

| type | can be undefined? | can be `null`? | so a SQL NULL means |
|---|---|---|---|
| `integer`, `float`, `string`, `boolean` | yes (`A / B`, overflow, `as_integer`) | no, `null` is not in the type | undefined, so filter the row |
| `integer?`, `string?`, … | **no** | yes | the `null` value, so keep the row |
| `value` | yes (`J["k"]` on `{}`) | yes (`J["k"]` on `{"k":null}`) | ambiguous, see §9.3 |

The second row is the one worth checking rather than assuming, and it holds only
because of §5's hybrid position. Which expressions have type `T?`? A variable
bound from a `T?` column, and the literal `null`. Both are always defined.
Anything that could be undefined is a partial *operation*, and every partial
operation on a `T?` operand is a static error under Position 3. So under the
hybrid rule **no `T?`-typed expression can be undefined**, and the ambiguity
never arises. Note what this means: §5 is not only a usability decision, it is
what keeps the storage story single-valued. Position 2 would reopen it, since
`X + 1` on an `integer?` would be an `integer?`-typed expression that is
undefined at null.

### 9.3 `value` is the exception, and the collision is already in the code

A `value`-typed expression can be both nullable and partial, so one marker cannot
carry both readings. `value` therefore spells `null` the JSON way, JSONB `null` on
Postgres and the canonical text `null` on SQLite, and a SQL NULL in a
`value`-typed expression means undefined.

Two things checked rather than assumed, and both are good news for the cost:

**The canonical encoding already distinguishes them.** `canonicalizeJson` in
`engine/src/json-canonical.ts` renders a JS `null` as the text `"null"`, so the
`value` representation already has a spelling for JSON null that is not SQL NULL.
No storage format changes.

**The collision is present today, worked around, with a comment saying so.** The
SQLite `list` aggregate filters on the *raw* argument rather than the lifted one:

> The `FILTER` tests the *original* `argSql` (not `valueSql`) so SQL-NULL inputs
> are skipped. `json_quote(NULL)` returns the text `'null'` (not SQL NULL), which
> would otherwise pass the filter and emit a JSON `null` entry for what was really
> an absent value.

That is exactly the two meanings colliding. Under this proposal the workaround
becomes type-conditional instead of unconditional: for a nullable argument a JSON
`null` entry in the array is precisely right, and for a non-nullable one a SQL NULL
still means undefined and is still skipped.

**And spec §2.9's collapse is not a decision to delete, it is accessor behaviour
to change.** `jsonSubscript` on SQLite iterates the receiver with `json_each` and
matches the key: a missing key yields no matching row, and a key whose value is
JSON null yields a matching row whose `value` is SQL NULL. Both arrive downstream
as SQL NULL, which is the collapse. The fix is available inside that one function,
because `json_each` also exposes a `type` column that the dialect already uses
elsewhere for exactly this kind of shape recovery. So the work is a change to the
accessor emit, not a redesign.

### 9.4 So the concrete work is five places plus one lift

Every site that today reads "this is SQL NULL" has to ask the expression's type
first. There are five:

1. the head filter that drops undefined tuples (§1);
2. the `list` and `concat` aggregate `FILTER` clauses (§9.3);
3. the `value` accessors, subscript and slice (§9.3);
4. `defined`'s emit (§11.6), which is `IS NOT NULL` for a non-nullable or `value`
   argument and constant `TRUE` for a `T?` one;
5. the aggregate emits (§7), where `SUM` over no rows and an overflowing `SUM` are
   both SQL NULL and must go opposite ways, so the identity `COALESCE` goes inside
   the domain guard rather than outside it.

Plus one new conversion: **lifting `T?` to `value` maps SQL NULL to JSON null**, a
new case in `liftToJsonIfNeeded` where today there is none.

Five sites is the honest measure of §9's awkwardness, and the shape is the same at
every one: a SQL NULL means undefined unless the static type says otherwise.

- **The Postgres join cost survives for genuinely nullable columns.** A join on a
  `T?` column must match null to null, so it lowers to `IS NOT DISTINCT FROM` and
  null.md §6's quadratic-plan warning still applies there. What disappears is the
  *analysis*: the translator reads the column's type instead of consulting a
  separate nullness fixed point. And since §3 makes nullability rare, the warning
  now applies to a handful of columns a program declares deliberately rather than
  to anything downstream of a division.

## 10 Refinement contracts

Three changes, all in the right direction, and one is the payoff
partial-expressions.md §3.8 identified.

**A derived tuple witnesses its own definedness.** A head expression that is
undefined derives no tuple, so `def(head expressions)` joins the hypotheses. The
overflow guard stops falsifying plausible invariants. Of the five failures
refinement-annotations.md tabulates, `cyk-parser`'s `I < K`, `fibonacci`'s
`Curr <= Next` and `refinements`' `S < F` are all pure overflow artifacts and
would discharge; `slot`'s `S < E` and `population-query`'s `D >= 0` still fail,
correctly, being claims about input data. Residual 8 of that doc calls the domain
guard "the single largest reason a plausible invariant does not discharge", and
this removes it for every computed term.

**A variable's null bit comes from its type, not from an analysis.** Today every
free variable gets a `$null` companion Bool unless `nullness.ts` prunes it, and
`obligations.ts` records that without the pruning "every counterexample was an
artifact". Under this proposal an `integer`-typed variable structurally has no
null case, and an `integer?`-typed one does. Since §3 makes the latter rare,
almost no variable carries a companion, and the encoder loses its dependency on
`nullness.ts`.

**Comparison encodings simplify in the common case.** For non-nullable operands
`<` is `(< l r)` rather than today's guarded pair. For nullable operands it is
today's shape. Definedness conditions on compound terms remain, because overflow
and division still exist, and they are syntactic.

## 11 Decisions

All settled. Each is recorded with what it costs, so a reversal has something to argue against.

1. **Position 3, the hybrid (§5).** Comparisons take a `T?` and are strict at
   null; everything else needs narrowing. This turned out to carry more weight
   than its own section claimed, being also what keeps §9.2's storage reading
   single-valued.
2. **`count(e)` counts nulls (§7).** On consistency, accepting the SQL divergence
   and the split-rule cost.

3. **`object` and `array` are not types, and this proposal does not want them
   to be.** The framing said `null` sits under `value` "on a par with `string`,
   `object`, etc.", but `PrimitiveType` is exactly
   `'string' | 'integer' | 'float' | 'boolean' | 'value'`: `value` covers every
   JSON shape and there is no `object`. Decomposing it is genuinely orthogonal,
   and the ordering runs one way only, which is the part worth recording:

   - **Adding `null` first, shapes later, is additive.** Shapes arrive as further
     atoms under `value`, `?` applies to them uniformly, and §6's pair
     representation makes that free, since `?` is a bit rather than a member.
     Nothing in §3, §5 or §9 has to move.
   - **Shapes first would buy the null design nothing**, and §9.3 in particular is
     unaffected: a `value` accessor is both partial and null-valued whether or not
     its receiver's shape is typed.

   On whether they are worth it eventually, a caution rather than an answer.
   Shapes without *element* types buy very little: `J : array` does not give
   `J[0] : integer`, so `X = J[0] + 1` stays partial, and the only gain is turning
   `length`, `keys` and `values` from partial into total. The corpus does not ask:
   `keys`, `values` and `has_key` appear zero times across `examples/`, and only
   two example files declare a `value` column at all. The real prize is
   `array<integer>`, which is parametric types, a much larger language, and the
   natural home for it is
   [functional-sublanguage.md](./functional-sublanguage.md)'s deferred `data`
   declarations rather than a decomposition of `value`. That half is already
   deferred there, for corpus reasons and because its builders collide with proof
   terms.
4. **`value?` is an ordinary type, neither a synonym nor an error.** The question
   was posed on a false premise, that `value` must contain `null` and so `value?`
   adds nothing. Building the lattice showed `(value, false)` is a real and useful
   element (§3.1), so `?` means the same thing on every base type: `value` is any
   JSON shape but not null, `value?` admits one. No special case, nothing to
   learn, and the two earlier answers here were both attempts to paper over a
   presentation artifact.

   One migration consequence, small: a `value` column that can carry a JSON null
   must now say `value?`. The corpus declares two `value` columns in total.
5. **Empty-group identities (§7). Decided: take them.** An aggregate returns its
   monoid's identity over an empty group where the domain has one, and is
   undefined where it does not. `count` is unchanged at `0`; `sum`, `concat` and
   `list` move from `null` to `0`, `""` and `[]`; `min`, `max` and `avg` stop
   emitting a row. The accepted cost is that a head mixing `count(*)` with one of
   the last three derives nothing over empty input and has to be split.

   One further option, found and rejected: make the empty-group result `null`
   where the head position's declared type admits it and undefined otherwise,
   which would preserve today's answers under a `T?` annotation. Rejected because
   it makes an aggregate's value depend on an annotation, which contradicts the
   invariant that annotations never change results.
6. **A `defined(e)` builtin, and `not defined(e)` for the negative case.**
   Adopted, reversing this doc's earlier claim that no builtin could do the job.
   That claim was right about `undefined(e)` and wrong to generalise: the polarity
   decides it.

   Builtins are strict in undefinedness, so a call on an undefined argument is
   itself undefined. Put the interesting case on the *true* side and strictness
   defeats you, since `undefined(1 / 0)` would be undefined where it must be true.
   Put it on the *failing* side and strictness does the work:

   | `e` | `defined(e)` | holds? | `not defined(e)` |
   |---|---|---|---|
   | defined | `true` | yes | fails |
   | undefined | undefined, by strictness | no | **holds** |

   Undefined and false both fail to hold in condition position, so `defined(e)` is
   equivalent to `e = e` as a condition, exactly as intended, and `not` inverts it
   with no special form. A grammar change becomes a registry entry.

   Three riders, none fatal, all needing to be written down before anyone builds
   it.

   - **It depends on §4.4's rewrite being deleted.** `not defined(e)` desugared to
     `!defined(e)` is undefined where it must hold. This is the motivating case for
     that deletion.
   - **It must not go through the `value` lift.** The tempting registry shape is
     `type_of`'s, one overload on `value`, since everything lifts into it. That
     breaks here: `json_quote(NULL)` returns the *text* `'null'` rather than SQL
     NULL (the SQLite dialect says so, in the comment explaining why the `list`
     aggregate filters its raw argument), so lifting an undefined `integer` would
     hand `defined` something that looks defined. So either give it one overload
     per family at the nullable top (`integer?`, `float?`, `string?`, `boolean?`,
     `value`), so a nullable and a non-nullable argument both resolve without
     lifting, or add a wildcard parameter to the registry. The first needs no new
     machinery and follows `abs`'s two-overload shape.
   - **`defined(X)` on a bare variable is constantly true, and it is not
     `X <> null`.** A variable always denotes a value, null included. This is where
     the proposal's central distinction turns into a usability hazard, because the
     two readings are one keystroke apart and only one of them is ever what a
     reader means on a variable. Warn on it, and say the difference in the spec
     next to both.

   One property to document rather than fix: `defined(e)` is true-or-undefined and
   never false, so `C = defined(e)` cannot bind `false`. That is not a defect of
   the builtin, it is what `e = e` already does, and the way to get a storable
   boolean is the two rules that make the case analysis explicit.

   The static undefined-expression warning still catches the common case before
   the run; this is for after it.

## 12 The `?` operators, declined

The proposal floats `+?` such that `null +? x` is `null`, if they pull their
weight. They do not.

**No demand.** Null-propagating arithmetic is used today on *undefined* values,
which become partiality and need nothing. On genuine nulls the corpus has one
`integer?` column and one example's literals. There is no program that wants to
add one to a possibly-absent number and get a possibly-absent number.

**High cost.** A shadow copy of the operator table, an overload for every
combination of nullable operand positions, and a translator emit plus an
interpreter implementation for each. It also reintroduces implicit propagation,
which is the thing this proposal is removing, one operator at a time.

**A smaller general answer exists.** Datamog has no `coalesce`, which is the
operation people actually want: `Y = coalesce(X, 0) + 1`. One builtin, two
overloads, and it composes with everything rather than doubling the operator
table. Where a genuine `null` output is wanted, two rules express it, and the
second rule is the case analysis that today's implicit propagation hides. Add
`coalesce` if and when a program wants one; decline `+?`.

## 13 What survives of `nullness.ts`

- **`inferNullness`'s cross-predicate fixed point: deleted.** Column nullability
  is part of the column's type, so `inferTypes` computes it. This is the parallel
  analysis the proposal is meant to remove and it goes in full.
- **`computePublishedNullness`: deleted**, folded into `computePublishedTypes`,
  and with it the nullness halves of `checkHeadAnnotations` and
  `checkModuleBoundaries`.
- **`refineBody` and friends: kept, repurposed** as the type narrowing Position 3
  needs (§5). It stops answering "is this variable non-null" and starts answering
  "what is this variable's type in this rule", which is the same fixed point over
  the same conjuncts.
- **`mayBeNull`: split.** Its "can this expression produce a NULL" question
  becomes two: "is `null` in this expression's type", answered by inference, and
  "can this expression be undefined", answered syntactically from the operators it
  contains.
- **`isUngroupedAggregate`: deleted**, §7's identities replacing the rule it
  encoded.
- **`nullness-diagnostics.ts`**: the nullable-filter warning is replaced by an
  undefined-expression warning, and the complementary-ordering and negated-ordering
  warnings survive restated about undefinedness. All three currently fire nowhere
  in the corpus.

So the deletion is not primarily a line count, it is one of two fixed points and
one of two parallel type-like structures. That is what makes this cleaner than
either today's design or partial-expressions.md's Axis 1, and it is the answer to
the objection that prompted it: there is no longer a difference in kind between
what a column carries and what a variable carries, because `null` is a value and
undefinedness is not.

## 14 What it still costs

Nothing here is fatal, and none of it is hidden.

1. **Silent absence.** `divs(Q) :- s(V), Q = 10 / V.` loses its `V = 0` row with
   nothing in the output to say so, where today a visible `null` appears. This is
   unchanged from partial-expressions.md §5.2 and remains the strongest objection
   for a teaching implementation. Mitigations: the static
   undefined-expression warning, which arrives before the run rather than as a
   null in a table afterwards, and §4.3's definedness test for after it.
2. **`<>` is not `not (=)`** (§4.2), and `!` is not `not` (§4.4). Both narrow to
   compound partial expressions.
3. **Two spellings of null in storage** (§9), and a new lift between them.
4. **The Postgres join cost** persists for declared-nullable columns (§9), though
   the analysis to avoid it does not.
5. **`count(e)`** (§7, §11.2).
6. **The sweep.** Smaller than partial-expressions.md's, because §6 keeps the
   representation and §4.1 keeps filter and negation behaviour, but not small:
   spec §2.6, §2.7, §2.9, §5.3, §5.4, §5.5 and §5.10; `null.md` and
   `nullness-tracking.md` become historical; `values.ts` gains an `UNDEF` sentinel
   distinct from the `null` value; walkthrough 06 and 14; and the examples with
   nulls in `expected.json` (`json-events`, `parse-json`,
   `primitive-conversions`, `relational-algebra`).

Against that, two costs of the alternatives disappear. `examples/relational-algebra`
keeps its outer join, `left_join(X, null)` being an ordinary tuple with an
`integer?` column, where both today's `?` bit and Axis 1 make it awkward or
impossible. And holey input data needs no new discipline: `age: integer?` means
what a reader expects, and Position 3 makes the program say where it handles the
hole.

## 15 Verdict

Adopt this in preference to both today's design and partial-expressions.md's
Axis 1, subject to §11.

It is cleaner than today because NULL's two jobs stop sharing machinery: one
becomes a value with a type, the other becomes partiality, and the second fixed
point, the parallel published structure and the three-valued comparison table all
go with the conflation. It is cleaner than Axis 1 because there is no difference
in kind between a column and a variable, which was the objection that prompted
it. It is cheaper than it looks because §6 keeps the representation the last
attempt priced and rejected, §3 makes nullability rare enough for the strict
reading to be affordable, and §4.1 leaves filters and negations where they are.

### 15.1 Build order, as revised while building

An earlier draft put "the lattice and inference" first, as one self-contained
stage. The lattice is; the inference is not, and the two have to be separated.
Nullability under this design is "only an actual `null`", which is true only once
a division stops producing one. Wiring inference before partiality would mean an
analysis disagreeing with the runtime it describes. Meanwhile §6 already settles
that merging `columnTypes` and `columnNullness` into one map is a clarity
refactor rather than a prerequisite, so there is no large representation change
to do first either.

The order, with the two landed stages marked:

1. **The lattice, as pure functions.** Done: `core/src/column-type.ts`, with its
   laws as a test. §3.1 records the two corrections that test forced.
2. **Split `not` from `!`.** Done. §4.4's rewrite deletion, which is a
   prerequisite for §11.6 and is self-contained: it changes behaviour only where
   a NULL reaches boolean position, and all four runnable backends agree.
3. **Partiality**: the `UNDEF` sentinel in `values.ts`, the planner and evaluator
   dropping on it, the head filter, and the comparison lowering. This is the one
   stage that cannot land incrementally, since the backends have to agree at
   every commit and partiality changes all of them at once.
4. **Inference**, now that nullability means what §3 says: column types carrying
   the bit, narrowing per §5, head annotations and boundaries reading one type.
5. **§13's deletions**, unlocked rather than risky by that point.
6. **§7's aggregate identities**, then the spec and the corpus.

Two caveats to keep in view. The corpus cannot argue for this, because it barely uses
nulls at all, so the case rests on the design being simpler to explain rather than
on a program that gets better. And §14.1 is a real regression for a teaching
language, paid in exchange for a language that no longer needs a section
explaining why its NULL is not the billion-dollar mistake.
