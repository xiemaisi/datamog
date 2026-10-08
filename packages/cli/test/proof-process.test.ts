import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProofProcess } from "../src/proof-process.ts";

const command = (source: string) => ["bun", "-e", source];
test("proof subprocess keeps separate streams and checks exit status", async () => {
  const result = await runProofProcess(
    command('console.log("ok"); console.error("diagnostic")'),
    process.cwd(),
  );
  expect(result).toEqual({ stdout: "ok\n", stderr: "diagnostic\n" });
  await expect(
    runProofProcess(command('console.log("claimed success"); process.exit(2)'), process.cwd()),
  ).rejects.toThrow("exited 2");
  await expect(runProofProcess(["/no/such/verification-tool"], process.cwd())).rejects.toThrow();
});
test("proof subprocess bounds both output streams and CPU-bound work", async () => {
  for (const stream of ["stdout", "stderr"])
    await expect(
      runProofProcess(
        command(`process.${stream}.write("x".repeat(10000)); while(true){}`),
        process.cwd(),
        { maxOutputBytes: 100, timeoutMs: 2000 },
      ),
    ).rejects.toThrow("output limit");
  await expect(
    runProofProcess(command("while(true){}"), process.cwd(), { timeoutMs: 100 }),
  ).rejects.toThrow("timeout");
});
test("proof subprocess cancellation works before and during execution", async () => {
  const controller = new AbortController();
  const pending = runProofProcess(command("while(true){}"), process.cwd(), {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  await expect(
    runProofProcess(command("process.exit(0)"), process.cwd(), { signal: controller.signal }),
  ).rejects.toThrow();
});
test.skipIf(process.platform === "win32")(
  "proof subprocess removes lingering descendants after parent exit",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "proof-process-"));
    try {
      const marker = join(dir, "survived");
      const descendant = `setTimeout(() => Bun.write(${JSON.stringify(marker)}, "bad"), 300);`;
      const parent = `Bun.spawn(["bun", "-e", ${JSON.stringify(descendant)}], {stdout:"inherit",stderr:"inherit"}); process.exit(0);`;
      await runProofProcess(command(parent), dir, { timeoutMs: 2000 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "timeout and cancellation remove descendants",
  async () => {
    for (const reason of ["timeout", "cancelled"]) {
      const dir = await mkdtemp(join(tmpdir(), "proof-process-stop-"));
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const marker = join(dir, "survived");
        const descendant = `setTimeout(() => Bun.write(${JSON.stringify(marker)}, "bad"), 300);`;
        const parent = `Bun.spawn(["bun", "-e", ${JSON.stringify(descendant)}], {stdout:"inherit",stderr:"inherit"}); setInterval(()=>{}, 1000);`;
        if (reason === "cancelled") timer = setTimeout(() => controller.abort(), 100);
        await expect(
          runProofProcess(command(parent), dir, {
            signal: controller.signal,
            timeoutMs: reason === "timeout" ? 100 : 2000,
          }),
        ).rejects.toThrow(reason);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(await Bun.file(marker).exists()).toBe(false);
      } finally {
        clearTimeout(timer);
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
);
