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

test("target unions collectively cover tuple component alternatives", () => {
  const split = unionType(tuple(int), tuple(str));
  const combined = tuple(unionType(int, str));
  expect(isSemanticSubtype(split, combined)).toBe(true);
  expect(isSemanticSubtype(combined, split)).toBe(true);
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

test("collective coverage preserves correlations between product positions", () => {
  const source = tuple(unionType(int, str), unionType(int, str));
  const diagonal = unionType(tuple(int, int), tuple(str, str));
  expect(isSemanticSubtype(source, diagonal)).toBe(false);
  expect(isSemanticSubtype(source, unionType(diagonal, tuple(int, str), tuple(str, int)))).toBe(
    true,
  );
  expect(
    isSemanticSubtype(
      record(tuple(unionType(int, str))),
      unionType(record(tuple(int)), record(tuple(str))),
    ),
  ).toBe(true);
});

test("optional field coverage distinguishes absence from null and preserves extra fields", () => {
  expect(isSemanticSubtype(record(int, true), unionType(emptyRecord, record(int)))).toBe(true);
  expect(
    isSemanticSubtype(record(unionType(int, nil), true), unionType(emptyRecord, record(int))),
  ).toBe(false);
  expect(
    isSemanticSubtype(
      record(unionType(int, nil), true),
      unionType(emptyRecord, record(int), record(nil)),
    ),
  ).toBe(true);
  const absent = record(NEVER, true, ANY_VALUE);
  expect(
    isSemanticSubtype(
      record(int, true, ANY_VALUE),
      unionType(absent, record(int, false, ANY_VALUE)),
    ),
  ).toBe(true);
  expect(
    isSemanticSubtype(
      record(int, true, ANY_VALUE),
      unionType(emptyRecord, record(int, false, ANY_VALUE)),
    ),
  ).toBe(false);
});

test("array element unions cannot be distributed across whole arrays", () => {
  expect(isSemanticSubtype(array(unionType(int, str)), unionType(array(int), array(str)))).toBe(
    false,
  );
  expect(
    isSemanticSubtype(array(tuple(unionType(int, str))), array(unionType(tuple(int), tuple(str)))),
  ).toBe(true);
  expect(
    isSemanticSubtype(
      tuple(unionType(proof, otherProof)),
      unionType(tuple(proof), tuple(otherProof)),
    ),
  ).toBe(true);
  expect(isSemanticSubtype(tuple(openRecord), unionType(tuple(proof), tuple(otherProof)))).toBe(
    false,
  );
});

test("collective coverage is bounded and exhaustion never establishes a contract", () => {
  const source = tuple(unionType(int, str));
  const target = unionType(tuple(int), tuple(str));
  expect(isSemanticSubtype(source, target, { maxUnionSplits: 0 })).toBe(false);
  expect(isSemanticSubtype(source, target, { maxUnionSplits: 2 })).toBe(true);
  expect(isSemanticSubtype(int, unionType(float, str), { maxUnionSplits: 0 })).toBe(true);
  expect(() => isSemanticSubtype(source, target, { maxUnionSplits: -1 })).toThrow("Union coverage");
});

test("collective coverage agrees with an independent finite membership oracle", () => {
  const leaf = [int, str, nil, unionType(int, str), unionType(int, nil)];
  const products = leaf.flatMap((type) => [
    tuple(type),
    record(type),
    record(type, true),
    record(type, true, ANY_VALUE),
    array(type),
  ]);
  const targets = products.flatMap((a) => products.map((b) => unionType(a, b)));
  const values: unknown[] = [[], {}, [1, "s"], { y: 1 }];
  for (const value of [1, "s", null]) values.push([value], { x: value }, { x: value, y: 1 });
  for (const source of products) {
    for (const target of targets) {
      if (!isSemanticSubtype(source, target)) continue;
      for (const value of values)
        if (contains(source, value)) expect(contains(target, value)).toBe(true);
    }
  }
});

test("partial Cartesian coverage cannot succeed when the remaining budget is exhausted", () => {
  const source = tuple(unionType(int, str), unionType(int, str));
  const target = unionType(tuple(int, int), tuple(int, str), tuple(str, int), tuple(str, str));
  expect(isSemanticSubtype(source, target, { maxUnionSplits: 4 })).toBe(false);
  expect(isSemanticSubtype(source, target, { maxUnionSplits: 6 })).toBe(true);
});

test("additional record fields may choose different union alternatives independently", () => {
  const source: SemanticType = { kind: "record", fields: [], additional: unionType(int, str) };
  const target = unionType(
    { kind: "record", fields: [], additional: int },
    { kind: "record", fields: [], additional: str },
  );
  expect(contains(source, { x: 1, y: "s" })).toBe(true);
  expect(contains(target, { x: 1, y: "s" })).toBe(false);
  expect(isSemanticSubtype(source, target)).toBe(false);
});

test("six-choice coverage fits default work while preserving correlations and split limits", () => {
  // Fresh leaves prevent object identity from standing in for a structural proof.
  const source = tuple(
    ...Array.from({ length: 6 }, () => unionType(scalarType("integer"), scalarType("string"))),
  );
  const alternatives = Array.from({ length: 64 }, (_, mask) =>
    tuple(
      ...Array.from({ length: 6 }, (_, bit) =>
        scalarType(mask & (1 << bit) ? "integer" : "string"),
      ),
    ),
  );
  const target = unionType(...alternatives);
  expect(isSemanticSubtype(source, target)).toBe(true);
  expect(isSemanticSubtype(source, target, { maxUnionSplits: 124 })).toBe(false);
  expect(isSemanticSubtype(source, target, { maxUnionSplits: 126 })).toBe(true);
  const incomplete = unionType(...alternatives.slice(1));
  const missing = Array.from({ length: 6 }, () => "s");
  expect(contains(source, missing)).toBe(true);
  expect(contains(incomplete, missing)).toBe(false);
  expect(isSemanticSubtype(source, incomplete)).toBe(false);
});

test("equal structural types remain reflexive without splits or shared object identity", () => {
  for (const type of [...types, unionType(...types.filter((t) => t.kind !== "value"))]) {
    const copy = structuredClone(type);
    expect(isSemanticSubtype(type, copy, { maxUnionSplits: 0 })).toBe(true);
    expect(isSemanticSubtype(copy, type, { maxUnionSplits: 0 })).toBe(true);
  }
});
