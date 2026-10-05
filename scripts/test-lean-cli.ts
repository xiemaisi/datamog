/** Optional compiled-CLI acceptance test; requires the pinned Lean toolchain. */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProofProcess } from "../packages/cli/src/proof-process.ts";

const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "dist/datamog");
const temp = await mkdtemp(join(tmpdir(), "datamog-lean-cli-"));
try {
  const input = join(temp, "input");
  await cp(join(root, "verification/lean/examples/selected-input-run"), input, { recursive: true });
  const config = join(input, "plan.json");
  const output = join(temp, "project");
  const reportPath = join(output, "verification-result.json");
  const run = (args: string[]) =>
    runProofProcess([cli, "proof", ...args], temp, {
      timeoutMs: 180_000,
      maxOutputBytes: 8_388_608,
      shutdownGraceMs: 2000,
    });
  const inspected = await run(["inspect", config, output]);
  if (!JSON.parse(inspected.stdout).goals.length || (await Bun.file(reportPath).exists()))
    throw new Error("Inspection wrote evidence or lost goals");
  await run(["export", config, output]);
  await cp(join(input, "Proofs.lean"), join(output, "Datamog/Proofs.lean"));
  await run(["export", config, output]);
  const check = [
    "check",
    config,
    output,
    "--allow-conditional",
    "--run-native",
    "--input-file",
    `item=${join(input, "item.csv")}`,
  ];
  await run(check);
  const report = await Bun.file(reportPath).json();
  if (
    report.entries.find((entry: { id: string }) => entry.id === "positive")?.status !==
      "conditional" ||
    report.dataset.inputs[0].rows !== 2 ||
    report.execution.assurance !== "runtime-executed" ||
    JSON.stringify(report.execution.results[0].rows) !== JSON.stringify([{ X: 1 }, { X: 2 }])
  )
    throw new Error("CLI lost proof, dataset, or execution scope");
  const reject = async (expected: string, args = check) => {
    await Bun.write(reportPath, "old success");
    let failed = false;
    try {
      await run(args);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(expected)) throw error;
      failed = true;
    }
    if (!failed || (await Bun.file(reportPath).exists()))
      throw new Error(`CLI failure retained evidence: ${expected}`);
  };
  await reject("remains conditional", [...check, "--require-goal", "positive"]);
  await Bun.write(join(input, "item.csv"), "n\n0\n");
  await reject("positiveItems fails");
  await Bun.write(join(input, "item.csv"), "n\n1\n2\n");
  const source = await Bun.file(join(input, "program.dl")).text();
  await Bun.write(join(input, "program.dl"), `${source}\n!- item(X), X = 1.\n`);
  await run(["export", config, output]);
  await reject("is violated");
  await Bun.write(join(input, "program.dl"), source);
  await reject("Stale or altered");
  console.log(
    "Compiled CLI: inspection, export, maintained proof, checked execution, and failure report cleanup passed.",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
