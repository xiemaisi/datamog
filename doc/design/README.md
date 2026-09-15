# Design docs

Rationale, not rules. Each doc records *why* a part of Datamog is shaped the way
it is, which alternatives were rejected, and where the sharp edges are. The
normative description of the language is `doc/spec.md`; when the two disagree, the
spec describes the intended contract; implementation discrepancies must be marked
as limitations, not silently described as completed features. Historical proposals
may retain their original argument when their status clearly identifies it.

The status column distinguishes implemented behavior, historical designs, and
future proposals. **Implemented** means the stated delivery scope shipped, not
that every possible extension or precision improvement is complete. Deferred
features and known limitations are called out separately. Historical audit counts
and branch names describe their original checkpoints, not current `main`.

Older primitive-type designs describe that layer's rationale;
[semantic types](semantic-types.md) describes the additional structural and
nominal analysis now used alongside it.

| Doc | Status | Covers |
|---|---|---|
| [`cli.md`](./cli.md) | implemented | Input predicates as like-named flags, output chosen positionally |
| [`finiteness-checking.md`](./finiteness-checking.md) | implemented | Both halves of keeping recursion finite: the static warning and the runtime iteration cap |
| [`null.md`](./null.md) | superseded by `null-as-a-value.md`; five arguments corrected in place | Why there is a NULL at all, how it propagates, why comparison is total and there is one equality |
| [`parity-stratification.md`](./parity-stratification.md) | implemented | Recursion through an even number of negations, the `^` sigil, the alternating fixed point |
| [`qualified-constructors.md`](./qualified-constructors.md) | implemented | Why a proof-term constructor is scoped to its predicate (`opt::Some`) |
| [`semantic-types.md`](./semantic-types.md) | implemented scope; bounded inference and null-only forwarding limitation remain | Structural and nominal contracts, aliases, typed operands, diagnostics, and REPL proof context |
| [`body-type-guards.md`](./body-type-guards.md) | unimplemented proposal; syntax and nominal membership open | Runtime type guards versus static assertions, ambiguity with proof captures, and compatibility alternatives |
| [`proof-signature-contracts.md`](./proof-signature-contracts.md) | implemented | Inline constructor contracts, bare nominal type names, module identity, and external-input restrictions |
| [`semantic-types-benchmarks.md`](./semantic-types-benchmarks.md) | measured baseline | Reproducible inference, subtype, and loading workloads; compiler work limits |
| [`type-lattice.md`](./type-lattice.md) | implemented primitive layer; extended by null and semantic types | The six types, `value` as the top and `null` as a sibling of the primitives, meet within a rule vs join across rules, head annotations |
| [`imports-as-functors.md`](./imports-as-functors.md) | core implemented; REPL/playground module bindings and other extensions deferred | A file as a function from its input relations to its output relations, wired with `:=` |
| [`typing-and-safety-constraints.md`](./typing-and-safety-constraints.md) | historical primitive model; unified solver unimplemented; null semantics superseded | Recasting safety checking and type inference as one constraint system over one lattice |
| [`postgres-alignment.md`](./postgres-alignment.md) | example-suite defects fixed; inherent float/overflow differences and open SQLite JSON float precision divergence | Where the Postgres backend disagrees with the others, and what each fix would take |
| [`functional-sublanguage.md`](./functional-sublanguage.md) | proposal, step 1 (the conditional expression) implemented; boundary decisions settled, datatype half deferred | Recursive functions over `value` and a conditional expression, so a computation can be named over an argument the caller supplies |
| [`value-construction.md`](./value-construction.md) | unimplemented proposal; ordered aggregate specified, computed keys need a separate design | Ordered aggregates and computed object keys for constructing data-dependent `value` shapes |
| [`head-arguments.md`](./head-arguments.md) | implemented; unused-name warning remains an optional question | Aggregates inside head expressions, and naming a head position so something else can refer to it |
| [`refinement-annotations.md`](./refinement-annotations.md) | runtime checks and integer-fragment discharge implemented; ranges/aggregates and tier 2 incomplete | A head position typed by a proposition rather than a primitive type, so the witness is erasable and each rule owes a proof obligation |
| [`nullness-tracking.md`](./nullness-tracking.md) | partly superseded; the bit still runs, coarser than the value model | A nullness bit beside the base type, inferred per column and refined per rule from the guards that imply non-nullness |
| [`imports.md`](./imports.md) | not adopted, not planned | The conventional module system, kept because it is the road not taken |
| [`partial-expressions.md`](./partial-expressions.md) | superseded exploration; alternative partiality design implemented | Dropping NULL for CodeQL-style partial expressions, what it would cost the type system and the contract encoding, and which half of it is worth taking |
| [`null-as-a-value.md`](./null-as-a-value.md) | core implemented; chronological audits retain known inference limits and conservative checks | Splitting NULL's two jobs: `null` becomes an ordinary value with its own type beside the primitives, and undefinedness becomes partiality. The nullness fixed point survives, as a phase after type inference rather than a component of it (§15.24) |
