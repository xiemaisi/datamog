# Design notes: partial expressions instead of NULL

Status: **superseded exploration; this proposal was not adopted as written.**
Partial expressions did ship under the different design in
[null-as-a-value.md](./null-as-a-value.md). A cheaper variant is recommended in
§8, and that doc then finds a better one again: this doc treats `null` and
undefinedness as one thing throughout, which is why its Axis 1 ends up
distinguishing what a column carries from what a variable carries. Splitting them
removes that distinction and most of §7's costs with it. Read this one for the
consequence map and the measurements, which carry over, and that one for the
design.

The premise under examination: an expression such as `b / c` has *no value* when
`c` is zero, so `a = b / c` does not hold, `p(b / c)` derives nothing, and a rule
whose head mentions it derives no tuple. This is what CodeQL does, at scale, in
production, which settles that it is practicable and moves the question to
whether it is right *here*.

Read [null.md](./null.md) first. This doc disputes one of its arguments and
agrees with two others, and it is not a rehearsal of them.

## 1 What partiality actually means, since null.md gets this wrong

null.md §3 lists "partial expressions that abort" among the rejected
alternatives and disposes of it in four lines: aborting makes success
data-dependent, and dropping the offending row instead "is *exactly* NULL plus a
three-valued filter, only implicit and unspecified".

Both halves miss. Nothing aborts, and nothing is unspecified.

The specification is one sentence: **an expression denotes a relation between
its free variables and its result, namely the graph of the function it
computes.** A partial function has a smaller graph than a total one, and that is
the whole of it. `a = b / c` is then not an assignment that might fail but a
conjunct with the graph of division,

```
{ (b, c, a) | c ≠ 0 ∧ a = trunc(b / c) }
```

and a rule body is what it always was, a conjunction of relations. Every
property null.md §2 says totality buys survives untouched:

- **A rule is still a function of its data, not of evaluation order.** The graph
  is a set; conjunction is commutative.
- **Backends still agree**, because the graph is specified, not delegated.
  Postgres raising and JavaScript returning `Infinity` are equally wrong, before
  and after.
- **A fixed point still needs monotone rules, and gets them.** A smaller graph
  is still a relation, so a rule is still a monotone function on relations. The
  standard theory does not notice.

So the option is coherent and null.md's dismissal of it does not stand. That
matters for §7's ledger but decides nothing on its own: null.md §3 has three
*other* rejected alternatives, and one of them, the option type, is the one this
change actually revives (§5.2).

## 2 The two axes, which the question conflates

The interesting result of this exploration is that "make expressions partial" is
two independent changes wearing one name, and almost all of the value sits on one
of them while almost all of the cost sits on the other.

**Axis 1: may a column hold an undefined marker?** Today it may: spec §5.4's
"Heads" paragraph says a rule whose head expression is NULL still emits a row.
The alternative is that such a tuple is simply not derived, so NULL exists only
*inside* an expression and never reaches storage.

**Axis 2: is the undefined marker inside the value domain or outside it?** Today
it is inside. `b / c` with `c` zero is not an undefined operand at all, it is an
ordinary operand holding the value `null`, and comparison is total over that
domain, so `A <> B / C` is *true* when `C` is zero. Outside the domain there is
nothing for a comparison to look at, and the condition simply does not hold,
which is CodeQL.

Stating the axis as "is such a condition false?" (an earlier draft of this doc
did) presupposes its own answer. Today the question does not arise, and §2.1 is
what the question becomes once it does.

Axis 1 is where nullness tracking, the Postgres join plan, the type system's
second component and most of the SMT encoding come from. Axis 2 is where the
`<>` footgun comes from, and it is the only source of it.

They compose but neither implies the other. The question as posed takes both;
§8 recommends taking Axis 1 alone.

### 2.1 Three answers, not two, and each gives up something

Once undefinedness is outside the value domain, an atomic condition mentioning it
has three defensible readings, and the third is the one an earlier draft of this
doc omitted. Three properties, of which any two are satisfiable and all three are
not:

- **P1.** `a <> b` means `not (a = b)`. One equality, negation complements it.
- **P2.** An atomic condition with an undefined operand does not hold.
- **P3.** Negation is classical: `not φ` holds exactly when `φ` does not.

Let `e` be undefined. P2 makes `a = e` fail and `a <> e` fail. P3 makes
`not (a = e)` hold. P1 then equates something that holds with something that does
not. So the corners are:

| gives up | design | `A <> e` | `not (A = e)` |
|---|---|---|---|
| P2 | **today**: `null` is a value, comparison is total over it | holds | holds |
| P3 | **SQL**: a third truth value, and `NOT UNKNOWN` is `UNKNOWN` | fails | fails |
| P1 | **CodeQL**: partial, negation classical | fails | holds |

