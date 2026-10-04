# Checks inside module instances

The same `filter.dl` is instantiated with two different inputs. `safe` and
`shared` share an instance wired to the derived positive filter. `unsafe` is
wired directly to arbitrary integer input.

The selection proves the safe instance's explicit constraint and its named error
goal through the shared alias. It refutes both checks for the unsafe instance,
using input zero. No module check is assumed as an input law.

```bash
bun run lean:project export verification/lean/examples/selected-instance-checks/plan.json /tmp/datamog-instance-checks
cp verification/lean/examples/selected-instance-checks/Proofs.lean /tmp/datamog-instance-checks/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-instance-checks/plan.json /tmp/datamog-instance-checks
bun run lean:project check verification/lean/examples/selected-instance-checks/plan.json /tmp/datamog-instance-checks
```

The report contains four checked goals, including two refutations. Changing
`item = positive` to `item = seed` makes the safe proofs fail after regeneration.
`instance` names a direct entry binding; nested instance paths are unsupported.
These are theorems about the exported model, not backend correctness proofs.
