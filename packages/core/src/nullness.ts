// Nullness inference: which columns can hold SQL NULL, and which variables a
// rule body proves cannot.
//
// Two levels, and keeping them apart is the design (see
// doc/design/nullness-tracking.md §4). Nullness of a *variable* is a per-rule
// fact refinable by the body's constraints; nullness of a *column* is a
// per-predicate fact computed as a least fixed point. The first reads the
// second at body atoms, the second reads the first at the head.
//
// Everything here over-approximates: where the answer is not known the answer
// is "may be NULL". Getting that direction wrong would be unsound rather than
// imprecise, since a column wrongly believed non-null lowers a join to a plain
// `=` and drops the NULL-NULL match that null.md §4 specifies.

import { BUILTIN_BODY_ATOMS } from "./analyzer.ts";
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

/** A rule or a query: anything with a body whose variables get refined. */
export type BodyOwner = Rule | Query;

export interface NullnessInfo {
  /**
   * Per predicate, per column: can it hold SQL NULL? Extensional columns take
   * their declared `?`; intensional ones are inferred.
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
  for (const [predicate, rules] of analyzed.rules) {
    const cols = published.get(predicate);
    if (!cols) continue;
    for (const rule of rules) {
      const annotations = rule.head.argTypes;
      if (annotations === undefined) continue;
      for (let i = 0; i < annotations.length && i < cols.length; i++) {
        if (annotations[i]?.nullable === true) cols[i] = true;
      }
    }
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
            // Iterating a NULL receiver yields no rows, so the atom firing
            // proves the source non-null. Of the bound slots, a JSON object
            // key and an array index are never NULL, while a value slot can
            // be a JSON null leaf, which is SQL NULL (spec §2.9).
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
          // `negated` is lowered to `!(...)` by post-processing, but handle it
          // so the analysis is also correct on a raw AST.
          add(
            elem.negated
              ? refineFalse(elem.expr, nonNull, owner, ctx)
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
 * Runs in negation normal form: `!` flips to `refineFalse` rather than
 * blocking, which is meaning-preserving because comparison is total, so `not`
 * over one is exact complementation (null.md §5).
 */
function refineTrue(
  expr: Expression,
  nonNull: ReadonlySet<string>,
  owner: BodyOwner,
  ctx: NullnessContext,
): Set<string> {
  if (expr.$type === "UnaryExpr" && expr.op === "!") {
    return refineFalse(expr.operand, nonNull, owner, ctx);
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
  // A true strict comparison proves both sides non-null: `<` and `>` are false
  // whenever either side is null. `<=` and `>=` prove nothing, being true of
  // two nulls (null.md §5).
  if (op === "<" || op === ">") {
    return union(strictVars(left, ctx), strictVars(right, ctx));
  }
  // `X <> null` is exactly the non-null test, `<>` being total and null-aware.
  if (op === "<>") return nullTestVars(expr, ctx);
  // `X = e` for a non-null `e`, the filter-position twin of body Equality.
  if (op === "=") {
    const proven = new Set<string>();
    if (!mayBeNull(right, nonNull, owner, ctx)) addAll(proven, strictVars(left, ctx));
    if (!mayBeNull(left, nonNull, owner, ctx)) addAll(proven, strictVars(right, ctx));
    return proven;
  }
  return new Set();
}

/** The variables proven non-null by `expr` *not* holding. */
function refineFalse(
  expr: Expression,
  nonNull: ReadonlySet<string>,
  owner: BodyOwner,
  ctx: NullnessContext,
): Set<string> {
  if (expr.$type === "UnaryExpr" && expr.op === "!") {
    return refineTrue(expr.operand, nonNull, owner, ctx);
  }
  if (expr.$type !== "BinaryExpr") return new Set();
  const { op, left, right } = expr;
  // De Morgan: `!(a && b)` is `!a || !b`, so both branches must prove it.
  if (op === "&&") {
    return intersect(
      refineFalse(left, nonNull, owner, ctx),
      refineFalse(right, nonNull, owner, ctx),
    );
  }
  if (op === "||") {
    return union(refineFalse(left, nonNull, owner, ctx), refineFalse(right, nonNull, owner, ctx));
  }
  // `not (X = null)` is the same fact as `X <> null`, spelled as a SQL
  // programmer would. A false ordering comparison proves nothing: that is
  // exactly where the NULL row lives, `not (X < 2)` holding of it.
  if (op === "=") return nullTestVars(expr, ctx);
  return new Set();
}

/**
 * For a comparison against the `null` literal, the strict positions of the
 * other side. Bails on any other shape: `X <> Y` for a non-null `Y` proves
 * nothing, `null <> 5` being true.
 */
function nullTestVars(expr: BinaryExpr, ctx: NullnessContext): Set<string> {
  if (expr.right.$type === "NullLiteral") return strictVars(expr.left, ctx);
  if (expr.left.$type === "NullLiteral") return strictVars(expr.right, ctx);
  return new Set();
}

/**
 * The variables occurring in a *strict position* of `expr`: reachable from the
 * root through strict operations only.
 *
 * The reasoning this licenses is one step. If the whole expression is known
 * non-null and a strictly-occurring variable were null, strictness would have
 * made the expression null. Non-strict operators block the walk and must: a
 * `X <> null` subexpression is non-null whatever `X` is, so nothing under one
 * is proven.
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
      // Both `-` and `!` propagate a NULL operand.
      strictVars(expr.operand, ctx, into);
      break;
    case "BinaryExpr":
      if (isStrictOp(expr.op)) {
        strictVars(expr.left, ctx, into);
        strictVars(expr.right, ctx, into);
      }
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
 *   connectives, the bitwise operators, string concatenation, and every
 *   builtin. A NULL comes out of `X / Y` only because one went in.
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
      return rec(expr.operand);
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
      return expr.args.some(rec);
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
    case "BinaryExpr": {
      const { op, left, right } = expr;
      // Comparison is where NULL stops travelling: every one is total.
      if (EQUALITY_OPS.has(op) || ORDERING_OPS.has(op)) return false;
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
