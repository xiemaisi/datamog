/** Source-derived contract theorem over the existing positive relation model. */
import type { HeadTerm } from "../packages/core/src/ast.ts";
import { isFloatLiteral } from "../packages/core/src/ast.ts";
import { exportLeanRelation } from "../packages/core/src/obligation-lean.ts";
import type { TypedProgram } from "../packages/core/src/types.ts";
import type { VerificationNode } from "../packages/core/src/verification-manifest.ts";

export interface InvariantClaim {
  kind: "invariant";
  id: string;
  predicate: string;
  relationName: string;
  polarity?: "prove" | "refute";
}

export function exportInvariant(typed: TypedProgram, claim: InvariantClaim) {
  const { id, predicate, relationName } = claim;
  if (
    ![id, relationName].every((name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) ||
    id === relationName
  )
    throw new Error("Invalid or conflicting invariant names");
  const rules = typed.rules.get(predicate);
  if (!rules?.length || rules.some((rule) => !rule.head.refinements?.length))
    throw new Error("Invariant requires refinements on every defining rule");
  if (typed.constraints.some((constraint) => !constraint.synthetic))
    throw new Error("Invariant export does not support explicit constraints");
  const { columns, contract } = invariantContract(typed, predicate);
  // Refinements check produced tuples; they are not constructor premises.
  // Only synthesized checks are removed. The original AST is never mutated.
  const erasedRules = new Map(typed.rules);
  erasedRules.set(
    predicate,
    rules.map((rule) => ({ ...rule, head: { ...rule.head, refinements: undefined } })),
  );
  const relation = exportLeanRelation(
    { ...typed, rules: erasedRules, constraints: [] },
    predicate,
    relationName,
  );
  // Match the existing relation exporter's first-occurrence input ordering.
  const inputs = [
    ...new Set(
      rules.flatMap((rule) =>
        rule.body.flatMap((atom) =>
          atom.$type === "Literal" && atom.predicate !== predicate ? [atom.predicate] : [],
        ),
      ),
    ),
  ];
  const params = inputs.map(
    (input, i) =>
      `(input${i} : ${[...typed.columnTypes.get(input)!.map(() => "Datamog.SafeInt"), "Prop"].join(" → ")})`,
  );
  const application = `${relationName} ${inputs.map((_, i) => `input${i}`).join(" ")} ${columns.join(" ")}`;
  const statement = `def ${id} : Prop :=\n  ∀ ${[...params, ...columns.map((column) => `(${column} : Datamog.SafeInt)`)].join(" ")},\n  ${application} → (${contract})\n`;
  const refute = claim.polarity === "refute";
  const proofName = refute ? `${id}_refuted` : id;
  if (proofName === relationName) throw new Error("Conflicting invariant proof name");
  const expected = `${refute ? "¬ " : ""}Generated.${id}`;
  const nodes: VerificationNode[] = [
    {
      id: relationName,
      kind: "definition",
      statement: { predicate, inputs, source: relation },
      assumptions: [],
      dependencies: ["IntegerSemantics"],
    },
    {
      id,
      kind: refute ? "definition" : "goal",
      ...(refute ? {} : { theorem: `Datamog.Checked.${id}` }),
      statement: { claim, source: statement },
      assumptions: [],
      dependencies: [relationName],
    },
  ];
  if (refute)
    nodes.push({
      id: proofName,
      kind: "goal",
      theorem: `Datamog.Checked.${proofName}`,
      statement: { negationOf: id, expected },
      assumptions: [],
      dependencies: [id],
    });
  return {
    source: `${relation}\n${statement}`,
    nodes,
    checker: `theorem ${proofName} : ${expected} := Proofs.${proofName}\n#audit ${proofName}\n`,
  };
}

export function invariantContract(typed: TypedProgram, predicate: string) {
  const rules = typed.rules.get(predicate);
  if (!rules?.length || rules.some((rule) => !rule.head.refinements?.length))
    throw new Error("Invariant requires refinements on every defining rule");
  const arity = rules[0]!.head.args.length;
  const columns = Array.from({ length: arity }, (_, i) => `x${i}`);
  const contracts = rules.map((rule) => {
    const positions = new Map<string, number>();
    rule.head.positionNames?.forEach((name, i) => {
      if (name !== undefined) positions.set(name, i);
    });
    const term = (expr: HeadTerm): string => {
      if (expr.$type === "Variable" && positions.has(expr.name))
        return `${columns[positions.get(expr.name)!]}.val`;
      if (
        expr.$type === "NumberLiteral" &&
        !isFloatLiteral(expr) &&
        Number.isSafeInteger(expr.value)
      )
        return `(${expr.value} : Int)`;
      if (
        expr.$type === "UnaryExpr" &&
        expr.op === "-" &&
        expr.operand.$type === "NumberLiteral" &&
        !isFloatLiteral(expr.operand) &&
        Number.isSafeInteger(expr.operand.value)
      )
        return `(${-expr.operand.value} : Int)`;
      throw new Error("Unsupported invariant contract term");
    };
    const operators: Record<string, string> = {
      "<": "<",
      "<=": "≤",
      ">": ">",
      ">=": "≥",
      "=": "=",
    };
    return `(${rule.head
      .refinements!.map(({ formula }) => {
        if (formula.$type !== "BinaryExpr" || !Object.hasOwn(operators, formula.op))
          throw new Error("Invariant contracts require simple integer comparisons");
        return `(${term(formula.left)} ${operators[formula.op]} ${term(formula.right)})`;
      })
      .join(" ∧ ")})`;
  });
  return { columns, contract: contracts.join(" ∨ ") };
}
