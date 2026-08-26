// Pure data extraction for editor auto-complete. Knows nothing about
// Langium services or LSP wire types — consumers (VS Code extension,
// playground) decide how to surface these as completion items.
//
// What this file exposes:
//   - Name lists for the built-ins the analyzer/translator recognise
//     (functions, aggregates, body-atom iteration helpers).
//   - `collectUserPredicates(program)` — every predicate the user has
//     declared or defined in the current document, with arity.
//   - `findEnclosingRule(program, offset)` and
//     `collectVariablesInRule(rule)` — for completing a variable that's
//     already in scope of the rule the cursor sits in.
//
// The variable collector deliberately skips the synthetic `$anonN`
// names that `postProcess` introduces for `_` placeholders. The user
// never types those.

import { AGGREGATE_NAMES, BUILTIN_BODY_ATOMS } from "./analyzer.ts";
import { asCoreRule } from "./ast.ts";
import type { HeadTerm, Program, Rule } from "./ast.ts";
import { BUILTINS } from "./builtins.ts";

export interface PredicateInfo {
  name: string;
  arity: number;
  kind: "extensional" | "idb";
  /** Column names for `extensional` declarations; undefined for rule-defined predicates. */
  columns?: readonly string[];
}

/** Built-in function names usable in expressions (`upper`, `sqrt`, `to_json`, …). */
export const BUILTIN_FUNCTION_NAMES: readonly string[] = Array.from(BUILTINS.keys()).sort();

/** Aggregate function names usable in rule heads (`count`, `sum`, …). */
export const AGGREGATE_FUNCTION_NAMES: readonly string[] = Array.from(AGGREGATE_NAMES).sort();

/** Built-in body-atom iteration helpers (`object_entry`, `array_element`). */
export const BUILTIN_BODY_ATOM_NAMES: readonly string[] = Array.from(
  BUILTIN_BODY_ATOMS.keys(),
).sort();

/**
 * Every predicate the user has either declared (`extensional`) or
 * defined (a rule head). Order is source-order, deduped across rules
 * that share a head (the first occurrence wins).
 */
export function collectUserPredicates(program: Program): PredicateInfo[] {
  const seen = new Set<string>();
  const out: PredicateInfo[] = [];
  for (const stmt of program.statements) {
    if (stmt.$type === "ExtDecl") {
      if (seen.has(stmt.predicate)) continue;
      seen.add(stmt.predicate);
      out.push({
        name: stmt.predicate,
        arity: stmt.columns.length,
        kind: "extensional",
        columns: stmt.columns.map((c) => c.name),
      });
    } else if (stmt.$type === "Rule") {
      const name = stmt.head.predicate;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, arity: stmt.head.args.length, kind: "idb" });
    }
  }
  return out;
}

/**
 * The Rule whose CST span contains `offset`, or undefined if the
 * cursor sits between statements. Used to scope variable suggestions
 * to "what's already named in this rule".
 */
export function findEnclosingRule(program: Program, offset: number): Rule | undefined {
  for (const stmt of program.statements) {
    if (stmt.$type !== "Rule") continue;
    const cst = stmt.$cstNode;
    if (!cst) continue;
    if (offset >= cst.offset && offset <= cst.end) return asCoreRule(stmt);
  }
  return undefined;
}

/**
 * Source-level variable names used anywhere in the rule's head or
 * body. Synthetic `$anonN` names (`_` desugarings) are filtered out
 * — those exist only after post-processing and aren't user-typed.
 */
export function collectVariablesInRule(rule: Rule): string[] {
  const names = new Set<string>();
  for (const arg of rule.head.args) collectVarsInTerm(arg, names);
  for (const elem of rule.body) {
    if (elem.$type === "Literal") {
      for (const arg of elem.args) collectVarsInTerm(arg, names);
    } else if (elem.$type === "Equality") {
      collectVarsInTerm(elem.left, names);
      collectVarsInTerm(elem.expr, names);
    } else if (elem.$type === "RangeAtom") {
      collectVarsInTerm(elem.expr, names);
      collectVarsInTerm(elem.low, names);
      collectVarsInTerm(elem.high, names);
    } else if (elem.$type === "Filter") {
      collectVarsInTerm(elem.expr, names);
    }
  }
  return Array.from(names)
    .filter((n) => !n.startsWith("$anon"))
    .sort();
}

function collectVarsInTerm(term: HeadTerm, into: Set<string>): void {
  switch (term.$type) {
    case "Variable":
      into.add(term.name);
      return;
    case "BinaryExpr":
      collectVarsInTerm(term.left, into);
      collectVarsInTerm(term.right, into);
      return;
    case "Conditional":
      collectVarsInTerm(term.cond, into);
      collectVarsInTerm(term.consequent, into);
      collectVarsInTerm(term.alternate, into);
      return;
    case "UnaryExpr":
      collectVarsInTerm(term.operand, into);
      return;
    case "FunctionCall":
      for (const a of term.args) collectVarsInTerm(a, into);
      return;
    case "AggregateCall":
      collectVarsInTerm(term.arg, into);
      return;
    case "Subscript":
      collectVarsInTerm(term.object, into);
      collectVarsInTerm(term.index, into);
      return;
    case "Slice":
      collectVarsInTerm(term.object, into);
      if (term.start) collectVarsInTerm(term.start, into);
      if (term.end) collectVarsInTerm(term.end, into);
      return;
    case "BracketAccess":
      collectVarsInTerm(term.object, into);
      if (term.start) collectVarsInTerm(term.start, into);
      if (term.end) collectVarsInTerm(term.end, into);
      return;
    case "ArrayLiteral":
      for (const e of term.elements) collectVarsInTerm(e, into);
      return;
    case "ObjectLiteral":
      for (const entry of term.entries) collectVarsInTerm(entry.value, into);
      return;
    case "StringLiteral":
    case "NumberLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
      return;
  }
}
