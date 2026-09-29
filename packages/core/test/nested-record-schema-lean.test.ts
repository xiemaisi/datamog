import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { exportLeanNestedRecordSchema } from "../src/nested-record-schema-lean.ts";
import { inferTypes } from "../src/types.ts";
import { canonicalVerificationJson, verificationDigest } from "../src/verification-manifest.ts";

const compile = (shape: string) => inferTypes(analyze(parse(`input predicate p(r: ${shape}).`)));
const descriptor = { id: "Nested", predicate: "p", column: 0 };
const exportShape = (shape: string) => exportLeanNestedRecordSchema(compile(shape), descriptor);

test("only required non-nullable parents produce integer-leaf path guarantees", () => {
  const result = exportShape(
    "{a: {b: {n: integer, nullable: integer?}}, optional?: {n: integer}, nullable: {n: integer}?}",
  );
  expect(result.goals.map((g) => g.path)).toEqual([
    { keys: ["a", "b", "n"], nullable: false },
    { keys: ["a", "b", "nullable"], nullable: true },
  ]);
  expect(result.goals[0]!.statement).toContain(".scalar (.integer n)");
  expect(result.goals[1]!.statement).toContain("∃ result");
  expect(result.fields[1]!.optional).toBe(true);
  expect(result.fields[2]!.nullable).toBe(true);
  expect(result.nodes[0]!.dependencies).toEqual(["NestedRecords"]);
  expect(result.checker).toContain("#audit Nested_path1");
});

test("empty schemas and optional leaves make no lookup claims", () => {
  for (const shape of ["{}", "{a: {}}", "{a: {n?: integer}}", "{a?: {b: {n: integer}}}"])
    expect(exportShape(shape).goals).toEqual([]);
});

test("key paths preserve literal dots, empty keys, and unicode", () => {
  expect(exportShape('{"a.b": {"": {"😀": integer}}}').goals[0]!.path.keys).toEqual([
    "a.b",
    "",
    "😀",
  ]);
});

for (const shape of [
  "integer",
  "{}?",
  "{a: [integer]}",
  "{a: {b: string}}",
  "{a: {b: value?}}",
  "{a: {b: boolean}}",
])
  test(`reject unsupported nested schema ${shape}`, () =>
    expect(() => exportShape(shape)).toThrow());

test("invalid selectors and binder identifiers are rejected", () => {
  for (const column of [-1, 1, 0.5, Number.NaN])
    expect(() => exportLeanNestedRecordSchema(compile("{}"), { ...descriptor, column })).toThrow();
  for (const id of ["value", "x\naxiom"])
    expect(() => exportLeanNestedRecordSchema(compile("{}"), { ...descriptor, id })).toThrow();
});

test("nested flags, keys and shapes participate in statement identities", async () => {
  const initial = await verificationDigest(
    canonicalVerificationJson(exportShape("{a: {n: integer}}").nodes),
  );
  for (const shape of [
    "{a?: {n: integer}}",
    "{a: {n: integer}?}",
    "{a: {n: integer?}}",
    "{a: {m: integer}}",
    "{a: {n: {}}}",
  ])
    expect(await verificationDigest(canonicalVerificationJson(exportShape(shape).nodes))).not.toBe(
      initial,
    );
});
