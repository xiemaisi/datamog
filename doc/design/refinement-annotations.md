# Design notes: refinement annotations on rule heads

Status: **phases 0, 1, 2, 3 and 5 implemented**; phase 4, static discharge, is
the remainder.
Refinements parse, the position erases, and a contract is checked against the
derived tuples; spec §5.11 and walkthrough chapter 7 describe it. Static
discharge (phase 4) is designed and unbuilt. `--obligations` writes the
obligations out as SMT-LIB 2, so discharge never requires a particular solver,
and `--strict-contracts` promotes the vacuous-contract advisory to an error.

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
- A contract is **checked dynamically or proved statically** (§4.5). Dynamic
  checking is the first slice and needs no prover; static discharge emits
  SMT-LIB and runs whatever solver you have. Mixing them is sound per predicate.
  No solver is ever a required dependency (§11.2).

## Review findings

The contract idea survives review. Seven issues came out of two passes, five from
the first and two more from a re-read of what the first left standing. Most have
answers in the body; the unresolved part is collected below.

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
- **A generator-only increment has no consumer.** Answered twice over in §4.5.
  Emitting SMT-LIB gives the goals a consumer of their own, and dynamic checking
  gives an annotation an effect without any discharge at all, so the first slice
  no longer has to choose between being small and being useful.

### Follow-up review

The last blocker, what the first delivery slice is, is settled and the plan is
unblocked. Two changes did it, both in §4.5.

Obligations are emitted as SMT-LIB 2, so no phase depends on a particular
solver, and printed goals have an independent user after all: a `.smt2` file
runs under any solver or sits in CI, where prose goals would not have.

And discharge is no longer the only way an annotation can mean something.
Checking a contract against the tuples a predicate derived, the way an
integrity constraint is checked, is a much smaller slice than proving it and
sidesteps §3.1's empty-group hole, §4.1's derived aggregate contracts and
§3.2's induction entirely. That is phase 3, and it is the first slice.

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
`count` downstream. That is exactly what spec §8's proof terms do: spec §8.2
makes two distinct derivations of one fact into two rows, which is why they are
observable data and not erasable. A refinement witness does not vary, so a column
holding it would be constant-valued, and dropping a constant column changes no
cardinality.

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
unannotated one, saying how many of the predicate's rules carry no refinement.

That recovers most of what conjunction would have given, at warning level, and
leaves the semantics alone.

**Decided: warning by default, error under `--strict-contracts`.** The teaching
default stays permissive, and CI can opt into the strict reading. Two precedents
give the shape: nullness and polarity diagnostics print unconditionally from
`emitPolarityWarnings` / `emitNullnessWarnings` (`cli/src/main.ts`), while
`--warn-finiteness` shows how an opt-in analysis flag is wired,
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
| Negated atom | Nothing (mirrors spec §8.2, where negations contribute no witness) |
| Comparison, equality, arithmetic | Itself |
| Range atom `X in a..b` | `a ≤ X ∧ X ≤ b` |
| A named head position (§2.3) | `name = ` the head expression it names |

The last row is easy to miss and §4.2 depends on it. A name is not a body
variable and §2.3 introduces no body equality, so without this row nothing
connects `K` to `I + 1` and an obligation mentioning `K` would have no
hypothesis at all. It is definitional rather than derived: the position *is*
that expression.

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

R1's hypothesis is the definition of the named position (§3.3's last row), not
a body equality: `as K` rewrites nothing, so `K = I + 1` holds because position
3 is that expression. `token` and `lexicon` are input predicates and contribute
nothing.

**R1 does not actually discharge, and emitting it is what showed that.** The
integer domain is `[-(2^53 - 1), 2^53 - 1]` and arithmetic leaving it is NULL
(spec §2.6), so `I + 1` is NULL when `I` is the largest integer, `K` is then
NULL, and `I < K` is false because an ordering is false at NULL. The contract
holds only for `I` bounded away from the top of the domain, and nothing in
`cyk-parser` says token positions are. The fix is a second claim,
`_: I < K, _: K <= 1000000`, or a bound on the input; the point for this
document is that the obligation is right to fail and the earlier text claiming
otherwise predated the integer domain. R2's two hypotheses are the contract of
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

### 4.5 Discharging: two modes, no solver dependency

An obligation can be **proved** or it can be **checked**. Both are supported and
neither ties the language to a prover.

**Static: SMT-LIB out, solver not included.** The obligation set's public form is
an SMT-LIB 2 script, and nothing in phases 0 to 2 may assume a particular solver.
That is the whole of the corner-avoidance: the artifact is text, every solver
reads it, and the choice moves to whoever runs it. It also answers what this
section previously left open, whether printed obligations have an independent
user. Prose goals arguably do not; a `.smt2` file does, since it can be piped to
any solver or checked into CI.

