/** Successful expression types shared by semantic inference and operand lowering. */
import { proofConstruction, proofProjection } from "datamog-parser";
import type { HeadTerm, PrimitiveType } from "./ast.ts";
import {
  ANY_VALUE,
  NEVER,
  type ProjectionType,
  type ProofTypeId,
  type SemanticType,
  projectProofPayload,
  projectType,
  scalarType,
  unionType,
} from "./semantic-type.ts";
import { boundSemanticType, widenSemanticType } from "./semantic-widening.ts";

export interface SemanticExpressionContext {
  variable(name: string): SemanticType | undefined;
  primitive(term: HeadTerm): PrimitiveType | undefined;
  /** Legacy expressions retain the caller's nullness and unknown-state policy. */
  fallback(term: HeadTerm): SemanticType | undefined;
  payload(id: ProofTypeId, name: string): readonly SemanticType[] | undefined;
}

/**
 * Language projection, with absence separate from successful values. An unknown
 * integer index may select any array/tuple element or fall outside its bounds.
 * Mixed string/JSON receivers stay conservative: their runtime access differs.
 */
export function projectSemanticSubscript(
  source: SemanticType,
  index: HeadTerm,
  indexType: PrimitiveType | undefined,
): ProjectionType {
  if (source.kind === "scalar" && source.name === "string" && indexType === "integer")
    return { type: source, mayBeAbsent: true };
  const json = (type: SemanticType): boolean =>
    type.kind === "union"
      ? type.members.every(json)
      : type.kind !== "scalar" && type.kind !== "proof";
  if (
    json(source) &&
    (index.$type === "StringLiteral" ||
      (index.$type === "NumberLiteral" && Number.isInteger(index.value) && index.value >= 0))
  ) {
    return projectType(source, index.value);
  }
  const element = (type: SemanticType): SemanticType => {
    if (type.kind === "never") return NEVER;
    if (type.kind === "array") return type.element;
    if (type.kind === "tuple") return unionType(...type.elements);
    if (type.kind === "union") return unionType(...type.members.map(element));
    return ANY_VALUE;
  };
  return {
    type: indexType === "integer" ? element(source) : ANY_VALUE,
    mayBeAbsent: true,
  };
}

/** No storage changes or null-to-absence conversion; lowering chooses extraction sites. */
export function inferSemanticExpression(
  term: HeadTerm,
  context: SemanticExpressionContext,
): SemanticType | undefined {
  const child = (expr: HeadTerm) => inferSemanticExpression(expr, context);
  switch (term.$type) {
    case "Variable":
      return context.variable(term.name);
    case "NullLiteral":
      return scalarType("null");
    case "StringLiteral":
      return scalarType("string");
    case "BooleanLiteral":
      return scalarType("boolean");
    case "ObjectLiteral": {
      const proof = proofConstruction(term);
      if (proof) return { kind: "proof", id: { predicate: proof.predicate } };
      // Duplicate-key runtime behavior remains the responsibility of backends.
      if (new Set(term.entries.map((entry) => entry.key)).size !== term.entries.length)
        return ANY_VALUE;
      const fields = [];
      for (const entry of term.entries) {
        const type = child(entry.value);
        if (!type) return undefined;
        fields.push({ name: entry.key, type, optional: false });
      }
      return boundSemanticType({ kind: "record", fields, additional: NEVER });
    }
    case "ArrayLiteral": {
      const elements: SemanticType[] = [];
      for (const expr of term.elements) {
        const type = child(expr);
        if (!type) return undefined;
        elements.push(type);
      }
      return boundSemanticType({ kind: "tuple", elements });
    }
    case "Conditional": {
      const a = child(term.consequent);
      const b = child(term.alternate);
      return a && b ? widenSemanticType(a, b) : undefined;
    }
    case "Subscript": {
      const match = proofProjection(term);
      if (match) {
        const source = child(match.receiver);
        return (
          source &&
          projectProofPayload(source, match.predicate, match.name, match.index, context.payload)
        );
      }
      const source = child(term.object);
      return (
        source && projectSemanticSubscript(source, term.index, context.primitive(term.index)).type
      );
    }
    case "AggregateCall":
      if (term.func === "list") {
        const element = child(term.arg);
        return element ? boundSemanticType({ kind: "array", element }) : undefined;
      }
      break;
  }
  return context.fallback(term);
}
