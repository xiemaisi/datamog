// Nullness inference: which columns can hold the **null value**, and which
// variables a rule body proves cannot.
//
// Not "can this be undefined": an operation with no value at its arguments
// yields no value at all, which no column holds and no variable binds to. That
// is `canBeUndefined` in `partiality.ts`, and keeping the two questions apart is
// the whole of doc/design/null-as-a-value.md §1.
//
// Two levels, and keeping those apart is the design (see
// doc/design/nullness-tracking.md §4). Nullness of a *variable* is a per-rule
// fact refinable by the body's constraints; nullness of a *column* is a
// per-predicate fact computed as a least fixed point. The first reads the
// second at body atoms, the second reads the first at the head.
//
// Everything here over-approximates: where the answer is not known the answer
// is "may be null". Getting that direction wrong would be unsound rather than
// imprecise, since a column wrongly believed non-null lowers a join to a plain
// `=` and drops the null-to-null match null-as-a-value.md §4.1 specifies, and
// lets Position 3 (§5) accept an operand it must reject.

import { BUILTIN_BODY_ATOMS, headAnnotations } from "./analyzer.ts";
import type { AnalyzedProgram } from "./analyzer.ts";
import type {
  BinaryExpr,
  BodyElement,
  Expression,
  FunctionCall,
  HeadTerm,
  PrimitiveType,
  Query,
  Rule,
} from "./ast.ts";
import { EQUALITY_OPS, ORDERING_OPS } from "./ast.ts";
import type { Overload } from "./builtins.ts";
import { type PartialityContext, canBeUndefined } from "./partiality.ts";

/** A rule or a query: anything with a body whose variables get refined. */
export type BodyOwner = Rule | Query;

export interface NullnessInfo {
  /**
   * Per predicate, per column: can it hold the null value? Extensional columns
   * take their declared `?`; intensional ones are inferred.
   */
  readonly columnNullness: ReadonlyMap<string, readonly boolean[]>;
  /**
   * Per rule and per query: the variables its body proves non-null. Absent
   * from the set means "may be NULL", so a missing entry is safe to read as
   * "nothing proven".
   *
   * Keyed by the body array rather than by the rule or query node, because the
   * translator lowers a query through a synthetic `Rule` that reuses the
   * query's own `body` array. Keying on the node would miss every query.
   */
  readonly nonNullVars: ReadonlyMap<readonly BodyElement[], ReadonlySet<string>>;
  /**
   * Per rule, per head argument: that rule's own contribution, before the join
   * across sibling rules. This is what a head annotation is checked against,
   * annotations being per rule.
   */
  readonly headArgNullness: ReadonlyMap<Rule, readonly boolean[]>;
  /**
   * What each predicate advertises to consumers: `columnNullness` widened by
   * any `?` head annotations on it. Module boundaries and consumers are checked
   * against this; a predicate's own body and all of codegen use the inferred
   * `columnNullness`, so an annotation never changes emitted SQL.
   */
  readonly publishedNullness: ReadonlyMap<string, readonly boolean[]>;
}

/**
 * What the analysis needs from type inference. Passed in rather than imported
 * so this module stays independent of the inference pass that calls it.
 */
export interface NullnessContext {
  /** Type of an expression in the context of one rule or query body. */
  typeOf(owner: BodyOwner, expr: HeadTerm): PrimitiveType | undefined;
  /** Resolved builtin overloads, read for their `nulls` bits. */
  overloads: ReadonlyMap<FunctionCall, Overload>;
}

