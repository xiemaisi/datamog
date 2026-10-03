# Optional Lean verification spike

This project pins Lean **4.34.0** and has no third-party Lean dependencies.
Ordinary Datamog builds and `bun test` do not require Lean. With Elan/Lean and
Bun on PATH, run from the repository root:

```bash
bun run generate:lean
bun run test:lean
```

`generate:lean` reads `doc/invariants/code/08-verify.dl` and
`verification/lean/fixtures/reach.dl`. It regenerates only
`Datamog/Generated.lean`, `Datamog/Checked.lean`, and `manifest.json`. Maintain proofs in
`Datamog/Proofs.lean`; regeneration never overwrites that file.
`bun run generate:lean --check` rejects stale generated output without writing.

The checked arithmetic theorem is the existing successor refinement, exported
from the typed obligation IR with its safe-integer, nullness, and head-definedness
premises. It is a local safety theorem, **not successor coverage**. In particular,
no output is required at the maximum integer. Boolean IR values become Lean
propositions, with Boolean equality represented by logical equivalence.

The recursive theorem uses an inductive `Reach` generated from both Datamog
rules over `SafeInt`. It proves preservation of an arbitrary property, conditional
on the input edges preserving that property. It does not establish the premise
for a loaded graph, nor prove evaluation termination. The relational exporter
currently accepts one positive, possibly self-recursive predicate with
variable-only body atoms and simple integer comparison guards over non-null integers, with variable or
variable-plus-integer-literal heads; other derived calls, mutual recursion,
negation, aggregates, other computed terms, and constraints are rejected.

`Semantics.lean` separates `none` (undefined) from `some Value.null`, models safe
integers, truth, logical negation, null-aware equality, ordering, addition,
truncating division, and remainder. Nullable arithmetic is rejected by Datamog's
current frontend; the raw semantic operations still state its null propagation.
The IR's quotient uses zero as a totalized placeholder for a zero divisor;
Datamog division separately requires a nonzero divisor. This scalar model has no float semantics.
The separate flat-record library below adds lookup over scalar-valued entries;
structural goals remain unsupported by local and relational export.

