import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertInputDataUnchanged,
  prepareInputData,
  validateInputData,
} from "../../../scripts/lean-input-data.ts";
import { executeInputSnapshot } from "../../../scripts/lean-input-run.ts";
import { planProject } from "../../../scripts/lean-project.ts";
import { runProofProcess } from "../../cli/src/proof-process.ts";
import { DatamogExecutor } from "../../engine/src/index.ts";

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

test("native execution uses checked rows even if the file later changes", async () => {
  await withInputFile(async (file, dir) => {
    const source =
      "input predicate item(n: integer). output predicate output(X, _: X > 0) :- item(X).";
    const config = join(dir, "plan.json");
    await Bun.write(join(dir, "program.dl"), source);
    await Bun.write(
      config,
      JSON.stringify({
        source: "program.dl",
        claims: [
          {
            kind: "program-invariant",
            id: "positive",
            predicates: ["output"],
            inputLaws: [{ id: "positiveItems", predicate: "item", column: 0, op: ">", value: 0 }],
          },
        ],
      }),
    );
    const plan = await planProject(config, join(dir, "project"));
    await Bun.write(file, "n\n1\n2\n");
    const input = await prepareInputData(
      plan.manifest,
      plan.inputDeclarations,
      [{ predicate: "item", file }],
      true,
    );
    await Bun.write(file, "n\n0\n");
    const execution = await executeInputSnapshot(plan.typed, input.rows);
    expect(execution.status).toBe("completed");
    expect(execution.results[0]!.rows.map((row) => Object.values(row))).toEqual([[1], [2]]);
    await expect(assertInputDataUnchanged(input.evidence.inputs)).rejects.toThrow("changed");
  });
});

test("native snapshot execution preserves runtime checks and rejects incomplete evaluation", async () => {
  const rows = new Map([["item", [{ n: 0 }]]]);
  const checked = DatamogExecutor.prepare(
    "input predicate item(n: integer). output(X, _: X > 0) :- item(X).",
  );
  await expect(executeInputSnapshot(checked, rows)).rejects.toThrow();
  const recursive = DatamogExecutor.prepare(
    "input predicate item(n: integer). grow(X) :- item(X). grow(X + 1) :- grow(X).",
  );
  await expect(executeInputSnapshot(recursive, rows)).rejects.toThrow(
    "did not reach a fixed point",
  );
  await expect(executeInputSnapshot(checked, new Map())).rejects.toThrow("Missing execution input");
});

test("execution requires files for inputs without laws as well", async () => {
  await withInputFile(async (file, dir) => {
    const config = join(dir, "plan.json");
    await Bun.write(
      join(dir, "program.dl"),
      "input predicate item(n: integer). input predicate other(n: integer). output(X, _: X > 0) :- item(X).",
    );
    await Bun.write(
      config,
      JSON.stringify({
        source: "program.dl",
        claims: [
          {
            kind: "program-invariant",
            id: "positive",
            predicates: ["output"],
            inputLaws: [{ id: "p", predicate: "item", column: 0, op: ">", value: 0 }],
          },
        ],
      }),
    );
    const plan = await planProject(config, join(dir, "project"));
    await Bun.write(file, "n\n1\n");
    const bindings = [{ predicate: "item", file }];
    await expect(
      prepareInputData(plan.manifest, plan.inputDeclarations, bindings, true),
    ).rejects.toThrow("other");
    const input = await prepareInputData(
      plan.manifest,
      plan.inputDeclarations,
      [...bindings, { predicate: "other", file }],
      true,
    );
    expect(input.evidence.inputs).toHaveLength(2);
  });
});

test("isolated execution resolves modules entirely from the checked source snapshot", async () => {
  await withInputFile(async (file, dir) => {
    const sourceDir = join(dir, "source");
    await cp("verification/lean/examples/selected-input-law-checks", sourceDir, {
      recursive: true,
    });
    const plan = await planProject(join(sourceDir, "plan.json"), join(dir, "project"));
    await Bun.write(file, "n\n1\n");
    const input = await prepareInputData(
      plan.manifest,
      plan.inputDeclarations,
      [{ predicate: "seed", file }],
      true,
    );
    const request = join(dir, "request.json");
    await Bun.write(
      request,
      JSON.stringify({ snapshot: plan.executionSnapshot, rows: [...input.rows] }),
    );
    await rm(sourceDir, { recursive: true });
    const response = await runProofProcess(["bun", worker, request], dir);
    expect(JSON.parse(response.stdout).result.status).toBe("completed");
  });
});

test("isolated native execution has a deadline even within one expensive iteration", async () => {
  await withInputFile(async (_file, dir) => {
    const request = join(dir, "request.json");
    await Bun.write(
      request,
      JSON.stringify({
        snapshot: {
          source:
            "input predicate item(n: integer). output predicate pairs(X,Y) :- item(X), item(Y).",
          file: join(dir, "source.dl"),
        },
        rows: [["item", Array.from({ length: 10000 }, (_, n) => ({ n }))]],
      }),
    );
    await expect(
      runProofProcess(["bun", worker, request], dir, { timeoutMs: 300 }),
    ).rejects.toThrow("timeout");
  });
});

const worker = new URL("../../../scripts/lean-input-worker.ts", import.meta.url).pathname;
