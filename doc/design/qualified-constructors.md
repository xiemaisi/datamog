# Design proposal: predicate-qualified constructors

Status: **implemented** (variant B — on-demand qualification). The doc below is
the design record; the summary and recommendation are kept for context, but the
"defer" recommendation was overridden and variant B shipped.

**What shipped.** A constructor is scoped to its predicate — `p::Cons`. Declared
with `head :: Ctor`; referenced bare (`Cons(...)`,
resolved to the one predicate declaring the tag) or qualified (`p::Cons(...)`,
required only when several predicates share the tag). The proof value's `$proof`
holds the qualified name; output renders it bare. Constructors are no longer
global, so two predicates may share a tag — and the module `<import>_<Ctor>`
affix was replaced: an imported instance's constructor is just `dist::Cons`.

Constructors are currently a single **global** namespace: a `[Ctor]` annotation
names a rule, and the name must be unique across the whole program (spec §8.1,
§1.8). This proposal scopes a constructor to its predicate — `p::Cons` rather
than a free-floating `Cons` — declared and referenced with a `::` qualifier. The
motivation and, more importantly, the honest cost/benefit are below; the short
version is that it is a coherent, more principled model whose benefits are
mostly cosmetic and whose costs (verbosity, migration) are real, so the
recommendation is to **defer** unless a concrete trigger appears.

## What we have today

- **Declaration:** `head(...)[Ctor]` / `[Ctor(a, b)]` — a bracket annotation on
  the rule head (spec §8.1).
- **Reference / match:** bare — `Cons(H, T)`, `P = Some(V)`, `list_sum(Nil(), 0)`
  (spec §8.4). A constructor term also range-restricts its subject to the
  owning predicate's proofs.
- **Namespace:** global; every constructor name is unique across the program.
- **Proof value:** `{ "$proof": "<Ctor>", "args": [...] }` (spec §8.2).
- **Imports (already shipped):** an entry import's constructors are named
  `<import>_<Ctor>` — a writable affix (`int_opt_Some`), distinct per instance,
  so `int_opt` and `str_opt` can both be matched. See
  [`imports-as-functors.md`](./imports-as-functors.md).

The affix is the piece this proposal would replace with something more uniform.

## The proposal

A constructor belongs to a predicate. Its full name is `p::Ctor`.

### Syntax

`::` is a new token (double colon, so it never collides with the single `:` of
capture `V : p`, type annotations, or the `:-` / `:=` operators).

```prolog
# declare — the predicate is the head's, so only the tag follows `::`
num_list(0)        :: Nil.
num_list(n + 1)    :: Cons :- num(Car), n <= 9, num_list(n).
ast(i, k)          :: Add(L, R) :- L : ast(i, j), token(j, "plus", _), R : ast(j + 1, k).

# reference / match — qualified by the owning predicate
list_sum(num_list::Nil, 0).
list_sum(num_list::Cons(H, T), S + as_integer(H)) :- list_sum(T, S).
```

`::` replaces `[...]` at the declaration and prefixes the predicate at every
reference. Explicit-argument (`:: Add(L, R)`) and nullary (`:: Nil` vs an
explicit `:: Nil()`) forms carry over unchanged.

### Semantics

- **Scope.** A constructor name is unique *within its predicate*, not globally.
  Two predicates in one file may each declare `Cons`.
- **Range restriction.** `X = p::Cons(...)` restricts `X` to `p`'s proofs — the
  same effect as a bare constructor match today, but the predicate is named
  rather than inferred.
- **Proof value.** The `$proof` key holds the qualified name:
  `{ "$proof": "num_list::Cons", "args": [...] }`. Matching `p::Cons` compares
  against `"p::Cons"`. This changes the runtime representation (any `to_json` of
  a proof, and a `P["$proof"]` read, now yield the qualified string).

### Imports fall out for free

An imported predicate is renamed to the importer's chosen name (`opt` →
`dist`), and its constructors follow: `opt::Cons` → `dist::Cons`. Two
instantiations give `int_opt::Some` and `str_opt::Some` — distinct and writable,
with no special affix. Qualified constructors **subsume the `<import>_<Ctor>`
affix** and make the import case identical to the intra-module case.

