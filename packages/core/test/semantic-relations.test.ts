import { expect, test } from "bun:test";
import {
  ANY_VALUE,
  NEVER,
  type SemanticType,
  intersectTypes,
  isSemanticSubtype,
  sameSemanticType,
  scalarType,
  unionType,
} from "../src/semantic-type.ts";

const int = scalarType("integer");
const float = scalarType("float");
const str = scalarType("string");
const nil = scalarType("null");
const array = (element: SemanticType): SemanticType => ({ kind: "array", element });
const tuple = (...elements: SemanticType[]): SemanticType => ({ kind: "tuple", elements });
const record = (type: SemanticType, optional = false, additional = NEVER): SemanticType => ({
  kind: "record",
  fields: [{ name: "x", type, optional }],
  additional,
});
const emptyRecord: SemanticType = { kind: "record", fields: [], additional: NEVER };
const openRecord: SemanticType = { kind: "record", fields: [], additional: ANY_VALUE };
const proof: SemanticType = { kind: "proof", id: { predicate: "a::list" } };
const otherProof: SemanticType = { kind: "proof", id: { predicate: "b::list" } };

const types = [
  NEVER,
  ANY_VALUE,
  int,
  float,
  str,
  nil,
  unionType(int, nil),
  array(int),
  array(str),
  array(NEVER),
  tuple(),
  tuple(int),
  tuple(float, str),
  emptyRecord,
  openRecord,
  record(int),
  record(float),
  record(str, true),
  record(NEVER, true, ANY_VALUE),
  record(unionType(int, nil), true),
  proof,
  otherProof,
];

function equivalent(a: SemanticType, b: SemanticType): boolean {
  return isSemanticSubtype(a, b) && isSemanticSubtype(b, a);
}

test("intersection identities, commutativity, associativity and lower bounds", () => {
  for (const a of types) {
    expect(equivalent(intersectTypes(a, ANY_VALUE), a)).toBe(true);
    expect(intersectTypes(a, NEVER)).toEqual(NEVER);
    expect(equivalent(intersectTypes(a, a), a)).toBe(true);
    for (const b of types) {
      const meet = intersectTypes(a, b);
      expect(isSemanticSubtype(meet, a)).toBe(true);
      expect(isSemanticSubtype(meet, b)).toBe(true);
      expect(equivalent(meet, intersectTypes(b, a))).toBe(true);
      for (const c of types) {
        expect(equivalent(intersectTypes(meet, c), intersectTypes(a, intersectTypes(b, c)))).toBe(
          true,
        );
      }
    }
  }
});

test("contract checks are directional and preserve presence constraints", () => {
  expect(isSemanticSubtype(int, float)).toBe(true);
  expect(isSemanticSubtype(float, int)).toBe(false);
  expect(isSemanticSubtype(record(int), record(float, true))).toBe(true);
  expect(isSemanticSubtype(record(int, true), record(float))).toBe(false);
  expect(isSemanticSubtype(record(unionType(int, nil)), record(int))).toBe(false);
  expect(isSemanticSubtype(openRecord, emptyRecord)).toBe(false);
  expect(isSemanticSubtype(emptyRecord, openRecord)).toBe(true);
  expect(isSemanticSubtype(emptyRecord, record(int, true))).toBe(true);
  expect(isSemanticSubtype(record(int), emptyRecord)).toBe(false);
  expect(isSemanticSubtype(openRecord, record(NEVER, true, ANY_VALUE))).toBe(false);
});

test("incompatible optional fields prohibit presence; required conflicts are empty", () => {
  expect(intersectTypes(record(int), record(str, true))).toEqual(NEVER);
  expect(equivalent(intersectTypes(record(int, true), record(str, true)), emptyRecord)).toBe(true);
  expect(equivalent(intersectTypes(record(int, true), emptyRecord), emptyRecord)).toBe(true);
  expect(intersectTypes(record(int), emptyRecord)).toEqual(NEVER);
  expect(sameSemanticType(intersectTypes(array(int), array(str)), array(NEVER))).toBe(true);
  expect(equivalent(array(NEVER), tuple())).toBe(true);
  expect(intersectTypes(tuple(int), tuple())).toEqual(NEVER);
});

test("proof identity survives structural operations without implying membership", () => {
  expect(isSemanticSubtype(proof, ANY_VALUE)).toBe(true);
  expect(isSemanticSubtype(proof, openRecord)).toBe(false);
  expect(isSemanticSubtype(openRecord, proof)).toBe(false);
  expect(intersectTypes(proof, otherProof)).toEqual(NEVER);
  expect(intersectTypes(proof, openRecord)).toEqual(NEVER);
  expect(intersectTypes(unionType(proof, otherProof), proof)).toEqual(proof);
});

test("target union coverage is deliberately conservative", () => {
  const split = unionType(tuple(int), tuple(str));
  const combined = tuple(unionType(int, str));
  expect(isSemanticSubtype(split, combined)).toBe(true);
  // Equivalent sets, but proving collective coverage needs a stronger algorithm.
  expect(isSemanticSubtype(combined, split)).toBe(false);
});

// Independent finite denotation oracle: checks successful subtype judgments and
// exact intersection against concrete JSON values, rather than mirroring the
// pairwise structural algorithms above.
function contains(type: SemanticType, value: unknown): boolean {
  switch (type.kind) {
    case "never":
      return false;
    case "value":
      return true;
    case "proof":
      return false; // JSON shape never establishes nominal proof membership.
    case "scalar":
      switch (type.name) {
        case "integer":
          return typeof value === "number" && Number.isInteger(value);
        case "float":
          return typeof value === "number";
        case "string":
          return typeof value === "string";
        case "boolean":
          return typeof value === "boolean";
        case "null":
          return value === null;
      }
      throw new Error("Unknown scalar type");
    case "union":
      return type.members.some((member) => contains(member, value));
    case "array":
      return Array.isArray(value) && value.every((v) => contains(type.element, v));
    case "tuple":
      return (
        Array.isArray(value) &&
        value.length === type.elements.length &&
        type.elements.every((element, i) => contains(element, value[i]))
      );
    case "record": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      if (type.fields.some((f) => !f.optional && !Object.hasOwn(object, f.name))) return false;
      return Object.entries(object).every(([key, v]) =>
        contains(type.fields.find((f) => f.name === key)?.type ?? type.additional, v),
      );
    }
  }
}

test("structural relations agree with concrete JSON membership", () => {
  const values: unknown[] = [
    null,
    true,
    1,
    1.5,
    "s",
    [],
    [1],
    ["s"],
    [1, "s"],
    {},
    { x: 1 },
    { x: null },
    { x: "s" },
    { y: 1 },
    { x: 1, y: "s" },
  ];
  const structural = types.filter((t) => t.kind !== "proof");
  for (const a of structural) {
    for (const b of structural) {
      const meet = intersectTypes(a, b);
      const subtype = isSemanticSubtype(a, b);
      for (const value of values) {
        expect(contains(meet, value)).toBe(contains(a, value) && contains(b, value));
        if (subtype && contains(a, value)) expect(contains(b, value)).toBe(true);
      }
    }
  }
});
