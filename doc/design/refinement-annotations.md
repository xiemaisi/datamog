# Design notes: refinement annotations on rule heads

Status: proposal, one review blocker remains. Refinement annotations are not
implemented or in the spec. The soundness findings, witness multiplicity, and
portable integer domain are addressed in the body, and the runtime implements
that integer domain. The first refinement implementation slice remains unsettled.

A head position may be annotated with a *proposition* over the predicate's
earlier arguments rather than with a primitive type. The position's inhabitant
is a witness that the proposition holds, the witness is `Prop`-sorted and
therefore carries no computational content, and it is erased. What remains at
runtime is the predicate without it.

```prolog
p(X: integer, Y: integer, _: Y > X) :- ...
```

reads as: `p` is morally binary, and every tuple it derives satisfies `Y > X`.
Whether the witness exists is the question, and it is a question about the
*rules*, not about the data: each rule for `p` must entail the proposition from
its body. Discharge the obligations and the annotation costs nothing at runtime.

This is refinement typing for Datalog, and its precedent in the codebase is
exact. Head type annotations (spec §5.10) are already per-rule, already checked
rather than used, already absent from codegen, and the grammar slot already
exists:

```
// datamog.langium
Expression ({infer AnnotatedHeadTerm.expr=current}
    ('as' name=Identifier (':' type=PrimitiveType (nullable?='?')?)?
    | ':' type=PrimitiveType (nullable?='?')?))?;
```

Widening that slot to admit a condition is a one-production grammar change, and it
has already been widened twice: `nullness-tracking.md` added the `?` suffix and
`head-arguments.md` added `as`. The downstream representation is not equally
small, because this position disappears rather than annotating a runtime argument.
`nullness-tracking.md` additionally supersedes most of §4.4 below; both are worth
reading alongside this one.

Decisions taken (see §2.1, §4, §5 for what each entails):

- Sibling rules **disjoin**, exactly as §5.10's type annotations join.
- **Tier 1**: propositions over head variables and arithmetic, decidable and
  eventually discharged automatically. **Tier 2** (propositions mentioning
  predicates) is designed in §7, not built.
- Once discharged, **consumers may assume a contract**. Contracts add no codegen;
  §4.1's safe-integer runtime prerequisite is implemented.
- The staged plan currently defers discharge (§4.5), but follow-up review leaves
  that first-slice decision open. A generator-only slice would not deliver the
  payoff above.

## Review findings

The contract idea survives review. Seven issues came out of the first pass. Most
have answers in the body; the unresolved parts are collected below.

- **The erased witness does not fit `argTypes`.** That array aligns with runtime
  head arguments; a witness is a syntactic position that erases entirely, so
  another argument record would break the alignment. Answered in §10 phase 0:
  rule-level storage. Several witnesses on one rule are kept separately for
  diagnostics and conjoined semantically (§2.1 and §11.6).
- **Head aliases are lowered too early.** Head-name processing substitutes `K`
  with its expression during parsing and records no per-position name, so a later
  checker would see `I < I + 1` and lose the reference to the published position.
  Answered in §2.3 and §10 phase 0: extract before substitution, or keep a
  name-to-position map.
- **The aggregate contracts need group-emptiness rules.** An ungrouped aggregate
  over empty input still emits one row, `count(*)` being `0` and `min`/`max` NULL,
  so a contract may strengthen only for a group known to contain an input row.
  Answered in §4.1.
- **The obligation rule inherits the same hole, and there it is unsound.** §3.1
  assumed a tuple is derived only when the body is satisfied, which an ungrouped
  aggregate rule breaks: it emits its row whatever the body does, so an
  unsatisfiable body discharges every annotation on it while the runtime violates
  them. Answered in §3.1 with a second obligation under the empty-group
  valuation, and in §3.2, whose induction never covered that row.
- **Aggregate terms need a scope rule.** A body comparison holds of one row while
  an aggregate is a per-group value, and connecting the two would discharge
  `_: S <= 100` from a body `X <= 100`. Answered in §3.3: an aggregate term is an
  opaque per-group constant, constrained only by §4.1's derived facts.
- **Solver arithmetic must match Datamog.** Integer division truncates toward zero
  and modulo follows the dividend's sign, where a solver's native integer
  operations may not. Integer overflow also differs across back ends, so the
  portable arithmetic domain has to be fixed before discharge can be sound.
  Answered in §4.1: safe-integer results are exact and overflow produces NULL.
  The runtimes and normative spec now enforce that domain.
- **A generator-only increment has no consumer.** Until obligations are
  discharged, no analysis or module boundary may rely on a contract, so phases 0
  to 2 land only if printed obligations are useful on their own. §4.5 and §10
  leave open whether discharge belongs in the first slice.

### Follow-up review

The proposal is not closed yet. One decision remains explicit in its own plan:

- §4.5 and phase 3 leave open whether printed obligations have an independent
  user or solver-backed discharge belongs in the first slice.

Until that is settled, the implementation plan remains blocked.

## 1 What the annotation is

### 1.1 The witness is proof-irrelevant, which is what makes erasure free

A tier-1 proposition is a decidable comparison over concrete values. It either
holds or it does not, and a witness that it holds carries no information beyond
that fact, so the proposition has **at most one inhabitant**. Two derivations of
`p(1, 2)` therefore produce the same witness, because there is only one witness
to produce.

That is the whole soundness argument for erasure, and it is worth stating
carefully because the failure it rules out is real. Datamog relations are sets,
so a witness that *varied* between derivations would make `p(1, 2, w₁)` and
`p(1, 2, w₂)` two tuples, which erasure collapses into one, changing every
`count` downstream. That is exactly what §8 proof terms do: §8.2 makes two
distinct derivations of one fact into two rows, which is why they are observable
data and not erasable. A refinement witness does not vary, so a column holding it
would be constant-valued, and dropping a constant column changes no cardinality.

**So the constraint to hold on to is that the annotation language stays
proof-irrelevant.** No connective may make a witness observable. An existential
would: in `exists Z. p(X, Z)` different `Z` are different witnesses, so the
proposition has more than one inhabitant and erasure stops being sound. Tier 1
has no existential, and tier 2's `forall` (§7) is safe, a function into a
subsingleton being itself unique. Anything added later must clear the same bar.

Given uniqueness, whether the witness "is a column" is a question of
representation rather than of meaning: a constant column and no column denote the
same relation. Nothing is kept (§6), and the convenient reading is as an
**invariant of the erased predicate**:

```
p(X, Y, _: Y > X)      means      ∀ x y, P x y → y > x
```