All three rows are shipped designs, so this is a choice among conventions rather
than a correctness question. What each costs:

- **Today's corner** costs the value domain a member, which is where Axis 1's
  whole ledger comes from: something comparable is something storable.
- **SQL's corner** costs classical negation, which Datalog cannot afford.
  Stratified negation *is* complementation with respect to a derived relation, so
  `not p(X)` is classical whatever happens to comparisons. A three-valued `not`
  over conditions beside a classical `not` over atoms is two negations, which is
  a worse bargain than the two equalities null.md §5 congratulates itself on
  avoiding.
- **CodeQL's corner** costs P1, which §5.1 prices.

So the footgun §5.1 prices cannot be engineered away: the only escape from it is
SQL's corner, and Datalog has already spent P3.

### 2.2 Axis 2 also splits `not` from `!`, which is the same trade one level up

Datamog lets a comparison be an *expression*, not just a condition. Verified on
`native`, with `p = {(5,0), (20,5), (7,5)}`:

```prolog
cmp(A, B, C)  :- p(A, B), C = (A = 100 / B).    # (5,0) binds C to false
bang(A, B, C) :- p(A, B), C = !(A = 100 / B).   # (5,0) binds C to true
```

So totality is observable, not merely a filtering convention: the value reaches a
boolean column. Under Axis 2 there is no value to reach it, so both rules derive
nothing for that row, while `not (A = 100 / B)` still *holds* of it. Formula-level
`not` and expression-level `!` agree today and cannot afterwards.

That has a consequence worth stating plainly, because it undercuts the tidiest
argument for Axis 2. **Partiality does not remove the third outcome from the
language, it renames it and moves it.** Today the boolean connectives are
three-valued (`!null` is `null`, spec §5.4) and comparisons absorb NULL before it
reaches them, so null.md §5's summary is "NULL propagates through operations and
is absorbed by comparisons". Under Axis 2 that becomes "undefinedness propagates
through operations *including* comparisons, and is absorbed only by `not`, at the
formula level". The absorbing boundary moves outward by one layer; it does not
disappear. Programs that never put a comparison in expression position will not
notice, which is nearly all of them, and that is the mitigation rather than a
refutation.

### 2.3 Axis 1 is a rule about storage, and stating it about rules is wrong

An earlier draft stated Axis 1 as "a tuple is derived only when every expression
in its rule, head and body alike, is defined". That is not compositional, and one
program shows it:

```prolog
input predicate p(x: integer).      # empty
q() :- not p(1 / 0).
```

Under the rule-level reading the body mentions `1 / 0`, which is undefined, so no
tuple is derived and `q` is empty. That is wrong twice over: it disagrees with
today's answer *and* with Axis 2's, so a formulation meant to be the conservative
half of the change turns out to be the only one of the three that is odd.
Verified today on `native` and `sqlite`, `q` holds.

The mistake is treating an expression under `not` as belonging to the rule. It
belongs to the negated subformula, whose *failure* is what `not` complements. Fix
it by stating Axis 1 as one condition on storage and deriving the rest:

| | statement |
|---|---|
| stipulated | No column may hold NULL. |
| follows | A head tuple is derived only where every head expression is non-NULL, since there is nowhere to put one. This is the behaviour change (§5.2). |
| follows | An atom argument that is NULL matches nothing, so `p(1 / 0)` is false and `not p(1 / 0)` is true. |
| follows | A join never compares NULL against NULL, so plain `=` is sound everywhere (§3.5). |

The user-visible answer is then `q` holds, agreeing with today and with Axis 2.
Note it is now *statically* true rather than data-dependent: under Axis 1 no
extension of `p` can contain a NULL, where today the answer flips if `p`'s column
is declared `?` and the data supplies one. Verified today, with
`r(x: integer?, tag: string)` holding one NULL row: `r(1 / 0, "a")` matches it,
so the corresponding `q` is empty. That flip disappearing is the point of the
axis, and it makes `p(e)` with a statically-NULL `e` a dead atom worth warning
about (§6).

Two things this reformulation also settles, both in Axis 1's favour:

- **§2.2's `not` versus `!` split does not arise.** A comparison keeps its total
  boolean value, so `C = (A = 100 / B)` still binds `C` to `false` at `B = 0` and
  still derives its tuple. The split is Axis 2's alone.
- **The three-corner choice of §2.1 is untouched.** Axis 1 stays in today's
  corner, keeping P1, P2 and P3 exactly as they are, because it never asks a
  comparison to look at an undefined operand. It only refuses to store the result.

## 3 Consequences for the language

### 3.1 Logic and negation

