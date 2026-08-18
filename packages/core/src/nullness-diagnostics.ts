// Warnings about a row going missing for a reason that is easy not to expect.
//
// Three are about NULL reaching somewhere surprising, the residual oddities
// null.md §5 and §8 name. The fourth is about an expression having no value at
// all, which withholds its row (doc/design/null-as-a-value.md §1). They sit
// together because the symptom is the same and it is the reason any of them is
// worth reporting: a missing row, whose cost is paid by reading output and
// counting. None is an error; each is specified behaviour that is sometimes
// exactly what was wanted.
//
// Shaped like `FinitenessDiagnostic` / `PolarityDiagnostic` and consumed the
// same way (a pull-based call from the CLI and the playground), so no warning
// channel out of `inferTypes` is needed.

import type { Expression, PrimitiveType } from "./ast.ts";
import { ORDERING_OPS } from "./ast.ts";
import type { BodyOwner } from "./nullness.ts";
import { mayBeNull, refineBody } from "./nullness.ts";
import { canBeUndefined } from "./partiality.ts";
import type { TypedProgram } from "./types.ts";
import { inferTermType, rebuildVarTypes } from "./types.ts";

export interface NullnessDiagnostic {
  severity: "warning";
  code:
    | "nullable-filter"
    | "nullable-ordering-gap"
    | "nullable-negated-ordering"
    | "undefined-expression";
  message: string;
  offset?: number;
  end?: number;
}

export interface NullnessDiagnosticOptions {
  /**
   * Also report expressions that can have no value (`undefined-expression`).
   *
   * Off by default, and the reason is measured rather than assumed. Across
   * `examples/` the check fires **192 times in 29 of 80 examples**, or 60 times
   * if narrowed to head arguments alone. That is not a corpus full of bugs: a
   * program that writes `Y = 10 / X` usually knows `X` can be zero and wants
   * those rows gone, and one that writes `to_integer(S)` is asking a question
   * that can fail. Partiality is pervasive and mostly intentional, so warning
   * about all of it is the array-bounds-warning mistake.
   *
   * It earns its keep the other way round: as something to switch on when rows
   * you expected are missing, which is exactly when the volume stops being
   * noise. See doc/design/null-as-a-value.md §15.14.
   */
  readonly warnUndefined?: boolean;
}

export function findNullnessRisks(
  typed: TypedProgram,
  opts?: NullnessDiagnosticOptions,
): NullnessDiagnostic[] {
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
    // A synthesised statement is not something the user can act on. The
    // contract check `refinements.ts` emits trips the negated-ordering warning
    // by construction, since it negates the contract and integer arithmetic
    // makes a computed column nullable.
    if ((owner as { synthetic?: boolean }).synthetic) continue;
    const nonNull = typed.nullness.nonNullVars.get(owner.body) ?? new Set<string>();
    if (opts?.warnUndefined) collectUndefinable(owner, typed, varTypeCache, diagnostics);
    for (const elem of owner.body) {
      if (elem.$type !== "Filter") continue;
      // A NULL filter value is "does not match", so the row leaves without a
      // trace. Comparison is total, so this only fires where a NULL reaches
      // boolean position some other way: a `boolean?` column, `as_boolean`, or
      // a connective propagating one (null.md §5).
      //
      // Not for a negated filter, where the premise is inverted: `not e` is
      // negation as failure, so a NULL operand *keeps* the row rather than
      // dropping it. The negated-ordering warning below covers that side.
      if (!elem.negated && mayBeNull(elem.expr, nonNull, owner, ctx)) {
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
      // Seeded from the filter's own flag, since `not X < 2` is now a negated
      // Filter rather than a Filter over `!(X < 2)`.
      collectNegatedOrderings(elem.expr, owner, nonNull, ctx, elem.negated ?? false, diagnostics);
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

/**
 * Expressions whose *value* a rule uses and which can fail to have one, so the
 * rule derives fewer tuples than its body suggests.
 *
 * This is the mitigation for the one real cost of partiality
 * (doc/design/null-as-a-value.md §14.1): the old behaviour put a visible NULL in
 * the row, where now the row is simply absent and nothing says so. A warning at
 * analysis time arrives before the run rather than after, which is the whole
 * point of having it.
 *
 * Reported at exactly the sites the translator guards, since those are the sites
 * where a value is used: head arguments and the sides of an equality. **Not**
 * filters, whose NULL-drops the `nullable-filter` warning above already covers
 * and whose whole job is to remove rows. One diagnostic per rule, naming the
 * first offending expression: a rule that divides twice has one problem, not two.
 */
function collectUndefinable(
  owner: BodyOwner,
  typed: TypedProgram,
  varTypeCache: Map<BodyOwner, Map<string, PrimitiveType>>,
  into: NullnessDiagnostic[],
): void {
  let vars = varTypeCache.get(owner);
  if (!vars) {
    vars = rebuildVarTypes(owner.body, typed.columnTypes);
    varTypeCache.set(owner, vars);
  }
  const pctx = {
    overloads: typed.functionOverloads,
    typeOf: (expr: Parameters<typeof inferTermType>[0]) =>
      inferTermType(expr, vars!, typed.columnTypes),
  };

  const candidates: Expression[] = [];
  const head = (owner as { head?: { args?: readonly Expression[] } }).head;
  if (head?.args) candidates.push(...head.args);
  for (const elem of owner.body) {
    if (elem.$type === "Equality") candidates.push(elem.left, elem.expr);
  }

  for (const expr of candidates) {
    if (!canBeUndefined(expr, pctx)) continue;
    const text = expr.$cstNode?.text;
    into.push({
      severity: "warning",
      code: "undefined-expression",
      message: text
        ? `\`${text}\` can have no value, and a rule derives no tuple where one of its expressions does not. Rows you might expect will be absent rather than carrying a NULL.`
        : "This expression can have no value, and a rule derives no tuple where one of its expressions does not.",
      offset: expr.$cstNode?.offset,
      end: expr.$cstNode?.end,
    });
    return;
  }
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