Weighing what a bundled solver would cost settles it. `z3-solver` unpacks to
about 35 MB, orders of magnitude past what the playground budget tolerates, for a
logic it barely stretches: the fragment is `QF_LIA` plus booleans, and every
hypothesis set in §9.1 is a conjunction of linear constraints with the case split
coming only from `||` and §4.4's null bit. cvc5 compiles to WebAssembly but
publishes no package, so it would mean owning a build. A pure-JS LP library could
carry the arithmetic, but it optimises in floating point, and a proof obligation
discharged by a floating-point simplex is not a proof.

One detail makes the output *more* portable rather than less. SMT-LIB's `div` and
`mod` are Euclidean, with a non-negative remainder, where §4.1 requires
truncation toward zero and a dividend-signed remainder. The emission therefore
encodes those explicitly rather than leaning on a solver's builtins, so it does
not depend on any solver's conventions.

Incompleteness is safe here, which keeps a small built-in checker on the table
later. An obligation that is not discharged simply does not publish its contract,
so a checker that answers "unsat" or "don't know" is sound. The cost is
diagnostic sharpness: it can say "I could not prove `D >= 0`" but not "this is
false", which for a teaching implementation is arguably the more honest message.

**Dynamic: check the contract against the tuples.** The alternative to proving
`Φ_p` is evaluating it over what `p` actually derived, and reporting a violation
the way an integrity constraint does. This is the cheaper mode by a wide margin,
and it is the one that gives the annotation an observable effect without any
prover at all.

It sidesteps the three hardest parts of the static mode outright:

- **The empty-group hole (§3.1) does not exist.** There is nothing to reason
  about: the row an ungrouped aggregate emits is checked like any other.
- **Derived aggregate contracts (§4.1) are unnecessary.** The aggregate's value
  is there to look at.
- **Recursion needs no induction (§3.2).** The check runs at the fixed point.

What it checks is exactly the published contract. A tuple does not record which
rule derived it, so the check is against `Φ_p`, the disjunction of §2.1, which is
precisely what a consumer assumes. NULL needs no special handling either: a null
in a constrained position makes a strict comparison false, so the tuple is
reported, which is what the contract said.

**Mixing the two is sound**, and that is worth stating because it is the reason
to have both. A static obligation proved under the assumption `Φ_q`, together
with a run in which `Φ_q` was dynamically checked, gives `Φ_p` for that run. So
every assumed contract must be either proved or checked in the same run, and the
modes compose per predicate rather than per program.

**What dynamic mode does not give you** is a theorem. It covers the run, not all
inputs, so §5's module-interface story, a law that holds for every wiring, still
needs the static mode. It also costs a scan of the extension per contract, the
same cost an integrity constraint already carries.

Being honest about the overlap: a dynamically-checked contract is expressible
today as `!- p(X, Y), not (Y > X).` The annotation earns its place by sitting at
the definition site and by being the same text that static discharge later
proves, not by expressing something new.

## 5 Consumers assume contracts

This is the chosen payoff and the part that makes it a specification language
rather than a lint. It comes in two strengths, per §4.5: a dynamically checked
contract may be assumed for the run that checked it, which is enough for one
program's own reasoning, while only a statically discharged one may be assumed
for all inputs, which is what a module interface needs. A body atom's contract is a hypothesis in the enclosing
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
never built.

One qualification, since §4.5 has two modes: **static discharge is
analysis-only, dynamic checking is not.** The dynamic mode emits a check
alongside the program, exactly as an integrity constraint does, so it reaches
codegen. What it does not do is change the predicate: no column is added, no
tuple is altered, and the witness is as absent as ever. Only the check is new,
and it is the constraint machinery rather than anything contract-specific.

With §4.1's runtime prerequisite in place, the static mode is analysis-only:

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
before committing and letting it choose. Done here over the `.dl` files under
`packages/cli/examples/`.

### 9.1 Coverage

Around 25 predicates across 11 of the example directories carry a per-tuple
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
predicates in 11 of the examples, headed by `fib_step`, `span`, `jugs` and the
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
times over rather than as a feature carrying its own weight. The slice
question is settled: phase 3 shipped the check, and solver-backed discharge is
phase 4 (§4.5).

## 10 Implementation plan

### Phase 0: surface and validation — built

Widen the `AnnotatedHeadTerm` slot to admit a condition and extract it in
`liftHeadAnnotations` (`parser/src/post-process.ts`) before head-name substitution
erases positional aliases. **As built**, the extraction is
`extractRefinements` in the new `parser/src/refinements.ts`, called from
`liftHeadAnnotations`. Store it as rule-level contract metadata, not in
`argTypes`: that array has one record per runtime argument, while the witness is a
syntactic position that disappears. Keep several witnesses as a source-ordered
list and conjoin them as the rule's contract, keeping the source claims separate
so a report names the exact annotation that failed. Validate that each formula
mentions only named head positions. Fragment membership is **not** checked
here: an out-of-fragment formula is instead reported at obligation time, as a
`; not emitted, outside tier 1: ...` line, so nothing is silently encoded as
something it is not. No solver, and nothing here may assume one.

