import type { PrimitiveType } from "./ast.ts";

/**
 * How an overload behaves on NULL. The nullness analysis needs both
 * directions, and they are independent — see
 * doc/design/nullness-tracking.md §4.1.
 *
 * `strict`: a NULL argument forces a NULL result, so a non-null *result*
 * proves every argument was non-null. This is what licenses reasoning
 * backwards from a guard, which is how `f(X) < 2` refines `X`.
 *
 * `total`: non-null arguments never produce NULL, so nullness does not
 * originate here. This is what licenses reasoning forwards, which is how a
 * head expression's nullness is computed.
 *
 * Every builtin is strict (spec §5.4 propagates NULL through all of them),
 * but the field is stated rather than assumed, because a future non-strict
 * builtin would otherwise inherit refinement it does not license. Totality
 * is the one that varies: the parsing, projection and domain-error families
 * are all partial.
 */
export interface NullBehaviour {
  readonly strict: boolean;
  readonly total: boolean;
}

/** Strict, and never NULL when its arguments are not. */
const TOTAL: NullBehaviour = { strict: true, total: true };

/** Strict, but a NULL source: can yield NULL from non-null arguments. */
const PARTIAL: NullBehaviour = { strict: true, total: false };

/**
 * One overload of a built-in function. Backends key their SQL-emit and
 * native-impl tables on `key`; the analyzer/type-inference layer cares
 * about `params` (for arity + arg-type compatibility), `result`
 * (for the call's result type after resolution) and `nulls` (for nullness).
 *
 * Keys follow the convention `<name>.<param-types-joined-by-_>` so that
 * a single-overload built-in has a predictable name (e.g. `upper.string`)
 * and overload sets read naturally (`abs.integer`, `abs.float`).
 */
export interface Overload {
  readonly key: string;
  readonly params: readonly PrimitiveType[];
  readonly result: PrimitiveType;
  readonly nulls: NullBehaviour;
}

export interface Builtin {
  readonly name: string;
  readonly overloads: readonly Overload[];
}

/**
 * `nulls` is a required parameter, not a defaulted one. A new partial
 * builtin that inherited `TOTAL` by omission would make the analysis claim
 * non-nullness it cannot prove, which is the unsound direction and the exact
 * risk null.md §6 declined this analysis over. Omitting it is a compile
 * error instead.
 */
const ov = (
  key: string,
  params: PrimitiveType[],
  result: PrimitiveType,
  nulls: NullBehaviour,
): Overload => ({
  key,
  params,
  result,
  nulls,
});

const builtin = (name: string, overloads: Overload[]): [string, Builtin] => [
  name,
  { name, overloads },
];

/**
 * Built-in function registry. Backends (translator, native evaluator)
 * provide their own per-key implementation tables and assert at module
 * load that every key here has an entry — so a missing implementation
 * fails loud at startup rather than at first invocation.
 *
 * Promotion is handled centrally by `resolveCall`: integer arguments
 * automatically match float parameters, so a single `(float) → float`
 * overload covers both `sqrt(2)` and `sqrt(2.5)`. Overload sets are kept
 * minimal — extra overloads only when the result type genuinely depends
 * on the argument type (e.g. `abs(integer) → integer` vs `abs(float) →
 * float`, where collapsing to a single `(float) → float` overload would
 * lose the `integer` result on integer inputs).
 */
