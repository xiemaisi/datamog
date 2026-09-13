# Proof-signature contracts

Status: proposal, not implemented. All `proof predicate` declarations and `proof P`
types below are proposed syntax. Existing programs retain their current behavior.
This extends the [semantic type foundation](semantic-types.md); it does not add
independent datatypes, freely constructible terms, or a finiteness guarantee.

## Problem and first-version scope

Today constructor payload types are inferred and propagated through private and
published proof registries. A producer cannot explicitly promise a payload shape
or deliberately publish less payload precision. Ordinary head annotations describe
value columns, not the implicit proof column's constructor signature.

The first version adds producer-owned signatures and nominal proof references in
type positions. A signature checks existing derivations and supplies their public
payload contract. It neither supplies rules nor creates a proof-carrying predicate.
Consumers use the producer's published signature. Per-consumer signature views,
constructor hiding and abstract signature imports are deferred.

## Proposed syntax

A standalone declaration names an existing locally defined proof-carrying predicate:

```prolog
proof predicate nat {
  Zero();
  Succ(proof nat);
}.

output predicate nat(0) :: Zero().
nat(N + 1) :: Succ(P) :- P : nat(N), N < 2.
```

Constructor entries give payload types in their encoded order, not the predicate's
ordinary column types. Parentheses are required even for nullary constructors;
semicolons separate entries and the declaration ends with `}.`. The declaration
may precede the rules. `proof` should be contextual, preserving existing identifiers
where the parser can distinguish the declaration or type position.

`proof P` denotes the nominal proof type of predicate `P`. It is allowed wherever
a declaration type is allowed, including aliases and nested records/arrays;
`proof P?` includes null. Field optionality and expression absence remain separate.

```prolog
proof predicate item { Item({name: string, score?: float}); }.
item() :: Item({"name": "Ada", "score": 1}).

type NatProof = proof nat.
selected(P: NatProof) :- P : nat(_).
```

The item signature widens the integer score to float and permits its absence.
The constructor still builds exactly the payload specified by its rule. Bare
`:: Ctor` rules also work, but their automatically selected witnesses and sub-proofs
must match the declared payload order. Explicit constructor arguments are preferable
when that order is part of a public interface.

## Checking and publication

A predicate has at most one signature declaration per source module. Its constructor
set must exactly equal the set of constructors in its rules, with matching payload
arities. Duplicate entries, missing entries, extra entries, declarations without
proof-carrying rules, and unknown proof references are errors. This first version
has no partial signature or hidden-constructor mechanism.

Each constructor's inferred payload contribution must satisfy its declared payload
type directionally: inferred is a subtype of declared. Check contributions before
publication replaces them with their contracts. A required record field must be
proved present; a nullable contribution cannot satisfy a non-null claim. Work-limit
fallback supplies no additional evidence. Signature checking must not use a
constructor's own declaration as evidence that its payload meets that declaration.

Keep the private registry inferred. Build the published registry with declared
payload types, retaining exact nominal identities. Other predicates, transitive
forwarders, operand lowering and module boundaries consume published payloads.
The producer's own rules retain the existing inferred-self treatment; calls to other
predicates, including mutually recursive ones, use those predicates' contracts.
Predicates without declarations retain today's inferred publication policy.

For example, `proof predicate item { Item(value); }.` may publish an integer payload
as opaque `value`. A caller matching `item::Item(X)` must then explicitly extract
an integer before arithmetic on `X`; private knowledge of the literal cannot leak
through forwarding rules or the constructor registry. This applies even when the
same nominal proof is carried by an ordinary, non-proof-carrying predicate.

Recursive payload references remain nominal graph edges, not recursive structural
aliases. Self and mutual references resolve after collecting all predicate identities.
Validate registry closure without unfolding those edges. A signature does not assert
that any constructor has a nonempty extension.

## Nominal identity and module boundaries

`proof P` resolves to an elaborated predicate identity, never merely a source name
or matching constructor spelling. Elaborate these references using exactly the
same substitutions as proof captures and constructor qualifiers:

- Freshen private predicates and their signature references per module instance.
- Rewrite self references when a selected proof-carrying output is renamed to its
  receiving predicate.
- Apply final shared-instance name aliases to all nominal references, including
  references expanded from type aliases.
- Preserve identity through ordinary forwarding predicates; carrying a proof of
  `P` does not turn it into a proof of the forwarding predicate.

Identical module identity and input wiring share the existing instance and proof
identity. Different instances have different identities even when their signatures
are structurally identical. Signature declarations do not change instance keys.

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

A consumer cannot redeclare a wired producer's signature to change its published
view in this version. Signature declarations attach only to local producer rules.
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
| `Succ(proof nat)` receiving a captured proof of nat | Accept |
| Same-shaped proof from a different module instance | Reject the nominal contract |
| Repeated import with identical module and wiring | Accept the shared identity |
| Published `value` payload used implicitly as integer by a caller | Reject scalar use |
| Missing constructor entry or wrong payload arity | Reject at the signature |
| Constructor entry with no corresponding rule | Reject; entries cannot mint nodes |
| Proof signature reference cycle between existing producers | Accept registry closure; do not unfold |
| JSON tag claiming a declared constructor | No nominal evidence |
| Data-loaded `[proof nat]`, including an empty batch | Reject the declaration |

Diagnostics should identify the producer, constructor, payload index and nested
mismatch path, with spans on the signature and offending contribution when available.
Nominal mismatches should distinguish module instances without exposing generated
names as the only explanation.

## Implementation sequence

1. Add raw signature/type-reference AST forms, alias expansion support and source
   spans. Resolve/freshen nominal references during elaboration, before proof lowering.
   Preserve signature metadata when stripping declaration-only statements. Add parser
   tests, quoted-identifier cases and editor keyword/navigation coverage.
2. Add producer signature validation and published-registry overrides. Test payload
   widening, recursive references, hidden precision through forwarders, nullability
   and unchanged rule execution. Keep stored representations and construction unchanged.
3. Add nominal column/head checking and boundary handling, including shared instances,
   overrides of module defaults, and rejection on all external loading/insertion paths.
   Test both compatible and incompatible modules and every evaluation backend.
4. Document implemented syntax in the language spec only after these checks exist;
   add examples and editor diagnostics. Run the full suite and commit each step.

The main implementation dependency is publication: a payload declared `value` must
stay opaque along every consumer path. Boundary-specific signature views should be
a separate design, after producer contracts establish that invariant.
