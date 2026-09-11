import { proofConstruction, proofProjection } from "datamog-parser";
/** Structural inference for implementation facts and published semantic contracts. */
import { BUILTIN_BODY_ATOMS } from "./analyzer.ts";
import type { HeadTerm, Rule } from "./ast.ts";
import { mayBeNull, refineBody } from "./nullness.ts";
import { constrainSemanticVariable } from "./semantic-constraints.ts";
import {
  ANY_VALUE,
  NEVER,
  ProofTypeRegistry,
  type SemanticType,
  fromPrimitiveType,
  projectProofPayload,
  projectType,
  sameSemanticType,
  scalarType,
  unionType,
} from "./semantic-type.ts";
import { boundSemanticType, widenSemanticType } from "./semantic-widening.ts";
import { declaredColumnType } from "./structural-declarations.ts";
import { type TypedProgram, inferTermType, rebuildVarTypes } from "./types.ts";

export type SemanticInferenceInput = Omit<
  TypedProgram,
  "semanticColumnTypes" | "proofTypes" | "publishedSemanticColumnTypes" | "publishedProofTypes"
>;

/**
 * Infer successful column values after legacy validation. Supplying inferred
 * columns selects published-contract propagation. Unknown results fall back to value;
 * absence stays with the existing partiality pass. Lowering metadata identifies
 * nominal proof construction and checked payload projections.
 */
