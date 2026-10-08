import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { exportLeanArraySchema } from "../src/array-schema-lean.ts";
import { inferTypes } from "../src/types.ts";
import { canonicalVerificationJson, verificationDigest } from "../src/verification-manifest.ts";

const compile = (shape: string) => inferTypes(analyze(parse(`input predicate p(v: ${shape}).`)));
const descriptor = { id: "ArraySchema", predicate: "p", column: 0 };
const exportShape = (shape: string) => exportLeanArraySchema(compile(shape), descriptor);

test("array lookup requires an explicit index bound and preserves element nullability", () => {
  const required = exportShape("[integer]");
  const nullable = exportShape("[integer?]");
  expect(required.nullable).toBe(false);
  expect(nullable.nullable).toBe(true);
  expect(required.statement).toContain("index < values.length →");
  expect(required.statement).toContain("∃ n : Datamog.SafeInt");
  expect(nullable.statement).toContain("∃ value");
  expect(nullable.statement).not.toContain("∃ n");
  expect(required.nodes[0]!.dependencies).toEqual(["ArraySemantics"]);
  expect(required.checker).toContain("#audit ArraySchema_lookup");
});

for (const shape of [
  "integer",
  "{}",
  "[integer]?",
  "[boolean]",
  "[float]",
  "[[integer]]",
  "[{x: integer}]",
])
  test(`rejects unsupported array schema ${shape}`, () =>
    expect(() => exportShape(shape)).toThrow());

test("invalid selectors and binder identifiers fail before export", () => {
  for (const column of [-1, 1, 0.5, Number.NaN])
    expect(() => exportLeanArraySchema(compile("[integer]"), { ...descriptor, column })).toThrow();
  for (const id of ["index", "values", "x\naxiom"])
    expect(() => exportLeanArraySchema(compile("[integer]"), { ...descriptor, id })).toThrow();
});

test("element nullability changes content identities", async () => {
  const digest = async (shape: string) =>
    verificationDigest(canonicalVerificationJson(exportShape(shape).nodes));
  expect(await digest("[integer]")).not.toBe(await digest("[integer?]"));
});
