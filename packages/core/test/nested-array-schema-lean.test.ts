import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { exportLeanNestedArraySchema } from "../src/nested-array-schema-lean.ts";
import { inferTypes } from "../src/types.ts";
import { canonicalVerificationJson, verificationDigest } from "../src/verification-manifest.ts";
const compile = (shape: string) => inferTypes(analyze(parse(`input predicate p(v: ${shape}).`)));
const descriptor = { id: "NestedArraySchema", predicate: "p", column: 0 };
const exportShape = (shape: string) => exportLeanNestedArraySchema(compile(shape), descriptor);

test("nested arrays retain independent nullability at every dimension and require every bound", () => {
  for (const outer of [false, true])
    for (const leaf of [false, true]) {
      const result = exportShape(`[[integer${leaf ? "?" : ""}]${outer ? "?" : ""}]`);
      expect(result.flags).toEqual([outer, leaf]);
      expect(result.statement).toContain("Bounds value path → path.length = 2 →");
      expect(result.statement).toContain(`accepts [] ${leaf} result = true`);
      expect(result.nodes[0]!.dependencies).toEqual(["NestedArraySemantics"]);
      expect(result.checker).toContain("#audit NestedArraySchema_lookup");
    }
  expect(exportShape("[[[[integer?]?]]?]").flags).toEqual([true, false, true, true]);
});
for (const shape of [
  "integer",
  "{}",
  "[[integer]]?",
  "[[boolean]]",
  "[[float]]",
  "[[{x: integer}]]",
])
  test(`rejects unsupported nested array schema ${shape}`, () =>
    expect(() => exportShape(shape)).toThrow());
test("nested array selectors and binder names are validated", () => {
  for (const column of [-1, 1, 0.5, Number.NaN])
    expect(() =>
      exportLeanNestedArraySchema(compile("[[integer]]"), { ...descriptor, column }),
    ).toThrow();
  for (const id of ["value", "path", "bad\naxiom"])
    expect(() =>
      exportLeanNestedArraySchema(compile("[[integer]]"), { ...descriptor, id }),
    ).toThrow();
  expect(() =>
    exportLeanNestedArraySchema(compile("[[integer]]"), { ...descriptor, predicate: "missing" }),
  ).toThrow();
});
test("depth, inner nullability, and predicate identities change content identities", async () => {
  const shapes = ["[[integer]]", "[[integer]?]", "[[integer?]]", "[[[integer]]]"];
  const hashes = await Promise.all(
    shapes.map(async (shape) =>
      verificationDigest(canonicalVerificationJson(exportShape(shape).nodes)),
    ),
  );
  expect(new Set(hashes).size).toBe(shapes.length);
  const renamed = inferTypes(analyze(parse("input predicate q(v: [[integer]]).")));
  expect(
    canonicalVerificationJson(
      exportLeanNestedArraySchema(renamed, { ...descriptor, predicate: "q" }).nodes,
    ),
  ).not.toBe(canonicalVerificationJson(exportShape("[[integer]]").nodes));
});
test("expanded array type aliases preserve nested flags", () => {
  const typed = inferTypes(analyze(parse("type Row = [integer?]. input predicate p(v: [Row?]).")));
  expect(exportLeanNestedArraySchema(typed, descriptor).flags).toEqual([true, true]);
});