export function inferNullness(analyzed: AnalyzedProgram, ctx: NullnessContext): NullnessInfo {
  const columnNullness = new Map<string, boolean[]>();

  // An extensional column holds a NULL only if it was declared `?`: without
  // one the table is `NOT NULL` and a loader coercion failure raises instead
  // (spec §5.4).
  for (const [predicate, decl] of analyzed.extDecls) {
    columnNullness.set(
      predicate,
      decl.columns.map((c) => c.nullable === true),
    );
  }

  // Intensional columns seed non-null and rise. Seeding here rather than at
  // "unknown" is what makes a recursive predicate come out right: it is
  // non-null when its base case is and its recursive step propagates.
  for (const predicate of analyzed.rules.keys()) {
    const arity = analyzed.arities.get(predicate) ?? 0;
    columnNullness.set(predicate, new Array(arity).fill(false));
  }

  const nonNullVars = new Map<readonly BodyElement[], ReadonlySet<string>>();

  // Outer fixed point. Monotone: a column only ever flips non-null → nullable,
  // and refinement only ever weakens as its inputs widen, so the head
  // contributions grow monotonically and this terminates at height two.
  let changed = true;
  while (changed) {
    changed = false;
    for (const stratum of analyzed.sortedStrata) {
      for (const predicate of stratum) {
        const rules = analyzed.rules.get(predicate);
        if (!rules) continue;
        const cols = columnNullness.get(predicate)!;
        for (const rule of rules) {
          const nonNull = refineBody(rule, columnNullness, ctx);
          nonNullVars.set(rule.body, nonNull);
          for (let i = 0; i < rule.head.args.length && i < cols.length; i++) {
            if (cols[i]) continue;
            if (mayBeNull(rule.head.args[i]!, nonNull, rule, ctx)) {
              cols[i] = true;
              changed = true;
            }
          }
        }
      }
    }
  }

  // Queries and constraints produce no columns, but their bodies still need
  // refined variables, since codegen lowers them the same way it lowers a rule.
  for (const owner of [...analyzed.queries, ...analyzed.constraints]) {
    nonNullVars.set(owner.body, refineBody(owner, columnNullness, ctx));
  }

  // Per-rule contributions, recomputed once now that the fixed point has
  // converged: the loop above skips positions already known nullable, so it
  // never has the full picture for every rule.
  const headArgNullness = new Map<Rule, readonly boolean[]>();
  for (const rules of analyzed.rules.values()) {
    for (const rule of rules) {
      const nonNull = nonNullVars.get(rule.body) ?? new Set<string>();
      headArgNullness.set(
        rule,
        rule.head.args.map((arg) => mayBeNull(arg, nonNull, rule, ctx)),
      );
    }
  }

  return {
    columnNullness,
    nonNullVars,
    headArgNullness,
    publishedNullness: computePublishedNullness(analyzed, columnNullness),
  };
}

/**
 * The inferred nullness widened by `?` head annotations, which is the contract
 * a predicate's consumers are held to.
 *
 * Only widening is possible: a `?` on a provably non-null column publishes it
 * as nullable, documenting looseness the way a `value` annotation documents a
 * loose type. The reverse is not a widening and is rejected by
 * `checkHeadAnnotations` rather than quietly narrowing the contract.
 */
function computePublishedNullness(
  analyzed: AnalyzedProgram,
  columnNullness: ReadonlyMap<string, readonly boolean[]>,
): ReadonlyMap<string, readonly boolean[]> {
  const published = new Map<string, boolean[]>();
  for (const [predicate, cols] of columnNullness) published.set(predicate, [...cols]);
  for (const [predicate, i, annotation] of headAnnotations(analyzed)) {
    const cols = published.get(predicate);
    if (!cols || i >= cols.length) continue;
    if (annotation.nullable) cols[i] = true;
  }
  return published;
}

/**
 * The variables `owner`'s body proves non-null.
 *
 * A body is a conjunction, so there is no control flow and no program point at
 * which a guard has not yet run: a guard written last refines the atoms written
 * first, and every conjunct holds of every derived tuple. Run as a fixed point
 * so the result does not depend on the order the conjuncts happen to be in.
 */
