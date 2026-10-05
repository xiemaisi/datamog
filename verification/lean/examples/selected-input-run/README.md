# Check input laws and execute the checked rows

This project proves output positivity under an explicit positive-input law and
refutes the unrestricted claim. Its named output returns the admitted input rows.

```bash
bun run datamog proof export verification/lean/examples/selected-input-run/plan.json /tmp/datamog-input-run
cp verification/lean/examples/selected-input-run/Proofs.lean /tmp/datamog-input-run/Datamog/Proofs.lean
bun run datamog proof export verification/lean/examples/selected-input-run/plan.json /tmp/datamog-input-run
bun run datamog proof check verification/lean/examples/selected-input-run/plan.json /tmp/datamog-input-run --allow-conditional --run-native --input-file item=verification/lean/examples/selected-input-run/item.csv
```

The last command checks the Lean proofs, validates the input law, and runs the
native backend using those same parsed rows. It prints output rows 1 and 2 and
writes dataset evidence and execution results in one fresh report. The universal
positivity theorem remains conditional; execution is recorded as
`runtime-executed`, with runtime constraints enabled. This does not prove the
native backend correct or verify unselected program properties.

Every declared input needs an explicit CSV file, even if it has no input law.
Header-only files represent empty inputs. A failing law, runtime constraint,
changed file, or failure to reach a fixed point within 1,000 iterations prevents
report publication and removes the previous report.
