/** Shared-variable refinement for structural inference and operand lowering. */
import {
  type SemanticType,
  intersectTypes,
  isSemanticSubtype,
  sameSemanticType,
} from "./semantic-type.ts";
import { boundSemanticType } from "./semantic-widening.ts";

/**
 * Add a requirement within a rule. Unknown is absence from the map, not never.
 * Bounding an intersection can discard precision, but must not undo an earlier
 * requirement: retain the previous approximation if the bound cannot be proved
 * narrower. This keeps local propagation descending even at budget boundaries.
 * This helper produces no diagnostics; validation owns mismatch reporting.
 */
export function constrainSemanticVariable(
  vars: Map<string, SemanticType>,
  name: string,
  requirement: SemanticType,
): boolean {
  const previous = vars.get(name);
  if (!previous) {
    vars.set(name, boundSemanticType(requirement));
    return true;
  }
  const narrowed = boundSemanticType(intersectTypes(previous, requirement));
  if (!isSemanticSubtype(narrowed, previous) || sameSemanticType(previous, narrowed)) return false;
  vars.set(name, narrowed);
  return true;
}
