/** Explicit source constraints become goals, never hypotheses. */
import { type Query, asCoreRule } from "../packages/core/src/ast.ts";
import type { TypedProgram } from "../packages/core/src/types.ts";
import { parse } from "../packages/parser/src/index.ts";
import { type InputLaw, exportProgramClaim } from "./lean-mutual.ts";

export interface ConstraintClaim {
  kind: "constraint";
  id: string;
  /** One-based index among explicit !- statements, excluding synthesized checks. */
  constraint: number;
  instance?: string;
  inputLaws?: InputLaw[];
  polarity?: "prove" | "refute";
}

export function exportConstraint(
  typed: TypedProgram,
  query: Query,
  claim: ConstraintClaim,
  sourceFile?: string,
) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(claim.id)) throw new Error("Invalid constraint claim name");
  if (!query.isError || query.synthetic || !query.$cstNode || query.outputName)
    throw new Error("Constraint selection requires an explicit source !- statement");
  const predicate = `__lean_constraint_${claim.id}`;
  if (typed.rules.has(predicate) || typed.extDecls.has(predicate))
    throw new Error("Generated constraint predicate conflicts with source predicate");
  const parsed = parse(`${predicate}().`).statements[0];
  if (parsed?.$type !== "Rule") throw new Error("Expected a generated nullary rule");
  const rule = asCoreRule(parsed);
  rule.body = query.body;
  const rules = new Map(typed.rules).set(predicate, [rule]);
  const columnTypes = new Map(typed.columnTypes).set(predicate, []);
  const publishedNullness = new Map(typed.nullness.publishedNullness).set(predicate, []);
  // Removing checks does not assume they hold: all source rule definitions remain.
  // The selected body's derivations must be ruled out for arbitrary typed inputs.
  const bundle = exportProgramClaim(
    {
      ...typed,
      rules,
      columnTypes,
      constraints: [],
      nullness: { ...typed.nullness, publishedNullness },
    },
    {
      kind: "program-emptiness",
      id: claim.id,
      predicate,
      polarity: claim.polarity,
      inputLaws: claim.inputLaws,
    },
  );
  const origin = `${claim.id}Constraint`;
  const cst = query.$cstNode;
  bundle.nodes.push({
    id: origin,
    kind: "definition",
    assumptions: [],
    dependencies: [],
    statement: {
      claim,
      ...(sourceFile ? { file: sourceFile } : {}),
      text: cst.text,
      span: {
        offset: cst.offset,
        end: cst.end,
        line: cst.range.start.line + 1,
        column: cst.range.start.character + 1,
      },
    },
  });
  const node = bundle.nodes.find((node) => node.id === claim.id)!;
  node.statement = { claim, source: (node.statement as { source: string }).source };
  node.dependencies = [...node.dependencies, origin];
  return bundle;
}

export interface ErrorPredicateClaim {
  kind: "error-predicate";
  id: string;
  predicate: string;
  instance?: string;
  inputLaws?: InputLaw[];
  polarity?: "prove" | "refute";
}

/** Error status applies to the whole relation, including unmarked sibling rules. */
export function exportErrorPredicate(
  typed: TypedProgram,
  claim: ErrorPredicateClaim,
  sourceFile?: string,
  resolvedPredicate = claim.predicate,
) {
  const rules = typed.rules.get(resolvedPredicate);
  if (
    !rules?.length ||
    !typed.constraints.some((q) => q.outputName === resolvedPredicate && !q.synthetic)
  )
    throw new Error("Selection requires a declared error predicate");
  const definitions = rules.map((rule) => {
    const cst = rule.$cstNode;
    if (!cst) throw new Error("Error predicate definitions require source provenance");
    return {
      error: rule.error,
      text: cst.text,
      span: {
        offset: cst.offset,
        end: cst.end,
        line: cst.range.start.line + 1,
        column: cst.range.start.character + 1,
      },
    };
  });
  // All checks are goals, not restrictions on the modeled inputs or derivations.
  const bundle = exportProgramClaim(
    { ...typed, constraints: [] },
    {
      kind: "program-emptiness",
      id: claim.id,
      predicate: resolvedPredicate,
      inputLaws: claim.inputLaws,
      polarity: claim.polarity,
    },
  );
  const origin = `${claim.id}ErrorPredicate`;
  bundle.nodes.push({
    id: origin,
    kind: "definition",
    statement: {
      claim,
      resolvedPredicate,
      ...(sourceFile ? { file: sourceFile } : {}),
      definitions,
    },
    assumptions: [],
    dependencies: [],
  });
  const node = bundle.nodes.find((node) => node.id === claim.id)!;
  node.statement = { claim, source: (node.statement as { source: string }).source };
  node.dependencies = [...node.dependencies, origin];
  return bundle;
}
