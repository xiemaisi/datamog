// Re-export Langium-generated AST types as the canonical AST.
// The grammar and generated types live in datamog-parser; this module
// provides backward-compatible type aliases consumed by the rest of the codebase.

import type {
  AggregateCall,
  BinaryExpr,
  BooleanLiteral,
  Conditional,
  FunctionCall,
  HeadAnnotation,
  NullLiteral,
  NumberLiteral,
  HeadAtom as ParserHeadAtom,
  Query as ParserQuery,
  Rule as ParserRule,
  Refinement,
  Slice,
  StringLiteral,
  Subscript,
  UnaryExpr,
  Variable,
} from "datamog-parser";

export type {
  Actual,
  AggregateCall,
  ArrayLiteral,
  BinaryExpr,
  Binding,
  BodyElement,
  BooleanLiteral,
  ColumnDecl,
  Conditional,
  Equality,
  ExtDecl,
  Filter,
  FunctionCall,
  HeadAnnotation,
  Literal,
  NullLiteral,
  NumberLiteral,
  ObjectEntry,
  ObjectLiteral,
  Program,
  RangeAtom,
  Slice,
  PrimitiveType,
  Statement,
  StringLiteral,
  Subscript,
  UnaryExpr,
  Variable,
  Wildcard,
} from "datamog-parser";

// Post-processing turns every `BracketAccess` node from the grammar into
// either a `Subscript` or a `Slice`, so downstream code only ever
// observes those two at runtime. Include all three in the static type
// so narrowing compiles both ways: the impossible `$type ===
// "BracketAccess"` branch becomes a dead check, and the real `$type ===
// "Subscript"`/`"Slice"` branches type-check against the known union
// members. The parser re-export still flows through the `BracketAccess`
// member so downstream code reading raw grammar nodes (e.g. tests) can
// see the pre-transform shape too.
import type { ArrayLiteral, BracketAccess, ObjectLiteral, Wildcard } from "datamog-parser";
export type Expression =
  | ArrayLiteral
  | BinaryExpr
  | BooleanLiteral
  | BracketAccess
  | Conditional
  | FunctionCall
  | NullLiteral
  | NumberLiteral
  | ObjectLiteral
  | Slice
  | StringLiteral
  | Subscript
  | UnaryExpr
  | Variable
  // A bare `*`: only ever the argument of `count(*)`. Included in the
  // union so expression walks narrow on it; the analyzer rejects it
  // anywhere else.
  | Wildcard;

// HeadTerm from the grammar is just `Expression`; aggregates are injected
// by post-processing (see `packages/parser/src/post-process.ts`). Declare
// the union at the core boundary so downstream code can narrow on
// `$type === "AggregateCall"` at head positions. The grammar's third
// possibility, AnnotatedHeadTerm, is lifted away in `parseRaw`
// (`liftHeadAnnotations`) before any core code runs, so it never appears here.
export type HeadTerm = AggregateCall | Expression;

// Mirror the parser's HeadAtom/Rule shapes but broaden `args` to include the
// synthesised AggregateCall nodes. `argTypes` carries optional per-column head
// type annotations (`h(x: integer)`, `h(x: integer?)`): the declared annotation
// per position, undefined for unannotated positions; the whole array is absent
// when the rule has none.
export type HeadAtom = Omit<ParserHeadAtom, "args"> & {
  args: HeadTerm[];
  argTypes?: (HeadAnnotation | undefined)[];
  /** Refinement contracts this rule claims, in its own position names. The
   *  parser strips their positions, so they never correspond to a column. */
  refinements?: Refinement[];
};
export type Rule = Omit<ParserRule, "head"> & { head: HeadAtom };

/**
 * Treat a parsed statement as a core Rule. `parseRaw` strips AnnotatedHeadTerm
 * wrappers and post-processing injects AggregateCall, so a Rule that has been
 * through those passes matches the core shape; TS can't track the in-place
 * normalisation, so callers assert it at that boundary.
 */
export function asCoreRule(rule: ParserRule): Rule {
  return rule as unknown as Rule;
}

// Widen Query to carry its output name and provenance.
// `outputName` labels the result: the predicate name for an `output predicate`
// or `error predicate`, "default" for a `?-` query, undefined for a `!-`
// constraint (which is anonymous and identified by its source text instead).
// `isOutput` marks the synthetic queries the analyzer derives from
// `output predicate` rules (as opposed to a `?-` query); the REPL uses it to emit
// each output once while re-running the transient `?-`. `isError` (from the
// grammar) marks a constraint; the analyzer routes those into
// `AnalyzedProgram.constraints` rather than `queries`.
export type Query = ParserQuery & { outputName?: string; isOutput?: boolean };

export type { AggregateFunction, BinaryOp } from "datamog-parser";

// Alias: the old AST called the expression union "Term"
export type { Expression as Term } from "datamog-parser";

/**
 * Subset of `BinaryExpr.op` values that mean "comparison", i.e. the
 * operators that yield a boolean. Every one of them is total: a null
 * operand never produces a null result. There is a single equality,
 * `=`/`<>`, which is null-aware; the orderings treat null as an isolated
 * point in the order. See doc/design/null.md §5.
 */
export type ComparisonOp = "<" | "<=" | ">" | ">=" | "=" | "<>";

export const COMPARISON_OPS: ReadonlySet<string> = new Set<ComparisonOp>([
  "<",
  "<=",
  ">",
  ">=",
  "=",
  "<>",
]);

/** `=` and `<>`, the language's only equality (`null = null` is true). */
export const EQUALITY_OPS: ReadonlySet<string> = new Set(["=", "<>"]);

/** `<`, `<=`, `>`, `>=`: `null` is outside the order, so these are strict at it. */
export const ORDERING_OPS: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);

export const LOGICAL_BINARY_OPS: ReadonlySet<string> = new Set(["&&", "||"]);

/**
 * Bitwise / shift operators on 32-bit signed two's-complement integers
 * (Java/JS `int` semantics): `>>` is arithmetic, `>>>` is logical, and the
 * shift count is taken mod 32. Operands and result are `integer`.
 */
export type BitwiseOp = "&" | "|" | "^" | "<<" | ">>" | ">>>";

export const BITWISE_OPS: ReadonlySet<string> = new Set<BitwiseOp>([
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
]);

/**
 * True if a NumberLiteral was written as a float (i.e. its source text contains
 * a decimal point or an exponent). Needed because the parser coerces NUMBER
 * tokens to JavaScript numbers, which collapses `1.0` and `1` to the same
 * value. The parser's post-processing preserves the original text on
 * `rawText` so we can recover the distinction here.
 */
export function isFloatLiteral(n: NumberLiteral): boolean {
  return n.rawText !== undefined && /[.eE]/.test(n.rawText);
}
