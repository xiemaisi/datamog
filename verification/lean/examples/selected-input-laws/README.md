# Explicit input laws

`output` preserves its input unchanged and claims positivity. The `positive`
goal explicitly assumes that every `item` row has a positive first column.
The `unrestricted_refuted` goal shows that the same source contract fails without
that assumption, using input zero.

```bash
bun run lean:project export verification/lean/examples/selected-input-laws/plan.json /tmp/datamog-input-laws
cp verification/lean/examples/selected-input-laws/Proofs.lean /tmp/datamog-input-laws/Datamog/Proofs.lean
bun run lean:project export verification/lean/examples/selected-input-laws/plan.json /tmp/datamog-input-laws
bun run lean:project check verification/lean/examples/selected-input-laws/plan.json /tmp/datamog-input-laws --allow-conditional
```

The report marks `positive` conditional and lists `positiveItems` with its exact
formula. The refutation is unconditional. Omitting `--allow-conditional` or adding
`--require-goal positive` fails the check and removes any previous report.
The flag permits reporting conditional proofs; it does not bypass proof checking
or discharge their premises. Weakening the law's bound to `-1` invalidates the
maintained proof after regeneration.

These statements quantify over all input relations satisfying their named laws.
They do not establish that a loaded dataset satisfies those laws. To check
this law for a particular CSV relation, create a file such as `item.csv` with
header `n` and positive integer rows, then run:

```bash
bun run datamog proof check verification/lean/examples/selected-input-laws/plan.json \
  /tmp/datamog-input-laws --allow-conditional --input-file item=/path/to/item.csv
```

The report records separate dataset evidence and the CSV digest; `positive`
remains conditional as a universal theorem. A zero row fails the dataset check
and removes any previous report. Runtime checks remain active, and source
constraints never become implicit assumptions.
