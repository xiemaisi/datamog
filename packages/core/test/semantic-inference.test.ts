import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { inferSemanticColumns } from "../src/semantic-inference.ts";
import {
  ANY_VALUE,
  NEVER,
  type SemanticType,
  isSemanticSubtype,
  scalarType,
  unionType,
} from "../src/semantic-type.ts";
import { inferTypes } from "../src/types.ts";

const infer = (source: string) => inferTypes(analyze(parse(source)));
const int = scalarType("integer");
const str = scalarType("string");

test("live inference retains record and tuple fields through predicate and equality bindings", () => {
  const typed = infer(`
    source({"age": 42, "name": "Ada"}, [1, "a"]).
    copied(P, A) :- source(P, A).
    result(Age, Name, First) :- copied(P, A), Age = P["age"], Name = P["name"], First = A[0].
  `);
  expect(typed.semanticColumnTypes.get("result")).toEqual([int, str, int]);
  expect(typed.columnTypes.get("result")).toEqual(["value", "value", "value"]);
  expect(typed.publishedTypes.get("result")).toEqual(["value", "value", "value"]);
});

test("binding inference follows equality dependencies regardless of source order", () => {
  const typed = infer(`r(X) :- X = P["x"], P = {"x": 7}.`);
  expect(typed.semanticColumnTypes.get("r")).toEqual([int]);
});

test("producer alternatives and nullable external columns remain represented", () => {
  const typed = infer(`
    input predicate external(x: integer?).
    copied(X) :- external(X).
    p({"x": 1}). p({"x": "s"}).
    q(X) :- p(P), X = P["x"].
  `);
  expect(typed.semanticColumnTypes.get("copied")).toEqual([unionType(int, scalarType("null"))]);
  expect(typed.semanticColumnTypes.get("q")).toEqual([unionType(int, str)]);
});

test("missing access denotes no successful values while null remains a value", () => {
  const typed = infer(`p({"x": null}). q(P["x"], P["missing"]) :- p(P).`);
  expect(typed.semanticColumnTypes.get("q")).toEqual([scalarType("null"), NEVER]);
});

test("list aggregates retain element types", () => {
  const typed = infer("p(1). p(2). q(list(X)) :- p(X).");
  expect(typed.semanticColumnTypes.get("q")).toEqual([{ kind: "array", element: int }]);
});

test("recursive JSON construction converges to a covering type", () => {
  const typed = infer("p(1). p([X]) :- p(X).");
  const type = typed.semanticColumnTypes.get("p")![0]!;
  let valueType = int;
  for (let i = 0; i < 12; i++) {
    expect(isSemanticSubtype(valueType, type)).toBe(true);
    valueType = { kind: "tuple", elements: [valueType] } as SemanticType;
  }
});

test("mixed string and JSON indexing falls back conservatively", () => {
  const typed = infer(`p("abc"). p([1]). q(P[0]) :- p(P).`);
  expect(typed.semanticColumnTypes.get("q")).toEqual([ANY_VALUE]);
});

test("published annotations continue to govern legacy validation", () => {
  const typed = infer(`p(X: value) :- X = {"x": 1}.`);
  expect(typed.semanticColumnTypes.get("p")![0]!.kind).toBe("record");
  expect(typed.publishedTypes.get("p")).toEqual(["value"]);
  expect(infer(`p({"x": 1}). q(P["x"] + 1) :- p(P).`).columnTypes.get("q")).toEqual(["integer"]);
});

test("long reverse-ordered dependency chains retain structural precision", () => {
  const rules = Array.from({ length: 130 }, (_, i) => `p${i}(X) :- p${i + 1}(X).`);
  const typed = infer(`${rules.join("\n")}\np130({"x": 1}).`);
  const shape = {
    kind: "record",
    fields: [{ name: "x", type: int, optional: false }],
    additional: NEVER,
  };
  for (const columns of [typed.semanticColumnTypes, typed.publishedSemanticColumnTypes]) {
    expect(columns.get("p0")).toEqual([shape]);
    expect(columns.get("p130")).toEqual([shape]);
  }
});

test("dynamic projections retain element shapes across predicate boundaries", () => {
  const typed = infer(`
    input predicate rows(items: [{n: integer}]).
    index(0).
    selected(A[I]) :- rows(A), index(I).
    result(P["n"] + 1) :- selected(P).
  `);
  for (const columns of [typed.semanticColumnTypes, typed.publishedSemanticColumnTypes]) {
    expect(columns.get("selected")).toEqual([
      {
        kind: "record",
        fields: [{ name: "n", optional: false, type: int }],
        additional: NEVER,
      },
    ]);
    expect(columns.get("result")).toEqual([int]);
  }
  expect(typed.columnTypes.get("selected")).toEqual(["value"]);
});

test("dynamic projections preserve nullable and mixed element alternatives", () => {
  const typed = infer(`
    input predicate rows(items: [integer?]). index(0).
    selected(A[I]) :- rows(A), index(I).
    pair([1, "s"]). mixed(A[I]) :- pair(A), index(I).
  `);
  expect(typed.publishedSemanticColumnTypes.get("selected")).toEqual([
    unionType(int, scalarType("null")),
  ]);
  expect(typed.publishedSemanticColumnTypes.get("mixed")).toEqual([unionType(int, str)]);
  expect(() =>
    infer(`
    input predicate rows(items: [integer?]). index(0).
    selected(A[I]) :- rows(A), index(I).
    result(X + 1) :- selected(X).
  `),
  ).toThrow();
});

test("work exhaustion discards all unfinished columns, payloads and head contributions", () => {
  const typed = infer("p(1). colour() :: Red. q(P) :: Wrap(P) :- P : colour.");
  for (const maxRuleEvaluations of [0, 1]) {
    for (const inferred of [undefined, typed.semanticColumnTypes]) {
      const result = inferSemanticColumns(typed, inferred, { maxRuleEvaluations });
      for (const [name, rules] of typed.rules) {
        expect(result.semanticColumnTypes.get(name)).toEqual(
          rules[0]!.head.args.map(() => ANY_VALUE),
        );
        for (const rule of rules)
          expect(result.headContributions.get(rule)).toEqual(rule.head.args.map(() => ANY_VALUE));
      }
      expect(result.proofTypes.payload({ predicate: "q" }, "Wrap")).toEqual([ANY_VALUE]);
    }
  }
});

test("payload changes wake consumers even when nominal columns do not change", () => {
  const typed = infer(`
    result(N) :- P : box, P = Box(N).
    box() :: Box(N) :- numbers(N).
    numbers(N) :- seed(N).
    seed(7).
  `);
  expect(typed.semanticColumnTypes.get("result")).toEqual([int]);
  expect(typed.publishedSemanticColumnTypes.get("result")).toEqual([int]);
});
