# Design docs

Rationale, not rules. Each doc records *why* a part of Datamog is shaped the way
it is, which alternatives were rejected, and where the sharp edges are. The
normative description of the language is `doc/spec.md`; when the two disagree, the
spec wins and the doc needs updating.

Every doc states its status near the top, since they do not all describe shipped
behaviour: one records a design that was turned down, and another a model that is
implemented without the structure it proposes.

| Doc | Status | Covers |
|---|---|---|
| [`cli.md`](./cli.md) | implemented | Input predicates as like-named flags, output chosen positionally |
| [`finiteness-checking.md`](./finiteness-checking.md) | implemented | Both halves of keeping recursion finite: the static warning and the runtime iteration cap |
| [`null.md`](./null.md) | implemented | Why there is a NULL at all, how it propagates, why comparison is total and there is one equality |
| [`parity-stratification.md`](./parity-stratification.md) | implemented | Recursion through an even number of negations, the `^` sigil, the alternating fixed point |
| [`qualified-constructors.md`](./qualified-constructors.md) | implemented | Why a proof-term constructor is scoped to its predicate (`opt::Some`) |
| [`type-lattice.md`](./type-lattice.md) | implemented | The five types, `value` as top, meet within a rule vs join across rules, head annotations |
| [`imports-as-functors.md`](./imports-as-functors.md) | largely implemented | A file as a function from its input relations to its output relations, wired with `:=` |
| [`typing-and-safety-constraints.md`](./typing-and-safety-constraints.md) | model implemented, structure not | Recasting safety checking and type inference as one constraint system over one lattice |
| [`postgres-alignment.md`](./postgres-alignment.md) | one open cause, one won't-fix | Where the Postgres backend disagrees with the others, and what each fix would take |
| [`functional-sublanguage.md`](./functional-sublanguage.md) | proposal, nothing implemented; datatype half deferred | Recursive functions over `value` and a conditional expression, so a computation can be named over an argument the caller supplies |
| [`value-construction.md`](./value-construction.md) | proposal, nothing implemented | Two small gaps that make `value` read-mostly: literal-only object keys, and `list` ordering by its own argument |
| [`imports.md`](./imports.md) | not adopted, not planned | The conventional module system, kept because it is the road not taken |
