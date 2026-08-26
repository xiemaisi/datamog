// Can an expression be *undefined*, as opposed to evaluating to `null`?
//
// doc/design/null-as-a-value.md §1. The two questions are different and keeping
// them apart is the whole design: `null` is an ordinary value that a column can
// hold, while undefined is the absence of one, so a conjunct mentioning an
// undefined expression does not hold and a rule whose head mentions one derives
// no tuple.
//
// This is deliberately *not* `mayBeNull` in `nullness.ts`, which answers "can
// this be the null value". The two differ at exactly the two places that matter:
//
//   - a **variable** always denotes a value, `null` included, so it is defined;
//   - the **`null` literal** is a value, so it is defined.
//
// What is left is the operations, and there the two agree, so the case analysis
// below mirrors `mayBeNull`'s. It is a syntactic walk over the operations rather
// than a fixed point: definedness is not a type-system notion (§1), so nothing
// has to be inferred across predicates to answer it.

import {
  BITWISE_OPS,
  EQUALITY_OPS,
  type FunctionCall,
  type HeadTerm,
  ORDERING_OPS,
  type PrimitiveType,
} from "./ast.ts";
import type { Overload } from "./builtins.ts";

/**
 * What deciding definedness needs. Deliberately smaller than
 * `NullnessContext`: there is no `owner`, because definedness never depends on
 * the enclosing rule. `mayBeNull` needs one for the ungrouped-aggregate case;
 * nothing here does, which is what lets `termToSql` ask the question at the
 * point it emits a comparison.
 */
export interface PartialityContext {
  readonly overloads: ReadonlyMap<FunctionCall, Overload>;
  readonly typeOf: (expr: HeadTerm) => PrimitiveType | undefined;
}

/**
 * Whether `expr` can fail to denote a value, so its use has to be guarded.
 *
 * Over-approximates: an unresolved call or an unknown type answers yes, which
 * costs a redundant guard rather than a wrong answer.
 */
export function canBeUndefined(expr: HeadTerm, ctx: PartialityContext): boolean {
  const rec = (e: HeadTerm) => canBeUndefined(e, ctx);
  switch (expr.$type) {
    // Literals denote themselves. `null` included: that is the point.
    case "StringLiteral":
    case "NumberLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
      return false;
    // Construction, not propagation, so only the parts can be undefined.
    case "ArrayLiteral":
      return expr.elements.some(rec);
    case "ObjectLiteral":
      return expr.entries.some((e) => rec(e.value));
    // A variable ranges over the values a column holds, and no column holds an
    // undefined. This is where this function parts company with `mayBeNull`.
    case "Variable":
      return false;
    case "UnaryExpr":
      // Arithmetic negation can leave the integer domain, and `!` has no value
      // at a `null` operand, a null being no truth value (§15.26). Whether the
      // operand can be a null is a nullness question and no nullness bit is in
      // scope here, so the answer is the conservative one for both, exactly as
      // for the orderings below.
      return true;
    case "AggregateCall":
      // §7. `count`, `concat` and `list` fold with an identity the domain has, 0,
      // `""` and `[]`, so they always have a value over any group. `avg`, `min`
      // and `max` have none, an average over nothing being 0/0 and a minimum
      // needing an infinity, so an empty or all-null group leaves them with no
      // value.
      //
      // `sum` has the identity and can still leave the domain, at either width:
      // an integer sum past the safe-integer range, and a float sum past the
      // IEEE range, which the ordinary rule for float arithmetic makes an absence
      // rather than an `Infinity`.
      //
      // A guard on one of these cannot go in `WHERE`, an aggregate not being
      // allowed there, so the translator emits `HAVING` for it instead.
      if (expr.func === "avg" || expr.func === "min" || expr.func === "max") return true;
      if (expr.func === "sum") return true;
      return false;
    case "FunctionCall": {
      const overload = ctx.overloads.get(expr);
      if (!overload) return true;
      if (!overload.nulls.total) return true;
      return expr.args.some(rec);
    }
    case "Subscript":
      // A string subscript out of range is `''`; a `value` one can miss its key
      // or hit the wrong shape, which is undefined rather than null (§8).
      if (ctx.typeOf(expr.object) !== "string") return true;
      return rec(expr.object) || rec(expr.index);
    case "Slice":
      if (ctx.typeOf(expr.object) !== "string") return true;
      return (
        rec(expr.object) ||
        (expr.start !== undefined && rec(expr.start)) ||
        (expr.end !== undefined && rec(expr.end))
      );
    case "Conditional":
      // Strict in the condition, which is where the conservative answer comes
      // from: a null condition is no truth value, so the conditional has no
      // value there, and whether the condition can be a null is a nullness
      // question with no nullness bit in scope — exactly the position `!`, the
      // connectives and the orderings are in above. Both branches then have to
      // be non-nullable (`nullable-operands.ts`), which is what makes this
      // answer safe as well as conservative: a NULL from a conditional is
      // always an absence, never the `null` value, so the guard this earns can
      // never drop a row it should keep.
      return true;
    case "BinaryExpr": {
      const { op, left, right } = expr;
      // Equality is total over *values* and strict in undefinedness, exactly
      // like an ordering: `e = f` holds only of two defined operands (§1), so as
      // an expression it has no value where either side has none. The translator
      // folds that definedness into the emission locally rather than hoisting it
      // to a rule-level guard, which is what keeps `<>` and `not (=)` apart
      // (§4.2, §15.3) while still leaving a binding position with nothing to
      // bind.
      if (EQUALITY_OPS.has(op)) return rec(left) || rec(right);
      // An ordering is strict at null and at undefined alike, `null` having no
      // place in an order (§4.1). No nullness bit is in scope here, so the answer
      // is the conservative one: any ordering may have no value. That costs an
      // `IS NOT NULL` guard where the result is bound to a variable, which is a
      // no-op for non-null operands, and nothing at all in condition position.
      if (ORDERING_OPS.has(op)) return true;
      // A connective is strict at a `null` operand for the same reason `!` is,
      // and non-strict at its absorbing value, so it has no value wherever an
      // operand is a null or an absence that `false`/`true` does not rescue.
      // Same conservative answer, and the same cost: an `IS NOT NULL` that is a
      // no-op where the operands are truth values.
      if (op === "&&" || op === "||") return true;
      // 32-bit wrapping, so nothing escapes the domain.
      if (BITWISE_OPS.has(op)) return rec(left) || rec(right);
      // A zero divisor, a negative base with a fractional exponent, overflow.
      if (op === "/" || op === "%" || op === "**") return true;
      // `+`, `-`, `*` and string concatenation. Arithmetic can leave the
      // integer domain; concatenation cannot. An unknown type is conservative.
      return ctx.typeOf(expr) === "string" ? rec(left) || rec(right) : true;
    }
    default:
      return true;
  }
}