`not` remains complementation, and remains complementation over a *bigger*
complement: `not (10 / X < 2)` holds where `X` is zero, because the inner
condition does not. The pleasant part is that this is already true today, and
`--dry-run` shows why. Today's `not (A = 100 / B)` lowers to
`NOT (a IS <expr>)`, and with `B` zero the inner `IS` is false, so the row is
kept. Partiality keeps it too, for a different reason. **In filter and negation
position, Axis 2 changes almost nothing observable**, because a NULL in a WHERE
conjunct already drops the row exactly as a false one would.

What it changes is the pair `<>` and `not (=)`, per §2.1, and `<=`/`>=` between
two undefined operands. Verified on `sqlite` and `native`, with
`p = {(5,0), (20,5), (7,5)}`:

```prolog
neg_eq(A, B) :- p(A, B), not (A = 100 / B).   # today {(5,0), (7,5)}.  After: unchanged
ne(A, B)     :- p(A, B), A <> 100 / B.        # today {(5,0), (7,5)}.  After: {(7,5)}
```

The two agree today and diverge afterwards, on exactly the row where the divisor
is zero. That single row is the whole of Axis 2's observable cost, and §5.1
prices it.

The trichotomy gap does not close. `not (e < 2)` is still not `e >= 2` whenever
`e` can be undefined, because the undefined rows are in neither. It does
*narrow*, and this is a real gain: under Axis 1 a bare variable ranges over a
column of actual values, so it is always defined, and `X < 2` against `X >= 2`
becomes a genuine partition. Today it is not one. So the language keeps the
warning but the shape it warns about needs a compound expression to arise, which
is rarer and more visibly the programmer's own construction.

### 3.2 Nullable input data, which is the crux

Everything else in this section is downstream of one question with no cheap
answer: real inputs have holes. A CSV cell is empty, a JSON object lacks a key,
a Postgres column is nullable. Today `age: integer?` handles it. If no column may
hold an undefined marker, `?` cannot mean what it means.

Four candidates, and only one survives.

1. **Reject a missing cell at load.** Coherent, and it is what CodeQL gets for
   free by never having a nullable column in its schema. Datamog does not have
   that luxury: it reads CSV, Google Sheets, JSONL, JSON over HTTP, and
   Postgres. The playground's `titanic` entry loads a dataset whose `age` column
   is famously incomplete. Rejecting is a data-source restriction dressed as a
   language rule.
2. **Skip the row.** Silent, unbounded data loss. No.
3. **Model the hole out of existence**, splitting `person(id, name, age?)` into
   `person(id, name)` plus `age(id, age)`. This is the correct relational answer
   and the right *advice*, and it is what CodeQL's extractors effectively do. As
   a language rule it means one CSV can no longer be one predicate, which is the
   loader contract in `directory-loader.ts` and the entire file-per-predicate
   convention.
4. **Make the hole a `value` holding JSON `null`, and unwrap it partially.**
   `age: value`, cells load as JSON, and `A = as_integer(Age)` is a partial
   projection, so rows with a hole derive nothing. Chosen, because it is the only
   candidate that keeps storage free of SQL NULL (JSONB `'null'` and SQLite's
   canonical text are values) while keeping one file to one predicate.

Candidate 4 is worth naming for what it is: **an option type, with partiality as
the case analysis.** null.md §3 rejected option types because "Datalog rule
bodies have nowhere to put the case analysis: there is no `match`, and a body is
a conjunction of atoms", so "every arithmetic expression would need an
accompanying rule for the failure branch". Partiality is the missing mechanism.
There is no failure branch to write, because the failure branch is the absence of
a tuple, and a conjunction is exactly where a partial projection belongs. **This
is the strongest intellectual argument for the whole change**, and it is an
argument for Axis 1, not Axis 2.

The cost is not zero and is not hidden. The corpus is small here, one `integer?`
column in `examples/expr-eval`, but the pattern is the one every real dataset
needs, so the cost lands on future programs rather than on existing ones. Each
such program gains an `as_*` call and a `value` column type where it had a
primitive.

### 3.3 The outer join loses its padding, and this one hurts

```prolog
# packages/cli/examples/relational-algebra/relational-algebra.dl
left_join(X, Y) :- a(X), b(Y), X = Y.
left_join(X, null) :- a(X), not b(X).
```

This is the corpus's only use of the `null` literal, and it is not incidental: it
is the textbook illustration of what NULL is *for* in relational algebra, in an
example whose job is to show that Datalog subsumes relational algebra. Under
either axis it must be rewritten with a `value` column and
`parse_json("null")`, which no longer looks like the relational operator it
models.

A teaching implementation losing the ability to write an outer join the way
textbooks write it is a real cost, and it is the one cost of this change that
cannot be mitigated by a diagnostic or an annotation.

