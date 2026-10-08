import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { type UniquenessClaim, exportLeanUniqueness } from "../src/obligation-lean.ts";
import { inferTypes } from "../src/types.ts";
import { createVerificationManifest } from "../src/verification-manifest.ts";

const compile = (source: string) => inferTypes(analyze(parse(source)));
const program = compile(
  "input predicate p(a: integer, b: integer, c: integer). q(X, Y, Z) :- p(X, Y, Z).",
);
const claim: UniquenessClaim = {
  id: "unique",
  predicate: "q",
  relationName: "Q",
  keyColumns: [0],
  outputColumns: [1],
};

test("unselected columns vary independently in two tuples", () => {
  const result = exportLeanUniqueness(program, claim);
  expect(result.statement).toContain("Q input0 v0 v1 v2 → Q input0 v0 w1 w2 → v1 = w1");
  expect(result.statement).toContain("(w2 : Datamog.SafeInt)");
  expect(result.checker).toContain("theorem unique : Generated.unique := Proofs.unique");
  expect(result.nodes[1]).toMatchObject({ kind: "goal", dependencies: ["Q"] });
});

test("multiple outputs and empty keys are explicit", () => {
  const many = exportLeanUniqueness(program, { ...claim, outputColumns: [2, 1] });
  expect(many.statement).toContain("v1 = w1 ∧ v2 = w2");
  expect(many).toEqual(exportLeanUniqueness(program, { ...claim, outputColumns: [1, 2] }));
  const global = exportLeanUniqueness(program, { ...claim, keyColumns: [] });
  expect(global.statement).toContain("Q input0 w0 w1 w2");
});

test("all relation parameters retain exporter order and types", () => {
  const multi = compile(
    "input predicate p(a: integer). input predicate r(b: integer). q(X, Y) :- r(Y), p(X).",
  );
  const result = exportLeanUniqueness(multi, claim);
  expect(result.statement).toContain(
    "(input0 : Datamog.SafeInt → Prop) (input1 : Datamog.SafeInt → Prop)",
  );
  expect(result.relation).toContain("(input0 v1) → (input1 v0)");
  expect(result.statement).toContain("Q input0 input1 v0 v1 → Q input0 input1 v0 w1");
});

test("invalid columns and conflicting names fail before emitting claims", () => {
  for (const keyColumns of [[-1], [3], [0.5], [Number.NaN], [0, 0]])
    expect(() => exportLeanUniqueness(program, { ...claim, keyColumns })).toThrow();
  for (const outputColumns of [[], [0], [1, 1], [3], [Number.POSITIVE_INFINITY]])
    expect(() => exportLeanUniqueness(program, { ...claim, outputColumns })).toThrow();
  for (const relationName of ["unique", "input0", "v0", "w2", "Q\naxiom bad : False"])
    expect(() => exportLeanUniqueness(program, { ...claim, relationName })).toThrow();
  expect(() => exportLeanUniqueness(program, { ...claim, predicate: "missing" })).toThrow();
  expect(() =>
    exportLeanUniqueness(program, { ...claim, relationName: "unique_refuted" }, "refute"),
  ).toThrow();
});

test("unsupported relation semantics cannot yield uniqueness claims", () => {
  for (const source of [
    "input predicate p(a: integer?). q(X, X) :- p(X).",
    "input predicate p(a: integer). q(X, X) :- p(X), X + 1 > 0.",
    "input predicate p(a: integer). q(X, X * 2) :- p(X).",
  ])
    expect(() => exportLeanUniqueness(compile(source), claim)).toThrow();
});

test("refutations register a different goal and selected columns change content identities", async () => {
  const refuted = exportLeanUniqueness(program, claim, "refute");
  expect(refuted.nodes[1]!.kind).toBe("definition");
  expect(refuted.nodes[2]).toMatchObject({
    id: "unique_refuted",
    kind: "goal",
    dependencies: ["unique"],
  });
  expect(refuted.checker).toContain("theorem unique_refuted : ¬ Generated.unique");
  const context = {
    profile: "datamog-integer-v1",
    toolchain: "pinned",
    method: "lean-kernel-checked" as const,
    artifacts: {},
  };
  const original = await createVerificationManifest(
    exportLeanUniqueness(program, claim).nodes,
    context,
  );
  for (const changed of [
    { ...claim, keyColumns: [2] },
    { ...claim, outputColumns: [2] },
  ]) {
    const updated = await createVerificationManifest(
      exportLeanUniqueness(program, changed).nodes,
      context,
    );
    expect(updated.entries.find((entry) => entry.id === "unique")!.digest).not.toBe(
      original.entries.find((entry) => entry.id === "unique")!.digest,
    );
  }
});
