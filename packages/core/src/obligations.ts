// Proof obligations for refinement contracts, as SMT-LIB 2.
//
// Phase 2 of doc/design/refinement-annotations.md. The script is the
// deliverable: nothing here runs a solver, and no phase may assume a
// particular one, so the obligation set's public form is text every solver
// reads.
//
// Two things the encoding must not delegate to the solver:
//
//   - SMT-LIB's `div`/`mod` are Euclidean, with a non-negative remainder,
//     where Datamog truncates toward zero and takes the dividend's sign
//     (spec §2.6). Both are written out.
//   - `integer` is `[-(2^53 - 1), 2^53 - 1]` and arithmetic leaving it is
//     NULL, so every arithmetic term carries an overflow condition.
//
// NULL is modelled as a pair, per §4.4: each term has a value and a Bool
// saying whether it is null. An ordering is false at NULL and `=` is
// null-aware, so the comparisons are written out rather than mapped straight
// onto SMT-LIB's.

import type { AnalyzedProgram } from "./analyzer.ts";
import { containsAggregate } from "./analyzer.ts";
import type { HeadTerm, PrimitiveType, Rule } from "./ast.ts";
import type { TypedProgram } from "./types.ts";
import { rebuildVarTypes } from "./types.ts";

const MAX_SAFE = "9007199254740991";

/** A term as a value and the condition under which it is NULL. */
interface Term {
  v: string;
  isNull: string;
}

const NOT_NULL = "false";

function or(...conditions: string[]): string {
  const live = conditions.filter((c) => c !== NOT_NULL);
  if (live.length === 0) return NOT_NULL;
  return live.length === 1 ? live[0]! : `(or ${live.join(" ")})`;
}

function nonNull(t: Term): string {
  return t.isNull === NOT_NULL ? "true" : `(not ${t.isNull})`;
}

/** Within the integer domain, so an arithmetic result is not NULL. */
function inDomain(value: string): string {
  return `(and (<= (- ${MAX_SAFE}) ${value}) (<= ${value} ${MAX_SAFE}))`;
}

/** Truncating division, where SMT-LIB's `div` floors toward negative infinity. */
function truncDiv(a: string, b: string): string {
  return `(ite (>= (* ${a} ${b}) 0) (div (abs ${a}) (abs ${b})) (- (div (abs ${a}) (abs ${b}))))`;
}

export interface ObligationContext {
  types: TypedProgram;
  /** Variable name to its SMT declaration, accumulated per obligation. */
  declared: Map<string, PrimitiveType>;
}

/**
 * Translate a Datamog expression. Returns undefined for anything outside
 * §4.1's fragment, which the caller reports rather than emitting a goal that
 * quietly means something else.
 */
function toSmt(expr: HeadTerm, ctx: ObligationContext, vars: Map<string, PrimitiveType>): Term {
  switch (expr.$type) {
    case "NumberLiteral":
      return { v: String(expr.value), isNull: NOT_NULL };
    case "BooleanLiteral":
      return { v: expr.value ? "true" : "false", isNull: NOT_NULL };
    case "NullLiteral":
      return { v: "0", isNull: "true" };
    case "Variable": {
      const type = vars.get(expr.name) ?? "integer";
      ctx.declared.set(expr.name, type);
      return { v: expr.name, isNull: `${expr.name}$null` };
    }
    case "UnaryExpr": {
      const operand = toSmt(expr.operand, ctx, vars);
      if (expr.op === "!") return { v: `(not ${operand.v})`, isNull: NOT_NULL };
      const value = `(- ${operand.v})`;
      return { v: value, isNull: or(operand.isNull, `(not ${inDomain(value)})`) };
    }
    case "BinaryExpr": {
      const l = toSmt(expr.left, ctx, vars);
      const r = toSmt(expr.right, ctx, vars);
      return binary(expr.op, l, r);
    }
    default:
      throw new UnsupportedTerm(expr.$type);
  }
}

export class UnsupportedTerm extends Error {
  constructor(readonly term: string) {
    super(`outside tier 1: ${term}`);
  }
}

function binary(op: string, l: Term, r: Term): Term {
  // Connectives over comparisons stay two-valued (§4.1 excludes a bare
  // boolean term, so neither side can be NULL here).
  if (op === "&&") return { v: `(and ${l.v} ${r.v})`, isNull: NOT_NULL };
  if (op === "||") return { v: `(or ${l.v} ${r.v})`, isNull: NOT_NULL };

  // Comparison is total: null never comes back out of one (null.md §5).
  const both = `(and ${nonNull(l)} ${nonNull(r)})`;
  const bothNull = `(and ${l.isNull} ${r.isNull})`;
  switch (op) {
    case "<":
    case ">":
      return { v: `(and ${both} (${op} ${l.v} ${r.v}))`, isNull: NOT_NULL };
    case "<=":
    case ">=":
      return { v: `(or ${bothNull} (and ${both} (${op} ${l.v} ${r.v})))`, isNull: NOT_NULL };
    case "=":
      return { v: `(or ${bothNull} (and ${both} (= ${l.v} ${r.v})))`, isNull: NOT_NULL };
    case "<>":
    case "!=":
      return { v: `(not (or ${bothNull} (and ${both} (= ${l.v} ${r.v}))))`, isNull: NOT_NULL };
  }

  // Arithmetic: NULL propagates, and leaving the integer domain originates it.
  const propagated = or(l.isNull, r.isNull);
  if (op === "+" || op === "-" || op === "*") {
    const value = `(${op} ${l.v} ${r.v})`;
    return { v: value, isNull: or(propagated, `(not ${inDomain(value)})`) };
  }
  if (op === "/" || op === "%") {
    const byZero = `(= ${r.v} 0)`;
    const q = truncDiv(l.v, r.v);
    const value = op === "/" ? q : `(- ${l.v} (* ${r.v} ${q}))`;
    return { v: value, isNull: or(propagated, byZero) };
  }
  throw new UnsupportedTerm(`operator ${op}`);
}