### 3.4 Type system

Small and all in the same direction. The base lattice is untouched: five types,
`value` on top, meet within a rule, join across rules, `undefined` wearing its
two hats. Nothing about §type-lattice.md's core changes.

What goes:

- **The nullness component.** No column may hold an undefined marker, so
  `columnNullness`, `publishedNullness`, the `?` suffix on column declarations
  and on head annotations, the nullness half of `checkHeadAnnotations` and of
  `checkModuleBoundaries`, and the whole product-lattice story in
  nullness-tracking.md §2 all go. type-lattice.md's closing section
  ("Nullness is not in this lattice") reduces to a sentence.
- **null.md §7's argument that `null` cannot be a type.** Careful, correct, and
  moot once the literal is confined to JSON.
- **The strictness/totality pair on `Overload`.** `strict` licensed backwards
  reasoning from a guard, which no longer exists to be done. `total` becomes a
  single `partial` bit, still required (a new builtin must declare whether it can
  be undefined, for §3.8's encoding and §6's diagnostic), so
  nullness-tracking.md §5's answer to the registry-coupling objection carries
  over unchanged.

What stays: `columnTypesCompatible`, overload resolution, `liftToJsonIfNeeded`,
`sqlTypeFor`, result coercion. All of them read the base component today and are
untouched, which is the point nullness-tracking.md §7 reason 2 already made in
the other direction.

### 3.5 The nullness analysis mostly stops existing

`core/src/nullness.ts` is 519 lines and `core/src/nullness-diagnostics.ts` is
224. Its stated payoffs (nullness-tracking.md §1) fare as follows.

**Payoff 1, the plain `=` and the 5000x Postgres join, is obtained
unconditionally and for free.** No column holds NULL, so every join is a plain
`=`, always hash-joinable. The analysis exists to recover this in the cases it
can prove; Axis 1 makes it true in all of them. null.md §6's warning, the only
warning in the design docs with a measured number attached, is deleted rather
than mitigated. This is the largest concrete win of the change.

**Payoff 2, the three diagnostics.** The nullable-filter warning is replaced by a
better one (§6). The complementary-ordering and negated-ordering warnings survive
in definedness form, now about compound expressions rather than about columns.
All three currently fire nowhere in the corpus, by nullness-tracking.md §6's own
admission.

**Payoff 3, the module boundary contract.** Gone with the bit, and it was free
rather than valuable.

**Payoff 4, the refinement encoder's non-nullness source.** See §3.8: it is
replaced by a structural fact rather than an analysis.

What survives, and it is worth spelling out rather than compressing, is a
residual per-rule question. Axis 1 forbids NULL in *columns*, not in
*expressions*, so a NULL can still exist inside a rule body. There is now exactly
one way to make one:

```prolog
q(...) :- s(V), X = 10 / V, ...
```

`V` comes from an atom position, so it ranges over a column, and no column holds
NULL: **`V` is non-null, always, with nothing to prove.** `X` is bound by an
equality to an expression containing a partial operation, so `X` may be NULL
inside this body. That is the whole of the distinction: **a variable is non-null
unless the rule itself computed a NULL into it.**

Three consumers still care. The translator, which must keep the null-aware `=`
for a body equality between two such variables (`X = 10 / A, Y = 10 / B, X = Y`
holds today when both divisors are zero, and Axis 1 keeps comparison total, so it
must keep holding). The obligation encoder, which gives such a variable a `$null`
companion and nothing else one. And the head filter of §2.3, which is exactly
"can this head expression be NULL".

**How much of `nullness.ts` this deletes is a choice, not a measurement**, and an
earlier draft quoted only the optimistic end of it.

- **Certainly gone**: `inferNullness`'s cross-predicate fixed point,
  `computePublishedNullness`, `isUngroupedAggregate`, the `columnNullness` lookup
  inside `refineBody`, and the `object_entry` / `array_element` value-slot caveat
  (a JSON null becomes a value, §3.7). Around 150 lines.
- **Optional**: the guard-based refinement apparatus, `refineTrue`, `refineFalse`,
  `strictVars`, `nullTestVars`, `isStrictOp`, roughly another 110. It exists to
  *recover* non-nullness that a nullable column lost, and under Axis 1 no column
  loses any. Keeping it buys precision (`X = 10 / V, X <> null` proving `X`
  non-null, so a later join can take the plain `=`); dropping it costs only that,
  since the imprecision is toward the null-aware form, which is always correct.

So 519 lines become about 370 if the refinement is kept for precision and about
100 if it is not. The encoder barely notices the difference, since what it needs
is that a *column-derived* variable has no `$null` companion, which is the branch
that survives either way.

### 3.6 Aggregates and empty groups

