# Optional Lean verification spike

This project pins Lean **4.34.0** and has no third-party Lean dependencies.
Ordinary Datamog builds and `bun test` do not require Lean. With Elan/Lean and
Bun on PATH, run from the repository root:

```bash
bun run generate:lean
bun run test:lean
```

`generate:lean` reads `doc/invariants/code/08-verify.dl` and
`verification/lean/fixtures/reach.dl`. It regenerates only
`Datamog/Generated.lean`, `Datamog/Checked.lean`, and `manifest.json`. Maintain proofs in
`Datamog/Proofs.lean`; regeneration never overwrites that file.
`bun run generate:lean --check` rejects stale generated output without writing.

The checked arithmetic theorem is the existing successor refinement, exported
from the typed obligation IR with its safe-integer, nullness, and head-definedness
premises. It is a local safety theorem, **not successor coverage**. In particular,
no output is required at the maximum integer. Boolean IR values become Lean
propositions, with Boolean equality represented by logical equivalence.

The recursive theorem uses an inductive `Reach` generated from both Datamog
rules over `SafeInt`. It proves preservation of an arbitrary property, conditional
on the input edges preserving that property. It does not establish the premise
for a loaded graph, nor prove evaluation termination. The relational exporter
currently accepts one positive, possibly self-recursive predicate with
variable-only atoms over non-null integers; other derived calls, mutual recursion,
negation, aggregates, computed terms, and constraints are rejected.

`Semantics.lean` separates `none` (undefined) from `some Value.null`, models safe
integers, truth, logical negation, null-aware equality, ordering, addition,
truncating division, and remainder. Nullable arithmetic is rejected by Datamog's
current frontend; the raw semantic operations still state its null propagation.
The IR's quotient uses zero as a totalized placeholder for a zero divisor;
Datamog division separately requires a nonzero divisor. This model has no float
or structural-value semantics. Structural goals remain unsupported by local export.

`test:lean` checks regeneration and the toolchain version, copies project sources
to a fresh temporary project, and rebuilds without existing project `.olean`
files. Generated checker theorems require the exact expected types, then audit
transitive axiom dependencies. The allowlist is `propext`, `Classical.choice`, and
`Quot.sound`; `sorryAx`, user axioms, and native computation axioms are rejected.
See the [Lean axiom reference](https://lean-lang.org/doc/reference/latest/Axioms/).
This policy is tested by deliberately failing proof attempts. A false local goal
is exported only as a negative fixture, and its negation is proved and audited.

The integration suite also compares 164 concrete arithmetic/null cases with the
native and SQLite backends and checks the same results in Lean using kernel
reduction (`decide`, never `native_decide`). These are regression checks, not a
proof of compiler or backend correctness. PostgreSQL is not covered by this suite.

The parser, analysis, exporters, semantic definitions, audit implementation, and
pinned toolchain remain trusted. Local exported goals may assume published
contracts: proving one does not independently discharge those dependencies.
The registered successor fixture has no such dependencies. No proof cache,
arbitrary external proof import, or CLI `--verify`
Lean integration exists yet. Proof elaboration executes repository code; the
axiom policy does not sandbox that process.

## Manifest and invalidation

`manifest.json` is a verification plan, not a successful result or certificate.
It records registered theorem names, their statements, assumptions, and dependency
closures. SHA-256 digests cover canonical JSON (sorted object keys, ordered arrays)
and the complete reachable definition set, including cycles.

The context includes the semantic profile, selected checking method, pinned
Lean toolchain, lockfile, complete core/parser source inventories, generation and
checking scripts, Datamog fixtures, and maintained Lean sources/configuration.
These files are hashed by contents. Changing semantics, imported Lean definitions,
proofs, the axiom audit, or frontend analysis invalidates the plan even when the
exported theorem text happens to remain identical. This deliberately invalidates
all registered results on any context change; finer dependency granularity can
come later. Newly imported project Lean modules belong under `Datamog/` so they
are included in the inventory; third-party Lean libraries remain unsupported.

The generated checker records the manifest digest. `generate:lean --check`
recomputes the artifacts from current sources and compares their full contents;
a copied digest cannot authenticate a changed statement. `test:lean` performs
that check before its fresh source build and reports the manifest identity with
the successful audits. Regeneration preserves proof scripts, which must then
check against the newly generated types. No cached result is accepted, and a
manifest or matching digest alone never discharges a theorem.

## Fresh verification reports

Run `bun run test:lean --report` to write the ignored
`verification/lean/verification-result.json` after the entire suite succeeds.
The runner removes an earlier report before checking, builds from fresh source,
requires exactly one structured axiom audit for each registered theorem, and
rechecks the manifest before atomically publishing the report. A failed run with
`--report` leaves no previous success report. Runs without the flag do not update
or remove reports.

The report binds each theorem to its goal and manifest digests, records the
transitive axiom dependencies, and keeps assurance separate from status. Goals
with explicit assumptions anywhere in their dependency closure are `conditional`;
others are `proved`. In particular, reachability retains its input edge premise,
and `falseGoal_refuted` reports a proof of the negation, not of the false goal.
The scope is the modeled language. Reports describe trusted local build outcomes;
they are not authenticated certificates, do not enable proof reuse, and are never
accepted as input to discharge a goal. Build tools and their log output remain
trusted. Consumers must not infer current validity from an old report.

## Postgres semantic comparisons

`bun run test:lean` also compares the 164 semantic cases with Postgres when
`DATAMOG_EXAMPLES_DATABASE_URL` or `DATABASE_URL` is set (the former takes
precedence). Use a dedicated test database. The runner creates a unique schema
on a single connection and drops that schema on completion or failure; it does
not reset `public`. The existing devcontainer configuration enables this path.

Without a URL, the runner explicitly reports the Postgres comparisons as skipped.
With `DATAMOG_REQUIRE_POSTGRES` set, a missing URL is an error. A configured but
unreachable server always fails the run. Lean CI provisions Postgres and requires
these checks. Fresh JSON reports include `semanticChecks` with the case count,
participating backends and Postgres status; these concrete comparisons do not
establish universal backend correctness or change theorem assurance.

## Requiring unconditional goals

Use manifest goal IDs to require specific unconditional results from a fresh run:

```bash
bun run test:lean --report --require-goal successor --require-goal falseGoal_refuted
```

All registered proofs and regression checks still run. Each requested ID must
name a registered goal and have no remaining assumptions in its dependency
closure; a definition ID, typo, missing audit, or conditional result fails the
run. `--require-goal reachPreserves` therefore fails with the input edge premise
in its diagnostic. Requiring `falseGoal` fails because it is a definition;
`falseGoal_refuted` names the theorem proving its negation. An option without an
ID is a usage error. Reports record the deduplicated requested IDs.

Without `--require-goal`, conditional theorems continue to be valid outcomes of
the proof suite. This gate checks the fixed project's fresh results only; it is
not general CLI verification, arbitrary cyclic contract discharge, or report
import. Lean CI requires the successor and false-goal-refutation proofs.
