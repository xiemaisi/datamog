# Body type guards and proof captures

Status: unimplemented proposal. This document records the motivation and syntax
tradeoffs; it recommends runtime type guards with an explicit spelling distinct
from proof captures. The spelling, supported type forms, and nominal membership
semantics remain open. Examples marked proposed are not current Datamog syntax.

## Motivation

An input can contain heterogeneous JSON values:

```prolog
input predicate item(payload: value).
```

A rule may want to keep only integer payloads and use them in arithmetic. Today,
scalar extraction can express this:

```prolog
incremented(N + 1) :- item(X), N = as_integer(X).
```

A general type guard could extend that idea to record and array shapes, while
making the refined type available on the original variable. For example, using
an illustrative spelling that is **proposed, not implemented**:

```prolog
names(X["name"]) :- item(X), X is {name: string}.
```

This would retain rows whose payload has the required shape and let the checker
use the string field. The record's additional-field policy would follow the
existing declaration type rules; a closed record would reject extra fields.

Putting `X: {name: string}` in the head does not achieve this. A head annotation
requires inference to prove that every value produced by that rule already
satisfies the contract. It cannot select matching rows from an opaque `value`.

The natural question is whether a body guard should use the same colon syntax:

```prolog
# Proposed body type guard, not implemented:
names(X["name"]) :- item(X), X : {name: string}.
```

That syntax resembles an existing body construct with a different meaning:
proof capture.

## Existing constructs

The following is valid today:

```prolog
nat(0) :: Zero().
nat(N + 1) :: Succ(P: nat) :- P : nat(N), N < 2.
selected(P: nat) :- P : nat.
```

In the last rule the two occurrences of `P: nat` have related but distinct jobs:

- In the head, `nat` is a nominal type. The annotation checks the rule's
  contribution and publishes a contract to consumers.
- In the body, `nat` is a predicate. The capture enumerates its existing
  derivations and binds their proofs to `P`.

| Property | Head type annotation | Body proof capture |
|---|---|---|
| Right-hand side | Type expression | Predicate application, possibly abbreviated |
| Binding | Does not supply a value for the annotated variable | Can bind the proof variable and ordinary argument variables |
| Static effect | Checks inference and publishes a consumer contract | Provides type information from the matched relation and its proofs |
| Runtime effect | No runtime assertion or cast | Requires a matching derivation; no match means no result |
| Arguments | `nat` names the predicate's proofs generally | `nat(N)` constrains the ordinary predicate columns too |

Neither form constructs a proof. Named rules construct their proof nodes through
`:: Ctor(...)` when they derive tuples. Constructor payload annotations, such as
`Succ(P: nat)`, follow the same checked-contract model as head annotations.

A proof capture must refer to a positive atom of a proof-carrying predicate.
`P : nat` abbreviates `P : nat(_)` here, ignoring the one ordinary column.
`_ : nat` suppresses that sub-proof from the enclosing constructor. These are
existing behaviors that an extension should preserve.

## What would a body type assertion mean?

Two features could reasonably be called a type assertion.

### Static assertion

A static assertion would require inference to establish that a bound value fits
a type, rejecting the program otherwise. It would neither filter runtime rows
nor justify narrowing an opaque `value` to a record or scalar type. This resembles
head annotation checking, but a body-local check need not publish any new output
contract.

This could document an invariant or locate a diagnostic, but would not solve the
heterogeneous-input example above.

### Runtime type guard

A runtime guard would hold when a bound value satisfies a type. A mismatch would
filter out a row rather than reject the whole program or raise a runtime error.
On surviving rows, analysis could refine the variable's type for the whole body.

This is the recommended direction because it supports selection and safe use of
heterogeneous data. It needs an explicit runtime membership definition; the
existing conservative static subtype checker is not itself a runtime validator.

A guard would not coerce the value or enumerate all values of a type. Another
body element must bind its subject. Like existing safety and nullness reasoning,
this must be independent of conjunct order: putting the guard before the binding
atom should not change the rule's meaning.

Successful refinement could affect operand extraction and SQL generation without
changing the stored value. SQL must guard partial operations safely; textual
ordering of WHERE conditions cannot establish an evaluation-order guarantee.

## Where colon becomes ambiguous

Primitive names, structural shapes, and predicate applications can often be
distinguished syntactically:

