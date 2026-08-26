// Runtime term evaluation for the native Datalog backend.
//
// The functions here mirror the cross-backend invariants the SQL translator
// encodes into generated SQL:
//   - `/0` and `%0` produce NULL
//   - arithmetic overflow produces NULL rather than IEEE Infinity / NaN
//   - `sqrt(x<0)`, `ln(x<=0)`, `0 ** neg`, `neg ** fractional` → NULL
//   - slice bounds that would walk backwards → empty string
//   - NULL propagates through arithmetic, functions, subscript/slice
//   - no comparison yields NULL. Equality is null-aware (`logicalEq`); an
//     ordering is strict at null, `null` being outside the order. See
//     doc/design/null-as-a-value.md §4.1.
//
// Integer-vs-float division follows the same type-driven decision as the
// translator: both operands integer → truncating division; otherwise
// floating-point division.

import type {
  AggregateCall,
  Expression,
  FunctionCall,
  HeadTerm,
  Overload,
  PrimitiveType,
} from "datamog-core";
import { BUILTINS, BUILTIN_KEYS, assertNever, inferTermType } from "datamog-core";
import { type JsonValue, canonicalizeJson, isJsonValue } from "datamog-engine";

/**
 * `JsonValue` (JSON arrays and objects, plus the `null`/boolean/number/
 * string leaves that overlap with primitive `Value`s) join the native
 * value union for `json`-typed columns. The type system guarantees that
 * a value-typed column never joins a non-value one, so the overlap with
 * primitive leaves doesn't cause cross-type confusion at runtime: a
 * variable bound from a value column is always treated structurally
 * (subscript, equality), and a variable bound from a string column always
 * primitively.
 */
export type Value = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * What evaluating an expression yields: a value, or `undefined` when the
 * expression has none.
 *
 * The two markers are not interchangeable and the whole of §8 rests on that.
 * `null` is an ordinary value a column can hold; `undefined` is the absence of
 * one, so a conjunct mentioning it does not hold and a head containing it
 * derives no tuple. A `value` accessor returns `null` for a present-but-null key
 * and `undefined` for a missing one, which the previous single marker could not
 * express. See doc/design/null-as-a-value.md §1, §8 and §15.4.
 */
export type EvalResult = Value | undefined;
export type Substitution = Map<string, Value>;

export interface TypeEnv {
  vars: Map<string, PrimitiveType>;
  columns: ReadonlyMap<string, readonly PrimitiveType[]>;
  /**
   * Built-in function overloads resolved during type inference. The
   * native impl table dispatches on `Overload.key`; values that share
   * an emit shape across overloads (`abs.integer` and `abs.float`) can
   * register the same impl, and untyped `null`-only calls fall through
   * to the first arity-matching overload at evaluation time.
   */
  functionOverloads: ReadonlyMap<FunctionCall, Overload>;
}

/** Substitution-backed type lookup that `inferTermType` expects. */
function typesFor(env: TypeEnv): ReadonlyMap<string, ReadonlyArray<PrimitiveType | undefined>> {
  return env.columns;
}

// Runtime type assertions. These replace bare `v as number` / `v as string`
// casts so a planner or analyzer bug surfaces immediately, with context,
// instead of silently producing NaN or weird coercions.

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  return `${typeof v} (${JSON.stringify(v)})`;
}

// The parameter is `Value`, never `EvalResult`. An absence is not a wrong type,
// it is the lack of one, and the caller has to answer it by withholding rather
// than by asserting. Keeping `undefined` out of the parameter type turns a
// missed absence check into a compile error instead of a crash at run time.

function asNumber(v: Value): number {
  if (typeof v !== "number") {
    throw new Error(`Type assertion failed: expected number, got ${describeValue(v)}`);
  }
  return v;
}

function asString(v: Value): string {
  if (typeof v !== "string") {
    throw new Error(`Type assertion failed: expected string, got ${describeValue(v)}`);
  }
  return v;
}

function asOrderable(v: Value): number | string {
  if (typeof v !== "number" && typeof v !== "string") {
    throw new Error(`Type assertion failed: expected number or string, got ${describeValue(v)}`);
  }
  return v;
}

/**
 * The ordering operators, which are strict at null: an order has no place for
 * `null`, so an ordering over one has no value. It never yields a null either,
 * having no null to yield. See doc/design/null-as-a-value.md §4.1.
 */
const ORDERING_OPS: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);

