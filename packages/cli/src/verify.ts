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
  status: "discharged" | "counterexample" | "unknown" | "skipped" | "error";
  /** The solver's own words, on anything other than a clean discharge. */
  detail?: string;
}

async function runSolver(command: string[], script: string): Promise<string> {
  const child = Bun.spawn(command, {
    stdin: new TextEncoder().encode(script),
    stdout: "pipe",
    stderr: "pipe",
  });
  // A solver reports a malformed script on stderr and its verdict on stdout,
  // and both are wanted. Read them together so neither pipe can fill while the
  // other is being drained.
  const [out, err] = await Promise.allSettled([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return [out, err].map((r) => (r.status === "fulfilled" ? r.value : "")).join("");
}

/**
 * Run each obligation as its own script. One solver call per obligation rather
 * than one for the file: a block that errors would otherwise shift every later
 * verdict onto the wrong claim, and there is no ordering to rely on once a
 * solver decides to say something extra.
 */
export async function verifyObligations(
  obligations: Obligation[],
  solver = DEFAULT_SOLVER,
): Promise<Verdict[]> {
  const command = solver.split(/\s+/);
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
    // `get-value` names what falsified the claim. It is only meaningful after
    // `sat`; after `unsat` the solver says so and the line is ignored.
    const script = [
      `(set-logic ${obligation.logic})`,
      obligation.script.replace(
        "(pop 1)",
        `(get-value (${obligation.declared.join(" ")}))\n(pop 1)`,
      ),
    ].join("\n");
    // A spawn failure is the same for every obligation, so it is the run that
    // failed rather than the claim. Fail once.
    const output = await runSolver(command, script).catch((e: Error) => {
      throw new Error(
        `could not run \`${command.join(" ")}\`: ${e.message}. Pass --solver with an SMT-LIB 2 solver that reads a script on stdin.`,
      );
    });
    const lines = output.split("\n").filter((l) => l.trim() !== "");
    const verdict = lines.find((l) => /^(sat|unsat|unknown)$/.test(l.trim()))?.trim();
    // A solver that rejects one command carries on with the rest, so `check-sat`
    // still answers, but over a script missing an assertion, and reading that as
    // a verdict turns a malformed encoding into a confident counterexample.
    // `unsat` survives it: dropping an assertion only ever makes a proof harder,
    // so a proof that went through is still a proof. Anything else does not.
    // `(error ...)` is SMT-LIB's own error response, spelled the same way by every
    // solver, and after `unsat` it is the `get-value` line saying there is no
    // model to name, which the verdict already accounts for.
    if (verdict !== "unsat" && lines.some((l) => /^\(error\b/.test(l.trim()))) {
      verdicts.push({ obligation, status: "error", detail: lines.join(" ").trim() });
      continue;
    }
    if (verdict === "unsat") verdicts.push({ obligation, status: "discharged" });
    else if (verdict === "sat")
      verdicts.push({
        obligation,
        status: "counterexample",
        detail: lines
          .slice(lines.indexOf("sat") + 1)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      });
    else if (verdict === "unknown") verdicts.push({ obligation, status: "unknown" });
    else verdicts.push({ obligation, status: "error", detail: output.trim() });
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