with `P` the ordinary binary relation the rules define.

### 1.2 It is not §8's proof term

Same syntax family, opposite sort, and they must not be conflated:

| | §8 proof terms (`:: Ctor`) | Refinement annotations (`_: φ`) |
|---|---|---|
| Sort | `Type`-like: observable data | `Prop`-like: irrelevant |
| Runtime | A real `value` column users query | Absent |
| Distinguishes rows | Yes, two derivations are two tuples | No |
| Establishes | That a derivation happened | That every derivation satisfies φ |
| Checked by | The evaluator, by construction | A solver, statically |

A proof-carrying predicate could in principle also carry refinements, but the
two mechanisms share nothing and §4's fragment excludes the combination for now.

## 2 The contract

### 2.1 Disjunction across sibling rules

A rule may have several witness positions. Their propositions constrain the same
derived tuple and therefore conjoin:

```prolog
bounded(X, _: X >= 0, _: X <= 10) :- source(X).
```

For this rule, `φ_R = X >= 0 ∧ X <= 10`. The implementation retains the source
claims separately for diagnostics, while their meaning is the conjunction. A
rule with no witness contributes `True`.

A predicate's tuples come from any of its rules, so sibling-rule contracts
disjoin:

```
Φ_p  =  φ_R₁ ∨ φ_R₂ ∨ … ∨ φ_Rₖ
```

This mirrors §5.10 exactly, where `publishedTypes` is `columnTypes` widened by
whatever the rules declare (`computePublishedTypes` in `core/src/types.ts`). The
contract is *derived* from what the rules claim, never *imposed* on them.

The consequence is sharp and must be documented rather than discovered: **a
contract is usable only when every rule of the predicate is annotated.** One
unannotated sibling collapses `Φ_p` to `True` and every annotation on the
predicate becomes decoration. This is the same failure mode as an unannotated
sibling widening a column type today, but it bites harder, because a `value`
column is still a column while a `True` contract is nothing at all.

The alternative would have been to read an annotation as a requirement binding
all rules (conjunction), which survives partial annotation but changes what the
annotation means and diverges from §5.10. Rejected in favour of consistency.

### 2.2 The inert-annotation warning

Because §2.1 makes partial annotation silently useless, it needs a diagnostic.
The precedent is `findInertPolarity` (`core/src/polarity.ts:31`), which warns
when a `^` sigil sits in a stratum where it buys nothing. The same shape applies:
warn when a predicate has at least one annotated rule and at least one
unannotated one, naming the rules that dilute the contract.

That recovers most of what conjunction would have given, at warning level, and
leaves the semantics alone.

**Decided: warning by default, error under `--strict-contracts`.** The teaching
default stays permissive, and CI can opt into the strict reading. Two precedents
give the shape: nullness and polarity diagnostics print unconditionally from
`emitNullnessWarnings` / `findInertPolarity` (`cli/src/main.ts:590`), while
`--warn-finiteness` (`main.ts:636`) shows how an opt-in analysis flag is wired,
including its rejection in REPL mode. Note the flag inverts the usual sense:
`--warn-finiteness` turns a diagnostic *on*, whereas `--strict-contracts`
promotes one that is already on. The alternative considered was an error in batch
with a REPL carve-out, on the grounds that this forbids only a provably useless
state and, the feature being new, costs no sweep. Rejected for the reason
`nullness-tracking.md` §7 gives for declining required `?`: for a teaching
implementation, stopping is the worse default.

### 2.3 An annotation may only mention a named head position

A contract is stated over *positions*, since a consumer sees columns rather than
the deriving rule's body variables. A bare head variable names its own position;
a literal or computed head argument needs an `as` name when the annotation refers
to it:

```prolog
span(NT, I, I + 1 as K, _: I < K) :- token(I, W), lexicon(NT, W).
```

Positions the annotation does not mention may hold anything:
`state(4, B, _: 0 <= B && B <= 3)` is valid because the literal position is not
part of the formula. A body-only variable remains invalid because publishing it
would require existential quantification, which is outside tier 1.

The existing head-name lowering substitutes `K` with `I + 1` during parsing and
does not preserve the position name. Phase 0 must therefore extract the contract
and its alias-to-position mapping before that substitution. No body rewrite is
needed, which also keeps auto-derived proof-term arguments unchanged.

## 3 Obligations

### 3.1 The rule

For each rule `R` of `p`, with `Φ_q` the contract of predicate `q`:

```
   ⟦comparisons, equalities and arithmetic in R's body⟧
∧  Φ_q[args]   for every positive body atom q(args)
⊢  φ_R
```

Free variables are implicitly universally quantified, so the query handed to a
solver is the unsatisfiability of the hypotheses conjoined with the negated
goal.

**A rule with no grouping columns owes a second obligation**, because the rule
above rests on a premise that such a rule breaks: that a tuple is derived only
when the body is satisfied. An aggregate rule with no grouping columns emits one
row whatever the body does, filled with the empty-group values. Verified on both
back ends:

```prolog
impossible(count(*)) :- q(X), X > 5, X < 0.     # emits 0, body or no body
```

Annotate that `_: N > 0` and §3.1's first obligation *discharges*: §3.3 admits
`X > 5` and `X < 0` as hypotheses, they are unsatisfiable together, so the query
is UNSAT. The runtime emits `0`. So for a rule with no grouping columns, emit a
second goal with **no body hypotheses at all** and every aggregate term at its
empty-group value:

```
count(*), count(X)                        →  0
sum, avg, min, max, concat, list          →  null
⊢  φ_R
```

Both obligations must discharge. Note what this rules out: an annotation on a
`min`/`max` position of an ungrouped rule can essentially never hold, since
comparison is total and `null >= 0` is false (`null.md` §5). That is the right
answer, and it is the same guard §4.1 puts on the derived contracts.

The condition is exactly `hasGroupingColumns` in `core/src/analyzer.ts`, the
shared definition used by the translator, interpreters and nullness analysis.
Obligation generation must call it too rather than restating the rule.

### 3.2 Why the induction is already there

The obligations above are not an ad-hoc check. `∀ x⃗, P x⃗ → Φ_p` is proved by
induction on the derivation of `P x⃗`, which gives exactly one case per rule, and
in the case for rule `R` a recursive body atom's contract is available as the
induction hypothesis. So:

- a body atom in a **lower SCC** contributes its contract as an already-proved
  lemma;
- a body atom in the **same SCC** contributes it as an induction hypothesis.

