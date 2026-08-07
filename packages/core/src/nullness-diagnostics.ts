// Warnings about NULL reaching a place where it is easy not to expect it.
//
// All three are the residual oddities null.md §5 and §8 name, and none is an
// error: the behaviour is specified and sometimes wanted. What makes them
// worth reporting is that the symptom is a missing row, so the cost of not
// noticing is paid by reading output and counting.
//
// Shaped like `FinitenessDiagnostic` / `PolarityDiagnostic` and consumed the
// same way (a pull-based call from the CLI and the playground), so no warning
// channel out of `inferTypes` is needed.

import type { Expression, PrimitiveType } from "./ast.ts";
import { ORDERING_OPS } from "./ast.ts";
import type { BodyOwner } from "./nullness.ts";
import { mayBeNull, refineBody } from "./nullness.ts";
import type { TypedProgram } from "./types.ts";
import { inferTermType, rebuildVarTypes } from "./types.ts";

export interface NullnessDiagnostic {
  severity: "warning";
  code: "nullable-filter" | "nullable-ordering-gap" | "nullable-negated-ordering";
  message: string;
  offset?: number;
  end?: number;
}

export function findNullnessRisks(typed: TypedProgram): NullnessDiagnostic[] {
  const diagnostics: NullnessDiagnostic[] = [];
  const varTypeCache = new Map<BodyOwner, Map<string, PrimitiveType>>();
  const ctx = {
    overloads: typed.functionOverloads,
    typeOf: (owner: BodyOwner, expr: Parameters<typeof inferTermType>[0]) => {
      let vars = varTypeCache.get(owner);
      if (!vars) {
        vars = rebuildVarTypes(owner.body, typed.columnTypes);
        varTypeCache.set(owner, vars);
      }
      return inferTermType(expr, vars, typed.columnTypes);
    },
  };

  const owners: BodyOwner[] = [
    ...[...typed.rules.values()].flat(),
    ...typed.queries,
    ...typed.constraints,
  ];
  const orderings: OrderingUse[] = [];

  for (const owner of owners) {
    const nonNull = typed.nullness.nonNullVars.get(owner.body) ?? new Set<string>();
    for (const elem of owner.body) {
      if (elem.$type !== "Filter") continue;
      // A NULL filter value is "does not match", so the row leaves without a
      // trace. Comparison is total, so this only fires where a NULL reaches
      // boolean position some other way: a `boolean?` column, `as_boolean`, or
      // a connective propagating one (null.md §5).
      if (mayBeNull(elem.expr, nonNull, owner, ctx)) {
        diagnostics.push({
          severity: "warning",
          code: "nullable-filter",
          message:
            "This filter can evaluate to NULL, and a NULL filter drops its row like a false one. Guard the nullable operand with `<> null` if that is not what you want.",
          offset: elem.$cstNode?.offset,
          end: elem.$cstNode?.end,
        });
      }
      // Unlike the pairing warning below, this one reads the *fully* refined
      // set. A negated ordering proves nothing about its own operands (§4.2),
      // so there is no self-refinement to skip, and any other conjunct that
      // does prove the operand non-null closes the gap and should silence it.
      collectNegatedOrderings(elem.expr, owner, nonNull, ctx, false, diagnostics);
      // Refine again without this conjunct: a strict comparison proves its own
      // operands non-null, so asking the fully-refined set whether the operand
      // can be NULL would always answer no and the gap would never be found.
      collectOrderings(
        elem.expr,
        owner,
        refineBody(owner, typed.nullness.columnNullness, ctx, elem),
        ctx,
        orderings,
      );
    }
  }

  diagnostics.push(...orderingGaps(orderings));
  return diagnostics;
}

interface OrderingUse {
  op: string;
  /**
   * Source text of the two operands, as the key two uses are matched on.
   * JSON-encoded rather than joined by a separator, since an operand's text can
   * itself contain one (`X + 1`) and a naive join would let two different pairs
   * collide into one key.
   */
  key: string;
  /** Which body it appeared in, so a pair within one body is not reported. */
  owner: BodyOwner;
  text: string;
  offset?: number;
  end?: number;
}

/**
 * Ordering comparisons on an operand that can be NULL. Walks through `&&` and
 * `||` so a compound filter still contributes, but not through `!`, where the
 * complement is the point rather than an oversight.
 */
