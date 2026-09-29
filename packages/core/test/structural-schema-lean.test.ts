import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { exportLeanStructuralSchema } from "../src/structural-schema-lean.ts";
import { inferTypes } from "../src/types.ts";
import { canonicalVerificationJson, verificationDigest } from "../src/verification-manifest.ts";
const compile = (shape: string) => inferTypes(analyze(parse(`input predicate p(v: ${shape}).`)));
const descriptor = { id: "Mixed", predicate: "p", column: 0 };
const exportShape = (shape: string) => exportLeanStructuralSchema(compile(shape), descriptor);

test("mixed paths preserve field names and allocate one quantified index per array", () => {
  const result = exportShape('{teams: [{members: [{age: integer, "a.b": integer?}]}]}');
  expect(result.goals.map((g) => g.path)).toEqual([
    {
      segments: [
        { field: "teams" },
        { index: 0 },
        { field: "members" },
        { index: 1 },
        { field: "age" },
      ],
      indices: 2,
      nullable: false,
    },
    {
      segments: [
        { field: "teams" },
        { index: 0 },
        { field: "members" },
        { index: 1 },
        { field: "a.b" },
      ],
      indices: 2,
      nullable: true,
    },
  ]);
  expect(result.goals[0]!.statement).toContain("(i0 : Nat) (i1 : Nat)");
  expect(result.goals[0]!.statement).toContain("Structural.ArrayBounds value");
  expect(result.goals[1]!.statement).toContain("leafMatches true result");
  expect(result.nodes[0]!.dependencies).toEqual(["StructuralSemantics"]);
  expect(result.checker).toContain("#audit Mixed_path0");
});

test("optional and nullable containers retain membership but suppress total descendant goals", () => {
  const result = exportShape(
    "{a?: [{n: integer}], b: [{n: integer}]?, c: [{n: integer}?], d: [integer?]}",
  );
  expect(result.goals.map((g) => g.path.segments)).toEqual([[{ field: "d" }, { index: 0 }]]);
  expect(result.schema.kind).toBe("record");
  expect(result.source).toContain("Schema.array true");
  expect(result.source).toContain("true, false");
  expect(result.source).toContain("false, true");
});

test("array roots and empty records compose without manufacturing goals", () => {
  expect(exportShape("[{rows: [[{n: integer}]]}]").goals[0]!.path.indices).toBe(3);
  expect(exportShape("[{rows: [{}]}]").goals).toEqual([]);
  expect(exportShape("{}").nodes).toHaveLength(1);
});
for (const shape of [
  "integer",
  "{n: integer}?",
  "[integer]?",
  "[{n: boolean}]",
  "{v: [float]}",
  "{v: string}",
])
  test(`rejects unsupported structural schema ${shape}`, () =>
    expect(() => exportShape(shape)).toThrow());

test("mixed schema aliases expand and invalid selectors fail", () => {
  const typed = inferTypes(
    analyze(
      parse("type Item = {n: integer}. type Rows = [Item]. input predicate p(v: {rows: Rows})."),
    ),
  );
  expect(exportLeanStructuralSchema(typed, descriptor).goals[0]!.path.segments).toEqual([
    { field: "rows" },
    { index: 0 },
    { field: "n" },
  ]);
  for (const column of [-1, 1, 0.5, Number.NaN])
    expect(() => exportLeanStructuralSchema(typed, { ...descriptor, column })).toThrow();
  for (const id of ["value", "i0", "bad\naxiom"])
    expect(() => exportLeanStructuralSchema(typed, { ...descriptor, id })).toThrow();
  expect(() =>
    exportLeanStructuralSchema(typed, { ...descriptor, predicate: "missing" }),
  ).toThrow();
});

test("shape, flags, names, and predicate identity change mixed-schema identities", async () => {
  const shapes = [
    "{a: [{n: integer}]}",
    "{a?: [{n: integer}]}",
    "{a: [{n: integer}]?}",
    "{a: [{n: integer}?]}",
    "{a: [{n: integer?}]}",
    "{b: [{n: integer}]}",
    "{a: [[{n: integer}]]}",
  ];
  const hashes = await Promise.all(
    shapes.map((shape) => verificationDigest(canonicalVerificationJson(exportShape(shape).nodes))),
  );
  expect(new Set(hashes).size).toBe(shapes.length);
  const renamed = inferTypes(analyze(parse("input predicate q(v: {a: [{n: integer}]}).")));
  expect(
    canonicalVerificationJson(
      exportLeanStructuralSchema(renamed, { ...descriptor, predicate: "q" }).nodes,
    ),
  ).not.toBe(canonicalVerificationJson(exportShape(shapes[0]!).nodes));
});
