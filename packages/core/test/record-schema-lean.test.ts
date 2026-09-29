import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { exportLeanRecordSchema, leanString } from "../src/record-schema-lean.ts";
import { inferTypes } from "../src/types.ts";

const compile = (shape: string) => inferTypes(analyze(parse(`input predicate p(r: ${shape}).`)));
const descriptor = { id: "Schema", predicate: "p", column: 0 };

test("exports every modifier and only promises lookup for required fields", () => {
  const result = exportLeanRecordSchema(
    compile("{a: integer, b: integer?, c?: integer, d?: integer?}"),
    descriptor,
  );
  expect(result.fields).toEqual([
    { name: "a", optional: false, nullable: false },
    { name: "b", optional: false, nullable: true },
    { name: "c", optional: true, nullable: false },
    { name: "d", optional: true, nullable: true },
  ]);
  expect(result.goals).toHaveLength(2);
  expect(result.goals[0]!.statement).toContain("Datamog.Value.integer n");
  expect(result.goals[1]!.statement).toContain("∃ value,");
  expect(result.checker).toContain("#audit Schema_field1");
  expect(result.nodes[1]!.dependencies).toEqual(["Schema"]);
  expect(result.nodes[0]!.statement).toMatchObject(descriptor);
});

test("empty schemas and unusual keys remain data", () => {
  expect(exportLeanRecordSchema(compile("{}"), descriptor).goals).toEqual([]);
  expect(
    exportLeanRecordSchema(compile('{"": integer, "a.b": integer}'), descriptor).fields.map(
      (f) => f.name,
    ),
  ).toEqual(["", "a.b"]);
  expect(leanString('"\\\n😀')).toBe(
    "(String.ofList [Char.ofNat 34, Char.ofNat 92, Char.ofNat 10, Char.ofNat 128512])",
  );
  expect(() => leanString("\ud800")).toThrow("surrogates");
});

for (const shape of [
  "integer",
  "{x: integer}?",
  "{x: boolean}",
  "{x: value}",
  "{x: [integer]}",
  "{x: {y: integer}}",
])
  test(`rejects unsupported schema ${shape}`, () => {
    expect(() => exportLeanRecordSchema(compile(shape), descriptor)).toThrow();
  });

test("rejects invalid selectors and source identifiers", () => {
  const program = compile("{}");
  expect(() => exportLeanRecordSchema(program, { ...descriptor, id: "fields" })).toThrow();
  for (const column of [-1, 1, 0.5, Number.NaN])
    expect(() => exportLeanRecordSchema(program, { ...descriptor, column })).toThrow();
  expect(() => exportLeanRecordSchema(program, { ...descriptor, predicate: "missing" })).toThrow();
  expect(() => exportLeanRecordSchema(program, { ...descriptor, id: "x\naxiom" })).toThrow();
});

test("aliases are expanded and semantic changes alter schema identities", async () => {
  const { createVerificationManifest } = await import("../src/verification-manifest.ts");
  const aliased = inferTypes(
    analyze(parse("type Entry = {x: integer}. input predicate p(r: Entry).")),
  );
  expect(exportLeanRecordSchema(aliased, descriptor).fields[0]!.name).toBe("x");
  const digest = async (shape: string, predicate = "p") => {
    const program = compile(shape);
    if (predicate !== "p") {
      const decl = program.extDecls.get("p")!;
      program.extDecls = new Map([[predicate, { ...decl, predicate }]]);
    }
    const exported = exportLeanRecordSchema(program, { ...descriptor, predicate });
    return (
      await createVerificationManifest(
        [
          {
            id: "RecordLookup",
            kind: "definition",
            statement: "semantics",
            assumptions: [],
            dependencies: [],
          },
          ...exported.nodes,
        ],
        {
          profile: "datamog-flat-record-v1",
          method: "lean-kernel-checked",
          toolchain: "test",
          artifacts: {},
        },
      )
    ).digest;
  };
  const initial = await digest("{x: integer}");
  for (const shape of [
    "{x?: integer}",
    "{x: integer?}",
    "{y: integer}",
    "{x: integer, y?: integer}",
  ])
    expect(await digest(shape)).not.toBe(initial);
  expect(await digest("{x: integer}", "$instance$p")).not.toBe(initial);
});
