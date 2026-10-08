import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import {
  assembleLeanClaims,
  exportLeanCoverage,
  exportLeanUniqueness,
} from "../src/obligation-lean.ts";
import { inferTypes } from "../src/types.ts";
import { createVerificationManifest } from "../src/verification-manifest.ts";

const compile = (source: string) => inferTypes(analyze(parse(source)));
const program = compile("input predicate item(n: integer). identity(X, X) :- item(X).");
const unique = {
  id: "unique",
  predicate: "identity",
  relationName: "Identity",
  keyColumns: [0],
  outputColumns: [1],
};
const coverage = {
  id: "coverage",
  predicate: "identity",
  relationName: "Identity",
  inputPredicate: "item",
  outputToInput: [0, null],
  bounds: [],
};
const bundles = () => [
  exportLeanUniqueness(program, unique),
  exportLeanCoverage(program, coverage),
];

test("assembly shares one relation across claim families and preserves both checkers", async () => {
  const batch = assembleLeanClaims(bundles());
  expect(batch.relations.match(/inductive Identity/g)).toHaveLength(1);
  expect(batch.nodes.map((node) => node.id)).toEqual(["Identity", "unique", "coverage"]);
  expect(batch.statements).toContain("def unique : Prop");
  expect(batch.statements).toContain("def coverage : Prop");
  expect(batch.checker).toContain("#audit unique");
  expect(batch.checker).toContain("#audit coverage");
  const context = {
    profile: "datamog-integer-v1",
    toolchain: "pinned",
    method: "lean-kernel-checked" as const,
    artifacts: {},
  };
  const manifest = await createVerificationManifest(batch.nodes, context);
  expect(manifest.entries.find((entry) => entry.id === "coverage")!.closure).toEqual([
    "Identity",
    "coverage",
  ]);
  const reversed = await createVerificationManifest(
    assembleLeanClaims(bundles().reverse()).nodes,
    context,
  );
  expect(reversed.digest).toBe(manifest.digest);
});

test("duplicate claims and collisions between relation, claim, and refutation IDs fail", () => {
  const [first, second] = bundles();
  expect(() => assembleLeanClaims([first!, first!])).toThrow("duplicate");
  expect(() =>
    assembleLeanClaims([first!, exportLeanCoverage(program, { ...coverage, id: "unique" })]),
  ).toThrow("unique");
  expect(() =>
    assembleLeanClaims([
      first!,
      exportLeanCoverage(program, { ...coverage, relationName: "unique" }),
    ]),
  ).toThrow("unique");
  expect(() =>
    assembleLeanClaims([
      exportLeanUniqueness(program, unique, "refute"),
      exportLeanCoverage(program, { ...coverage, id: "unique_refuted" }),
    ]),
  ).toThrow("unique_refuted");
  expect(() =>
    assembleLeanClaims([second!, exportLeanCoverage(program, coverage, "refute")]),
  ).toThrow("coverage");
  expect(() => assembleLeanClaims([])).toThrow("No Lean claims");
});

test("same relation name cannot hide changed definitions or source predicate identities", () => {
  const [first] = bundles();
  for (const [source, predicate, inputPredicate] of [
    ["input predicate item(n: integer). identity(X, X + 1) :- item(X).", "identity", "item"],
    ["input predicate other(n: integer). identity(X, X) :- other(X).", "identity", "other"],
    ["input predicate item(n: integer). renamed(X, X) :- item(X).", "renamed", "item"],
  ]) {
    const changed = exportLeanCoverage(compile(source!), {
      ...coverage,
      predicate: predicate!,
      inputPredicate: inputPredicate!,
    });
    expect(() => assembleLeanClaims([first!, changed])).toThrow("Identity");
  }
});

test("identical source text does not merge different input parameter wiring", () => {
  const left = compile(
    "input predicate p(n: integer). input predicate r(n: integer). q(X, Y) :- p(X), r(Y).",
  );
  const right = compile(
    "input predicate p(n: integer). input predicate r(n: integer). q(X, Y) :- r(X), p(Y).",
  );
  const a = exportLeanUniqueness(left, { ...unique, predicate: "q" });
  const b = exportLeanCoverage(right, { ...coverage, predicate: "q", inputPredicate: "p" });
  expect(a.relation).toBe(b.relation);
  expect(() => assembleLeanClaims([a, b])).toThrow("Identity");
});

test("assembly rejects differing assumptions, duplicate theorem names, and missing dependencies", () => {
  const [first, second] = bundles();
  const changed = structuredClone(second!);
  changed.nodes[0]!.assumptions = ["extra input law"];
  expect(() => assembleLeanClaims([first!, changed])).toThrow("Identity");
  const duplicate = structuredClone(second!);
  duplicate.nodes[1]!.theorem = first!.nodes[1]!.theorem;
  expect(() => assembleLeanClaims([first!, duplicate])).toThrow("checker theorem");
  const missing = structuredClone(second!);
  missing.nodes[1]!.dependencies = ["absent"];
  expect(() => assembleLeanClaims([first!, missing])).toThrow("dependency");
});
