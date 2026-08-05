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
import { BITWISE_OPS, EQUALITY_OPS, ORDERING_OPS } from "./ast.ts";
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

  return { columnNullness, nonNullVars };
}

/**
 * The variables `owner`'s body proves non-null.
 *
 * A body is a conjunction, so there is no control flow and no program point at
 * which a guard has not yet run: a guard written last refines the atoms written
 * first, and every conjunct holds of every derived tuple. Run as a fixed point
 * so the result does not depend on the order the conjuncts happen to be in.
 */
function refineBody(
  owner: BodyOwner,
  columnNullness: ReadonlyMap<string, readonly boolean[]>,
  ctx: NullnessContext,
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
 * Can `expr` evaluate to SQL NULL? The forward direction, used for head
 * arguments and for the equality refinement's premise.
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
      // A group exists only because a row does, so `count` is never NULL (an
      // empty count is 0). The rest are NULL exactly when every row in some
      // group has a NULL argument, so they propagate rather than originate.
      return expr.func === "count" ? false : rec(expr.arg);
    case "FunctionCall": {
      const overload = ctx.overloads.get(expr);
      // Unresolved: assume the worst, which keeps the analysis sound when
      // inference could not pin the call.
      if (!overload) return true;
      if (!overload.nulls.total) return true;
      return expr.args.some(rec);
    }
    case "Subscript":
      // A string subscript out of range is `''`, but a `value` one that misses
      // its key or hits the wrong shape is NULL (spec §5.4).
      if (ctx.typeOf(owner, expr.object) !== "string") return true;
      return rec(expr.object) || rec(expr.index);
    case "Slice":
      if (ctx.typeOf(owner, expr.object) !== "string") return true;
      return (
        rec(expr.object) ||
        (expr.start !== undefined && rec(expr.start)) ||
        (expr.end !== undefined && rec(expr.end))
      );
    case "BinaryExpr": {
      const { op, left, right } = expr;
      // Comparison is where NULL stops travelling: every one is total.
      if (EQUALITY_OPS.has(op) || ORDERING_OPS.has(op)) return false;
      // Three-valued but never inventing a NULL, so propagate conservatively.
      if (op === "&&" || op === "||") return rec(left) || rec(right);
      // 32-bit wrapping, so no overflow to escape.
      if (BITWISE_OPS.has(op)) return rec(left) || rec(right);
      // Division and exponentiation are partial whatever their operands:
      // a zero divisor, a negative base with a fractional exponent, overflow.
      if (op === "/" || op === "%" || op === "**") return true;
      // What is left is `+`, `-`, `*` and string concatenation. Integer
      // arithmetic and concatenation are total; float arithmetic is not, a
      // non-finite result being NULL (spec §5.4). An unknown type takes the
      // conservative branch.
      const resultType = ctx.typeOf(owner, expr);
      if (resultType === undefined || resultType === "float") return true;
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
