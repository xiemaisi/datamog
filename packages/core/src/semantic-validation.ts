/** Checks that require semantic information unavailable in primitive storage types. */
import { proofConstruction, proofMatch, proofProjection } from "datamog-parser";
import { AnalyzerError } from "./analyzer.ts";
import type { BodyElement, HeadTerm } from "./ast.ts";
import { formatSemanticType as describe } from "./semantic-diagnostics.ts";
import {
  ANY_VALUE,
  type SemanticType,
  intersectTypes,
  projectProofPayload,
  sameSemanticType,
  scalarType,
} from "./semantic-type.ts";
import type { TypedProgram } from "./types.ts";

/**
 * Check disjoint proof requirements and generated constructor payload constraints.
 * Unknown/value contracts are deliberately accepted. This does not reinterpret
 * JSON filtering, validate external data, or enable typed primitive extraction.
 */
export function validateSemanticTypes(program: TypedProgram): void {
  const check = (body: BodyElement[], owner?: string) => {
    const vars = new Map<string, SemanticType>();
    const columns = (predicate: string) =>
      predicate === owner
        ? program.semanticColumnTypes.get(predicate)
        : program.publishedSemanticColumnTypes.get(predicate);
    const fail = (message: string, term: HeadTerm) => {
      throw new AnalyzerError(message, term.$cstNode?.offset, term.$cstNode?.end);
    };
    const hasProof = (type: SemanticType): boolean =>
      type.kind === "proof" || (type.kind === "union" && type.members.some(hasProof));
    const constrain = (name: string, type: SemanticType, term: HeadTerm) => {
      const previous = vars.get(name);
      if (!previous) {
        vars.set(name, type);
        return true;
      }
      // Empty producer types are not evidence of a type mismatch.
      if (previous.kind === "never" || type.kind === "never") return false;
      const common = intersectTypes(previous, type);
      if (common.kind === "never" && (hasProof(previous) || hasProof(type))) {
        fail(
          `Variable '${name}' has incompatible semantic types: ${describe(previous)} and ${describe(type)}`,
          term,
        );
      }
      // Do not turn ordinary relational filtering into a new type error.
      if (common.kind === "never" || sameSemanticType(previous, common)) return false;
      vars.set(name, common);
      return true;
    };
    for (const element of body) {
      if (element.$type !== "Literal" || element.negated) continue;
      for (const [i, arg] of element.args.entries()) {
        const type = columns(element.predicate)?.[i];
        if (arg.$type === "Variable" && type) constrain(arg.name, type, arg);
      }
    }
    const infer = (term: HeadTerm): SemanticType => {
      switch (term.$type) {
        case "Variable":
          return vars.get(term.name) ?? ANY_VALUE;
        case "StringLiteral":
          return scalarType("string");
        case "NumberLiteral":
          return scalarType(Number.isInteger(term.value) ? "integer" : "float");
        case "BooleanLiteral":
          return scalarType("boolean");
        case "NullLiteral":
          return scalarType("null");
        case "ObjectLiteral": {
          const info = proofConstruction(term);
          return info ? { kind: "proof", id: { predicate: info.predicate } } : ANY_VALUE;
        }
        case "Subscript": {
          const info = proofProjection(term);
          if (!info) return ANY_VALUE;
          const source = infer(info.receiver);
          const registry =
            info.predicate === owner ? program.proofTypes : program.publishedProofTypes;
          return projectProofPayload(source, info.predicate, info.name, info.index, (id, name) =>
            registry.payload(id, name),
          );
        }
        default:
          return ANY_VALUE;
      }
    };
    for (let pass = 0; pass <= body.length; pass++) {
      let changed = false;
      for (const element of body) {
        if (element.$type !== "Equality") continue;
        for (const [target, source] of [
          [element.left, element.expr],
          [element.expr, element.left],
        ]) {
          if (target!.$type === "Variable")
            changed = constrain(target!.name, infer(source!), target!) || changed;
        }
      }
      if (!changed) break;
    }
    for (const element of body) {
      if (element.$type !== "Equality") continue;
      const match = proofMatch(element);
      if (match) {
        const source = infer(match.receiver);
        const expected: SemanticType = { kind: "proof", id: { predicate: match.predicate } };
        if (source.kind !== "never" && intersectTypes(source, expected).kind === "never") {
          fail(
            `Constructor '${match.predicate}::${match.name}' cannot match ${describe(source)}`,
            match.receiver,
          );
        }
      }
      const projection = (term: HeadTerm) => term.$type === "Subscript" && proofProjection(term);
      if (projection(element.left) || projection(element.expr)) {
        const a = infer(element.left);
        const b = infer(element.expr);
        if (a.kind !== "never" && b.kind !== "never" && intersectTypes(a, b).kind === "never") {
          fail(
            `Constructor payload has incompatible semantic types: ${describe(a)} and ${describe(b)}`,
            element.left,
          );
        }
      }
    }
  };
  for (const [predicate, rules] of program.rules) {
    for (const rule of rules) check(rule.body, predicate);
  }
  for (const query of program.queries) check(query.body);
  for (const constraint of program.constraints) check(constraint.body);
}
