// Runtime term evaluation for the native Datalog backend.
//
// The functions here mirror the cross-backend invariants the SQL translator
// encodes into generated SQL:
//   - `/0` and `%0` produce NULL
//   - arithmetic overflow produces NULL rather than IEEE Infinity / NaN
//   - `sqrt(x<0)`, `ln(x<=0)`, `0 ** neg`, `neg ** fractional` → NULL
//   - slice bounds that would walk backwards → empty string
//   - NULL propagates through arithmetic, functions, subscript/slice
//   - comparison is total: NULL never comes back out of one. Equality is
//     null-aware (`logicalEq`) and ordering treats NULL as an isolated point
//     in the order. See doc/design/null.md §5.
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

function asNumber(v: Value | undefined): number {
  if (typeof v !== "number") {
    throw new Error(`Type assertion failed: expected number, got ${describeValue(v)}`);
  }
  return v;
}

function asString(v: Value | undefined): string {
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
 * The ordering operators, which are total: a null operand never yields
 * null. Null is an isolated point in the order, so `<` and `>` are false
 * whenever either side is null, and `<=` / `>=` are true only when both
 * are. See doc/design/null.md §5.
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

function asBoolean(v: Value | undefined): boolean {
  if (typeof v !== "boolean") {
    throw new Error(`Type assertion failed: expected boolean, got ${describeValue(v)}`);
  }
  return v;
}

function finiteOrNull(v: number): number | null {
  return Number.isFinite(v) ? v : null;
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
  aggregates?: (agg: AggregateCall) => Value,
): Value {
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
      if (term.op === "!") {
        // 3VL: !null = null; !true = false; !false = true.
        return v === null ? null : !asBoolean(v);
      }
      if (v === null) return null;
      return finiteOrNull(-asNumber(v));
    }
    case "BinaryExpr": {
      const l = evalTerm(term.left, sub, env, aggregates);
      const r = evalTerm(term.right, sub, env, aggregates);
      if (term.op === "&&") {
        // 3VL: false dominates, then NULL, then both-true.
        if (l === false || r === false) return false;
        if (l === null || r === null) return null;
        return asBoolean(l) && asBoolean(r);
      }
      if (term.op === "||") {
        // 3VL: true dominates, then NULL, then both-false.
        if (l === true || r === true) return true;
        if (l === null || r === null) return null;
        return asBoolean(l) || asBoolean(r);
      }
      // `=` / `<>` are null-aware equality. JS `===` / `!==` already give
      // the right answer for null values (`null === null` is true,
      // `null === X` is false). For JSON values (arrays / objects) `===` is
      // reference identity, which would diverge from the SQL backends'
      // structural equality, so route through `valueStructuralEq`, which
      // canonicalises on demand.
      if (term.op === "=") return valueStructuralEq(l, r);
      if (term.op === "<>") return !valueStructuralEq(l, r);
      // Ordering is total: null is an isolated point in the order,
      // comparable only to itself. See doc/design/null.md §5.
      if (l === null || r === null) {
        if (ORDERING_OPS.has(term.op)) {
          return (term.op === "<=" || term.op === ">=") && l === null && r === null;
        }
        // Every other operator propagates.
        return null;
      }
      return evalBinary(term.op, l, r, term.left, term.right, env);
    }
    case "FunctionCall":
      return evalCall(
        term,
        term.args.map((a) => evalTerm(a, sub, env, aggregates)),
        env,
      );
    case "AggregateCall": {
      if (aggregates) return aggregates(term);
      throw new Error(`Aggregate '${term.func}' evaluated outside aggregate context`);
    }
    case "Subscript": {
      const obj = evalTerm(term.object, sub, env, aggregates);
      const idx = evalTerm(term.index, sub, env, aggregates);
      if (obj === null || idx === null) return null;
      const objType = inferTermType(term.object, env.vars, typesFor(env));
      if (objType === "value") {
        // Array index → integer; object key → string. Wrong-shape access
        // (string index on array, integer index on object, anything on a
        // primitive leaf) returns NULL, matching the SQL backends.
        if (Array.isArray(obj)) {
          if (typeof idx !== "number" || !Number.isInteger(idx)) return null;
          if (idx < 0 || idx >= obj.length) return null;
          return obj[idx] as Value;
        }
        if (typeof obj === "object") {
          if (typeof idx !== "string") return null;
          if (!Object.hasOwn(obj as object, idx)) return null;
          return (obj as Record<string, JsonValue>)[idx] as Value;
        }
        return null;
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
      if (obj === null) return null;
      const objType = inferTermType(term.object, env.vars, typesFor(env));
      if (objType === "value") {
        // Slicing a non-array `value` returns NULL; otherwise produces a
        // sub-array. Empty / reversed ranges return [], matching the SQL
        // backends' `COALESCE(...)` shape.
        if (!Array.isArray(obj)) return null;
        const start = term.start ? evalTerm(term.start, sub, env, aggregates) : 0;
        const end = term.end ? evalTerm(term.end, sub, env, aggregates) : obj.length;
        if (start === null || end === null) return null;
        const si = asNumber(start);
        const ei = asNumber(end);
        if (si < 0 || ei < 0) return [];
        if (ei <= si) return [];
        return obj.slice(si, ei) as JsonValue[];
      }
      const cp = [...asString(obj)];
      const start = term.start ? evalTerm(term.start, sub, env, aggregates) : 0;
      const end = term.end ? evalTerm(term.end, sub, env, aggregates) : cp.length;
      if (start === null || end === null) return null;
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
      const arr = term.elements.map((e) =>
        scrubNonFiniteForJson(evalTerm(e, sub, env, aggregates)),
      );
      return JSON.parse(canonicalizeJson(arr)) as Value;
    }
    case "ObjectLiteral": {
      const obj: Record<string, JsonValue> = {};
      for (const entry of term.entries) {
        obj[entry.key] = scrubNonFiniteForJson(evalTerm(entry.value, sub, env, aggregates));
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
 * The `**` operator. Mirrors the SQL `powerSql` guards: negative base
 * with a fractional exponent → NULL (imaginary); zero base with a
 * negative exponent → NULL (division by zero inside POWER); a result
 * that overflows to ±Infinity → NULL.
 */
function evalPower(base: number, exp: number): number | null {
  if (base < 0 && exp !== Math.floor(exp)) return null;
  if (base === 0 && exp < 0) return null;
  const v = base ** exp;
  return Number.isFinite(v) ? v : null;
}

function evalBinary(
  op: string,
  l: Value,
  r: Value,
  left: Expression,
  right: Expression,
  env: TypeEnv,
): Value {
  if (op === "+") {
    const leftType = inferTermType(left, env.vars, typesFor(env));
    const rightType = inferTermType(right, env.vars, typesFor(env));
    if (leftType === "string" || rightType === "string") {
      return `${l}${r}`;
    }
    return finiteOrNull(asNumber(l) + asNumber(r));
  }
  if (op === "-") return finiteOrNull(asNumber(l) - asNumber(r));
  if (op === "*") return finiteOrNull(asNumber(l) * asNumber(r));
  if (op === "/") {
    const rn = asNumber(r);
    if (rn === 0) return null;
    const ln = asNumber(l);
    const leftType = inferTermType(left, env.vars, typesFor(env));
    const rightType = inferTermType(right, env.vars, typesFor(env));
    if (leftType === "integer" && rightType === "integer") {
      return finiteOrNull(Math.trunc(ln / rn));
    }
    return finiteOrNull(ln / rn);
  }
  if (op === "%") {
    const rn = asNumber(r);
    if (rn === 0) return null;
    return finiteOrNull(asNumber(l) % rn);
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
  // BinaryExpr case decides every null case before calling here, since
  // ordering is total and null is an isolated point in the order.
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
 * Per-overload native implementations. Each entry mirrors the
 * translator's SQL emit for the same overload key — same domain-error
 * guards (sqrt of negative → null, ln of non-positive → null, etc.) and
 * the same NULL-propagation rules. Entries that share runtime behaviour
 * across overloads (`abs.integer` and `abs.float`) reuse the same
 * function value.
 */
type NativeImpl = (args: Value[]) => Value;

const callAbs: NativeImpl = (args) => finiteOrNull(Math.abs(asNumber(args[0])));

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

const callRound1: NativeImpl = (args) => finiteOrNull(roundHalfAwayFromZero(asNumber(args[0])));
function roundToScale(x: number, n: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(n)) return null;
  const factor = 10 ** n;
  if (factor === 0) return 0;
  if (!Number.isFinite(factor)) return x;
  const rounded = roundHalfAwayFromZero(x * factor) / factor;
  return Number.isFinite(rounded) ? rounded : null;
}
const callRound2: NativeImpl = (args) => {
  return roundToScale(asNumber(args[0]), asNumber(args[1]));
};
const callRoundInteger2: NativeImpl = (args) => {
  const rounded = callRound2(args);
  return rounded === null ? null : Math.trunc(asNumber(rounded));
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
  ["floor.float", (args) => finiteOrNull(Math.floor(asNumber(args[0])))],
  ["ceil.float", (args) => finiteOrNull(Math.ceil(asNumber(args[0])))],
  [
    "sqrt.float",
    (args) => {
      const x = asNumber(args[0]);
      return x < 0 ? null : Math.sqrt(x);
    },
  ],
  [
    "ln.float",
    (args) => {
      const x = asNumber(args[0]);
      return x <= 0 ? null : Math.log(x);
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
      return Number.isFinite(v) ? v : null;
    },
  ],

  // JSON coercion: type-strict, NULL on shape mismatch, no implicit
  // conversion. Mirrors the per-dialect SQL emission.
  ["as_string.value", (args) => (typeof args[0] === "string" ? args[0] : null)],
  [
    "as_integer.value",
    (args) => {
      const v = args[0]!;
      // Booleans are explicitly excluded — `typeof true === 'boolean'`
      // so they don't fall through. Integer-valued reals (1.0, -3.0)
      // qualify; out-of-range values fail the safe-integer check and
      // yield NULL.
      if (typeof v !== "number") return null;
      if (!Number.isFinite(v) || v !== Math.trunc(v)) return null;
      if (v < Number.MIN_SAFE_INTEGER || v > Number.MAX_SAFE_INTEGER) return null;
      return v;
    },
  ],
  [
    "as_float.value",
    (args) => (typeof args[0] === "number" && Number.isFinite(args[0]) ? args[0] : null),
  ],
  ["as_boolean.value", (args) => (typeof args[0] === "boolean" ? args[0] : null)],
  [
    "length.value",
    (args) => {
      const v = args[0]!;
      if (Array.isArray(v)) return v.length;
      if (typeof v === "string") return [...v].length;
      if (v !== null && typeof v === "object") return Object.keys(v).length;
      return null;
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
      return null;
    },
  ],
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
      if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
      return Object.keys(v).sort(compareStrings);
    },
  ],
  [
    "values.value",
    (args) => {
      const v = args[0]!;
      if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
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
      // Canonical form: `0`, or `-?[1-9][0-9]*` with at most 9 digits.
      // The 9-digit cap matches the SQL backends' INT32 ceiling so
      // every backend agrees on which inputs are accepted.
      if (!/^(0|-?[1-9][0-9]{0,8})$/.test(s)) return null;
      return Number.parseInt(s, 10);
    },
  ],
  [
    "to_float.string",
    (args) => {
      const s = asString(args[0]);
      // Same canonical form as the SQL dialect parsers — see
      // `parseStringAsFloat` for the parallel regex / GLOB chain.
      if (!/^((0|-?[1-9][0-9]*)(\.[0-9]+)?|-0\.[0-9]+)$/.test(s)) return null;
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : null;
    },
  ],
  [
    "to_boolean.string",
    (args) => {
      const s = asString(args[0]);
      if (s === "true") return true;
      if (s === "false") return false;
      return null;
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
        if (!isJsonValue(parsed)) return null;
        return JSON.parse(canonicalizeJson(parsed)) as Value;
      } catch {
        return null;
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

function evalCall(call: FunctionCall, args: Value[], env: TypeEnv): Value {
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

  // NULL-propagating arity-agnostic guard: any null arg → null. This runs
  // after primitive-to-value scrubbing so non-finite floats lifted into a
  // value slot collapse the same way they do on SQL backends.
  if (liftedArgs.some((a) => a === null)) return null;

  return impl(liftedArgs);
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
 * Comparison operators, all total: no operand combination yields null.
 * Equality is null-aware, and ordering treats null as an isolated point
 * comparable only to itself. See doc/design/null.md §5.
 */
export function compareOp(op: string, a: Value, b: Value): Value {
  if (op === "=") return valueStructuralEq(a, b);
  if (op === "<>") return !valueStructuralEq(a, b);
  if (a === null || b === null) {
    return (op === "<=" || op === ">=") && a === null && b === null;
  }
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
