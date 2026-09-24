// Discharge refinement obligations with an SMT solver.
//
// Phase 4 of doc/design/refinement-annotations.md. The obligations are
// SMT-LIB 2 text (see core's `obligations.ts`), so this shells out to a solver
// named on the command line rather than linking one in: no dependency, and
// swapping z3 for cvc5 is `--solver`.

import type { Obligation } from "datamog-core";

/** Overridable with `--solver` so no particular solver is baked in. */
export const DEFAULT_SOLVER = "z3 -in";

export interface Verdict {
  obligation: Obligation;
  /** `discharged` is unsat: no tuple satisfies the body and breaks the claim. */
  status: "discharged" | "counterexample" | "unknown" | "skipped" | "error" | "timeout";
  /** The solver's own words, on anything other than a clean discharge. */
  detail?: string;
}

export interface SolverOptions {
  /** Per invocation, including a separate countermodel request. */
  timeoutMs?: number;
  /** Combined stdout/stderr byte limit per invocation. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

interface SolverResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failure?: "timeout" | "output limit exceeded" | "cancelled";
}

async function runSolver(
  command: string[],
  script: string,
  options: SolverOptions,
): Promise<SolverResult> {
  const child = Bun.spawn(command, {
    stdin: new TextEncoder().encode(script),
    stdout: "pipe",
    stderr: "pipe",
  });
  let failure: SolverResult["failure"];
  const stop = (reason: NonNullable<SolverResult["failure"]>) => {
    failure ??= reason;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 30_000);
  const abort = () => stop("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let bytes = 0;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > (options.maxOutputBytes ?? 1_048_576)) {
        stop("output limit exceeded");
        break;
      }
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  };
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      read(child.stdout),
      read(child.stderr),
      child.exited,
    ]);
    return { stdout, stderr, exitCode, failure };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    child.kill("SIGKILL");
    await child.exited;
  }
}

function solverError(result: SolverResult): string | undefined {
  if (result.failure) return result.failure;
  if (result.exitCode !== 0)
    return `solver exited with code ${result.exitCode}: ${result.stderr.trim()}`;
  if (/^\s*\(error\b/m.test(result.stdout) || result.stderr.trim()) {
    return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  }
  return undefined;
}

/**
 * Run each obligation as its own script. One solver call per obligation rather
 * than one for the file: a block that errors would otherwise shift every later
 * verdict onto the wrong claim, and there is no ordering to rely on once a
 * solver decides to say something extra.
 */
export async function verifyObligations(
  obligations: Obligation[],
  solver: string | readonly string[] = DEFAULT_SOLVER,
  options: SolverOptions = {},
): Promise<Verdict[]> {
  const command = typeof solver === "string" ? solver.trim().split(/\s+/) : [...solver];
  for (const value of [options.timeoutMs, options.maxOutputBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("Solver limits must be positive safe integers");
    }
  }
  const verdicts: Verdict[] = [];
  for (const obligation of obligations) {
    if (obligation.logic === null) {
      const note = obligation.script
        .split("\n")
        .at(-1)
        ?.replace(/^; not emitted, /, "");
      verdicts.push({ obligation, status: "skipped", detail: note });
      continue;
    }
    if (options.signal?.aborted) {
      verdicts.push({ obligation, status: "error", detail: "cancelled" });
      continue;
    }
    const script = `(set-logic ${obligation.logic})\n${obligation.script}`;
    const invoke = (text: string) =>
      runSolver(command, text, options).catch((e: Error) => {
        throw new Error(
          `could not run \`${command.join(" ")}\`: ${e.message}. Pass --solver with an SMT-LIB 2 solver that reads a script on stdin.`,
        );
      });
    const result = await invoke(script);
    const error = solverError(result);
    if (error) {
      verdicts.push({
        obligation,
        status: result.failure === "timeout" ? "timeout" : "error",
        detail: error,
      });
      continue;
    }
    const answer = result.stdout.trim();
    if (answer === "unsat") verdicts.push({ obligation, status: "discharged" });
    else if (answer === "sat") {
      // Re-run only satisfiable goals with a model request. Never accept an
      // error after unsat as an expected side effect of asking for a model.
      let detail: string | undefined;
      if (obligation.declared.length > 0) {
        const model = await invoke(
          `(set-option :produce-models true)\n${script.replace(
            "(pop 1)",
            `(get-value (${obligation.declared.join(" ")}))\n(pop 1)`,
          )}`,
        );
        const modelError = solverError(model);
        detail = modelError
          ? `Countermodel unavailable: ${modelError}`
          : /^sat\s*\(/.test(model.stdout.trim())
            ? model.stdout.trim().slice(3).trim()
            : "Countermodel unavailable: inconsistent solver response";
      }
      verdicts.push({ obligation, status: "counterexample", detail });
    } else if (answer === "unknown") verdicts.push({ obligation, status: "unknown" });
    else
      verdicts.push({
        obligation,
        status: "error",
        detail: `Unexpected solver response: ${answer}`,
      });
  }
  return verdicts;
}

/** Report the verdicts, returning true if every obligation was discharged. */
export function reportVerdicts(verdicts: Verdict[]): boolean {
  if (verdicts.length === 0) {
    console.log("No refinement contracts to discharge.");
    return true;
  }
  const mark = {
    discharged: "proved  ",
    counterexample: "FAILED  ",
    unknown: "unknown ",
    skipped: "skipped ",
    error: "ERROR   ",
    timeout: "timeout ",
  };
  for (const { obligation, status, detail } of verdicts) {
    const { predicate, rule, claim } = obligation;
    console.log(`${mark[status]} ${predicate} rule ${rule}: ${claim}`);
    if (detail) console.log(`         ${detail}`);
  }
  const proved = verdicts.filter((v) => v.status === "discharged").length;
  console.log(`\n${proved}/${verdicts.length} discharged.`);
  return proved === verdicts.length;
}