function compareStrings(a: string, b: string): number {
  const acp = [...a];
  const bcp = [...b];
  const len = Math.min(acp.length, bcp.length);
  for (let i = 0; i < len; i++) {
    const av = acp[i]!.codePointAt(0)!;
    const bv = bcp[i]!.codePointAt(0)!;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return acp.length < bcp.length ? -1 : acp.length > bcp.length ? 1 : 0;
}

function compareOrderable(a: number | string, b: number | string): number {
  if (typeof a !== typeof b) {
    throw new Error(`Cannot order-compare ${describeValue(a)} with ${describeValue(b)}`);
  }
  if (typeof a === "string" && typeof b === "string") return compareStrings(a, b);
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

function asBoolean(v: Value): boolean {
  if (typeof v !== "boolean") {
    throw new Error(`Type assertion failed: expected boolean, got ${describeValue(v)}`);
  }
  return v;
}

/**
 * A non-finite result has no value, so it is *undefined* rather than null.
 * `undefined` is the interpreter's marker for "no value"; `null` stays the
 * ordinary null value a column can hold. Keeping them apart is what lets a
 * `value` accessor return a present-but-null key as a value while a missing key
 * withholds the row. See doc/design/null-as-a-value.md §1 and §8.
 */
export function finiteOrUndef(v: number): number | undefined {
  return Number.isFinite(v) ? v : undefined;
}

/** Leaving the integer domain is undefined, per §1. */
function safeIntegerOrUndef(v: number): number | undefined {
  return Number.isSafeInteger(v) ? v : undefined;
}

/**
 * Replace IEEE Infinity / NaN with `null` for JSON-construction paths.
 * This is still needed at value-construction boundaries because a caller
 * may lift a non-finite host value directly, bypassing Datamog expression
 * evaluation.
 */
export function scrubNonFiniteForJson(v: Value): JsonValue {
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v as JsonValue;
}

/**
 * Evaluate a head term or body expression under a substitution.
 *
 * `aggregates` resolves an AggregateCall leaf. An aggregate may sit inside a
 * head expression (`count(*) - 1`), so the group-by machinery passes a
 * resolver that reduces it over the group; everywhere else there is no group
 * and reaching one is a planner bug. Ordinary variables in such an expression
 * are grouping variables, which the analyzer guarantees, so they hold the
 * same value for every substitution in the group and any one of them will do.
 */
export function evalTerm(
  term: HeadTerm,
  sub: Substitution,
  env: TypeEnv,
  aggregates?: (agg: AggregateCall) => EvalResult,
): EvalResult {
  switch (term.$type) {
    case "StringLiteral":
      return term.value;
    case "NumberLiteral":
      return term.value;
    case "BooleanLiteral":
      return term.value;
    case "NullLiteral":
      return null;
    case "Variable": {
      const v = sub.get(term.name);
      return v === undefined ? null : v;
    }
    case "UnaryExpr": {
      const v = evalTerm(term.operand, sub, env, aggregates);
      // Both unary operators are strict in the absence marker. For `!` that is
      // §4.4: expression-level `!` propagates undefinedness where formula-level
      // `not` complements failure, so the two do not agree. Arithmetic negation
      // has nothing to negate. Only the `null` value flows through, and only
      // through `!`.
      if (v === undefined) return undefined;
      if (term.op === "!") {
        // `null` is not a truth value, so `!null` has *no value* rather than
        // being `null`. Same argument as the orderings' strictness (§4.1): the
        // operator needs a domain, and the null is not in this one. It is also
        // what keeps a connective's result non-nullable, so a SQL NULL in one
        // has a single reading (§9.2, §15.26).
        return v === null ? undefined : !asBoolean(v);
      }
      if (v === null) return null;
      const negated = -asNumber(v);
      return inferTermType(term, env.vars, typesFor(env)) === "integer"
        ? safeIntegerOrUndef(negated)
        : finiteOrUndef(negated);
    }
    case "Conditional": {
      const c = evalTerm(term.cond, sub, env, aggregates);
      // Strict in the condition, like `!` and the connectives past their
      // absorbing value: neither an absence nor a `null` is a truth value, so
      // the conditional has no value at either. Lazy in the branches, matching
      // SQL's `CASE`, so an undefined in the branch not taken costs nothing.
      if (c === undefined || c === null) return undefined;
      return asBoolean(c)
        ? evalTerm(term.consequent, sub, env, aggregates)
        : evalTerm(term.alternate, sub, env, aggregates);
    }
    case "BinaryExpr": {
      const l = evalTerm(term.left, sub, env, aggregates);
      const r = evalTerm(term.right, sub, env, aggregates);
      // The connectives are non-strict in the *absorbing* case and strict
      // otherwise. `false` dominates a `&&` and `true` dominates a `||`, so
      // either survives an operand that has no value, which is what makes
      // `X <> 0 && 10 / X > 0` a usable guard (§4.4). Past that the connective
      // needs truth values, and neither an absence nor a `null` is one, so it
      // has no value. Treating the two differently here is what made a bound
      // connective nullable *and* partial, the one shape that leaves a SQL NULL
      // ambiguous (§9.2, §15.26). SQL agrees without being asked: `TRUE AND
      // NULL` is NULL either way.
      if (term.op === "&&") {
        if (l === false || r === false) return false;
        if (l === undefined || r === undefined || l === null || r === null) return undefined;
        return asBoolean(l) && asBoolean(r);
      }
      if (term.op === "||") {
        if (l === true || r === true) return true;
        if (l === undefined || r === undefined || l === null || r === null) return undefined;
        return asBoolean(l) || asBoolean(r);
      }
      // Every other operator, comparisons included, is undefined at an
      // undefined operand. For a comparison that is what §4.4 requires: as a
      // condition it fails to hold, which is what drops the row and what makes
      // `not` of it hold, and as an expression it has no value to bind.
      //
      // This replaced a static `canBeUndefined` test. With a runtime marker the
      // interpreter can see which of the two a NULL is, so it no longer has to
      // be told.
      if (l === undefined || r === undefined) return undefined;
      // `=` / `<>` are null-aware over *values*. JS `===` already gives the
      // right answer for the null value; JSON values need structural equality
      // to agree with the SQL backends.
      if (term.op === "=") return valueStructuralEq(l, r);
      if (term.op === "<>") return !valueStructuralEq(l, r);
      // An ordering needs an order and `null` is not in one, so it is strict at
      // null: no value, rather than a false or a true picked by convention
      // (doc/design/null-as-a-value.md §4.1). In condition position that drops
      // the row exactly as the old `false` did, and its negation holds exactly as
      // before, which is why almost nothing observes the change; what changes is
      // `null <= null`, which used to be true by fiat, and an ordering bound to a
      // variable, which now derives nothing.
      if (l === null || r === null) {
        if (ORDERING_OPS.has(term.op)) return undefined;
        // Arithmetic, concatenation and the bitwise operators still *propagate*
        // the null value, as spec §5.4 says. This is deliberately not the
        // absence marker: under §5's hybrid position, arithmetic on a nullable
        // operand is a static type error, so the right answer is to reject the
        // program rather than to invent a runtime one. Until that lands,
        // propagation is what the spec documents and what these operators do.
        return null;
      }
      return evalBinary(term.op, l, r, term.left, term.right, env);
    }
    case "FunctionCall": {
      // Builtins are strict in the absence marker: a call on an argument with no
      // value has no value either. That strictness is what makes
      // `not defined(e)` work rather than `undefined(e)` (§11.6).
      const args = term.args.map((a) => evalTerm(a, sub, env, aggregates));
      if (args.some((a) => a === undefined)) return undefined;
      return evalCall(term, args as Value[], env);
    }
    case "AggregateCall": {
      if (aggregates) return aggregates(term);
      throw new Error(`Aggregate '${term.func}' evaluated outside aggregate context`);
    }
    case "Subscript": {
      const obj = evalTerm(term.object, sub, env, aggregates);
      const idx = evalTerm(term.index, sub, env, aggregates);
      // Two markers, one disposition. A part with no value leaves the access with
      // none either, an access being strict (§1); a null receiver or a null index
      // is a shape the operation has no answer for. Neither may reach the string
      // branch's assertions below.
      if (obj === undefined || idx === undefined) return undefined;
      if (obj === null || idx === null) return undefined;
      const objType = inferTermType(term.object, env.vars, typesFor(env));
      if (objType === "value") {
        // This is §8, and it is why the interpreter needs two markers. A missing
        // key, an out-of-range index, a wrong-shape access and a primitive leaf
        // all have *no value*, so they are undefined and the row goes. A key that
        // is present and holds a JSON null has a value, namely null, so the row
        // stays and carries it. The single marker could not tell those apart.
        if (Array.isArray(obj)) {
          if (typeof idx !== "number" || !Number.isInteger(idx)) return undefined;
          if (idx < 0 || idx >= obj.length) return undefined;
          return obj[idx] as Value;
        }
        if (typeof obj === "object") {
          if (typeof idx !== "string") return undefined;
          if (!Object.hasOwn(obj as object, idx)) return undefined;
          return (obj as Record<string, JsonValue>)[idx] as Value;
        }
        return undefined;
      }
      // Iterate code points so multi-byte characters (e.g. 😀, which is a
      // UTF-16 surrogate pair) count as one position — matches SQL's
      // SUBSTR-by-character behaviour on every backend.
      const cp = [...asString(obj)];
      const i = asNumber(idx);
      if (i < 0 || i >= cp.length) return "";
      return cp[i]!;
    }
    case "Slice": {
      const obj = evalTerm(term.object, sub, env, aggregates);
      // Same strictness as a subscript, in the receiver and in either bound: a
      // bound with no value leaves the slice with none, so `W[0 : 10 / V]` is
      // withheld where `V` is zero rather than reaching the assertions below.
      if (obj === undefined || obj === null) return undefined;
      const objType = inferTermType(term.object, env.vars, typesFor(env));
      if (objType === "value") {
        // Slicing a non-array `value` returns NULL; otherwise produces a
        // sub-array. Empty / reversed ranges return [], matching the SQL
        // backends' `COALESCE(...)` shape.
        if (!Array.isArray(obj)) return undefined;
        const start = term.start ? evalTerm(term.start, sub, env, aggregates) : 0;
        const end = term.end ? evalTerm(term.end, sub, env, aggregates) : obj.length;
        if (start === undefined || end === undefined) return undefined;
        if (start === null || end === null) return undefined;
        const si = asNumber(start);
        const ei = asNumber(end);
        if (si < 0 || ei < 0) return [];
        if (ei <= si) return [];
        return obj.slice(si, ei) as JsonValue[];
      }
      const cp = [...asString(obj)];
      const start = term.start ? evalTerm(term.start, sub, env, aggregates) : 0;
      const end = term.end ? evalTerm(term.end, sub, env, aggregates) : cp.length;
      if (start === undefined || end === undefined) return undefined;
      if (start === null || end === null) return undefined;
      const si = asNumber(start);
      const ei = asNumber(end);
      if (ei <= si) return "";
      if (si < 0 || ei < 0) return "";
      return cp.slice(si, ei).join("");
    }
    case "ArrayLiteral": {
      // SQL backends pass JSON null through as JSON null; mirror that by
      // mapping unbound variables / null literals to JS null. Non-finite
      // numerics (Infinity / NaN — produced by arithmetic overflow that
      // isn't otherwise guarded) get scrubbed to JSON null too so the
      // literal-construction output matches what the canonicalisation
      // path already does silently via JSON.stringify, and to keep the
      // SQL backends' element-finiteness guard from diverging.
      const elems = term.elements.map((e) => evalTerm(e, sub, env, aggregates));
      if (elems.some((e) => e === undefined)) return undefined;
      const arr = (elems as Value[]).map(scrubNonFiniteForJson);
      return JSON.parse(canonicalizeJson(arr)) as Value;
    }
    case "ObjectLiteral": {
      const obj: Record<string, JsonValue> = {};
      for (const entry of term.entries) {
        const v = evalTerm(entry.value, sub, env, aggregates);
        if (v === undefined) return undefined;
        obj[entry.key] = scrubNonFiniteForJson(v);
      }
      return JSON.parse(canonicalizeJson(obj)) as Value;
    }
    case "BracketAccess":
      throw new Error("BracketAccess should have been rewritten by post-processing");
    case "Wildcard":
      // `count(*)` short-circuits in evalAggregate, so a Wildcard never reaches
      // term evaluation.
      throw new Error("'*' has no value; it may only appear as the argument of count(*)");
  }
  assertNever(term, "term type");
}

/**
 * The `**` operator. Mirrors the SQL `powerSql` guards, each a domain failure
 * and so undefined rather than null: negative base with a fractional exponent
 * (imaginary); zero base with a negative exponent (division by zero inside
 * POWER); a result that overflows to ±Infinity.
 */
function evalPower(base: number, exp: number): number | undefined {
  if (base < 0 && exp !== Math.floor(exp)) return undefined;
  if (base === 0 && exp < 0) return undefined;
  const v = base ** exp;
  return Number.isFinite(v) ? v : undefined;
}

function evalBinary(
  op: string,
  l: Value,
  r: Value,
  left: Expression,
  right: Expression,
  env: TypeEnv,
): EvalResult {
  if (op === "+") {
    const leftType = inferTermType(left, env.vars, typesFor(env));
    const rightType = inferTermType(right, env.vars, typesFor(env));
    if (leftType === "string" || rightType === "string") {
      return `${l}${r}`;
    }
    const result = asNumber(l) + asNumber(r);
    return leftType === "integer" && rightType === "integer"
      ? safeIntegerOrUndef(result)
      : finiteOrUndef(result);
  }
  if (op === "-" || op === "*") {
    const result = op === "-" ? asNumber(l) - asNumber(r) : asNumber(l) * asNumber(r);
    const leftType = inferTermType(left, env.vars, typesFor(env));
    const rightType = inferTermType(right, env.vars, typesFor(env));
    return leftType === "integer" && rightType === "integer"
      ? safeIntegerOrUndef(result)
      : finiteOrUndef(result);
  }
  if (op === "/") {
    const rn = asNumber(r);
    if (rn === 0) return undefined;
    const ln = asNumber(l);
    const leftType = inferTermType(left, env.vars, typesFor(env));
    const rightType = inferTermType(right, env.vars, typesFor(env));
    if (leftType === "integer" && rightType === "integer") {
      return safeIntegerOrUndef(Math.trunc(ln / rn));
    }
    return finiteOrUndef(ln / rn);
  }
  if (op === "%") {
    const rn = asNumber(r);
    if (rn === 0) return undefined;
    const result = asNumber(l) % rn;
    const leftType = inferTermType(left, env.vars, typesFor(env));
    const rightType = inferTermType(right, env.vars, typesFor(env));
    return leftType === "integer" && rightType === "integer"
      ? safeIntegerOrUndef(result)
      : finiteOrUndef(result);
  }
  // Bitwise / shift ops on 32-bit signed integers. JS bit operators already
  // coerce operands to int32 and mask the shift count mod 32 (Java/JS
  // semantics), so this matches the SQL backends exactly. `>>>` yields a
  // uint32, so `| 0` reinterprets it as signed int32.
  if (op === "&") return asNumber(l) & asNumber(r);
  if (op === "|") return asNumber(l) | asNumber(r);
  if (op === "^") return asNumber(l) ^ asNumber(r);
  if (op === "<<") return asNumber(l) << asNumber(r);
  if (op === ">>") return asNumber(l) >> asNumber(r);
  if (op === ">>>") return (asNumber(l) >>> asNumber(r)) | 0;
  // Exponentiation: float-valued, with the same domain guards as the SQL `**`.
  if (op === "**") return evalPower(asNumber(l), asNumber(r));
  // Ordering ops. Both operands are non-null at this point: `evalTerm`'s
  // BinaryExpr case has already answered the null cases with no value at all,
  // an order having no place for `null`.
  if (ORDERING_OPS.has(op)) {
    const av = asOrderable(l);
    const bv = asOrderable(r);
    const cmp = compareOrderable(av, bv);
    switch (op) {
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
    }
  }
  throw new Error(`Unknown binary operator: ${op}`);
}

/**
 * The argument slots an impl may read. Every builtin has a fixed arity that the
 * analyzer checks, and `evalCall` has already dropped the call where any
 * argument has no value, so each slot holds a `Value`. Declaring the slots
 * rather than passing an array is what keeps the absence marker out of their
 * type, so `asNumber(args[0])` stays honest under `noUncheckedIndexedAccess`.
 * The widest builtin is `replace`, at three arguments.
 */
type NativeArgs = { readonly [K in 0 | 1 | 2]: Value };

/**
 * Per-overload native implementations. Each entry mirrors the
 * translator's SQL emit for the same overload key — same domain-error
 * guards (sqrt of negative → null, ln of non-positive → null, etc.) and
 * the same NULL-propagation rules. Entries that share runtime behaviour
 * across overloads (`abs.integer` and `abs.float`) reuse the same
 * function value.
 */
type NativeImpl = (args: NativeArgs) => EvalResult;

const callAbs: NativeImpl = (args) => finiteOrUndef(Math.abs(asNumber(args[0])));

/**
 * Round half away from zero. JS `Math.round` rounds half toward +Infinity
 * (`Math.round(-0.5) === 0`); SQL `ROUND` rounds half away from zero
 * (SQLite/Postgres both give `-1`). Spec §6 promises identical output
 * across every backend, so route through this helper instead.
 */
function roundHalfAwayFromZero(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

const callRound1: NativeImpl = (args) => finiteOrUndef(roundHalfAwayFromZero(asNumber(args[0])));
function roundToScale(x: number, n: number): number | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(n)) return undefined;
  const factor = 10 ** n;
  if (factor === 0) return 0;
  if (!Number.isFinite(factor)) return x;
  const scaled = x * factor;
  // A scale fine enough to push `x * 10**n` out of the float range is finer than
  // any digit `x` has: a double that large has an ulp far above `10**-n`, so
  // there is nothing at that place to round away and the answer is `x` itself.
  // Both SQL backends answer the same way, `ROUND(9000000000000, 300)` giving
  // the input back.
  if (!Number.isFinite(scaled)) return x;
  const rounded = roundHalfAwayFromZero(scaled) / factor;
  return Number.isFinite(rounded) ? rounded : undefined;
}
const callRound2: NativeImpl = (args) => {
  return roundToScale(asNumber(args[0]), asNumber(args[1]));
};
const callRoundInteger2: NativeImpl = (args) => {
  const rounded = roundToScale(asNumber(args[0]), asNumber(args[1]));
  // Rounding out of the float range has no value, so there is nothing to
  // truncate and the row is withheld.
  return rounded === undefined ? undefined : Math.trunc(rounded);
};

// SQL's `LENGTH(s)` counts characters (code points), so e.g. `LENGTH('😀')`
// is 1 on Postgres/SQLite. JS's `String.length` is UTF-16 code-unit count,
// which doubles up on every non-BMP character. Iterate the string to get the
// code-point count and stay portable across backends.
const stringLength: NativeImpl = (args) => [...asString(args[0])].length;

const NATIVE_IMPLS: ReadonlyMap<string, NativeImpl> = new Map<string, NativeImpl>([
  // String functions
  ["upper.string", (args) => asciiUpper(asString(args[0]))],
  ["lower.string", (args) => asciiLower(asString(args[0]))],
  [
    "trim.string",
    // SQL's `TRIM(x)` strips ASCII spaces only — tabs, newlines, and other
    // unicode whitespace pass through unchanged on Postgres/SQLite. JS's
    // `String.trim()` would strip the broader Unicode-WS set, so a program
    // that hits a tab-padded EDB row produces `hello` here and `\thello\t`
    // on every SQL backend. Match the SQL semantics.
    (args) => asString(args[0]).replace(/^ +| +$/g, ""),
  ],
  [
    "replace.string_string_string",
    // SQL's `REPLACE(s, '', new)` is a no-op on every backend — there is
    // no empty substring to replace. JS's `split('').join(new)` instead
    // explodes the string into every character and rejoins them, so we'd
    // produce `h_e_l_l_o` against SQL's `hello`. Bypass the split/join for
    // the empty-pattern case so cross-backend results agree.
    (args) => {
      const old = asString(args[1]);
      if (old === "") return asString(args[0]);
      return asString(args[0]).split(old).join(asString(args[2]));
    },
  ],

  // Math
  ["abs.integer", callAbs],
  ["abs.float", callAbs],
  ["round.float", callRound1],
  ["round.integer_integer", callRoundInteger2],
  ["round.float_integer", callRound2],
  ["floor.float", (args) => finiteOrUndef(Math.floor(asNumber(args[0])))],
  ["ceil.float", (args) => finiteOrUndef(Math.ceil(asNumber(args[0])))],
  [
    "sqrt.float",
    (args) => {
      const x = asNumber(args[0]);
      return x < 0 ? undefined : Math.sqrt(x);
    },
  ],
  [
    "ln.float",
    (args) => {
      const x = asNumber(args[0]);
      return x <= 0 ? undefined : Math.log(x);
    },
  ],
  [
    "exp.float",
    (args) => {
      // Spec §5.4's design principle: runtime-partial operations yield
      // NULL rather than IEEE special values. `Math.exp(1000)` overflows
      // to `Infinity`, which then silently collapses to `null` via
      // `JSON.stringify` if the value is captured in an ArrayLiteral or
      // ObjectLiteral. Match `as_float.value`'s `Number.isFinite` gate so
      // overflow surfaces as NULL explicitly at the operation, not as
      // hidden corruption further down the pipeline.
      const v = Math.exp(asNumber(args[0]));
      return Number.isFinite(v) ? v : undefined;
    },
  ],

  // JSON coercion: type-strict, NULL on shape mismatch, no implicit
  // conversion. Mirrors the per-dialect SQL emission.
  ["as_string.value", (args) => (typeof args[0] === "string" ? args[0] : undefined)],
  [
    "as_integer.value",
    (args) => {
      const v = args[0]!;
      // Booleans are explicitly excluded — `typeof true === 'boolean'`
      // so they don't fall through. Integer-valued reals (1.0, -3.0)
      // qualify; out-of-range values fail the safe-integer check and
      // yield NULL.
      if (typeof v !== "number") return undefined;
      if (!Number.isFinite(v) || v !== Math.trunc(v)) return undefined;
      if (v < Number.MIN_SAFE_INTEGER || v > Number.MAX_SAFE_INTEGER) return undefined;
      return v;
    },
  ],
  [
    "as_float.value",
    (args) => (typeof args[0] === "number" && Number.isFinite(args[0]) ? args[0] : undefined),
  ],
  ["as_boolean.value", (args) => (typeof args[0] === "boolean" ? args[0] : undefined)],
  [
    "length.value",
    (args) => {
      const v = args[0]!;
      if (Array.isArray(v)) return v.length;
      if (typeof v === "string") return [...v].length;
      if (v !== null && typeof v === "object") return Object.keys(v).length;
      return undefined;
    },
  ],
  ["length.string", stringLength],
  [
    "type_of.value",
    (args) => {
      const v = args[0]!;
      if (v === null) return "null";
      if (typeof v === "boolean") return "boolean";
      if (typeof v === "number") return "number";
      if (typeof v === "string") return "string";
      if (Array.isArray(v)) return "array";
      if (typeof v === "object") return "object";
      return undefined;
    },
  ],
  // `defined` needs no implementation beyond `true`, and that is the point of
  // §11.6's polarity argument: `evalCall` never reaches here with an undefined
  // argument, being strict in the absence marker, so an undefined argument makes
  // the call undefined without anything here saying so. What is left to answer is
  // the case where the argument *does* have a value, and the answer is yes. A
  // null argument is one of those: `null` is a value.
  ...(["integer", "float", "string", "boolean", "value"] as const).map(
    (t) => [`defined.${t}`, () => true] as [string, () => boolean],
  ),
  [
    "has_key.value_string",
    (args) => {
      const v = args[0]!;
      return v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.hasOwn(v as object, asString(args[1]))
        : false;
    },
  ],
  [
    "keys.value",
    (args) => {
      const v = args[0]!;
      if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
      return Object.keys(v).sort(compareStrings);
    },
  ],
  [
    "values.value",
    (args) => {
      const v = args[0]!;
      if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
      return Object.keys(v)
        .sort(compareStrings)
        .map((k) => (v as Record<string, JsonValue>)[k] as JsonValue);
    },
  ],
  [
    "to_json.value",
    (args) => {
      const v = args[0]!;
      // `canonicalizeJson` already produces the cross-backend
      // canonical form: object keys in jsonb order, numbers normalised,
      // no whitespace.
      return canonicalizeJson(v as JsonValue);
    },
  ],

  // Primitive conversions. The string → number parsers use the same
  // canonical-form regex as the Postgres dialect; the SQLite GLOB
  // chain enforces the same shape via a sequence of negative tests, so
  // all three backends accept and reject the same set of strings.
  //
  // `String(1.0)` formats as `'1'` in JS, matching Postgres's
  // `CAST(1.0::float8 AS TEXT)`. SQLite renders the same value as
  // `'1.0'`; this is the documented v1 cross-backend variance for
  // integer-valued reals.
  ["to_string.integer", (args) => String(asNumber(args[0]))],
  ["to_string.float", (args) => String(asNumber(args[0]))],
  ["to_string.boolean", (args) => (asBoolean(args[0]) ? "true" : "false")],
  [
    "to_integer.string",
    (args) => {
      const s = asString(args[0]);
      // Canonical form: `0`, or `-?[1-9][0-9]*`, inside the JS
      // safe-integer range.
      if (!/^(0|-?[1-9][0-9]*)$/.test(s)) return undefined;
      const value = Number(s);
      return Number.isSafeInteger(value) ? value : undefined;
    },
  ],
  [
    "to_float.string",
    (args) => {
      const s = asString(args[0]);
      // Same canonical form as the SQL dialect parsers — see
      // `parseStringAsFloat` for the parallel regex / GLOB chain.
      if (!/^((0|-?[1-9][0-9]*)(\.[0-9]+)?|-0\.[0-9]+)$/.test(s)) return undefined;
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : undefined;
    },
  ],
  [
    "to_boolean.string",
    (args) => {
      const s = asString(args[0]);
      if (s === "true") return true;
      if (s === "false") return false;
      return undefined;
    },
  ],

  // Parse a string as JSON. NULL on malformed input. Canonicalise the
  // parsed value through `canonicalizeJson` + `JSON.parse` so object
  // keys come back sorted, matching the EDB-insert path in
  // `loader.ts` and Postgres's jsonb canonicalisation — without this,
  // a parse_value result could silently fail structural equality
  // against an EDB-loaded value with the same shape.
  [
    "parse_json.string",
    (args) => {
      const s = asString(args[0]);
      try {
        const parsed = JSON.parse(s) as JsonValue;
        if (!isJsonValue(parsed)) return undefined;
        return JSON.parse(canonicalizeJson(parsed)) as Value;
      } catch {
        return undefined;
      }
    },
  ],
]);

// Module-load coverage check, mirroring the translator's: every overload
// key in the core registry must have a native impl, and every impl must
// correspond to a registered overload.
for (const key of BUILTIN_KEYS) {
  if (!NATIVE_IMPLS.has(key)) throw new Error(`Native impl not registered for built-in '${key}'`);
}
for (const key of NATIVE_IMPLS.keys()) {
  if (!BUILTIN_KEYS.has(key))
    throw new Error(`Native impl registered for unknown built-in '${key}'`);
}

const INTEGER_RESULT_GUARDS = new Set([
  "round.float",
  "round.integer_integer",
  "floor.float",
  "ceil.float",
]);

function evalCall(call: FunctionCall, args: Value[], env: TypeEnv): EvalResult {
  // Most calls are pre-resolved by type inference; the fallback covers
  // explicit `null`-literal arguments where overloads disagreed on
  // result type. Both overloads of `abs`/`round` etc. have the same
  // runtime behaviour, so the first arity-match is sufficient.
  let overload = env.functionOverloads.get(call);
  if (!overload) {
    const builtin = BUILTINS.get(call.name);
    overload = builtin?.overloads.find((o) => o.params.length === call.args.length);
    if (!overload) {
      throw new Error(`Internal error: no overload available for '${call.name}'`);
    }
  }
  const impl = NATIVE_IMPLS.get(overload.key);
  if (!impl) {
    throw new Error(`Internal error: native impl missing for built-in '${overload.key}'`);
  }

  const liftedArgs = args.map((arg, i) =>
    overload.params[i] === "value" && arg !== null ? (scrubNonFiniteForJson(arg) as Value) : arg,
  );

  // NULL propagation, for the builtins that propagate. Two things narrow it,
  // both from §8.
  //
  // The overload's own `strict` bit, rather than a blanket rule, because a
  // non-strict builtin has something to say about a null: `type_of(null)` is
  // `"null"`, not null.
  //
  // And only for a *primitive* parameter. A `value` slot accepts null as one of
  // the shapes it holds, so a null there is an argument rather than an absence,
  // and propagating it would disagree with the SQL backends, which lift it to a
  // JSON null and hand it to the function. That divergence is what
  // `has_key(null, "x")` exposed: sqlite answered false while the interpreter
  // propagated.
  //
  // Runs after primitive-to-value scrubbing so non-finite floats lifted into a
  // value slot collapse the same way they do on SQL backends.
  if (
    overload.nulls.strict &&
    liftedArgs.some((a, i) => a === null && overload.params[i] !== "value")
  ) {
    return null;
  }

  // `liftedArgs` is as long as the overload's parameter list, so every slot the
  // impl reads is occupied; the cast is what tells the compiler that.
  const result = impl(liftedArgs as unknown as NativeArgs);
  return INTEGER_RESULT_GUARDS.has(overload.key) && typeof result === "number"
    ? safeIntegerOrUndef(result)
    : result;
}

/**
 * Structural equality on `Value`s. `===` is the fast path for primitive
 * leaves; nested compounds (arrays / objects, only valid for json
 * values) compare via `canonicalizeJson` so that two structurally equal
 * but reference-distinct `value`s agree. `null === null` is the
 * conventional reference-equal case and remains true.
 */
function valueStructuralEq(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" && typeof b !== "object") return false;
  return canonicalizeJson(a as JsonValue) === canonicalizeJson(b as JsonValue);
}

/**
 * Null-aware equality: the runtime behind the `=` and `<>` operators,
 * body-level Equality, and atom matching alike. `null = null` is true,
 * `null = X` is false. This is the language's only notion of sameness,
 * shared with tuple dedup and aggregate grouping, so a repeated variable
 * and a spelled-out `=` denote the same join. See doc/design/null.md §4.
 *
 * JS strict equality is the fast path for primitives; structural equality
 * kicks in for json compounds.
 */
export function logicalEq(a: Value, b: Value): boolean {
  return valueStructuralEq(a, b);
}

/**
 * Comparison over two values. Equality is null-aware; an ordering is strict at
 * null, so `null` in an ordering position gives no value at all
 * (null-as-a-value.md §4.1).
 *
 * `evalTerm` decides the null cases itself and calls `evalBinary` rather than
 * this, so this is the spelling for a caller holding two values already. Both
 * have to agree, which is why the null cases are here rather than assumed away.
 */
export function compareOp(op: string, a: Value, b: Value): EvalResult {
  if (op === "=") return valueStructuralEq(a, b);
  if (op === "<>") return !valueStructuralEq(a, b);
  if (a === null || b === null) return undefined;
  // Ordering operators require both sides to be the same primitive type
  // (number-number or string-string). The analyzer already enforces this
  // statically; the runtime check guards against analyzer/planner bugs.
  const av = asOrderable(a);
  const bv = asOrderable(b);
  const cmp = compareOrderable(av, bv);
  switch (op) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
  }
  throw new Error(`Unknown comparison operator: ${op}`);
}