## The decision that dominates: always-qualified vs. on-demand

Whether a reference *must* be qualified is the crux, and it is where the real
cost lives.

- **A. Always qualified.** Every reference is `p::Cons`, even inside `p`'s own
  rules. Simplest to specify and parse (no resolution), and it is what "embed the
  predicate name everywhere" literally means. The cost is permanent verbosity:
  `list_sum(num_list::Cons(H, T), ...)` in every rule, and — unless display is
  special-cased — proof output like `num_list::Cons(7, num_list::Cons(7,
  num_list::Nil()))`. Every proof-term program pays this tax forever, and every
  existing bare reference must migrate.

- **B. Qualified on demand.** A bare `Cons` is allowed and resolves to the unique
  predicate that declares a `Cons`; you *must* qualify (`p::Cons`) only when two
  predicates share the tag (including two imported instances). This keeps
  existing code working unchanged (each current constructor is globally unique,
  so it still resolves bare), adds `::` exactly where disambiguation is needed
  (sharing, imports), and avoids forced verbosity. The cost is a name-directed
  resolution step (map a bare tag to its predicate; error "ambiguous, qualify it"
  when several match) — moderate, and *not* type-directed, so no circularity with
  inference.

B gets the two real wins (per-predicate scoping and clean import matching) at a
fraction of A's cost. A's only extra is uniformity — no bare constructors ever —
which does not obviously justify the verbosity.

## Display

Independent of source syntax: a proof value carries its predicate, so output can
print **bare when unambiguous** (`Cons(7, Cons(7, Nil()))`) and qualify only a
sub-proof of a *different* predicate. That keeps nested ADTs readable even under
A, and needs no inference (the value already knows its predicate). Worth doing
whichever source rule we pick.

## Migration

Whatever the variant:

- **Declarations:** `[Ctor]` → `:: Ctor` everywhere — Chapter 15, the proof-term
  examples (`proof-terms`, `peano`, `list-ops`, `expr-eval`, the sequent/CNF
  provers), their `expected.json`, and the case-study chapter.
- **Proof representation:** `$proof` strings become qualified; regenerate every
  `expected.json` and fix any test asserting proof JSON.
- **References:** under A, every bare match migrates too; under B, only genuinely
  ambiguous ones.
- **Grammar / spec:** add `::`; rewrite spec §8.1–§8.4 and the §1.8 namespace
  rules (constructors go from global to predicate-scoped); §1.7 gains `::`.
- **Elaborator:** drop the `<import>_<Ctor>` affix in `expandModule`; the import
  case becomes ordinary predicate renaming.
- **post-process:** the proof-term desugar keys off the qualified name.

Doing this while there are ~8 proof-term programs is cheaper than later, but it
is still a broad, breaking change to a shipped, heavily-taught feature.

## Alternatives

- **C. Status quo.** Keep global constructors and the `<import>_<Ctor>` affix.
  Zero migration. Covers the concrete need that started this — importing and
  matching several instantiations of one ADT module — which already works. Does
  *not* allow two predicates in one file to share a constructor tag.

## Recommendation

**Defer, keeping C.** The concrete problem (import + match multiple
instantiations) is already solved by the shipped affix. The redesign's remaining
benefits are a rare capability (intra-module constructor sharing) and cosmetics
(`dist::Cons` reads better than `dist_Cons`, `::` is more principled than
`[...]`) — not enough to justify a breaking migration of the proof-term feature
plus, under A, a permanent verbosity tax.

Revisit when a real trigger appears:

- a program genuinely wants two same-named constructors in one file, or
- the `<import>_<Ctor>` affix proves confusing in practice.

If we do revisit, adopt **B** (qualified on demand) with **bare-when-unambiguous
display**, not A — it delivers the scoping and import wins with the least churn
and no ongoing verbosity. The `p(...) :: Ctor` declaration syntax comes along
for the ride and is the right spelling at that point; on its own, ahead of the
references, it is not worth the migration.
