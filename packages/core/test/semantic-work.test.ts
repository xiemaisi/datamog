import { expect, test } from "bun:test";
import {
  ANY_VALUE,
  NEVER,
  ProofTypeRegistry,
  type SemanticType,
  SemanticTypeLimitError,
  intersectTypes,
  intersectTypesWithinBudget,
  isSemanticSubtype,
  normalizeType,
  projectProofPayload,
  projectType,
  sameSemanticType,
  scalarType,
  unionType,
} from "../src/semantic-type.ts";

const integer = scalarType("integer");
const nested = (depth: number, leaf = integer): SemanticType => {
  let type = leaf;
  for (let i = 0; i < depth; i++) type = { kind: "array", element: type };
  return type;
};

test("nested keys stay compact enough for exact equality, union and subtype checks", () => {
  const a = nested(64);
  const b = nested(64);
  expect(sameSemanticType(a, b)).toBe(true);
  expect(unionType(a, b)).toEqual(a);
  expect(isSemanticSubtype(a, nested(64, scalarType("float")))).toBe(true);
  expect(intersectTypes(a, ANY_VALUE)).toEqual(a);
});

test("keys distinguish field names and proof identities containing encoding delimiters", () => {
  const record = (name: string): SemanticType => ({
    kind: "record",
    fields: [{ name, optional: false, type: integer }],
    additional: NEVER,
  });
  for (const name of ["x", 'x",false,never],', '["array",never]', '\\"']) {
    expect(sameSemanticType(record(name), record(`${name}x`))).toBe(false);
    expect(unionType(record(name), record(`${name}x`)).kind).toBe("union");
  }
  expect(
    sameSemanticType(
      { kind: "proof", id: { predicate: 'p",never' } },
      { kind: "proof", id: { predicate: "p" } },
    ),
  ).toBe(false);
});

test("over-deep exact inputs fail explicitly instead of overflowing the stack", () => {
  const deep = nested(20000);
  for (const operation of [
    () => normalizeType(deep),
    () => sameSemanticType(deep, deep),
    () => isSemanticSubtype(deep, ANY_VALUE),
    () => intersectTypes(deep, ANY_VALUE),
    () => projectType(deep, 0),
    () => unionType(deep, integer),
  ])
    expect(operation).toThrow(SemanticTypeLimitError);
  expect(intersectTypesWithinBudget(deep, ANY_VALUE, 4096)).toBeUndefined();
});

test("a relation's work budget includes input normalization and key construction", () => {
  const type: SemanticType = { kind: "tuple", elements: [integer, integer] };
  // Each input alone fits, but the relation must share one budget across both.
  expect(() => normalizeType(type, { maxWork: 6 })).not.toThrow();
  for (const operation of [
    () => sameSemanticType(type, type, { maxWork: 6 }),
    () => isSemanticSubtype(type, type, { maxWork: 6 }),
    () => intersectTypes(type, type, { maxWork: 6 }),
  ])
    expect(operation).toThrow(SemanticTypeLimitError);
  expect(sameSemanticType(type, type, { maxWork: 1000 })).toBe(true);
});

test("wide inputs and large names cannot bypass work limits", () => {
  expect(() =>
    normalizeType(
      { kind: "tuple", elements: Array.from({ length: 100 }, () => integer) },
      { maxWork: 10 },
    ),
  ).toThrow(SemanticTypeLimitError);
  expect(() =>
    normalizeType({ kind: "proof", id: { predicate: "x".repeat(100) } }, { maxWork: 10 }),
  ).toThrow(SemanticTypeLimitError);
  for (const maxWork of [-1, 0.5, Number.POSITIVE_INFINITY])
    expect(() => normalizeType(integer, { maxWork })).toThrow("nonnegative safe integer");
});

test("registry updates are atomic when payload normalization exceeds the limit", () => {
  const registry = new ProofTypeRegistry();
  const id = { predicate: "p" };
  expect(() => registry.define(id, [{ name: "Bad", payload: [nested(20000)] }])).toThrow(
    SemanticTypeLimitError,
  );
  registry.define(id, [{ name: "Good", payload: [integer] }]);
  expect(registry.payload(id, "Bad")).toBeUndefined();
  expect(registry.payload(id, "Good")).toEqual([integer]);
  expect(() => registry.validateReferences({ maxWork: 0 })).toThrow(SemanticTypeLimitError);
  expect(() => registry.validateReferences()).not.toThrow();
});

test("proof projection budgets include callback payloads", () => {
  const source: SemanticType = { kind: "proof", id: { predicate: "p" } };
  expect(() => projectProofPayload(source, "p", "C", 0, () => [nested(20000)])).toThrow(
    SemanticTypeLimitError,
  );
  expect(projectProofPayload(source, "p", "C", 0, () => [integer])).toEqual(integer);
});

test("key caches are discarded between operations", () => {
  const leaf: { kind: "scalar"; name: "integer" | "string" } = { kind: "scalar", name: "integer" };
  expect(sameSemanticType(leaf, integer)).toBe(true);
  leaf.name = "string";
  expect(sameSemanticType(leaf, integer)).toBe(false);
});

test("bounded intersection does not hide malformed type errors", () => {
  const field = { name: "x", optional: false, type: integer };
  const malformed: SemanticType = { kind: "record", fields: [field, field], additional: NEVER };
  expect(() => intersectTypesWithinBudget(malformed, ANY_VALUE, 4096)).toThrow(
    "Duplicate semantic field",
  );
});

test("tuple-to-array checks spend work on elements rather than impossible key equality", () => {
  const tuple: SemanticType = {
    kind: "tuple",
    elements: Array.from({ length: 256 }, () => scalarType("integer")),
  };
  // This budget covers normalization and the element checks. Constructing and
  // comparing a whole tuple key with an array key exhausted it before dispatch.
  for (const [name, expected] of [
    ["integer", true],
    ["float", true],
    ["string", false],
  ] as const)
    expect(
      isSemanticSubtype(tuple, { kind: "array", element: scalarType(name) }, { maxWork: 15_000 }),
    ).toBe(expected);
});

test("equal wide unions retain their equality shortcut within a bounded operation", () => {
  const source = unionType(
    ...Array.from(
      { length: 128 },
      (_, i): SemanticType => ({
        kind: "proof",
        id: { predicate: `module_${i}` },
      }),
    ),
  );
  expect(
    isSemanticSubtype(source, structuredClone(source), {
      maxWork: 100_000,
      maxUnionSplits: 0,
    }),
  ).toBe(true);
});
