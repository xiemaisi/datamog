# Semantic type foundation

Status: implemented. The foundation includes structural/proof inference,
published semantic contracts, structural input and head declarations, transparent
file-local aliases, and typed scalar operands. Proof registries validate their
references. Inference uses dependency-driven propagation and bounded widening;
structural errors report mismatch paths and editors navigate alias references.

The scope is richer structural JSON types and static types for existing proof
terms. Independent datatype declarations and freely constructible ADTs are
explicitly out of scope, including changes to proof construction or finiteness
checking.

## Representation

`packages/core/src/semantic-type.ts` introduces a semantic type representation
separate from the primitive column types consumed by backends. It includes
scalars, records, arrays, tuples, unions, and nominal proof references.

Unknown inference state remains outside the type domain (`undefined`). `never`
is the empty type; `value` is the universal type including null. Null is a scalar
alternative, so nullable types can be represented as unions. This internal
universal `value` is a conservative approximation, not the surface declaration
`value`: declarations exclude a bare null unless marked `?`, enforced by the
separate nullness checks. Expression absence is separate from both null and the
empty type.

Record fields carry independent optionality and value types. The additional-field
type describes undeclared fields; `never` closes a record. Optional `never` fields
are retained: in an open record they prohibit that particular field. Required
`never` fields and tuples with impossible components normalize to `never`, while
an array of `never` remains inhabited by the empty array.

Normalization sorts record fields, rejects duplicate fields, flattens and sorts
unions, removes duplicate alternatives, and absorbs integer into float. Equality
compares these normalized structures. It is deliberately not semantic equivalence
or a subtype decision: for example, structurally subsumed record alternatives
are not eliminated. Exact union construction does not provide a convergence
policy for recursive inference.

## Structural relations

`isSemanticSubtype(source, target)` checks contracts directionally. Integer is a
subtype of float; arrays are covariant; tuples require matching lengths or can
satisfy an array contract componentwise. Records check required-field presence,
each declared field on either side, and the additional-field policy. An optional
field does not satisfy a required field even when its value type fits. A proof
reference only satisfies the same nominal proof identity or a containing union
or `value`; JSON storage does not make it a structural record subtype.

Source unions are checked alternative by alternative. For a target union, the
checker first looks for a single alternative accepting the source. If none does,
it can split finite product choices in the source: unions inside tuple components
or declared record fields, and optional fields into absent and present branches.
Each resulting branch must satisfy the target union. Thus a one-element tuple of
`integer | string` satisfies the union of a one-element integer tuple and a
one-element string tuple. These are internal tuple shapes, not array declarations.

Splitting is exact and preserves correlations between components. An absent field
is represented by optional `never`, including in open records, so absence is not
confused with null or an undeclared field allowed by the additional-field policy.
Array elements and additional record fields are not distributed into whole-value
alternatives: an array of `integer | string` may mix both types, so it does not
satisfy `[integer] | [string]`.

The checker generates at most 256 split alternatives per subtype call and searches
at most 32 structural levels for a split. These provisional limits bound product
expansion; a separate per-operation budget covers normalization, keys and relation
work. Split-budget exhaustion declines to establish the contract, while structural
work exhaustion raises `SemanticTypeLimitError`. Partial coverage never counts as
success. The algorithm remains sound but incomplete, so a false result means a
guarantee was not established, not necessarily that a counterexample exists.
Subtype comparison descends through product components directly, avoiding a
whole-product equality-key comparison before checking the same components again.
Scalar names and exact nominal proof identities have direct comparisons; input
normalization and the shared work/split limits still apply. Equal unions retain
a whole-union equality shortcut to avoid a quadratic alternative search. The six-choice tuple
benchmark now establishes its 64-alternative coverage within the default budget.
Widening uses the same API to retain existing alternatives that collectively cover
a contribution. Published semantic contracts propagate through a separate pass;
structural annotations and module boundaries use semantic subtype checks alongside
the existing primitive and nullness checks.

