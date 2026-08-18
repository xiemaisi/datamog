// The column-type lattice: a base type paired with whether `null` inhabits it.
//
// `doc/design/null-as-a-value.md` §3 is the specification and §6 is why this is
// a pair rather than a ten-member `PrimitiveType`. The two are order-isomorphic,
// and `PrimitiveType` is compared against a literal string at ~150 sites, every
// one of which reads the base and must stay blind to the bit.
//
// **Status: a reference implementation, not on the pipeline's path.** Nothing
// outside its own test imports it. What ships is the pair of maps §6 keeps
// (`columnTypes` in `types.ts` plus `columnNullness` in `nullness.ts`), with `null`
// added to `PrimitiveType` as a sibling atom rather than as `(⊥, nullable)`
// (§15.10), and `types.ts` still lets `undefined` serve as the meet's unit, which
// the laws below say it may not. The value of this file is the laws test: it is
// where the lattice §3 specifies is checked, and where a future merge of the two
// maps would start. Keep it in step with §3, and do not read it as describing what
// runs.
//
// Twelve elements:
//
//        ⊥  <  integer  <  float           (the base order, unchanged)
//        ⊥  <  string
//        ⊥  <  boolean
//     everything  <  value                 (the coarse top)
//
// crossed with `null ∈ T?` or not. `T?` is not a new kind of type, it is the
// join `T ⊔ null`, and `null` itself is `(⊥, nullable)`: the empty base set plus
// null. `nullness-tracking.md` §7 reason 3 called that element junk, on the
// grounds that a nullness bit on an uninhabited type denotes nothing. Under this
// design it denotes exactly the type of the `null` literal, which is why the
// product needs no new elements.
//
// Two things the pair gets right that the flattened presentation in §3 did not,
// both found by making the lattice laws a test:
//
//   - **The two units are different elements.** `undefined` is ⊥ and the join's
//     identity; the meet's identity is the top, `value?`. Letting `undefined`
//     serve as both, which is what `meetTypes` in `types.ts` does, breaks
//     associativity and monotonicity.
//   - **`value` and `value?` are distinct**, so `?` means the same thing on every
//     base type and `value` is not a special case. `(value, false)` is "any JSON
//     shape, never null", which is what joining two non-null primitives yields,
//     so the join is exact where the flattened lattice over-approximated.

import type { PrimitiveType } from "./ast.ts";

/**
 * A base type paired with whether `null` is one of its values.
 *
 * `base === undefined` is ⊥, the join's identity and the "nothing known yet"
 * seed of the fixed point. Paired with `nullable`, it is the `null` type.
 */
export interface ColumnType {
  readonly base: PrimitiveType | undefined;
  readonly nullable: boolean;
}

/** ⊥: no information, and not null. The identity of `joinColumn`. */
export const BOTTOM: ColumnType = { base: undefined, nullable: false };

/** The type of the `null` literal: no base values, plus null. */
export const NULL_TYPE: ColumnType = { base: undefined, nullable: true };

/** The top: any JSON shape, null included. Spelled `value?`. */
export const VALUE_TYPE: ColumnType = { base: "value", nullable: true };

export function col(base: PrimitiveType | undefined, nullable = false): ColumnType {
  return { base, nullable };
}

export function sameColumnType(a: ColumnType, b: ColumnType): boolean {
  return a.base === b.base && a.nullable === b.nullable;
}

/** Whether this type has no values at all, which only ⊥ does. */
export function isBottom(t: ColumnType): boolean {
  return t.base === undefined && !t.nullable;
}

/** Whether this is the `null` type, whose only value is `null`. */
export function isNullType(t: ColumnType): boolean {
  return t.base === undefined && t.nullable;
}

/**
 * How a type is written in a diagnostic. `null` for the null type, `integer?`
 * for a nullable primitive, and `value` for the top, which needs no suffix
 * because it already admits one.
 */
export function formatColumnType(t: ColumnType): string {
  if (t.base === undefined) return t.nullable ? "null" : "unknown";
  return t.nullable ? `${t.base}?` : t.base;
}

