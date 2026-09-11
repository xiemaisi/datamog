import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { constrainSemanticVariable } from "../src/semantic-constraints.ts";
import {
  ANY_VALUE,
  NEVER,
  type SemanticType,
  intersectTypes,
  intersectTypesWithinBudget,
  isSemanticSubtype,
  projectProofPayload,
  scalarType,
  unionType,
} from "../src/semantic-type.ts";
import { inferTypes } from "../src/types.ts";
const int = scalarType("integer");
const str = scalarType("string");
const a: SemanticType = { kind: "proof", id: { predicate: "a" } };
const b: SemanticType = { kind: "proof", id: { predicate: "b" } };

test("shared requirements narrow existing information and keep empty distinct from unknown", () => {
  const vars = new Map<string, SemanticType>();
  expect(constrainSemanticVariable(vars, "X", unionType(int, str))).toBe(true);
  expect(constrainSemanticVariable(vars, "X", int)).toBe(true);
  expect(vars.get("X")).toEqual(int);
  expect(constrainSemanticVariable(vars, "X", ANY_VALUE)).toBe(false);
  expect(constrainSemanticVariable(vars, "X", str)).toBe(true);
  expect(vars.get("X")).toEqual(NEVER);
  expect(constrainSemanticVariable(vars, "X", int)).toBe(false);
});

test("successful proof matching filters nominal alternatives but never trusts an opaque branch", () => {
  const lookup = () => [int];
  expect(projectProofPayload(unionType(a, b), "a", "A", 0, lookup)).toEqual(int);
  expect(projectProofPayload(b, "a", "A", 0, lookup)).toEqual(NEVER);
  expect(projectProofPayload(ANY_VALUE, "a", "A", 0, lookup)).toEqual(ANY_VALUE);
  const record: SemanticType = { kind: "record", fields: [], additional: ANY_VALUE };
  expect(projectProofPayload(unionType(a, record), "a", "A", 0, lookup)).toEqual(ANY_VALUE);
});

test("shared JSON constraints refine both inferred and published output shapes", () => {
  const typed = inferTypes(
    analyze(parse('a({"x": 1}). a({"x": "s"}). b({"x": 1}). q(P["x"]) :- a(P), b(P).')),
  );
  expect(typed.semanticColumnTypes.get("q")).toEqual([int]);
  expect(typed.publishedSemanticColumnTypes.get("q")).toEqual([int]);
});

test("union-aware payload validation rejects an incompatible nested literal", () => {
  expect(() =>
    inferTypes(
      analyze(
        parse(`
    n(7). s("s"). a() :: A :- n(X). b() :: B :- s(X).
    choice(P) :- P : a. choice(P) :- P : b.
    box() :: Box(P) :- choice(P).
    ?- Box(a::A("wrong")) = P.
  `),
      ),
    ),
  ).toThrow("Constructor payload");
});

test("a widened payload contract remains opaque through a nested union match", () => {
  expect(() =>
    inferTypes(
      analyze(
        parse(`
    n(X: value) :- X = 7. s("s"). a() :: A :- n(X). b() :: B :- s(X).
    choice(P) :- P : a. choice(P) :- P : b.
    box() :: Box(P) :- choice(P).
    answer(X + 1) :- Box(a::A(X)) = P.
  `),
      ),
    ),
  ).toThrow();
});

test("a budget boundary cannot widen a variable while applying a requirement", () => {
  const shape = (prefix: string): SemanticType => ({
    kind: "record",
    additional: ANY_VALUE,
    fields: Array.from({ length: 5 }, (_, i) => ({
      name: `${prefix}${i}`,
      type: int,
      optional: false,
    })),
  });
  const previous = shape("a");
  const vars = new Map([["X", previous]]);
  // Summarizing ten fields may retain extra requirements, but must not lose
  // any of the previous ones, regardless of which field names survive.
  constrainSemanticVariable(vars, "X", shape("b"));
  expect(isSemanticSubtype(vars.get("X")!, previous)).toBe(true);
});

test("intersection work exhaustion returns unknown instead of a partial intersection", () => {
  const left = unionType(int, str, { kind: "array", element: int });
  const right = unionType(int, { kind: "array", element: scalarType("float") });
  expect(intersectTypesWithinBudget(left, right, 1)).toBeUndefined();
  expect(intersectTypesWithinBudget(left, right, 100)).toEqual(intersectTypes(left, right));
  expect(() => intersectTypesWithinBudget(left, right, -1)).toThrow("Intersection work limit");
});

test("deep requirements are bounded before local intersection", () => {
  let requirement = int;
  for (let i = 0; i < 20000; i++) requirement = { kind: "array", element: requirement };
  const previous: SemanticType = { kind: "array", element: ANY_VALUE };
  const vars = new Map([["X", previous]]);
  expect(() => constrainSemanticVariable(vars, "X", requirement)).not.toThrow();
  expect(isSemanticSubtype(vars.get("X")!, previous)).toBe(true);
});