`intersectTypes` computes the represented intersection, distributing over unions.
Record fields are required if either operand requires them; their types and the
additional-field policies are intersected. Conflicting optional fields become
optional `never` fields, prohibiting their presence. Conflicting required fields
make the entire record empty. Arrays with disjoint element types still share the
empty array. Intersection does not unfold nominal proof signatures.

Tests cover algebraic identities, lower bounds, presence constraints, nominal
identity, and an independent finite JSON membership oracle. Intersection can
expand unions; neither this operation nor exact union construction should enter
a recursive inference loop without a convergence and complexity policy.

## Bounded producer accumulation

`semantic-widening.ts` adds an explicit precision budget, initially four levels
of structure and eight fields, tuple components, or union alternatives per node.
These defaults are provisional compiler policy, not restrictions on runtime data.
`boundSemanticType` replaces excess nesting or too many union alternatives with
`value`. Scalars and nominal proof references are leaves and retain their identities
even at the depth boundary. A wide record retains the first eight fields in name
order and allows arbitrary
additional fields. A wide tuple becomes an array whose element type covers every
component. These summaries preserve useful precision without retaining unbounded
field counts or tuple lengths. Bounding visits children within the budget
before normalization, so deeply nested inputs do not require an unbounded walk.

`widenSemanticType(previous, contribution)` accumulates producer types. Start at
`never`, defer unknown contributions, and use the same budget throughout a solve.
Already-covered contributions preserve the prior state. Otherwise the operation
uses a covering contribution or bounds the union of both types. Every result
covers both inputs; bounding is idempotent. This is a widening operation rather
than an exact join, so producer scheduling may affect precision.

For a fixed program's finite field/proof names, fixed depth and width give a finite
representation domain. Accumulation only widens. Tests exercise recursive array
and record producers, growing alternatives, oversized records and tuples, subtype
coverage, idempotence, and input nesting beyond the JavaScript call stack limit.
This bounds producer state and does not establish runtime finiteness. Local
variable refinement bounds both input trees before intersection and caps recursive
pair comparisons at 4,096. Exhaustion keeps the previous approximation, never a
partial intersection; a successful result is bounded and must still be provably
narrower. The exact intersection API remains available for structural relations
and contract validation, with the exact-operation limits described below.

## Exact-operation work limits

Exact normalization, equality, subtyping, intersection and projection share one
work context per public operation. The default budget is 1,000,000 work units,
charging type visits, collection sizes, key text and string comparisons. Structural
nesting is capped at 256 levels before recursive traversal can exhaust the host
stack. These are compiler resource policies, independent of the producer widening
budget and the parser's declaration-expansion limits; they do not limit runtime
JSON data. Selected APIs accept `maxWork` for callers needing a smaller budget.

Structural keys embed child encodings directly instead of repeatedly JSON-quoting
an already encoded child. Their size is linear in the represented tree, including
escaped names. Keys are cached only within the current operation; each comparison
still charges the key text it reads. Relation checks normalize inputs once and
reuse those normalized subtrees. Record field lookup uses an index per relation
check rather than scanning the whole field list for every name.

Exhaustion raises `SemanticTypeLimitError`, never an invented empty type or a
silently widened declaration. `intersectTypesWithinBudget` additionally enforces
its caller's pair-comparison limit and returns unknown on either resource limit,
allowing local inference to retain its previous approximation. Other errors, such
as duplicate fields, still propagate. Registry definition shares a work context
across all payloads and commits atomically only after normalization succeeds;
reference validation and proof projection are budgeted too.

## Projections and proofs

The projection API describes JSON access with literal string keys and nonnegative
integer indices. Its result separates the successful value type from possible
absence. Required nullable fields are present; optional fields and array indices
may be absent. Unsupported receivers/keys produce `never` with possible absence.
The shared language projection helper additionally handles proven string receivers
and dynamic integer indices into arrays and tuples. Mixed string/JSON receivers
remain conservative; source diagnostics and runtime bounds checks stay separate.

