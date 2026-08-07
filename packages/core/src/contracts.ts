// Diagnostics for refinement contracts.
//
// A predicate's contract is the disjunction over its rules, and a rule that
// annotates nothing contributes `True`, so one unannotated sibling makes the
// whole contract vacuous. Nothing goes wrong, which is the problem: the
// annotations are still there, still read as claims, and check nothing. The
// parser emits no contract check for such a predicate, and this says why.
//
// See doc/design/refinement-annotations.md §2.1 and §2.2.

import type { AnalyzedProgram } from "./analyzer.ts";

export interface ContractDiagnostic {
  severity: "warning";
  code: "inert-contract";
  message: string;
  offset?: number;
  end?: number;
}

export function findInertContracts(analyzed: AnalyzedProgram): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  for (const [predicate, rules] of analyzed.rules) {
    const annotated = rules.filter((r) => (r.head.refinements?.length ?? 0) > 0);
    if (annotated.length === 0 || annotated.length === rules.length) continue;
    const bare = rules.length - annotated.length;
    const head = annotated[0]!.head;
    diagnostics.push({
      severity: "warning",
      code: "inert-contract",
      message: `${bare} of ${rules.length} rules for '${predicate}' carry no refinement, so its contract is vacuous and nothing is checked: a predicate's contract is the disjunction over its rules, and an unannotated one claims everything. Annotate the rest, or drop the annotation.`,
      offset: head.$cstNode?.offset,
      end: head.$cstNode?.end,
    });
  }
  return diagnostics;
}
