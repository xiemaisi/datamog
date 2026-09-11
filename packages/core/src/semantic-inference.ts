import { proofConstruction } from "datamog-parser";
/** Structural inference for implementation facts and published semantic contracts. */
import { BUILTIN_BODY_ATOMS } from "./analyzer.ts";
import type { HeadTerm, Rule } from "./ast.ts";
import { mayBeNull, refineBody } from "./nullness.ts";
import { constrainSemanticVariable } from "./semantic-constraints.ts";
import { inferSemanticExpression } from "./semantic-expressions.ts";
import {
  ANY_VALUE,
  NEVER,
  ProofTypeRegistry,
  type SemanticType,
  fromPrimitiveType,
  sameSemanticType,
  scalarType,
  unionType,
} from "./semantic-type.ts";
import { widenSemanticType } from "./semantic-widening.ts";
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
  options: { maxRuleEvaluations?: number } = {},
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

  const pending = new Set([...program.rules.values()].flat());
  const dependents = new Map<string, Set<Rule>>();
  const limit = options.maxRuleEvaluations ?? 128 * pending.size;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("Semantic inference work limit must be a nonnegative safe integer");
  let evaluations = 0;
  while (pending.size > 0 && evaluations++ < limit) {
    const rule = pending.values().next().value!;
    pending.delete(rule);
    let changed = false;
    // Register reads as they happen, including nominal payload lookups whose
    // signatures may widen without changing the source column's proof identity.
    const dependOn = (predicate: string) => {
      let readers = dependents.get(predicate);
      if (!readers) {
        readers = new Set();
        dependents.set(predicate, readers);
      }
      readers.add(rule);
    };
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
    nullColumns.set(rule.head.predicate, program.nullness.columnNullness.get(rule.head.predicate)!);
    const nonNull = refineBody(rule, nullColumns, nullContext);
    const vars = new Map<string, SemanticType>();
    for (const element of rule.body) {
      if (element.$type !== "Literal" || element.negated) continue;
      dependOn(element.predicate);
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
    const infer = (term: HeadTerm): SemanticType | undefined =>
      inferSemanticExpression(term, {
        variable: (name) => {
          const type = vars.get(name);
          return type?.kind === "union" && nonNull.has(name)
            ? unionType(...type.members.filter((t) => t.kind !== "scalar" || t.name !== "null"))
            : type;
        },
        primitive: (expr) => inferTermType(expr, legacyVars.get(rule)!, legacyContext),
        payload: (id, name) => {
          dependOn(id.predicate);
          return signatures.get(id.predicate)?.get(name);
        },
        fallback: (expr) => {
          const coarse = inferTermType(expr, legacyVars.get(rule)!, legacyContext);
          if (!coarse) return ANY_VALUE;
          const type = fromPrimitiveType(coarse);
          return mayBeNull(expr, nonNull, rule, nullContext)
            ? unionType(type, scalarType("null"))
            : type;
        },
      });
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
    if (changed) {
      for (const reader of dependents.get(rule.head.predicate) ?? []) pending.add(reader);
    }
  }
  if (pending.size === 0) return finish(columns);
  // Exhaustion must not publish a partial, potentially too-narrow fixed point.
  // Include rules never visited when a caller supplies a very small work limit.
  for (const rule of [...program.rules.values()].flat())
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
