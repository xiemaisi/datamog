# Design notes: parity-stratified recursion

Status: implemented. This doc covers recursion through universal quantification
("all children are constant", "all premises are derived"), which stratified
negation used to reject, and records why the design is what it is. The
normative rules are in the spec (§1.7, §2.3, §4.3, §4.4, §6.1); the tutorial is
walkthrough chapter 17.

The feature is one postfix sigil, `p^`, plus an alternating fixed-point driver
in the in-memory evaluators. Nothing about the SQL backends changed except a
new rejection message.

Where the code lives: the sigil in `parser/src/datamog.langium` (optional flags on heads, literals, and input declarations), the polarity and spelling checks plus `maximalPredicates` in
`core/src/analyzer.ts`, the inert-sigil warning in `core/src/polarity.ts`, the
driver in `backend/native/src/base-evaluator.ts` (`runParityStratum`, shared by
both evaluators, which supply only `runFixpoint`), the ⊤ marker in
`backend/native/src/planner.ts` (`Relation.isTop`), and the SQL rejection in
`engine/src/translator.ts`. Examples: `constant-expressions`, `proplog-forall`,
`purity`, `nim`.

## 1 The problem

Universal quantification over a recursive predicate is a normal thing to want:

- An expression is constant if it is a literal, or it is composite and *every*
  child is constant.
- A clause's head is derived if *every* premise is derived (`examples/proplog`).
- A function is pure if it writes nothing and *every* callee is pure.

Datalog has no `forall`, so the standard encoding is double negation: introduce
a helper for the counterexample and negate it.

```prolog
constant(E) :- literal(E).
constant(E) :- composite(E), not has_nonconstant_child(E).
has_nonconstant_child(E) :- child(E, C), not constant(C).
```

Today this is rejected:

```
Negation of 'has_nonconstant_child' in rules for 'constant' is not
stratifiable (they are mutually recursive). Recursion through negation needs
the two sides to have opposite polarity: mark exactly one of them maximal
with '^'
```

The rejection is correct under the current rules and wrong in spirit. The two
negations cancel: `constant` depends on itself through exactly two `not`s, so
the operator it defines is monotone and has a least fixed point. Only the
*intermediate* predicate is anti-monotone.

