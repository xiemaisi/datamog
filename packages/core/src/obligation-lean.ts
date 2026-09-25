/** Optional Lean source export. No Lean executable or filesystem dependency. */
import { isFloatLiteral } from "./ast.ts";
import type { LogicalExpression } from "./obligation-ir.ts";
import type { LogicalObligation } from "./obligations.ts";
import type { TypedProgram } from "./types.ts";

function identifier(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    throw new Error(`Invalid Lean declaration name: ${name}`);
  return name;
}

/** Export a local abstract goal as a Prop, retaining every premise of the IR. */
export function exportLeanObligation(goal: LogicalObligation, name: string): string {
  identifier(name);
  const statement = goal.statement;
  if (!statement) throw new Error(`Unsupported Lean goal: ${goal.unsupportedReason}`);
  if (statement.profile !== "datamog-integer-v1") throw new Error("Unsupported Lean profile");
  const names = new Map(
    statement.variables.map((v, i) => [v.name, { name: `v${i}`, sort: v.sort }]),
  );
  if (names.size !== statement.variables.length) throw new Error("Duplicate logical variable");
  const expr = (e: LogicalExpression): string => {
    switch (e.kind) {
      case "integer":
        if (!/^-?(0|[1-9][0-9]*)$/.test(e.value)) throw new Error("Invalid integer literal");
        return `(${e.value} : Int)`;
      case "boolean":
        return e.value ? "True" : "False";
      case "variable": {
        const variable = names.get(e.name);
        if (!variable || variable.sort !== e.sort)
          throw new Error(`Unbound or mistyped variable: ${e.name}`);
        return variable.name;
      }
      case "negate":
        return `(-${expr(e.operand)})`;
      case "not":
        return `(¬ ${expr(e.operand)})`;
      case "junction":
        return e.operands.length === 0
          ? e.op === "and"
            ? "True"
            : "False"
          : `(${e.operands.map(expr).join(e.op === "and" ? " ∧ " : " ∨ ")})`;
      case "boolean-equality":
        return `(${expr(e.left)} ↔ ${expr(e.right)})`;
      case "comparison":
        return `(${expr(e.left)} ${e.op} ${expr(e.right)})`;
      case "arithmetic":
        return e.op === "trunc-div"
          ? `(Datamog.truncDiv ${expr(e.left)} ${expr(e.right)})`
          : `(${expr(e.left)} ${e.op} ${expr(e.right)})`;
    }
  };
  const binders = statement.variables
    .map((v, i) => `(v${i} : ${v.sort === "integer" ? "Int" : "Prop"})`)
    .join(" ");
  const body = [...statement.domains, ...statement.hypotheses, statement.conclusion]
    .map(expr)
    .join(" →\n  ");
  // Source names never enter Lean syntax; this also avoids keyword/name capture.
  return `def ${name} : Prop :=\n  ${binders ? `∀ ${binders},\n  ` : ""}${body}\n`;
}

/**
 * Spike fragment: one positive (possibly self-recursive) relation, over non-null
 * integers, with variable-only body atoms and variable or variable-plus-integer
 * heads. Other computed terms, derived calls, mutual recursion, negation,
 * constraints and aggregates are rejected explicitly.
 * Inputs are arbitrary relations over SafeInt; finite derivations form the LFP.
 */
export function exportLeanRelation(typed: TypedProgram, predicate: string, name: string): string {
  identifier(name);
  const rules = typed.rules.get(predicate);
  if (!rules?.length) throw new Error("Lean relation has no defining rules");
  if (typed.constraints.length || typed.maximalPredicates.size)
    throw new Error("Unsupported Lean relation constraints or parity");
  const inputs = new Map<string, number>();
  const relationType = (p: string) => {
    const columns = typed.columnTypes.get(p);
    const nullable = typed.nullness.publishedNullness.get(p);
    if (!columns || !nullable || columns.some((c) => c !== "integer") || nullable.some(Boolean)) {
      throw new Error("Lean relation requires non-null integer columns");
    }
    return [...columns.map(() => "Datamog.SafeInt"), "Prop"].join(" → ");
  };
  for (const rule of rules) {
    if (rule.head.refinements?.length) throw new Error("Unsupported Lean relation refinement");
    for (const atom of rule.body) {
      if (atom.$type !== "Literal" || atom.negated)
        throw new Error("Unsupported Lean relation body");
      if (atom.predicate !== predicate) {
        if (!typed.extDecls.has(atom.predicate))
          throw new Error("Unsupported Lean derived dependency");
        if (!inputs.has(atom.predicate)) inputs.set(atom.predicate, inputs.size);
      }
    }
  }
  const params = [...inputs].map(([p, i]) => `(input${i} : ${relationType(p)})`).join(" ");
  const result = `${name}${[...inputs.values()].map((i) => ` input${i}`).join("")}`;
  const constructors = rules.map((rule, i) => {
    const variables = new Map<string, string>();
    const computed: string[] = [];
    const defined: string[] = [];
    const variable = (name: string) => {
      if (!variables.has(name)) variables.set(name, `v${variables.size}`);
      return variables.get(name)!;
    };
    const terms = (args: typeof rule.head.args, head = false) =>
      args
        .map((arg) => {
          if (arg.$type === "Variable") return variable(arg.name);
          if (
            head &&
            arg.$type === "BinaryExpr" &&
            arg.op === "+" &&
            arg.left.$type === "Variable" &&
            arg.right.$type === "NumberLiteral" &&
            !isFloatLiteral(arg.right) &&
            Number.isSafeInteger(arg.right.value)
          ) {
            const input = variable(arg.left.name);
            const output = `w${computed.length}`;
            computed.push(output);
            // A bounded output witness enforces head definedness. Coverage must
            // construct that witness; overflow has no constructor instance.
            defined.push(`(${output}.val = ${input}.val + (${arg.right.value} : Int))`);
            return output;
          }
          throw new Error("Unsupported Lean relation term");
        })
        .join(" ");
    const head = `${result} ${terms(rule.head.args, true)}`.trim();
    const body = rule.body.map((atom) => {
      if (atom.$type !== "Literal") throw new Error("Unsupported Lean relation body");
      const callee = atom.predicate === predicate ? result : `input${inputs.get(atom.predicate)}`;
      return `(${callee} ${terms(atom.args)})`;
    });
    const binders = [...variables.values(), ...computed]
      .map((v) => `(${v} : Datamog.SafeInt)`)
      .join(" ");
    return `  | rule${i} ${binders} : ${[...body, ...defined, head].join(" → ")}`;
  });
  return `inductive ${name} ${params} : ${relationType(predicate)} where\n${constructors.join("\n")}\n`;
}