/** The hypotheses a rule body contributes (§3.3). */
function hypotheses(
  rule: Rule,
  ctx: ObligationContext,
  vars: Map<string, PrimitiveType>,
): string[] {
  const out: string[] = [];
  // Hypotheses are best effort: one outside the fragment is dropped rather
  // than failing the obligation, since omitting a hypothesis only weakens the
  // goal. A goal outside the fragment is a different matter and is reported.
  const attempt = (build: () => string) => {
    try {
      out.push(build());
    } catch (e) {
      if (!(e instanceof UnsupportedTerm)) throw e;
    }
  };
  for (const element of rule.body) {
    if (element.$type === "Filter") {
      attempt(() => toSmt(element.expr as HeadTerm, ctx, vars).v);
    } else if (element.$type === "Equality") {
      // The grammar calls the right-hand side `expr`.
      attempt(
        () =>
          binary(
            "=",
            toSmt(element.left as HeadTerm, ctx, vars),
            toSmt(element.expr as HeadTerm, ctx, vars),
          ).v,
      );
    }
    // A positive atom contributes its contract, which needs the contract of
    // another predicate and so waits on phase 4's ordering; an unannotated or
    // input atom contributes nothing either way. Omitting a hypothesis only
    // weakens a goal, so this is safe: an obligation may fail that a later
    // pass could discharge.
  }

  // A named head position contributes its definition (§3.3's last row). `as`
  // rewrites nothing, so without this nothing connects `K` to `I + 1` and a
  // goal mentioning `K` would have no hypothesis at all.
  rule.head.positionNames?.forEach((name, i) => {
    const arg = rule.head.args[i];
    if (name === undefined || arg === undefined) return;
    if (arg.$type === "Variable" && arg.name === name) return; // `X = X`
    ctx.declared.set(name, vars.get(name) ?? "integer");
    attempt(() => binary("=", { v: name, isNull: `${name}$null` }, toSmt(arg, ctx, vars)).v);
  });
  return out;
}

/** One obligation: a named goal with its hypotheses. */
export interface Obligation {
  predicate: string;
  claim: string;
  script: string;
}

/**
 * Generate one SMT-LIB block per refinement. A rule whose head contains an
 * aggregate is skipped with a note: its contract needs §4.1's derived facts
 * and the empty-group goal of §3.1, which this pass does not yet emit.
 */
export function generateObligations(typed: TypedProgram): Obligation[] {
  const out: Obligation[] = [];
  for (const [predicate, rules] of typed.rules) {
    if (!rules.every((r) => (r.head.refinements?.length ?? 0) > 0)) continue;
    for (const [index, rule] of rules.entries()) {
      const vars = rebuildVarTypes(rule.body, typed.columnTypes);
      for (const refinement of rule.head.refinements!) {
        const ctx: ObligationContext = { types: typed, declared: new Map() };
        let block: string;
        try {
          if (rule.head.args.some(containsAggregate)) {
            throw new UnsupportedTerm("an aggregate in the head");
          }
          const goal = toSmt(refinement.formula as HeadTerm, ctx, vars);
          const asserts = hypotheses(rule, ctx, vars);
          const declarations = [...ctx.declared]
            .map(([name]) => `(declare-const ${name} Int)\n(declare-const ${name}$null Bool)`)
            .join("\n");
          block = [
            `; ${predicate} rule ${index + 1}: ${refinement.text}`,
            "(push 1)",
            declarations,
            ...asserts.map((a) => `(assert ${a})`),
            `(assert (not ${goal.v}))`,
            "(check-sat) ; unsat discharges the obligation",
            "(pop 1)",
          ]
            .filter((line) => line !== "")
            .join("\n");
        } catch (e) {
          if (!(e instanceof UnsupportedTerm)) throw e;
          block = `; ${predicate} rule ${index + 1}: ${refinement.text}\n; not emitted, ${e.message}`;
        }
        out.push({ predicate, claim: refinement.text, script: block });
      }
    }
  }
  return out;
}

/** The obligations of `typed` as one SMT-LIB 2 script. */
export function obligationScript(typed: TypedProgram & AnalyzedProgram): string {
  const obligations = generateObligations(typed);
  if (obligations.length === 0) return "; no refinement contracts to discharge\n";
  return [
    "; Datamog refinement obligations.",
    "; Each block is unsat exactly when its contract holds for that rule.",
    "(set-logic QF_LIA)",
    "",
    ...obligations.map((o) => o.script),
    "",
  ].join("\n");
}
