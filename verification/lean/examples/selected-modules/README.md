# A selected invariant through nested modules

[program.dl](program.dl) wires arbitrary integer `seed` rows into
[pipeline.dl](pipeline.dl), which imports [filter.dl](filter.dl). The filter retains
positive rows, and the entry predicate `output` publishes positivity as its head
contract. [plan.json](plan.json) selects that invariant; [Proofs.lean](Proofs.lean)
proves it over every imported rule, without assuming an interface law.

From the repository root, with Bun and pinned Lean 4.34.0 available:

```bash
bun run lean:project inspect verification/lean/examples/selected-modules/plan.json /tmp/datamog-module-example > /tmp/datamog-module-preview.json
bun run lean:project export verification/lean/examples/selected-modules/plan.json /tmp/datamog-module-example
cp verification/lean/examples/selected-modules/Proofs.lean /tmp/datamog-module-example/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-modules/plan.json /tmp/datamog-module-example
bun run lean:project check verification/lean/examples/selected-modules/plan.json /tmp/datamog-module-example --require-goal safe
```

The fresh report contains one proved goal and three `moduleSources` snapshots.
Its manifest includes import edges and elaborated definitions. Changing only
`filter.dl` invalidates the project. Regenerate after changes; weakening its guard
to `X >= 0` makes the maintained positivity proof fail.

This uses source-definition composition. It does not import a proof of the module
interface or assume that a module's runtime checks hold. See the
[module support boundary](../../PROJECTS.md#local-module-programs).