Proof identities use elaborated predicate identities, not source names. The proof
registry stores constructor payload signatures and permits forward references,
so recursive signatures do not require recursive object graphs. After all
definitions are registered, `validateReferences` checks every proof reference
inside constructor payloads, including nested structural components and record
additional-field types. References must resolve to the exact elaborated identity;
the check does not unfold signatures, so self and mutual recursion are valid.
Both inferred and published registries run this check before being returned,
including on the work-limit fallback path. Unresolved references report the
owning constructor and payload position as a compiler metadata error. Ordinary
JSON projection does not expose a proof's representation to structural inference;
payload lookup serves generated constructor matches. A signature never establishes
membership in the predicate's derived proofs.

Parser lowering attaches construction and payload-projection metadata in weak maps
keyed by the generated AST nodes. The runtime AST and JSON encoding are unchanged.
Elaboration precedes lowering, so identities use the elaborated predicate names.
Metadata is not inferred from JSON tags: an ordinary object cannot establish proof
membership. Consumers must preserve lowered node identity; any future cloning of
lowered ASTs must explicitly transfer this metadata.

The semantic pass accumulates constructor signatures alongside column types and
publishes them as `TypedProgram.proofTypes`. Construction produces a nominal proof
reference; a generated match projection recovers its constructor's payload type
when its receiver has the corresponding nominal identity. Nested matches follow
recursive payload references, including unions of nominal identities. A successful
match selects the matching nominal alternative; unrelated nominal alternatives
cannot pass its tag guard. An opaque or structural alternative keeps the result
conservative, since a JSON tag alone does not establish proof membership. An
opaque or structural receiver falls back to `value`; known incompatible scalars,
arrays and tuples have no successful proof payload. A tagged JSON shape never
grants membership. Ordinary user-written
JSON access on proofs remains conservatively typed as `value`. Private registry signatures remain inferred implementation facts. Optional inline
payload annotations publish checked contracts in the separate published registry;
they do not declare new datatypes.

## Implementation inference

`inferTypes` runs `inferSemanticColumns` during preliminary operand preparation
and again during final checking, after primitive and nullness inference. It exposes
implementation facts as `TypedProgram.semanticColumnTypes`, separate from published
contracts. Operand lowering and structural checking use this map; backends continue
to consume the primitive `columnTypes` and the lowered expressions.

The pass seeds external columns from their primitive or structural declarations,
including declared nullability, and accumulates rule producers with bounded widening. Object literals retain
required fields, array literals become tuples, and `list` aggregates retain an
array element type. Positive predicate bindings and equality dependencies carry
these shapes into consumers. Literal JSON projections retain successful component
types; a missing projection contributes `never`, not null. Conditional branches
combine alternatives. Dynamic integer indexing carries array elements or the union
of tuple elements through predicate boundaries. Mixed string/JSON receivers
retain a conservative fallback.

This remains an over-approximation: positive predicate requirements on shared
variables and bidirectional equality bindings are intersected, but general guards
and reverse field-path constraints are not inferred. Unsupported expressions use
existing primitive results with conservative nullness.
External `value` data remains opaque. Proof terms use retained lowering metadata
for nominal types and payload inference. The inference pass computes each rule's
contribution; final structural annotation and proof-match validation runs afterward
using consumer-visible contracts. Input loaders validate external structural data
before insertion, and module boundary checks run after final inference.

A worklist initially schedules every rule and then requeues only readers of a
changed predicate or constructor payload. Reads of nominal signatures register
dependencies too: a payload can change while its column keeps the same proof
identity. A secondary limit of 128 rule evaluations per program rule bounds total
propagation work without imposing a 128-hop limit on dependency chains. If the
limit is exhausted, pending predicates and their transitive readers fall back to
`value`, including their constructor payloads and every sibling rule's contribution.
The dependency closure includes proof-signature reads as well as relation reads.
Unvisited rules are still pending, so their results cannot be mistaken for completed
inference. Completed producers upstream and unrelated components retain their
precision; no unfinished, potentially too-narrow fixed point is published. Integration tests cover literal shape propagation,
equality source order, nullable inputs, producer alternatives, missing/null values,
aggregates, recursion and preservation of legacy checking/storage behavior.