Both amount to "assume the contract", so the generator does not need to
distinguish them, but obligations must be discharged in SCC order and
simultaneously within an SCC. The analyzer already computes the SCCs.

This is what makes recursion work rather than being the hard case, and it is
where a hand-rolled check would go wrong.

One case the induction does *not* cover, which is why §3.1 needs its second
obligation: the row an ungrouped aggregate rule emits over an empty group is not
produced by a derivation at all. The aggregation machinery emits it, so "one
case per rule" misses it and the induction has to be supplemented rather than
trusted.

### 3.3 What contributes a hypothesis

| Body element | Contributes |
|---|---|
| Positive atom of an annotated predicate | Its contract, instantiated at the atom's arguments |
| Positive atom of an unannotated or input predicate | Nothing |
| Negated atom | Nothing (mirrors §8.2, where negations contribute no witness) |
| Comparison, equality, arithmetic | Itself |
| Range atom `X in a..b` | `a ≤ X ∧ X ≤ b` |

The atoms themselves contribute no relation symbol to the query. Only their
contracts matter, which is what keeps tier 1 inside a decidable theory (§4.1) and
what makes the check **modular**: no predicate definition is ever unfolded.

**In an aggregate rule the table needs a scope caveat.** A body comparison holds
of one row. A grouping variable is constant across the group, so a hypothesis
about it is a group-level fact; any other body variable varies within the group,
so a hypothesis about it is not. An annotation cannot mention such a variable
anyway (§2.3 restricts it to head positions), so admitting the hypothesis is
harmless in itself. What must not happen is connecting it to the aggregate:

**An aggregate term is an opaque per-group constant.** The only facts about it
are §4.1's derived contracts. Modelling `sum(X)` in terms of the row variable
`X` is the error to avoid, and it is the one an implementer would reach for: it
would discharge `_: S <= 100` from a body `X <= 100`, though a sum over many
rows exceeds any per-row bound.

## 4 Tier 1: the decidable fragment

### 4.1 The formula language

Comparisons (`<`, `<=`, `>`, `>=`, `=`, `<>`, with `!=` accepted as a spelling of
`<>`) over linear arithmetic on head variables and literals, closed under `and`,
`or`, `not`. Equality on strings and booleans is permitted and stays
uninterpreted.

Integer `/` and `%` are in, by *constant* divisors, which stays decidable and is
what `collatz`'s `M = P / 2` and `primes`'s `R = X % D` need (§9.5). A
variable-divisor result is left unconstrained rather than rejected.

Their solver encoding must reproduce the runtime rules: division truncates toward
zero and modulo has the dividend's sign. Using a solver's native mathematical
integer division and modulo without this encoding is unsound for negative values.

**The portable integer domain is the JavaScript safe-integer range:**
`-(2^53 - 1)` through `2^53 - 1`. Every tier-1 integer arithmetic operation is
exact when its mathematical result is inside that range and produces NULL outside
it. Integer literals, loaders, conversions, range enumeration, and every backend
enforce the same range.

The solver may use unbounded mathematical integers internally, but each runtime
integer term carries the same null bit as §4.4. For an operation with mathematical
result `r`, the result is null when an operand is null, another partial case
applies, or `r` lies outside the safe-integer range; its value equals `r` only in
the non-null case. This preserves linear arithmetic because multiplication and
division remain restricted as above.

Runtime evaluation and the spec enforce this rule. Loaders and conversions reject
unsafe integer inputs, arithmetic and integer-returning builtins guard their
results, and PostgreSQL stores integer columns as `BIGINT` while guarding
intermediate arithmetic. These are implementation choices, not part of the
contract model.

Excluded, each with a reason rather than by omission: predicate references and
quantifiers (tier 2, §7), `value`-typed positions and JSON operations (no
theory), §8 proof columns, `^` predicates (§7), and non-linear arithmetic
otherwise.

**Aggregate head positions are in, with conservative derived contracts** rather
than the exclusion an earlier draft had (§9.5, §11.7). The checker must first know
whether an emitted group is guaranteed to contain an input row:

| Aggregate term | Derived contract |
|---|---|
| `count(*)` | `>= 0` always; `>= 1` only for a group known to contain an input row |
| `count(X)` | `>= 0` always; `>= 1` only when the group is known non-empty and `X` is non-null |
| `min(X)`, `max(X)` | `X`'s own contract only when the group is known non-empty and `X` is non-null |

The table is keyed by **term**, not by position, which matters now that an
aggregate may sit inside an expression (`head-arguments.md` §1). No propagation
calculus is needed and none should be written: the derived fact enters the
obligation as a hypothesis about the opaque term (§3.3), and the solver does the
surrounding arithmetic itself. `count(Other) - 1 >= 0` follows from
`count(Other) >= 1` by linear arithmetic, with nothing in this document having to
know that `- 1` shifts a lower bound.

**A derived fact is published in conjunction with the annotation disjunction.**
This is worth stating because it looks like it reopens §2.1 and does not. §2.1
governs how *claims* compose, and its answer is disjunction because an
unannotated rule claims nothing. A derived fact is proved rather than claimed, so
it may be conjoined. The soundness condition is that it must hold of every rule's
tuples: publish a fact at a position only when it is derived for **every** rule
of the predicate there. A predicate with one grouped and one ungrouped rule
therefore publishes only the weaker `>= 0`.

The non-empty guard matters even when the argument column is non-null. An
ungrouped aggregate over empty input emits one row: `count(*)` is `0`, while
`min(X)` and `max(X)` are NULL. A grouped result normally exists because an input
row established its group, but the implementation must derive that fact from the
actual grouping shape rather than from the presence of a literal head expression.
Within a known non-empty group, `min`/`max` still need `X` to be non-null because
they skip NULLs (`null.md` §8). When either condition is missing, derive nothing.

`sum` and `avg` derive nothing. Both are derivable in principle, `sum` from its
argument's sign and `avg` from the min/max bracket, but no corpus case wants
either and `avg` would drag division into the derivation itself.

Also excluded: a **bare boolean term** in formula position. Comparison is total
(`null.md` §5) but the boolean connectives stay three-valued, so `!null` is
`null` and a nullable `boolean?` column or `as_boolean(null)` can still put a
NULL into boolean position. Restricting formulas to comparisons combined with
connectives keeps them two-valued, since a comparison absorbs NULL rather than
propagating it.

Every obligation is then a quantifier-free formula over primitives, mentioning
no relations, so it is decidable and needs no interaction.

