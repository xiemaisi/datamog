# Design docs

Rationale, not rules. Each doc records *why* a part of Datamog is shaped the way
it is, which alternatives were rejected, and where the sharp edges are. The
normative description of the language is `doc/spec.md`; when the two disagree, the
spec wins and the doc needs updating.

Every doc states its status near the top, since they do not all describe shipped
behaviour: one records a design that was turned down, three are superseded or partly so, two are mostly unbuilt, and
another a model whose structure was never built and one of whose denotations has
since been overtaken.

| Doc | Status | Covers |
|---|---|---|
| [`cli.md`](./cli.md) | implemented | Input predicates as like-named flags, output chosen positionally |
| [`finiteness-checking.md`](./finiteness-checking.md) | implemented | Both halves of keeping recursion finite: the static warning and the runtime iteration cap |
| [`null.md`](./null.md) | superseded by `null-as-a-value.md`; five arguments corrected in place | Why there is a NULL at all, how it propagates, why comparison is total and there is one equality |
| [`parity-stratification.md`](./parity-stratification.md) | implemented | Recursion through an even number of negations, the `^` sigil, the alternating fixed point |
| [`qualified-constructors.md`](./qualified-constructors.md) | implemented | Why a proof-term constructor is scoped to its predicate (`opt::Some`) |
| [`type-lattice.md`](./type-lattice.md) | implemented, annotated for the `null` type | The six types, `value` as the top and `null` as a sibling of the primitives, meet within a rule vs join across rules, head annotations |
| [`imports-as-functors.md`](./imports-as-functors.md) | largely implemented | A file as a function from its input relations to its output relations, wired with `:=` |
| [`typing-and-safety-constraints.md`](./typing-and-safety-constraints.md) | model implemented bar `⟦null⟧`, structure not | Recasting safety checking and type inference as one constraint system over one lattice |
| [`postgres-alignment.md`](./postgres-alignment.md) | example-suite defects fixed; one won't-fix, one untested limitation, and one open divergence that is SQLite's rather than Postgres's | Where the Postgres backend disagrees with the others, and what each fix would take |
| [`functional-sublanguage.md`](./functional-sublanguage.md) | proposal, step 1 (the conditional expression) implemented; boundary decisions settled, datatype half deferred | Recursive functions over `value` and a conditional expression, so a computation can be named over an argument the caller supplies |
| [`value-construction.md`](./value-construction.md) | proposal; ordered aggregate ready, computed keys to be split out | Ordered aggregates and computed object keys for constructing data-dependent `value` shapes |
| [`head-arguments.md`](./head-arguments.md) | implemented | Aggregates inside head expressions, and naming a head position so something else can refer to it |
| [`refinement-annotations.md`](./refinement-annotations.md) | implemented, static discharge included (`--verify`, needs a solver on PATH) | A head position typed by a proposition rather than a primitive type, so the witness is erasable and each rule owes a proof obligation |
| [`nullness-tracking.md`](./nullness-tracking.md) | partly superseded; the bit still runs, coarser than the value model | A nullness bit beside the base type, inferred per column and refined per rule from the guards that imply non-nullness |
| [`imports.md`](./imports.md) | not adopted, not planned | The conventional module system, kept because it is the road not taken |
| [`partial-expressions.md`](./partial-expressions.md) | exploration; recommended against as asked, and superseded by `null-as-a-value.md` | Dropping NULL for CodeQL-style partial expressions, what it would cost the type system and the contract encoding, and which half of it is worth taking |
| [`null-as-a-value.md`](./null-as-a-value.md) | implemented, spec and prose in sync; §15.18, §15.25 to §15.31 and §15.32 record four audits and what each found, the last leaving one item open with a reason; §15.8's two named gaps are annotated closed | Splitting NULL's two jobs: `null` becomes an ordinary value with its own type beside the primitives, and undefinedness becomes partiality. The nullness fixed point survives, as a phase after type inference rather than a component of it (§15.24) |
