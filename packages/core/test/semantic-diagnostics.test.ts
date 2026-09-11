import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { formatSemanticType, semanticContractMismatch } from "../src/semantic-diagnostics.ts";
import {
  ANY_VALUE,
  NEVER,
  type SemanticType,
  scalarType,
  unionType,
} from "../src/semantic-type.ts";
import { inferTypes } from "../src/types.ts";
const integer = scalarType("integer");
const string = scalarType("string");

test("head annotation failures identify the nested path and expected/inferred types", () => {
  expect(() =>
    inferTypes(analyze(parse('p({"items": [{"age": "old"}]}: {items: [{age: integer}]}).'))),
  ).toThrow('$["items"][0]["age"]: expected integer, inferred string');
  expect(() => inferTypes(analyze(parse("p({}: {age: integer}).")))).toThrow(
    '$["age"]: required field is not guaranteed',
  );
});

test("formatting distinguishes structural shape, presence and nominal identity", () => {
  expect(
    formatSemanticType({
      kind: "record",
      fields: [{ name: "age", optional: true, type: unionType(integer, scalarType("null")) }],
      additional: NEVER,
    }),
  ).toBe('{"age"?: integer | null}');
  expect(formatSemanticType({ kind: "tuple", elements: [integer, string] })).toBe(
    "tuple(integer, string)",
  );
  expect(formatSemanticType({ kind: "proof", id: { predicate: "p" } })).toBe("proof of 'p'");
  let deep: SemanticType = integer;
  for (let i = 0; i < 10000; i++) deep = { kind: "array", element: deep };
  expect(formatSemanticType(deep)).toContain("…");
});

test("union coverage failures do not claim a demonstrated counterexample", () => {
  const source: SemanticType = { kind: "tuple", elements: [unionType(integer, string)] };
  const target = unionType(
    { kind: "tuple", elements: [integer] },
    { kind: "tuple", elements: [string] },
  );
  expect(semanticContractMismatch(source, target)).toContain("union coverage not established");
  expect(semanticContractMismatch(source, ANY_VALUE)).toBeUndefined();
});