export function refineBody(
  owner: BodyOwner,
  columnNullness: ReadonlyMap<string, readonly boolean[]>,
  ctx: NullnessContext,
  /**
   * A conjunct to leave out. Used to ask what a variable's nullness would be
   * without a particular guard, which is how the ordering-gap diagnostic avoids
   * being talked out of its own premise: `X < 2` proves `X` non-null, so
   * reading the refined set would hide the very gap the comparison creates.
   */
  skip?: BodyElement,
): ReadonlySet<string> {
  const nonNull = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const add = (names: Iterable<string>) => {
      for (const n of names) {
        if (!nonNull.has(n)) {
          nonNull.add(n);
          changed = true;
        }
      }
    };

    for (const elem of owner.body) {
      if (elem === skip) continue;
      switch (elem.$type) {
        case "Literal": {
          // A negated atom binds nothing, so it proves nothing.
          if (elem.negated) break;
          const spec = BUILTIN_BODY_ATOMS.get(elem.predicate);
          if (spec) {
            // Iterating a null receiver yields no rows, so the atom firing
            // proves the source non-null. Of the bound slots, a JSON object
            // key and an array index are never null, while a value slot can
            // hold a JSON `null` leaf, which is the null value (§8).
            const source = elem.args[spec.sourceArg];
            if (source) add(strictVars(source, ctx));
            for (const bound of spec.boundArgs) {
              const arg = elem.args[bound.index];
              if (arg?.$type === "Variable" && bound.type !== "value") add([arg.name]);
            }
            break;
          }
          const cols = columnNullness.get(elem.predicate);
          if (!cols) break;
          for (let j = 0; j < elem.args.length; j++) {
            const arg = elem.args[j]!;
            if (arg.$type === "Variable" && cols[j] === false) add([arg.name]);
          }
          break;
        }
        case "RangeAtom":
          // `X in [lo .. hi]` is `X BETWEEN lo AND hi`, which is strict, so a
          // NULL `X` never satisfies it whether the range binds or filters.
          add(strictVars(elem.expr, ctx));
          break;
        case "Equality": {
          // `=` matches exactly, and only null matches null, so a provably
          // non-null side forces the other side non-null.
          if (!mayBeNull(elem.expr, nonNull, owner, ctx)) add(strictVars(elem.left, ctx));
          if (!mayBeNull(elem.left, nonNull, owner, ctx)) add(strictVars(elem.expr, ctx));
          break;
        }
        case "Filter":
          // A negated filter is negation as failure over its expression, so all
          // it reports is that the expression did not hold: `failed` rather than
          // `false`, which is the distinction `refineFalse` turns on.
          add(
            elem.negated
              ? refineFalse(elem.expr, "failed", nonNull, owner, ctx)
              : refineTrue(elem.expr, nonNull, owner, ctx),
          );
          break;
      }
    }
  }
  return nonNull;
}

/**
 * The variables proven non-null by `expr` holding.
 *
 * `!` flips to `refineFalse`, which is sound in this direction only: `!e` holds
 * only where `e` has a value and is false, `!` propagating an absence rather than
 * complementing it. That is the `false` premise, the stronger of the two the
 * function takes. The reverse flip is not available, since a comparison is no
 * longer total; `refineFalse` says why.
 */
function refineTrue(
  expr: Expression,
  nonNull: ReadonlySet<string>,
  owner: BodyOwner,
  ctx: NullnessContext,
): Set<string> {
  if (expr.$type === "UnaryExpr" && expr.op === "!") {
    return refineFalse(expr.operand, "false", nonNull, owner, ctx);
  }
  if (expr.$type !== "BinaryExpr") return new Set();
  const { op, left, right } = expr;
  if (op === "&&") {
    return union(refineTrue(left, nonNull, owner, ctx), refineTrue(right, nonNull, owner, ctx));
  }
  if (op === "||") {
    // Both branches have to prove it, but when they do the disjunction does:
    // `(X <> null) || (X > 5)` proves `X` non-null either way.
    return intersect(refineTrue(left, nonNull, owner, ctx), refineTrue(right, nonNull, owner, ctx));
  }
  // A true ordering proves both sides non-null, every ordering being strict at
  // null (null-as-a-value.md §4.1). `<=` and `>=` join `<` and `>` here: they
  // used to prove nothing, being true of two nulls, which was the wart §4.1
  // deletes.
  if (ORDERING_OPS.has(op)) {
    return union(strictVars(left, ctx), strictVars(right, ctx));
  }
  // `X <> null` is exactly the non-null test, `<>` being null-aware. A partial
  // operand needs no guard on this side: `<>` holding means it had a value.
  if (op === "<>") return nullTestVars(expr, owner, ctx, false);
  // `X = e` for a non-null `e`, the filter-position twin of body Equality.
  if (op === "=") {
    const proven = new Set<string>();
    if (!mayBeNull(right, nonNull, owner, ctx)) addAll(proven, strictVars(left, ctx));
    if (!mayBeNull(left, nonNull, owner, ctx)) addAll(proven, strictVars(right, ctx));
    return proven;
  }
  return new Set();
}

