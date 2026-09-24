# Checking and proving invariants in Datamog

A booking has a room, a start time and an end time. We want its times to be
integers, its start to precede its end, and every booking to receive a result.
Those are three different promises. Datamog has several ways to express them,
and choosing the right one changes what happens to bad data.

This tutorial introduces the checks together: types and nullability, body
conditions, integrity constraints, head refinements, solver verification,
proof terms, and module contracts. It assumes you can read a rule such as
`valid(Id) :- booking(Id, S, E), S < E.` For an introduction to rules, start
with the [walkthrough](../walkthrough/README.md).

The examples use only implemented syntax. General body type guards remain a
[proposal](../design/body-type-guards.md).

## Run the examples

From the repository root, after the [development setup](../../DEVELOPMENT.md):

```bash
bun run datamog --backend native doc/invariants/code/01-filter.dl
```

Each numbered file is an independent program. Input JSONL files live beside
it and load by predicate name. SQLite also runs these examples; using `native`
keeps the focus on the language. Module examples need the CLI or VS Code,
while the other examples can be tried in the playground with their input data.
Z3 is needed only for the commands using `--verify`.

Some examples deliberately fail. The [expected-results table](#expected-results)
at the end distinguishes those failures from mistakes in your setup.

## The choices at a glance

| Mechanism | What it establishes | When it runs | What a failure does |
|---|---|---|---|
| Safety, arity, operator typing, stratification | The program obeys the language's static rules | Before evaluation | Rejects the program |
| Input types, structural contracts and `?` | Loaded cells fit their declared type | At analysis and loading | Rejects an invalid declaration or load |
| Head and constructor payload type annotations | Inference justifies a published type contract | Before evaluation | Rejects an unjustified annotation or incompatible consumer |
| Body comparisons, extraction and `defined` | A particular row satisfies a condition | During evaluation; some conditions also refine static types | Produces no row for a failed condition |
| `!-` and `error predicate` | No counterexample exists in the evaluated relations | After evaluation, before queries | Reports violations and produces no query results |
| Head refinement `_: proposition` | Every resulting tuple satisfies the predicate's combined contract | Checked at runtime by default | Reports violating tuples |
| `--verify` | Supported refinement obligations follow from the encoded rule hypotheses for all admissible inputs | Instead of data evaluation | Reports a counterexample, skipped obligation, unknown result or solver error |
| Proof capture `P : p(...)` | A derivation of that particular relation membership exists | During evaluation | Produces no matching row if no derivation exists |
| Module boundary contracts | A supplied relation fits an interface; module constraints hold on this instance's data | At elaboration/type checking and runtime | Rejects incompatible wiring or reports constraint violations |

A warning is another kind of feedback. Warnings about partial expressions,
vacuous contracts and potentially unbounded recursion help find mistakes, but
normally neither reject the program nor prove an invariant.

## 1. A condition selects rows

Our shared [booking data](code/booking.jsonl) contains one valid interval,
one reversed interval, and one unknown start:

```jsonl
{"id":"ok","start":9,"finish":11}
{"id":"reversed","start":12,"finish":10}
{"id":"missing","start":null,"finish":14}
```

[01-filter.dl](code/01-filter.dl) selects the valid interval:

```prolog
input predicate booking(id: string, start: integer?, finish: integer?).

valid(Id, S, E) :- booking(Id, S, E), S < E.
?- valid(Id, S, E).
```

The result is `("ok", 9, 11)`. The other two input rows are still legal input:
`integer?` admits null, and neither time's type says which one must be earlier.
`S < E` succeeds only on rows where both times are non-null and correctly
ordered. It does not complain about the rows it excludes.

This is appropriate when the question is “which bookings are valid?” It does
not establish “every booking is valid.” A query returning no invalid rows is
also just an observation unless you arrange to treat a nonempty result as an
error.

Body conditions can help static analysis too. With nullable times,
`duration(Id, E - S) :- booking(Id, S, E).` is rejected because subtraction
requires non-null operands. Adding `S < E` proves both operands non-null for
that rule. The inference is independent of conjunct order; putting the
comparison last is fine.

Safety is a different requirement. `valid(S, E) :- S < E.` is unsafe: the
comparison does not enumerate possible times. A positive relation, a binding
range, or an equality to an already-grounded expression must supply them.
Adding type annotations to the head would not bind them either. Safety makes
each rule application draw bindings from available sources; it does not prove
that recursive value construction will terminate.

Arity and dependency checks also run automatically. Calls must use the declared
number of arguments, aggregate predicates cannot be recursive, and recursion
through negation must satisfy stratification or the explicit parity rules.
These checks establish that a program belongs to a supported language fragment;
they do not establish application facts such as “no bookings overlap.”

## 2. A constraint rejects counterexamples

[02-constraint.dl](code/02-constraint.dl) turns the same condition into an
invariant of the run:

```prolog
input predicate booking(id: string, start: integer?, finish: integer?).

error predicate invalid_booking(Id, S, E) :- booking(Id, S, E), not (S < E).
?- booking(Id, S, E).
```

The error relation contains `("reversed", 12, 10)` and
`("missing", null, 14)`. Datamog reports a constraint violation and returns no
query results. It does not return the good booking as a partial success.

An anonymous constraint expresses the same requirement without naming the
counterexample relation. Replace the `error predicate` rule with:

```prolog
!- booking(Id, S, E), not (S < E).
```

Use a named error predicate when a descriptive name or a chosen set of witness
columns will make the violation easier to diagnose. Both forms can express
relationships across tuples and predicates, such as foreign keys, uniqueness,
non-overlapping bookings, and required output coverage. For example, these are
rule fragments to add to a program declaring the referenced relations:

```prolog
!- booking_room(Id, Room), not room(Room).
!- booking_room(Id, R1), booking_room(Id, R2), R1 <> R2.
```

The second forbids two different rooms for one booking ID. Identical duplicate
facts already collapse under set semantics; this constraint detects conflicting
values, not repeated source lines.

### Negation matters when a value is missing

Replacing `not (S < E)` with `S >= E` would miss the null row. An ordering with
a null operand has no value, so neither ordering holds there. Negation as
failure, `not`, succeeds whenever its body condition does not hold.

Logical `!` is different: `!(S < E)` also has no value at that null. To reject
all failures of a condition, including undefinedness, use `not (condition)`.

The general pattern is:

```prolog
# Fragment: reject every candidate for which the property does not hold.
!- candidate(X), not property(X).
```

The positive `candidate` relation supplies the finite domain over which the
requirement is checked. Without it, the variable under negation would be unsafe.

## 3. Types check a different layer of the promise

[04-types.dl](code/04-types.dl) replaces separate columns with a structured
request. Here is its declaration and its first result rule:

```prolog
type Request = {room: string, start: integer, finish: integer,
                organizer: string?, note?: string}.
input predicate request(payload: Request).

summary(upper(R["room"]): string, R["start"] + 1: integer) :- request(R).
```

The alias is a reusable spelling of the shape, with no separate identity. The
loader checks each object against it. Records are closed: extra fields are
rejected. Missing required fields or a string where an integer is required are
load errors. The [sample requests](code/request.jsonl) illustrate the two
independent uses of `?`:

- `organizer: string?` requires the field and permits its value to be null.
- `note?: string` permits the field to be absent, but its value must be a string
  when present. `note?: string?` would permit both absence and null.

Arrays can have contracts too: `[integer]` admits arrays of integers,
`[integer?]` permits null elements, and `[integer]?` permits a null array.
A top-level `value` contract accepts any non-null JSON shape; `value?` also
accepts a bare null. The same rule holds at nested positions: `[value]` excludes null
elements, while `[value?]` permits them. `{x?: value}` allows `x` to be
absent, but requires a non-null value when present; `{x?: value?}` also
allows an explicit null. A `value` remains opaque, so its children can
contain null: `{x: value}` accepts `{"x": {"child": null}}`.

The declaration provides enough information to use `R["start"]` directly in
arithmetic and `R["room"]` in `upper`, which produces an uppercase room name. The second sample request still has its finish before its start:
it passes this shape check. Use a constraint or refinement for that relation
between fields.

### A head annotation checks what inference can establish

The annotations on `summary` are checked statically against the values its rule
can produce. An integer contribution may be declared `float` or `value`, but
an opaque `value` cannot be declared `integer` merely because this particular
input file happens to contain integers.

An annotation does not cast a value or add a runtime assertion. It publishes
what consumers may assume. Declaring a structured producer as `value` hides its
field precision; a consumer then needs explicit extraction to use a field
numerically. Conversely, a published float field can control the consumer's
scalar extraction. Producer storage is still based on inference.

For example, this complete program is deliberately rejected:

```prolog
opaque({"start": 9}: value).
claimed(X: {start: integer}) :- opaque(X).
?- claimed(X).
```

The implementation of `opaque` has that field, but its advertised contract
withholds the guarantee. Head annotations cannot inspect rows and select only
those with a matching shape. Structural inference is also bounded: an annotation
can fail because inference cannot prove it, not only because an actual bad value
has been found.

Sibling rules can widen an unannotated column to heterogeneous `value`.
`p(1). p("one").` is legal. To insist on integers, annotate each rule's
contribution; annotating only one sibling does not impose its annotation on the
others. Within one rule, sharing a variable between incompatible nonnullable
integer and string columns is instead a type error: that one value must satisfy
both requirements.

Input formats affect validation too. JSONL uses native JSON types; CSV can
coerce canonical numeric text. A CSV `string?` cell containing an empty string
remains a string and cannot represent null. See [data loading](../spec.md#7-data-loading)
for those boundary rules.

## 4. Extraction can implement a scalar check

When heterogeneous data is intentional, [05-extraction.dl](code/05-extraction.dl)
selects its integer leaves:

```prolog
input predicate raw(payload: value?).

integers(N) :- raw(X), N = as_integer(X).
output predicate unusable(X) :- raw(X), not defined(as_integer(X)).
?- integers(N).
```

The [input](code/raw.jsonl) contains `3`, `"3"`, `null`, `{}`, and `3.5`.
The default query returns just `3`. Run with `--all` to see the four other
values under `unusable`.

`as_integer` checks a numeric leaf, including whether it is an integer within
the safe-integer range. It does not parse a string. For text such as `"3"`,
`to_integer` is the separate conversion operation. Both have no value on a
failed check. The equality binds `N` only where extraction succeeds.

If invalid payloads should reject the run instead, change `output predicate
unusable` to `error predicate unusable`. This small change is the distinction
between reporting rejected rows and enforcing an input invariant.

There is currently no general `X is T` runtime type guard. A body `P : valid`
is a proof capture, introduced below, not a type assertion. The
[body-type-guards proposal](../design/body-type-guards.md) discusses why those
operations need distinct spellings.

## 5. Definedness and completeness need their own checks

A null is a value. A failed computation has no value at all.
[06-definedness.dl](code/06-definedness.dl) makes the distinction observable:

```prolog
amount("ok", 8, 2).
amount("zero", 8, 0).

ratio(Id, N / D) :- amount(Id, N, D).
output predicate lost(Id) :- amount(Id, N, D), not defined(N / D).
?- ratio(Id, Q).
```

The default result is `("ok", 4)`. There is no ratio for `"zero"`; it does
not become a row with null. `--all` also reports `"zero"` under `lost`.

`defined(E)` is true when `E` has a value and itself undefined otherwise;
it never returns false. `not defined(E)` is how to select the failures.
`defined(X)` on a bound variable is always true, even when X is null.
Use `X <> null` to ask whether that value is non-null.

To require every source row's division to be defined, add:

```prolog
!- amount(Id, N, D), not defined(N / D).
```

To require a result for every source ID, the more general coverage check is:

```prolog
!- amount(Id, _, _), not ratio(Id, _).
```

These promises differ if several source rows share an ID. One successful ratio
satisfies coverage for that ID even when another source row's division fails.
Choose witness keys that identify what you actually require a result for.

Neither an integer result type nor a proposition about produced ratios proves
coverage. Both can be satisfied by an empty output. The optional
`--warn-undefined` flag points out potentially partial expressions; it does not
replace either of these constraints.

## 6. A refinement attaches a proposition to a relation

[03-refinement.dl](code/03-refinement.dl) keeps the interval invariant beside
its definition:

```prolog
input predicate booking(id: string, start: integer?, finish: integer?).

interval(Id, S, E, _: S < E) :- booking(Id, S, E).
?- interval(Id, S, E).
```

The `_` refinement position is erased. `interval` has three columns, and callers
pass three arguments. This is unlike `S: integer`, which annotates a real column.
A refinement can mention head positions; a computed position needs an `as` name
before a proposition can refer to it.

During an ordinary run, the refinement becomes a constraint check after the
relation is evaluated. The same reversed and null-start rows fail as in
`02-constraint.dl`. The annotation does not filter them out. A proposition must
hold: false, null, or an undefined result all count as failure.

Adding `S < E` to the body would make the output invariant hold by construction,
but would still discard bad bookings. If the invariant is about *all input
bookings*, keep the constraint over the input or add a coverage check.

### Several rules mean alternative contracts

The runtime contract is the disjunction of the rules' contracts. Multiple
refinements on one rule conjoin. An unrefined sibling contributes `true`, so
[11-vacuity.dl](code/11-vacuity.dl) accepts both of these rows:

```prolog
interval(9 as S, 11 as E, _: S < E).
interval(12, 10).
?- interval(S, E).
```

Datamog warns that the first claim has become vacuous. Run with
`--strict-contracts` to make that advisory fatal. This flag promotes contract
advisories; it does not invoke a solver or make ordinary type checks stronger.

Even if every rule is refined, the runtime check is over the combined relation.
Contracts `X >= 0` and `X < 0` on two alternatives jointly admit every non-null
integer. That is useful for a relation with genuinely different cases, but it is
not a runtime check that each tuple satisfies the claim on the particular rule
that produced it. If all rows must satisfy the same property, put it on every
rule or write a separate integrity constraint.

## 7. Ask a solver whether the claim follows from the rules

[08-verify.dl](code/08-verify.dl) introduces a computation with a refinement:

```prolog
input predicate sample(n: integer).

successor(X, X + 1 as Y, _: Y > X) :- sample(X).
?- successor(X, Y).
```

With the supplied [sample data](code/sample.jsonl), ordinary execution produces
`(0, 1)` and `(4, 5)` and checks the claim on those tuples. With Z3 on PATH:

```bash
bun run datamog --verify doc/invariants/code/08-verify.dl
```

The result is:

```text
proved   successor rule 1: Y > X

1/1 discharged.
```

This command does not run the data and then try more test cases. It asks whether
the rule hypotheses can hold while the proposition fails. An SMT solver answers
`unsat` when no such counterexample exists, which discharges the obligation.
The check ranges over the encoded integer domain, independently of the current
JSONL rows.

To inspect the obligations without invoking a solver:

```bash
bun run datamog --obligations doc/invariants/code/08-verify.dl
```

`--solver "cvc5 --lang smt2"` is an alternative solver command and implies
`--verify`. The encoding uses `QF_LIA`, widening to `QF_NIA` for supported
nonlinear integer arithmetic. These are SMT-LIB logic names, not extra
Datamog syntax.

### What the proof does not say

At the largest safe integer, `X + 1` has no value and the rule emits no tuple.
The proof remains valid: every *produced* successor exceeds its predecessor.
It does not prove every input has a successor. Head definedness is a hypothesis
of the obligation, and free integer variables are bounded to Datamog's
safe-integer domain. Use a runtime coverage constraint when totality matters.

The verifier generates obligations for head refinements. It does not prove
arbitrary `!-` or `error predicate` assertions, all data-loading assumptions,
termination, or equivalence between a program and an external specification.
Ordinary evaluation is still needed for data-dependent constraints.

### A dataset can pass while the proof fails

[09-data-property.dl](code/09-data-property.dl) uses the same nonnegative sample
file but makes a stronger assertion about its input:

```prolog
input predicate sample(n: integer).

nonnegative(X, _: X >= 0) :- sample(X).
?- nonnegative(X).
```

Ordinary execution passes. `--verify` reports `FAILED`: the input type admits
negative integers, and nothing in the rule excludes them. The solver's
counterexample need not occur in the loaded file.

If negative inputs should be selected out, add `X >= 0` to the body. If they
should be rejected, retain a runtime constraint over the input. Merely adding
another asserted refinement moves the proof obligation to that producer; it
cannot turn an unrestricted input into a theorem.

### Read the entire verification result

| Result | What you know |
|---|---|
| `proved` | The encoded obligation was discharged |
| `FAILED` | There is a counterexample to the encoded obligation; missing hypotheses or the abstraction of called relations can make it unreachable in your program |
| `skipped` | The encoder does not cover a required construct |
| `unknown` | The solver could not decide the obligation |
| `ERROR` or a command error | Verification failed operationally |

An unsupported goal involving float, string or JSON reasoning is skipped, as
is an aggregate rule. [12-aggregate.dl](code/12-aggregate.dl) checks a nonnegative
total successfully on the sample data, but its aggregate refinement is `skipped`
by `--verify`.

Unsupported *hypotheses* are handled differently: they can be omitted, leaving
less information with which to prove the goal. Range bounds currently contribute
no hypotheses. For example, [13-range-limit.dl](code/13-range-limit.dl) is valid
and passes its runtime check:

```prolog
bounded(N, _: N >= 0) :- N in [0 .. 3].
?- bounded(N).
```

Its verification nevertheless reports `FAILED`, because the encoding does not
use the range's lower bound. Replacing the range is not required for correct
execution. This is a limitation of the current proof abstraction, and the
reported negative N is not a possible result of this program.

The command exits nonzero unless every generated obligation is discharged.
However, “No refinement contracts to discharge” also exits successfully. In
particular, an unrefined sibling can leave no obligations for that predicate.
Check the obligation count and use `--strict-contracts` to catch vacuous claims;
a zero-obligation success is not evidence for your intended invariant.

## 8. Recursive contracts supply an induction hypothesis

[10-induction.dl](code/10-induction.dl) derives the integers zero through three:

```prolog
step(0 as N, _: N >= 0).
step(N + 1 as Next, _: Next >= 0) :- step(N), N < 3.
?- step(N).
```

Both obligations are proved:

```bash
bun run datamog --verify doc/invariants/code/10-induction.dl
```

```text
proved   step rule 1: N >= 0
proved   step rule 2: Next >= 0

2/2 discharged.
```

The base rule establishes the property for zero. The recursive rule assumes it
for `step(N)` and establishes it for the new tuple. A rule may assume the
refinement contract of a positive callee, including itself; a negated call
supplies no such hypothesis. The assurance depends on discharging the producer
obligations too. An isolated `proved` line is not enough if another rule failed
or was skipped.

This is induction on derivations. It is separate from termination. The
`--warn-finiteness` analysis warns about value-producing recursion conservatively
and can warn even on this bounded example. `--max-iterations N` on the in-memory
backends is a runtime cap, not a proof: stopping early returns partial results
with a note. Such a run cannot establish that no later iteration would produce
a counterexample. Evaluate to convergence before relying on a fixed-point check.

## 9. A proof term records a derivation

The word “proof” also appears in another feature. In
[07-proofs.dl](code/07-proofs.dl), a named rule records evidence for accepted
bookings:

```prolog
booking("ok", 9, 11).
booking("reversed", 12, 10).

valid(Id, S, E) :: Checked(S: integer, E: integer) :-
    booking(Id, S, E), S < E.

evidence(Id: string, P: valid) :- P : valid(Id, _, _).
?- evidence(Id, P).
```

Only `"ok"` receives evidence, rendered as `Checked(9, 11)`.
There are several distinct constructs here:

| Spelling | Meaning |
|---|---|
| `:: Checked(...)` | Construct a proof node when this named rule derives a tuple |
| `S: integer` in its payload | Statically check and publish the constructor argument's type |
| `P: valid` in the head | Statically check nominal provenance: P is a proof of the predicate `valid` |
| `P : valid(Id, _, _)` in the body | Match an existing derivation and bind its proof to P |

The body capture is relational: it can enumerate derivations or constrain a
previously bound proof. `P : valid` abbreviates a capture ignoring all ordinary
columns. An ordinary call `valid(Id, S, E)` instead leaves the proof implicit.
Constructor patterns such as `P = Checked(S, E)` match existing proofs; they do
not build new ones.

Nominal types distinguish producers even when their JSON shapes look alike.
An ordinary JSON object with matching `$proof` and `args` fields cannot justify
a nominal head annotation, and external input declarations cannot claim nominal
proof types. Validated module wiring can carry them.

This evidence says *which derivation exists*. It is not an SMT proof that every
booking is valid, and a nominal `valid` annotation does not encode the particular
start/end arguments. The rule defining `valid` supplies the condition; an
additional rule accepting other cases would change the evidence available.
Proof terms and solver discharge answer different questions, and neither alone
establishes coverage of all input bookings.

## 10. Modules combine interface types with data-dependent laws

The [module example](code/modules/main.dl) wires a candidate relation into a
small interface. Its [module](code/modules/nonnegative.dl) is:

```prolog
input predicate point(n: integer).
error predicate negative(X) :- point(X), X < 0.
output predicate accepted(X: integer) :- point(X).
```

The caller is:

```prolog
candidate(2).
candidate(4).

input predicate checked(n: integer) := accepted from "nonnegative.dl"(point = candidate).
?- checked(N).
```

Run it from the repository root:

```bash
bun run datamog --backend native doc/invariants/code/modules/main.dl
```

The result contains `2` and `4`. Now consider two different changes:

- Changing the receiving declaration to `checked(n: string)` makes its output
  boundary fail statically: the module publishes integers. Boundaries compare
  published types, including structural and nominal contracts, and also check
  arity and polarity.
- Adding `candidate(-1).` preserves the type but violates the module's runtime
  law. Its `error predicate` travels into the caller, so the run fails before
  returning query results.

The first check concerns what an implementation promises its caller. The second
concerns the data supplied to this instance. Module constraints are checked per
instance; identical module/input wiring shares an instance. Type aliases are
file-local spellings, while proof identities follow module elaboration and
instance sharing. None of this automatically turns module laws into solver
obligations.

## Choose the promise before choosing the syntax

For the booking application, a useful progression is:

1. Declare primitive or structural input types to establish representation and
   nullability at the loading boundary.
2. Use head and constructor payload annotations to publish the type guarantees
   you want consumers to rely on.
3. Use body conditions and extraction where selecting a subset is intentional.
4. Write constraints for invalid data, cross-row relationships, and missing
   outputs that must reject the run.
5. Put refinements on derived relations to state properties of their tuples.
   Cover every defining rule and enable `--strict-contracts`.
6. Use `--verify` where the supported encoding can establish those refinements
   independently of a particular input file; inspect every verdict and count.
7. Capture proof terms when downstream rules need derivation evidence, and use
   module boundaries to combine type guarantees with per-instance laws.

In a REPL, constraints are checked once when introduced, not continuously
rechecked after later chunks. For a whole-program invariant check, run the
complete program on the complete input. Backend limitations also remain in
force; static acceptance and solver discharge do not establish that every SQL
backend can evaluate a program. See the [specification](../spec.md).

## Expected results

For ordinary runs, use `bun run datamog --backend native <file>`. All paths
below are relative to this tutorial directory; prepend `doc/invariants/`
when running from the repository root. Output row order is not significant.

| File | Ordinary run | Additional check |
|---|---|---|
| [01-filter](code/01-filter.dl) | Only booking `ok` | Reversed and null-start rows are filtered |
| [02-constraint](code/02-constraint.dl) | Constraint violation, two witnesses | No query output |
| [03-refinement](code/03-refinement.dl) | Constraint violation, two witnesses | Same data invariant as 02 |
| [04-types](code/04-types.dl) | `("BLUE", 10)`, `("GREEN", 13)` | `--all` also shows the one present note |
| [05-extraction](code/05-extraction.dl) | Integer `3` | `--all` also reports four unusable values |
| [06-definedness](code/06-definedness.dl) | Ratio `("ok", 4)` | `--all` also reports lost ID `zero` |
| [07-proofs](code/07-proofs.dl) | Evidence for `ok` only | Proof payload is `Checked(9, 11)` |
| [08-verify](code/08-verify.dl) | `(0, 1)`, `(4, 5)` | `--verify`: 1/1 discharged |
| [09-data-property](code/09-data-property.dl) | `0`, `4`; runtime contract passes | `--verify`: counterexample, nonzero exit |
| [10-induction](code/10-induction.dl) | `0`, `1`, `2`, `3` | `--verify`: 2/2 discharged |
| [11-vacuity](code/11-vacuity.dl) | Both intervals, with an advisory | `--strict-contracts`: nonzero exit |
| [12-aggregate](code/12-aggregate.dl) | Total `4` | `--verify`: skipped, nonzero exit |
| [13-range-limit](code/13-range-limit.dl) | `0`, `1`, `2`, `3`; runtime contract passes | `--verify`: counterexample because range hypotheses are omitted |
| [modules/main](code/modules/main.dl) | `2`, `4` | Adding a negative candidate violates the module law |

## Try changing the promises

1. Change `02-constraint.dl` to use `S >= E`. Which counterexample disappears,
   and why? Restore `not (S < E)` to include the null-start booking.
2. Add a second `amount` row with ID `zero` and a nonzero divisor to
   `06-definedness.dl`. The ID coverage constraint now passes for that ID,
   while the per-row definedness constraint still fails.
3. Add `X >= 0` to the body of `09-data-property.dl` and run `--verify` again.
   It should prove, but it now selects out negative inputs. Add a separate
   error predicate if those inputs must instead reject the run.
4. Annotate the second interval in `11-vacuity.dl` with the same `S < E`
   property using `as` names. The advisory disappears and a real constraint
   violation replaces it.

For more detail, continue with [safety and types](../walkthrough/07-safety.md),
[structured values](../walkthrough/14-json.md),
[proof terms](../walkthrough/15-proof-terms.md), and
[modules](../walkthrough/16-modules.md). The
[binary-search example](../../packages/cli/examples/binary-search/binary-search.dl)
shows a larger recursive invariant discharged by the verifier.
