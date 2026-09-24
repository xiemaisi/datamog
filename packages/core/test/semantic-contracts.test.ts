import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { AnalyzerError, analyze } from "../src/analyzer.ts";
import { NON_NULL_VALUE, scalarType } from "../src/semantic-type.ts";
import { inferTypes } from "../src/types.ts";
const infer = (source: string) => inferTypes(analyze(parse(source)));

test("published shapes honor annotations transitively without changing implementation types", () => {
  const typed = infer('p(X: value) :- X = {"x": 1}. q(X) :- p(X). r(X) :- q(X).');
  for (const pred of ["p", "q", "r"]) {
    expect(typed.semanticColumnTypes.get(pred)![0]!.kind).toBe("record");
    expect(typed.publishedSemanticColumnTypes.get(pred)).toEqual([NON_NULL_VALUE]);
    expect(typed.columnTypes.get(pred)).toEqual(["value"]);
  }
});

test("unannotated predicates publish their inferred structural precision", () => {
  const typed = infer('p({"x": 1}). q(X) :- p(X).');
  expect(typed.publishedSemanticColumnTypes.get("q")).toEqual(typed.semanticColumnTypes.get("q"));
});

test("constructor signatures respect widened producer contracts", () => {
  const typed = infer("n(X: value) :- X = 1. opt() :: Some :- n(X).");
  expect(typed.proofTypes.payload({ predicate: "opt" }, "Some")).toEqual([scalarType("integer")]);
  expect(typed.publishedProofTypes.payload({ predicate: "opt" }, "Some")).toEqual([NON_NULL_VALUE]);
  expect(() =>
    infer('n(X: value) :- X = 1. opt() :: Some :- n(X). ?- Some("s") = P.'),
  ).not.toThrow();
});

test("distinct proof requirements are rejected in rules and queries", () => {
  for (const consumer of ["bad(P) :- P : a, P : b.", "?- P : a, P : b."]) {
    expect(() => infer(`a() :: A. b() :: B. ${consumer}`)).toThrow("incompatible semantic types");
  }
});

test("constructor payload literals must overlap the published payload type", () => {
  expect(() => infer('n(1). opt() :: Some :- n(X). ?- Some("s") = P.')).toThrow(
    "Constructor payload",
  );
  expect(() => infer("n(1). opt() :: Some :- n(X). ?- Some(1) = P.")).not.toThrow();
});

test("nested nullary constructor matches check their receiver identity", () => {
  expect(() =>
    infer(`
    colour() :: Red.
    nat() :: Zero.
    box() :: Box :- P : colour.
    ?- Box(Zero()) = B.
  `),
  ).toThrow("cannot match");
});

test("semantic errors retain source locations", () => {
  try {
    infer("a() :: A. b() :: B. ?- P : a, P : b.");
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AnalyzerError);
    expect((error as AnalyzerError).offset).toBeNumber();
  }
});

test("published primitive widening also reaches computed wrapper results", () => {
  const typed = infer("p(X: float) :- X = 1. q(X + 1) :- p(X).");
  expect(typed.semanticColumnTypes.get("q")![0]).toEqual(scalarType("integer"));
  expect(typed.publishedSemanticColumnTypes.get("q")![0]).toEqual(scalarType("float"));
});

test("integrity constraints use the same proof compatibility checks", () => {
  expect(() => infer("a() :: A. b() :: B. !- P : a, P : b.")).toThrow(
    "incompatible semantic types",
  );
});
