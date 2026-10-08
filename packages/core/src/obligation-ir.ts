/**
 * Internal logical language for the integer verification profile. Expressions
 * are mathematical values; Datamog nullness and partiality are separate Boolean
 * expressions constructed by obligations.ts. No node contains prover syntax.
 */
export type IntegerExpression = { readonly sort: "integer" } & (
  | { readonly kind: "integer"; readonly value: string }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "negate"; readonly operand: IntegerExpression }
  | {
      readonly kind: "arithmetic";
      /** trunc-div truncates toward zero; its totalized value at zero divisor is 0.
       * Datamog definedness must separately exclude a zero divisor. */
      readonly op: "+" | "-" | "*" | "trunc-div";
      readonly left: IntegerExpression;
      readonly right: IntegerExpression;
    }
);

export type BooleanExpression = { readonly sort: "boolean" } & (
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "not"; readonly operand: BooleanExpression }
  | {
      readonly kind: "junction";
      readonly op: "and" | "or";
      readonly operands: readonly BooleanExpression[];
    }
  | {
      readonly kind: "comparison";
      readonly op: "<" | ">" | "<=" | ">=" | "=";
      readonly left: IntegerExpression;
      readonly right: IntegerExpression;
    }
  | {
      readonly kind: "boolean-equality";
      readonly left: BooleanExpression;
      readonly right: BooleanExpression;
    }
);

export type LogicalExpression = IntegerExpression | BooleanExpression;
export interface LogicalVariable {
  readonly name: string;
  readonly sort: "integer" | "boolean";
}

/** Universally quantified variables: domains ∧ hypotheses ⇒ conclusion. */
export interface ObligationStatement {
  readonly profile: "datamog-integer-v1";
  readonly variables: readonly LogicalVariable[];
  readonly domains: readonly BooleanExpression[];
  readonly hypotheses: readonly BooleanExpression[];
  readonly conclusion: BooleanExpression;
}

export const TRUE: BooleanExpression = { sort: "boolean", kind: "boolean", value: true };
export const FALSE: BooleanExpression = { sort: "boolean", kind: "boolean", value: false };

export function integer(value: number): IntegerExpression {
  if (!Number.isSafeInteger(value)) throw new Error("IR integer literal must be a safe integer");
  return { sort: "integer", kind: "integer", value: String(value) };
}

export function integerVariable(name: string): IntegerExpression {
  return { sort: "integer", kind: "variable", name };
}

export function booleanVariable(name: string): BooleanExpression {
  return { sort: "boolean", kind: "variable", name };
}

export function negate(operand: IntegerExpression): IntegerExpression {
  return { sort: "integer", kind: "negate", operand };
}

export function arithmetic(
  op: "+" | "-" | "*" | "trunc-div",
  left: IntegerExpression,
  right: IntegerExpression,
): IntegerExpression {
  return { sort: "integer", kind: "arithmetic", op, left, right };
}

export function compare(
  op: "<" | ">" | "<=" | ">=" | "=",
  left: IntegerExpression,
  right: IntegerExpression,
): BooleanExpression {
  return { sort: "boolean", kind: "comparison", op, left, right };
}

export function not(operand: BooleanExpression): BooleanExpression {
  return { sort: "boolean", kind: "not", operand };
}

export function junction(
  op: "and" | "or",
  operands: readonly BooleanExpression[],
): BooleanExpression {
  return { sort: "boolean", kind: "junction", op, operands };
}

export function isBoolean(expr: BooleanExpression, value: boolean): boolean {
  return expr.kind === "boolean" && expr.value === value;
}

export function and(...operands: BooleanExpression[]): BooleanExpression {
  const live = operands.filter((expr) => !isBoolean(expr, true));
  return live.length === 0 ? TRUE : live.length === 1 ? live[0]! : junction("and", live);
}

export function or(...operands: BooleanExpression[]): BooleanExpression {
  const live = operands.filter((expr) => !isBoolean(expr, false));
  return live.length === 0 ? FALSE : live.length === 1 ? live[0]! : junction("or", live);
}
