# User-selected Lean projects

`bun run lean:project` exports and checks selected claims from a Datamog source file. It supports structural projections, local head refinements,
positive recursive program laws, explicit constraints, and named error predicates.
Export and inspection need only Bun; checking uses pinned Lean **4.34.0** through
`lake`. Ordinary execution and `--verify` do not require Lean.

Start with the [end-to-end walkthrough](examples/selected-laws-and-checks/README.md).
It checks an invariant, coverage, an explicit constraint, and a named error goal
in one project, and explains what the resulting report does and does not establish.

## Support at a glance

| Selection | Implemented scope | Main boundary |
|---|---|---|
| `program-invariant` | Head contracts across positive derived dependencies and mutual recursion | Non-null integers; comparison contracts with `&&`, `||`, `!` |
| `program-uniqueness` | Two tuples sharing selected keys must agree on selected outputs | All non-key columns vary independently |
| `program-coverage` | An input row yields an output, with copied columns or existential witnesses | Explicit input bounds; filters and computed-head definedness must be proved |
| `program-equivalence` | Both inclusion directions for two derived predicates | Same output arity and column order |
| `program-emptiness` | No tuple can be derived, including nullary relations | Proves universal emptiness, not absence in one dataset |
| `constraint`, `error-predicate` | Explicit `!-` statements and complete named error relations | Checks are goals, never assumptions; all error siblings participate |
| `projections` | Record/array integer-leaf projection soundness and coverage | One rule/input atom; supported paths, indices, carried integers, and filters |
| `local` | Integer/Boolean head-refinement obligations | Selected acyclic contract dependencies must also be proved |
| `invariant`, `mutual-invariant`, `uniqueness`, `coverage` | Earlier single-relation or single-component APIs | Narrower dependency and explicit-check support; prefer composed laws for pipelines |

All composed laws share a positive, non-null integer relation fragment: variable-only
relation arguments, simple comparison guards, and heads containing variables or
variables plus/minus safe integer literals. Mixed arities and nullary derived
relations are supported. Structural projections are a separate fragment; their
support does not extend to general recursive structural relations.

Every goal can have a maintained proof; claims supporting `polarity` can instead
register a refutation. Unsupported selections fail explicitly. Reports cover
only registered goals. Runtime checks remain enabled, and adding checks does not
restrict a theorem's quantified inputs.