`functional-sublanguage.md` interacts here. If `fun` lands, a total function
becomes a candidate for the formula language, but only a non-recursive one can
be inlined and stay decidable; a recursive one needs its defining equations as
axioms, which is tier 2 in all but name. Its `data` declarations do not change
§2.3, since they give datatypes a declaration site but not IDB predicates.

### 4.2 Worked example: cyk-parser

Using §2.3's head-position name:

```prolog
span(NT, I, I + 1 as K, _: I < K) :- token(I, W), lexicon(NT, W).
span(NT, I, K, _: I < K) :- grammar(NT, L, R), span(L, I, J), span(R, J, K).
```

Both rules are annotated, so by §2.1 the contract is `I < K ∨ I < K`, i.e.
`I < K`. Two obligations:

```
R1:  K = I + 1                    ⊢  I < K
R2:  (I < J)  ∧  (J < K)          ⊢  I < K
```

R1's hypothesis is the body equality; `token` and `lexicon` are input
predicates and contribute nothing. R2's two hypotheses are the contract of
`span` instantiated at each recursive atom, which is the induction hypothesis of
§3.2. Both are valid in linear integer arithmetic and discharge with no
interaction.

Note what R2 shows: the interesting obligation on a recursive predicate is
solved by the invariant being available at the recursive positions, and neither
rule alone proves anything.

### 4.3 A failing obligation

```prolog
span(NT, I, K, _: I >= 1) :- token(I, W), lexicon(NT, W), K = I + 1.
```

`token` is an input predicate, so it contributes nothing, and `I >= 1` does not
follow from `K = I + 1`. The obligation fails, correctly: nothing in the program
says token positions start at 1. The fixes are to add `I >= 1` to the body as a
filter, or to refine the input declaration (§8).

This is the feature's characteristic failure and its main practical value. A
filter would have got the guarantee dynamically by silently dropping rows; the
annotation makes the gap loud at build time.

### 4.4 NULL: ask the analysis, but keep the encoding honest

Comparison being total (`null.md` §5) is what makes tier 1 viable, and nullness
tracking (`nullness-tracking.md`) supplies most of what this section originally
had to derive by hand. What survives is one soundness requirement on the solver
encoding.

`null` is an isolated point in a **partial** order: `<`/`>` are false whenever
either side is null, `<=`/`>=` are true only when both are, `=` is null-aware so
`null = null` holds. Trichotomy fails deliberately, so `not (X < 2)` is not
`X >= 2` (the NULL row is in the first and neither of the second). A solver
handed plain linear arithmetic assumes trichotomy and would therefore *discharge*
that implication, certifying a contract that does not hold. So null must be in
the encoding:

```
a = b    ⟺  (a.isNull ∧ b.isNull) ∨ (¬a.isNull ∧ ¬b.isNull ∧ a.v = b.v)
a < b    ⟺  ¬a.isNull ∧ ¬b.isNull ∧ a.v < b.v
a <= b   ⟺  (a.isNull ∧ b.isNull) ∨ (¬a.isNull ∧ ¬b.isNull ∧ a.v <= b.v)
a + b    →  isNull ⟺ a.isNull ∨ b.isNull
a / b    →  isNull ⟺ a.isNull ∨ b.isNull ∨ b.v = 0
```

Each term becomes a `(isNull, v)` pair, which keeps the query quantifier-free in
arithmetic plus booleans, so it stays decidable and cheap.

**Non-nullness is not this feature's problem any more.** An earlier draft of this
section derived it from three ad-hoc sources: a `?`-free EDB declaration, a true
strict comparison, and an explicit `<> null` guard. `nullness-tracking.md` §4.2
now ships all three properly, as a per-rule refinement over the body in negation
normal form, and generalises each of them:

| This section wanted | What shipped |
|---|---|
| `?`-free EDB column is non-null | Any positive atom refines, using the atom's *published* nullness, so IDB columns work too |
| A true `<` implies both sides non-null | Every variable in a **strict position** of either operand, walked through arbitrary expressions |
| An explicit `X <> null` guard | That, plus `not (X = null)`, plus `X in [lo .. hi]`, plus disjunctions where every branch refines |

So the checker should **query the analysis rather than reimplement it**:
`inferNullness` and `mayBeNull` in `core/src/nullness.ts`, and `refineBody` for
the per-rule view. `publishedNullness` gives the cross-predicate answer that the
ad-hoc version could not reach at all.

Two consequences for the encoding above. It is still needed, because a term the
analysis reports as maybenull really can be null and plain arithmetic really is
unsound there. But it is needed *only* for those terms: where `mayBeNull` is
false, emit plain arithmetic and skip the pair entirely. And since a tier-1 goal
is usually a strict comparison, which is false at null anyway, most obligations
over a maybenull term are simply unprovable, which is the right answer reported
for the right reason.

`nullness-tracking.md` §1 payoff 4 anticipated this section and calls it "a
reference rather than a workaround". That is the correct reading: the analysis
this section was written to avoid needing now exists, so the right move is to
depend on it. Note that `null.md` §7's verdict survives intact and should not be
cited against this: nullness rides as a bit *beside* the base type, so there is
still no `null` type and base-type inference still does not see nullability.

### 4.5 Discharging, deferred

The staged plan has `--obligations` print goals before anything discharges them.
That takes no dependency and lets the goal format settle against real output,
but follow-up review leaves this delivery choice open: it is worthwhile only if
the printed goals have an independent user.

The obligations are quantifier-free linear integer arithmetic, which is the
easiest thing an SMT solver does, so the eventual choice is between running one
in the CLI only, following the module-resolver precedent that the playground may
simply omit a feature, and `z3-solver`'s WASM build for parity at an unmeasured
bundle cost. A built-in procedure is ruled out already: the corpus needs
coefficients and constant division (`20 * D1 < 21 * D2` in `population-query`,
`P = P0 * 2` in `hanoi`, `%` and `/` in `collatz`), so the fragment is full
linear integer arithmetic rather than difference logic, and hand-rolling a
decision procedure for it is the wrong trade at any dependency cost.

One consequence to state plainly, because it bounds what the first cut delivers.
The generated goals are *correct* including their contract hypotheses (§3.3):
discharging a whole SCC's obligations together is a simultaneous induction, and
that is sound. But until something discharges them, **no consumer may rely on a
contract**, since assuming an unverified claim is exactly the unsoundness the
obligations exist to rule out. So §5's payoff, the one chosen as this feature's
reason to exist, arrives with discharge and not before. Phases 0 to 2 are a goal
generator.

## 5 Consumers assume contracts

