export type {
  Actual,
  AggregateCall,
  ArrayLiteral,
  BinaryExpr,
  Binding,
  BodyElement,
  BooleanLiteral,
  BracketAccess,
  ColumnDecl,
  Equality,
  Expression,
  ExtDecl,
  Filter,
  FunctionCall,
  HeadAtom,
  HeadTerm,
  Identifier,
  Literal,
  NullLiteral,
  NumberLiteral,
  ObjectEntry,
  ObjectLiteral,
  Program,
  Query,
  RangeAtom,
  Rule,
  Slice,
  PrimitiveType,
  Statement,
  StringLiteral,
  Subscript,
  UnaryExpr,
  Variable,
  Wildcard,
  DatamogAstType,
} from "./generated/ast.js";

export {
  isActual,
  isAggregateCall,
  isArrayLiteral,
  isBinaryExpr,
  isBinding,
  isBodyElement,
  isBooleanLiteral,
  isEquality,
  isExpression,
  isExtDecl,
  isFilter,
  isFunctionCall,
  isLiteral,
  isNullLiteral,
  isNumberLiteral,
  isObjectEntry,
  isObjectLiteral,
  isQuery,
  isRangeAtom,
  isRule,
  isSlice,
  isStringLiteral,
  isSubscript,
  isUnaryExpr,
  isVariable,
  isWildcard,
} from "./generated/ast.js";

export type AggregateFunction = "count" | "sum" | "avg" | "min" | "max" | "concat" | "list";

// `op` includes the logical, comparison, and arithmetic kinds. The
// generated `BinaryExpr.op` already carries the full union.
export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "&&"
  | "||"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "="
  | "<>";

export { defaultColumnTypes, liftHeadAnnotations, postProcess } from "./post-process.js";
export { createDatamogServices } from "./datamog-module.js";
export {
  DatamogGeneratedModule,
  DatamogGeneratedSharedModule,
  DatamogLanguageMetaData,
} from "./generated/module.js";

import type { AstNode } from "langium";
import { GrammarUtils } from "langium";
import { createDatamogServices } from "./datamog-module.js";
import type { Program } from "./generated/ast.js";
import { defaultColumnTypes, liftHeadAnnotations, postProcess } from "./post-process.js";

/**
 * Source span of a single assigned property, for consumers that need to
 * point at one identifier rather than the whole node.
 *
 * Most names in the grammar (`predicate`, `ruleName`, `Actual.param`, …)
 * come from the `Identifier` datatype rule, so they are plain strings on
 * the AST with no node of their own. Their position lives only in the CST,
 * which is Langium-shaped; this wrapper is the one place that couples to
 * `GrammarUtils` so `datamog-core` can stay Langium-free.
 */
export function propertySpan(
  node: AstNode,
  property: string,
  index?: number,
): { offset: number; end: number } | undefined {
  const cst = GrammarUtils.findNodeForProperty(node.$cstNode, property, index);
  return cst ? { offset: cst.offset, end: cst.end } : undefined;
}

export { ParseError } from "./parse-error.js";
import { ParseError } from "./parse-error.js";

const services = createDatamogServices();
const parser = services.Datamog.parser.LangiumParser;

/** Last line/column of `source`, as 1-based positions. */
function endOfSource(source: string): [number, number] {
  const lines = source.split("\n");
  const line = Math.max(1, lines.length);
  const col = (lines[lines.length - 1]?.length ?? 0) + 1;
  return [line, col];
}

/** Convert a 1-based (line, column) pair to a byte offset within `source`. */
function lineColumnToOffset(source: string, line: number, column: number): number {
  let offset = 0;
  for (let i = 1; i < line; i++) {
    const nl = source.indexOf("\n", offset);
    if (nl === -1) break;
    offset = nl + 1;
  }
  return offset + column - 1;
}

/**
 * Best-effort parse for tooling that runs mid-edit (editor completions,
 * hover providers). Returns whatever AST Chevrotain produced — even when
 * there are lexer or parser errors — instead of throwing, and swallows
 * any exception from `postProcess` so a partially-malformed tree (e.g.
 * an empty `[]` bracket access that post-processing rejects) still
 * yields the rest of the program. Callers that need a guaranteed-clean
 * AST (translation, analysis) should use `parse` instead.
 */
export function parseLenient(source: string): Program {
  const result = parser.parse<Program>(source);
  const program = result.value;
  try {
    postProcess(program);
  } catch {
    // Post-processing aborts on the first malformed node; nodes
    // visited before that point have already been rewritten in place,
    // which is enough for completion-style consumers.
  }
  return program;
}

/**
 * Best-effort parse that also skips post-processing: `parseRaw`'s AST shape
 * with `parseLenient`'s tolerance for a half-typed document. Completes the
 * pair of axes the other three entry points cover between them (raw vs
 * post-processed, throwing vs best-effort).
 *
 * This is what editor features keyed on *source* shapes want. Go-to-definition
 * has to see `Ctor(...)` as a constructor term and `_` as a don't-care, both of
 * which post-processing lowers away, and it has to keep working while the user
 * is mid-keystroke and the document does not parse.
 */
export function parseRawLenient(source: string): Program {
  const program = parser.parse<Program>(source).value;
  liftHeadAnnotations(program);
  defaultColumnTypes(program);
  return program;
}

/**
 * Parse without post-processing: the AST is exactly as the grammar produced
 * it (numeric literals not yet `rawText`-tagged, `_` not desugared, proof
 * terms still `:: Ctor` / `Ctor(...)` rather than lowered onto `value`). The
 * module elaborator parses each referenced module this way so it can expand
 * (substitute inputs, freshen names) before a single post-process runs over
 * the merged program. Lexer / parser errors still throw a `ParseError`.
 */
export function parseRaw(source: string, file?: string): Program {
  const result = parser.parse<Program>(source);
  if (result.lexerErrors.length > 0) {
    const err = result.lexerErrors[0]!;
    const line = err.line ?? 1;
    const col = err.column ?? 1;
    throw new ParseError(err.message, line, col, lineColumnToOffset(source, line, col), file);
  }
  if (result.parserErrors.length > 0) {
    const err = result.parserErrors[0]!;
    // Chevrotain hands us an "empty" EOF token with `NaN`
    // start-line/column when the parse error sits at the end of the
    // source (e.g. `r(1)` with a missing period). Fall back to the
    // actual end of the source so the message points somewhere usable
    // instead of `line NaN, column NaN`.
    const line = err.token.startLine;
    const col = err.token.startColumn;
    if (
      line === undefined ||
      col === undefined ||
      !Number.isFinite(line) ||
      !Number.isFinite(col)
    ) {
      const [l, c] = endOfSource(source);
      throw new ParseError(err.message, l, c, lineColumnToOffset(source, l, c), file);
    }
    throw new ParseError(err.message, line, col, lineColumnToOffset(source, line, col), file);
  }
  // Normalise the tree before any consumer (elaboration, post-processing,
  // analysis) sees it: lift head type annotations onto each head's `argTypes`
  // (keeping AnnotatedHeadTerm out of every later stage) and default unannotated
  // input-predicate columns to `string`.
  liftHeadAnnotations(result.value);
  defaultColumnTypes(result.value);
  return result.value;
}

export function parse(source: string, file?: string): Program {
  const program = parseRaw(source, file);
  // `postProcess` throws `ParseError`s (via `parseErrorAtNode`) that only know
  // their node position, so stamp the source file here at the parse boundary.
  try {
    postProcess(program);
  } catch (e) {
    if (e instanceof ParseError) e.file ??= file;
    throw e;
  }
  return program;
}