Test: goldens for the parsed contract, plus one rejection test per §4.1
exclusion.

### Phase 1: contracts — built

Compute `Φ_p` per predicate by disjunction over rules with position abstraction
(§2.1), using the alias-to-position mapping captured before head-name lowering.
Keep it alongside, rather than inside, `publishedTypes` in `core/src/types.ts`.
Emit the inert annotation warning (§2.2).

Test: a predicate with mixed annotated and unannotated rules yields `True` and
one warning.

**As built**, no Φ_p is materialised anywhere. The disjunction is implicit:
`synthesiseContractChecks` (`parser/src/refinements.ts`) emits one `!-` per
contracted predicate only when *every* rule carries a refinement, and
`findInertContracts` (`core/src/contracts.ts`) warns about the mixed case. Since
nothing consumes Φ_p as a value, the type-system placement never arose.

### Phase 2: obligation generation — built

Hypotheses per §3.3, SCC ordering per §3.2. `--obligations` writes the goals as
an SMT-LIB 2 script (§4.5), encoding truncating division and a dividend-signed
remainder explicitly rather than using SMT-LIB's Euclidean `div`/`mod`. Still no
solver: the script is the deliverable, and it is testable against a golden file
and by running any solver that happens to be installed.

Independent of phase 4, since a `.smt2` file is usable on its own.

**As built**, in `core/src/obligations.ts`, behind `--obligations`. Coverage and
its limits:

- The encoding writes out what it must not delegate: truncating division, the
  integer domain on every arithmetic term, and NULL as a value-plus-Bool pair
  so an ordering can be false at NULL.
- A named head position contributes its definition, which §3.3's last row
  requires and §4.2 depends on.
- **Body-atom contracts are not yet hypotheses.** That is one of the two §3.3
  rows left, and it is what §4.2's R2 and §5's payoff need, so it is the first
  thing phase 4 should add.
- **A range atom contributes nothing either**, the other missing row:
  `hypotheses()` handles `Filter` and `Equality` only, so `n(X, _: X >= 2) :- X
  in [2 .. 5].` emits a goal with no assumptions and cannot discharge.
- **A goal mentioning a non-`integer` position is not emitted.** QF_LIA has one
  sort, so a `float`, `string` or `value` variable would be declared `Int` and
  could discharge for the wrong reason. Ordering per §3.2 is not implemented
  either: the blocks come out in `typed.rules` order, which is moot while
  body-atom contracts are absent. Omitting a hypothesis only weakens a goal, so this is sound: an
  obligation may fail that a later pass discharges.
- **A rule with an aggregate in its head is not emitted**, with a note saying
  so. Its contract needs §4.1's derived facts and §3.1's empty-group goal.
- A hypothesis outside the fragment, a string equality say, is dropped rather
  than failing the obligation, for the same soundness reason.

No solver ran against the output, none being installed here, so the encoding is
pinned by tests rather than by a verdict.

### Phase 3: dynamic checking — built

The smallest slice that makes an annotation do something. Assemble `Φ_p` from
phase 1, emit it as a check over `p`'s extension, and route violations through
`engine/src/constraints.ts`, which already reports a predicate, a source claim
and the offending rows, and already runs after evaluation and before any query
(spec §4.7). No solver, no obligation generation, and none of §3's machinery:
§4.5 explains why the empty-group hole, the derived aggregate contracts and the
induction are all irrelevant to this mode.

Test: a contract that holds passes silently; one that does not names the
predicate, the annotation and the tuple. A predicate with an unannotated sibling
checks nothing, since `Φ_p` is `True` (§2.1), and warns (§2.2).

**As built**, in `parser/src/refinements.ts`. Three notes.

The lowering is the whole implementation: a contract becomes a synthesised
`!- p(Col1, .., Coln), !(Φ_p).`, so the translator, both interpreters and the
violation reporting are untouched. Nothing after parsing knows refinements
exist.

Where the contract splits, it is split, so a violation names the claim that
failed rather than the first one. A single rule's contract is a conjunction and
`!- p(..), !(a && b).` is exactly `!- p(..), !a.` plus `!- p(..), !b.`, so one
check per refinement is emitted. Several rules disjoin, which does not split, so
they share one.

A synthesised statement is marked `synthetic` and diagnostics skip it. Without
that, the check trips the negated-ordering warning by construction, since it
negates the contract and integer arithmetic makes a computed column nullable
(`nullness-tracking.md`). Warning about a statement the user cannot edit is
noise.

