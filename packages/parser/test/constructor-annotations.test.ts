import { expect, test } from "bun:test";
import {
  constructorAnnotations,
  parse,
  parseRaw,
  proofConstruction,
  typeAliasReferences,
} from "../src/index.ts";

test("payload annotations lift independently and preserve expressions and source spans", () => {
  const source = 'p() :: C(42: float, "s", null: integer?, {"n": 1}: {n: float}).';
  const rule = parseRaw(source).statements[0]!;
  if (rule.$type !== "Rule") throw new Error("expected rule");
  expect(rule.ctorArgs.map((arg) => arg.$type)).toEqual([
    "NumberLiteral",
    "StringLiteral",
    "NullLiteral",
    "ObjectLiteral",
  ]);
  const types = constructorAnnotations(rule)!;
  expect(types.map((a) => a?.type)).toEqual(["float", undefined, "integer", "value"]);
  expect(types[2]!.nullable).toBe(true);
  expect(source.slice(types[0]!.offset, types[0]!.end)).toBe("42: float");
  expect(rule.ctorArgs[0]!.$container).toBe(rule);
  const lowered = parse(source).statements[0]!;
  if (lowered.$type !== "Rule") throw new Error("expected rule");
  const proof = lowered.head.args.at(-1)!;
  if (proof.$type !== "ObjectLiteral") throw new Error("expected proof");
  expect(proofConstruction(proof)!.annotations?.map((a) => a?.type)).toEqual(
    types.map((a) => a?.type),
  );
  expect(proofConstruction(proof)!.payload).toHaveLength(4);
});

test("payload aliases expand and retain navigation spans", () => {
  const source = 'type Shape = {n: [integer?]}. p() :: C({"n": [1]}: Shape).';
  const program = parseRaw(source);
  const rule = program.statements[1]!;
  if (rule.$type !== "Rule") throw new Error("expected rule");
  expect(constructorAnnotations(rule)![0]!.shape?.$type).toBe("RecordType");
  expect(typeAliasReferences(program).map((ref) => source.slice(ref.offset, ref.end))).toEqual([
    "Shape",
  ]);
  expect(() => parseRaw("p() :: C(_: Missing).")).toThrow("Unknown type alias");
});

test("bare and nullary constructors remain unannotated; matches cannot carry annotations", () => {
  for (const source of ["p() :: C.", "p() :: C().", "p() :: C(1)."]) {
    const rule = parseRaw(source).statements[0]!;
    if (rule.$type !== "Rule") throw new Error("expected rule");
    expect(constructorAnnotations(rule)).toBeUndefined();
  }
  expect(() => parseRaw("p() :: C(1). q(X) :- P : p, P = C(X: integer).")).toThrow();
  expect(() => parseRaw("p() :: C(1 as X).")).toThrow();
  expect(() => parseRaw("p() :: C(1: proof p).")).toThrow();
});
