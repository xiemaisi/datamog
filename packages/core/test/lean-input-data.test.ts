import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInputDataUnchanged, validateInputData } from "../../../scripts/lean-input-data.ts";
import { planProject } from "../../../scripts/lean-project.ts";

async function withInputFile(run: (file: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "datamog-input-law-data-"));
  try {
    await run(join(dir, "item.csv"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("bound input laws check typed CSV rows and retain universal assumptions", async () => {
  const config = "verification/lean/examples/selected-input-laws/plan.json";
  await withInputFile(async (file, dir) => {
    const plan = await planProject(config, join(dir, "project"));
    const binding = [{ predicate: "item", file }];
    await Bun.write(file, "n\n1\n9007199254740991\n");
    const evidence = await validateInputData(plan.manifest, plan.inputDeclarations, binding);
    expect(evidence.manifestDigest).toBe(plan.manifest.digest);
    expect(evidence.inputs[0]).toMatchObject({ predicate: "item", rows: 2 });
    expect(evidence.goals).toEqual([
      {
        id: "positive",
        laws: [{ id: "positiveItems", formula: expect.any(String) }],
        status: "premises-satisfied-for-supplied-inputs",
      },
    ]);
    expect(plan.manifest.entries.find((entry) => entry.id === "positive")!.closure).toContain(
      "positiveInputLaw0",
    );
    await assertInputDataUnchanged(evidence.inputs);
    await Bun.write(file, "n\n0\n");
    await expect(assertInputDataUnchanged(evidence.inputs)).rejects.toThrow("changed");
    await expect(validateInputData(plan.manifest, plan.inputDeclarations, binding)).rejects.toThrow(
      "positiveItems fails",
    );
    await Bun.write(file, "n\n9007199254740992\n");
    await expect(
      validateInputData(plan.manifest, plan.inputDeclarations, binding),
    ).rejects.toThrow();
    await Bun.write(file, "n\n1\n");
    await expect(validateInputData(plan.manifest, plan.inputDeclarations, [])).rejects.toThrow(
      "Missing input file",
    );
    await expect(
      validateInputData(plan.manifest, plan.inputDeclarations, [...binding, ...binding]),
    ).rejects.toThrow("Duplicate");
    await expect(
      validateInputData(plan.manifest, plan.inputDeclarations, [{ predicate: "other", file }]),
    ).rejects.toThrow("unneeded");
  });
});

test("functional dependency checks all rows sharing a key and ignores unrelated columns", async () => {
  const config = "verification/lean/examples/selected-functional-dependency/plan.json";
  await withInputFile(async (file, dir) => {
    const plan = await planProject(config, join(dir, "project"));
    const binding = [{ predicate: "item", file }];
    await Bun.write(file, "k,v,tag\n1,2,3\n1,2,4\n2,5,6\n");
    const evidence = await validateInputData(plan.manifest, plan.inputDeclarations, binding);
    expect(evidence.goals.map((goal) => goal.id)).toEqual(["unique"]);
    expect(evidence.inputs[0]!.rows).toBe(3);
    await Bun.write(file, "k,v,tag\n1,2,3\n1,9,4\n");
    await expect(validateInputData(plan.manifest, plan.inputDeclarations, binding)).rejects.toThrow(
      "inputKey fails for item rows 1 and 2",
    );
  });
});

test("dataset laws use the entry input after module wiring", async () => {
  const config = "verification/lean/examples/selected-input-law-checks/plan.json";
  await withInputFile(async (file, dir) => {
    const plan = await planProject(config, join(dir, "project"));
    await Bun.write(file, "n\n1\n");
    const evidence = await validateInputData(plan.manifest, plan.inputDeclarations, [
      { predicate: "seed", file },
    ]);
    expect(evidence.goals.map((goal) => goal.id).sort()).toEqual(["check", "empty", "noBad"]);
    expect(evidence.inputs[0]!.predicate).toBe("seed");
    await expect(
      validateInputData(plan.manifest, plan.inputDeclarations, [{ predicate: "item", file }]),
    ).rejects.toThrow("unneeded");
  });
});