/**
 * What a caller of `refineFalse` knows, and the two callers do not know the same
 * thing. `!e` being true means `e` is **false**; `not e` holding means `e`
 * **failed**, which is false *or* no value at all. The leaf case reasons from
 * falsity, so it has to be told which premise it is under.
 */
type Falsity = "false" | "failed";

/**
 * The variables proven non-null by `expr` *not* holding, in the sense `premise`
 * names.
 *
 * The induction that keeps the compound arms sound is worth stating, because it
 * runs on "did not hold" rather than on "is false". `a && b` not holding means at
 * least one side did not hold, and the intersection is contained in whichever
 * one that is. `a || b` not holding means *neither* side held, both by
 * dominance, so the union is licensed. Only the leaf needs the premise.
 */
function refineFalse(
  expr: Expression,
  premise: Falsity,
  nonNull: ReadonlySet<string>,
  owner: BodyOwner,
  ctx: NullnessContext,
): Set<string> {
  if (expr.$type === "UnaryExpr" && expr.op === "!") {
    // No double-negation elimination in this direction, and this is the one arm
    // where the two are not symmetric. `!e` failing to hold means `e` is true, or
    // `e` has no value: `not (!(X < 2))` holds at a null `X`, the ordering having
    // no value there and `!` propagating that. So nothing is proven, where
    // `refineTrue` may flip soundly, `!e` being *true* only where `e` has a value
    // and is false. Under the `false` premise a flip back to `refineTrue` would be
    // sound; `!!e` is not a shape worth the arm.
    return new Set();
  }
  if (expr.$type !== "BinaryExpr") return new Set();
  const { op, left, right } = expr;
  // De Morgan: `!(a && b)` is `!a || !b`, so both branches must prove it.
  if (op === "&&") {
    return intersect(
      refineFalse(left, premise, nonNull, owner, ctx),
      refineFalse(right, premise, nonNull, owner, ctx),
    );
  }
  if (op === "||") {
    return union(
      refineFalse(left, premise, nonNull, owner, ctx),
      refineFalse(right, premise, nonNull, owner, ctx),
    );
  }
  // `not (X = null)` is the same fact as `X <> null`, spelled as a SQL
  // programmer would, *as long as the tested operand has a value everywhere*:
  // otherwise `not` also holds where the equality has none, and an absence says
  // nothing about a null. A false ordering comparison proves nothing either way:
  // that is exactly where the null row lives, `not (X < 2)` holding of it.
  if (op === "=") return nullTestVars(expr, owner, ctx, premise === "failed");
  return new Set();
}

/**
 * For a comparison against the `null` literal, the strict positions of the
 * other side. Bails on any other shape: `X <> Y` for a non-null `Y` proves
 * nothing, `null <> 5` being true.
 *
 * `requireDefined` is what keeps a negation-as-failure caller honest. Equality is
 * total over values but strict in undefinedness, so `A["x"] = null` has no value
 * where the key is missing, and `not (A["x"] = null)` holds there without `A`
 * being anything in particular. Under that premise only an operand that cannot be
 * undefined licenses the conclusion, which leaves the idiom the guard exists for,
 * a bare variable, untouched.
 */
function nullTestVars(
  expr: BinaryExpr,
  owner: BodyOwner,
  ctx: NullnessContext,
  requireDefined: boolean,
): Set<string> {
  const tested =
    expr.right.$type === "NullLiteral"
      ? expr.left
      : expr.left.$type === "NullLiteral"
        ? expr.right
        : undefined;
  if (tested === undefined) return new Set();
  if (requireDefined && canBeUndefined(tested, partialityCtx(owner, ctx))) return new Set();
  return strictVars(tested, ctx);
}

/** `canBeUndefined`'s context, which is this one minus the rule. */
function partialityCtx(owner: BodyOwner, ctx: NullnessContext): PartialityContext {
  return { overloads: ctx.overloads, typeOf: (expr) => ctx.typeOf(owner, expr) };
}