This is the chosen payoff and the part that makes it a specification language
rather than a lint. A body atom's contract is a hypothesis in the enclosing
rule's obligations (§3.3), automatically, with no witness naming, so a
predicate's invariant propagates to everything built on it:

```prolog
output predicate chart(NT, I, K, _: I < K) :- span(NT, I, K).
```

`chart`'s obligation is `(I < K) ⊢ I < K`, discharged from `span`'s contract
alone, with no arithmetic in the body. The invariant crosses the predicate
boundary without being restated or rechecked.

Module boundaries are the case where this pays off most in a modular program, but
not by the same mechanism, and it is worth being exact about the difference.
Spec §9 already checks a module's wiring against `publishedTypes` rather than
against inferred types, so the shape is right: an interface could advertise not
just "this input is a binary relation of integers" but "and its second column
exceeds its first". What does not carry over is the checking machinery.
`checkModuleBoundaries` (`core/src/elaborate.ts:316`) compares a
`BoundaryConstraint`'s `expected: PrimitiveType[]` against `publishedTypes`
column by column with `columnTypesCompatible`. A contract is one formula over all
columns, not a per-column type, so it cannot use that path.

Nullness went through this door first and confirms the shape rather than the
machinery. `nullness-tracking.md` §1 payoff 3 rode along "for free" precisely
because a nullness bit *is* per column, so it slotted into the existing loop
(`elaborate.ts:335` reads `publishedNullness` beside the types). A contract does
not have that luxury, which is what makes the two bullets below the real cost of
this section.

Two things would follow, neither of them free:

- **A second obligation form.** The boundary check becomes
  `Φ_supplied ⟹ Φ_required`, an implication between two contracts rather than a
  per-rule entailment. Decidable in tier 1, but a distinct kind of goal that
  §3.1's rule does not cover.
- **A third reading of an annotation, by position.** On an IDB head it is a
  theorem to prove (§3). On an input predicate's declaration it is an
  *assumption*: on a module's free input a required precondition the importer
  must discharge, on the entry program's input a claim about data checkable only
  at load (§8).

**Decided: neither, in the first cut. Annotations go on IDB heads only.** The
boundary check stays per-column type and nullness, exactly as today. The evidence
does not support paying for the alternative: module use in the corpus is
`modular-order` plus walkthrough chapter 16, whose inputs are `cover`, `edge` and
`elem`, and the only tier-1 contract any of them wants is
`cover(A, B, _: A <> B)`.

That candidate also fails to deliver the case this section was built on.
`order.dl`'s missing precondition is that `cover` is **acyclic**, and a per-tuple
contract can only rule out self-loops, not longer cycles. Acyclicity is
relation-level, so by §8 it stays an integrity constraint whatever happens here.
Revisit when a module wants a contract that a per-tuple invariant can actually
express.

## 6 Erasure

There is no erasure step. §5.10 already establishes that head annotations never
reach codegen ("Codegen uses `columnTypes` only"), and §1.1 establishes that a
witness is unique, so a column holding one would be constant-valued and is simply
never built. With §4.1's runtime prerequisite in place, the refinement feature
itself is analysis-only:

- no grammar change beyond the one production,
- no contract-specific change to the translator, any SQL dialect, or either
  interpreter,
- no change to `expected.json` for any example.

Guard elimination (using a discharged proposition to drop a `NULLIF` divisor
guard, a `sqrt`/`ln` domain `CASE`, or the `W[i:j]` slice guard) is the one thing
that would touch the translator, and it is deliberately deferred. It makes the
emitted SQL depend on a solver's answer, which is a much bigger commitment than
a static check.

It is also narrower than it first looks, and `null.md` §3 says why. That doc
already considers and rejects "totality by typing", precisely the idea of a
refinement type proving a divisor non-zero, on the grounds that divisors come
from EDB columns and so the obligation is about data the compiler never sees.
That rejection stands and this proposal does not reopen it: nothing here tries to
make `1 / 0` a static error, and NULL stays exactly as it is. What guard
elimination could remove is only a guard the program has already made redundant
with an explicit `Y <> 0` test, where the obligation is trivial. Useful, but a
peephole optimisation rather than a route to totality.

## 7 Tier 2: designed, not built

Tier 2 is annotations whose propositions mention predicates:

```prolog
p(X, Y, _: not q(X, Y)) :- ...
reach(X, Y, _: forall Z. reach(Y, Z) -> reach(X, Z)) :- ...
```

The second is worth noticing: it expresses transitivity *per tuple*, which is
otherwise a relation-level property (§8).

Both stay proof-irrelevant, which §1.1 requires and which bounds what tier 2 may
grow into. `not` and `forall` are safe, a function into a subsingleton being
unique. An existential is not: `_: exists Z. p(X, Z)` has one inhabitant per
witnessing `Z`, so it is proof-relevant and would make erasure unsound. If that
is ever wanted, it belongs with §8's proof terms, which are observable data
precisely because they record such a choice.

What changes:

- **Definitions must be unfolded.** A goal mentioning `Q` needs `Q`'s meaning,
  not just its contract, so the modular property of §3.3 is lost and the
  program's rules must be translated into a prover's logic.
- **The translation is available.** A stratum's predicates become a mutually
  inductive family, and Datalog's stratification condition is exactly the
  positivity condition an inductive definition must satisfy: a negated body atom
  refers only to a lower stratum, hence to an already-defined type, and a
  negative occurrence of a *previously defined* type is legal where a negative
  self-occurrence is not. Stratified Datalog's perfect model is the per-stratum
  least fixed point, which is what an inductive definition means, so the two
  agree rather than merely resembling each other.
- **Decidability goes.** Obligations become interactive, which puts a prover in
  the build loop. For an educational implementation that is a significant UX
  change and should not be undertaken to serve a handful of annotations.
- **Parity strata stay out.** Not because of coinduction: each side of a parity
  stratum is a least fixed point (`parity-stratification.md` §4,
  `Vᵢ = lfp of G(Uᵢ, ·)`; §6.2 of that doc explicitly rejects the
  greatest-fixed-point reading), so derivations are finite and induction is
  valid. The obstacle is the mutual negative dependency: each side's rules carry
  a negated premise naming the other side while it is being defined, so the pair
  is not an inductive family. Breaking that needs an assumed completeness axiom
  for the opposite side, at the cost of a visibly larger trust base.

## 8 What this deliberately does not do

**Relation-level properties, and there is a line inside them.** A contract
constrains one tuple, so transitivity, antisymmetry, functional dependencies and
cardinality bounds are all outside tier 1. But they do not all fail the same way,
and the distinction decides what is permanently out of reach:

