// Diagnostics for refinement contracts.
//
// A predicate's contract is the disjunction over its rules, and a rule that
// annotates nothing contributes `True`, so one unannotated sibling makes the
// whole contract vacuous. Nothing goes wrong, which is the problem: the
// annotations are still there, still read as claims, and check nothing. The
// parser emits no contract check for such a predicate, and this says why.
//
// A rule reaches the same place by a second route, writing a refinement that
// mentions no head position. `_: 0 <= 0` is a closed formula, so it is the same
// proposition for every tuple and constrains none of them.
//
// See doc/design/refinement-annotations.md §2.1, §2.2 and §11.9.

import type { AnalyzedProgram } from "./analyzer.ts";
import type { Expression } from "./ast.ts";

export interface ContractDiagnostic {
  severity: "warning";
  code: "inert-contract" | "constant-refinement";
  message: string;
  offset?: number;
  end?: number;
}

/** Whether an expression mentions a variable, walking the AST generically. */
function mentionsVariable(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(mentionsVariable);
  if (typeof node !== "object" || node === null) return false;
  const typed = node as { $type?: string };
  if (typed.$type === "Variable") return true;
  return Object.entries(node).some(
    ([key, value]) => !key.startsWith("$") && mentionsVariable(value),
  );
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
  for (const rules of analyzed.rules.values()) {
    for (const rule of rules) {
      for (const refinement of rule.head.refinements ?? []) {
        if (mentionsVariable(refinement.formula as Expression)) continue;
        diagnostics.push({
          severity: "warning",
          code: "constant-refinement",
          message: `The refinement \`${refinement.text}\` mentions no head position, so it is the same proposition for every tuple of '${rule.head.predicate}' and constrains none of them. If it is true the rule claims nothing, which makes the predicate's whole contract vacuous, since the contract is the disjunction over its rules; if it is false no tuple can satisfy it. Name the positions it is meant to be about, with \`as\` where they are computed.`,
          offset: refinement.formula.$cstNode?.offset,
          end: refinement.formula.$cstNode?.end,
        });
      }
    }
  }
  return diagnostics;
}
