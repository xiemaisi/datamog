// Position 3's second half: an operation that computes rather than compares
// requires a non-null operand, so a nullable one has to be narrowed first.
//
// See doc/design/null-as-a-value.md §5. Comparisons take a `T?` and are strict at
// null, a guard failing being a guard doing its job. Everything else rejects one
// statically, and the reason that survived building it is §9.2's rather than §5's
// own: it is what keeps a SQL NULL single-valued. A `T?`-typed expression is never
// undefined, so a NULL in a `T?` context is the `null` value and nothing else,
// which is what lets `defined` and the `list` filter read a NULL at all. Let
// arithmetic take a `T?` and the guarantee goes, because `X + 1` would then be a
// `T?`-typed expression that is undefined at the top of the integer domain.
//
// A *statically* `null` operand (`null + 1`) is already a type error from the base
// type alone (§15.10). This is the other half: an operand whose type admits null.
// Both report the same way, so a reader sees one rule rather than two.

import type { AnalyzedProgram } from "./analyzer.ts";
import type { Expression, FunctionCall, HeadTerm, PrimitiveType } from "./ast.ts";
import { BITWISE_OPS, EQUALITY_OPS, ORDERING_OPS } from "./ast.ts";
import type { BodyOwner, NullnessContext, NullnessInfo } from "./nullness.ts";
import { mayBeNull } from "./nullness.ts";

/** The aggregates that fold values arithmetically or textually, so need one. */
const VALUE_AGGREGATES: ReadonlySet<string> = new Set(["sum", "avg", "min", "max", "concat"]);

export interface NullableOperandError {
  message: string;
  offset?: number;
  end?: number;
}

/**
 * Every nullable operand in a position that needs a value.
 *
 * Returns them rather than throwing, so the caller decides: `inferTypes` reports
 * the first, and a corpus measurement can count them all.
 */
export function findNullableOperands(
  analyzed: AnalyzedProgram,
  nullness: NullnessInfo,
  ctx: NullnessContext,
): NullableOperandError[] {
  const out: NullableOperandError[] = [];
  const owners: BodyOwner[] = [
    ...[...analyzed.rules.values()].flat(),
    ...analyzed.queries,
    ...analyzed.constraints,
  ];
  for (const owner of owners) {
    // A synthesised statement is not something a user can act on, and the
    // contract check `refinements.ts` emits reproduces the head's expressions.
    if ((owner as { synthetic?: boolean }).synthetic) continue;
    const nonNull = nullness.nonNullVars.get(owner.body) ?? new Set<string>();
    const check = (expr: Expression | HeadTerm, what: string) => {
      // Only a *primitive* operand. The rule protects §9.2's reading of a SQL
      // NULL, and that reading is only at risk for a `T?` primitive, where the
      // one marker would have to carry both "the null value" and "no value". A
      // `value` spells its null the JSON way (§9.3), so a `value` operand has no
      // ambiguity to protect and the null in it propagates harmlessly. Which is
      // just as well: a proof-term argument is a `value` subscript, so the strict
      // reading would reject every fold over an ADT in the corpus.
      const type = ctx.typeOf(owner, expr as HeadTerm);
      if (type === undefined || type === "value") return;
      if (!mayBeNull(expr as HeadTerm, nonNull, owner, ctx)) return;
      const text = expr.$cstNode?.text;
      out.push({
        message: `${text ? `\`${text}\`` : "This operand"} can be null, and ${what} needs a value. Guard it with \`<> null\` first, or use a comparison, which takes a null and simply does not hold.`,
        offset: expr.$cstNode?.offset,
        end: expr.$cstNode?.end,
      });
    };
    const head = (owner as { head?: { args?: readonly HeadTerm[] } }).head;
    for (const arg of head?.args ?? []) walk(arg, ctx, check);
    for (const element of owner.body) {
      if (element.$type === "Filter") walk(element.expr, ctx, check);
      else if (element.$type === "Equality") {
        walk(element.left, ctx, check);
        walk(element.expr, ctx, check);
      } else if (element.$type === "Literal") {
        for (const arg of element.args ?? []) walk(arg as Expression, ctx, check);
      } else if (element.$type === "RangeAtom") {
        // A bound has to be an integer, and a null is not one. The ranged
        // expression itself is fine: the range is a comparison, strict at null.
        check(element.low, "a range bound");
        check(element.high, "a range bound");
        walk(element.low, ctx, check);
        walk(element.high, ctx, check);
      }
    }
  }
  return out;
}

function walk(
  expr: Expression | HeadTerm,
  ctx: NullnessContext,
  check: (e: Expression | HeadTerm, what: string) => void,
): void {
  switch (expr.$type) {
    case "BinaryExpr": {
      const { op, left, right } = expr;
      // A comparison accepts a null on either side: it is strict there, so it
      // does not hold, which is the whole of Position 3's first half. The
      // connectives are absorbing, so a null in one branch is not decisive.
      if (!EQUALITY_OPS.has(op) && !ORDERING_OPS.has(op) && op !== "&&" && op !== "||") {
        const what = BITWISE_OPS.has(op) ? `the bitwise \`${op}\`` : `\`${op}\``;
        check(left, what);
        check(right, what);
      }
      walk(left, ctx, check);
      walk(right, ctx, check);
      return;
    }
    case "UnaryExpr":
      if (expr.op === "-") check(expr.operand, "negation");
      walk(expr.operand, ctx, check);
      return;
    case "Subscript":
      check(expr.object, "a subscript");
      check(expr.index, "a subscript index");
      walk(expr.object, ctx, check);
      walk(expr.index, ctx, check);
      return;
    case "Slice":
      check(expr.object, "a slice");
      if (expr.start) {
        check(expr.start, "a slice bound");
        walk(expr.start, ctx, check);
      }
      if (expr.end) {
        check(expr.end, "a slice bound");
        walk(expr.end, ctx, check);
      }
      walk(expr.object, ctx, check);
      return;
    case "FunctionCall": {
      checkCallArgs(expr, ctx, check);
      for (const arg of expr.args) walk(arg, ctx, check);
      return;
    }
    case "AggregateCall": {
      if (VALUE_AGGREGATES.has(expr.func) && expr.arg.$type !== "Wildcard") {
        check(expr.arg, `\`${expr.func}\``);
      }
      if (expr.arg.$type !== "Wildcard") walk(expr.arg, ctx, check);
      return;
    }
    case "ArrayLiteral":
      for (const el of expr.elements) walk(el, ctx, check);
      return;
    case "ObjectLiteral":
      for (const entry of expr.entries) walk(entry.value, ctx, check);
      return;
    default:
      return;
  }
}

/**
 * A builtin's arguments, against its resolved overload's parameter types.
 *
 * A `value` parameter takes a null, that being one of the shapes a `value` holds,
 * and the function answers for it (§15.10). A primitive parameter does not.
 */
function checkCallArgs(
  call: FunctionCall,
  ctx: NullnessContext,
  check: (e: Expression | HeadTerm, what: string) => void,
): void {
  // `defined` is the exception, and obviously so: asking whether something has a
  // value cannot require it to have one. Note it is *not* `<> null`, and on a
  // bare variable it is constantly true; `nullness-diagnostics.ts` warns about
  // that shape.
  if (call.name === "defined") return;
  const overload = ctx.overloads.get(call);
  if (!overload) return;
  const params: readonly (PrimitiveType | undefined)[] = overload.params;
  call.args.forEach((arg, i) => {
    const param = params[i] ?? params[params.length - 1];
    if (param === undefined || param === "value") return;
    check(arg, `\`${call.name}\``);
  });
}
