# Semantic type foundation

Status: structural/proof inference, published semantic contracts, and conservative
proof-match validation implemented. Proven scalar operands now lower to existing
extraction builtins before final primitive checking and backend emission. Disjoint proof requirements and constructor payload
constraints now produce semantic errors. Structural input declarations and
rule-head annotations are implemented.

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
alternative, so nullable types can be represented as unions. Expression absence
is separate from both null and the empty type.

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

Source unions are checked alternative by alternative. For a target union, each
source alternative must fit a single target alternative. This is sound but
incomplete: `[integer | string]` has the same inhabitants as `[integer] | [string]`,
but the checker does not prove the former is a subtype of the latter. Consequently
a false result means the contract was not established, not necessarily that the
types contain a counterexample. Widening uses this API to avoid redundant producer alternatives. Published semantic contracts now propagate through a separate pass; explicit
annotation and module-boundary guarantees still use the existing primitive checks.

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
`boundSemanticType` replaces a subtree exceeding either limit with `value`.
Scalars and nominal proof references are leaves and retain their identities even
at the depth boundary. A wide record or tuple currently widens to `value`, rather
than attempting a more precise summary. Bounding visits children within the budget
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
This bounds producer state; it does not bound the cost of arbitrary exact
intersection or establish runtime finiteness. Inference integration must also
control transient types before expensive structural operations.

## Projections and proofs

The projection API describes JSON access with literal string keys and nonnegative
integer indices. Its result separates the successful value type from possible
absence. Required nullable fields are present; optional fields and array indices
may be absent. Unsupported receivers/keys produce `never` with possible absence.
Language-level string indexing, negative-index semantics, dynamic indices and
source diagnostics remain responsibilities of future expression typing.

Proof identities use elaborated predicate identities, not source names. The proof
registry stores constructor payload signatures and permits forward references,
so recursive signatures do not require recursive object graphs. Ordinary JSON
projection does not expose a proof's representation; payload lookup serves generated constructor matches. A signature never establishes membership
in the predicate's derived proofs.

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
conservative, since a JSON tag alone does not establish proof membership. An unknown or non-nominal receiver falls back to
`value`, so a tagged JSON shape never grants membership. Ordinary user-written
JSON access on proofs remains conservatively typed as `value`. Registry signatures
are inferred implementation facts, not new datatype declarations or contracts.

## Observational inference

After existing type validation and nullness inference, `inferTypes` runs
`inferSemanticColumns` and exposes its result as `TypedProgram.semanticColumnTypes`.
The map describes inferred implementation facts only. It is neither a published
contract nor a replacement for `columnTypes`, and no backend reads it yet.

The pass seeds external columns from their primitive declarations and nullness,
and accumulates rule producers with bounded widening. Object literals retain
required fields, array literals become tuples, and `list` aggregates retain an
array element type. Positive predicate bindings and equality dependencies carry
these shapes into consumers. Literal JSON projections retain successful component
types; a missing projection contributes `never`, not null. Conditional branches
combine alternatives. Mixed string/JSON receivers and dynamic or negative indexing
use a conservative fallback until language-level projection typing is integrated.

This remains an over-approximation: positive predicate requirements on shared
variables and bidirectional equality bindings are intersected, but general guards
and reverse field-path constraints are not inferred. Unsupported expressions use
existing primitive results with conservative nullness.
External `value` data remains opaque. Proof terms use retained lowering metadata for nominal types and payload inference.
The inference pass does not itself validate structural declarations or matches;
proof-match validation runs afterward using consumer-visible contracts.

A secondary 128-round work limit bounds propagation overhead. If it is exhausted,
all intensional columns and constructor payloads fall back to `value`; an unfinished, potentially too-narrow
fixed point is never published. Worklist propagation can improve this fallback for
large dependency graphs later. Integration tests cover literal shape propagation,
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
expressions and opaque alternatives remain conservative. The existing primitive annotation/nullability checks and module
boundary checks remain authoritative for the declaration syntax supported today.
Structural input declarations and validation are now implemented as described below.

## Typed operands and backend extraction

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

## Storage and next steps

The primitive bridge preserves all existing primitive names. Structured values,
proofs and nontrivial unions map to JSON (`value`) storage. `never` has no storage
mapping. This is a conservative whole-value representation, not a recipe for
extracting primitive fields from JSON or an optimization for nullable scalars.

Input column declarations now accept closed records, optional fields, homogeneous
arrays and nested nullability. `structural-declarations.ts` translates them into
semantic contracts and validates incoming JSON, reporting column/row/path errors.
The shared loader helper validates each full batch before inserting any row;
native backend hooks also validate direct inserts. Module boundaries require
published semantic types to satisfy declared shapes.

Rule-head annotations accept the same shapes. Semantic inference retains each
rule's contribution before annotation widening; the final pass checks it against
the declared type using published callee contracts and inferred self contracts.
The published pass propagates the declared generality to callers. Existing
nullness analysis supplies computed-field nullability and guarded variable
refinement. Annotation checks do not invent evidence when inference reaches its
work limit, and structural values retain JSON storage.

Next, consider reusable type aliases. Validate registry references before exposing proof signatures as
user-facing declarations. Inferred types, published contracts, nullness and
partiality must remain distinct during this migration. External data validation
is required before trusting structural input declarations.

JSON Schema interoperability is later work; this foundation neither accepts
schemas nor claims schema conformance.