function collectOrderings(
  expr: Expression,
  owner: BodyOwner,
  nonNull: ReadonlySet<string>,
  ctx: Parameters<typeof mayBeNull>[3],
  into: OrderingUse[],
): void {
  if (expr.$type !== "BinaryExpr") return;
  if (expr.op === "&&" || expr.op === "||") {
    collectOrderings(expr.left, owner, nonNull, ctx, into);
    collectOrderings(expr.right, owner, nonNull, ctx, into);
    return;
  }
  if (!ORDERING_OPS.has(expr.op)) return;
  // Only an operand that can actually be NULL leaves a gap.
  if (!mayBeNull(expr.left, nonNull, owner, ctx)) return;
  const left = expr.left.$cstNode?.text;
  const right = expr.right.$cstNode?.text;
  if (left === undefined || right === undefined) return;
  into.push({
    op: expr.op,
    key: JSON.stringify([left, right]),
    owner,
    text: expr.$cstNode?.text ?? `${left} ${expr.op} ${right}`,
    offset: expr.$cstNode?.offset,
    end: expr.$cstNode?.end,
  });
}

/**
 * Ordering comparisons under a `!`, on an operand that can be NULL.
 *
 * Negating an ordering keeps the NULL row rather than excluding it: every
 * ordering is false at NULL (null.md §5), so its negation is true there. A
 * reader who writes `not (X < 2)` for "at least 2" gets the NULL row too, where
 * `X >= 2` would not have it.
 *
 * This is the case `collectOrderings` deliberately leaves alone, on the grounds
 * that writing `!` is a deliberate act. Reported anyway, because the two
 * spellings differing is exactly the trap null.md §8 tells readers to guard
 * against, and a warning is cheap to silence with `<> null`. Revisit if it
 * proves noisy in practice.
 *
 * `negated` tracks parity, so a double negation is not reported: it is the
 * original comparison again and has no gap.
 */
function collectNegatedOrderings(
  expr: Expression,
  owner: BodyOwner,
  nonNull: ReadonlySet<string>,
  ctx: Parameters<typeof mayBeNull>[3],
  negated: boolean,
  into: NullnessDiagnostic[],
): void {
  if (expr.$type === "UnaryExpr" && expr.op === "!") {
    collectNegatedOrderings(expr.operand, owner, nonNull, ctx, !negated, into);
    return;
  }
  if (expr.$type !== "BinaryExpr") return;
  if (expr.op === "&&" || expr.op === "||") {
    collectNegatedOrderings(expr.left, owner, nonNull, ctx, negated, into);
    collectNegatedOrderings(expr.right, owner, nonNull, ctx, negated, into);
    return;
  }
  if (!negated || !ORDERING_OPS.has(expr.op)) return;
  if (!mayBeNull(expr.left, nonNull, owner, ctx) && !mayBeNull(expr.right, nonNull, owner, ctx)) {
    return;
  }
  const text = expr.$cstNode?.text ?? expr.op;
  into.push({
    severity: "warning",
    code: "nullable-negated-ordering",
    message: `Negating \`${text}\` keeps the NULL row: every ordering is false at NULL, so its negation is true there. Add a \`<> null\` guard, or write the ordering you mean.`,
    offset: expr.$cstNode?.offset,
    end: expr.$cstNode?.end,
  });
}

/** `<` pairs with `>=`, and `<=` with `>`: the two that partition non-null values. */
const COMPLEMENT: Record<string, string> = { "<": ">=", ">=": "<", "<=": ">", ">": "<=" };

/**
 * Two bodies comparing the same operands with complementary operators read as a
 * partition, and are one for every value except NULL, which satisfies neither.
 * Reported only across distinct bodies: both in one body is a contradiction,
 * which is a different mistake and not this one.
 */
function orderingGaps(uses: OrderingUse[]): NullnessDiagnostic[] {
  const diagnostics: NullnessDiagnostic[] = [];
  const reported = new Set<string>();
  for (let i = 0; i < uses.length; i++) {
    for (let j = i + 1; j < uses.length; j++) {
      const a = uses[i]!;
      const b = uses[j]!;
      if (a.owner === b.owner) continue;
      if (a.key !== b.key) continue;
      if (COMPLEMENT[a.op] !== b.op) continue;
      if (reported.has(a.key)) continue;
      reported.add(a.key);
      diagnostics.push({
        severity: "warning",
        code: "nullable-ordering-gap",
        message: `\`${a.text}\` and \`${b.text}\` look like a partition but leave out NULL, which satisfies neither. Add a \`<> null\` guard, or a third case for it.`,
        offset: b.offset,
        end: b.end,
      });
    }
  }
  return diagnostics;
}
