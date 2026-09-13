# Constructor payload contracts

Status: proposal, not implemented. Type annotations on constructor arguments after
`::`, and the companion `proof P` type syntax below, are proposed extensions.
Existing programs retain their current behavior.
This extends the [semantic type foundation](semantic-types.md); it does not add
independent datatypes, freely constructible terms, or a finiteness guarantee.

## Motivation: what does a constructor promise its callers?

Suppose a module produces invoice proofs. The invoice's total lives in the
constructor payload, rather than an ordinary predicate column:

```prolog
output predicate invoice() :: Invoice({"total": 42}).
```

A caller matches the proof and uses that total in arithmetic:

```prolog
tax(Total * 0.05) :- P : invoice, P = invoice::Invoice(Details), Total = Details["total"].
```

This already works. Inference discovers that `Invoice` carries a record with an
integer `total`, and the caller can use that field as an integer. No signature is
needed to infer or run this program.

But suppose the module author intends to promise: **every `Invoice` payload has a
numeric `total`, and callers must allow fractional totals**. Today that promise
is not written anywhere the type checker can enforce. Callers see the current
implementation's integer type. Changing `42` to `42.5` changes their inferred
contract; accidentally changing it to `"42"` makes the caller's arithmetic fail
type checking. The producer alone still checks, since deriving an invoice with a
string total is a valid program. Nothing states that it broke its intended API.

An annotation on the constructor argument makes that promise explicit at the producer:

```prolog
output predicate invoice()
  :: Invoice({"total": 42}: {total: float}).
```

The checker would accept the integer payload, since integer is a subtype of float,
and publish the declared float field to callers. A later fractional total would
still satisfy the same contract. A string total or a missing `total` field would
be rejected at the producer, even when checking the module without any callers.
The annotation does not change the stored payload or construct another proof.

An ordinary head annotation cannot express this particular promise: `invoice()`
has no ordinary head arguments to annotate. The record belongs to `:: Invoice(...)`,
and its inferred signature lives in the proof registry. Allowing the same annotation
syntax on that argument gives it a public contract beside its implementation. It
also lets an author publish a payload as `value` when callers should not depend on its current
shape; callers would then need explicit extraction before scalar operations.

This is an optional API-design feature, not a missing requirement for using proof
terms. Small programs can keep relying on inference. An author could also move the
total into an ordinary annotated column or route payload construction through a
typed helper predicate. The motivation for new syntax is to state the contract
directly on the constructor when proof payloads are the interface a module exposes.

## Scope

Extend the existing head-annotation model to explicit constructor payload arguments:
check each annotation against inference, then publish its declared generality to
callers. Annotations are optional and independent per argument. Unannotated arguments
retain their inferred publication policy, including when another argument of the
same constructor is annotated.

There is no standalone signature declaration or repeated list of constructors.
The rules continue to determine which constructors exist and their payload arities.
The existing rule that a constructor tag is unique within its predicate remains;
this proposal does not allow several rules to define the same constructor.

Primitive, structural and alias annotations solve the motivating problem by
themselves. Nominal `proof P` references are a companion type extension, described
below, and can follow separately. Per-consumer signature views, constructor hiding
and interfaces declared separately from their rules are outside this proposal.

## Proposed syntax

An explicit argument after `::` may carry `: type`, just like a head argument:

```prolog
item() :: Item({"name": "Ada", "score": 1}: {name: string, score?: float}, "receipt").
```

Here the first payload argument publishes the declared record shape, with a float
score that may be absent; the second retains its inferred string type. The annotation
applies to the payload expression immediately before it. Nullable and alias types
use their existing spelling, for example `X: integer?` or `Details: InvoiceDetails`.
The constructor builds exactly the payload expressions specified by its rule.

Annotations are legal only on the explicit payload list in a rule's `:: Ctor(...)`
suffix. They do not add annotations or casts to ordinary constructor-match terms in
heads, equalities or nested expressions. Existing matches remain matches.

