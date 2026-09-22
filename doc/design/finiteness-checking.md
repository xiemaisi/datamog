# Design notes: finiteness checking

Status: implemented, both halves. This is the home for design decisions about how
Datamog keeps recursion from running forever. It has two independent halves, and
they are meant to grow separately:

1. **Static analysis** (implemented): a conservative warning that flags
   value-producing recursion cycles at edit/compile time. Opt-in on the CLI
   (`--warn-finiteness`); the playground, the embed and the VS Code validator
   run it unconditionally, since there is no flag to type at. The normative rules
   live in the spec (§5.8); the code is `packages/core/src/finiteness.ts`.
2. **Runtime iteration cap** (implemented): a per-stratum cap on the in-memory
   interpreters that turns a non-terminating fixpoint into a bounded, reported
   result instead of a hang.

This doc covers *why*, and records the alternatives we rejected. For *what* the
static check reports, read the spec.

## Background: two sources of infinity

Pure Datalog terminates because every derivable fact is drawn from the finite
active domain of the input. Datamog leaves that guarantee behind in two distinct
ways, and the distinction drives every design choice here:

- **Structural term invention.** ADT/proof-term constructors, JSON object/array
  literals, and `parse_json` build new compound values whose *depth* can grow
  each iteration (transitive closure that nests a sub-proof, a rule that
  re-wraps an extracted value one level deeper). This is the local analogue of
  fresh-value creation in the chase / existential rules.
- **Scalar arithmetic invention.** `Y = X + 1` can keep producing new integers
  until safe-integer overflow withholds the next tuple. This domain is finite
  but too large to make exhaustive iteration practical; string concatenation
  can grow without a language-level bound.

The static check folds both into one "a value was manufactured" signal, which is
fine for a warning. Telling them apart only matters if we ever want to stop
warning on genuinely-bounded programs or escalate some to hard errors; neither
is built yet.

Two facts bound the whole space and are worth stating up front:

- **Boundedness is undecidable** even for arithmetic-free Datalog (Gaifman,
  Mairson, Sagiv, Vardi, JACM 1993). Any static finiteness check is therefore
  sound but incomplete: it can only accept a decidable subclass and must be
  conservative about the rest.
- **The exact terminating class is only semi-decidable** (Calimeri et al. 2008),
  so a runtime backstop is a necessary complement to the static check, not a
  substitute we could replace with a better analysis.

## Part 1: the static analysis (why it is only a warning)

`findInfiniteRisks` builds one program-wide dataflow graph over `(predicate,
column)` and per-rule variable nodes, tags an edge PLUS when a value is
manufactured (arithmetic, string concat, a function call, a non-literal range
bound, a JSON/array/object literal, a nesting constructor), runs Tarjan's SCC,
and flags every column in any SCC that carries both a cycle and a PLUS edge.

The one deliberate limitation: **it reads no guards.** Comparisons, filters, and
non-binding equalities contribute no edges, so `s(Y) :- s(X), Y = X + 1, Y < 10`
(terminates) flags exactly like the unbounded version. Reading a numeric guard
like `Y < 10` would require a ranking-function / linear-constraint analysis
(Calautti, Greco, Molinaro, Trubitsyna 2014-2016), which is the only technique
family that can. We judged that too heavy for the value it adds, so the check
stays conservative and is therefore **only ever a warning**. Programs are always
translated and executed.

This puts Datamog in the same design corner as LogicBlox ("recursion through
constructors/arithmetic is not guaranteed to terminate ... warns if termination
cannot be guaranteed") and DES (which warns on possible non-groundness). The one
thing a warning cannot do is stop a hang once the user runs anyway. That is
Part 2.

## Part 2: the runtime iteration cap

### Problem

The naive and seminaive interpreters run a bare fixpoint loop
(`native/src/evaluator.ts`, `seminaive/src/evaluator.ts`) with no stopping
condition other than reaching the least fixed point. The CLI can be Ctrl-C'd and
the full playground runs in a Web Worker that can be killed, but the **embed
mini-playground evaluates on the browser main thread** (`embed/engine.ts`), so a
non-terminating tutorial snippet freezes the tab.

### Design

An optional per-stratum cap on fixpoint iterations, held on the shared
`BaseDatalogEvaluator`:

- `maxIterations?: number` on the evaluator (via its constructor options).
  `undefined` means unlimited, which is the pre-existing behaviour.
- When a stratum's fixpoint loop reaches the cap without converging, the
  evaluator records an `IterationCapInfo { stratum, iteration, predicates }` on
  `capInfo` and `break`s out of the loop, rather than looping forever.
- The backend factory (`createEvaluatorBackend`) reads `capInfo` after
  `computeAll()` and, if set, calls an optional `onIterationCap(info)` callback.
  The partial results are still returned.

The cap lives entirely in the two interpreters and their `create()` options. The
`Backend` interface, `QueryResult`, `DatamogExecutor`, and the SQL backends are
untouched: the SQL path runs recursion inside the database and has its own
engine limits; a row/time budget there is separate future work.

### Why partial results, not an exception

The interpreters accumulate monotonically, so a capped relation holds a sound
*prefix* of the least fixed point. Returning that prefix plus a "stopped, did not
converge" banner is more useful in a teaching tool than a thrown error that
discards everything: the student sees the relation still growing and reads why it
stopped. This matches egg's `StopReason` and XSB's marked answers, and it fixes
the one flaw in Logica's otherwise-identical iteration cap, which truncates
silently. Throwing was the rejected alternative: simpler, but it turns a
teachable moment into a stack trace.

### Semantics and caveats

- A capped relation is an **under-approximation** (a prefix) of the least fixed
  point. Positive/monotone queries over it return a subset of the true answer:
  sound as incomplete.
- **Negation or aggregation over a capped predicate can be unsound**, not merely
  incomplete: stratified negation assumes its input is fully computed, so
  `not p(...)` over an under-approximated `p` over-approximates, and an aggregate
  over a capped stratum is simply wrong. The "results are incomplete" banner is
  all the warning we give; we do not try to detect this precisely.
- The cap bounds **loop count, not per-iteration work**. A rule that doubles a
  term's size each step can still blow memory within a few dozen iterations. If
  that ever bites, a companion "max total derived tuples" cap is a natural
  follow-up on the same plumbing; not built until a real program needs it.
- The cap is **per stratum**, matching the loop structure and the trace model
  (iterations reset per stratum). A program with many strata each just under the
  cap can still run long; revisit only if it matters.

### Iteration counting across the two backends

Both backends count a full pass as one iteration and cap the total number of
passes per stratum at `maxIterations` (for the seminaive backend the priming
pass counts as pass one). The reported `iteration` is the number of passes run
before stopping. The exact count is a teaching aid, not a contract; the point is
"stopped without converging," not a precise pass number.

### Defaults per entry point

- **Embed:** cap ON by default (`1000`). Tutorial programs converge in far fewer
  passes, so a four-digit cap never trips a legitimate example while still
  stopping a runaway in milliseconds.
- **Playground:** cap ON by default, controllable from the toolbar (a number
  input plus an "unlimited" toggle that sends `undefined`). On cap the worker
  posts a warning the UI shows as a banner.
- **CLI:** default unlimited (preserve batch behaviour; Ctrl-C is available),
  with an opt-in `--max-iterations N` flag that prints the stop reason to stderr.

### Interaction with the static warning

The two halves reinforce each other and name the same predicate: the static
warning fires at edit time ("column 1 of `s` may grow without bound"), the
runtime cap fires at run time ("`s` was still producing rows, stopped at 1000").
Consistent phrasing across the two is deliberate.
