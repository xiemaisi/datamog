import { expect, test } from "bun:test";
import type { HeadTerm } from "../src/ast.ts";
import { projectSemanticSubscript } from "../src/semantic-expressions.ts";
import { ANY_VALUE, NEVER, scalarType, unionType } from "../src/semantic-type.ts";

const integer = scalarType("integer");
const nullable = unionType(integer, scalarType("null"));
const key = { $type: "StringLiteral", value: "n" } as HeadTerm;
const dynamic = { $type: "Variable", name: "I" } as HeadTerm;

test("projection presence is independent of nullable values", () => {
  for (const optional of [false, true]) {
    expect(
      projectSemanticSubscript(
        {
          kind: "record",
          fields: [{ name: "n", type: nullable, optional }],
          additional: NEVER,
        },
        key,
        "string",
      ),
    ).toEqual({ type: nullable, mayBeAbsent: optional });
  }
  expect(
    projectSemanticSubscript({ kind: "record", fields: [], additional: NEVER }, key, "string"),
  ).toEqual({ type: NEVER, mayBeAbsent: true });
});

test("dynamic tuple projection unions successful elements without adding null for absence", () => {
  expect(
    projectSemanticSubscript(
      { kind: "tuple", elements: [integer, scalarType("string")] },
      dynamic,
      "integer",
    ),
  ).toEqual({ type: unionType(integer, scalarType("string")), mayBeAbsent: true });
  expect(
    projectSemanticSubscript({ kind: "array", element: nullable }, dynamic, "integer"),
  ).toEqual({ type: nullable, mayBeAbsent: true });
  expect(projectSemanticSubscript({ kind: "tuple", elements: [] }, dynamic, "integer")).toEqual({
    type: NEVER,
    mayBeAbsent: true,
  });
});

test("opaque and mixed string/JSON receivers do not justify scalar extraction", () => {
  for (const source of [
    ANY_VALUE,
    unionType(scalarType("string"), { kind: "array", element: integer }),
  ]) {
    expect(projectSemanticSubscript(source, dynamic, "integer").type).toEqual(ANY_VALUE);
  }
});
