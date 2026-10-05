# Uniqueness and equivalence under input laws

The input has key and value columns. The named law `zeroValues` says that every
input tuple's second column is zero; it quantifies over both columns.

Under that law, `raw` is unique per key and equivalent to `filtered`, which keeps
only zero-valued rows. The companion unrestricted claims are refuted: values zero
and one for the same key break uniqueness, while value one breaks equivalence.

```bash
bun run lean:project export verification/lean/examples/selected-input-law-relations/plan.json /tmp/datamog-input-law-relations
cp verification/lean/examples/selected-input-law-relations/Proofs.lean /tmp/datamog-input-law-relations/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-input-law-relations/plan.json /tmp/datamog-input-law-relations
bun run lean:project check verification/lean/examples/selected-input-law-relations/plan.json /tmp/datamog-input-law-relations --allow-conditional --require-goal uniqueUnrestricted_refuted --require-goal equivalentUnrestricted_refuted
```

The two proofs remain conditional; the two refutations are unconditional.
Requiring either conditional goal fails. Weakening the law from `= 0` to `>= 0`
invalidates the maintained proofs. No runtime input check is removed.

This uses the existing column-to-integer comparison fragment. It does not add
functional-dependency input laws or arbitrary comparisons between tuples.
