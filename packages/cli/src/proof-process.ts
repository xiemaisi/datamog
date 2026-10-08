/** Resource bounds for optional verification subprocesses. */
import { spawn } from "node:child_process";

export interface ProofProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Allow an orchestrator to cancel its own process groups before killing it. */
  shutdownGraceMs?: number;
}

export async function runProofProcess(
  command: string[],
  cwd: string,
  options: ProofProcessOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  const grace = options.shutdownGraceMs ?? 0;
  for (const [name, value] of Object.entries({ timeoutMs, maxOutputBytes, grace }))
    if (!Number.isSafeInteger(value) || value < (name === "grace" ? 0 : 1))
      throw new Error(`Invalid proof process limit: ${name}`);
  options.signal?.throwIfAborted();
  const env = { ...process.env };
  env.LEAN_PATH = undefined;
  env.LEAN_SRC_PATH = undefined;
  const grouped = process.platform !== "win32";
  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    env,
    detached: grouped,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failure: Error | undefined;
  let bytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
    }
  };
  const stop = (reason: string) => {
    if (failure) return;
    failure = new Error(reason);
    if (grace) {
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), grace);
    } else kill("SIGKILL");
  };
  const timer = setTimeout(
    () => stop(`Verification process timeout after ${timeoutMs} ms`),
    timeoutMs,
  );
  const abort = () => stop("Verification process cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const read = (chunks: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxOutputBytes)
      stop(`Verification process output limit exceeded (${maxOutputBytes} bytes)`);
    if (!failure) chunks.push(chunk);
  };
  child.stdout.on("data", read(stdout));
  child.stderr.on("data", read(stderr));
  // Reap the direct child; kill remaining group members even when it exits cleanly.
  child.once("exit", () => kill("SIGKILL"));
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        failure ??= error;
      });
      child.once("close", resolve);
    });
    if (failure) throw failure;
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    if (code !== 0) throw new Error(`${command[0]} exited ${code}\n${out}${err}`);
    return { stdout: out, stderr: err };
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    options.signal?.removeEventListener("abort", abort);
    kill("SIGKILL");
  }
}
