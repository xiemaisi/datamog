/** Check payload contributions before their annotations widen the published registry. */
import type { ProofConstruction } from "datamog-parser";
import { AnalyzerError } from "./analyzer.ts";
import { semanticContractMismatch } from "./semantic-diagnostics.ts";
import type { ConstructorContribution } from "./semantic-inference.ts";
import { declaredColumnType } from "./structural-declarations.ts";

export function validateConstructorAnnotations(
  contributions: ReadonlyMap<ProofConstruction, ConstructorContribution>,
): void {
  for (const [proof, contribution] of contributions) {
    for (const [i, annotation] of (proof.annotations ?? []).entries()) {
      if (!annotation) continue;
      const mismatch = semanticContractMismatch(
        contribution.types[i]!,
        declaredColumnType(annotation),
      );
      const nullMismatch =
        contribution.nullable[i] && !annotation.nullable
          ? "this payload can be null; use a nullable annotation (?)"
          : undefined;
      if (mismatch || nullMismatch) {
        const expr = proof.payload[i];
        throw new AnalyzerError(
          `Constructor '${proof.predicate}::${proof.name}' payload ${i + 1} does not satisfy its annotation: ${mismatch ?? nullMismatch}`,
          annotation.offset ?? expr?.$cstNode?.offset,
          annotation.end ?? expr?.$cstNode?.end,
        );
      }
    }
  }
}
