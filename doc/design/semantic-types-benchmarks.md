# Semantic type benchmark baseline

Status: **measurement report, not a pending implementation plan.** The benchmark
script and the subtype improvements discussed below are implemented. Timings
refer to the recorded revisions and environment, not to a fresh measurement of
current `main`; further tuning is optional follow-up work.

Baseline: runtime implementation at `471a7c14` (documentation checkpoint
`94d91de7`). Run with `bun run bench:semantic-types > baseline.json`; set
`DATAMOG_BENCH_SAMPLES` to change the default seven samples (1–100).

The script asserts results after warmup and each sample. Fixture parsing, analysis,
primitive/nullness inference and operand lowering are excluded from semantic
inference timings. Each measured inference call starts a fresh semantic fixed point.
Relation calls include normalization and their normal per-operation caches.
Prepared validation excludes preparation; the per-cell comparison includes it.
Validation measurements exclude JSON parsing, canonicalization and database inserts.

These are synthetic workloads, not end-to-end application or database benchmarks.
Two warmup calls precede each workload; iterations per sample appear below.
No forced collection is used. Allocation and GC costs remain in the observations.
Bun 1.4.2, Linux arm64; the container reports its CPU model as `unknown`.
Timings from this single environment are observations, not CI thresholds or budget
recommendations. Differences between small timings can be dominated by JIT and GC.

| Workload | Size / outcome | Iterations | Median ms | Min–max ms |
| --- | --- | ---: | ---: | ---: |
| inference/private-chain | rules=33 | 3 | 0.3684 | 0.2227–1.0184 |
| inference/published-chain | rules=33 | 3 | 0.1759 | 0.1645–0.5140 |
| inference/private-chain | rules=129 | 3 | 1.1809 | 1.0622–2.7677 |
| inference/published-chain | rules=129 | 3 | 1.0575 | 0.9900–1.1748 |
| inference/private-chain | rules=513 | 3 | 6.3525 | 5.1801–7.4017 |
| inference/published-chain | rules=513 | 3 | 7.1992 | 5.7357–11.2734 |
| inference/recursive-shapes | predicates=8, rules=16 | 3 | 1.0561 | 0.8856–1.3273 |
| inference/recursive-shapes | predicates=32, rules=64 | 3 | 3.2156 | 3.0619–3.3456 |
| relation/record-subtype | fields=8 | 30 | 0.0064 | 0.0058–0.0111 |
| relation/record-intersection | fields=8 | 30 | 0.0082 | 0.0076–0.0135 |
| relation/record-subtype | fields=64 | 30 | 0.0366 | 0.0285–0.0766 |
| relation/record-intersection | fields=64 | 30 | 0.0347 | 0.0330–0.0486 |
| relation/record-subtype | fields=256 | 30 | 0.1232 | 0.1115–0.1645 |
| relation/record-intersection | fields=256 | 30 | 0.1260 | 0.1228–0.1737 |
| relation/collective-coverage | choices=2, alternatives=4, maxWork=1000000, outcome=accepted | 3 | 0.0082 | 0.0069–0.0092 |
| relation/collective-coverage | choices=2, alternatives=4, maxWork=16000000, outcome=accepted | 3 | 0.0081 | 0.0072–0.0109 |
| relation/collective-coverage | choices=4, alternatives=16, maxWork=1000000, outcome=accepted | 3 | 0.0600 | 0.0559–0.0692 |
| relation/collective-coverage | choices=4, alternatives=16, maxWork=16000000, outcome=accepted | 3 | 0.0545 | 0.0506–0.2038 |
| relation/collective-coverage | choices=6, alternatives=64, maxWork=1000000, outcome=work-limit | 3 | 0.1712 | 0.1665–0.1838 |
| relation/collective-coverage | choices=6, alternatives=64, maxWork=16000000, outcome=accepted | 3 | 0.5915 | 0.5654–0.7898 |
| validation/prepare | one column | 100 | 0.0035 | 0.0031–0.0158 |
| validation/prepared-batch | rows=10000 | 1 | 2.8221 | 2.3001–3.5925 |
| validation/prepare-per-cell | rows=10000 | 1 | 19.2941 | 18.7238–27.5249 |
| validation/nullable-failure | depth=5 | 100 | 0.0020 | 0.0019–0.0021 |
| validation/nullable-failure | depth=13 | 100 | 0.0020 | 0.0018–0.0021 |
| validation/nullable-failure | depth=33 | 100 | 0.0043 | 0.0040–0.0110 |

