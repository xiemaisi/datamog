# datamog-parser

*Part of the [Datamog](../../README.md) monorepo.*

Langium-based parser for the Datamog Datalog dialect. The grammar is defined in `datamog.langium` and the lexer, parser, and AST types are generated from it.

## Usage

```ts
import { parse } from "datamog-parser";

const program = parse(`
  input predicate parent(name: string, child: string).
  ancestor(X, Y) :- parent(X, Y).
  ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
  ?- ancestor("alice", X).
`);

for (const stmt of program.statements) {
  console.log(stmt.$type); // "ExtDecl", "Rule", "Query", or "TypeAlias"
}
```

## Syntax

```
# Comments run to end of line
input predicate <name>^?(<col>: <type>, ...). # input declaration; optional maximal sigil
input predicate <name>^?(...) := <binding>.   # data/module binding; polarity is checked
<head>(<args>) :- <body>, ... .               # rule
<head>(<args>).                               # fact (rule with empty body)
output predicate <head>(<args>) :- ... .      # a named, additionally-printed output
error predicate <head>(<args>) :- ... .       # a named integrity constraint
?- <atom>.                                    # query
!- <atom>, ... .                              # anonymous integrity constraint
<head>(X, _: <proposition>) :- ... .          # refinement annotation on an erased position
<name>^(<args>)                               # the parity sigil: this predicate is maximal
```

Declaration types include `string`, `integer`, `float`, `boolean`, `value`, `null`,
closed records (`{name: string, age?: integer}`), arrays (`[float]`), transparent
aliases (`type N = nat.`), and bare proof-carrying predicate names (`nat`). `?`
admits null; an unannotated input column defaults to `string`. Nominal types are
checked after module elaboration and are not allowed on external data inputs.
Explicit constructor arguments also accept contracts: `p() :: C(42: float).`

## Post-processing

`parseRaw` returns the tree straight from the grammar; `parse` additionally runs `postProcess`, which normalises the AST so later stages (analyzer, translator, evaluators) see a regular shape. The main transforms:

1. **Don't-care desugaring:** each `_` is renamed to a unique internal variable name.
2. **Numeric literal preservation:** the raw source text of number literals is preserved on a `rawText` property to distinguish `1` from `1.0`.
3. **Aggregate rewriting:** `FunctionCall` nodes in rule head positions whose name is an aggregate (`count`, `sum`, `avg`, `min`, `max`, `concat`, `list`) are rewritten to `AggregateCall`.
4. **Bracket-access splitting:** the unified `BracketAccess` node the grammar produces (to avoid an LL(k) ambiguity) is split into `Subscript` (`x[i]`) or `Slice` (`x[i:j]`) based on whether a `:` was present.
5. **Proof-term / ADT desugaring:** a named rule `p(...) :: Ctor` and constructor terms are lowered onto the `value` machinery.

6. **Contract lowering:** `synthesiseContractChecks` turns each refinement-carrying predicate into one synthesised `!-`, so no stage after parsing sees a refinement.

`parseRaw` expands aliases while retaining symbolic nominal references, lifts
constructor argument contracts onto `rule.ctorArgTypes`, and applies the normalisations that must precede everything else (lifting optional head type annotations onto `head.argTypes`, extracting refinements, substituting `as` head-argument names away, and defaulting an unannotated column type to `string`), so every consumer, including the module elaborator that runs before `postProcess`, sees them.

## Parse entry points

Four, one per (raw vs post-processed) x (throwing vs best-effort) combination:

| | throws on error | best effort |
| --- | --- | --- |
| **grammar shape** | `parseRaw` | `parseRawLenient` |
| **post-processed** | `parse` | `parseLenient` |

The lenient pair is what editor features use, so navigation and completion survive a file that does not parse cleanly. The raw pair is what the module elaborator and any feature keyed on *source* shapes use, since post-processing lowers away `Ctor(...)` and `_`. `propertySpan(node, property)` locates an identifier's source span; it is the single place coupled to Langium's CST helpers, so `datamog-core` can stay Langium-free.

## Langium services

For advanced use (e.g. building a language server), the Langium services are also exported:

```ts
import { createDatamogServices } from "datamog-parser";

const services = createDatamogServices();
```

The throwing entry points accept inherited aliases and a fourth `context`
argument for incremental sessions. `parseRaw` uses the context for type names;
`parse` also passes it to `postProcess`. This context contains previously lowered
statements. Proof lowering reads their retained construction metadata to resolve
captures, patterns and arities, and mutates only the new program. Do not lower
accumulated rules a second time: their implicit proof columns already exist.
