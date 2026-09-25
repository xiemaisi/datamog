import { expect, test } from "bun:test";
import { type VerificationNode, createVerificationManifest } from "../src/verification-manifest.ts";
import { createLeanVerificationResult } from "../src/verification-result.ts";

const nodes: VerificationNode[] = [
  {
    id: "safe",
    kind: "goal",
    theorem: "Checked.safe",
    statement: "safe",
    assumptions: [],
    dependencies: [],
  },
  {
    id: "reach",
    kind: "goal",
    theorem: "Checked.reach",
    statement: "reach",
    assumptions: [],
    dependencies: ["edge"],
  },
  {
    id: "edge",
    kind: "definition",
    statement: "edge",
    assumptions: ["edge preserves P"],
    dependencies: [],
  },
];
const manifest = () =>
  createVerificationManifest(nodes, {
    profile: "datamog-integer-v1",
    toolchain: "lean4:v4.34.0",
    method: "lean-kernel-checked",
    artifacts: {},
  });
const audit = (theorem: string, axioms: string[] = []) =>
  `info: Checked.lean:1:0: DATAMOG_AUDIT ${JSON.stringify({ theorem, axioms })}\n`;
const output = audit("Checked.safe", ["propext"]) + audit("Checked.reach");

test("fresh reports bind exact goals to content and preserve inherited premises", async () => {
  const plan = await manifest();
  const report = createLeanVerificationResult(plan, output);
  expect(report.manifestDigest).toBe(plan.digest);
  expect(report.entries.find((entry) => entry.id === "reach")).toMatchObject({
    status: "conditional",
    assumptions: ["edge preserves P"],
    assurance: "lean-kernel-checked",
    axioms: [],
  });
  expect(report.entries.find((entry) => entry.id === "safe")).toMatchObject({
    status: "proved",
    assumptions: [],
    axioms: ["propext"],
    digest: plan.entries.find((entry) => entry.id === "safe")!.digest,
  });
});

test("incomplete, duplicate, unexpected and malformed audit records fail closed", async () => {
  const plan = await manifest();
  for (const invalid of [
    "",
    audit("Checked.safe"),
    output + audit("Checked.safe"),
    output + audit("Other"),
    'DATAMOG_AUDIT {"theorem":"Checked.safe","axioms":[1]}',
    "DATAMOG_AUDIT not-json",
    "DATAMOG_AUDIT null",
    "Audited Checked.safe: []\nAudited Checked.reach: []",
  ]) {
    expect(() => createLeanVerificationResult(plan, invalid)).toThrow();
  }
});

test("empty or ambiguous theorem registries cannot report success", async () => {
  const plan = await manifest();
  expect(() => createLeanVerificationResult({ ...plan, entries: [] }, "")).toThrow();
  for (const theorem of [undefined, "Checked.safe"]) {
    const entries = plan.entries.map((entry) =>
      entry.id === "reach" ? { ...entry, theorem } : entry,
    );
    expect(() => createLeanVerificationResult({ ...plan, entries }, output)).toThrow();
  }
});

test("required goals accept only registered unconditional fresh proofs", async () => {
  const plan = await manifest();
  expect(createLeanVerificationResult(plan, output, ["safe", "safe"]).requiredGoals).toEqual([
    "safe",
  ]);
  for (const ids of [[], ["typo"], ["edge"], ["safe", "typo"]])
    expect(() => createLeanVerificationResult(plan, output, ids)).toThrow();
  expect(() => createLeanVerificationResult(plan, output, ["safe", "reach"])).toThrow(
    "edge preserves P",
  );
  // Selecting a goal does not permit missing audits elsewhere in the plan.
  expect(() => createLeanVerificationResult(plan, audit("Checked.safe"), ["safe"])).toThrow(
    "Missing axiom audit",
  );
});