Bare `:: Ctor` continues to select witnesses and sub-proofs automatically. To
annotate one of those payloads, write the explicit argument list in the desired
order. There is no annotation of an implicit payload position in the first version.
`:: Ctor()` still specifies an empty payload and has nothing to annotate; a rule
using that form or the bare form needs no declaration elsewhere.

The companion `proof P` type denotes the nominal proof type of predicate `P`:

```prolog
output predicate nat(0) :: Zero().
nat(N + 1) :: Succ(P: proof nat) :- P : nat(N), N < 2.

type NatProof = proof nat.
selected(P: NatProof) :- P : nat(_).
```

Once added, `proof P` is allowed wherever a declaration type is allowed, including
aliases and nested records/arrays; `proof P?` includes null. `proof` should be
contextual in type positions. Field optionality and expression absence remain
separate. Without the annotation, `Succ(P)` already infers its nominal payload type;
the annotation expresses a checked promise rather than creating that identity.

## Checking and publication

Each annotated argument's inferred payload contribution must satisfy its declared
type directionally: inferred is a subtype of declared. Check contributions before
publication replaces them with their contracts. A required record field must be
proved present; a nullable contribution cannot satisfy a non-null claim. Work-limit
fallback supplies no additional evidence. Checking must not use the argument's own
annotation as evidence that its expression satisfies that annotation.

Keep the private registry inferred. Build the published registry with the declared
types at annotated positions and the published-context inferred types elsewhere,
retaining exact nominal identities. Other predicates, transitive forwarders, operand
lowering and module boundaries consume published payloads. The producer's own rules
retain the existing inferred-self treatment; calls to other predicates, including
mutually recursive ones, use those predicates' contracts. A predicate may have a
mix of annotated and unannotated constructors without requiring a complete interface.

For example, `item() :: Item(42: value).` publishes its integer payload as opaque
`value`. A caller matching `item::Item(X)` must explicitly extract an integer before
arithmetic on `X`; private knowledge of the literal cannot leak through forwarding
rules or the constructor registry. This applies even when the same nominal proof
is carried by an ordinary, non-proof-carrying predicate. Unannotated positions must
also respect contracts of producers they consume; omitting an annotation does not
recover hidden private precision.

Recursive payload references remain nominal graph edges, not recursive structural
aliases. Self and mutual references resolve after collecting all predicate identities.
Validate registry closure without unfolding those edges. An annotation does not
assert that its constructor has a nonempty extension.

## Nominal identity and module boundaries

`proof P` resolves to an elaborated predicate identity, never merely a source name
or matching constructor spelling. Elaborate these references using exactly the
same substitutions as proof captures and constructor qualifiers:

- Freshen private predicates and their annotation references per module instance.
- Rewrite self references when a selected proof-carrying output is renamed to its
  receiving predicate.
- Apply final shared-instance name aliases to all nominal references, including
  references expanded from type aliases.
- Preserve identity through ordinary forwarding predicates; carrying a proof of
  `P` does not turn it into a proof of the forwarding predicate.

Identical module identity and input wiring share the existing instance and proof
identity. Different instances have different identities even when their signatures
are structurally identical. Payload annotations do not change instance keys.

A receiving declaration still counts the implicit trailing proof column. For the
`nat` module above, the proposed receiving contract is:

```prolog
input predicate local(n: integer, evidence: proof local) := nat from "nat.dl"().
```

Here `proof local` names the selected output after renaming; it does not introduce
a fresh datatype. Every receiving boundary is checked, including a second binding
that shares the first binding's instance. Elaboration must retain each boundary's
contract even though the selected relation and its final name are shared.

For a wired module input, a nominal reference to that input is substituted with
the actual predicate identity. The actual column must already carry that exact
proof type. A predicate that merely forwards proofs of another predicate does not
satisfy a self-proof requirement; its proof identity remains the original one.
Ordinary column arity, primitive storage and nullness checks still apply.