export const BUILTINS: ReadonlyMap<string, Builtin> = new Map([
  // String → string
  builtin("upper", [ov("upper.string", ["string"], "string", TOTAL)]),
  builtin("lower", [ov("lower.string", ["string"], "string", TOTAL)]),
  builtin("trim", [ov("trim.string", ["string"], "string", TOTAL)]),
  builtin("replace", [
    ov("replace.string_string_string", ["string", "string", "string"], "string", TOTAL),
  ]),

  // Math. The domain-error family (`sqrt`, `ln`, `exp`) is partial by spec
  // §5.4; the rest are total because rounding or negating a finite number
  // stays finite, so their `finiteOrNull` guards are unreachable. The
  // exception is two-argument `round`, where scaling by `10 ** n` can
  // overflow before the rounding happens (`values.ts` `roundToScale`).
  builtin("abs", [
    ov("abs.integer", ["integer"], "integer", TOTAL),
    ov("abs.float", ["float"], "float", TOTAL),
  ]),
  builtin("round", [
    // arity-1: result is always integer (rounding to nearest whole). Single
    // (float) → integer overload covers integer inputs via promotion — the
    // result type doesn't depend on the input domain.
    ov("round.float", ["float"], "integer", TOTAL),
    // arity-2: result follows the first arg's domain.
    ov("round.integer_integer", ["integer", "integer"], "integer", PARTIAL),
    ov("round.float_integer", ["float", "integer"], "float", PARTIAL),
  ]),
  builtin("floor", [ov("floor.float", ["float"], "integer", TOTAL)]),
  builtin("ceil", [ov("ceil.float", ["float"], "integer", TOTAL)]),
  builtin("sqrt", [ov("sqrt.float", ["float"], "float", PARTIAL)]),
  builtin("ln", [ov("ln.float", ["float"], "float", PARTIAL)]),
  builtin("exp", [ov("exp.float", ["float"], "float", PARTIAL)]),

  // Value coercion / introspection. All take a single `value`
  // argument and dispatch to per-dialect SQL fragments at translation
  // time. The projections are partial: a wrong-shape argument yields NULL
  // rather than raising (spec §5.4). `type_of` is total, its NULL result
  // being strictness on a NULL argument rather than a shape failure.
  builtin("as_string", [ov("as_string.value", ["value"], "string", PARTIAL)]),
  builtin("as_integer", [ov("as_integer.value", ["value"], "integer", PARTIAL)]),
  builtin("as_float", [ov("as_float.value", ["value"], "float", PARTIAL)]),
  builtin("as_boolean", [ov("as_boolean.value", ["value"], "boolean", PARTIAL)]),
  builtin("length", [
    // Non-collection `value` → NULL; a string always has a length.
    ov("length.value", ["value"], "integer", PARTIAL),
    ov("length.string", ["string"], "integer", TOTAL),
  ]),
  builtin("type_of", [ov("type_of.value", ["value"], "string", TOTAL)]),

  // Object helpers. `has_key` is a boolean presence test. `keys`
  // returns a sorted array of the object's keys (as JSON strings);
  // `values` returns the corresponding array of values, ordered by key
  // for cross-backend determinism. The projection helpers return
  // `NULL` on non-object input.
  // `has_key` is total: a missing key or non-object receiver is `false`, not
  // NULL. `keys` / `values` are partial, non-object input yielding NULL.
  builtin("has_key", [ov("has_key.value_string", ["value", "string"], "boolean", TOTAL)]),
  builtin("keys", [ov("keys.value", ["value"], "value", PARTIAL)]),
  builtin("values", [ov("values.value", ["value"], "value", PARTIAL)]),

  // Serialise a `value` to its canonical JSON text — the inverse of
  // `parse_json`. Object keys are sorted, numbers normalised, no
  // whitespace inserted; the result is identical across every
  // backend so it's safe as a hash / dedup key.
  builtin("to_json", [ov("to_json.value", ["value"], "string", TOTAL)]),

  // Primitive conversions. `to_string` is polymorphic over numeric and
  // boolean inputs; the parsing variants (`to_integer`/`to_float`/
  // `to_boolean`) take string and return NULL on any malformed input —
  // strict canonical decimals only (no leading zeros, no whitespace,
  // exact 'true'/'false' literals). Number-to-number conversions are
  // intentionally absent: integer-into-float promotion already widens
  // automatically, and `floor`/`ceil`/`round` cover the lossy
  // float-to-integer direction.
  builtin("to_string", [
    ov("to_string.integer", ["integer"], "string", TOTAL),
    ov("to_string.float", ["float"], "string", TOTAL),
    ov("to_string.boolean", ["boolean"], "string", TOTAL),
  ]),
  builtin("to_integer", [ov("to_integer.string", ["string"], "integer", PARTIAL)]),
  builtin("to_float", [ov("to_float.string", ["string"], "float", PARTIAL)]),
  builtin("to_boolean", [ov("to_boolean.string", ["string"], "boolean", PARTIAL)]),

  // Parse a string as JSON. Returns NULL on malformed input rather
  // than raising — matching the rest of the parsing family
  // (`to_integer`, `to_float`, `to_boolean`). This is a value-producing
  // operation: a recursion that loops a string back through `parse_json`
  // can manufacture an unbounded family of JSON values, so the
  // finiteness checker flags such cycles via the same general
  // FunctionCall-as-PLUS rule that flags string concat / arithmetic.
  builtin("parse_json", [ov("parse_json.string", ["string"], "value", PARTIAL)]),
]);

/** Set of all overload keys defined in the registry. */
export const BUILTIN_KEYS: ReadonlySet<string> = new Set(
  Array.from(BUILTINS.values()).flatMap((b) => b.overloads.map((o) => o.key)),
);

