// Warnings about a row going missing for a reason that is easy not to expect.
//
// Six of them, split by which of the two the row lost it to. Three are about a
// `null` reaching somewhere surprising: a filter that a null cannot satisfy, two
// orderings that read as a partition but leave the null out, and a `not` over an
// ordering that keeps the null row. Three are about an expression having no value
// at all, which withholds its row (doc/design/null-as-a-value.md §1): a `<>` over
// a partial operand, a `defined(X)` that asks the question about a variable rather
// than about an expression, and the opt-in report of every partial expression
// whose value a rule uses. They sit together because the symptom is the same and
// it is the reason any of them is worth reporting: a missing row, whose cost is
// paid by reading output and counting. None is an error; each is specified
// behaviour that is sometimes exactly what was wanted.
//
// Shaped like `FinitenessDiagnostic` / `PolarityDiagnostic` and consumed the
// same way (a pull-based call from the CLI and the playground), so no warning
// channel out of `inferTypes` is needed.

import type { BodyElement, Expression, PrimitiveType } from "./ast.ts";
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
    | "undefined-expression"
    | "partial-inequality"
    | "constant-defined";
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
      // A filter that does not hold drops its row without a trace, and a `null`
      // in truth-value position never holds: as the filter's own value it is not
      // `true`, and inside a connective it leaves the connective with no value.
      // No comparison returns a null, and neither does `as_boolean`, whose failed
      // projection has no value at all, so this only fires where a null reaches
      // that position some other way: a `boolean?` column, a variable the body
      // binds to the `null` literal, or a connective over one of those.
      //
      // Not for a negated filter, where the premise is inverted: `not e` is
      // negation as failure, so an operand with no value *keeps* the row rather
      // than dropping it. The negated-ordering warning below covers that side.
      if (!elem.negated && nullReachesTruthValue(elem.expr, nonNull, owner, ctx)) {
        diagnostics.push({
          severity: "warning",
          code: "nullable-filter",
          message:
            "This filter drops its row where its operand is null: a null is no truth value, so the filter does not hold. Guard the nullable operand with `<> null` if that is not what you want.",
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
    }

    // The three position-independent warnings, over every position an expression
    // can occupy: a filter, a head argument, and either side of a body equality.
    // A `<>`, an ordering and a `defined(X)` read the same way in each and go
    // wrong the same way, so none of them is a filter-only question. Only the two
    // warnings above are, their subject being what a filter does with a row.
    for (const { expr, filter } of expressionPositions(owner)) {
      collectPartialInequalities(expr, owner, typed, varTypeCache, diagnostics);
      collectConstantDefined(expr, typed, diagnostics);
      // In a filter, refine again without this conjunct: a strict comparison
      // proves its own operands non-null, so asking the fully-refined set whether
      // the operand can be null would always answer no and the gap would never be
      // found. Elsewhere there is no such conjunct to leave out, an equality over
      // a comparison and a head argument both proving nothing about the operands.
      collectOrderings(
        expr,
        owner,
        filter ? refineBody(owner, typed.nullness.columnNullness, ctx, filter) : nonNull,
        ctx,
        orderings,
      );
    }
  }

  diagnostics.push(...orderingGaps(orderings));
  return diagnostics;
}

/**
 * Every position of `owner` an expression can occupy: a filter, either side of a
 * body equality, and a head argument. `filter` is the conjunct itself where the
 * position is one, since a warning that reads the refined variable set has to be
 * able to leave its own guard out.
 */
function expressionPositions(owner: BodyOwner): { expr: Expression; filter?: BodyElement }[] {
  const positions: { expr: Expression; filter?: BodyElement }[] = [];
  for (const elem of owner.body) {
    if (elem.$type === "Filter") positions.push({ expr: elem.expr, filter: elem });
    else if (elem.$type === "Equality") positions.push({ expr: elem.left }, { expr: elem.expr });
  }
  const head = (owner as { head?: { args?: readonly Expression[] } }).head;
  for (const arg of head?.args ?? []) positions.push({ expr: arg });
  return positions;
}

/**
 * Does a `null` reach a truth-value position in `expr`?
 *
 * `mayBeNull` answers for the *result*, which is the right question everywhere
 * but here: a connective's result is never a null, `null` being no truth value
 * (§15.26), so the row leaves because an operand was one. The recursion stops at
 * anything that is not a connective, where the result is what reaches the filter.
 */
function nullReachesTruthValue(
  expr: Expression,
  nonNull: ReadonlySet<string>,
  owner: BodyOwner,
  ctx: Parameters<typeof mayBeNull>[3],
): boolean {
  if (expr.$type === "BinaryExpr" && (expr.op === "&&" || expr.op === "||")) {
    return (
      nullReachesTruthValue(expr.left, nonNull, owner, ctx) ||
      nullReachesTruthValue(expr.right, nonNull, owner, ctx)
    );
  }
  if (expr.$type === "UnaryExpr" && expr.op === "!") {
    return nullReachesTruthValue(expr.operand, nonNull, owner, ctx);
  }
  return mayBeNull(expr, nonNull, owner, ctx);
}

