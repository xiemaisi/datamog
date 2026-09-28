import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { type CoverageClaim, exportLeanCoverage } from "../src/obligation-lean.ts";
import { inferTypes } from "../src/types.ts";
import { createVerificationManifest } from "../src/verification-manifest.ts";

const compile = (source: string) => inferTypes(analyze(parse(source)));
const program = compile("input predicate p(a: integer, b: integer). q(X, Y, X + 1) :- p(X, Y).");
const claim: CoverageClaim = {
  id: "coverage",
  predicate: "q",
  relationName: "Q",
  inputPredicate: "p",
  outputToInput: [0, null, null],
  bounds: [{ column: 0, op: "<", value: Number.MAX_SAFE_INTEGER }],
};

test("coverage quantifies all input columns and independent output witnesses", () => {
  const result = exportLeanCoverage(program, claim);
  expect(result.statement).toContain("(v0 : Datamog.SafeInt) (v1 : Datamog.SafeInt)");
  expect(result.statement).toContain(
    "input0 v0 v1 → v0.val < (9007199254740991 : Int) → ∃ (w1 : Datamog.SafeInt) (w2 : Datamog.SafeInt), Q input0 v0 w1 w2",
  );
  expect(result.statement).not.toContain("w2.val");
  expect(result.checker).toContain("theorem coverage : Generated.coverage := Proofs.coverage");
  expect(result.nodes[1]).toMatchObject({ kind: "goal", assumptions: [], dependencies: ["Q"] });
});

test("coverage permits repeated mappings and direct inclusion without witnesses", () => {
  const result = exportLeanCoverage(program, {
    ...claim,
    outputToInput: [1, 0, 1],
    bounds: [],
  });
  expect(result.statement).toContain("input0 v0 v1 → Q input0 v1 v0 v1");
  expect(result.statement).not.toContain("∃");
  const all = exportLeanCoverage(program, { ...claim, outputToInput: [null, null, null] });
  expect(all.statement).toContain("Q input0 w0 w1 w2");
});

test("coverage uses the selected input's arity and preserves parameter ordering", () => {
  const multi = compile(
    "input predicate p(a: integer, b: integer). input predicate r(c: integer). q(X, Y, Z) :- r(Z), p(X, Y).",
  );
  const result = exportLeanCoverage(multi, claim);
  expect(result.statement).toContain(
    "(input0 : Datamog.SafeInt → Prop) (input1 : Datamog.SafeInt → Datamog.SafeInt → Prop)",
  );
  expect(result.statement).toContain("input1 v0 v1 →");
  expect(result.statement).toContain("Q input0 input1 v0 w1 w2");
  expect(() =>
    exportLeanCoverage(multi, {
      ...claim,
      inputPredicate: "r",
      outputToInput: [1, null, null],
    }),
  ).toThrow("mapping");
});

test("all supported bounds remain explicit input-domain restrictions", () => {
  const result = exportLeanCoverage(program, {
    ...claim,
    bounds: [
      { column: 0, op: ">=", value: -5 },
      { column: 0, op: "<=", value: 5 },
      { column: 1, op: ">", value: 0 },
      { column: 1, op: "<", value: 4 },
    ],
  });
  expect(result.statement).toContain(
    "v0.val ≥ (-5 : Int) → v0.val ≤ (5 : Int) → v1.val > (0 : Int) → v1.val < (4 : Int)",
  );
});

test("invalid mappings, bounds, inputs, and names cannot emit coverage claims", () => {
  for (const outputToInput of [
    [0],
    [0, 1, 2],
    [-1, null, null],
    [0.5, null, null],
    [Number.NaN, null, null],
    new Array(3),
  ])
    expect(() => exportLeanCoverage(program, { ...claim, outputToInput })).toThrow();
  for (const bounds of [
    [{ column: 2, op: "<", value: 1 }],
    [{ column: 0.5, op: "<", value: 1 }],
    [{ column: 0, op: "<", value: 0.5 }],
    [{ column: 0, op: "<", value: Number.MAX_SAFE_INTEGER + 1 }],
    [{ column: 0, op: "<", value: Number.NaN }],
    [{ column: 0, op: "=", value: 1 }],
  ])
    expect(() => exportLeanCoverage(program, { ...claim, bounds } as CoverageClaim)).toThrow();
  for (const inputPredicate of ["q", "missing"])
    expect(() => exportLeanCoverage(program, { ...claim, inputPredicate })).toThrow();
  const unused = compile(
    "input predicate unused(n: integer). input predicate p(n: integer). q(X) :- p(X).",
  );
  expect(() =>
    exportLeanCoverage(unused, { ...claim, inputPredicate: "unused", outputToInput: [0] }),
  ).toThrow();
  for (const relationName of ["coverage", "input0", "v0", "w2", "Bad\nName"])
    expect(() => exportLeanCoverage(program, { ...claim, relationName })).toThrow();
  expect(() =>
    exportLeanCoverage(program, { ...claim, relationName: "coverage_refuted" }, "refute"),
  ).toThrow();
  expect(() => exportLeanCoverage(program, claim, "invalid" as "prove")).toThrow();
});

test("coverage rejects unsupported relation semantics", () => {
  for (const source of [
    "input predicate p(a: integer?). q(X, X, X) :- p(X).",
    "input predicate p(a: integer). q(X, X, X) :- p(X), X > 0.",
    "input predicate p(a: integer). q(X, X, X * 2) :- p(X).",
  ])
    expect(() => exportLeanCoverage(compile(source), claim)).toThrow();
});

test("coverage polarity and domain changes are bound to manifest identities", async () => {
  const refuted = exportLeanCoverage(program, claim, "refute");
  expect(refuted.nodes[1]!.kind).toBe("definition");
  expect(refuted.nodes[2]).toMatchObject({
    id: "coverage_refuted",
    kind: "goal",
    dependencies: ["coverage"],
  });
  expect(refuted.checker).toContain("theorem coverage_refuted : ¬ Generated.coverage");
  const context = {
    profile: "datamog-integer-v1",
    toolchain: "pinned",
    method: "lean-kernel-checked" as const,
    artifacts: {},
  };
  const digest = async (c: CoverageClaim) =>
    (await createVerificationManifest(exportLeanCoverage(program, c).nodes, context)).digest;
  const original = await digest(claim);
  for (const changed of [
    { ...claim, bounds: [] },
    { ...claim, bounds: [{ column: 0, op: "<=" as const, value: Number.MAX_SAFE_INTEGER }] },
    { ...claim, outputToInput: [1, null, null] },
  ])
    expect(await digest(changed)).not.toBe(original);
});
