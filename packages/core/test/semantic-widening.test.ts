import { expect, test } from "bun:test";
import {
  ANY_VALUE,
  NEVER,
  NON_NULL_VALUE,
  type SemanticType,
  isSemanticSubtype,
  sameSemanticType,
  scalarType,
  unionType,
} from "../src/semantic-type.ts";
import { boundSemanticType, widenSemanticType } from "../src/semantic-widening.ts";

const int = scalarType("integer");
const str = scalarType("string");
const array = (element: SemanticType): SemanticType => ({ kind: "array", element });
const record = (name: string, type: SemanticType): SemanticType => ({
  kind: "record",
  fields: [{ name, type, optional: false }],
  additional: NEVER,
});
const budget = { maxDepth: 3, maxWidth: 3 };

test("bounded types cover their inputs and bounding is idempotent", () => {
  const samples = [
    NEVER,
    ANY_VALUE,
    NON_NULL_VALUE,
    int,
    array(int),
    record("x", array(int)),
    array(array(array(array(int)))),
    unionType(int, str, array(int), record("x", int)),
    { kind: "tuple", elements: [int, int, int, int] } as SemanticType,
    { kind: "proof", id: { predicate: "module::list" } } as SemanticType,
  ];
  for (const source of samples) {
    const result = boundSemanticType(source, budget);
    expect(isSemanticSubtype(source, result)).toBe(true);
    expect(sameSemanticType(boundSemanticType(result, budget), result)).toBe(true);
    for (const other of samples) {
      const widened = widenSemanticType(source, other, budget);
      expect(isSemanticSubtype(source, widened)).toBe(true);
      expect(isSemanticSubtype(other, widened)).toBe(true);
    }
  }
});

test("precision is retained for small types, proof leaves and covered producers", () => {
  const small = record("x", array(int));
  expect(boundSemanticType(small, budget)).toEqual(small);
  expect(widenSemanticType(NEVER, small, budget)).toEqual(small);
  expect(widenSemanticType(ANY_VALUE, small, budget)).toEqual(ANY_VALUE);
  expect(widenSemanticType(array(scalarType("float")), array(int), budget)).toEqual(
    array(scalarType("float")),
  );
  const proof: SemanticType = { kind: "proof", id: { predicate: "list" } };
  expect(boundSemanticType(proof, { maxDepth: 0, maxWidth: 1 })).toEqual(proof);
  expect(boundSemanticType(array(proof), { maxDepth: 0, maxWidth: 1 })).toEqual(ANY_VALUE);
});

test("recursive array and record producers reach a stable covering type", () => {
  for (const wrap of [array, (type: SemanticType) => record("next", type)]) {
    let state = NEVER;
    let stable = false;
    for (let iteration = 0; iteration < 30; iteration++) {
      const contribution = unionType(int, wrap(state));
      const next = widenSemanticType(state, contribution, budget);
      expect(isSemanticSubtype(state, next)).toBe(true);
      expect(isSemanticSubtype(contribution, next)).toBe(true);
      if (sameSemanticType(next, state)) {
        stable = true;
        break;
      }
      state = next;
    }
    expect(stable).toBe(true);
  }
});

test("growing fields, tuples and alternatives trigger width limits", () => {
  let alternatives = NEVER;
  for (let i = 0; i < 10; i++) {
    const source = record(`field${i}`, int);
    alternatives = widenSemanticType(alternatives, source, budget);
    expect(isSemanticSubtype(source, alternatives)).toBe(true);
  }
  expect(alternatives).toEqual(ANY_VALUE);
  expect(boundSemanticType({ kind: "tuple", elements: [int, int, int, int] }, budget)).toEqual(
    array(int),
  );
  expect(
    boundSemanticType(
      {
        kind: "record",
        fields: ["a", "b", "c", "d"].map((name) => ({ name, type: int, optional: false })),
        additional: NEVER,
      },
      budget,
    ),
  ).toEqual({
    kind: "record",
    fields: ["a", "b", "c"].map((name) => ({ name, type: int, optional: false })),
    additional: ANY_VALUE,
  });
});

test("bounds are applied before traversing deeply nested input", () => {
  let deep = int;
  for (let i = 0; i < 20000; i++) deep = array(deep);
  expect(boundSemanticType(deep, budget)).toEqual(array(array(array(ANY_VALUE))));
});

test("invalid budgets are rejected", () => {
  for (const invalid of [
    { maxDepth: -1, maxWidth: 1 },
    { maxDepth: 1, maxWidth: 0 },
    { maxDepth: 0.5, maxWidth: 1 },
    { maxDepth: 1, maxWidth: Number.POSITIVE_INFINITY },
  ])
    expect(() => boundSemanticType(int, invalid)).toThrow("Type budget");
});

test("wide record summaries are deterministic and preserve selected field contracts", () => {
  const fields = ["d", "b", "c", "a"].map((name) => ({ name, type: int, optional: false }));
  const source: SemanticType = { kind: "record", fields, additional: NEVER };
  const summary = boundSemanticType(source, budget);
  expect(isSemanticSubtype(source, summary)).toBe(true);
  expect(boundSemanticType({ ...source, fields: [...fields].reverse() }, budget)).toEqual(summary);
  expect(boundSemanticType(summary, budget)).toEqual(summary);
});

test("wide tuples preserve element types and summarize mixed alternatives soundly", () => {
  for (const elements of [
    [int, int, int, int],
    [int, str, int, str],
    [NON_NULL_VALUE, int, scalarType("null"), str],
  ]) {
    const source: SemanticType = { kind: "tuple", elements };
    const summary = boundSemanticType(source, budget);
    expect(summary).toEqual(array(unionType(...elements)));
    expect(isSemanticSubtype(source, summary)).toBe(true);
    expect(boundSemanticType(summary, budget)).toEqual(summary);
  }
});

test("producer accumulation retains alternatives that collectively cover a new contribution", () => {
  const previous = unionType(
    { kind: "tuple", elements: [int] },
    { kind: "tuple", elements: [str] },
  );
  const contribution: SemanticType = { kind: "tuple", elements: [unionType(int, str)] };
  expect(widenSemanticType(previous, contribution)).toEqual(previous);
  expect(isSemanticSubtype(contribution, previous)).toBe(true);
});