Today an ungrouped aggregate emits one row whatever the body does, filled with
`0` for `count` and NULL for everything else. Verified on `native`:
`tot(sum(V), count(*), min(V), list(V)) :- s(V).` over empty `s` gives
`(null, 0, null, null)`.

Under partiality the sensible reading, and CodeQL's, is that an aggregate with an
identity returns it and one without is undefined:

| aggregate | empty group |
|---|---|
| `count(*)`, `count(e)` | `0` |
| `sum(e)` | `0` |
| `concat(e)` | `""` |
| `list(e)` | `[]` |
| `min(e)`, `max(e)`, `avg(e)` | undefined, so the tuple is not derived |

This is better on the merits and removes two documented warts: null.md §8's note
that an empty `list` gives `null` rather than `[]`, and the `count(e)` versus
`length(list(e))` discrepancy that follows from `list` filtering NULLs.

It also costs something specific, and the cost should not be smuggled past. A
head mixing `count(*)` with `min(V)` derives nothing over empty input, so the
count becomes unobservable and the rule has to be split. That is defensible ("the
minimum of nothing does not exist") but it is a behaviour change in a corner the
spec currently pins (§2.7), so every example with an ungrouped aggregate over
possibly-empty input needs re-checking. Not surveyed here.

Within a group, a row whose aggregate argument is undefined contributes nothing
to *that* aggregate and still counts for `count(*)`, exactly as today's NULL
filtering does. No change, but it needs stating, since the natural reading of
"the body must hold" would drop the row from every aggregate in the head.

### 3.7 JSON and `value`, which get better

Today `J["missing"]` is NULL, a JSON `null` leaf collapses to SQL NULL on read
(spec §2.9), and `type_of` on one returns NULL rather than `"null"`. null.md §8
records that last one as accepted rather than liked.

Under partiality the two notions separate cleanly and both improve. A missing key
is *undefined*, so `person(J), Name = J["name"]` naturally skips objects with no
name instead of binding `Name` to a null that then propagates. A JSON `null` is
an ordinary `value` inhabitant, so `type_of` answers `"null"`, and §3.2's
candidate 4 has somewhere to put a hole. "There is one NULL, not two" becomes
"there is one JSON null and no SQL null", which is a stronger and simpler
commitment.

### 3.8 The precondition language, where the real surprise is

The user's stated motivation is that NULL complicates the translation of
contracts for theorem proving. It does, and partiality helps more than the
obvious inspection of `obligations.ts` suggests, but not in the way one expects.

**The obvious win is real but partial.** Today every term is a `(v, isNull)`
pair, every free variable gets a `$null` companion Bool unless the analysis
prunes it, and the comparisons are written out longhand:

```smt2
; today, a <= b
(or (and a$null b$null) (and (not a$null) (not b$null) (<= a b)))
```

Under partiality the pair becomes `(v, def)`, the comparisons lose their
both-null disjuncts, and, more importantly, **a variable is structurally defined**
because it ranges over a column of actual values. The companions disappear for
free variables rather than being pruned, and the encoder loses its dependency on
`nullness.ts` altogether. But the pair itself does *not* go away: `I + 1` can
leave the integer domain, so compound terms still carry a definedness condition.
It is syntactic rather than analysed, which is the whole of that saving.

**The unobvious win is much larger, and it is a semantic one.** Under Axis 1 a
tuple whose head expression is undefined is not derived, so **definedness of the
head expressions joins the hypotheses.** An obligation is discharged about
tuples that exist, and a tuple's existence now witnesses that its arithmetic
stayed in the domain.

Take refinement-annotations.md §4.2's worked failure, which that doc spends a
paragraph explaining:

```prolog
span(NT, I, I + 1 as K, _: I < K) :- token(I, W), lexicon(NT, W).
```

Today the obligation is `K = I + 1 ⊢ I < K` and it **fails**, because `I + 1` is
NULL at the top of the integer domain, `K` is then NULL, and an ordering is false
at NULL. The doc's advice is to add a second claim bounding `K`, or to bound the
input. Under Axis 1 the obligation is `def(I + 1) ∧ K = I + 1 ⊢ I < K`, the
hypothesis supplies the domain bound, and it **discharges**.

That is not one example. Of the five failures refinement-annotations.md §"What
this buys, measured" tabulates, three are exactly this shape:

| obligation | today | under Axis 1 |
|---|---|---|
| `cyk-parser`: `span`'s `I < K` | fails: `I + 1` can overflow | discharges |
| `fibonacci`: `Curr <= Next` | fails: same overflow | discharges |
| `refinements`: `padded`'s `S < F` | fails: `E + 60` can overflow | discharges |
| `refinements`: `slot`'s `S < E` | fails: property of the data | still fails, correctly |
| `population-query`: `D >= 0` | fails: overflow *and* `A = 0` | still fails: needs `P >= 0`, `A > 0` |

And the same doc's residual 8 states that the domain guard "is the single largest
reason a plausible invariant does not discharge", with `examples/binary-search`
needing `_: 1 <= N, _: N <= 1000000` on its input to get anywhere. Axis 1 removes
that reason for every *computed* term, leaving it only where a genuine claim about
input data is missing, which is where a failing obligation should point.

So the motivating complaint is well founded, the fix is bigger than expected, and
it comes from Axis 1. Axis 2 adds only the cosmetically simpler comparison
encodings.

### 3.9 What is unaffected

Worth listing, because the change looks more invasive than it is.

- **Safety and range restriction.** Definedness is a runtime property.
  `X = Y / 0` still binds `X` statically; the predicate is just empty. The one
  change is a deletion: null.md §7's rule that a bare `null` cannot ground a
  variable goes with the literal.
- **Stratification, parity strata, the alternating fixed point.** Nothing here
  touches polarity or SCC structure.
- **Proof terms.** The proof column is an object literal, always defined.
  refinement-annotations.md §4.1 excludes proof-carrying predicates from tier 1
  for unrelated reasons, which stand.
- **Modules.** `checkModuleBoundaries` loses its nullness half and keeps its
  types.
- **Set semantics and dedup.** Fewer tuples, same equality on the ones that
  exist, and one fewer question ("do two NULLs dedup") to answer.

## 4 Consequences for the implementation

### 4.1 The SQL translator gets simpler, and `--dry-run` shows how

Today's emitted SQL for `q(A, B, Q) :- p(A, B), Q = A / B.`:

```sql
SELECT DISTINCT __b0."a", __b0."b", (WITH __datamog_safe_integer("value") AS
  (SELECT (__b0."a" / NULLIF(__b0."b", 0)))
  SELECT CAST((CASE WHEN "value" BETWEEN -9007199254740991 AND 9007199254740991
    THEN "value" ELSE NULL END) AS INTEGER)
  FROM __datamog_safe_integer) AS col3 FROM "p" AS __b0
```

The NULL-producing machinery, `NULLIF` on the divisor and the domain `CASE`, is
**exactly a definedness marker already**. Partiality does not replace it; it adds
a filter where the marker would otherwise escape into a column. Concretely, one
extra nesting per rule with a partial head expression:

```sql
SELECT * FROM ( <the select above> ) WHERE col3 IS NOT NULL
```

which is one place in `translateRule`, needs no expression duplication, and works
inside a recursive CTE (Postgres's `singleRecursiveTerm` already wraps rule
bodies in a `LATERAL`).

Against that, several things are deleted:

- `sqlEqWithJsonLift`'s `plainEq` parameter, its threading through the join and
  atom-match paths, and `IS NOT DISTINCT FROM` / `IS` entirely. Plain `=`
  everywhere.
- `totalOrderingSql`'s three branches and its `cannotBeNull` calls. Under Axis 1
  an ordering is plain SQL, and NULL in a WHERE conjunct drops the row, which is
  what an ordering at an undefined operand should do.
- The `mayBeNull` / `NullnessContext` plumbing in `translateRule`.

Added, for Axis 2 only: a negated condition needs totalising, `NOT COALESCE(φ,
FALSE)`, since `NOT NULL` is NULL and would drop a row that should be kept. That
is one `COALESCE` per `not`, against today's one per ordering comparison. Roughly
a wash.

Net assessment: the translator's null-related surface (20 sites matching
`NULLIF|IS NOT DISTINCT|COALESCE|IS NULL`) shrinks, and the shrink is
concentrated in the fiddly parts.