- **Upper bounds** are universally quantified over the tuples that exist:
  functionality (`p(X,Y) ∧ p(X,Z) → Y = Z`), injectivity
  (`p(X,Z) ∧ p(Y,Z) → X = Y`), transitivity, antisymmetry. These *are*
  expressible per tuple, in tier 2's `forall` form, since a tuple can assert
  something about every other tuple that joins with it:
  `p(X, Y, _: forall Z. p(X, Z) -> Y = Z)` is functionality.
- **Lower bounds** are existence claims: totality (`∀x ∈ dom. ∃y. p(x,y)`) and
  surjectivity. **No head annotation can express one at any tier**, and the
  reason is structural rather than a scoping choice: an annotation constrains
  tuples that *are* derived, and cannot demand that a tuple *be* derived. These
  are inherently integrity constraints, and inherently data-dependent whenever
  the domain is an EDB.

Both kinds remain expressible as integrity constraints today, and integrity
constraints remain dynamic assertions checked at the fixed point, which is what
they are for. §9.4 surveys which of the four the corpus actually wants.

**Data assertions.** Nothing here says anything about input data. An annotation
on an *input* predicate's column would be an assumption, not a theorem, and the
only sound place to check it is at load time. That is a coherent extension using
the same syntax with a different reading by position, and it is the natural fix
for §4.3's failing obligation, but it is deferred with the rest of the input
readings (§5) and would be this proposal's first runtime component.

## 9 What the corpus says

`functional-sublanguage.md` set the precedent of surveying the example corpus
before committing and letting it choose. Done here over the 80 `.dl` files under
`packages/cli/examples/`.

### 9.1 Coverage

Around 25 predicates across 11 of the 78 example directories carry a per-tuple
invariant worth stating and expressible in tier 1.

| Predicate (example) | Invariant | Rules | Verdict |
|---|---|---|---|
| `span` (cyk-parser) | `I < K` | 2 | Discharges; one computed position needs an `as` name |
| `fib_step` (fibonacci) | `I >= 1 && 0 <= Prev && Prev <= Curr` | 2 | Discharges; one computed position needs an `as` name. A genuine inductive invariant: the goal needs both conjuncts of the IH |
| `chain` (collatz) | `1 <= N && N <= 27 && M >= 1 && K >= 0` | 3 | Discharges, but needs `/` and `%` in the theory (§9.5) |
| `state` (jugs) | `0 <= A && A <= 4 && 0 <= B && B <= 3` | 9 | Discharges; four rules need head-position names, and the invariant is restated nine times (§9.3) |
| `state` (bridge-crossing) | `0 <= T && T < 19` | 7 | Discharges; restated seven times |
| `pow2`, `task`, `move` (hanoi) | `N >= 0 && P >= 1`, `N >= 1 && Off >= 0` | 2, 3, 1 | Discharge |
| `num`, `divides` (primes) | `2 <= I && I <= 30`, `1 < D && D < X` | 1, 1 | Discharge from a range atom and from body comparisons |
| `n`, `d`, `attacks`, `safe`, `q1`…`q6` (n-queens) | domain bounds | 1 each | Discharge. The `q1`→`q6` chain is the §5 showcase: each obligation follows from the previous predicate's contract |
| `density`, `close_pair` (population-query) | `D >= 0`, `D1 > D2` | 1, 1 | `close_pair` discharges; **`density` fails, correctly** (§9.2) |
| `tvar`, `var_index` (cnf-tseitin) | index within `nvars` | 2, 1 | **Blocked** on aggregate contracts (§9.5) |
| `fastest`, `how_soon` (bom) | `Time >= 0` | 1, 1 | Needs an input refinement; `part_cost` is an EDB |

Examples with no tier-1 content at all are the string- and `value`-shaped ones:
`adder-debugging`, `sk-strings`, `parse-json`, the `proof-term*` family, most of
the knights-and-knaves style puzzles. That is the majority of the corpus.

### 9.2 The best case was one that fails, and nullness tracking took it

This subsection used to hold the survey's strongest argument. It no longer
belongs to this proposal, and the honest thing is to say so rather than restate
it.

```prolog
input predicate population(country: string, people: integer).
input predicate area(country: string, sq_miles: integer).
density(C, D) :- population(C, P), area(C, A), D = P * 100 / A.
```

The argument was that `density(C, D, _: D >= 0)` fails, with counterexample
`sq_miles = 0` making `D` NULL, so writing down the obvious invariant finds a
latent division by data nobody guarded. That is still true. But it is now
reachable without any of this, because `nullness-tracking.md` shipped, and a
plain stage-1 head annotation delivers it (verified):

```prolog
density(C, D: integer) :- population(C, P), area(C, A), D = P * 100 / A.
# Predicate 'density' column 2 is annotated 'integer' but this rule can
# produce NULL; annotate 'integer?'
```

So the corpus's clearest "this catches a real bug" case is served by a feature
that exists, at the cost of one already-supported annotation. What is left for
refinement annotations is the part the nullness bit cannot express, which is
every invariant that is not one bit wide: `span`'s `I < K`, `fib_step`'s
`0 <= Prev && Prev <= Curr`, `jugs`'s bounds, `n-queens`'s domains. Those are
untouched, and they are now the whole case rather than the supporting cast.

Note also that `D >= 0` was never a good refinement example on its own merits:
given non-null `D`, it needs `P >= 0` and `A > 0`, which are claims about input
data (§8) rather than about the rules.

### 9.3 The restatement cost, which bears on §2.1

The corpus's strongest invariants sit on predicates with many rules, and this is
where the per-rule disjunctive contract hurts. `jugs`'s `state` has nine rules;
the invariant `0 <= A && A <= 4 && 0 <= B && B <= 3` must be written on all nine,
because one unannotated sibling collapses the contract to `True` (§2.1), and
written differently on each because the rules name their head arguments
differently. Four also need `as` names for computed positions. `bridge-crossing`
has seven rules for `0 <= T && T < 19`.

Nothing about that is unsound. It is recorded here because the survey is the
first place the cost is visible: a predicate-level annotation, written once in
position terms and imposed on every rule, would cost one line where this costs
nine.

**Decided: disjunction stands.** The choice was reaffirmed after this section
priced it, so the two costs below are accepted rather than overlooked, and this
should not be reopened without new evidence.

1. *Restatement.* Nine annotations on `jugs`, seven on `bridge-crossing`, each
   written in that rule's own position names. Four of `jugs`'s also need an `as`
   name for a computed position; the restatement is the substantial cost.