## Published contracts and semantic validation

`TypedProgram.publishedSemanticColumnTypes` and `publishedProofTypes` are computed
in a second fixed point. Head annotations widen the advertised type; consumers
use these widened results transitively, including when inferring constructor
payloads. Direct recursive references retain their own predicate's inferred type,
as with existing primitive contracts. For example, publishing a record producer
as `value` makes an unannotated forwarding predicate publish `value` too, while
both predicates retain their private inferred record shape. Widening an integer
producer to `value` likewise hides its constructor payload's integer precision.

Semantic validation uses published contracts for other predicates and inferred
facts for a predicate's own references. It checks rule bodies, queries and
integrity constraints. Shared variables with disjoint nominal proof requirements
are rejected; generated constructor tag guards check receiver compatibility,
including nullary nested patterns; generated payload equalities reject disjoint
known payload/argument types. Errors carry source spans. Existing `value` contracts
and unknown receivers are accepted conservatively. These are overlap checks, not
claims that a relation contains every value of its advertised type.

Inference and operand lowering use a shared variable-refinement helper, so
predicate and equality requirements narrow both column shapes and usable operands.
Local refinement stays descending: if bounding an intersection cannot be proved
narrower than the previous type, it keeps the previous approximation. Ordinary
JSON filtering is not reinterpreted as a type error. Payload projection over proof
unions is shared by inference, validation and operand lowering; arbitrary payload
expressions and opaque alternatives remain conservative. Primitive and nullness
checks continue to validate the corresponding parts of declarations; semantic
subtyping validates their structural parts.
Structural head and module-boundary errors report a mismatch path and the expected
and inferred types. Missing required fields report that presence is not guaranteed.
The formatter bounds display depth and width with ellipses without weakening the
checked contract; failures of collective union coverage are described as unproven
guarantees rather than demonstrated counterexamples.

## Typed operands and backend extraction

`semantic-expressions.ts` shares structural expression typing between inference
and `typed-operands.ts`: literals, construction metadata, conditionals, list
aggregates, and literal/dynamic projections use the same rules. Callers supply
their variable environment, proof registry, and legacy nullness/unknown fallback.
The projection helper retains presence independently; consumers use its successful
value type without turning a missing element into a null value.

`typed-operands.ts` makes inferred scalar fields usable in arithmetic, logical
operators, scalar builtin calls, and supported aggregate operands. For example,
`P["age"] + 1` works when the consumer-visible shape proves that field is an
integer. Proof-pattern payload variables use the same mechanism. Whole structured
values and standalone projections retain JSON storage.

The pass inserts existing `as_integer`, `as_float`, `as_string` or `as_boolean`
operations at primitive operand positions. Those operations already implement
matching extraction on native, seminaive, SQLite, sql.js and Postgres backends.
Nested string indexing/slicing extracts a proven string receiver; dynamic integer
indexing can use homogeneous array or tuple element types. Unknown or mixed
scalar types do not justify conversion, nor does an opaque published `value`.

Nullability is not converted away. A scalar-or-null field needs a bound-variable
`<> null` guard before implicit extraction. Missing fields/indices remain absent,
and standalone JSON null projections remain null values. Comparisons and explicit
value-parameter calls retain existing value semantics. This is operand lowering,
not a blanket change to the storage type of every projected expression.

