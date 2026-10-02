# User-selected Lean projects

`bun run lean:project` exports and checks structural projections, integer relation claims, and local head refinements for a
standalone Datamog source file. This is an optional repository workflow; ordinary
Datamog execution and `--verify` do not require Lean. Export needs only Bun.
Checking requires the repository's pinned Lean 4.34.0 toolchain through `lake`.

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
rather than silently dropping goals. The current source must have no module or
data bindings (`:=`); ordinary input declarations quantify over admitted data.

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

## Worked example

The checked-in [selection](examples/selected-projections/plan.json),
[source](examples/selected-projections/program.dl), and
[maintained proofs](examples/selected-projections/Proofs.lean) establish coverage
and soundness for a required integer field and soundness for an optional nullable
field. From the repository root:

```bash
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