/**
 * `defined(X)` on a bare variable, which is constantly true and is **not**
 * `X <> null` (doc/design/null-as-a-value.md §11.6, third rider).
 *
 * A variable is bound to a value, `null` included, so it is always defined. The
 * two readings are one keystroke apart and only one of them is ever what a reader
 * means on a variable, which is what makes this worth a warning rather than
 * leaving as a tautology to discover.
 *
 * Walks every operator, the way `collectPartialInequalities` does, so the call is
 * found wherever it is written: bare in a filter, under a connective or a `!`, or
 * as an operand of anything else.
 */
function collectConstantDefined(
  expr: Expression,
  typed: TypedProgram,
  into: NullnessDiagnostic[],
): void {
  if (expr.$type === "BinaryExpr") {
    collectConstantDefined(expr.left, typed, into);
    collectConstantDefined(expr.right, typed, into);
    return;
  }
  if (expr.$type === "UnaryExpr") {
    collectConstantDefined(expr.operand, typed, into);
    return;
  }
  if (expr.$type !== "FunctionCall" || expr.name !== "defined") return;
  const arg = expr.args[0];
  if (arg?.$type !== "Variable") return;
  into.push({
    severity: "warning",
    code: "constant-defined",
    message: `\`defined(${arg.name})\` is always true: a variable is bound to a value, and \`null\` is one. If you meant "not null", write \`${arg.name} <> null\`.`,
    offset: expr.$cstNode?.offset,
    end: expr.$cstNode?.end,
  });
}

/**
 * `<>` on an operand that can have no value, which is the one place `<>` and
 * `not (a = b)` come apart (doc/design/null-as-a-value.md §4.2).
 *
 * `A <> 100 / B` requires both sides to have a value, so it does not hold at
 * `B = 0`; `not (A = 100 / B)` does hold there. Either may be what was meant, and
 * the warning exists because the two readings are one rewrite apart and the
 * difference is invisible in the output, which is simply a shorter table.
 *
 * Not reported for `=`, which has no competing reading, nor for the orderings,
 * whose own two warnings are about nulls rather than about absence.
 *
 * Reached from every position a `<>` can occupy, not only a filter: bound to a
 * variable, projected into a head, or under a `!`, the reading is the same and so
 * is the invisibility of the difference.
 */
function collectPartialInequalities(
  expr: Expression,
  owner: BodyOwner,
  typed: TypedProgram,
  varTypeCache: Map<BodyOwner, Map<string, PrimitiveType>>,
  into: NullnessDiagnostic[],
): void {
  if (expr.$type === "UnaryExpr") {
    collectPartialInequalities(expr.operand, owner, typed, varTypeCache, into);
    return;
  }
  if (expr.$type !== "BinaryExpr") return;
  if (expr.op !== "<>") {
    collectPartialInequalities(expr.left, owner, typed, varTypeCache, into);
    collectPartialInequalities(expr.right, owner, typed, varTypeCache, into);
    return;
  }
  let vars = varTypeCache.get(owner);
  if (!vars) {
    vars = rebuildVarTypes(owner.body, typed.columnTypes);
    varTypeCache.set(owner, vars);
  }
  const pctx = {
    overloads: typed.functionOverloads,
    typeOf: (e: Parameters<typeof inferTermType>[0]) => inferTermType(e, vars!, typed.columnTypes),
  };
  const partial = [expr.left, expr.right].find((side) => canBeUndefined(side, pctx));
  if (partial === undefined) return;
  const text = partial.$cstNode?.text;
  into.push({
    severity: "warning",
    code: "partial-inequality",
    message: `${text ? `\`${text}\`` : "An operand here"} can have no value, and \`<>\` does not hold where an operand has none. If you meant "not equal, including where there is nothing to compare", write \`not (a = b)\`.`,
    offset: expr.$cstNode?.offset,
    end: expr.$cstNode?.end,
  });
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
 * Ordering comparisons under a `not`, on an operand that can be null.
 *
 * An ordering is strict at a null, so it has no value there and does not hold,
 * and negation as failure holds of anything that does not hold: the row stays. A
 * reader who writes `not (X < 2)` for "at least 2" therefore gets the null row
 * too, where `X >= 2` does not have it.
 *
 * Only the `not` spelling has that gap. Expression-level `!` propagates the
 * absence instead of complementing it, so `!(X < 2)` drops the null row exactly
 * as `X >= 2` does, and there is nothing to warn about. Which is why passing
 * through a `!` does not flip `negated` here: it is tracking "is this inside a
 * negation as failure", not parity, and a `not` over any shape with no value
 * holds.
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
    collectNegatedOrderings(expr.operand, owner, nonNull, ctx, negated, into);
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
    message: `\`not (${text})\` keeps the null row: the ordering has no value there, so it does not hold, and \`not\` holds of anything that does not. Add a \`<> null\` guard, or write the ordering you mean.`,
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
