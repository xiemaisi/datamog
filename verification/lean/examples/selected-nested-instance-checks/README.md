# Checks inside nested module instances

This extends the [direct-instance example](../selected-instance-checks/README.md)
with `wrapper.dl` and `middle.dl`. The selector `safe.pipeline.checked` follows
three source binding names to the checks declared in `filter.dl`.

`safe` and `shared` share their complete instance tree. `unsafe` supplies arbitrary
input instead of the positive filter, so the same nested checks are refuted there.
Each parent also contains a deliberately false constraint. Parent checks neither
change child constraint numbering nor become assumptions in the selected proofs.

```bash
bun run lean:project export verification/lean/examples/selected-nested-instance-checks/plan.json /tmp/datamog-nested-instance-checks
cp verification/lean/examples/selected-nested-instance-checks/Proofs.lean /tmp/datamog-nested-instance-checks/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-nested-instance-checks/plan.json /tmp/datamog-nested-instance-checks
bun run lean:project check verification/lean/examples/selected-nested-instance-checks/plan.json /tmp/datamog-nested-instance-checks
```

The fresh-check suite rejects the safe proofs after changing their input wiring.
Unit tests also override the `pipeline` default: `safe.pipeline.checked` then
fails selection because that child instance was never instantiated. The shared
alias's separately retained default remains selectable.

These results concern selected checks in the exported model; they do not prove
backend correctness or satisfaction of every runtime check in the module tree.