### 4.2 The interpreters need a real distinction

`values.ts` (785 lines, 131 `null` mentions) returns `null` for every partial
operation. Since §3.7 makes JSON `null` a legitimate value, the interpreters need
a distinct `UNDEF` sentinel and must propagate it through arithmetic, comparison,
accessors and aggregate reduction, with the planner dropping a binding at the
boundary. Mechanical, testable, and the largest single mechanical edit in the
change. `planner.ts` has one atom-match choke point per binding, so the number of
boundary sites is small.

### 4.3 Loaders and DDL

`coerceValue`/`checkValue` stop passing NULL through, `?` leaves `ColumnDecl`,
and every generated column is `NOT NULL`. §3.2 candidate 4 moves a holey column
to `value`, which the loaders already know how to fill.

## 5 Pragmatics

### 5.1 The footgun, priced

The `<>` versus `not (=)` divergence, together with its one-layer-up twin in §2.2
(`not` versus `!`), is Axis 2's only real cost, and the usual framing ("beginners
will trip over it, but so does NULL") understates one thing and overstates
another.

Understated: **Datamog has no syntax at which the divergence can show itself.**
CodeQL writes `not exists(...)`, and the `exists` is a visible scope marker that
tells a reader something non-obvious is happening. Datamog writes `not (...)`,
which looks like ordinary boolean negation and is not. In CodeQL the surprise has
a place to live in the source; here it does not.

