/** Metadata on lowered nodes, retained separately from their JSON representation. */
import type { Equality, Expression, ObjectLiteral, Subscript } from "./generated/ast.js";

export interface ProofConstruction {
  readonly predicate: string;
  readonly name: string;
  readonly payload: readonly Expression[];
}
export interface ProofProjection {
  readonly predicate: string;
  readonly name: string;
  readonly index: number;
  readonly receiver: Expression;
}

// Lowering runs after module elaboration, so predicate names already identify
// module instances. Consumers must preserve node identity after this stage;
// cloning a lowered tree requires explicitly transferring this metadata.
const constructions = new WeakMap<ObjectLiteral, ProofConstruction>();
const projections = new WeakMap<Subscript, ProofProjection>();
export function markProofConstruction(node: ObjectLiteral, info: ProofConstruction): void {
  constructions.set(node, info);
}
export function markProofProjection(node: Subscript, info: ProofProjection): void {
  projections.set(node, info);
}
export function proofConstruction(node: ObjectLiteral): ProofConstruction | undefined {
  return constructions.get(node);
}
export function proofProjection(node: Subscript): ProofProjection | undefined {
  return projections.get(node);
}

/** Tag guard emitted for every match, including nullary constructors. */
const matches = new WeakMap<Equality, Omit<ProofProjection, "index">>();
export function markProofMatch(node: Equality, info: Omit<ProofProjection, "index">): void {
  matches.set(node, info);
}
export function proofMatch(node: Equality): Omit<ProofProjection, "index"> | undefined {
  return matches.get(node);
}
