import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { AnalyzerError, analyze } from "../src/analyzer.ts";
import { declaredColumnType } from "../src/structural-declarations.ts";
import { inferTypes } from "../src/types.ts";
const typed = (source: string) => inferTypes(analyze(parse(source)));

test("structural annotations publish widened shapes transitively", () => {
  const program = typed(`p({"n": 1}: {n: float, label?: string}). q(P) :- p(P). r(P) :- q(P).`);
  const expected = declaredColumnType(program.rules.get("p")![0]!.head.argTypes![0]!);
  for (const name of ["p", "q", "r"]) {
    expect(program.columnTypes.get(name)).toEqual(["value"]);
    expect(program.publishedSemanticColumnTypes.get(name)).toEqual([expected]);
  }
  expect(program.semanticColumnTypes.get("p")).not.toEqual([expected]);
});

test("records, arrays, names, nested nullability and computed fields", () => {
  for (const source of [
    "p({}: {}).",
    "p([1, 2]: [float]).",
    "p([1, null]: [integer?]).",
    "p(null: [integer]?).",
    'p({"n": 1} as P: {n: integer}).',
    'n(1). p({"n": X + 1}: {n: integer}) :- n(X).',
    'p({"first-name": "Ada", "nested": [null]}: {"first-name": string, nested: [integer?]}).',
  ])
    expect(() => typed(source)).not.toThrow();
});

test("annotations reject narrowing, missing and extra fields, including opaque callees", () => {
  for (const source of [
    'p({"n": "x"}: {n: integer}).',
    "p({}: {n: integer}).",
    'p({"n": 1, "extra": 2}: {n: integer}).',
    "p([null]: [integer]).",
    'p({"n": null}: {n?: integer}).',
    'p(P: value) :- P = {"n": 1}. q(P: {n: integer}) :- p(P).',
    'p({"n": 1}: {n: float}). q(P: {n: integer}) :- p(P).',
  ])
    expect(() => typed(source)).toThrow("structural annotation");
});

test("annotations are checked per rule, with unannotated siblings still contributing", () => {
  expect(() => typed('p({"n": 1}: {n: integer}). p({"s": "s"}).')).not.toThrow();
  expect(() => typed('p({"n": "bad"}: {n: integer}). p({"n": 1}).')).toThrow(
    "structural annotation",
  );
});

test("recursive rules use inferred self contracts and cannot assert arbitrary shapes", () => {
  expect(() => typed('p({"n": 1}: {n: float}). p(P: {n: integer}) :- p(P).')).not.toThrow();
  expect(() => typed('p({"n": "s"}). p(P: {n: integer}) :- p(P).')).toThrow(
    "structural annotation",
  );
});

test("structural annotation errors carry source locations and reject duplicate fields", () => {
  expect(() => typed("p({}: {n?: integer, n?: string}).")).toThrow("Duplicate structural field");
  try {
    typed('p({"n": "s"}: {n: integer}).');
    throw new Error("Expected a failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AnalyzerError);
    expect((error as AnalyzerError).offset).toBeNumber();
  }
});

test("nullable field contracts require guards before narrowing", () => {
  const prefix = 'p({"n": 1}: {n: integer?}).';
  expect(() => typed(`${prefix} q({"n": N}: {n: integer}) :- p(P), N = P["n"].`)).toThrow(
    "structural annotation",
  );
  expect(() =>
    typed(`${prefix} q({"n": N}: {n: integer}) :- p(P), N = P["n"], N <> null.`),
  ).not.toThrow();
});

test("expression refinements retain their syntax alongside structural types", () => {
  expect(() => typed("p(X as N: integer, _: N > 0) :- X = 1.")).not.toThrow();
});
