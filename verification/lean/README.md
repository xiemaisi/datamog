# Proving properties of Datamog programs

The goal is to prove that a Datamog program satisfies a stated property for every
input covered by that statement. For example: every result is positive, a key
has at most one output, or every eligible input produces a result. Recursive
programs need proofs that account for any number of rule applications.

This directory contains an experimental implementation using Lean, a proof
assistant whose kernel checks mathematical proofs. Datamog generates the
statement and relation definitions from your source; you supply the proof.
Lean then checks that proof against the generated statement. The existing SMT
verifier remains available for automatic checking of local refinements.

## What we built and how it works

The implementation can prove invariants, uniqueness, coverage, equivalence, and
emptiness for supported integer relations, including positive recursion and local
module imports. It can also prove that selected integrity constraints and named
error predicates cannot be violated. A separate exporter handles supported
projections through records and arrays with integer leaves.

The relation fragment uses non-null safe integers, simple comparison guards,
and a limited set of computed heads. The [support matrix](PROJECTS.md#support-at-a-glance)
describes the exact limits. Unsupported selections fail explicitly.

A verification project has three inputs: a Datamog program, a JSON plan selecting
the claims to prove, and a Lean file containing your proofs. The workflow is:

1. **Export the claims.** Each supported positive rule becomes a way to construct
   a finite derivation in Lean. This gives positively recursive relations an
   induction principle: a proof can follow a derivation back through the rules
   that produced it. The current relational exporter excludes negated relation
   calls and parity-stratified recursion. Supporting them would require an
   additional semantic model; this is a limit of the exporter, not of Lean.
   The semantic model preserves Datamog's integer bounds, null values, and
   undefined expressions where the selected fragment uses them.
2. **Write the proofs.** Generated definitions and maintained proofs live in
   separate files. Regeneration preserves your proof file. Proofs may use
   induction and Lean tactics, but the kernel must accept the resulting terms.
3. **Check and report.** The checker builds a fresh Lean project, requires each
   proof to have the exact selected theorem type, and audits its axiom
   dependencies. A manifest identifies the source, statements, assumptions,
   proofs, and toolchain by their contents. Changes require regeneration and
   checking again; a failed check removes the previous result report.

The repository includes maintained proofs, tests that reject invalid proofs,
and comparisons of concrete semantic cases against native, SQLite, and Postgres
execution. Those comparisons help find modeling and implementation mistakes.
The universal proofs concern the exported model; the frontend, exporter, and
semantic definitions remain trusted, and backend correctness is not proved.
Runtime constraints stay enabled.

## Walk through one example

The [laws-and-checks example](examples/selected-laws-and-checks/) filters positive
input values and passes them through two mutually recursive predicates:

```prolog
input predicate seed(n: integer).
positive(X) :- seed(X), X > 0.
positive(X) :- carry(X).
carry(X) :- positive(X).
output(X, _: X > 0) :- positive(X).
error predicate bad(X) :- positive(X), X <= 0.
!- positive(X), X <= 0.
!- seed(X), X <= 0.
```

The first rule introduces only positive values. The recursive rules copy those
values, so every finite derivation of `positive`, `carry`, or `output` retains
positivity. A positive input can also reach `output` directly through the first
rule. These observations are the arguments the Lean proofs make precise.

The example's [plan.json](examples/selected-laws-and-checks/plan.json) selects
four claims:

| Goal | Statement |
|---|---|
| `safe` | Every derived `output` value is positive. |
| `covered` | Every `seed` value greater than zero has a corresponding `output` value. |
| `noViolation` | The first `!-` constraint cannot be violated. |
| `noBad` | The `bad` relation is empty. |

The last constraint, `!- seed(X), X <= 0.`, is deliberately left unproved.
An input containing zero violates it at runtime. Its presence does not let the
proof assume that all inputs are positive: `safe` must follow from the filtering
rule itself. Likewise, `covered` promises an output only for positive input
values; it makes no promise for zero or negative values.

Run the following from a Datamog source checkout with Bun dependencies installed.
Checking requires Lean **4.34.0** through Elan's `lake` command; the devcontainer
provides it. Inspection and export require only Bun. Choose an empty output
directory or one previously generated for this example.

```bash
proof_example=verification/lean/examples/selected-laws-and-checks
proof_project=/tmp/datamog-laws-walkthrough

bun run datamog proof inspect "$proof_example/plan.json" "$proof_project"
bun run datamog proof export "$proof_example/plan.json" "$proof_project"
```

`inspect` previews the goals and their assumptions without writing a project.
`export` writes the Lean definitions, expected theorem types, and a starter
`Datamog/Proofs.lean` file. For this walkthrough, use the
[proofs supplied with the example](examples/selected-laws-and-checks/Proofs.lean):

```bash
cp "$proof_example/Proofs.lean" "$proof_project/Datamog/Proofs.lean"
bun run datamog proof export "$proof_example/plan.json" "$proof_project"
bun run datamog proof check "$proof_example/plan.json" "$proof_project"
```

The second export records the maintained proof file in the manifest. In your
own project, this is the file you would write and revise. The `safe` proof uses
induction over the generated derivations: the input rule supplies positivity,
and every subsequent rule preserves it. The coverage proof constructs an
output derivation from a positive input. The other two proofs show that a
positive value cannot also satisfy `X <= 0`.

A successful check prints these results, followed by the report's location:

```text
safe: proved claim
covered: proved claim
noViolation: proved claim
noBad: proved claim
```

The order may differ. The full report is
`/tmp/datamog-laws-walkthrough/verification-result.json`. These four results hold
for arbitrary admitted `seed` relations, including ones containing nonpositive
values. They do not say that the unselected input constraint holds, or that a
particular dataset has been loaded or executed.

To see the proof catch a bug, work on a copy of the example and remove `X > 0`
from the first rule. Export again and check using the same proofs. The positivity
proof fails: the remaining runtime constraints cannot supply its missing premise.

The [project guide](PROJECTS.md) covers other claim kinds, explicit input
assumptions, reports, and process limits. The
[checked execution example](examples/selected-input-run/README.md) shows how to
validate input assumptions against CSV data and execute those same rows with
`--run-native`. Its dataset checks and runtime results are reported separately
from the universal theorems.

For implementation work, `bun run test:lean` checks the fixed semantic library
and backend comparisons, `bun run test:lean-project` checks selected proof
projects, and `bun run test:lean-cli` exercises the compiled CLI workflow. Postgres
comparisons are required in CI and explicitly skipped locally when no test
database is configured. See [DEVELOPMENT.md](../../DEVELOPMENT.md) for setup and
[the design document](../../doc/design/verification-obligations.md) for the
translation's trust boundary and future work. Ordinary Datamog execution requires
no Lean installation.