A consumer cannot annotate a constructor match to change a wired producer's
published signature. Payload annotations attach to the producer's rule suffix.
Later support for abstract input signatures would require contracts on boundary
views, not overwriting a global registry entry keyed by the actual identity:
several consumers may require different views of the same producer.

No new export namespace is introduced for aliases or constructors. Nominal references
to private helpers remain freshened internal identities; their source names do not
become names importers can write. This proposal does not promise constructor privacy
beyond the module system's existing behavior.

## Proof membership and external data

A nominal annotation checks provenance already established by semantic inference.
It never casts a JSON object to a proof, tests a tag at runtime, or inserts the
object into the referenced predicate's extension. Existing constructor terms remain
matches, including when they appear in heads or nested constructor arguments.

```prolog
# Rejected: structural JSON cannot establish the nominal type.
forged(P: proof nat) :- P = {"$proof": "nat::Zero", "args": []}.
```

A data-file binding or free externally loaded input cannot declare a nominal proof
contract, even nested inside an optional field or array. Reject such declarations
before loading, rather than making validity depend on which rows happen to arrive.
Module bindings and wired inputs are allowed because inference checks their sources.
This applies to direct backend insertion as well: runtime JSON validation must not
become an unchecked path around the restriction. Untyped `value` inputs retain
existing behavior and gain no nominal evidence from their contents.

## Acceptance and rejection cases

| Case | Required result |
| --- | --- |
| Integer payload declared float | Accept; consumers see float |
| Integer payload declared string | Reject at the constructor payload position |
| Nullable payload declared integer | Reject unless non-nullness is proved |
| Record payload missing a declared required field | Reject with the field path |
| `Succ(P: proof nat)` with P captured from nat | Accept |
| Same-shaped proof from a different module instance | Reject the nominal contract |
| Repeated import with identical module and wiring | Accept the shared identity |
| Published `value` payload used implicitly as integer by a caller | Reject scalar use |
| Only some explicit payload arguments annotated | Accept; infer the other positions |
| Bare `:: Ctor` without explicit arguments | Keep automatic payload inference |
| Nullary `:: Ctor()` | Accept; no annotation is required |
| Annotation inside an ordinary constructor-match term | Reject the syntax |
| Repeated constructor tag within one predicate | Retain the existing rejection |
| Nominal annotation reference cycle between existing producers | Accept registry closure; do not unfold |
| JSON tag claiming a declared constructor | No nominal evidence |
| Data-loaded `[proof nat]`, including an empty batch | Reject the declaration |

Diagnostics should identify the producer, constructor, payload index and nested
mismatch path, with spans on the payload annotation and expression when available.
Nominal mismatches should distinguish module instances without exposing generated
names as the only explanation.

## Implementation sequence

1. Extend only the rule suffix's explicit constructor arguments with optional type
   annotations. Reuse the existing declaration-type and alias machinery. Lift wrappers
   into per-argument metadata before proof lowering, preserving source spans and the
   original payload expression list. Carry annotations into proof-construction metadata;
   type-only syntax must never become a runtime argument. Test partial annotations,
   aliases, nullable/structural types, and unchanged bare and nullary constructors.
2. Check annotated payload contributions and publish their contracts in the proof
   registry. Test widening, hidden precision through forwarders and unannotated sibling
   positions, inferred-self behavior, nullability and repeated analysis. Check all
   backends for unchanged stored payloads and construction, and appropriate consumer
   operand extraction. These first two steps deliver the motivating feature without
   introducing nominal type syntax.
3. Add the companion nominal type-reference AST form. Resolve and freshen references
   during elaboration, including aliases and shared-instance name aliases. Add nominal
   payload/column/head checking and boundaries, overrides of module defaults, and
   rejection on external loading/insertion paths. Test recursive references, compatible
   and incompatible modules, quoted names and editor navigation.
4. Document each implemented extension in the language spec only after its checks
   exist; add examples and editor diagnostics. Run the full suite and commit each step.

The main implementation dependency is publication: a payload annotated `value` must
stay opaque along every consumer path. Standalone interfaces or boundary-specific
signature views would need a separate motivation and design.