/**
 * The variables occurring in a *strict position* of `expr`: reachable from the
 * root through strict operations only.
 *
 * The reasoning this licenses is one step, and every caller supplies the same
 * premise: this expression has a value, and that value is not null. Were a
 * strictly-occurring variable null, strictness would have left the expression
 * with a null or with no value, and either contradicts the premise. Non-strict
 * operators block the walk and must: a `X <> null` subexpression has a non-null
 * value whatever `X` is, so nothing under one is proven.
 */
function strictVars(
  expr: Expression,
  ctx: NullnessContext,
  into: Set<string> = new Set(),
): Set<string> {
  switch (expr.$type) {
    case "Variable":
      into.add(expr.name);
      break;
    case "UnaryExpr":
      // `-` propagates a null operand. `!` has no value at one, a null being no
      // truth value (§15.26), which is strictness of the kind this walk wants:
      // `!e` having a value at all means `e` had one and was not a null.
      strictVars(expr.operand, ctx, into);
      break;
    case "BinaryExpr":
      if (isStrictOp(expr.op)) {
        strictVars(expr.left, ctx, into);
        strictVars(expr.right, ctx, into);
      }
      break;
    case "Conditional":
      // Strict in the condition and in neither branch. A conditional with a
      // value proves its condition had one and was not a null, the same
      // reasoning `!` gets; it proves nothing about a branch, since only one of
      // them was evaluated and this walk cannot tell which.
      strictVars(expr.cond, ctx, into);
      break;
    case "FunctionCall": {
      // Unresolved means no refinement, which is the safe direction here:
      // proving fewer variables non-null only loses precision.
      const overload = ctx.overloads.get(expr);
      if (overload?.nulls.strict) {
        for (const arg of expr.args) strictVars(arg, ctx, into);
      }
      break;
    }
    case "Subscript":
      strictVars(expr.object, ctx, into);
      strictVars(expr.index, ctx, into);
      break;
    case "Slice":
      strictVars(expr.object, ctx, into);
      if (expr.start) strictVars(expr.start, ctx, into);
      if (expr.end) strictVars(expr.end, ctx, into);
      break;
    // Array and object construction is not strict: `[null]` is a non-null
    // array. Aggregates cannot occur in a body. Literals bind nothing.
  }
  return into;
}

/** The operators that propagate a NULL operand to their result. */
function isStrictOp(op: string): boolean {
  if (EQUALITY_OPS.has(op) || ORDERING_OPS.has(op)) return false;
  // The connectives are three-valued but absorbing: `false && null` is false.
  return op !== "&&" && op !== "||";
}

/**
 * Can `expr` evaluate to the **null value**? The forward direction, used for
 * head arguments and for the equality refinement's premise.
 *
 * Not "can it be undefined": that is `canBeUndefined` in `partiality.ts`, and
 * keeping the two apart is the whole of doc/design/null-as-a-value.md. A partial
 * operation *originates* no nullness at all now, because it yields no value
 * rather than a null, so the cases below split into two kinds:
 *
 * - **Originates** a null: the `null` literal, a nullable column, a `value`
 *   accessor reaching a JSON `null` leaf, and a `value`-typed builtin result,
 *   which may be one.
 * - **Propagates** its operands' nullness, and nothing more: arithmetic, the
 *   bitwise operators, string concatenation, and every builtin. A NULL comes out
 *   of `X / Y` only because one went in.
 * - **Stops** it: the comparisons, and the connectives with them, a null being
 *   no truth value (§15.26).
 *
 * Propagation is still needed because §5's hybrid position is only half
 * enforced: a *statically* `null` operand is a type error, but a `T?` one is
 * not, since overload resolution reads the base type and not the nullness bit.
 * So `X + 1` with `X : integer?` still type-checks and still propagates.
 */
