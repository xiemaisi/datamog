import { expect, test } from "bun:test";
import { parse, parseRaw, postProcess } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { checkModuleBoundaries, elaborate } from "../src/elaborate.ts";
import { declaredColumnType, validateStructuralColumn } from "../src/structural-declarations.ts";
import { inferTypes } from "../src/types.ts";
const typed = (source: string) => inferTypes(analyze(parse(source)));

test("records and arrays use JSON storage while publishing structural types", () => {
  const program = typed(
    'input predicate p(person: {name: string, age?: integer, scores: [float?]}). q(P["name"] + "!") :- p(P).',
  );
  expect(program.columnTypes.get("p")).toEqual(["value"]);
  expect(program.columnTypes.get("q")).toEqual(["string"]);
  expect(program.publishedSemanticColumnTypes.get("p")![0]!.kind).toBe("record");
});

test("field presence, nested nullability, extra fields and numeric kinds are checked", () => {
  const decl = typed(
    "input predicate p(x: {name: string, age?: integer, scores: [float?]}).",
  ).extDecls.get("p")!.columns[0]!;
  for (const value of [
    { name: "Ada", scores: [] },
    { name: "Ada", age: 7, scores: [1, 1.5, null] },
  ])
    expect(() => validateStructuralColumn(value, decl, "row 1")).not.toThrow();
  for (const [value, message] of [
    [{ scores: [] }, "required field"],
    [{ name: "Ada", age: null, scores: [] }, "expected integer"],
    [{ name: "Ada", age: 1.5, scores: [] }, "expected integer"],
    [{ name: "Ada", scores: ["x"] }, '$["scores"][0]'],
    [{ name: "Ada", scores: [], extra: 1 }, "unexpected field"],
  ] as const)
    expect(() => validateStructuralColumn(value, decl, "row 1")).toThrow(message);
});

test("top-level nullability is independent of element nullability", () => {
  const program = typed("input predicate p(a: [integer]?, b: [integer?]).");
  const [a, b] = program.extDecls.get("p")!.columns;
  expect(() => validateStructuralColumn(null, a!, "row 1")).not.toThrow();
  expect(() => validateStructuralColumn([null], a!, "row 1")).toThrow();
  expect(() => validateStructuralColumn(null, b!, "row 1")).toThrow();
  expect(() => validateStructuralColumn([null], b!, "row 1")).not.toThrow();
});

test("quoted fields and empty record types work; duplicate fields fail at their source", () => {
  const program = typed('input predicate p(a: {"first-name": string}, b: {}).');
  expect(declaredColumnType(program.extDecls.get("p")!.columns[1]!)).toEqual({
    kind: "record",
    fields: [],
    additional: { kind: "never" },
  });
  expect(() => typed("input predicate p(a: {x: integer, x: string}).")).toThrow(
    "Duplicate structural field",
  );
});

test("module wiring checks retained structural input contracts against published types", () => {
  const resolve = () => ({
    program: parseRaw(
      "input predicate data(x: {age: integer}). output predicate out(P) :- data(P).",
    ),
    file: "m.dl",
  });
  const check = (source: string) => {
    const result = elaborate(parseRaw(source), resolve, "entry.dl");
    postProcess(result.program);
    checkModuleBoundaries(inferTypes(analyze(result.program)), result.boundaries);
  };
  expect(() =>
    check('p({"age": 1}). input predicate q(x: {age: integer}) := out from "m.dl"(data = p).'),
  ).not.toThrow();
  expect(() =>
    check('p({"age": 1}). input predicate q(x: {age: string}) := out from "m.dl"(data = p).'),
  ).toThrow("structural declaration");
  for (const source of [
    'p({"age": "x"}).',
    'p({"age": 1, "extra": 2}).',
    'p(P: value) :- P = {"age": 1}.',
  ])
    expect(() =>
      check(`${source} input predicate q(x: value) := out from "m.dl"(data = p).`),
    ).toThrow("structural declaration");
});