Overstated: the divergence is narrow. It arises only where a comparison's operand
is a compound partial expression. `A <> B` over two columns is unaffected, and
that is nearly every comparison in the corpus.

### 5.2 Silent absence replaces a visible NULL, and this applies to Axis 1 too

Verified on `native`, with `s = {0, 1, 3}`:

```prolog
divs(Q) :- s(V), Q = 10 / V.        # today: {null, 10, 3}.  After: {10, 3}
```

Today the undefined case is *in the output*, at the column where it happened.
After the change it is gone, and nothing says so. For a teaching implementation
that is the wrong direction, and it is the strongest single objection to the
change on either axis.

Two things soften it, neither completely.

Today's language is already silent in filter position: `p(X), 10 / X > 0` drops
the `X = 0` row with no trace, and nullness-tracking.md's nullable-filter warning
exists because of it. So the current behaviour is *inconsistently* silent, loud
in a head and quiet in a filter, and partiality makes it uniformly quiet. Uniform
is better than arbitrary, and quiet is worse than loud.

And the compensating diagnostic is cheap, syntactic, and better than the null it
replaces: warn at analysis time that a head expression can be undefined, naming
the operation, so the message arrives before the run rather than as a null in a
table afterwards. That is strictly more useful than today's warning, which fires
nowhere.

## 6 Diagnostics the change would owe

- **Undefined head expression.** A rule whose head can be undefined derives
  fewer tuples than its body suggests. Syntactic, per rule, names the partial
  operation. This is the replacement for the nullable-filter warning and the
  answer to §5.2.
- **Complementary-ordering gap**, kept from nullness-diagnostics.ts, restated
  about definedness. Narrower than today, since bare variables are always
  defined.
- **Negated ordering over a partial operand**, likewise.
- **`<>` on a partial operand** (Axis 2 only), pointing at `not (a = e)` as the
  other reading. This one is the footgun's only mitigation and it should be on by
  default.
- **A comparison in expression position whose operands can be undefined**
  (Axis 2 only), per §2.2, since the rule derives fewer tuples than a reader
  expecting a boolean would predict.
- **A dead atom**: an atom argument that is statically NULL can match nothing
  once no column holds one, so `p(1 / 0)` is constantly false and
  `not p(1 / 0)` constantly true (§2.3). Cheap, syntactic, and it catches the
  shape that made the wrong formulation plausible.

## 7 The ledger

**For.**

1. Nullness tracking collapses. Between 220 and 480 lines of the 743 in
   `nullness.ts` and `nullness-diagnostics.ts`, the spread being the design
   choice in §3.5 rather than uncertainty, plus the `?` grammar slots,
   `publishedNullness`, the nullness halves of two checkers, and the
   corresponding tests. Call it 300 to 600 all told. The cross-predicate fixed
   point goes at either end, which is the part that costs comprehension rather
   than lines.
2. The Postgres quadratic-join warning is deleted rather than mitigated. Plain
   `=` everywhere, unconditionally.
3. Refinement obligations gain definedness hypotheses, which discharges three of
   the five documented corpus failures and removes what that doc calls the single
   largest reason an invariant does not discharge (§3.8).
4. The SMT encoder loses its free-variable `$null` companions and its dependency
   on the nullness analysis.
5. JSON improves: a missing key is undefined, a JSON `null` is a value,
   `type_of` stops lying (§3.7).
6. Empty-group aggregates get identities, retiring two warts (§3.6).
7. The option type becomes usable, which is the modelling answer for holey data
   and refutes null.md §3's rejection of it (§3.2).
8. Two design docs' worth of careful reasoning about a `null` type, a nullness
   lattice and a nullness bit stop being needed.

**Against.**

1. Holey input data needs a new discipline and a `value` column where a
   primitive used to do (§3.2). The corpus barely exercises this; every real
   dataset does.
2. The relational-algebra outer join cannot be written the way textbooks write
   it (§3.3). Unmitigable.
3. A visible NULL becomes a silent absence (§5.2), in a teaching implementation,
   partly compensated by a static warning.
4. `<>` stops meaning `not (=)`, with no syntax at which the divergence is
   visible (§5.1), and `not` stops agreeing with `!` for the same reason one
   layer up (§2.2). Axis 2 only. Note also what this does *not* buy: the third
   outcome is renamed and moved outward, not removed (§2.2), so "partiality gets
   rid of three-valued logic" is not among the arguments for it.
