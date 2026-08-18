import type { PrimitiveType } from "./ast.ts";

/**
 * How an overload behaves on a `null` argument and on the edges of its domain.
 * Two bits, and they answer two different questions in two different analyses,
 * so neither implies the other.
 *
 * `strict`: a null argument forces a null result, so a non-null *result*
 * proves every argument was non-null. This is what licenses reasoning
 * backwards from a guard, which is how `f(X) < 2` refines `X` (`nullness.ts`).
 *
 * `total`: a call with **defined arguments always has a value**. That is
 * definedness rather than nullness, and it is the reading `canBeUndefined`
 * (`partiality.ts`) takes: a `false` here means the call can have no value at
 * all, so its use needs a definedness guard. A total builtin may still return a
 * null, by propagating one it was given.
 *
 * Most builtins are strict, but not all: `type_of` and `defined` answer *about*
 * a null rather than propagating it (`ANSWERS_NULL` below), which is why the bit
 * is stated at every overload rather than assumed. Totality varies the same way:
 * the parsing, projection and domain-error families are all partial.
 */
export interface NullBehaviour {
  readonly strict: boolean;
  readonly total: boolean;
}

/** Strict, and always has a value where its arguments do. */
const TOTAL: NullBehaviour = { strict: true, total: true };

/** Strict, and can have no value at arguments that have one. */
const PARTIAL: NullBehaviour = { strict: true, total: false };

/**
 * Answers for a null argument instead of propagating it, and always has a value.
 * `type_of` and `defined` are the two: `null` is an ordinary value, with an
 * ordinary type name and a definedness of its own, so reporting on it is the
 * function's job rather than something to short-circuit. See
 * doc/design/null-as-a-value.md §8.
 */
const ANSWERS_NULL: NullBehaviour = { strict: false, total: true };

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
 * `nulls` is a required parameter, not a defaulted one. A new partial builtin
 * that inherited `TOTAL` by omission would make the analysis claim a value where
 * there may be none, which drops the definedness guard the call needs, and a
 * non-strict one that inherited `strict` would license a refinement it does not
 * support. Both are the unsound direction. Omitting the field is a compile error
 * instead.
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

  // Math. Domain errors, non-finite float results and integer results outside
  // the safe-integer range are partial by spec §5.4. Two-argument `round` is
  // also partial because scaling by `10 ** n` can overflow before rounding.
  builtin("abs", [
    ov("abs.integer", ["integer"], "integer", TOTAL),
    ov("abs.float", ["float"], "float", TOTAL),
  ]),
  builtin("round", [
    // arity-1: result is always integer (rounding to nearest whole). Single
    // (float) → integer overload covers integer inputs via promotion — the
    // result type doesn't depend on the input domain.
    ov("round.float", ["float"], "integer", PARTIAL),
    // arity-2: result follows the first arg's domain.
    ov("round.integer_integer", ["integer", "integer"], "integer", PARTIAL),
    ov("round.float_integer", ["float", "integer"], "float", PARTIAL),
  ]),
  builtin("floor", [ov("floor.float", ["float"], "integer", PARTIAL)]),
  builtin("ceil", [ov("ceil.float", ["float"], "integer", PARTIAL)]),
  builtin("sqrt", [ov("sqrt.float", ["float"], "float", PARTIAL)]),
  builtin("ln", [ov("ln.float", ["float"], "float", PARTIAL)]),
  builtin("exp", [ov("exp.float", ["float"], "float", PARTIAL)]),

  // Value coercion / introspection. All take a single `value`
  // argument and dispatch to per-dialect SQL fragments at translation
  // time. The projections are partial: a wrong-shape argument has no value
  // rather than raising (spec §5.4). `type_of` is total and answers for every
  // shape a `value` holds, `type_of(null)` being `"null"`: `null` is one of
  // those shapes, so reporting it is the function's job (§8).
  builtin("as_string", [ov("as_string.value", ["value"], "string", PARTIAL)]),
  builtin("as_integer", [ov("as_integer.value", ["value"], "integer", PARTIAL)]),
  builtin("as_float", [ov("as_float.value", ["value"], "float", PARTIAL)]),
  builtin("as_boolean", [ov("as_boolean.value", ["value"], "boolean", PARTIAL)]),
  builtin("length", [
    // A non-collection `value` has no length; a string always has one.
    ov("length.value", ["value"], "integer", PARTIAL),
    ov("length.string", ["string"], "integer", TOTAL),
  ]),
  builtin("type_of", [ov("type_of.value", ["value"], "string", ANSWERS_NULL)]),

  // `defined(e)`: does `e` have a value? True where it does, and *undefined*
  // where it does not, by the ordinary strictness every builtin has. That
  // polarity is the whole trick (doc/design/null-as-a-value.md §11.6): an
  // `undefined(e)` that had to be true on an undefined argument could not be a
  // builtin at all, since strictness would make the call undefined exactly where
  // it must hold. Here strictness does the work, and `not defined(e)` is the
  // spelling for the negative case.
  //
  // One overload per base type rather than a single `value` one, and the
  // difference matters: lifting a primitive into a `value` would route an
  // undefined `integer` through `json_quote(NULL)`, whose result is the *text*
  // `'null'` and therefore looks defined. `abs`'s shape, for the same reason of
  // wanting no lift.
  //
  // `ANSWERS_NULL`: a null argument is a value, so `defined(null)` is true. It
  // never propagates one and never returns one.
  builtin("defined", [
    ov("defined.integer", ["integer"], "boolean", ANSWERS_NULL),
    ov("defined.float", ["float"], "boolean", ANSWERS_NULL),
    ov("defined.string", ["string"], "boolean", ANSWERS_NULL),
    ov("defined.boolean", ["boolean"], "boolean", ANSWERS_NULL),
    ov("defined.value", ["value"], "boolean", ANSWERS_NULL),
  ]),

  // Object helpers. `has_key` is a boolean presence test. `keys`
  // returns a sorted array of the object's keys (as JSON strings);
  // `values` returns the corresponding array of values, ordered by key
  // for cross-backend determinism.
  // `has_key` is total: a missing key or non-object receiver is `false`. `keys` /
  // `values` are partial, non-object input having no value at all.
  //
  // `ANSWERS_NULL` rather than `TOTAL`: `has_key(null, k)` is `false`, a value,
  // so a non-null result does not prove the receiver non-null.
  builtin("has_key", [ov("has_key.value_string", ["value", "string"], "boolean", ANSWERS_NULL)]),
  builtin("keys", [ov("keys.value", ["value"], "value", PARTIAL)]),
  builtin("values", [ov("values.value", ["value"], "value", PARTIAL)]),

  // Serialise a `value` to its canonical JSON text — the inverse of
  // `parse_json`. Object keys are sorted, numbers normalised, no
  // whitespace inserted; the result is identical across every
  // backend so it's safe as a hash / dedup key.
  //
  // `ANSWERS_NULL` rather than `TOTAL`: `to_json(null)` is the text `"null"`, a
  // value, so a non-null result does not prove the argument non-null.
  builtin("to_json", [ov("to_json.value", ["value"], "string", ANSWERS_NULL)]),

  // Primitive conversions. `to_string` is polymorphic over numeric and
  // boolean inputs; the parsing variants (`to_integer`/`to_float`/
  // `to_boolean`) take string and have no value on malformed input,
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

  // Parse a string as JSON. Has no value on malformed input rather
  // than raising, matching the rest of the parsing family
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