/**
 * Join (least upper bound) of two base types: the smallest type accommodating
 * two producers. Total, so incompatible primitives widen to `value` rather than
 * erroring; see type-lattice.md, which argues that at length and is unaffected
 * by this change.
 */
function joinBase(
  a: PrimitiveType | undefined,
  b: PrimitiveType | undefined,
): PrimitiveType | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === b) return a;
  if ((a === "integer" && b === "float") || (a === "float" && b === "integer")) return "float";
  return "value";
}

/**
 * Meet (greatest lower bound) of two base types, `undefined` being ⊥.
 *
 * **`undefined` is ⊥ here too, not the identity**, which is the one place this
 * departs from `meetTypes` in `types.ts`. type-lattice.md records that
 * `undefined` wears two hats there, bottom as the join's identity and top as the
 * meet's, because "no element can be the unit of both operations". That is true,
 * and the answer is that they are two *different* elements: the join's unit is ⊥
 * and the meet's unit is `value`, which is a real element of the lattice and
 * already behaves as the unit, since a `value` slot merely accepts what the other
 * side requires. Making `undefined` the meet's unit as well breaks associativity
 * and monotonicity, which the law tests catch.
 *
 * The consequence for callers: a variable solve seeds at the meet's unit, not at
 * ⊥. That is `value` for the base lattice here, and `value?` for the column
 * lattice below, which is what §3.1 states.
 */
function meetBase(
  a: PrimitiveType | undefined,
  b: PrimitiveType | undefined,
): PrimitiveType | undefined {
  if (a === undefined || b === undefined) return undefined;
  if (a === b) return a;
  if ((a === "integer" && b === "float") || (a === "float" && b === "integer")) return "integer";
  // Typing the meet `value` would be less precise than the other side and would
  // reject a later `X & 1`.
  if (a === "value") return b;
  if (b === "value") return a;
  return undefined;
}

/**
 * Join, componentwise: what a column must be to accommodate every rule that
 * writes to it. Nullable if either producer can write a null.
 */
export function joinColumn(a: ColumnType, b: ColumnType): ColumnType {
  return { base: joinBase(a.base, b.base), nullable: a.nullable || b.nullable };
}

/**
 * Meet, componentwise: what a variable must be to satisfy every position it
 * occupies. Null survives only if both sides admit it.
 *
 * The result is ⊥ exactly when nothing inhabits it, which is the static error.
 * Note what does *not* error: `string? ⊓ integer?` is the `null` type, since a
 * variable in both positions can only be null. That is the case null.md §7
 * feared and it is correct here, because `null` is a sibling of the primitives
 * rather than sitting below them, so `string ⊓ integer` is still empty.
 */
export function meetColumn(a: ColumnType, b: ColumnType): ColumnType {
  return { base: meetBase(a.base, b.base), nullable: a.nullable && b.nullable };
}

/**
 * The meet's identity: the top of the lattice, which is what an unconstrained
 * variable starts at. Every value inhabits it, so meeting it with anything
 * yields that thing.
 */
export const TOP: ColumnType = VALUE_TYPE;

/** Whether `a`'s values are all `b`'s values. */
export function subsumes(b: ColumnType, a: ColumnType): boolean {
  return sameColumnType(joinColumn(a, b), b);
}

/**
 * Whether an inferred type satisfies a declared one, at a head annotation or a
 * module boundary. Directional: the declaration may equal or widen what the
 * program proves, never narrow it, so a `value` does not satisfy a declared
 * `integer` and an `integer?` does not satisfy a declared `integer`.
 */
export function columnTypeCompatible(inferred: ColumnType, declared: ColumnType): boolean {
  return subsumes(declared, inferred);
}

/**
 * Narrowing a type by removing `null`, which is what a guard proving a variable
 * non-null does (§5). ⊥ stays ⊥, and the `null` type narrows to ⊥: a rule whose
 * body proves a null-typed variable non-null can derive nothing.
 */
export function withoutNull(t: ColumnType): ColumnType {
  return t.nullable ? { base: t.base, nullable: false } : t;
}

/** Adding `null`, which is what the `?` suffix does to a declared base type. */
export function withNull(t: ColumnType): ColumnType {
  return t.nullable ? t : { base: t.base, nullable: true };
}