Local `.dl` module imports are supported for composed `program-*` claims and
entry-file and instance check goals (see
[modules](#local-module-programs)). Data-file bindings, general negation, aggregates, parity recursion,
floats, arbitrary expression translation, and general structural relation laws
remain outside this workflow. Proof caching/import, automatic proof search, and
backend correctness are also outside its current scope.

## Structural projection selection

A selection file names the source relative to itself and one or more projections:

```json
{
  "source": "program.dl",
  "projections": [
    { "id": "Picked", "predicate": "picked" },
    { "id": "Maybe", "predicate": "maybe", "coverage": false }
  ]
}
```

Each projection selects an existing predicate and a Lean declaration prefix.
Coverage defaults to true; `coverage: false` requests soundness only for a path
that may be absent. Unsupported programs or paths fail export. Unknown selection
fields, duplicate identities, empty selections, and invalid descriptors fail
rather than silently dropping goals. Structural projection selections require a source without module or data
bindings (`:=`); ordinary input declarations quantify over admitted data.

The supported fragment is the existing structural projection exporter: one rule
and one positive input atom per selected predicate, one structural input column,
additional non-null integer columns, projected integer leaves and carried integer
outputs, literal keys, literal or input-variable array indices, and the documented
integer comparison filters. Records, arrays, optional fields, and nullable leaves
follow the existing schema model. Lookup comparisons require explicit
`as_integer` and non-null leaves. See [the design](../../doc/design/verification-obligations.md).
Other source predicates do not acquire verification claims merely by being present.

## Integer relation claims

A plan can use `claims` instead of `projections`, or include both arrays. At least
one selected claim or projection is required. For example:

```json
{
  "source": "program.dl",
  "claims": [
    {
      "kind": "uniqueness",
      "id": "identityUnique",
      "predicate": "identity",
      "relationName": "Identity",
      "keyColumns": [0],
      "outputColumns": [1]
    },
    {
      "kind": "coverage",
      "id": "successorCoverage",
      "predicate": "succ",
      "relationName": "Successor",
      "inputPredicate": "sample",
      "outputToInput": [0, null],
      "bounds": [{ "column": 0, "op": "<", "value": 9007199254740991 }]
    }
  ]
}
```

Uniqueness columns are zero-based. Two tuples agree on the selected keys;
selected output columns must then agree. Empty keys mean global uniqueness.
Output columns must be nonempty and disjoint from keys. Coverage maps each
output column to an input column or an independent existential witness (`null`).
Its explicit bounds restrict the theorem's input domain; they do not assert a law
about an entire dataset or assume computed outputs are defined.

Both claim kinds support `"polarity": "prove"` (the default) or `"refute"`.
Refutation generates a theorem named `ID_refuted` with type `¬ Generated.ID`.
The original `ID` is a statement definition, not a proved goal, and cannot satisfy
`--require-goal ID`. Use `--require-goal ID_refuted` for the refutation. The initial
proof-file comments preserve this exact negative type.

Claims sharing a `relationName` share a generated relation only when their source,
predicate identity, and input wiring agree. Conflicting definitions, duplicate
claim IDs, and collisions with projection IDs fail before project files are written.
The existing integer relational fragment applies: non-null integer columns,
positive relation atoms, supported comparison guards, supported computed heads,
and self-recursion. General derived dependencies, mutual recursion, negation,
aggregates, and structural-valued relation laws remain unsupported.

The [integer example](examples/selected-integer/plan.json) and its
[maintained proofs](examples/selected-integer/Proofs.lean) establish identity
uniqueness, successor coverage below `maxSafe`, and a refutation of unrestricted
successor coverage. Export it with the same commands as the projection example,
substituting `selected-integer` for `selected-projections` and a separate output
directory. It demonstrates two coverage claims sharing the same `Successor`
relation without duplicate Lean definitions.

## Local head refinements

A `claims` entry can select an integer head-refinement obligation:

```json
{"kind": "local", "id": "successor", "predicate": "successor", "rule": 1, "refinement": 1}
```

Both indices are one-based: `rule` selects a rule of the named predicate in source
order, and `refinement` selects that rule's generated refinement obligation.
Missing or unsupported obligations fail export. Every assumed contract obligation must also be explicitly selected with prove
polarity, including all defining sibling rules and transitive dependencies.
Missing prerequisites, duplicate selections of the same obligation, refutations
used as prerequisites, and recursive dependency cycles fail export. Selection
order does not matter. Recursive groups still need a separate induction boundary.
The existing local generator's eligibility rules apply, including its treatment
of unrefined sibling rules.

The manifest retains the typed statement, source location, and included/omitted
hypothesis provenance. This proves the existing local contract abstraction:
computed-head definedness is a premise, so success does not establish coverage.
Omitted body hypotheses can make the obligation stronger than the source claim.
`"polarity": "refute"` registers only `ID_refuted`; a refutation of this abstract
obligation does not necessarily exhibit a reachable runtime tuple.

The [local example](examples/selected-local/plan.json) and its
[proofs](examples/selected-local/Proofs.lean) prove successor safety and refute a
false positive-integer claim. Use the worked commands below with `selected-local`
and a separate output directory. No SMT solver is used by this Lean workflow.

The [dependency example](examples/selected-dependencies/plan.json) proves a chain
from a guarded positive input through two derived predicates. Its manifest maps
batch-local obligation identities to selected goal names and includes each full
dependency closure. All selected proofs are freshly built and audited, even when
`--require-goal resultSafe` requests only the final goal. A failing prerequisite
prevents report publication and removes any previous report. This checks the
local abstract statements and their complete acyclic prerequisites; the source
translation and contract-composition argument remain trusted.

## Recursive contract invariants

An `invariant` claim requests the published head contract over every finite
derivation of a selected positive relation:

```json
{"kind": "invariant", "id": "growSafe", "predicate": "grow", "relationName": "Grow"}
```

The [recursive example](examples/selected-recursive/program.dl) has a guarded
positive seed and a recursive bounded successor. Its [maintained proof](examples/selected-recursive/Proofs.lean)
inducts on the generated derivation. Removing the seed guard fails the proof;
local cyclic claims are not accepted in its place.

The exporter preserves all rules in the relation definition. Refinements become
the conclusion, never constructor premises. The conclusion is the disjunction of
sibling contracts, each a conjunction of that rule's refinements, with head names
mapped to output columns. Computed heads retain bounded witnesses and equality
premises from the existing relation model. Synthetic runtime refinement checks
are omitted from this derivation model; explicit constraints are rejected.

This first fragment requires non-null integer columns, refinements on every rule,
and comparisons between head positions and safe integer literals, optionally
combined using `&&`, `||`, and `!`. The
existing positive relation fragment supports self-recursion, variable-only atoms,
comparison guards, and variable or variable-plus-literal heads. Mutual recursion,
other derived dependencies, parity, negation, aggregates, arithmetic in the
contract, and nullable contracts remain unsupported. Both prove and refute polarity are
accepted. The manifest binds the exact relation and theorem, and fresh checking
audits the maintained proof. This is a direct invariant proof, not automatic
assembly of local proof cycles or an evaluation-termination proof.

For `"polarity": "refute"`, the [recursive refutation example](examples/selected-recursive-refutation/plan.json)
constructs a safe base tuple and a recursive step violating the claimed upper bound.
The exact goal is `growSafe_refuted : ¬ Generated.growSafe`. The positive statement
remains a definition and cannot satisfy a required-goal gate. Repairing the step
invalidates the counterexample proof. As with mutual refutations, this establishes
a modeled derivation counterexample rather than a backend execution trace.

## Initial mutual invariants

A separate joint selection exports one tagged inductive family for a complete
positive component:

```json
{"kind": "mutual-invariant", "id": "bothSafe", "predicates": ["left", "right"]}
```

The [mutual example](examples/selected-mutual/program.dl) passes positive seed
values between two predicates. Its [proof](examples/selected-mutual/Proofs.lean)
inducts over the joint family and establishes both contracts. Predicate order
assigns the family tags and is included in the manifest. Every rule from every
selected member becomes a constructor; the theorem conjoins the members' published
contracts. No member contract is a constructor premise. Adding an unguarded seed
rule to the second predicate causes the maintained proof to fail.

This initial fragment requires at least two distinct predicates forming one
strongly connected component, non-null integer relations (including zero-column derived members),
variable-only
atoms, variable or variable-plus/minus-safe-integer-literal heads, and supported integer
comparison guards. All rules must carry
supported comparison refinements, optionally combined using `&&`, `||`, and `!`. Missing members, derived dependencies outside the
component, explicit constraints, negation, parity, nullable columns, other computed
heads are rejected. There is one joint goal ID;
member definitions cannot independently satisfy a proof gate. Ordinary local
proof cycles remain unsupported. The family models finite derivations and does
not establish termination or backend correctness.

The [mutual successor example](examples/selected-mutual-successor/program.dl)
adds one in a cross-member rule. A constructor requires a `SafeInt` witness equal
to the mathematical sum; overflow therefore produces no derivation. Its joint
proof establishes positivity in the first predicate and a strict lower bound of
one in the second. Changing the step to add zero fails checking. Maintained Lean
boundary examples establish that `maxSafe - 1` admits a successor witness and
`maxSafe` does not. These auxiliary checks are not additional registered goals
or backend comparisons. Multiplication, division, nested computations, and
variable addends remain unsupported.

The [tuple example](examples/selected-mutual-tuples/program.dl) establishes
`Y > X` across two binary predicates, including a rule incrementing both columns.
Every tuple position remains a separate family argument; computed columns receive
independent bounded witnesses and sum equalities. Contracts refer to the matching
output positions. Swapping the computed outputs fails the maintained induction
proof. Members and inputs may now have differing positive arities, as described below.

The [mixed-arity example](examples/selected-mutual-mixed/program.dl) combines a
unary member, a binary member, and differently sized input relations. The family
uses the widest member's column count. Shorter members use the canonical bounded
zero in trailing slots in every constructor, recursive premise, and theorem
application. These slots are not source columns or extra quantified outputs.
Input relations retain their own argument counts, even when wider than the family.
The manifest records member arities, family width, input arities, and padding.

The maintained proof establishes both contracts by joint induction and separately
checks that a unary derivation's padding is always zero. Changing the computed
successor to add zero fails checking. This extends tuple representation only;
nullable values and general local proof-cycle assembly remain unsupported.

The [flag example](examples/selected-mutual-flags/program.dl) adds zero-column
derived members. A nullary member's contract is an implication with no output
binders; in a mixed family its slots are all canonical zero. A wholly nullary
family has type `Nat → Prop` and requires no padding or integer arguments.
The fixture also proves by induction that an all-nullary recursive cycle with no
base rule has no finite derivations. Adding a base fact makes that proof fail and
prevents a fresh report. This does not assume a cycle's contracts to prove them.
Input declarations still require at least one column under current parser syntax.

The [descent example](examples/selected-mutual-descent/program.dl) subtracts one
under a strict positive guard and proves that both members stay nonnegative.
Subtraction uses the same bounded-witness boundary as addition, with an explicit
difference equation. Allowing a step from zero fails the proof. Auxiliary Lean
checks cover a predecessor at `-maxSafe + 1` and its impossibility at `-maxSafe`.
These prove safety and modeled definedness, not evaluation termination. Variable
subtrahends, fractional literals, and nested arithmetic remain unsupported.

Mutual invariant selections also accept `"polarity": "refute"` (the default is
`"prove"`). The [refutation example](examples/selected-mutual-refutation/plan.json)
constructs a seed and a recursive derivation violating the second member's bound.
Its proof has the exact type `¬ Generated.bothSafe`. Only `bothSafe_refuted` is a
registered goal; `bothSafe` remains a definition and cannot satisfy `--require-goal`.
The refutation concerns the joint claim, so one failing member suffices; it does
not say that every member contract is false. Repairing the source step invalidates
the maintained counterexample, and a failed check removes the previous report.
This is a proof about a generated derivation, not a backend execution trace.

Both invariant exporters accept nested `&&`, `||`, and `!` in head refinements when
every leaf is a supported integer comparison. The [Boolean contract example](examples/selected-boolean-contracts/program.dl)
proves `X = 0 || (X > 0 && X <= 3)` by induction for both self and mutual recursion.
Relaxing the step guard to admit an output of four fails checking. Formula nesting
is preserved inside each refinement; multiple refinements still conjoin within a
rule and sibling contracts still disjoin.

Every accepted comparison is total over the non-null integer domain. This does
not extend null/undefined Boolean semantics, arithmetic inside comparisons,
negated relation calls, or compound body filters. Unsupported leaves fail the whole
export, including when another disjunct might make them unnecessary.

The [negated contract example](examples/selected-negated-contracts/program.dl)
proves `!(X < 0 || X > 3)` for self and mutual recursion. Logical negation becomes
Lean negation only after recursively checking that its operand uses supported
total comparisons and Boolean connectives. Nested negations preserve their source
structure. Tightening the bound to exclude the reachable value three fails checking.
This supports expression-level `!`; it does not add negation-as-failure to relation
bodies or define how nullable/undefined operands behave in the invariant model.

## Inspect before writing proofs

Use the same selection and intended output directory with the read-only command:

```bash
bun run lean:project inspect plan.json my-project > /tmp/datamog-goals.json
```

Inspection requires Bun but no Lean installation. It regenerates the current plan
in memory and emits JSON labeled `inspection-only`: selected goal IDs, theorem
names, exact statements, dependencies, complete closures, assumptions, generated
Lean definitions, and exact checker declarations. Source/selection snapshots and
the plan manifest are included. Unsupported selections fail with the same errors
as export.

The command does not create the output directory, alter maintained proofs, refresh
generated files, or remove an earlier report. If proofs already exist in the
intended directory, they contribute to the planned content identity. Inspection
shows what the current source would generate, even when disk-generated files are
stale; it does not validate those files or establish proof success. `--require-goal`
applies only to `check`.

## Invariants across derived dependencies

A `program-invariant` claim selects one or more predicates and follows every
positive derived call transitively:

```json
{"kind": "program-invariant", "id": "pipelineSafe", "predicates": ["output"]}
```

The [pipeline example](examples/selected-program-invariant/program.dl) passes
positive input through two unrefined helpers, a mutually recursive component,
and a refined output predicate. Its [proof](examples/selected-program-invariant/Proofs.lean)
uses induction on the complete generated family. Only selected predicates need
head contracts; upstream contracts are never assumed. Every defining rule of
every reachable predicate becomes a constructor, including sibling rules.

The exporter puts all reachable derived predicates in one tagged inductive
family, preserving finite-derivation semantics across multiple recursive
components. The manifest records component membership, derived-call edges, and
per-predicate rule definitions in the goal's dependency closure. Changes to an
upstream guard or rule invalidate the content identity. Fresh-check regressions
remove the positive input guard and add an unsafe upstream sibling separately;
both changes make the maintained downstream proof fail and leave no success report.

This uses the existing mutual fragment: non-null integer columns, mixed arities,
variable-only relation arguments, supported comparison guards, and variable or
variable-plus/minus-literal heads. Selected head contracts support comparisons
combined with `&&`, `||`, and `!`. Optional `"polarity": "refute"` requests a proof
of the negated claim. A single selected predicate is allowed; duplicate or empty
root selections are rejected. Unrefined helpers may be included automatically,
but selecting an unrefined predicate as a goal is rejected.

Negation in rule bodies, parity, aggregates, module imports, structural columns,
and unsupported expressions remain outside this fragment. This exports source
definitions together; it does not compose separately checked theorem reports or
introduce modular proof import. The narrower `mutual-invariant` selection still
requires exactly one complete strongly connected component.

## Uniqueness across derived dependencies

`program-uniqueness` uses the same complete positive dependency export to compare
two tuples from a selected predicate:

```json
{"kind": "program-uniqueness", "id": "pipelineUnique", "predicate": "output", "keyColumns": [0], "outputColumns": [1]}
```

Columns are zero-based. Both tuples share only the key columns; every other
column varies independently, including columns not selected as outputs. The
conclusion equates each selected output column. Empty keys request global
uniqueness. Empty outputs, duplicate or overlapping columns, and out-of-range
indices are rejected. Canonical padding for mixed-arity families is fixed and
is not an extra quantified tuple column.

No head refinements are required. The [worked pipeline](examples/selected-program-uniqueness/program.dl)
creates identity pairs and propagates them through mutual recursion to an output.
Its [proof](examples/selected-program-uniqueness/Proofs.lean) establishes equality
of each pair by induction, then proves uniqueness for two derivations. A fresh
regression adds an upstream rule producing a second value for the same key;
the unchanged proof fails and no success report remains.

All reachable rules contribute to the manifest closure, exact checker, and
fresh result. `"polarity": "refute"` requests the negated uniqueness statement.
The supported source fragment and trust boundary are the same as for
`program-invariant`; this does not import separately checked proofs.

## Coverage across derived dependencies

`program-coverage` proves that an input tuple produces an output through the
complete positive dependency graph:

```json
{"kind": "program-coverage", "id": "pipelineCoverage", "predicate": "output", "inputPredicate": "seed", "outputToInput": [0, null], "bounds": [{"column": 0, "op": ">=", "value": 0}, {"column": 0, "op": "<", "value": 9007199254740991}]}
```

The selected input must be a declared input dependency reachable from the output.
Every input column is universally quantified, including columns not copied to
outputs. Each output mapping is a zero-based input column or `null` for an
independent existential bounded-integer witness. A mapping with no witnesses
expresses direct inclusion; an empty mapping is allowed for a nullary output.
Other input relations remain universally quantified, without additional promises
that they contain matching rows.

Bounds use `<`, `<=`, `>`, or `>=` and safe integer literals. They restrict the
claimed input domain; they do not assert a law about the entire input dataset.
All upstream filters and computed heads stay in the generated constructors.
The theorem assumes neither head definedness nor intermediate derivations.
Invalid mappings, bounds, or input selections fail before export.

The [coverage pipeline](examples/selected-program-coverage/program.dl) filters
nonnegative inputs, computes their successors, and forwards them through mutual
recursion. Its [proof](examples/selected-program-coverage/Proofs.lean) constructs
a bounded successor and the complete output derivation. A companion refutation
uses input `-1` to disprove unrestricted coverage. Fresh regressions strengthen
the upstream filter to exclude zero and widen the input bound to include
`maxSafe`; both invalidate the maintained coverage proof and remove any old report.

The selection supports `"polarity": "refute"`, exact checker types, full rule
closures, and fresh results like the other composed claims. It retains the
same non-null integer source fragment and does not establish backend correctness.

## Equivalence across derived dependencies

`program-equivalence` compares two distinct derived predicates of equal arity:

```json
{"kind": "program-equivalence", "id": "sameRows", "predicates": ["first", "second"]}
```

The exporter follows the union of both positive dependency graphs and generates
one family. Its exact goal universally quantifies all input relations and each
output column, then states that the same tuple belongs to the first predicate
if and only if it belongs to the second. Shared input predicates use the same
relation parameter; distinct inputs remain independent. Head refinements are
not required. Nullary predicates compare proposition membership, and mixed-arity
helpers retain canonical padding without adding data columns to the goal.

The [worked example](examples/selected-program-equivalence/program.dl) proves
that two recursive paths from a shared input produce the same tuples. Its
[proof](examples/selected-program-equivalence/Proofs.lean) establishes both
inclusion directions by inspecting finite derivations. A companion refutation
uses input zero to distinguish an unfiltered path from a positive-only path.
Fresh regressions add a filter on either side separately; both break the exact
equivalence proof and remove any previous success report.

The descriptor supports `"polarity": "refute"`. Both predicates and every
reachable rule are included in the statement identity and fresh report. This
compares modeled relations in the supported positive integer fragment; it does
not prove SQL translation correctness or compare separately imported modules.

## Emptiness and named violation relations

`program-emptiness` proves that no tuple belongs to a selected derived predicate:

```json
{"kind": "program-emptiness", "id": "noViolation", "predicate": "violation"}
```

The exact goal quantifies every input relation and output column, then concludes
`False` from an output derivation. A nullary predicate needs no tuple quantifiers.
All reachable rules, including sibling rules and recursive components, contribute
to the generated family and manifest. No input law or head contract is assumed.
`"polarity": "refute"` instead requests a proof that universal emptiness is false.

The [worked violation relation](examples/selected-program-emptiness/program.dl)
selects nonpositive rows from a recursively propagated positive relation. Its
[proof](examples/selected-program-emptiness/Proofs.lean) shows no such derivation
exists. A second proof shows that a nullary cycle with no base rule is empty;
a refutation constructs a positive row to disprove emptiness of the source
relation. Fresh regressions weaken the positivity guard and add an unsafe
violation sibling; both reject the maintained emptiness proof and remove any
previous success report.

This provides a way to prove ordinary named violation predicates empty in the
supported positive integer fragment. The separate `constraint` selection below imports explicit `!-` statements;
named errors use the `error-predicate` selection below. Composed program laws can coexist with these checks as described below.
Runtime checks remain enabled.

## Explicit source constraints

Select an explicit `!-` statement by its one-based position among explicit
constraints in the source:

```json
{"kind": "constraint", "id": "noViolation", "constraint": 1}
```

Ordinary queries and synthesized refinement checks do not count toward this
index. The exporter copies the selected constraint body into a generated nullary
violation relation, follows its positive dependencies, and proves that relation
empty. The manifest binds the descriptor, exact constraint text, source offsets,
line/column, and all reachable definitions. Source and selection snapshots identify
the file; moving or editing a constraint invalidates the content identity.

Neither the selected constraint nor other constraints become hypotheses. The
theorem ranges over arbitrary typed input relations before runtime constraint
checks. It must establish that the selected violation cannot arise. In particular,
`!- seed(X).` is not accepted merely because it appears in the program: the
[worked fixture](examples/selected-constraints/program.dl) refutes that claim
with an input row, alongside a proved constraint over recursively propagated
positive integers. Its [maintained proofs](examples/selected-constraints/Proofs.lean)
are checked against exact generated types. Changing the upstream positivity guard
or the constraint comparison makes the maintained safety proof fail.

Supported bodies use positive variable-only relation atoms and the existing
integer comparison guards. Unsupported bodies, invalid indices, and generated
predicate-name collisions fail before export. `"polarity": "refute"` proves the
negation of the selected universal constraint. Explicit constraints and named
error goals and composed program laws may be selected together. Checks do not
automatically become selected goals. Runtime checks are unchanged.

## Named error predicates

Select a declared error relation by its predicate name:

```json
{"kind": "error-predicate", "id": "noBad", "predicate": "bad"}
```

The goal proves that no tuple of the error relation can be derived for any typed
inputs. Every defining rule participates, including siblings without an `error`
marker and recursive rules. The source provenance records all defining rules,
their error flags, exact text, and locations; the manifest includes the full
positive dependency closure. An ordinary predicate without an error declaration
cannot satisfy this selector; use `program-emptiness` for that case.

The [worked example](examples/selected-error-predicates/program.dl) proves a
recursive error relation empty and refutes emptiness of an error relation that
copies input rows. It also refutes an explicit `!-` constraint in the same
project. Neither named errors nor explicit constraints are assumed to hold.
The [maintained proofs](examples/selected-error-predicates/Proofs.lean) fail if
an upstream guard admits zero or an unmarked sibling introduces reachable errors.

`"polarity": "refute"` negates the exact universal emptiness theorem. Nullary
error predicates are supported. The existing positive integer fragment, fresh
checking, and axiom audit apply. Explicit constraint selection can now traverse
named error definitions as well. Runtime error reporting remains enabled, and
the older single-relation and single-component claim APIs retain their restrictions.

## Combining program laws and runtime checks

All composed `program-*` claims can now be selected in sources containing explicit
constraints and named errors. A plan may combine those laws with `constraint` and
`error-predicate` goals. Each goal still quantifies arbitrary typed inputs and
models derivations before runtime checks. Checks neither restrict the input domain
nor add hypotheses to a program law.

The [combined example](examples/selected-laws-and-checks/plan.json) proves a
recursive invariant, input-bounded coverage, an explicit constraint, and a named
error goal in one fresh project. An additional input constraint is deliberately
unselected: its presence is not proof that it holds. Reports cover only selected
goals, and `--require-goal` continues to refer to registered goal IDs.

Regressions compare generated definitions and theorem statements for all five
composed law kinds before and after checks are added; they remain identical,
while the source identity changes. A fresh Lean regression removes the actual
positivity guard and selects only the invariant. The proof then fails even though
runtime checks reject nonpositive input, demonstrating that those checks cannot
be used as assumptions to discharge the law.

The older `invariant` and `mutual-invariant` exporters retain their explicit-check
restrictions. This does not automatically select every source check or permit
unsupported rule bodies. Runtime checking remains enabled.

## Local module programs

Composed `program-*` claims can now select predicates in a source using local
`.dl` imports. Select the entry program's alias or derived predicate as usual;
the exporter follows the elaborated dependency graph through imported definitions.
The [nested-module example](examples/selected-modules/README.md) proves positivity
through two levels of imports.

The loader uses the same raw parsing, elaboration, post-processing, inference,
and module-boundary checking sequence as execution. Imports resolve relative to
the importing file. Each resolver call receives a fresh AST, while repeated reads
of one canonical file share a source snapshot. Elaborated predicate identities
preserve separate instances and wiring; shared instances follow the elaborator's
existing rules. Boundary checks enforce declared types, nullability, and polarity.

Module plans add `moduleSources` to inspection and fresh reports: exact text,
entry-relative path, and digest for the entry and every resolved module file.
`ModuleSources` in the manifest records those identities, import edges, and
boundary metadata, and belongs to every selected goal's closure. Changes to a
transitive import invalidate the plan even when the entry file is unchanged.
Check re-resolves the complete source graph when checking freshness. The source
snapshot and selection snapshot retain their existing entry-point meaning.

This scope supports composed integer program laws and selected source checks as
described below. Structural projection and local selections in module sources
are rejected. Runtime checks inside modules do not become assumptions.
Data-file bindings, remote imports, separate interface-law assumptions, and proof
imports remain unsupported. Module cycles, missing files, and incompatible
boundaries fail before export. This expands source loading; it does not prove the
elaborator correct or establish a reusable assume-guarantee module theorem.

## Entry-file checks over module dependencies

A module source may also select `constraint` and `error-predicate` goals declared
in its entry file. Constraint indices count only explicit entry-file `!-`
statements, excluding imported constraints and synthesized checks. Named error
selections require an entry-file error declaration and defining rules from that
file. To select a check inside an import, supply `instance` as described below.

The goal follows every positive imported definition needed by its body. Source
provenance adds an entry-relative `file` alongside the exact check text and
locations; the goal closure also contains `ModuleSources`. Adding an imported
constraint changes source identities but does not renumber entry constraints or
change their theorem statements.

The [module-check example](examples/selected-module-checks/plan.json) proves an
entry invariant, an explicit constraint, and a named error goal over an imported
positive filter, and refutes a second entry constraint asserting empty input.
Its module deliberately contains unselected checks that fail for nonempty input.
Those checks are never assumed: weakening the imported guard still invalidates
the maintained proofs. A successful report concerns the selected entry goals,
not satisfaction of all imported checks or successful execution on a dataset.

## Checks inside module instances

Both check descriptors accept an optional `instance` naming a module binding path.
A single name selects an entry binding (for example, `safe`); dotted names follow
source-local nested bindings (for example, `safe.pipeline.checked`).
Without it, selection remains entry-local. With it, `constraint` is the one-based
index among explicit `!-` statements in that instance's source, and `predicate`
is the source-local name of a declared error predicate:

```json
{"kind": "constraint", "id": "safeCheck", "instance": "safe", "constraint": 1}
```

Selection uses explicit elaborator metadata, including the shared expansion and
source-to-elaborated predicate mapping. Two aliases for the same module and
wiring select the same checks; different wiring selects distinct instances.
Nested imports still contribute definitions to the proof, but their checks are
not included in the parent's numbering. Unknown bindings, empty path segments,
non-error predicates, and out-of-range indices are rejected before export.
Only instantiated defaults appear in the path map: overriding a nested binding
with an actual removes that child path, even if the actual denotes another
module output. Selection does not follow relation aliases as module bindings.
Named error goals include all defining sibling rules in the selected instance.

The [instance-check example](examples/selected-instance-checks/README.md) proves
checks for a module wired to a positive filter and refutes the same source checks
for an instance wired to arbitrary input. Its shared alias exercises instance
reuse. The fresh-check suite also rejects the safe proofs after rewiring their
instance to arbitrary input. Source paths, selector descriptors, elaborated
relations, and the complete module source graph participate in manifest identity.
Checks never become input assumptions.

The [nested example](examples/selected-nested-instance-checks/README.md) checks
three levels of bindings, shared paths, and different wiring. Each selected
module keeps its own constraint numbering; parent and sibling checks remain
unselected and unassumed. Structural module claims and reusable module-interface
proofs remain future work.

## Worked example

The checked-in [selection](examples/selected-projections/plan.json),
[source](examples/selected-projections/program.dl), and
[maintained proofs](examples/selected-projections/Proofs.lean) establish coverage
and soundness for a required integer field and soundness for an optional nullable
field. From the repository root:

```bash
bun run lean:project inspect verification/lean/examples/selected-projections/plan.json /tmp/datamog-selected-example > /tmp/datamog-goals.json
bun run lean:project export verification/lean/examples/selected-projections/plan.json /tmp/datamog-selected-example
cp verification/lean/examples/selected-projections/Proofs.lean /tmp/datamog-selected-example/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-projections/plan.json /tmp/datamog-selected-example
bun run lean:project check verification/lean/examples/selected-projections/plan.json /tmp/datamog-selected-example
```

For your own project, author `Datamog/Proofs.lean` after the first export. Its
initial contents list the required theorem signatures as comments; it does not
supply successful placeholder proofs. Keep helper lemmas in this maintained file.
The workflow currently supports this single proof file, not additional local Lean
modules or external package dependencies.

Export preserves `Proofs.lean` byte for byte and refreshes generated definitions,
exact checkers, support libraries, and the content manifest. Run export again
after changing proofs, source, selection, or repository semantics. The output
must be empty or marked as a generated Datamog Lean project; unrelated directories
and symlinked managed files are rejected. Managed generated files are overwritten.
Keep source and selection outside those managed paths.

Check defaults to requiring every selected goal. You may specify repeated gates:

```bash
bun run lean:project check plan.json my-project --require-goal Picked_coverage --require-goal Picked_soundness
```

Every registered goal is still compiled and audited. Requested IDs must identify
registered goals, not schema definitions, and must have unconditional fresh
results. A definition or an unknown ID cannot satisfy a requirement.

## Freshness and assurance

The manifest hashes the source, selection, frontend/exporter inventories, runner,
lockfile, pinned build configuration, semantic libraries, audit policy, and
maintained proofs. Checker declarations name the exact expected types and audit
transitive axiom dependencies under the existing allowlist.

Check compares actual project contents with a recomputed plan, then writes only
that validated source snapshot to a fresh temporary directory. Existing `.olean`
files, `.lake` caches, alternate build scripts, and old result reports are ignored.
After the build succeeds, the runner recomputes the plan and rechecks project
contents before atomically publishing `verification-result.json`. Source or proof
changes during compilation therefore invalidate the run. Each subprocess has a
two-minute timeout. Process-tree containment and memory limits remain outside
this runner's current scope.

A previous report is removed at the start of checking; a failed check cannot
leave it as a current success. Successful export also removes any previous report.
Selected-project reports carry `evidenceSchema: "datamog-selected-evidence-v1"`.
`sourceSnapshot` contains the original source path, exact text, and digest;
`selectionSnapshot` contains the exact selection text and digest. `verificationPlan`
embeds the checked manifest, including goal statements, relation definitions,
dependency closures, semantic profile, and artifact identities. The snapshot
digests match that manifest's source/selection artifacts, and each result entry
matches its registered goal digest. Refuted claims remain definitions while their
negative theorems are goals. This makes a report self-contained for inspection;
it does not include all files needed to reproduce the build.

Reports identify modeled-language theorems. They are not certificates, are never
imported to discharge goals, and do not claim backend correctness or concrete
input coverage. Unlike the fixed-project `test:lean` suite, this workflow does
not run backend differential cases for the selected program.

This is a workflow for locally authored, trusted Lean source and the trusted
repository toolchain. Lean elaboration can execute code; it is not a sandbox or
an untrusted proof-import protocol. The manifest and audit output are freshness
and reporting mechanisms within that trust boundary, not authentication of
arbitrary external projects.

`bun test` includes export/freshness regressions without requiring Lean.
`bun run test:lean-project` freshly builds the worked project, ignores a poisoned
local cache, rejects `sorry`, a weaker theorem, and an extra axiom, and rejects a
source change made during compilation. The dedicated Lean CI job runs this suite.
