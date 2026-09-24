/** SMT-LIB export for the typed integer obligation IR. */
import type { IntegerExpression, LogicalExpression } from "./obligation-ir.ts";
import type { LogicalObligation, Obligation } from "./obligations.ts";

function numeral(expr: IntegerExpression): bigint | undefined {
  if (expr.kind === "integer") return BigInt(expr.value);
  if (expr.kind === "negate" && expr.operand.kind === "integer") return -BigInt(expr.operand.value);
  return undefined;
}

function absolute(expr: IntegerExpression): string {
  const n = numeral(expr);
  return n === undefined ? `(abs ${expressionToSmt(expr)})` : String(n < 0n ? -n : n);
}

/** The integer IR uses truncation toward zero, never SMT's signed div convention. */
export function expressionToSmt(expr: LogicalExpression): string {
  switch (expr.kind) {
    case "integer":
      return expr.value.startsWith("-") ? `(- ${expr.value.slice(1)})` : expr.value;
    case "boolean":
      return String(expr.value);
    case "variable":
      return expr.name;
    case "negate":
      return `(- ${expressionToSmt(expr.operand)})`;
    case "not":
      return `(not ${expressionToSmt(expr.operand)})`;
    case "junction":
      return `(${expr.op}${expr.operands.map((e) => ` ${expressionToSmt(e)}`).join("")})`;
    case "comparison":
      return `(${expr.op} ${expressionToSmt(expr.left)} ${expressionToSmt(expr.right)})`;
    case "boolean-equality":
      return `(= ${expressionToSmt(expr.left)} ${expressionToSmt(expr.right)})`;
    case "arithmetic": {
      const a = expressionToSmt(expr.left);
      const b = expressionToSmt(expr.right);
      if (expr.op !== "trunc-div") return `(${expr.op} ${a} ${b})`;
      const magnitude = `(div ${absolute(expr.left)} ${absolute(expr.right)})`;
      const divisor = numeral(expr.right);
      const positive =
        divisor === undefined
          ? `(>= (* ${a} ${b}) 0)`
          : divisor < 0n
            ? `(< ${a} 0)`
            : `(>= ${a} 0)`;
      return `(ite (= ${b} 0) 0 (ite ${positive} ${magnitude} (- ${magnitude})))`;
    }
  }
}

function nonlinear(expr: LogicalExpression): boolean {
  switch (expr.kind) {
    case "integer":
    case "boolean":
    case "variable":
      return false;
    case "negate":
    case "not":
      return nonlinear(expr.operand);
    case "junction":
      return expr.operands.some(nonlinear);
    case "comparison":
    case "boolean-equality":
      return nonlinear(expr.left) || nonlinear(expr.right);
    case "arithmetic":
      return (
        (expr.op === "*" &&
          numeral(expr.left) === undefined &&
          numeral(expr.right) === undefined) ||
        (expr.op === "trunc-div" && numeral(expr.right) === undefined) ||
        nonlinear(expr.left) ||
        nonlinear(expr.right)
      );
  }
}

/** Compatibility adapter: all solver text is derived from the logical statement. */
export function exportSmtObligation(obligation: LogicalObligation): Obligation {
  const { statement } = obligation;
  const title = `; ${obligation.predicate} rule ${obligation.rule}: ${obligation.claim}`;
  if (!statement)
    return {
      ...obligation,
      logic: null,
      declared: [],
      script: `${title}\n; not emitted, ${obligation.unsupportedReason}`,
    };
  const expressions = [...statement.domains, ...statement.hypotheses, statement.conclusion];
  return {
    ...obligation,
    logic: expressions.some(nonlinear) ? "QF_NIA" : "QF_LIA",
    declared: statement.variables.map((v) => v.name),
    script: [
      title,
      "(push 1)",
      ...statement.variables.map(
        (v) => `(declare-const ${v.name} ${v.sort === "integer" ? "Int" : "Bool"})`,
      ),
      ...[...statement.domains, ...statement.hypotheses].map(
        (e) => `(assert ${expressionToSmt(e)})`,
      ),
      `(assert (not ${expressionToSmt(statement.conclusion)}))`,
      "(check-sat) ; unsat discharges the obligation",
      "(pop 1)",
    ].join("\n"),
  };
}