### Phase 4: static discharge, deferred

Deferred, and no longer blocking anything: phase 3 gives an annotation an effect
and phase 2 gives its goals a consumer, so neither waits on this. When taken up,
run a solver over phase 2's script rather than linking one, keeping §11.2's
no-required-dependency rule, at which point `cyk-parser` (§4.2) discharges and
§4.3's variant fails with a message naming the rule and the unprovable formula.
This is where a contract becomes a theorem rather than a checked fact, so it is
what §5's module-interface story waits for. `--strict-contracts` (§2.2, §11.4)
did not wait for it: the warning it promotes exists from phase 1 on, and
promoting one does not depend on anything being discharged, so it shipped with
phase 3.

### Phase 5: documentation — built

Spec §5.11 gains the refinement form, placed after head type annotations rather
than before so the existing references to §5.10 keep resolving. Walkthrough
chapter 7 covers it beside the type system, since a refinement occupies the slot
a type would. `examples/refinements` is the worked program.

## 11 Decisions and residuals

These earlier decisions still apply, with the corrections recorded above. One
decision remains blocking: the first useful delivery slice.

1. **Should `not` around a comparison be warned about?** Decided: yes, and the
   body-position version now warns (`nullable-negated-ordering` in
   `nullness-diagnostics.ts`). Because trichotomy fails (§4.4),
   `_: not (X < 2)` is strictly weaker than `_: X >= 2`, admitting a null `X`.

   This reversed a considered choice rather than filling a gap: the pairing
   warning deliberately did not walk through `!`, "where the complement is the
   point rather than an oversight". Settling it before annotations exist avoids
   the language warning in an annotation while staying silent about the same
   shape three lines below it. Taken provisionally, on the basis that it fires
   nowhere in the corpus today, so its cost if wrong is a warning nobody sees;
   revisit if it turns out noisy.

   The annotation-position version reuses the same predicate, and unlike the
   pairing warning it reads the fully refined nullness set: a negated ordering
   proves nothing about its own operands, so there is no self-refinement to skip,
   and any other conjunct that does prove the operand non-null should silence
   it.
2. **Solver dependency.** Decided: none, ever, as a required dependency. The
   obligation set's public form is SMT-LIB 2 and no phase may assume a
   particular solver (§4.5). `z3-solver` unpacks to about 35 MB, which settles
   it against bundling; cvc5 publishes no WebAssembly package; a floating-point
   LP library cannot discharge a proof obligation soundly. An optional
   in-process checker stays available later precisely because incompleteness is
   safe here.
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
   by default, error under `--strict-contracts`. See §2.2. Also decided: the flag
   is about the checker's advisories as a class, not this one diagnostic, so any
   later advisory it grows is promoted by the same flag rather than gaining its
   own. That keeps one switch between the teaching default and the strict
   reading, and means a new advisory has to be written knowing CI may turn it
   into an error.
5. **What does the REPL do?** Check each obligation once, when the rule owing it
   is entered, and let §2.2's inert-annotation warning fire normally.

   **That answer holds only because of a restriction, and stops holding if the
   restriction is dropped.** `IncrementalSession` rejects extending an existing
   predicate across chunks, "Predicate 'p' was defined in an earlier chunk and
   cannot be extended", so every sibling rule of a predicate arrives together and
   the checker sees the predicate complete. Both §2.1's disjunctive contract and
   §2.2's warning need that: a contract assembled from some of a predicate's
   rules is not the contract, and "some annotated, some not" cannot be judged
   from a fragment. If the REPL ever permits rule-by-rule extension, a later
   chunk could silently weaken a contract an earlier one published, and this
   answer has to be redesigned rather than adjusted.
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
   does not exceed the count of the set" (§9.5).

   What that would take, since the shape recurs: it is a **relation between two
   predicates**, not a property of one predicate's tuples, so it needs a second
   obligation form the way §5's boundary check does. It also needs definitions
   unfolded, since the subset fact lives in how the two bodies differ rather than
   in either contract, which puts it in tier 2 (§7) and gives up §3.3's
   modularity. Concretely, three parts: detect that one aggregate's generating
   body entails another's over the same counted term, check the groupings are
   compatible (a per-group subset against an ungrouped total), then apply
   monotonicity of `count`. The corpus writes exactly this shape at least four
   times, `rank` against `nprop`, `irank` against `ninternal`, and `oprank`
   against `nops`, so the demand is real.

   The cheap alternative, and the one to reach for first, is not to prove it:
   `!- irank(N, R), ninternal(I), R > I.` states the same fact as an integrity
   constraint, costs nothing, and checks it against the data at hand. That is
   what §9.4 already concluded for `cnf-tseitin`'s other invariants.
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
