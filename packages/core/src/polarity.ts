// Warnings about `^` sigils that carry no meaning.
//
// A `^` only does something when the predicate is read while its value is
// still ⊤, which happens only inside the alternating loop of a stratum that
// holds both polarities. Two shapes make it inert: a predicate in no recursive
// SCC at all, and a recursive SCC whose members are all maximal. Both compute
// exactly what they would without the sigil.
//
// Inert sigils are not errors, because an error would fire constantly while
// editing: comment out one rule, the cycle opens, and an unrelated line goes
// red. They are worth reporting anyway, since a reader takes `^` at a call
// site as the cue that a negation inside a cycle is deliberate, and inert ones
// make that cue unreliable.
//
// Shaped like `FinitenessDiagnostic` and consumed the same way (a pull-based
// call from the CLI and the playground), so no warning channel out of
// `analyze` is needed. See `doc/design/parity-stratification.md` §11.

import type { AnalyzedProgram } from "./analyzer.ts";

export interface PolarityDiagnostic {
  severity: "warning";
  code: "inert-maximal";
  message: string;
  predicate: string;
  /** Byte offset of the head of the predicate's first rule. */
  offset?: number;
  end?: number;
}

export function findInertPolarity(analyzed: AnalyzedProgram): PolarityDiagnostic[] {
  const diagnostics: PolarityDiagnostic[] = [];
  for (const stratum of analyzed.sortedStrata) {
    const maximal = stratum.filter((p) => analyzed.maximalPredicates.has(p));
    if (maximal.length === 0) continue;
    // A stratum with both polarities is a real parity cycle: the minimal side
    // reads the maximal side at ⊤ in round 0, so every sigil in it counts.
    if (maximal.length < stratum.length) continue;

    const recursive = stratum.some((p) => analyzed.recursivePredicates.has(p));
    for (const predicate of maximal) {
      const head = analyzed.rules.get(predicate)?.[0]?.head;
      const cst = head?.$cstNode;
      diagnostics.push({
        severity: "warning",
        code: "inert-maximal",
        message: recursive
          ? `The '^' on '${predicate}' has no effect: every predicate in its recursive cycle is maximal, so nothing reads it at ⊤`
          : `The '^' on '${predicate}' has no effect: it is not part of a recursive cycle, so nothing reads it at ⊤`,
        predicate,
        offset: cst?.offset,
        end: cst?.end,
      });
    }
  }
  return diagnostics;
}