2. *Silent degradation.* Adding a rule to an annotated predicate can never fail
   an existing annotation; it weakens `Φ_p` toward `True`. So a contract can
   quietly become worthless as a program evolves, where a predicate-level
   reading would have failed loudly. §2.2's warning is the whole mitigation,
   with `--strict-contracts` providing the opt-in error (§2.2).

### 9.4 Functionality, injectivity, totality, surjectivity

Surveyed separately, because §8 shows they are a different shape. The answer has
three parts.

**Nobody writes them down.** The whole corpus contains nine integrity
constraints, in four examples, and not one of them asserts any of the four:

| Example | What its constraints assert |
|---|---|
| `integrity-constraints` | Referential integrity, a range check, a state exclusion |
| `nim` | That `win` agrees with the closed form `A ^ B <> 0`, in both directions |
| `modular-order/order` | Irreflexivity, antisymmetry, transitivity |

**The properties hold widely and unstated.** At least ten relations read as
functional without saying so: `density`, `fastest`, `how_soon`, `steps`, `pow2`,
`fib_step`, `slower`, `time`, `opp`, `var_index`, `tvar`. `opp` is a two-element
bijection, so it has all four. The interesting case is `cnf-tseitin`, which
assigns propositional variable indices to AST nodes, where a collision silently
produces a wrong formula.

**And stating one is harder than it looks.** The obvious property, `tvar` is
injective, is *false*, and the checker says so immediately:

```prolog
!- tvar(N1, I), tvar(N2, I), N1 <> N2.
# violated by 4 rows: N1 = 1, I = 0, N2 = 5 ...
```

Nodes 1 and 5 both get index 0 by design: they are two occurrences of the same
propositional variable, and collapsing them is the point of the encoding. `tvar`
is injective *up to variable naming*, which takes four constraints to say, all
four of which hold (verified):

```prolog
!- var_index(N1, I), var_index(N2, I), N1 <> N2.                  # names injective
!- tvar(A, I), tvar(B, I), A <> B, internal(A), internal(B).       # internals injective
!- tvar(V, I), tvar(N, I), node(V, "var"), internal(N).            # the two ranges are disjoint
!- tvar(N, I1), tvar(N, I2), I1 <> I2.                             # tvar functional
```

**Refinements are the wrong tool for all of it, which is the useful finding.**
Those four lines cost nothing and are checked against the actual AST. Proving
them statically instead means proving that
`rank(Name, count(Other)) :- varname(Name), varname(Other), Other <= Name`
is injective, i.e. that counting a strict order's predecessors is injective. That
needs aggregate *and* order reasoning, beyond tier 2 as well as tier 1. So the
corpus's best instance of this family argues for adding the four constraints to
`cnf-tseitin`, which is worth doing on its own merits, and not for the refinement
mechanism at all.

`nim` also supplies a concrete instance of the not-expressible class:
`!- pos(A, B), (A ^ B) <> 0, not win(A, B).` demands that every position with
nonzero xor *be* in `win`. That is a lower bound, so no head annotation can state
it, at any tier.

**Net effect on tier 2.** It gains its first corpus support, since functionality
and injectivity are genuinely wanted and genuinely per-tuple expressible in the
`forall` form. It does not gain a case for being built, because the instance that
wants it most cannot be discharged even with it. Every invariant tier 1 found is
arithmetic over head variables, so tier 1's scope is unaffected.

### 9.5 Two gaps the corpus exposes

**Integer division and modulo must be in the theory.** §4.1 says "linear
arithmetic" and excludes non-linear, which as written excludes `collatz`'s
`M = P / 2` and `primes`'s `R = X % D`. Both are needed, and division and modulo
by a *constant* stay decidable, so the fragment should name them explicitly.
`X % D` with a variable divisor is the harder case and appears in `primes`; the
obligation there does not need it (the invariant `1 < D && D < X` follows from
the body comparisons alone), so a first cut can treat a variable-divisor result
as unconstrained.

**Aggregate positions want built-in contracts, not exclusion.** This is what
§4.1 now does; an earlier draft of it excluded them, which is what blocked
`cnf-tseitin`'s index-in-range invariant. Some contracts are free and need no
annotation. `count(*) >= 0` and `count(X) >= 0` always hold. Either strengthens to
`>= 1` only when the emitted group is known to contain a row, with `count(X)` also
requiring `X` to be non-null. Under the same two guards, `min`/`max` inherit their
argument's contract. An ungrouped empty aggregate is the counterexample to the
stronger unconditional rules: it emits `count(*) = 0` and `min(X) = null`.

But it unblocks less than it first appears, and the difference is worth stating
because it bounds how much this is worth. `var_index(Name, count(Other) - 1)`,
which is what the corpus says since the collapse in `head-arguments.md` §1.1,
gets `>= 0` only if its grouping shape proves a non-empty group.
The upper bound still does not follow. `tvar`'s internal branch needs
`P + R - 1 < P + I`, i.e. `irank(N) <= ninternal`, and the var branch needs
`rank(Name) <= nprop`: both are "the count of a subset does not exceed the count of
the set", a relation *between two aggregates over the same base* rather than a
property of one. No per-aggregate contract delivers that at any of the settings
below.

### 9.6 Verdict

The corpus supports tier 1, but less than it did before nullness tracking
shipped, and the case should be stated at its current strength rather than its
former one.

Against: the single clearest "catches a real bug" instance is gone (§9.2), taken
by a feature that already exists and costs one annotation. What remains is
documentation-plus-assumption for arithmetic invariants over roughly 25
predicates in 11 of 78 examples, headed by `fib_step`, `span`, `jugs` and the
`n-queens` contract chain. Those are real, but none of them is currently *wrong*,
so the feature would be confirming what already holds rather than finding
defects. Two of the three remaining high-value cases argue for design changes
first (§9.3, §9.5). Nothing in the corpus argues for tier 2 being built (§9.4).

For: the cost dropped at the same time as the case weakened, and by more.
`nullness-tracking.md` established the annotation slot's second component, the
`publishedNullness` companion to `publishedTypes`, the declared-versus-inferred
discipline in `checkHeadAnnotations`, the boundary check in
`checkModuleBoundaries`, and `refineBody`'s per-rule fixed point over body
conjuncts. A refinement checker is the same shape with a richer claim, and can
reuse all five.

So: still worth designing, but as an extension of a pattern that now exists three
times over rather than as a feature carrying its own weight. One follow-up
decision remains: whether solver-backed discharge belongs in the first
implementation slice.

## 10 Implementation plan

### Phase 0: surface and validation

