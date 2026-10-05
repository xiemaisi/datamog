import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../src/main.ts");
const fixture = join(
  import.meta.dir,
  "../../../verification/lean/examples/selected-input-laws/plan.json",
);
async function cli(args: string[]) {
  const child = Bun.spawn(["bun", "run", entry, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("proof subcommand inspects and exports an exact selected project without Lean", async () => {
  const dir = await mkdtemp(join(tmpdir(), "datamog-cli-proof-"));
  try {
    const inspected = await cli(["proof", "inspect", fixture, dir]);
    expect(inspected.exitCode).toBe(0);
    const preview = JSON.parse(inspected.stdout);
    expect(preview.goals.find((g: { id: string }) => g.id === "positive").assumptions).toHaveLength(
      1,
    );
    expect(await Bun.file(join(dir, "manifest.json")).exists()).toBe(false);
    const exported = await cli(["proof", "export", fixture, dir]);
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain("Exported 2 goals");
    expect(await Bun.file(join(dir, "manifest.json")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "Datamog/Proofs.lean")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proof subcommand validates commands and keeps SMT verification separate", async () => {
  for (const args of [
    ["proof"],
    ["proof", "inspect"],
    ["proof", "inspect", fixture, "out", "--allow-conditional"],
    ["proof", "inspect", fixture, "out", "--input-file", "item=rows.csv"],
    ["proof", "export", fixture, "out", "--input-file", "item=rows.csv"],
    ["proof", "check", fixture, "out", "--input-file", "item="],
    ["proof", "check", fixture, "out", "--input-file"],
    ["proof", "check", fixture, "out", "--require-goal"],
    ["proof", "check", fixture, "out", "--unknown"],
  ]) {
    const result = await cli(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Usage: datamog proof");
  }
  const help = await cli(["proof", "--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("--allow-conditional");
  const general = await cli(["--help"]);
  expect(general.exitCode).toBe(0);
  expect(general.stderr).toContain("--verify");
  expect(general.stderr).toContain("datamog proof");
});
