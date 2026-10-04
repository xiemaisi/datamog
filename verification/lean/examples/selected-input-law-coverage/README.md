# Coverage under an explicit input law

Every `item` row has a successor if every input integer is strictly below
`maxSafe`. The `total` claim states that input-wide law explicitly and has no
row-level coverage bounds. Its proof constructs the bounded successor; head
definedness is not assumed.

The companion `unrestricted_refuted` theorem uses an input containing `maxSafe`
to refute total coverage without the law.

```bash
bun run lean:project export verification/lean/examples/selected-input-law-coverage/plan.json /tmp/datamog-input-law-coverage
cp verification/lean/examples/selected-input-law-coverage/Proofs.lean /tmp/datamog-input-law-coverage/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-input-law-coverage/plan.json /tmp/datamog-input-law-coverage
bun run lean:project check verification/lean/examples/selected-input-law-coverage/plan.json /tmp/datamog-input-law-coverage --allow-conditional --require-goal unrestricted_refuted
```

The report marks `total` conditional and the refutation proved. Requiring `total`
still fails even with `--allow-conditional`. Changing the input law from `<` to
`<=` admits the overflowing boundary and invalidates the maintained proof.

Coverage `bounds` restrict the particular input row quantified by the goal.
An `inputLaws` premise instead constrains every row of its named input relation.
These are different statements and have different content identities. Neither
form validates a dataset; input-law reports retain the explicit assumption.
