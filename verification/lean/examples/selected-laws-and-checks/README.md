# A complete selected verification project

This example verifies four claims about [program.dl](program.dl) using
[plan.json](plan.json) and the maintained [Proofs.lean](Proofs.lean).
It uses the repository's Bun setup and pinned Lean 4.34.0 through `lake`.
Run the commands from the repository root.

The program accepts arbitrary integer `seed` rows, filters positive values,
propagates them through mutually recursive `positive` and `carry` predicates,
and produces `output` rows. It also declares a named error and two explicit
constraints. The selection chooses:

| Goal ID | What its proof establishes |
|---|---|
| `safe` | Every derived output is positive |
| `covered` | Every positive input has an output; positivity is an explicit domain bound |
| `noViolation` | The first explicit constraint, on nonpositive `positive` rows, cannot be violated |
| `noBad` | The named error relation has no derivations |

The second explicit constraint, `!- seed(X), X <= 0.`, is **not selected or proved**.
It still executes at runtime. Its presence does not justify assuming that inputs
are positive in any theorem. All four proofs quantify arbitrary typed input
relations; coverage restricts the particular input tuple by its stated bound.

## Inspect, export, and check

Use an empty directory or one already owned by this workflow. Inspection requires
Bun only and does not write project files:

```bash
bun run lean:project inspect verification/lean/examples/selected-laws-and-checks/plan.json /tmp/datamog-laws-walkthrough > /tmp/datamog-laws-preview.json
bun run lean:project export verification/lean/examples/selected-laws-and-checks/plan.json /tmp/datamog-laws-walkthrough
cp verification/lean/examples/selected-laws-and-checks/Proofs.lean /tmp/datamog-laws-walkthrough/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-laws-and-checks/plan.json /tmp/datamog-laws-walkthrough
bun run lean:project check verification/lean/examples/selected-laws-and-checks/plan.json /tmp/datamog-laws-walkthrough --require-goal safe --require-goal covered --require-goal noViolation --require-goal noBad
```

The copy installs this example's maintained proofs. For your own project, author
that file after the first export. The second export binds its contents into the
manifest; regeneration preserves it. Changing source, selection, proofs, or the
exporter requires export and check again.

Check compiles a fresh temporary project, checks exact theorem types, and audits
axiom dependencies. A successful run writes
`/tmp/datamog-laws-walkthrough/verification-result.json`. Omitting the repeated
`--require-goal` options requires all registered goals by default; explicit gates
do not skip compilation or auditing of other registered goals.

## Read the result

The report contains four proved entries, the requested goal IDs, source and
selection snapshots, and the checked verification plan with statement digests
and complete dependencies. The preview is only a proposed plan; it has no proof
success status. Neither artifact asserts that every source constraint is proved.

The regression suite removes the actual positivity guard and checks only the
`safe` invariant. That proof fails even though the source still contains runtime
checks against nonpositive values. This tests the essential separation between
proving a law and enforcing a check on a dataset. Failed checks remove the old
report rather than leaving a previous success behind.

These are Lean-kernel-checked statements about the exported model. They do not
certify native/SQL execution, prove termination, or provide an importable proof
certificate. The selected workflow does not run backend comparisons for this
source; the fixed Lean suite has separately reported concrete comparisons.
See the [support matrix and trust boundary](../../PROJECTS.md) for the full scope.

For a conditional proof whose input laws are checked before executing the same
rows, see the [checked input execution example](../selected-input-run/README.md).
