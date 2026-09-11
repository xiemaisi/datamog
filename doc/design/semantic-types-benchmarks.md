# Semantic type benchmark baseline

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

The six-choice tuple case has 64 alternatives and exhausts the default 1,000,000
work units; with 16,000,000 explicit units it establishes coverage. The larger
budget is a benchmark comparison only, not a change to compiler policy.
Inspect repeated work before increasing limits: the subtype relation currently
requests equality keys even for different top-level kinds, including a tuple
against its target union. Their keys cannot be equal.

Prepared batch validation avoids repeated schema normalization and field-index
construction. Nested nullable failure measurements retain exact paths at every
tested depth. Neither observation calls for a default-budget change.