/**
 * Outcome of resolving a `FunctionCall` against the registry.
 *
 * The shape is two-layered on purpose:
 *
 *   - `resultType` is best-effort and lets the type-inference fixed
 *     point progress as soon as every viable overload agrees on the
 *     result type — even if argument types aren't yet pinned tightly
 *     enough to choose the impl.
 *   - `overload` is only populated when a unique impl is selected. The
 *     translator and native evaluator key on this.
 *   - `error` carries a diagnostic that, when present and inputs are
 *     fully typed, must be raised at validation time. During the
 *     fixed-point iteration the error is ignored — it might disappear
 *     once more variable types are learned.
 */
export interface Resolution {
  readonly resultType: PrimitiveType | undefined;
  readonly overload: Overload | undefined;
  readonly error: ResolutionError | undefined;
}

export type ResolutionError =
  | { kind: "unknown-name"; name: string }
  | { kind: "arity-mismatch"; name: string; arities: readonly number[]; got: number }
  | {
      kind: "no-match";
      name: string;
      argTypes: readonly (PrimitiveType | undefined)[];
      overloads: readonly Overload[];
    }
  | {
      kind: "ambiguous";
      name: string;
      argTypes: readonly (PrimitiveType | undefined)[];
      candidates: readonly Overload[];
    };

/**
 * Resolve a `FunctionCall` site. Compatibility:
 *
 *   - `argType === paramType`     → exact match
 *   - `paramType === "float"` and `argType === "integer"` → promoted match
 *   - `paramType === "value"` and `argType` is primitive → value embedding
 *   - `argType === undefined`     → wildcard (caller hasn't pinned yet)
 *   - otherwise                   → reject
 *
 * When multiple overloads remain, prefer the one with no promotion
 * needed. Returning `resultType` even with un-pinned args (when all
 * surviving candidates agree on result type) lets the fixed-point
 * iteration converge for cases like `length(X)` where X is constrained
 * elsewhere — same reach as the previous monomorphic `inferCallType`.
 */
export function resolveCall(
  name: string,
  argTypes: readonly (PrimitiveType | undefined)[],
): Resolution {
  const builtin = BUILTINS.get(name);
  if (!builtin) {
    return { resultType: undefined, overload: undefined, error: { kind: "unknown-name", name } };
  }

  const arityMatches = builtin.overloads.filter((o) => o.params.length === argTypes.length);
  if (arityMatches.length === 0) {
    const arities = [...new Set(builtin.overloads.map((o) => o.params.length))].sort(
      (a, b) => a - b,
    );
    return {
      resultType: undefined,
      overload: undefined,
      error: { kind: "arity-mismatch", name, arities, got: argTypes.length },
    };
  }

  const compatible = arityMatches.filter((o) =>
    o.params.every((p, i) => {
      const a = argTypes[i];
      return a === undefined || isCompatible(a, p);
    }),
  );
  if (compatible.length === 0) {
    return {
      resultType: undefined,
      overload: undefined,
      error: { kind: "no-match", name, argTypes, overloads: arityMatches },
    };
  }

  const allArgsKnown = argTypes.every((t) => t !== undefined);

  // With every arg type pinned we can pick the unique overload (preferring
  // exact match over promoted match). With some args still undefined we
  // can still expose `resultType` if every surviving candidate agrees.
  let chosen: Overload | undefined;
  if (allArgsKnown) {
    if (compatible.length === 1) {
      chosen = compatible[0];
    } else {
      const exact = compatible.filter((o) => o.params.every((p, i) => argTypes[i] === p));
      if (exact.length === 1) chosen = exact[0];
      else if (exact.length === 0 && compatible.length === 1) chosen = compatible[0];
    }
    if (!chosen) {
      return {
        resultType: agreedResultType(compatible),
        overload: undefined,
        error: { kind: "ambiguous", name, argTypes, candidates: compatible },
      };
    }
  }

  const resultType = chosen?.result ?? agreedResultType(compatible);
  return { resultType, overload: chosen, error: undefined };
}

/** If every overload in `compatible` returns the same PrimitiveType, that type; otherwise undefined. */
function agreedResultType(compatible: readonly Overload[]): PrimitiveType | undefined {
  if (compatible.length === 0) return undefined;
  const first = compatible[0]!.result;
  return compatible.every((o) => o.result === first) ? first : undefined;
}

/**
 * `argType` can flow into a slot of type `paramType` without an explicit
 * cast — same type, integer-into-float promotion, or primitive-into-value
 * embedding. Mirrors the compatibility rules used throughout type inference.
 */
function isCompatible(argType: PrimitiveType, paramType: PrimitiveType): boolean {
  if (argType === paramType) return true;
  if (paramType === "value") return true;
  return paramType === "float" && argType === "integer";
}