`test:lean` checks regeneration and the toolchain version, copies project sources
to a fresh temporary project, and rebuilds without existing project `.olean`
files. Generated checker theorems require the exact expected types, then audit
transitive axiom dependencies. The allowlist is `propext`, `Classical.choice`, and
`Quot.sound`; `sorryAx`, user axioms, and native computation axioms are rejected.
See the [Lean axiom reference](https://lean-lang.org/doc/reference/latest/Axioms/).
This policy is tested by deliberately failing proof attempts. A false local goal
is exported only as a negative fixture, and its negation is proved and audited.

The integration suite also compares 164 concrete arithmetic/null cases with the
native and SQLite backends and checks the same results in Lean using kernel
reduction (`decide`, never `native_decide`). These are regression checks, not a
proof of compiler or backend correctness. PostgreSQL is not covered by this suite.

The parser, analysis, exporters, semantic definitions, audit implementation, and
pinned toolchain remain trusted. Local exported goals may assume published
contracts: proving one does not independently discharge those dependencies.
The registered successor fixture has no such dependencies. No proof cache,
arbitrary external proof import, or CLI `--verify`
Lean integration exists yet. Proof elaboration executes repository code; the
axiom policy does not sandbox that process.

## Manifest and invalidation

`manifest.json` is a verification plan, not a successful result or certificate.
It records registered theorem names, their statements, assumptions, and dependency
closures. SHA-256 digests cover canonical JSON (sorted object keys, ordered arrays)
and the complete reachable definition set, including cycles.

The context includes the semantic profile, selected checking method, pinned
Lean toolchain, lockfile, complete core/parser source inventories, generation and
checking scripts, Datamog fixtures, and maintained Lean sources/configuration.
These files are hashed by contents. Changing semantics, imported Lean definitions,
proofs, the axiom audit, or frontend analysis invalidates the plan even when the
exported theorem text happens to remain identical. This deliberately invalidates
all registered results on any context change; finer dependency granularity can
come later. Newly imported project Lean modules belong under `Datamog/` so they
are included in the inventory; third-party Lean libraries remain unsupported.

The generated checker records the manifest digest. `generate:lean --check`
recomputes the artifacts from current sources and compares their full contents;
a copied digest cannot authenticate a changed statement. `test:lean` performs
that check before its fresh source build and reports the manifest identity with
the successful audits. Regeneration preserves proof scripts, which must then
check against the newly generated types. No cached result is accepted, and a
manifest or matching digest alone never discharges a theorem.

## Fresh verification reports

Run `bun run test:lean --report` to write the ignored
`verification/lean/verification-result.json` after the entire suite succeeds.
The runner removes an earlier report before checking, builds from fresh source,
requires exactly one structured axiom audit for each registered theorem, and
rechecks the manifest before atomically publishing the report. A failed run with
`--report` leaves no previous success report. Runs without the flag do not update
or remove reports.

The report binds each theorem to its goal and manifest digests, records the
transitive axiom dependencies, and keeps assurance separate from status. Goals
with explicit assumptions anywhere in their dependency closure are `conditional`;
others are `proved`. In particular, reachability retains its input edge premise,
and `falseGoal_refuted` reports a proof of the negation, not of the false goal.
The scope is the modeled language. Reports describe trusted local build outcomes;
they are not authenticated certificates, do not enable proof reuse, and are never
accepted as input to discharge a goal. Build tools and their log output remain
trusted. Consumers must not infer current validity from an old report.

## Postgres semantic comparisons

`bun run test:lean` also compares the 164 semantic cases with Postgres when
`DATAMOG_EXAMPLES_DATABASE_URL` or `DATABASE_URL` is set (the former takes
precedence). Use a dedicated test database. The runner creates a unique schema
on a single connection and drops that schema on completion or failure; it does
not reset `public`. The existing devcontainer configuration enables this path.

Without a URL, the runner explicitly reports the Postgres comparisons as skipped.
With `DATAMOG_REQUIRE_POSTGRES` set, a missing URL is an error. A configured but
unreachable server always fails the run. Lean CI provisions Postgres and requires
these checks. Fresh JSON reports include `semanticChecks` with the case count,
participating backends and Postgres status; these concrete comparisons do not
establish universal backend correctness or change theorem assurance.

## Requiring unconditional goals

Use manifest goal IDs to require specific unconditional results from a fresh run:

```bash
bun run test:lean --report --require-goal successor --require-goal falseGoal_refuted
```

All registered proofs and regression checks still run. Each requested ID must
name a registered goal and have no remaining assumptions in its dependency
closure; a definition ID, typo, missing audit, or conditional result fails the
run. `--require-goal reachPreserves` therefore fails with the input edge premise
in its diagnostic. Requiring `falseGoal` fails because it is a definition;
`falseGoal_refuted` names the theorem proving its negation. An option without an
ID is a usage error. Reports record the deduplicated requested IDs.

Without `--require-goal`, conditional theorems continue to be valid outcomes of
the proof suite. This gate checks the fixed project's fresh results only; it is
not general CLI verification, arbitrary cyclic contract discharge, or report
import. Lean CI requires the successor and false-goal-refutation proofs.

## Reachability transitivity

The registered `reachTransitive` theorem proves, for every input edge relation
and bounded-integer vertices `a`, `b`, and `c`:

```text
Reach(edge, a, b) → Reach(edge, b, c) → Reach(edge, a, c)
```

Its maintained proof inducts on the second finite derivation and uses only the
constructors generated from `fixtures/reach.dl`. It has no extra input law or
axiom dependencies and is required by Lean CI. Check it explicitly with
`bun run test:lean --require-goal reachTransitive`.

This is a worked relation-level law in the companion Lean project. It adds no
Datamog assertion syntax or new supported translation fragment, and it does not
claim termination or correctness of a backend's execution. The preservation
example still retains its explicit edge premise.

## Two-tuple uniqueness

`fixtures/identity.dl` defines `identity(X, X) :- item(X)`. Its exported inductive
relation supports `identityUnique`: for every input relation and every `x`, two
outputs `y` and `z` must be equal. The proof examines the two derivations, without
assuming uniqueness of the input data.

Reachability does not satisfy the same law. `reachUnique_refuted` proves the
negation of `reachUnique`, using the graph with edges `0 → 1` and `0 → 2`. Only
the refutation is registered as a proved goal; the false uniqueness statement
remains a definition and cannot satisfy `--require-goal reachUnique`.

Both results use exact generated checker types and axiom audits and are required
in Lean CI. The suite also replays the identity fixture at safe-integer boundaries
and the branching graph on native, SQLite, and configured Postgres, checking
exact rows. Reports count these two relation fixtures separately from the 164
expression cases. These remain companion-project claims; no general uniqueness
syntax or new relational translation fragment is introduced.

## Bounded successor coverage

The relational exporter now accepts a head variable plus an integer literal
(single addition only). Its constructor quantifies a `SafeInt` output and
requires its value to equal the sum. Overflow has no output witness. Body terms
remain variable-only; nested arithmetic and other computed operations are rejected.

`fixtures/successor.dl` exports `succ(X, X + 1) :- sample(X)`.
`successorCoverage` proves an output exists for every admitted input `x` with
`x.val < maxSafe`, by constructing that output and proving its bounds.
`successorTotal_refuted` proves coverage without that restriction is false.
The bound is explicit in the theorem's input domain; this does not establish
that a loaded dataset excludes the maximum. CI requires both checked results.

The third concrete relation fixture includes negative values, zero, and both
upper-bound cases: `maxSafe - 1` yields `maxSafe`, while `maxSafe` yields no row.
It runs against native, SQLite, and configured Postgres and is counted separately
from the expression cases in fresh reports. This worked coverage claim remains
in the Lean companion project; it adds no assertion syntax.

## Internal uniqueness-claim API

`exportLeanUniqueness(typedProgram, claim, polarity)` in
`packages/core/src/obligation-lean.ts` accepts a named descriptor:

```typescript
{ id: "identityUnique", predicate: "identity", relationName: "Identity",
  keyColumns: [0], outputColumns: [1] }
```

Column indices are zero-based positions in the elaborated relation. Key columns
are shared between two universally quantified tuples; every other column varies
independently. The conclusion equates the selected output columns. Empty keys
mean global uniqueness. Outputs must be nonempty and disjoint from keys;
duplicates, nonintegral or out-of-range indices, unknown predicates, and
unsupported relational semantics are rejected. Column selections are normalized
into ascending order.

The result contains the relation source, exact claim statement, checker source,
and manifest nodes. The checker expects a maintained proof under `Datamog.Proofs`;
it does not create that proof. Default `"prove"` registers the claim as a goal;
`"refute"` registers its negation under an `_refuted` ID and retains the claim as
a definition. The identity and reachability uniqueness examples now use this
API. Descriptors and exact statements both enter content identities. Use `assembleLeanClaims` to combine exporter results: it emits shared relation
definitions once, followed by the claim statements, and collects their checkers
and manifest nodes. It rejects duplicate claim/refutation IDs, conflicting
relation definitions, duplicate checker theorem names, and missing dependencies.
A shared definition must agree in Lean source, elaborated predicate identity,
input parameter mapping, assumptions, and dependencies. Identical Lean text
alone is insufficient: parameter renaming can hide different Datamog inputs.
The underlying manifest builder continues to reject all duplicate IDs.

This remains an internal API for the supported integer relational fragment,
with the companion project's namespace convention. Datamog assertion syntax
and arbitrary CLI export remain future work.


## Internal coverage-claim API

`exportLeanCoverage(typedProgram, claim, polarity)` uses the same result and
proof/refutation registration convention as uniqueness:

```typescript
{ id: "successorCoverage", predicate: "succ", relationName: "Successor",
  inputPredicate: "sample", outputToInput: [0, null],
  bounds: [{ column: 0, op: "<", value: Number.MAX_SAFE_INTEGER }] }
```

The input must be an external dependency of the exported relation. All its
columns are universally quantified. Each output position maps to a zero-based
input column, or `null` for an independent existential bounded-integer witness.
Repeated mappings are allowed; no witnesses means direct inclusion. Mapping
length must match the output arity. Bounds compare input columns with safe
integer literals using `<`, `<=`, `>`, or `>=`; empty bounds cover all admitted
input tuples. Invalid indices, operators, and non-safe-integer bounds are rejected.

Bounds restrict the theorem's input domain, without assuming head definedness
or a property of the entire dataset. The generated theorem must still establish
an output derivation. Both successor claims now use this API; the unrestricted
claim is registered with `"refute"`. Descriptors, bounds, exact statements, and
dependency definitions enter content identities. Maintained proofs remain
separate, and no new Datamog syntax or automatic proof search is introduced.


The fixed project assembles its uniqueness and coverage exports with this helper.
For example, `assembleLeanClaims([uniqueExport, coverageExport])` returns
`relations`, `statements`, `checker`, and `nodes`. Declaration order follows
the input bundles, with all relations emitted before claim statements. Reordering
bundles leaves manifest content identities unchanged. Empty batches are rejected.
This is an internal assembler for trusted exporter results, not a validator for
external source or proof artifacts.


## Integer body guards

Positive `<`, `<=`, `>`, `>=`, and `=` comparisons may use atom-bound variables
or safe integer literals (including negative literals). Each comparison becomes
a premise of that rule's constructor, in body order. This fragment is total over
non-null bounded integers; nullable operands, arithmetic within guards,
disequality, compound Boolean expressions, and negated filters are rejected.
Equality must use variables bound by positive relation atoms; introducing a new
variable through an equality remains unsupported. Plain body equality and
parenthesized equality filters obey the same restriction.

`fixtures/guarded-successor.dl` filters inputs with `X < 9007199254740990`.
`guardedCoverage` constructs an output below that explicit domain bound.
`guardedTotal_refuted` uses the excluded value `9007199254740990`, whose
successor would fit in the integer domain. Thus filtering alone can defeat
coverage; guards are never silently assumed by the coverage exporter. Lean CI
requires both results. The fourth relation regression compares the fixture,
including both sides of the filter boundary, on native, SQLite, and Postgres.


## Coverage and uniqueness across sibling rules

`saturating-successor.dl` increments below `maxSafe` and returns its input
unchanged at `maxSafe`. The generated `saturatingCoverage` theorem quantifies
over all admitted input integers, with no additional domain bounds. Its proof
selects the applicable constructor and establishes the computed output's bounds.
`saturatingUnique` examines both derivations and rules out contradictory guards.

`overlapping-successor.dl` moves the fallback guard down to `maxSafe - 1`.
That input now produces both itself and `maxSafe`. The registered goal
`overlappingUnique_refuted` proves the negation of uniqueness using those two
derivations. All three new results are required in Lean CI. The fifth and sixth
relation fixtures replay the total function and overlapping counterexample on
native, SQLite, and Postgres, including the safe-integer boundary. SQL fixture
loaders replace input rows within the isolated test schema to prevent earlier
fixtures with the same input name from contributing data.


## Equality filtering

`fixtures/diagonal.dl` retains pairs satisfying `X = Y`. Its generated
`diagonalUnique` claim is proved by examining two derivations and their equality
premises. The `diagonalTotal_refuted` theorem uses an input relation containing
only `(0, 1)`: no output with first column `0` exists, even though the output's
second column is existential. Filtering cannot be silently assumed by coverage.

Both results are required in Lean CI. The seventh relation fixture compares
equal pairs at both safe-integer boundaries and mismatched pairs in both orders
on native, SQLite, and Postgres. These results concern non-null integers;
nullable equality and equality-driven bindings are still outside this exporter.


## Flat-record lookup library

`Datamog/Records.lean` introduces `FlatRecord`, a finite list of string-keyed
entries with scalar `Value` contents (null, bounded integers, and Booleans).
`lookupField` keeps absence (`none`) separate from explicit null
(`some Value.null`). The last occurrence of a duplicate key wins.

The generated goals `recordAbsent`, `recordLastWrite`, and
`recordNullDistinct` register generic library laws with exact checker types and
axiom audits. CI requires all three. Their maintained proofs live in
`Proofs.lean`. The last law depends on the registered last-write result;
all record goals depend on the record library definition. The manifest context
now names `datamog-integer-v1+flat-record-v1`, and record-law statements identify
the `datamog-flat-record-v1` profile explicitly.

The runner checks 124 concrete lookup cases against native, SQLite, Postgres,
and Lean kernel reduction, including missing keys, explicit null, duplicate
keys in both orders, scalar boundaries, dotted keys, and empty keys.
Reports record their count under `semanticChecks.recordCases`, separately from
arithmetic cases and relation fixtures. Nested values, arrays, strings as
values, general structural membership, and wrong-shape lookup are not modeled.
This library does not enable arbitrary structural claims in the exporters.


## Required, optional, and nullable integer fields

`integerFieldMatches fields key optional nullable` checks just one field in the
flat-record model. Optionality permits absence; nullability permits a present
null. Bounded integers match in every flag combination; Booleans never match.
This predicate does not check undeclared keys or whole-record membership.

The exact registered goals `requiredFieldPresent` and
`nonnullableFieldInteger` establish lookup existence for accepted required
fields, and an integer witness for accepted required non-nullable fields.
`optionalFieldTotal_refuted` refutes the universal existence claim for optional
nullable fields with an empty record. All three have maintained proofs, axiom
audits, and unconditional CI requirements.

The integration runner compares 32 cases covering all four flag combinations,
absence, null, Booleans, and integer boundaries. Each backend loads a single-field
structural declaration; invalid inputs must be rejected by structural validation,
and valid inputs must produce the expected projected value (or no row for an
absent optional field). Lean reduction checks the same acceptance results.
Fresh reports count them separately as `semanticChecks.fieldCases`.
This field-level model is also used by the scoped schema exporter below.

### Flat integer-record schema export

The internal `packages/core/src/record-schema-lean.ts` exporter selects an
elaborated input predicate and column. It emits a closed schema with the declared
field names, optionality, and nullability. Only non-null record columns with
integer fields are supported; nested schemas, arrays, other scalar field types,
and nominal types are rejected. Expanded aliases work within this fragment.
Keys are encoded as Unicode scalar data, with unpaired UTF-16 surrogates rejected.

`integerRecordMatches` checks all declared fields and rejects undeclared keys.
For each required field, the exporter generates an exact lookup goal: an integer
witness for a non-nullable field, or a present value for a nullable field. It emits
checker declarations and manifest nodes together. Optional fields generate no
lookup guarantee. Empty schemas are supported and generate no required-field goals.

`fixtures/record-schema.dl` exercises all four flag combinations. Its two
required-field proofs (`DocumentSchema_field0` and `DocumentSchema_field1`) are
maintained, audited, and required by Lean CI. The manifest preserves the predicate
identity, column index, and schema descriptors. The runner compares 265 cases
against input validation and accepted projections on native, SQLite, and Postgres,
then checks acceptance using the generated schema by Lean reduction. Reports
record these separately under `semanticChecks.schemaCases`.

These are theorems about the flat modeled domain, not arbitrary structural
contracts or a proof of the input validator or execution backends.

The generic `schemaFieldMatches`, `schemaClosed`, and `emptySchemaExact` laws
are also registered, audited, and required by CI. They prove that accepted
records satisfy each declared field check, contain only declared keys, and
match an empty schema exactly when they are empty. The fixture lookup proofs
reuse `schemaFieldMatches`. Four of the 265 schema cases exercise the exported
empty schema against empty records and extra integer, Boolean, and null fields.
An empty schema generates no required-field goals; its definition is not an
acceptable `--require-goal` target.

### Nested integer-record schemas

`exportLeanNestedRecordSchema` in `packages/core/src/nested-record-schema-lean.ts`
exports non-null input record columns with nested closed records and integer
leaves. `Datamog/NestedRecords.lean` supplies a separate recursive value domain,
membership checks, and literal-segment path lookup. Every field retains its
optional and nullable flags. Arrays, other leaf types, and nominal membership
remain unsupported; the root record must be non-null.

Generated leaf lookup goals require every parent to be required and non-nullable.
Required integer leaves get an integer witness; required nullable leaves get a
presence guarantee. Optional/nullable parents generate no descendant total-lookup
claim. The generic `nestedRequiredPath` theorem proves this rule by induction;
`NestedSchema_path0` and `NestedSchema_path1` instantiate it for the fixture.
`optionalParentTotal_refuted` and `nullableParentTotal_refuted` establish why
removing those parent requirements is unsound. All five are registered, audited,
and required by Lean CI, with the `datamog-nested-record-v1` profile.

The runner compares 61 cases on native, SQLite, and Postgres, checking input
acceptance and projections for admitted records. Missing/null values, wrong
scalar shapes, extra keys at multiple depths, and integer boundaries are covered.
Lean checks the exported membership predicate and five path lookups per case.
Reports record `semanticChecks.nestedSchemaCases` separately. These results
concern the modeled fragment, not general schema translation or backend proofs.

### Integer-array schemas

`exportLeanArraySchema` in `packages/core/src/array-schema-lean.ts` translates
non-null `[integer]` and `[integer?]` input columns. `Datamog/Arrays.lean` checks
each scalar element and models partial indexing with explicit null distinct from
absence. Empty arrays are admitted; they provide no element-existence guarantee.
Arrays of records/arrays, arrays inside records, and nullable array roots remain
unsupported by this exporter.

`IntegerArray_lookup` and `NullableIntegerArray_lookup` explicitly require a
nonnegative index below the array length. Their conclusions give an integer
witness or a present value, respectively. `arrayElementValid` proves element
membership; `arrayNegativeAbsent` and `arrayPastEndAbsent` prove invalid-index
absence. `arrayTotal_refuted` uses the empty array to refute unconditional lookup
at zero. All six results have exact checker types, axiom audits, manifest entries,
and CI requirements under `datamog-integer-array-v1`.

The runner compares 114 short-array cases against native, SQLite, and Postgres,
with six dynamic indices per admitted array. Lean checks every case's acceptance
and lookup results. Reports count `semanticChecks.arraySchemaCases`. The tests
also exposed and now cover a Postgres int32 subscript cast overflow: wide valid
Datamog indices now yield no value rather than an SQL error.

### Nested integer-array schemas

`exportLeanNestedArraySchema` in `packages/core/src/nested-array-schema-lean.ts`
exports arbitrary array nesting with integer leaves. Root arrays must be non-null;
each element position independently permits or rejects null. For example,
`[[integer?]?]` admits null inner arrays and null leaves. Schemas are lists of
nullability flags in `Datamog/NestedArrays.lean`, under `datamog-nested-array-v1`.
Records and non-integer leaf schemas remain unsupported.

`NestedArray_lookup`, `NullableNestedArray_lookup`, and `DeepArray_lookup` cover
two- and three-level fixtures. Each requires a path of the schema's depth and
`Bounds` evidence: every traversed value must be an array, and each index must
be below that array's own length. The conclusion returns a value satisfying the
integer leaf schema, preserving explicit null when permitted. Empty arrays and
null parents do not create unconditional child-lookup guarantees.

`nestedArrayTypedLookup` proves the generic result by induction on schema depth.
`nestedArrayTotal_refuted` refutes unconditional `[0, 0]` lookup using a null inner
array. All five results have exact checkers, audited axiom dependencies, content
identities, and CI requirements. Bounds are explicit theorem premises, not input
dataset assumptions or presumed head definedness.

The runner checks 376 acceptance cases and dynamic path lookups on native, SQLite,
and Postgres, then checks those results in Lean. Reports count
`semanticChecks.nestedArraySchemaCases`. Cases include ragged arrays, missing
indices, empty and null children, wrong depths, and integer boundaries. This also
regresses a Postgres scalar-at-index-zero discrepancy; numeric JSON subscripts now
require an actual array and preserve null only when it is an array element.

### Composable record and array schemas

`exportLeanStructuralSchema` in `packages/core/src/structural-schema-lean.ts`
exports closed records and arrays with integer leaves in one recursive model.
`Datamog/Structural.lean` defines membership and mixed field/index lookup under
`datamog-structural-integer-v1`. Roots must be non-null records or arrays; field
optionality and child nullability are preserved throughout. Non-integer leaf
schemas and nominal types remain unsupported.

Generated paths quantify over one natural-number index per array step. Their
`ArrayBounds` premise supplies bounds for each reached array. Field steps only
propagate bounds to children that exist, so this premise does not assume required
field presence. `structuralRequiredLookup` proves lookup existence and integer
leaf membership from schema membership, a required typed path, and those bounds.
Optional or nullable containers suppress descendant goals; required nullable
integer leaves allow an explicit null result.

`MixedSchema_path0`, `MixedSchema_path1`, and `MixedArraySchema_path0` exercise
alternating record and array layers, including an array root. The three
`mixed{Empty,Optional,Null}Total_refuted` theorems reject unconditional lookup
through an empty array, an absent optional field, or a null parent. All seven
results, including the generic theorem, are registered, audited, and required in
CI. `MixedOptionalSchema` exports a definition only, so it cannot satisfy a
requested theorem ID.

The runner compares 137 mixed-schema cases on native, SQLite, and Postgres.
Concrete Lean examples run in sequential batches of 500 to bound elaborator
memory; every batch must pass before a fresh result report is written.
Lean checks membership and nonnegative mixed-path lookup results. Runtime checks
also cover negative and wide indices at each dimension. Reports record
`semanticChecks.structuralSchemaCases`. These checks concern the modeled fragment;
the direct-projection fragment below connects the guarantees to selected source
rules, while general refinement obligations remain future work.

### Source-derived structural projection coverage and soundness

`exportLeanStructuralProjection` reads one selected rule with one positive input
atom, one structural input column, and unannotated outputs consisting of
field/index lookup chains. It generates the input schema, an inductive output relation, and
exact coverage and soundness statements from the elaborated AST. Nonnegative
safe-integer indices and literal string keys are supported. Input integer
variables can also index arrays as described below. Filters, joins, sibling
rules, and annotations are rejected explicitly.

Coverage requires an admitted input row and bounds at each array step. It proves
both an output derivation and integer-leaf membership (including null when the
leaf schema allows it); head lookup definedness is not a coverage premise.
Manifest identities include elaborated input/output predicate identities and the
literal path, so changed indices or renamed inputs invalidate the result.

`FirstAge_coverage` and `FirstRating_coverage` prove the fixture's two rules.
`firstAgeTotal_refuted` uses an input row with an empty array to refute coverage
without bounds. All three are audited and required in CI. The runner compares
766 source-fixture inputs across native, SQLite, and Postgres and kernel-checks
membership plus concrete derivations or their absence. Reports record
`semanticChecks.structuralProjectionCases`. This remains an internal projection
exporter, without general CLI integration or a translation-soundness theorem.


Soundness states that every derived output satisfies its selected leaf schema,
provided every input row satisfies the declared schema. It has no array-bounds
or head-definedness premise and does not imply output existence. The generic
`structuralTypedLookup` theorem proves typing for any successful lookup along a
schema-typed path, including optional fields and nullable containers.

The descriptor option `coverage: false` requests soundness alone and permits
optional leaves, optional/nullable parents, and nullable array elements. Default
coverage still rejects these paths explicitly. For example, the
`optional-projection.dl` fixture projects `R["profile"]["age"]` through an optional
nullable profile. `ProfileAge_soundness` guarantees integer outputs, while
`optionalProfileTotal_refuted` and `nullableProfileTotal_refuted` exhibit accepted
inputs with no output. Nullable rating projections preserve a present null leaf.
All six projection soundness goals, the generic theorem, and both refutations
are audited and required in CI. The 51 literal-path replay cases include 31 optional-path
inputs, with absence, null, empty arrays, wrong shapes, and integer boundaries.


### Dynamic indices from input rows

The same exporter supports one structural input column plus any number of
non-null integer columns in the same positive atom. Arguments must be distinct
variables. Column order is preserved, including a structural column outside the
first position. Literal paths and input index variables can be mixed; repeated
uses of one index preserve the shared value.

Generated relations quantify indices as signed bounded `SafeInt` values and
require nonnegativity before converting used indices to natural numbers.
Coverage requires those sign conditions and the existing per-array bounds.
Soundness has no additional index premises. Unused integer columns remain
quantified and can be negative. Nullable indices, string variables used as keys,
arithmetic indices, and repeated variables in the input atom are rejected.

`dynamic-projection.dl` supplies `DynamicAge`, `DynamicRating`, and `ReusedAge`
coverage/soundness proofs plus `DynamicScore_soundness` for an optional nullable
leaf. `dynamicTotal_refuted` demonstrates a negative index withholding an output
even for a populated array. These eight results are audited and required in CI.
The 104 additional replay cases cover independent and reused indices, ragged
arrays, missing/null leaves, negative and wide indices, integer boundaries, and
an unused negative column. The report records `dynamicProjectionCases` as a
subset of the 155 `structuralProjectionCases`.


### Multiple projected outputs

`exportLeanStructuralProjection` supports several projected integer leaves from
one structural input row, including nullable leaves and dynamic indices. Its
ordered `projections` result records each output's path and nullability. The
constructor requires all lookups to succeed for the same row. Any missing value
withholds the entire tuple; explicit null values remain valid at nullable leaves.

Coverage requires bounds for every path and nonnegative used indices. Soundness
conjoins all output type guarantees. If any path is optional, requesting coverage
fails explicitly; `coverage: false` exports tuple soundness alone. Output order,
arity, and repeated paths are included in manifest identities. Non-integer carried values, arithmetic heads, and multiple structural input
columns are still unsupported.

`tuple-projection.dl` supplies paired and repeated-output coverage/soundness
proofs and optional-output soundness. `pairedSameRow` records the shared input
witness. Two refutations demonstrate that first-path bounds alone and a missing
optional output do not establish tuple coverage. All eight new goals are audited
and required in CI; a weaker tuple statement is rejected by the exact checker.

There are 54 new tuple inputs among 209 kernel-checked projection cases, plus
one separate four-row execution dataset that checks correlation and prevents
partial rows from completing one another. These run on native, SQLite, and
Postgres. Reports expose `tupleProjectionCases` and `tupleProjectionDatasets`;
the dataset is counted separately from kernel reduction. `dynamicProjectionCases`
continues to count the single-output dynamic fixture.


### Carried integer input columns

Projected tuples may include bare non-null integer variables from the same input
atom. Each output descriptor distinguishes a lookup from a carried input column.
The generated constructor equates each carried result to its original bounded
integer value; coverage includes that equality in its conclusion. Repeated
carried columns and carried indices preserve their output order.

Carrying a column imposes no nonnegative guard unless it is also used as an array
index. Negative identifiers are valid. All lookup positions must still be defined
for the tuple to exist. The exporter requires at least one lookup and rejects
whole structural values, nullable/non-integer carried columns, and computed heads.

`carried-projection.dl` provides `Identified` and `Indexed` coverage/soundness,
`OptionalIdentified_soundness`, a shared-row witness theorem, and an empty-array
coverage refutation. These seven goals are audited and required in CI. Carried
identifiers are not assumed unique.

The 89 new carried-column cases bring projection replay to 298 kernel-checked
cases across native, SQLite, and Postgres. A separate five-row execution dataset
checks repeated identifiers, identifier/value association, and tuple suppression
on failed lookups. Reports expose `carriedProjectionCases` and
`carriedProjectionDatasets`, separately from the existing tuple dataset.


### Integer filters on projection rules

The projection exporter accepts `<`, `<=`, `>`, `>=`, `=`, and `<>` (also `!=`) between non-null
integer input variables and safe integer literals. The single positive input atom
can occur before or after filters. Equality must compare variables already bound
by that atom; binding equalities and structural lookup operands are rejected.
Arithmetic, nullable operands, negation, and compound filters remain
unsupported.

Constructor premises and coverage claims retain the ordered filter formulas.
Coverage applies to inputs satisfying these formulas plus index signs and actual
array bounds. It proves defined outputs without assuming lookup success.
Soundness follows from derivations without extra filter premises.

`fixtures/filtered-projection.dl` registers `Filtered_coverage`,
`Filtered_soundness`, and `filteredTotal_refuted`. The refutation gives an
in-bounds, defined lookup excluded by a false filter. All three goals have exact
checker types, axiom audits, manifest identities, and CI requirements.

The 96 new cases bring projection replay to 394 kernel-checked inputs compared
on native, SQLite, and Postgres. They cover independent filter failures, negative
and wide indices, empty arrays, and integer boundaries. Fresh reports record
`filteredProjectionCases` separately within `structuralProjectionCases`.


### Excluding integer keys

`fixtures/excluded-projection.dl` uses `U != J` to exclude a blocked key before
returning the key and its array projection. Integer `!=` and `<>` share the same
Lean premise and statement identity. Nullable and structural operands remain
unsupported.

`Excluded_coverage`, `Excluded_soundness`, and `excludedTotal_refuted` have exact
checker types, axiom audits, and CI requirements. The refutation uses equal keys
and an in-bounds lookup to show why coverage must retain the disequality premise.

The 144 additional cases exercise both spellings, equal and unequal boundary
keys, empty arrays, and negative/wide indices on native, SQLite, and Postgres,
with matching Lean kernel checks. Fresh reports record `excludedProjectionCases`
within the 538 total `structuralProjectionCases`.


### Filters on projected integer values

The exporter accepts `as_integer(path)` comparisons with a safe integer
literal on the right, where `path` matches a projected non-null integer leaf.
The explicit conversion follows existing Datamog typing; ordering a raw `value`
lookup is rejected. Literal and dynamic array indices are supported.

`fixtures/positive-projection.dl` filters with
`as_integer(R["rows"][I]["n"]) > 0`. Its soundness theorem proves positivity
as well as output typing. Coverage requires that any integer returned by the
lookup satisfies the comparison; this premise does not assert lookup existence.
Schema membership and array bounds supply the witness independently.

`Positive_coverage`, `Positive_soundness`, and `positiveTotal_refuted` have exact
checker types, axiom audits, manifest identities, and CI requirements. The
refutation uses a defined zero-valued lookup excluded by the filter.

The 28 new cases cover positive, zero, negative, boundary, and absent lookup
results, with native/SQLite/Postgres comparisons and matching Lean kernel checks.
Reports record `positiveProjectionCases` within 566 `structuralProjectionCases`.
Nullable leaves, unprojected paths, variable limits, reversed operands, arithmetic,
and compound filters remain unsupported.


### Conjunctions on one projected value

Several comma-separated comparisons can now constrain the same projected integer
leaf. The generated value property uses one integer witness satisfying every
comparison. Coverage keeps separate universal comparison premises and proves
lookup existence from schema membership and bounds. Contradictory comparisons
remain explicit; the exporter does not discard them.

`fixtures/ranged-projection.dl` combines `> 0` and `<= 10`.
`Ranged_coverage`, `Ranged_soundness`, and `rangedUpper_refuted` have exact checker
types, axiom audits, manifest identities, and CI requirements. The refutation
uses 11 to show that the lower bound alone cannot guarantee output.

The 56 added cases include -1, 0, 1, 10, 11, both safe-integer extremes, empty
arrays, and invalid indices. Native/SQLite/Postgres results agree with Lean
kernel checks. Reports record `rangedProjectionCases` within 622 total
`structuralProjectionCases`. The extension below adds different lookup outputs;
variable limits, nullable leaves, and general Boolean expressions remain unsupported.


### Comparisons on distinct projected fields

Lookup comparisons can target different projected non-null integer leaves.
Conditions are grouped by output, with a separate integer witness for each
field and every comparison retained. Coverage keeps lookup-comparison premises
in source order and proves all results arise from the same admitted input row.

`fixtures/both-positive-projection.dl` requires positive values from independently
indexed `left` and `right` arrays. `BothPositive_coverage`,
`BothPositive_soundness`, and `bothPositiveSecond_refuted` have exact checker
types, manifest identities, axiom audits, and CI requirements. The refutation
uses values 1 and 0 to show that the first field's condition and both array bounds
cannot replace the second field's positivity premise.

The 72 new cases cover independent filter outcomes, integer boundaries, empty
arrays, invalid shapes, and independent indices. Native/SQLite/Postgres results
agree with Lean kernel checks. Reports record `bothPositiveProjectionCases`
within 694 total `structuralProjectionCases`. The extension below adds direct
field comparisons; variable limits, nullable leaves, and general Boolean
expressions remain unsupported.


### Field-to-field comparisons

The exporter accepts direct comparisons between two projected non-null integer
lookups wrapped in `as_integer`. The value property binds both output witnesses
and relates them with the source operator. Literal and pair comparisons can
coexist; their coverage premises retain source order and do not assume either
lookup exists. Schema membership and bounds establish both witnesses.

`fixtures/ordered-projection.dl` requires the left value to be at most the right.
`Ordered_coverage`, `Ordered_soundness`, and `orderedTotal_refuted` have exact
checker types, axiom audits, manifest identities, and CI requirements. The
refutation uses values 1 and 0 to show that array bounds alone cannot imply output.

The 72 new cases cover ordered/equal/reversed boundary values, empty arrays,
invalid shapes, and independent indices on native, SQLite, and Postgres, with
matching Lean kernel checks. Reports record `orderedProjectionCases` within
766 total `structuralProjectionCases`. Unprojected paths, nullable leaves,
scalar-variable limits, arithmetic, and general Boolean expressions remain unsupported.


## User-selected programs

The optional `bun run lean:project` workflow now exports selected structural
projections, integer uniqueness/coverage claims, local head refinements, and
recursive invariants from a standalone Datamog source. It checks maintained
proofs or refutations in a fresh temporary Lean project. See [the workflow guide](PROJECTS.md) for the
JSON selection format, worked example, regeneration steps, and trust boundary.
This does not add a general Lean mode to `--verify`, proof caching, or proof import.

Selected-project reports now embed the exact source and selection snapshots plus
the checked verification plan, so statements, assumptions, dependencies, and
proof/refutation identities can be inspected alongside the fresh result. This
applies to `lean:project check`; the fixed-project report format above is unchanged.
The embedded evidence is descriptive, not a certificate-import or replay format.

Before authoring proofs, `bun run lean:project inspect PLAN.json OUTPUT` previews
the exact goals, assumptions, dependency closures, and generated checker types as
JSON. It needs no Lean installation and does not modify the project or its report.
Inspection is a proposed verification plan, not a successful check.

`program-invariant` selections now close over positive derived dependencies,
including unrefined helpers and multiple recursive components. Every reachable
source rule contributes to the generated inductive family; selected contracts
are proved without assuming upstream contracts. The [pipeline example](examples/selected-program-invariant/plan.json)
and workflow guide show the selection and maintained proof.

`program-uniqueness` uses that dependency closure for two-tuple key/output laws,
without requiring head refinements. The [uniqueness pipeline](examples/selected-program-uniqueness/plan.json)
proves a key determines its output through mutual recursion; an unsafe upstream
sibling makes the maintained proof fail.

`program-coverage` proves output existence from a reachable input dependency,
with explicit input bounds and copied columns or independent existential witnesses.
The [coverage pipeline](examples/selected-program-coverage/plan.json) constructs a
bounded successor through mutual recursion and refutes unrestricted coverage.
Upstream filters and computed-head definedness must be proved through the rules.

`program-equivalence` compares two derived predicates of equal arity over the
union of their positive dependency graphs. Its exact theorem requires both
inclusion directions. The [equivalence example](examples/selected-program-equivalence/plan.json)
proves two recursive paths equivalent and refutes equivalence to a filtered path.

`program-emptiness` proves that a selected derived relation has no rows for any
admitted inputs. The [emptiness example](examples/selected-program-emptiness/plan.json)
proves a named violation relation and a base-free cycle empty, and refutes
emptiness of a reachable relation. Direct constraint import remains unsupported.