export function inferSemanticColumns(
  program: SemanticInferenceInput,
  inferred?: ReadonlyMap<string, readonly SemanticType[]>,
): {
  semanticColumnTypes: Map<string, SemanticType[]>;
  proofTypes: ProofTypeRegistry;
  headContributions: Map<Rule, SemanticType[]>;
} {
  const headContributions = new Map<Rule, SemanticType[]>();
  const signatures = new Map<string, Map<string, SemanticType[]>>();
  for (const rules of program.rules.values()) {
    for (const rule of rules) {
      for (const term of rule.head.args) {
        const info = term.$type === "ObjectLiteral" ? proofConstruction(term) : undefined;
        if (!info) continue;
        let ctors = signatures.get(info.predicate);
        if (!ctors) {
          ctors = new Map();
          signatures.set(info.predicate, ctors);
        }
        ctors.set(
          info.name,
          info.payload.map(() => NEVER),
        );
      }
    }
  }
  const finish = (columns: Map<string, SemanticType[]>) => {
    const proofTypes = new ProofTypeRegistry();
    for (const [predicate, ctors] of signatures) {
      proofTypes.define(
        { predicate },
        [...ctors].map(([name, payload]) => ({ name, payload })),
      );
    }
    proofTypes.validateReferences();
    return { semanticColumnTypes: columns, proofTypes, headContributions };
  };
  const columns = new Map<string, SemanticType[]>();
  for (const [name, storage] of program.columnTypes) {
    columns.set(
      name,
      program.extDecls.has(name)
        ? program.extDecls.get(name)!.columns.map(declaredColumnType)
        : storage.map(() => NEVER),
    );
  }
  const legacyVars = new Map<Rule, ReturnType<typeof rebuildVarTypes>>();
  for (const rules of program.rules.values()) {
    for (const rule of rules) {
      const context = new Map(inferred ? program.publishedTypes : program.columnTypes);
      context.set(rule.head.predicate, program.columnTypes.get(rule.head.predicate)!);
      legacyVars.set(rule, rebuildVarTypes(rule.body, context));
    }
  }

  // A secondary work limit bounds analysis overhead even for long dependency
  // chains. If reached, discard all IDB precision rather than publish an
  // unfinished (and potentially too narrow) approximation.
  for (let round = 0; round < 128; round++) {
    let changed = false;
    for (const rules of program.rules.values()) {
      for (const rule of rules) {
        const legacyContext = new Map(inferred ? program.publishedTypes : program.columnTypes);
        legacyContext.set(rule.head.predicate, program.columnTypes.get(rule.head.predicate)!);
        const nullContext = {
          overloads: program.functionOverloads,
          typeOf: (_owner: Rule, expr: HeadTerm) =>
            inferTermType(expr, legacyVars.get(rule)!, legacyContext),
        };
        const nullColumns = new Map(
          inferred ? program.nullness.publishedNullness : program.nullness.columnNullness,
        );
        nullColumns.set(
          rule.head.predicate,
          program.nullness.columnNullness.get(rule.head.predicate)!,
        );
        const nonNull = refineBody(rule, nullColumns, nullContext);
        const vars = new Map<string, SemanticType>();
        for (const element of rule.body) {
          if (element.$type !== "Literal" || element.negated) continue;
          const builtin = BUILTIN_BODY_ATOMS.get(element.predicate);
          for (const [i, arg] of element.args.entries()) {
            if (arg.$type !== "Variable") continue;
            const bound = builtin?.boundArgs.find((item) => item.index === i);
            const type = builtin
              ? bound && unionType(fromPrimitiveType(bound.type), scalarType("null"))
              : (inferred && element.predicate === rule.head.predicate
                  ? inferred.get(element.predicate)
                  : columns.get(element.predicate))?.[i];
            if (type) constrainSemanticVariable(vars, arg.name, type);
          }
        }
        const infer = (term: HeadTerm): SemanticType | undefined => {
          const child = (expr: HeadTerm) => infer(expr);
          switch (term.$type) {
            case "Variable": {
              const type = vars.get(term.name);
              return type?.kind === "union" && nonNull.has(term.name)
                ? unionType(
                    ...type.members.filter(
                      (member) => member.kind !== "scalar" || member.name !== "null",
                    ),
                  )
                : type;
            }
            case "NullLiteral":
              return scalarType("null");
            case "StringLiteral":
              return scalarType("string");
            case "BooleanLiteral":
              return scalarType("boolean");
            case "NumberLiteral":
              return fromPrimitiveType(
                inferTermType(term, legacyVars.get(rule)!, program.columnTypes)!,
              );
            case "ObjectLiteral": {
              const proof = proofConstruction(term);
              if (proof) return { kind: "proof", id: { predicate: proof.predicate } };
              const fields = [];
              const keys = new Set<string>();
              for (const entry of term.entries) {
                // Leave duplicate-key behavior to existing backends.
                if (keys.has(entry.key)) return ANY_VALUE;
                keys.add(entry.key);
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
                if (!source) return undefined;
                return projectProofPayload(
                  source,
                  match.predicate,
                  match.name,
                  match.index,
                  (id, name) => signatures.get(id.predicate)?.get(name),
                );
              }
              const receiver = child(term.object);
              if (!receiver) return undefined;
              // This API handles JSON receivers and literal nonnegative keys.
              // Language string and negative/dynamic indexing retain fallback types.
              const index = term.index;
              if (
                supportsJsonProjection(receiver) &&
                (index.$type === "StringLiteral" ||
                  (index.$type === "NumberLiteral" &&
                    Number.isInteger(index.value) &&
                    index.value >= 0))
              ) {
                return projectType(receiver, index.value).type;
              }
              break;
            }
            case "AggregateCall":
              if (term.func === "list") {
                const element = child(term.arg);
                return element ? boundSemanticType({ kind: "array", element }) : undefined;
              }
              break;
          }
          const coarse = inferTermType(term, legacyVars.get(rule)!, program.columnTypes);
          if (!coarse) return ANY_VALUE;
          const type = fromPrimitiveType(coarse);
          return mayBeNull(term, nonNull, rule, nullContext)
            ? unionType(type, scalarType("null"))
            : type;
        };
        // Equalities propagate in both directions, including requirements on
        // names already bound by predicates or earlier equality bindings.
        for (let pass = 0; pass <= rule.body.length; pass++) {
          let learned = false;
          for (const element of rule.body) {
            if (element.$type !== "Equality") continue;
            for (const [target, source] of [
              [element.left, element.expr],
              [element.expr, element.left],
            ]) {
              if (target!.$type !== "Variable") continue;
              const type = infer(source!);
              if (type) learned = constrainSemanticVariable(vars, target!.name, type) || learned;
            }
          }
          if (!learned) break;
        }
        for (const term of rule.head.args) {
          const proof = term.$type === "ObjectLiteral" ? proofConstruction(term) : undefined;
          if (!proof) continue;
          const payload = signatures.get(proof.predicate)!.get(proof.name)!;
          for (const [i, expr] of proof.payload.entries()) {
            const next = widenSemanticType(payload[i]!, infer(expr) ?? ANY_VALUE);
            if (!sameSemanticType(payload[i]!, next)) {
              payload[i] = next;
              changed = true;
            }
          }
        }
        const previous = columns.get(rule.head.predicate)!;
        const contributions: SemanticType[] = [];
        headContributions.set(rule, contributions);
        for (const [i, term] of rule.head.args.entries()) {
          let contribution = infer(term) ?? ANY_VALUE;
          contributions.push(contribution);
          const annotation = inferred ? rule.head.argTypes?.[i] : undefined;
          if (annotation) {
            contribution = widenSemanticType(contribution, declaredColumnType(annotation));
          }
          const next = widenSemanticType(previous[i]!, contribution);
          if (!sameSemanticType(previous[i]!, next)) {
            previous[i] = next;
            changed = true;
          }
        }
      }
    }
    if (!changed) return finish(columns);
  }
  for (const [rule] of headContributions)
    headContributions.set(
      rule,
      rule.head.args.map(() => ANY_VALUE),
    );
  for (const name of program.rules.keys()) {
    columns.set(
      name,
      program.columnTypes.get(name)!.map(() => ANY_VALUE),
    );
  }
  for (const ctors of signatures.values()) {
    for (const [name, payload] of ctors)
      ctors.set(
        name,
        payload.map(() => ANY_VALUE),
      );
  }
  return finish(columns);
}

/** A string alternative needs the language's distinct string-indexing semantics. */
function supportsJsonProjection(type: SemanticType): boolean {
  return type.kind === "union"
    ? type.members.every(supportsJsonProjection)
    : type.kind !== "scalar" && type.kind !== "proof";
}