Preparation runs primitive inference without final validation to discover semantic
shapes, inserts justified conversions, and repeats for dependent expressions.
Unresolved primitive columns remain opaque during preparation; an unanchored
recursive equation must not manufacture evidence for its own conversion. Final
inference performs normal overload resolution, nullness/partiality checking,
annotation checking, semantic validation and backend handoff on the lowered tree.
Inserted calls preserve source spans and AST parent links. Re-analysis removes
previous implicit conversions and proves them again, so edits or REPL additions
cannot retain stale assumptions after contracts widen.

Cross-backend tests cover records, tuples, proof payloads, arithmetic and builtins,
integer division/remainder, missing and nullable fields, guarded extraction,
dynamic indexing, nested string access, aggregates, and dependent wrappers.
Regression tests also check repeated analysis and widened contracts.

## Constructor payload annotations

Explicit `:: Ctor(expr: type, ...)` arguments accept existing primitive, structural
and alias types. Parsing lifts wrappers into per-argument metadata, retaining the
original expression and diagnostic span; proof lowering carries that metadata on
the generated construction node. Unannotated positions, bare constructors and
nullary constructors retain their existing behavior. Alias navigation and editor
validation cover the new annotation location.

Semantic inference retains each annotated constructor's pre-publication payload
contribution and nullability for final checking. The private registry remains
inferred; the published pass widens annotated positions by their contracts and
propagates those types through forwarding rules and unannotated payloads. Own-rule
lookups in that pass use the inferred proof registry, matching inferred-self column
contracts. Work exhaustion clears affected constructor contributions too, so an
unfinished result cannot establish a narrow annotation. Reanalysis proves all
consumer operand conversions again. Runtime proof construction and storage remain
unchanged; consumers extract operands according to the published payload types.

See [Constructor payload contracts](proof-signature-contracts.md) and spec §8.2.
Bare predicate names as nominal types are the next proposed extension; see the
constructor payload contract design.

## Storage and structural declarations

The primitive bridge preserves all existing primitive names. Structured values,
proofs and nontrivial unions map to JSON (`value`) storage. `never` has no storage
mapping. This is a conservative whole-value representation, not a recipe for
extracting primitive fields from JSON or an optimization for nullable scalars.

Input column declarations now accept closed records, optional fields, homogeneous
arrays and nested nullability. `structural-declarations.ts` translates them into
semantic contracts and validates incoming JSON, reporting column/row/path errors.
The shared loader helper validates each full batch before inserting any row;
native backend hooks also validate direct inserts. Both insertion paths prepare
structural validators once per batch, reusing nested shape dispatch and record
field indexes across cells. Prepared validators snapshot the declaration and are
not cached between batches, so edits cannot retain stale contracts. Nullable
failure diagnostics reuse the failed branch's error instead of traversing its
input subtree again; deeply nested nullable records retain the precise error path
without exponential revalidation. These compiler preparation costs are separate
from the number of runtime JSON values checked.
Module boundaries require
published semantic types to satisfy declared shapes.

Rule-head annotations accept the same shapes. Semantic inference retains each
rule's contribution before annotation widening; the final pass checks it against
the declared type using published callee contracts and inferred self contracts.
The published pass propagates the declared generality to callers. Existing
nullness analysis supplies computed-field nullability and guarded variable
refinement. Annotation checks do not invent evidence when inference reaches its
work limit, and structural values retain JSON storage.

## Reusable type aliases

`type Person = {name: string, age?: integer}.` introduces a transparent alias for
any existing declaration type, including primitives and nested nullable types.
Aliases can refer to other aliases and can be used in input columns and rule-head
annotations. They preserve the exact contract and storage of their expansion;
they do not introduce nominal identities or freely constructible proof terms.

`packages/parser/src/type-aliases.ts` expands aliases before head annotations are
lifted and before module elaboration. Each file has its own alias namespace and
may use forward references. Unknown names, duplicates (including quoted variants),
primitive-name redefinitions and cycles are rejected at source spans. Unused
aliases are validated too. Cycles are rejected even through optional fields or
arrays: accepting them would require recursive structural contracts, which this
foundation does not provide. Expansion is memoized, with independent AST nodes
at each use and repaired parent links. Compiler work is capped at 100,000 expanded
type-value nodes and 128 levels of alias or structural nesting; exhaustion fails
explicitly rather than widening a declaration to `value`.