## Follow-up supported by this baseline

In this baseline, the six-choice tuple case has 64 alternatives and exhausts the default 1,000,000
work units; with 16,000,000 explicit units it establishes coverage. The larger
budget is a benchmark comparison only, not a change to compiler policy.
Inspect repeated work before increasing limits: the baseline subtype relation
requested equality keys even for different top-level kinds, including a tuple
against its target union. Their keys cannot be equal. The follow-up below removes
that work.

Prepared batch validation avoids repeated schema normalization and field-index
construction. Nested nullable failure measurements retain exact paths at every
tested depth. Neither observation calls for a default-budget change.


## Follow-up: skip equality keys for different kinds

At `a75ac98d`, the subtype fast path compared structural equality keys only when
the two normalized types had the same kind. Normalization, element checks, union coverage
and all default budgets remain in place. This also avoids constructing a whole
tuple key before checking whether its elements fit an array contract.

A deterministic regression checks a 256-element integer tuple against integer,
float and string array contracts with 15,000 work units. The previous implementation
exhausts that budget for the integer-array check; the revised implementation
accepts the numeric contracts and rejects the string contract within the budget.

Repeating the same seven-sample benchmark in the same environment gave the
following medians. Before measurements used the baseline above; after measurements
include only the kind guard. These are separate runs, not a controlled speedup
estimate. At that revision, the six-choice work-limit outcome remained unchanged.

| Choices | Work budget | Outcome (both runs) | Before ms | After ms |
| ---: | ---: | --- | ---: | ---: |
| 2 | 1,000,000 | accepted | 0.0082 | 0.0088 |
| 2 | 16,000,000 | accepted | 0.0081 | 0.0081 |
| 4 | 1,000,000 | accepted | 0.0600 | 0.0583 |
| 4 | 16,000,000 | accepted | 0.0545 | 0.0618 |
| 6 | 1,000,000 | work-limit | 0.1712 | 0.2827 |
| 6 | 16,000,000 | accepted | 0.5915 | 0.6897 |

Further optimization should account for repeated same-kind product comparisons
before reconsidering default limits. These measurements do not establish a need
for larger budgets or additional declaration syntax.


## Follow-up: compare product components directly

Subtype checks now compare normalized product components directly, without first
constructing or comparing whole-product equality keys. Scalars compare their fixed
names; proof references compare exact nominal identities with charged string work.
Normalization still validates every input before the comparison, and exact key
construction remains in the operations that require it, including union deduplication.
Equal union types retain a whole-union equality shortcut to avoid a quadratic
alternative search; a 128-proof union regression checks it within 100,000 work
units. No default budget changed.

The six-choice, 64-alternative tuple now establishes coverage within the default
1,000,000 work units. Regressions use independently allocated leaves, reject a
missing alternative with a concrete witness, and require failure when fewer than
126 split alternatives can be generated. Separate reflexivity checks cover fresh
copies of structural types with a zero split budget.

A seven-sample run of the final implementation on the same Bun/Linux arm64
environment produced the following results. Other validation checks were running
concurrently, so the timing ranges also include possible resource contention.

| Choices | Work budget | Outcome | Median ms | Min–max ms |
| ---: | ---: | --- | ---: | ---: |
| 2 | 1,000,000 | accepted | 0.0061 | 0.0050–0.0088 |
| 2 | 16,000,000 | accepted | 0.0064 | 0.0053–0.0073 |
| 4 | 1,000,000 | accepted | 0.0362 | 0.0332–0.0495 |
| 4 | 16,000,000 | accepted | 0.0334 | 0.0324–0.0356 |
| 6 | 1,000,000 | accepted | 0.3619 | 0.3543–0.6117 |
| 6 | 16,000,000 | accepted | 0.3405 | 0.3396–0.5441 |

The stable improvement is completion under the existing work limit; these separate
microbenchmark runs do not establish an end-to-end speedup. Larger products can
still exhaust work or split budgets, and no general completeness claim follows.
