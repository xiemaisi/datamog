import { expect, test } from "bun:test";
import {
  type VerificationContext,
  type VerificationNode,
  assertCurrentVerificationManifest,
  canonicalVerificationJson,
  createVerificationManifest,
} from "../src/verification-manifest.ts";

const context: VerificationContext = {
  profile: "datamog-integer-v1",
  toolchain: "leanprover/lean4:v4.34.0",
  method: "lean-kernel-checked",
  artifacts: { semantics: "hash1", policy: "hash2" },
};
const nodes: VerificationNode[] = [
  {
    id: "consumer",
    kind: "goal",
    statement: { conclusion: "safe" },
    assumptions: ["input law"],
    dependencies: ["producer"],
  },
  {
    id: "producer",
    kind: "definition",
    statement: { body: "original" },
    assumptions: [],
    dependencies: [],
  },
];

test("manifest identity is deterministic across object and node order", async () => {
  expect(await createVerificationManifest(nodes, context)).toEqual(
    await createVerificationManifest([...nodes].reverse(), {
      ...context,
      artifacts: { policy: "hash2", semantics: "hash1" },
    }),
  );
  expect(canonicalVerificationJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
});

test("changed imported definitions invalidate an unchanged consumer", async () => {
  const before = await createVerificationManifest(nodes, context);
  const after = await createVerificationManifest(
    [nodes[0]!, { ...nodes[1]!, statement: { body: "changed" } }],
    context,
  );
  expect(after.entries[0]!.digest).not.toBe(before.entries[0]!.digest);
});

test("changed goals, assumptions, toolchain, semantics and policy invalidate results", async () => {
  const before = await createVerificationManifest(nodes, context);
  for (const changed of [
    { ...nodes[0]!, statement: { conclusion: "different" } },
    { ...nodes[0]!, assumptions: ["different law"] },
  ])
    expect((await createVerificationManifest([changed, nodes[1]!], context)).digest).not.toBe(
      before.digest,
    );
  for (const change of [
    { ...context, toolchain: "different" },
    { ...context, profile: "different" },
    { ...context, artifacts: { ...context.artifacts, semantics: "changed" } },
    { ...context, artifacts: { ...context.artifacts, policy: "changed" } },
  ])
    expect((await createVerificationManifest(nodes, change)).entries[0]!.digest).not.toBe(
      before.entries[0]!.digest,
    );
});

test("cyclic closures are complete and deterministic", async () => {
  const cycle = [nodes[0]!, { ...nodes[1]!, dependencies: ["consumer"] }];
  const result = await createVerificationManifest(cycle, context);
  expect(result.entries.every((entry) => entry.closure.join() === "consumer,producer")).toBe(true);
  expect(result.entries[0]!.digest).not.toBe(result.entries[1]!.digest);
  expect(result).toEqual(await createVerificationManifest([...cycle].reverse(), context));
});

test("missing and duplicate identities fail rather than describing an incomplete proof", async () => {
  await expect(createVerificationManifest([nodes[0]!], context)).rejects.toThrow(
    "Missing verification dependency",
  );
  await expect(createVerificationManifest([nodes[0]!, nodes[0]!], context)).rejects.toThrow(
    "Duplicate",
  );
  expect(() => canonicalVerificationJson({ value: Number.NaN })).toThrow();
  expect(() => canonicalVerificationJson(new Map())).toThrow();
});

test("a copied digest cannot authenticate altered or stale manifest content", async () => {
  const current = await createVerificationManifest(nodes, context);
  assertCurrentVerificationManifest(current, JSON.parse(JSON.stringify(current)));
  const forged = JSON.parse(JSON.stringify(current));
  forged.entries[0].statement = { conclusion: "weaker claim" };
  expect(() => assertCurrentVerificationManifest(current, forged)).toThrow("mismatched");
  const stale = await createVerificationManifest(nodes, { ...context, toolchain: "old" });
  expect(() => assertCurrentVerificationManifest(current, stale)).toThrow("Stale");
});