The grammar uses lookahead to distinguish alias references from compound
refinements. On an erased witness a bare unknown alias-like name remains a
Boolean refinement, preserving `_: B`. If `B` is also an alias, `_: (B)` explicitly
selects the expression. Alias names otherwise occupy a separate namespace from
predicates and variables, and `type` is a contextual keyword.

Parsed alias declarations retain expanded definitions so successful incremental
session chunks can supply them to later chunks. Failed chunks publish no aliases,
redefinition is rejected, and reset discards them with the rest of the program.
Modules expand aliases in their own files, so no alias import/export mechanism or
freshening is necessary. Module contracts compare expanded shapes as before.
Editor completion offers alias names, and editor validation runs the same
expansion before type inference. The parser retains original alias-reference spans
before expansion in a program-keyed weak map. Core uses them for file-local
go-to-definition, including nested, forward and quoted references. Both VS Code
and the playground expose these links; lenient parsing preserves navigation when
unknown aliases, cycles or unrelated errors prevent successful analysis. Expanded
copies never supply navigation spans, and Boolean refinements are not alias links.

## Remaining scope

The foundation keeps inferred facts, published contracts, nullness and partiality
separate. Work-budget fallback preserves completed types outside the dependency
closure of unfinished predicates. Its treatment of affected predicates remains
conservative: all columns, payloads and sibling contributions are widened together.
Structural subtyping proves bounded collective coverage of finite product choices;
it remains incomplete beyond those limits and does not implement general type
subtraction or complement. Exact structural operations now share per-operation
resource limits; those budgets and the inference summary choices remain provisional
compiler policy. They bound individual operations, not total compilation time.

[Constructor payload contracts](proof-signature-contracts.md) now implement inline
annotations on explicit `:: Ctor(...)` arguments using existing types and aliases.
The companion nominal type syntax and its additional boundary/loading rules remain
proposed, not implemented. Registry closure alone grants neither a new contract nor
proof membership. General union syntax, tuple contracts, open-record declarations
and parameterized aliases are possible future extensions; the internal type domain
does not by itself expose those features as declaration syntax.

Recursive structural aliases, independent datatype declarations and freely
constructible ADTs remain out of scope. JSON Schema interoperability is later
work; this foundation neither accepts schemas nor claims schema conformance.


## Continuation checkpoint

At `471a7c14`, the foundation and the hardening work described above are
implemented. Validation at that revision: `bun run test` passed 2,306 tests
with 72 skips and no failures; `bun run typecheck` and `bun run check` passed.
The most recent step prepares structural input validators once per batch and
removes repeated traversal when reporting nested nullable failures.

Suggested follow-up work, rather than outstanding requirements for this foundation:

1. Measure representative large programs and structural input batches before
   changing the provisional work budgets. Separate inference, exact relation
   checks, validator preparation and row validation so the measurements explain
   which limit or repeated work matters.
2. If proof signatures are to become declarations, write the syntax and module
   boundary design first. Specify nominal identity across module instances,
   constructor payload contracts and how published contracts hide inferred facts;
   retain the distinction between a JSON shape and established proof membership.
3. Choose any additional structural declaration syntax explicitly. Internal unions,
   tuples and open records are not a commitment to expose all three at once.

Continue to commit each completed step separately. The implementation does not
require a new syntax feature merely to finish the existing foundation.


The first measurement follow-up is recorded in
[Semantic type benchmark baseline](semantic-types-benchmarks.md). Run
`bun run bench:semantic-types` to reproduce the separated workloads; the report
records a union-coverage work-limit case and the measured improvements that now
establish that coverage using componentwise comparisons. Compiler budgets are
unchanged; larger cases can still exceed them.