`examples/proplog` documents the workaround at length: replace the `forall` with
a positional prefix counter (`body_derived(Clause, N)` means "the first N
premises hold") so the recursion becomes positive. It works, it is three rules
where one would do, and it only works because the premises happen to sit in an
array that can be walked by index.

## 2 Why CodeQL's check does not port

CodeQL accepts the same pattern. Its predicate bodies are arbitrary first-order
formulas, so the whole double negation fits inside one predicate:

```ql
predicate constant(Expr e) {
  e instanceof Literal
  or
  e instanceof Composite and forall(Expr c | child(e, c) | constant(c))
}
```

`forall` desugars to `not exists(c | child(e, c) and not constant(c))`. The
compiler walks the formula tree, counts the negations enclosing each recursive
occurrence, and requires every recursive occurrence to sit under an even number
of them. The check is local to one predicate body, and the helper never exists
as a named predicate, so it never needs a polarity of its own.

Horn clauses have no formula tree. The helper must be named, and once it is
named it is a predicate in the dependency graph that is genuinely anti-monotone
in `constant`. There is no body-local parity to count.

The graph-level version of the check is a 2-colouring: give every predicate in
an SCC a bit, require positive edges to preserve it and negated edges to flip
it. That is decidable (union-find over the SCC), and consistency is exactly the
condition "every cycle crosses an even number of negations". But it does not
determine the answer, which is the subject of §4.

## 3 The proposal

A predicate name may carry a postfix `^`:

```prolog
constant(E) :- literal(E).
constant(E) :- composite(E), not has_nonconstant_child^(E).

has_nonconstant_child^(E) :- child(E, C), not constant(C).
```

A predicate is **maximal** if its name carries the sigil, and **minimal**
otherwise. Minimal is the default, so every existing program keeps its meaning.

The sigil is written at **every** occurrence: rule heads, body literals
(positive and negated), and queries. It is not part of the predicate's
identity. The parser records it as a flag and the analyser keys the predicate
under its bare name, so `has_nonconstant_child` is one predicate, spelled
`has_nonconstant_child^` everywhere it appears. Two consequences:

- Everything downstream keeps using the bare name: module renaming, qualified
  constructors (`p::Ctor`), output labels, REPL protocol keys. Nothing has to
  learn about the sigil.
- "Both `p` and `p^`" cannot arise, so it needs no rule of its own. What
  replaces it is an agreement check: every occurrence of a predicate must spell
  the sigil the same way, and a mismatch is an error naming the declaration
  ("`bad` is maximal, write `bad^` here"), which is a better diagnostic than
  the "unknown predicate" you would get if the sigil were part of the name.

Requiring it at every occurrence is the point of choosing a sigil over a
declaration-site marker. Reading

```prolog
constant(E) :- composite(E), not has_nonconstant_child^(E).
```

you can tell locally that the negation is legal inside a cycle. With a
declaration-site marker you would have to go find the callee's rules. The whole
feature exists to make one specific negation legal, so the call site is where
the reader needs to see it.

The stratification check is replaced by a polarity check. For every rule of `p`
and every body literal on `q` where `p` and `q` are in the same SCC:

| body literal | requirement |
| --- | --- |
| positive `q(...)` | `p` and `q` must have the **same** polarity |
| negated `not q(...)` | `p` and `q` must have **different** polarities |

Everything outside an SCC is unaffected: negation across strata stays legal and
unrestricted, positive use of a maximal predicate from a later stratum is fine
(by then it is an ordinary finite relation).

Three consequences worth stating explicitly:

- With no annotations anywhere, the second row can never be satisfied, so the
  check degenerates to today's "no negation inside an SCC". Fully backward
  compatible.
- `p :- not p` is still rejected: a predicate cannot differ in polarity from
  itself. Odd cycles stay out, which is right, since they have no
  two-valued fixed point in general.
- The local rules imply the global parity condition. Following a cycle flips
  colour exactly at the negated edges, and returning to the start requires an
  even number of flips. So the annotation implies even parity, and additionally
  pins down *which* colour class starts full.

## 4 Semantics

Write `U` for the tuples of the SCC's minimal predicates and `V` for the tuples
of its maximal predicates. The polarity check guarantees the shape of the rules:
minimal predicates depend positively on minimal and negatively on maximal;
maximal predicates depend positively on maximal and negatively on minimal.
So the two one-step consequence operators are

- `F(U, V)`: monotone in `U`, anti-monotone in `V`
- `G(U, V)`: anti-monotone in `U`, monotone in `V`

The stratum is evaluated by an alternating fixed point:

```
V₀ = ⊤                          every maximal predicate holds of everything
U₁ = lfp of F(·, V₀)            minimal side, maximal side frozen
V₁ = lfp of G(U₁, ·)            maximal side, minimal side frozen
U₂ = lfp of F(·, V₁)
V₂ = lfp of G(U₂, ·)
...
```

`Uᵢ` increases and `Vᵢ` decreases, both by anti-monotonicity of the other side,
so on finite data the sequence converges. Stop when `Vᵢ = Vᵢ₋₁`; at that point
`U` is already at its fixed point for that `V`. The limit satisfies
`U = lfp F(·, V)` and `V = lfp G(U, ·)` simultaneously, which is a stable model
of the SCC's rules.

This is Van Gelder's alternating fixed point restricted to two colour classes.
On programs where the well-founded model is total (all the motivating examples,
because their data is a DAG) it computes exactly that model.

### 4.1 ⊤ is never materialised

`V₀ = ⊤` is notional. The polarity check guarantees the minimal side reads
maximal predicates only under `not`, so "the maximal predicate holds of
everything" is implemented as "every negated read of it fails". Nothing
enumerates ⊤, which matters because Datamog has no finite domain per column: ⊤
for a predicate over `integer` is infinite.

That constraint is what rules out the more ambitious reading of `maximal`
discussed in §6.2.

The precise invariant is: **⊤ is only ever observed by a negated atom.** Every
way a *positive* atom could reach a maximal predicate reads a finite relation.

| positive read of `p^` from | what it reads |
| --- | --- |
| a minimal predicate in the same SCC | rejected by the polarity check |
| a maximal predicate in the same SCC | the max phase's in-progress lfp, seeded from ∅ |
| a later stratum, or a query | the converged relation |
| an earlier stratum | impossible, strata run in dependency order |

So safety needs no new rule. The existing "a variable is bound if it occurs in a
positive body atom" stays sound, because every positive body atom still reads a
finite relation at the moment it is enumerated. Phase 2 encodes the invariant
directly: the positive `atom` step throws if it meets an `isTop` relation, so a
mistake here is an internal error rather than silent nonsense.

This is the observable difference between this design and §6.2. Under a true
downward iteration, a positive read of a maximal predicate really would have to
enumerate ⊤, and safety would need either a new rule or finite domain types.
Under the alternating fixed point it does not.

### 4.1.1 `p^(X) :- p^(X).`

Worth walking through, because the intuition that it should be unsafe is right
about §6.2 and wrong about this design.

Its minimal twin `p(X) :- p(X).` is already accepted by the safety check today
(`X` occurs in a positive body atom) and rejected one stage later by type
inference, which cannot infer a type for the column. Given a type from a
sibling rule it evaluates to ∅, per the recursive-only-predicate invariant.

`p^` behaves identically. Its SCC holds no minimal predicate, so the sigil is
inert (§11): it warns, and the stratum runs the ordinary fixed-point driver.

The version that does form a parity cycle is no different:

```prolog
q(X)    :- node(X), not bad^(X).
bad^(X) :- bad^(X), not q(X).
```

Round 1 has `bad` at ⊤, so `q` is empty. The max phase then rebuilds `bad` from
∅, and its only rule needs a `bad` tuple to produce one, so it derives nothing.
Round 2 gives `q` every node and `bad` stays empty, and round 3 converges.
`bad = ∅`, `q = node`, which is the stable model, and the same answer the
recursive-only-predicate invariant gives inside each round.

### 4.2 Positive recursion inside the maximal class stays a least fixed point

A maximal predicate may recurse positively into other maximal predicates of the
same SCC:

```prolog
bad^(E) :- child(E, C), not constant(C).
bad^(E) :- child(E, C), bad^(C).
```

Each round computes `V` as the *least* fixed point of the maximal rules given
the current `U`, so `bad` means "has a non-constant descendant reachable in
finitely many steps", the reading a Datalog programmer expects. `maximal` does
not turn a predicate into a greatest fixed point; it only sets the value the
*other* side sees in round 0. See §6.2, and §10.5 for a two-line program where
the two readings give different answers.

### 4.3 Termination and cost

Rounds are bounded by `|V₁| + 2`, since `V` strictly shrinks until it stops.
Each round re-runs both halves to a fixed point, so a chain of depth `d` costs
about `d` rounds: one round of the constant-expression example promotes one
level of the AST. The existing `maxIterations` cap applies to the total number
of passes in the stratum, not per round.

Stopping early is sound in a useful direction: `U` is always an under-estimate
of the final minimal relations and `V` always an over-estimate of the maximal
ones.

## 5 Why the polarity is declared and not inferred

The 2-colouring of §2 is consistent under *both* assignments: swapping which
class is maximal satisfies the same constraints. The two choices generally give
different answers, and both are stable models, so the compiler has no grounds
to pick. A purity analysis makes this concrete.

```prolog
# f and g call each other and write nothing; h calls a writer.
pure(F)          :- func(F), not writes(F), not calls_impure^(F).
calls_impure^(F) :- calls(F, G), not pure(G).
```

With `calls_impure` maximal (the conservative reading), the alternating fixed
point runs:

```
round 1: pure=[]        calls_impure=[f, g, h]
round 2: pure=[leaf]    calls_impure=[f, g, h]
```

`f` and `g` are never pure: purity has to be established by a finite
derivation, and a call cycle offers none.

Move the sigil to the other side (the optimistic reading):

```prolog
pure^(F)        :- func(F), not writes(F), not calls_impure(F).
calls_impure(F) :- calls(F, G), not pure^(G).
```

```
round 1: pure=[f, g, h, leaf]  calls_impure=[]
round 2: pure=[f, g, leaf]     calls_impure=[h]
```

`f` and `g` are pure unless something proves otherwise, which is what a real
purity analysis wants.

Same rules up to where the sigil sits, same even parity, two defensible
analyses. The sigil is how the author says which one they mean. That is the
argument for declaring the polarity rather than inferring it, and it is also
the answer to "is there a greatest-fixed-point connection here?": yes, but it
shows up as the *choice of which side starts full*, not as a gfp anywhere in
the evaluation.

## 6 Rejected alternatives

### 6.1 Infer the colouring by 2-colouring the SCC

Rejected per §5: consistent colourings come in pairs and the pair members
disagree. Inference would silently pick one.

### 6.2 The sigil means "greatest fixed point"

The reading the phrase "start at top and iterate downwards" most directly
suggests: iterate the pair `(F, G)` on the product lattice `2^U × (2^V)ᵒᵖ` from
`(∅, ⊤)`. This is monotone and Knaster-Tarski applies, so it is well defined,
and it is strictly more expressive: positive recursion inside the maximal class
would become genuine coinduction (`on_infinite_path(N) :- succ(N, M),
on_infinite_path(M)`).

It needs ⊤ materialised. Shrinking from ⊤ means starting with every tuple of
the predicate's column types, which is infinite unless the language grows finite
domain types or an active-domain approximation. Both are large, separate
features with their own pitfalls. Deferred; §4.2 keeps the door open, because a
future coinduction marker would be a different marker with a different rule,
not a reinterpretation of this one. §10.5 works the difference through on the
smallest program that shows it.

### 6.3 Full well-founded semantics

The alternating fixed point generalises past parity stratification: run it over
the whole SCC with no colouring and you get the three-valued well-founded model,
which handles odd cycles (`win(P) :- move(P, Q), not win(Q)`) correctly, giving
"undefined" for draws.

That is a much bigger change: every relation grows a third truth value, and
every consumer (query results, constraints, output printing, the trace UI, the
loaders' type coercion) has to render and propagate it. Parity stratification
keeps every relation two-valued. Worth revisiting as its own feature; not a
prerequisite.

A single self-negating predicate can be hand-encoded meanwhile, by naming its
two bounds as separate predicates and reading the gap between them as
"undefined" (§10.6). That is a technique available to an author, not a language
feature: nothing generalises it across a program.

### 6.4 A `maximal predicate` rule marker

The first shape considered, matching the existing `output predicate` /
`error predicate` markers:

```prolog
maximal predicate has_nonconstant_child(E) :- child(E, C), not constant(C).
```

Rejected for three reasons.

1. It puts the polarity only at the definition, so a reader of the call site
   cannot tell why `not has_nonconstant_child(E)` is legal inside a cycle (§3).
2. `maximal` is already a predicate name in this repo, in a different sense:
   `examples/modular-order/order.dl` and `doc/walkthrough/code/ch16/order.dl`
   both define `output predicate maximal(X)` next to a `minimal(X)`, meaning
   maximal *elements of an order*. Contextual keywords make it parse, but two
   meanings of one word in a teaching language is a poor trade.
3. It needs grammar work. The marker slot is currently a single alternation, so
   combining `maximal` with `output` requires splitting the rule prefix into
   two LL(1)-distinguishable branches. The sigil composes for free:
   `output predicate top^(X) :- ...` parses with no changes to the prefix.

Other shapes considered: `antitone predicate` (accurate, avoids the collision,
still definition-site only), an attribute syntax (`@maximal`), a separate
declaration (`maximal p/1.`), and `coinductive predicate` (actively wrong under
§4.2).

### 6.5 Other sigils

`^` is the bitwise XOR operator, so it is not collision-free. Verified against
the real grammar (§9, phase 1): the one shape whose meaning changes is a bare
`A ^ (B)` as a complete body element, which today is always a type error, since
a body filter must be boolean and XOR yields an integer. So no working program
changes meaning.

`~` is unused by the grammar, as are `@`, `;`, `$` and `'`, so it would be
collision-free. Rejected because `~` reads as negation in most languages, and
the sigil is not a negation: `not bad^(E)` would then look like it negates
twice. `^` reads as "up", which is what it means.

`'` (prime) is also unused, but is easy to miss at a glance and collides with
the apostrophe in comments and strings when grepping.

## 7 Backends

The in-memory evaluators (`native`, `seminaive`) can run this. The SQL backends
cannot: `WITH RECURSIVE` computes one least fixed point of a monotone body, and
an alternating fixed point needs an outer loop that re-materialises a relation
and *deletes* from it between rounds. Nothing in the current SQL pipeline
(create views once, then query) can express that.

So parity-stratified SCCs join non-linear recursion as an interpreter-only
feature: the translator rejects them by dialect, examples that use them carry
the `native-only` marker, and the playground's default `native` backend runs
them without a backend switch.

A SQL implementation is possible but is a different execution model: temp tables
instead of views, with the alternation loop driven from TypeScript in
`executor.ts` issuing `DELETE` plus `INSERT ... SELECT` per round. Out of scope
here; if it is ever wanted, it should be designed alongside incremental
maintenance, not bolted onto the view pipeline.

## 8 Interactions

**Aggregates.** Unchanged: aggregates stay banned inside recursion. An
aggregate is neither monotone nor anti-monotone in its input, so no polarity
assignment makes it fit. Monotonic aggregates are a separate feature.

**Proof terms.** Orthogonal. A maximal predicate can carry a proof term, though
it is only observable through a positive read (from another maximal rule in the
SCC, or from a later stratum), since negated atoms contribute no sub-proofs
already.

**Modules.** The flag lives on `HeadAtom`, `Literal`, and
`ExtDecl` nodes. `expandModule` rewrites predicates in place when it freshens
names, so their polarity survives expansion. A maximal module input or a
receiving binding spells its contract as `input predicate p^(...)`; actuals and
export selectors still use the bare predicate name because `^` is not part of
identity.

There was an important implementation limitation here: `aliasRule` originally
synthesised its `HeadAtom` and `Literal` without the `maximal` field.
Selecting a named maximal output therefore failed on an internal name the user
could neither see nor repair:

```
'got$0$sink' is a maximal predicate; write 'got$0$sink^' here
```

The module elaborator now preserves the selected output's flag on the alias body
and the receiving declaration's flag on its head. Its boundary contract requires
those polarities to agree, just as it checks column types and nullness. The same
check requires an actual wired to a maximal module input to be maximal. Thus a
named maximal output is imported explicitly:

```prolog
input predicate got^(x: integer) := sink from "inner.dl"(node = n).
?- got^(X).
```

An alternating SCC may close through that binding: the alias is maximal on both
ends, so ordinary polarity analysis sees the same graph it would have seen
before the files were split. The unnamed `?-` default remains minimal; it may,
of course, contain correctly sigilled calls to maximal predicates.

**Finiteness analysis.** No change needed. `finiteness.ts` only follows positive
atoms, and a parity SCC's cross-class edges are negated, so they contribute no
value-flow edges. A parity SCC whose classes have no internal positive recursion
produces no cycle in the value-flow graph and no warning, which is correct.

**REPL.** The native REPL path re-evaluates the whole accumulated program per
chunk, so a parity SCC is recomputed from scratch each time. Nothing to do.

**Trace / playground step view.** Done. An append-only trace could not express
clearing the maximal relations between rounds, so `trace.ts` gained
`round-start` / `round-end` / `relation-cleared`, and `trace-state.ts` treats
`round-end` as a stop at every granularity, drops cleared relations during
replay, and labels rounds and clears in its captions.

## 9 Implementation plan

Phased so each phase is separately testable and committable.

### Phase 0: refactor, no behaviour change

- `packages/backend/native/src/planner.ts`: add `isTop?: boolean` to `Relation`
  and a `clearRelation` helper.
- `packages/backend/native/src/evaluator.ts` and
  `packages/backend/seminaive/src/evaluator.ts`: split `evaluateStratum` into
  the trace-emitting wrapper and a `runFixpoint(stratum, stratumIdx, opts)` core
  that treats every predicate outside `predicates` as frozen. Both already key
  their delta positions off stratum membership, so this is a parameter rename
  plus moving the `stratum-start` / `stratum-end` emission out.
- Move `computeAll` up into `BaseDatalogEvaluator` with `runFixpoint` abstract.
- Tests: existing suites must pass untouched.

### Phase 1: front end

- `packages/parser/src/datamog.langium`: three lines, one optional assignment
  after the predicate name in `HeadAtom` and in both `Literal` alternatives:

  ```
  HeadAtom:
      predicate=Identifier (maximal?='^')? '(' ... ')';

  Literal:
      proofVar=Identifier ':' (negated?='not')? predicate=Identifier (maximal?='^')?
          (parens?='(' ... ')')?
    | (negated?='not')? predicate=Identifier (maximal?='^')? parens?='(' ... ')';
  ```

  No lexer change (`^` is already a token), no new keyword, nothing to add to
  the `Identifier` alternation. Regenerate with `bunx langium generate`.

  **Already verified against the real grammar.** Applying exactly this diff and
  regenerating produces no new Chevrotain ambiguity warnings (only the three
  pre-existing "declared but never referenced" notes for `AggregateCall`,
  `Subscript`, `Slice`), and the full suite stays green at 1618 pass / 0 fail.
  Confirmed parsing: `p^(X)` heads, `not p^(X)` bodies, `output predicate
  top^(X)`, the proof-capture shorthand `V : p^`, and `?- ... not p^(E)`.
  XOR survives everywhere it is currently legal, `R = A ^ (3)` for instance; Chevrotain looks past the closing paren to pick `Filter`. The
  one shape that changes meaning is a bare `A ^ (3)` as a complete body element,
  which now parses as a literal on `A^` instead of failing the boolean-filter
  type check (§6.5).
- `packages/core/src/keywords.ts` and
  `packages/vscode-extension/syntaxes/datamog.tmLanguage.json`: no keyword to
  add, but the TextMate grammar should highlight a trailing `^` on a predicate
  name distinctly from XOR, and `keywords.ts` feeds the playground highlighter
  the same way.
- `packages/core/src/analyzer.ts`: collect `maximalPredicates: Set<string>` onto
  `AnalyzedProgram`, checking that every occurrence of a predicate agrees on the
  sigil (§3). Replace the stratification loop with the polarity check of §3,
  keeping the `NegationCycle` payload on both new error shapes so the
  playground's "Show cycle" keeps working. Reject the sigil on an
  `error predicate` head. An `input predicate` now accepts the sigil too: check consistency with
  its occurrences and check actual/receiving polarity at module boundaries (§8).
- Error text: the same-polarity negation error should point at the fix, e.g.
  "... are mutually recursive. If this is recursion through a universal
  quantification, mark one of them with `^`."
- `packages/core/src/`: `findInertPolarity(analyzed)` plus its three call sites
  in the CLI and playground, mirroring `findInfiniteRisks` (§11).
- Tests: `packages/core/test/` accept/reject matrix, including `p :- not p`,
  a three-predicate odd cycle, and the module-boundary case of §8. Add one for
  type inference across a parity SCC (a mutually recursive pair whose only
  cross-edges are negated). Inference already iterates to a fixed point over
  mutual recursion and checks negated atoms for compatibility, so it should
  need no change, but nothing exercises that combination today.

### Phase 2: evaluators

- `BaseDatalogEvaluator.computeAll`: route a stratum holding **both** polarities
  (not merely one containing a maximal predicate, see §11) to a new
  `runParityStratum`, shared by both evaluators:

  ```
  mark every maximal relation isTop
  repeat
    runFixpoint(minimal)            # keeps its tuples, only grows
    clear every maximal relation    # also clears isTop
    runFixpoint(maximal)            # rebuilt from empty
  until the maximal relations stop changing
  ```

  Keeping the minimal relations across rounds is sound: `Uᵢ ⊆ Uᵢ₊₁`, and a tuple
  derivable under `Vᵢ₋₁` is still derivable under the smaller `Vᵢ`.
- `planner.ts`: `filterNot` fails when the relation `isTop`; the positive `atom`
  step throws on `isTop` (the polarity check makes that unreachable, so it is an
  internal-error assertion).
- Thread `maxIterations` through as a total pass budget for the stratum, setting
  `capInfo` as today.
- `trace.ts`: add `round-start` / `round-end` and `relation-cleared`.
- Tests: `packages/backend/native/test/` and the seminaive suite must agree
  tuple-for-tuple on every new example, plus a round-count assertion on the
  constant-expression case (three rounds for the AST in §10.1).

### Phase 3: SQL rejection

- `packages/engine/src/translator.ts`: alongside the non-linear-recursion check
  in `translateViews`, reject a stratum holding *both* polarities, naming the
  maximal predicates and pointing at `--backend native` / `seminaive`. An
  all-maximal stratum has nothing to alternate against, so the sigil is inert
  (§7) and it compiles as usual. Anchor the error
  at the first maximal rule's CST node so the playground squiggly lands.
- Tests: one per SQL dialect, mirroring the non-linear-recursion tests.

### Phase 4: examples and docs

- New `packages/cli/examples/constant-expressions/` with the `native-only`
  marker and a `playground.json` (the playground defaults to `native`).
- New `packages/cli/examples/proplog-forall/`: the three-rule version of
  `proplog`. Keep the counter-based `proplog` and cross-reference the two, since
  the contrast is the whole point of its header comment. Update that comment,
  which currently says the double-negation version "does not work".
- Optional third example: the purity analysis of §5, which is the one where the
  polarity choice visibly changes the answer.
- Optional fourth: Nim (§10.6). It earns its place by pairing the two-bound game
  encoding with a determinacy constraint (`!- not_lost^(P), not win(P).`), and
  the repo has no game-solving example yet. The expected output is independently
  checkable against Sprague-Grundy, so it is a real test rather than a
  self-confirming one.
- Spec: rewrite §4.3 (stratification) and extend §4.4 (recursion); the sigil
  also needs a line in §1.7 (operators and punctuation, not §1.6 keywords, since
  it is not a keyword) and §2.3 (rules), plus the formal grammar in §3.
- Walkthrough: a section in `08-negation.md`, or a new chapter after it. The
  purity example belongs here, since "conservative or optimistic" is the
  teachable idea and neither answer is wrong.

### Phase 5: playground

- `trace-state.ts` and `step-panel.tsx`: handle `relation-cleared` and label
  rounds. Without this the step view over-reports maximal relations.

## 10 Worked examples

The traces below are from a prototype of the §4 driver
(`alternate(F, G)` over ground instances), not from Datamog.

### 10.1 Constant expressions

```prolog
input predicate literal(e: string).
input predicate composite(e: string).
input predicate child(parent: string, kid: string).

constant(E) :- literal(E).
constant(E) :- composite(E), not has_nonconstant_child^(E).

has_nonconstant_child^(E) :- child(E, C), not constant(C).

?- constant(E).
```

Data: `add` is `1 + 2`, `mul_x` is `add * x`, `mul_4` is `add * 4`, with `n1`,
`n2`, `n4` literals and `x` a variable (neither literal nor composite, so no
rule can make it constant).

```
round 1: constant=[n1, n2, n4]                 has_nonconstant_child=[mul_4, mul_x]
round 2: constant=[add, n1, n2, n4]            has_nonconstant_child=[mul_x]
round 3: constant=[add, mul_4, n1, n2, n4]     has_nonconstant_child=[mul_x]
```

One level of the AST per round. `mul_x` is correctly excluded, and the answer is
the least fixed point of the composed monotone operator, not the greatest (which
would have called everything constant).

### 10.2 Proplog, without the prefix counter

The existing example's own header explains why this shape is currently
impossible. With the sigil it is three rules:

```prolog
premise(Id, A) :- kb(Id, _, B), array_element(B, _, V), A = as_string(V).

unmet^(Id) :- premise(Id, A), not derived(A).

derived(H) :- kb(Id, H, _), not unmet^(Id).
```

Against the knowledge base already in `examples/proplog`:

```
round 1: derived=[]                                      unmet=[4, 5, 6, 7]
round 2: derived=[cold, driving, rained]                 unmet=[5, 6, 7]
round 3: derived=[cold, driving, rained, wet_grass]      unmet=[6, 7]
round 4: derived=[cold, driving, rained, slippery,       unmet=[6, 7]
                  wet_grass]
```

`derived` matches the committed `expected.json` of the counter-based version
exactly, which is a useful check on the whole design: same answer, one rule per
concept, no dependence on premises being array-indexable.

Note this version is also *linearly* recursive (no rule has two positive
same-SCC atoms), whereas the counter version is non-linear. Both stay
interpreter-only, but for different reasons.

### 10.3 Purity: the polarity choice is a modelling decision

Covered in §5. The same two rules, with the sigil on one side or the other,
give the conservative answer (`pure=[leaf]`) or the optimistic one
(`pure=[f, g, leaf]`). This is the example that justifies declaring the
polarity, and the one to teach from.

### 10.4 Rejected: the complement encoding of a game

```prolog
win(P)   :- move(P, Q), lose^(Q).
lose^(Q) :- position(Q), not win(Q).
```

The `win` to `lose` edge is positive, so the polarity check demands the same
polarity; the `lose` to `win` edge is negated, so it demands different. Rejected
wherever the author puts the sigil, which is correct: the cycle crosses one
negation.

What is rejected is this *encoding*, not the game. Naming the complement of a
same-SCC predicate is what forces a positive cross-class edge. §10.6 writes the
same analysis with both edges negated, and it passes.

### 10.5 Two lines that separate this design from §6.2

```prolog
p^(0).
p^(X: integer) :- p^(X).
```

The minimal class of this SCC is empty and the maximal class is `{p}`, so `U`
ranges over nothing and all the work is in `V`.

```
V₀ = ⊤                     p holds of every integer

U₁ = lfp F(·, V₀) = ∅      no minimal predicates, nothing to do
V₁ = lfp G(U₁, ·) = {0}    rebuild p from ∅
                           V₁ ≠ V₀, continue

U₂ = lfp F(·, V₁) = ∅
V₂ = lfp G(U₂, ·) = {0}    V₂ = V₁, stop
```

The inner `lfp G` takes two passes from ∅ each round:

```
pass 1:  p^(0).            fires, a fact is a rule with an empty body  -> {0}
         p^(X) :- p^(X).   reads p = ∅, derives nothing
pass 2:  p^(0).            re-derives 0, deduped
         p^(X) :- p^(X).   reads p = {0}, derives 0, deduped
                           nothing new, fixed point
```

Three things it shows.

**⊤ is set and never read** (§4.1 in its simplest form). No minimal predicate
exists to negate `p^`, and `p^`'s own rules read it during the max phase, which
starts from ∅.

**Clearing the maximal relations between rounds does not lose base facts.** The
natural worry about "rebuild from ∅ each round" is that `p^(0).` is thrown
away. It is not: a fact is a rule with an empty body, re-derived in pass 1 of
every round.

**It is the smallest program on which §6.2 gives a different answer.** Under a
true downward iteration, `V₁ = G(⊤)`, and `p^(X) :- p^(X).` is satisfied by
every `X`, so `V` never shrinks: the greatest fixed point is ⊤, every integer,
infinite and unimplementable without finite domain types. The alternating fixed
point gives `{0}`.

What the implementation actually does: this SCC holds one polarity, so it is
the inert case (§11). The sigil warns and the stratum is routed to the ordinary
driver, which reaches `{0}` in one pass. The alternation above is what the
definition says; the routing rule short-circuits it to the same answer.

### 10.6 Games: both bounds of a three-valued analysis, in a two-valued language

The classic game rule `win(P) :- move(P, Q), not win(Q).` is a one-negation
cycle and stays rejected. Duplicating the predicate instead of complementing it
(contrast §10.4) gets through, because both edges are then negated and cross
polarity:

```prolog
win(P)      :- move(P, Q), not not_lost^(Q).
not_lost^(P) :- move(P, Q), not win(Q).
```

Both rules apply the same anti-monotone operator
`A(S) = {P | ∃Q. move(P, Q), Q ∉ S}`. So `Uᵢ₊₁ = A(A(Uᵢ))` from `U₁ = A(⊤) = ∅`,
and `Vᵢ = A(Uᵢ)`. That is Van Gelder's alternating fixed point for the rejected
one-predicate version, with its two bounds given names:

- `win` rises to `lfp(A²)`: the positions with a forced win.
- `not_lost^` falls to `gfp(A²)`: the positions that are not definitely lost.
- `not_lost^ \ win` is the well-founded model's undefined set: the draws.

The three-valued analysis, hand-encoded in a two-valued language. Which
predicate gets which bound is set by where the sigil goes (§5): the minimal side
is the one that has to prove itself.

**Nim.** Its graph is finite and acyclic, since every move strictly decreases
the total, so every position is determined and the two bounds must meet. Two
heaps of at most 2:

```
round 1: win=[]                          not_lost=[01 02 10 11 12 20 21 22]
round 2: win=[01 02 10 20]               not_lost=[01 02 10 12 20 21 22]
round 3: win=[01 02 10 12 20 21]         not_lost=[01 02 10 12 20 21]
round 4: win=[01 02 10 12 20 21]         not_lost=[01 02 10 12 20 21]
```

Round 1 has `not_lost` at ⊤, so `win` is empty and `not_lost` becomes "has any
move". Round 2 finds the win-in-one positions, and `11` drops out as the first
proven loss. Round 3 reaches the answer, round 4 confirms it. The result is
`{(a,b) : a xor b ≠ 0}`, checked against Sprague-Grundy in the prototype.

So for Nim the duplication buys no information: the two predicates agree. It is
the price of admission, the thing that gets the game past the polarity check.

**A game with a draw.** Same rules, `a` and `b` moving to each other, `c` moving
to a dead end:

```
round 1: win=[]     not_lost=[a b c]
round 2: win=[c]    not_lost=[a b c]
```

`c` wins by moving to a dead end. `a` and `b` chase each other forever, so
neither is winning and neither is lost, and they sit in the gap.

**Determinacy as a constraint.** The gap being empty is an ordinary integrity
constraint, since a constraint runs after the SCC has converged and may read a
maximal predicate positively:

```prolog
!- not_lost^(P), not win(P).
```

"No position is undetermined." Holds for Nim, fails on any game with a draw and
reports the drawn positions as the counterexamples.

This is not full well-founded semantics (§6.3). It works because one predicate's
two bounds could be named separately by hand; nothing generalises the trick
across a program, and the author has to know that the gap means "undefined"
rather than "false".

## 11 Inert sigils

A `^` has an effect only when something reads the predicate while its value is
still ⊤, which happens only inside an SCC's alternating loop. Two shapes make
it inert.

**No recursive SCC.** Ordinary stratified negation:

```prolog
sink^(X) :- node(X), not has_outgoing(X).
```

`sink` gets its own stratum and an ordinary least fixed point, and everything
that reads it reads a finished relation.

**An SCC whose members are all maximal.** The polarity check passes, because a
positive edge only asks that both ends agree:

```prolog
tc^(X, Z) :- edge(X, Y), tc^(Y, Z).
```

With no minimal predicate in the SCC nothing reads `tc` negatively from inside
it, so the alternation degenerates: the minimal phase has no predicates, the
maximal phase computes the ordinary least fixed point, and the next round finds
nothing changed.

There is no third shape. An SCC holding both polarities must have a cross-class
edge, and a positive one is rejected, so every cross-class edge is negated and
the cycle is real.

Consequence for phase 2: `computeAll` routes a stratum to `runParityStratum`
when it holds **both** polarities, not merely when it holds a maximal predicate.
Otherwise the second shape pays for a round it cannot use.

An inert sigil is a **warning**, not an error and not silence. The mistake one
would most expect (forgetting the `not` at a call site) is already a hard
polarity error, so what reaches inertness is a `^` whose cycle was never there
or has since been broken. That is harmless for the answer, but it undercuts the
reason for choosing a sigil: at a call site `^` is the reader's cue that a
negation inside a cycle is deliberate, and inert ones make that cue unreliable.
An error is too aggressive, since it would fire constantly while editing
(comment out one rule, the cycle opens, an unrelated line goes red).

Delivery follows the finiteness precedent exactly, so no new channel out of
`analyze` is needed: a pure `findInertPolarity(analyzed): PolarityDiagnostic[]`
in core, shaped like `FinitenessDiagnostic` (`severity`, `code`, `message`,
`predicate`, `offset`, `end`), called by the consumers that already call
`findInfiniteRisks`: `cli/src/main.ts`, `playground/src/worker/executor.ts`,
`playground/src/embed/engine.ts`. The message should name which of the two
shapes above it hit, since the fix differs (no cycle at all, versus a cycle with
nothing minimal in it).

## 12 Decisions

Implemented: the sigil on `input predicate` declarations and module boundaries
(§8). Expansion preserves polarity, aliases carry it, and actual/receiving
contracts are checked. The former deferral is closed; SQL evaluation of parity
SCCs remains deliberately unsupported.

Settled:

- The syntax is a postfix `^` at every occurrence, not a declaration-site
  keyword (§3, §6.4).
- The sigil is not part of the predicate's identity, so "both `p` and `p^`"
  cannot arise and needs no rule (§3).
- Query output, `--all`, and the REPL print the name with the sigil (`unmet^`),
  matching how the source always spells it. The bare name stays the identity
  everywhere it is a key rather than a label: module wiring, qualified
  constructors, REPL protocol fields.
- An inert sigil warns, delivered the way finiteness warnings are (§11).
