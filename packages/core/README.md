# datamog-core

*Part of the [Datamog](../../README.md) monorepo.*

AST type definitions, semantic analyzer, and type inference for the Datamog Datalog system.

## AST Types

The core AST re-exports Langium-generated types from `datamog-parser`. A Datamog program is a list of statements:

- **`Expression`** (aliased as `Term`): `Variable`, `StringLiteral`, `NumberLiteral`, `NullLiteral`, `ArrayLiteral`, `ObjectLiteral`, `BinaryExpr`, `UnaryExpr`, `FunctionCall`, `Subscript`, and `Slice`. The `HeadTerm` union additionally includes the synthesised `AggregateCall` shape for aggregate-position rule heads
- **`Literal`**: a body atom — a predicate applied to expressions, e.g. `ancestor(X, Y)`, `not composite(X)`. Carries `negated`, `maximal` (the parity `^` sigil), and `proofVar` (the `V : p(...)` proof capture)
- **`ExtDecl`**: extensional predicate declaration with typed columns
- **`Rule`**: a Horn clause with a head atom and body elements (empty body = fact)
- **`Query`**: a `?-` query against a predicate
- **`Program`**: a list of statements

All nodes carry source positions via Langium's `$cstNode`.

## Analyzer

`analyze(program)` classifies predicates, builds a dependency graph, and detects recursion:

```ts
import { analyze } from "datamog-core";

const result = analyze(program);
result.extDecls;            // Map<string, ExtDecl>, extensional predicates
result.rules;               // Map<string, Rule[]>, intensional predicates
result.queries;             // Query[]
result.recursivePredicates; // Set<string>, recursive predicates (self or mutual)
result.nonLinearPredicates; // Set<string>, predicates with >1 recursive body atom
result.maximalPredicates;   // Set<string>, predicates carrying the parity `^` sigil
result.constraints;         // Query[], integrity constraints (kept apart from queries)
result.arities;             // Map<string, number>
result.sortedStrata;        // string[][], SCCs in dependency order
```

The analyzer also checks safety, arity consistency, stratified and parity-stratified negation, and aggregate constraints.

## Type Inference

`inferTypes(analyzed)` infers column types for all predicates via fixed-point iteration:

```ts
import { analyze, inferTypes } from "datamog-core";

const typed = inferTypes(analyze(program));
typed.columnTypes;      // Map<string, PrimitiveType[]>, column types per predicate — what codegen uses
typed.publishedTypes;   // the same, widened by head annotations — the contract consumers see
typed.functionOverloads;// Map<FunctionCall, Overload>, the hand-off to backend dispatch
typed.nullness;         // which columns can hold the `null` value, and which variables each body proves cannot
```

Types are: `string`, `integer`, `float`, `boolean`, `value`, and `null` (the literal's own type), each optionally nullable. Type inference is a fixed-point iteration; columns that the iteration leaves un-pinned are reported as a type-inference error (rather than silently defaulted).

## Other analyses

Each is a pull-based call the CLI, the playground, and the VS Code extension make separately; none is wired into `inferTypes`.

| Entry point | Module | What it answers |
| ----------- | ------ | --------------- |
| `inferNullness`, `findNullnessRisks` | `nullness.ts`, `nullness-diagnostics.ts` | which columns can hold the `null` value, plus five warnings where a null or an absent value lands somewhere easy not to expect |
| `canBeUndefined` | `partiality.ts` | whether an expression can have no value, which is a different question from nullness and the one that decides guards, `count`'s emit and `defined`'s |
| `findNullableOperands` | `nullable-operands.ts` | every nullable operand in a position that needs a value, which is a static error |
| `findInertContracts` | `contracts.ts` | which refinement contracts an unannotated sibling rule has made vacuous |
| `generateObligations`, `obligationScript` | `obligations.ts` | the refinement contracts as SMT-LIB 2, for a solver you supply |
| `findInfiniteRisks` | `finiteness.ts` | which columns may grow unboundedly across iterations |
| `findInertPolarity` | `polarity.ts` | which `^` sigils sit in a single-polarity stratum and so do nothing |
| `findDefinition`, `findPredicateReferences` | `definitions.ts`, `references.ts` | go-to-definition and clickable spans, for editors |

## Modules

`elaborate(program, resolve, file)` expands a program's `:=` bindings into one flat program, resolving imports through a caller-supplied `ModuleResolver` so core stays filesystem-free. `expandModule` does one instantiation; `checkModuleBoundaries(typed, boundaries)` checks the wiring against each predicate's `publishedTypes` after inference. See spec §9.
