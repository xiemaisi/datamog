# Source checks under explicit input laws

The imported module rejects nonpositive input through both an explicit constraint
and a named error predicate. The selection proves those checks and an entry-file
violation relation empty under the named law `positiveSeed`. All three proofs
remain conditional. A fourth goal refutes the imported constraint without that
law, demonstrating that assumptions do not leak between selected claims.

```bash
bun run lean:project export verification/lean/examples/selected-input-law-checks/plan.json /tmp/datamog-input-law-checks
cp verification/lean/examples/selected-input-law-checks/Proofs.lean /tmp/datamog-input-law-checks/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-input-law-checks/plan.json /tmp/datamog-input-law-checks
bun run lean:project check verification/lean/examples/selected-input-law-checks/plan.json /tmp/datamog-input-law-checks --allow-conditional --require-goal unrestricted_refuted
```

The law names the actual entry input `seed`, not the imported parameter `item` or
the derived alias `imported`. Each law must target a reachable input of that goal.
This is an explicit premise about the wired input, not a reusable interface law
or a proof that an arbitrary dataset satisfies it.

Requiring `check` as an unconditional goal fails. Weakening `> 0` to `>= 0`
invalidates all three maintained conditional proofs. The constraints themselves
never become assumptions, and runtime checks remain enabled.