5. `min`/`max`/`avg` in a head with `count(*)` makes the count unobservable over
   empty input (§3.6).
6. The trichotomy gap narrows but does not close (§3.1).
7. The sweep. Spec §2.6, §2.7, §2.9, §5.1, §5.3, §5.4, §5.10 and §5.11, with 178
   `null` mentions in `spec.md` and §5.4 being 200 lines of it; `null.md` (377)
   and `nullness-tracking.md` (560) become historical; `refinement-annotations.md`
   §4.4 rewritten; walkthrough 06 and 14 plus two slide decks; the four examples
   whose `expected.json` contains a null (`json-events`, `parse-json`,
   `primitive-conversions`, `relational-algebra`) plus whatever §3.6 moves;
   `values.ts` reworked and its 87-assertion test file with it.
   1446 tests, with the heaviest null concentrations in
   `engine/test/executor.test.ts` (167 mentions) and `translator.test.ts` (95).

## 8 Recommendation

**Full partiality, both axes, as asked: net negative. Do not do it.**

Not because the design is wrong. It is defensible, CodeQL proves it scales, and
null.md's dismissal of it does not survive §1. The reason is that its marginal
value *over Axis 1 alone* is small while its marginal cost is the whole of §7's
items 3 and 4. Axis 2 buys simpler comparison encodings in one file and gives up
a property of equality that the language currently teaches, in a language with
nowhere to signal the change.

**Axis 1 alone, forbidding NULL in columns and keeping comparison total and
null-aware inside expressions: net positive, and this is what to do if anything
is done.** It captures for-items 1 through 5 in full, item 6 and 7 as well, and
none of against-items 4 or 6. Stated as a language rule:

> **No column may hold NULL.** Inside an expression NULL remains exactly what it
> is today, an absorbing element under a total comparison, so `<>` still means
> `not (=)` and `not` still agrees with `!`.

That is the whole rule, and §2.3 explains why it must be stated about storage
rather than about rules. Keeping comparison total is what buys off §5.1 and §2.2
entirely, and it costs nothing: two NULL operands can only meet where both sides
are compound expressions, which no corpus program writes.

**But do not start with either.** The complaint that prompted this is complexity
in the type system and the contract encoding, and the largest single contributor
to both is not NULL, it is **the nullness analysis built around it**. Before any
semantic change, price the deletion on its own:

> Delete `nullness.ts` and `nullness-diagnostics.ts`, keep NULL semantics exactly
> as specified, accept `IS NOT DISTINCT FROM` everywhere, and replace the
> encoder's `nonNull` input with a syntactic check (a variable bound only from
> non-`?` columns is non-null).

That is both files, about 700 lines, and their two test files gone against a
replacement of a few dozen, **zero** semantic change, zero
spec sweep, and the only cost is a plan regression on Postgres, which null.md §6
itself calls "the one backend nobody runs by default" and which already carries a
warning. Three warnings that fire nowhere in the corpus go with it. If that
deletion resolves the complaint, the semantic question does not need answering at
all; if it does not, the residue is a much clearer statement of what Axis 1 would
be buying.

Ranked, then: delete the analysis first, consider Axis 1 second, and leave Axis 2
alone.

## 9 If Axis 1 is ever taken: staging

Each step is useful alone and each is reversible until the one after it.

1. **Decide the holey-data discipline** (§3.2). Nothing else can be sequenced
   until `?` has a replacement, and the decision is independent of everything
   below it. Rewrite `examples/expr-eval` and the `titanic` playground entry
   against it, then delete `?` from the grammar.
2. **Make heads strict.** One outer filter in `translateRule` (§4.1), an `UNDEF`
   sentinel in `values.ts` (§4.2), and the undefined-head-expression warning
   (§6). Behaviour changes here, so this is where the four `expected.json` files
   move.
3. **Delete the nullness analysis**, now unconditionally correct rather than
   merely cheaper, together with `publishedNullness` and the two checkers'
   nullness halves. Emit plain `=` everywhere and delete null.md §6's warning.
4. **Add definedness hypotheses to obligation generation** (§3.8) and drop the
   free-variable `$null` companions. Re-run `--verify` over the corpus and
   confirm the three predicted discharges.
5. **Aggregate identities** (§3.6), which is separable and the only step that
   changes an answer nobody asked about.
6. **Spec and docs.** §5.4 shrinks to a section on JSON `null` plus a table of
   partial operations. `null.md` and `nullness-tracking.md` get status lines
   pointing here rather than being deleted, since the reasoning in them is why
   the alternatives are not reopened.