```prolog
# First two lines are proposed; the third is an existing proof capture.
X : integer
X : {name: string}
P : nat(N)
```

The difficult case is the existing shorthand:

```prolog
P : nat
```

`nat` is both a proof-carrying predicate and an allowed nominal type name. The
same text could therefore mean either of the following:

| Interpretation | Unbound `P` | Bound `P` |
|---|---|---|
| Proof capture | Enumerates proofs and binds `P` | Joins against proofs in the current `nat` relation |
| Nominal type guard | Requires a separate binding source | Checks membership in the nominal type, under a membership definition still to be chosen |

The distinction matters for externally loaded proof values. A validator can check
a predicate identity and constructor payload shape without establishing that the
value is a derivation present in the current relation. Such validation must not
silently replace the relational condition expressed by a proof capture.

Nor does a guard for nominal `nat` inherently check a particular ordinary
argument such as `nat(2)`. Parameterized nominal types are not part of this
proposal.

## Alternatives

### Resolve the colon by the right-hand name

Preserve predicate names as captures; treat primitive names, shapes, and type
aliases as guards. This preserves existing captures but makes transparent aliases
surprising:

```prolog
type NatProof = nat.
# Under this alternative:
P : nat       # capture
P : NatProof  # type guard
```

An alias should not silently change enumeration into validation. Rejecting
predicate/alias name collisions does not resolve this issue: these names are
unambiguous individually, but denote the same nominal type.

### Resolve the colon by whether the variable is bound

Treat an unbound variable as a capture and a bound variable as a guard. This
would change the meaning of existing bound captures. It would also make semantic
interpretation depend on binding analysis, despite conjunctions being unordered.
This alternative is not recommended.

### Require parentheses for proof captures

Reserve `P : nat` for a type assertion and require `P : nat(_)` for captures.
This separates the forms, but breaks existing shorthand and does not explain why
the two uses of the colon have different binding behavior. A compatibility break
is not justified by this proposal.

### Give guards a distinct spelling

Preserve all existing colon captures and introduce an explicit guard form, for
example `X is T` or `has_type(X, T)`. These are candidate spellings only. A
function-like form would need a type-expression argument in the grammar, rather
than treating `T` as an ordinary value expression.

This is the recommended approach. It makes selection explicit, preserves
existing programs, and leaves room to decide whether nominal guards should be
supported without overloading relational proof capture.

## Open decisions and implementation boundaries

Before implementation, settle:

- The spelling and whether guards initially accept only variables or arbitrary
  expressions. Variables are sufficient for the motivating examples.
- Which declaration types are supported. Aliases should expand transparently;
  scalar, nullable, record, and array membership must match their documented
  contracts. Numeric membership must agree with existing scalar extraction rules.
- Whether nominal guards are included. If included, distinguish shape/identity
  validation from membership in the current derived relation, including recursive
  payload validation and module-qualified identities.
- Null and absence: proposed guards on absent expressions would not hold; null
  is a value and would match only types that admit it. Keep declaration nullability
  separate from the inference engine's internal universal type.
- How refinement combines with other constraints, published contracts, and
  recursive inference. A producer's inferred precision must not bypass its
  published contract; narrowing must be justified by the guard.
- Negation: a negated guard must not bind variables. Complement-type refinement
  and guards inside compound Boolean expressions need separate decisions.
- Runtime validation limits and diagnostics. Resource exhaustion must not be
  mistaken for a successful match or silently treated as a type mismatch.

An implementation would touch parsing, safety, semantic inference, operand
lowering, SQL translation, and both interpreters, as well as REPL/editor support.
Validation should cover conjunct reordering, unsafe unbound guards, heterogeneous
inputs, aliases, null versus absence, closed/optional record fields, nested arrays,
and parity across supported backends. Existing captures must retain their binding
and suppression behavior. Nominal support would additionally need tests that
distinguish well-shaped external proofs from derivations in the current relation.

This proposal does not introduce proof construction, parameterized types,
standalone datatypes, or changes to head and constructor annotation contracts.

## Related documents

- [Language specification](../spec.md), §§5.10 and 8.3: head annotations and proof captures.
- [Semantic types](semantic-types.md): structural types, nominal identities, and published contracts.
- [Constructor payload contracts](proof-signature-contracts.md): nominal type names and payload annotations.
- [Null as a value](null-as-a-value.md): null, absence, and refinement of body variables.