Widen the `AnnotatedHeadTerm` slot to admit a condition and extract it in
`liftHeadAnnotations` (`parser/src/post-process.ts`) before head-name substitution
erases positional aliases. Store it as rule-level contract metadata, not in
`argTypes`: that array has one record per runtime argument, while the witness is a
syntactic position that disappears. Keep several witnesses as a source-ordered
list, conjoin them as the rule's contract, and generate one obligation per source
formula so a failure points at the exact annotation. Validate that each formula
mentions only named head positions and is inside §4.1's fragment. No solver yet.
A `--obligations` flag prints the generated goals.

Test: goldens for the obligation text, plus one rejection test per §4.1
exclusion.

### Phase 1: contracts

Compute `Φ_p` per predicate by disjunction over rules with position abstraction
(§2.1), using the alias-to-position mapping captured before head-name lowering.
Keep it alongside, rather than inside, `publishedTypes` in `core/src/types.ts`.
Emit the inert annotation warning (§2.2).

Test: a predicate with mixed annotated and unannotated rules yields `True` and
one warning.

### Phase 2: obligation generation

Hypotheses per §3.3, SCC ordering per §3.2. Still no solver, so the whole
pipeline is testable against expected goal text.

### Phase 3: discharge, deferred

The current proposal leaves this out of the first cut (§4.5). Before implementation,
decide whether printed obligations have an independent user. If not, this phase
belongs in the first slice. Wire a solver behind `--check-refinements`, at which
point `cyk-parser` (§4.2) discharges and §4.3's variant fails with a message naming
the rule and the unprovable formula. Only at this point may a consumer rely on a
contract, so §5's payoff and the `--strict-contracts` flag of §2.2 land here
rather than earlier.

### Phase 4: documentation

Spec §5.10 gains the refinement form; walkthrough coverage; one example under
`packages/cli/examples/`.

## 11 Decisions and residuals

These earlier decisions still apply, with the corrections recorded above. One
decision remains blocking: the first useful delivery slice.

1. **Should `not` around a comparison be warned about?** Was deferred as "help or
   noise"; the project has since answered it. Because trichotomy fails (§4.4),
   `_: not (X < 2)` is strictly weaker than `_: X >= 2`, since it admits a null
   `X`. `nullness-tracking.md` stage 2 shipped a warning for exactly this shape
   in body position, with the message "`X < 2` and `X >= 2` look like a partition
   but leave out NULL, which satisfies neither" (`nullness-diagnostics.ts`). So
   the warning is wanted, and an annotation-position version should reuse that
   wording. One trap is recorded there and applies here too: the check must ask
   what nullness would be *without* the conjunct being warned about, since a
   strict comparison proves its own operands non-null and the naive version never
   fires.
2. **Solver dependency.** This follows the delivery-slice decision in §4.5. A
   built-in procedure is ruled out on the corpus's fragment. If discharge joins
   the first slice, choose between CLI-only and `z3-solver`'s WASM build by
   measuring the bundle cost.
3. **Floats.** Decided: tier 1 covers integer positions only; a refinement on a
   float position is rejected. Two of the three worries turned out not to exist.
   Every partial float operation returns NULL rather than a special value, and
   no float literal can denote an infinity either, since there is no exponent
   syntax and an over-range decimal is rejected outright as "outside the finite
   number range" (both verified). So NaN and infinity never arise and §4.4's
   encoding already covers null. What remains is the real reason: IEEE rounding
   is not exact real arithmetic, so a solver reasoning over reals would discharge
   obligations the runtime does not satisfy. A floating-point theory exists and
   Z3 supports it, but it is far more expensive and no corpus invariant is a
   float one, every case in §9.1 being integer.
4. **Is the inert-annotation diagnostic a warning or an error?** Decided: warning
   by default, error under `--strict-contracts`. See §2.2. What remains is
   whether the flag should also promote any *other* advisory the checker grows,
   which is a question about the flag's scope rather than about this diagnostic,
   and can wait until there is a second one.
5. **What does the REPL do?** `IncrementalSession` currently rejects extending an
   existing predicate across chunks, so sibling rules must arrive together. The
   checker therefore has the complete predicate when it accepts a chunk and can
   emit the inert-annotation warning once. Revisit only if the REPL later permits
   rule-by-rule extension of a predicate.
6. **Are several witnesses on one rule rejected or combined?** Decided: combine
   them by conjunction. This matches a single annotation using `&&` and preserves
   proof irrelevance. Keep the source claims as a list and discharge them
   separately so diagnostics identify the failing witness. Across sibling rules,
   the resulting rule contracts still disjoin (§2.1).
7. **How far do derived aggregate contracts go?** `count` has the universal
   contract `>= 0`. It strengthens to `>= 1`, and `min`/`max` inherit their
   argument's contract, only for groups known to contain a row; the latter also
   require a non-null argument. `sum` and `avg` derive nothing. No per-aggregate
   contract reaches `cnf-tseitin`'s upper bound, which needs "the count of a subset
   does not exceed the count of the set" (§9.5). That relation between aggregates
   would be a different feature.
8. **What integer domain does solver discharge use?** Decided: the JavaScript
   safe-integer range. Operations are exact inside it and return NULL on overflow.
   The solver uses mathematical integers with a range guard and §4.4's null bit,
   rather than bit-vectors or backend storage widths. Runtime alignment is in
   place (§4.1).

## Appendix: adjacent findings, all fixed

Turned up while investigating this, independent of it, and dealt with rather
than left in a list. Recorded because each says something about proof terms that
the spec had not said.

1. **Universal-quantifier proof terms already worked**, with no language change,
   and nothing documented how. Range restriction makes every quantification
   finite, so a universal claim's proof is the finite list of its sub-proofs;
   what was missing was how to build one. Now spec §8.5, with the two encodings
   split by whether the quantification sits inside a recursion.
2. **`formatProofArg` did not recurse into arrays**, so a `list` aggregate over
   captured proofs printed as raw tagged JSON instead of
   `Forall([Pass(), Pass()])`. Fixed in `engine/src/json-canonical.ts`.
3. **`::` on a `^` predicate was neither rejected nor specified.** It works and
   should: each side of a parity stratum is a least fixed point, so derivations
   are finite. Now spec §8.7, with a test in the native parity suite.
4. **Negating a proof-carrying predicate was unspecified.** A mark is the only
   way to reach the implicit proof column and a mark on a negated atom is an
   error, so a negated atom never observes a proof: it is written at the
   declared arity, and `not p(args)` holds when the fact has no proof at all.
   Now spec §8.3.