export function mayBeNull(
  expr: HeadTerm,
  nonNull: ReadonlySet<string>,
  owner: BodyOwner,
  ctx: NullnessContext,
): boolean {
  const rec = (e: HeadTerm) => mayBeNull(e, nonNull, owner, ctx);
  switch (expr.$type) {
    case "StringLiteral":
    case "NumberLiteral":
    case "BooleanLiteral":
      return false;
    // Construction, not propagation: `[null]` and `{"k": null}` are values.
    case "ArrayLiteral":
    case "ObjectLiteral":
      return false;
    case "NullLiteral":
      return true;
    case "Variable":
      return !nonNull.has(expr.name);
    case "UnaryExpr":
      // `!null` has no value rather than being a null, a null being no truth
      // value (§15.26), so logical negation originates and propagates nothing.
      // Arithmetic negation still passes a null on, where Position 3 has not
      // already rejected the operand.
      return expr.op === "!" ? false : rec(expr.operand);
    case "AggregateCall":
      // No aggregate yields a null any more, which is what §7's identities
      // bought. `count`, `sum`, `concat` and `list` fold monoids whose
      // identities are `0`, `""` and `[]`; `avg`, `min` and `max` either return
      // one of their arguments or have no value at all, and they skip nulls on
      // the way, so a null never comes back out.
      return false;
    case "FunctionCall": {
      const overload = ctx.overloads.get(expr);
      // Unresolved: assume the worst, which keeps the analysis sound when
      // inference could not pin the call.
      if (!overload) return true;
      // A `value`-typed result may be a JSON `null`, which is a value:
      // `parse_json("null")` is the case. Everything else either returns a
      // primitive or has no value, so it only passes on what it was given.
      if (overload.result === "value") return true;
      // A non-strict overload answers for a null rather than passing it on, which
      // is exactly what the registry's `strict` bit records: `type_of(null)` is
      // `"null"` and `defined(null)` is true, neither of them a null.
      if (!overload.nulls.strict) return false;
      // And a strict one passes a null on only through a *primitive* parameter. A
      // `value` parameter accepts a null as one of the shapes it holds, so the
      // null reaches the function and the function answers: `as_integer(null)`
      // has no value, `null` being no integer. This mirrors `evalCall`, which
      // skips its short-circuit for a `value` parameter for the same reason
      // (§15.10), and without it every fold over a proof term looks nullable,
      // proof-term arguments being `value` subscripts.
      const params = overload.params;
      return expr.args.some((arg, i) => {
        const param = params[i] ?? params[params.length - 1];
        return param !== "value" && rec(arg);
      });
    }
    case "Subscript":
      // A `value` key that is present and holds a JSON `null` yields the null
      // value. A missing key or wrong shape has no value at all, which is
      // `canBeUndefined`'s business rather than this function's.
      if (ctx.typeOf(owner, expr.object) === "value") return true;
      return rec(expr.object) || rec(expr.index);
    case "Slice":
      // A slice of a `value` is an array or nothing, never a null.
      return (
        rec(expr.object) ||
        (expr.start !== undefined && rec(expr.start)) ||
        (expr.end !== undefined && rec(expr.end))
      );
    case "Conditional":
      // The value is one of the branches, so their nullness joins. The
      // condition's own nullness does not enter: a null condition gives the
      // whole conditional no value rather than a null one, and Position 3
      // rejects a nullable condition anyway.
      return rec(expr.consequent) || rec(expr.alternate);
    case "BinaryExpr": {
      const { op, left, right } = expr;
      // Comparison is where a null stops travelling: equality is total over
      // values, and an ordering is strict at a null, so neither returns one.
      if (EQUALITY_OPS.has(op) || ORDERING_OPS.has(op)) return false;
      // A connective stops it too, and for the ordering's reason: `null` is no
      // truth value, so `null && true` has no value rather than being a null
      // (§15.26). That is what keeps a connective's result non-nullable, which
      // is what §9.2 needs in order to read a SQL NULL as undefined.
      if (op === "&&" || op === "||") return false;
      // Everything else propagates its operands' nullness and originates none.
      // Division, modulo and exponentiation used to answer `true` outright, and
      // arithmetic with it, because overflow and a zero divisor produced a
      // NULL; they produce no value now, so they contribute nothing here.
      return rec(left) || rec(right);
    }
    default:
      return true;
  }
}

function union(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set(a);
  addAll(out, b);
  return out;
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

function addAll(into: Set<string>, from: Iterable<string>): void {
  for (const x of from) into.add(x);
}
