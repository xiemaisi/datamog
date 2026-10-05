# Preserving an input functional dependency

`item` has key, value, and tag columns. The named `inputKey` law says that any two
input tuples sharing column 0 agree on column 1. Their tag columns vary
independently. The pipeline drops the tag and preserves key/value pairs.

```json
{"kind": "functional-dependency", "id": "inputKey", "predicate": "item",
 "keyColumns": [0], "outputColumns": [1]}
```

The maintained proof follows output derivations back to input tuples, then applies
the input law. Its result remains conditional. The companion theorem refutes
unrestricted output uniqueness with two different values for the same key.

```bash
bun run lean:project export verification/lean/examples/selected-functional-dependency/plan.json /tmp/datamog-functional-dependency
cp verification/lean/examples/selected-functional-dependency/Proofs.lean /tmp/datamog-functional-dependency/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-functional-dependency/plan.json /tmp/datamog-functional-dependency
bun run lean:project check verification/lean/examples/selected-functional-dependency/plan.json /tmp/datamog-functional-dependency --allow-conditional --require-goal unrestricted_refuted
```

Changing the assumed key to `[0, 2]` weakens the law: tuples with different tags
need no longer agree on value. The original proof then fails after regeneration.
`--require-goal unique` rejects the conditional result even with
`--allow-conditional`. No input law is inferred from source checks or validated
against a dataset by this workflow.
