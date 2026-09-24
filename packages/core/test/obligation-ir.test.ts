import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import {
  type BooleanExpression,
  FALSE,
  type IntegerExpression,
  type LogicalExpression,
} from "../src/obligation-ir.ts";
import { exportSmtObligation } from "../src/obligation-smt.ts";
import { generateLogicalObligations, generateObligations } from "../src/obligations.ts";
import { inferTypes } from "../src/types.ts";

const typed = (source: string) => inferTypes(analyze(parse(source)));
const goals = (source: string) => generateLogicalObligations(typed(source));
type Environment = Record<string, bigint | boolean>;

// Independent interpretation using BigInt arithmetic, never SMT syntax.
function evaluate(expr: IntegerExpression, env: Environment): bigint;
function evaluate(expr: BooleanExpression, env: Environment): boolean;
function evaluate(expr: LogicalExpression, env: Environment): bigint | boolean {
  switch (expr.kind) {
    case "integer":
      return BigInt(expr.value);
    case "boolean":
      return expr.value;
    case "variable": {
      const value = env[expr.name];
      if (expr.sort === "integer" ? typeof value !== "bigint" : typeof value !== "boolean") {
        throw new Error(`Unbound or mistyped variable ${expr.name}`);
      }
      return value!;
    }
    case "negate":
      return -evaluate(expr.operand, env);
    case "not":
      return !evaluate(expr.operand, env);
    case "junction":
      return expr.op === "and"
        ? expr.operands.every((e) => evaluate(e, env))
        : expr.operands.some((e) => evaluate(e, env));
    case "boolean-equality":
      return evaluate(expr.left, env) === evaluate(expr.right, env);
    case "comparison": {
      const l = evaluate(expr.left, env);
      const r = evaluate(expr.right, env);
      switch (expr.op) {
        case "<":
          return l < r;
        case ">":
          return l > r;
        case "<=":
          return l <= r;
        case ">=":
          return l >= r;
        case "=":
          return l === r;
        default:
          throw new Error("Unknown comparison");
      }
    }
    case "arithmetic": {
      const l = evaluate(expr.left, env);
      const r = evaluate(expr.right, env);
      switch (expr.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "trunc-div":
          return r === 0n ? 0n : l / r;
      }
    }
  }
}

describe("logical obligation statements", () => {
  test("separates typed variables, domain premises, hypotheses, and conclusion", () => {
    const source = "input predicate p(x: integer?). q(X, _: X > 0) :- p(X).";
    const [goal] = goals(source);
    const statement = goal!.statement!;
    expect(goal!.kind).toBe("head-refinement");
    expect(statement.profile).toBe("datamog-integer-v1");
    expect(statement.variables).toEqual([
      { name: "X", sort: "integer" },
      { name: "X$null", sort: "boolean" },
    ]);
    expect(statement.domains).toHaveLength(1);
    expect(statement.hypotheses).toEqual([]);
    expect(statement.conclusion.sort).toBe("boolean");
    expect(source.slice(goal!.source.offset, goal!.source.end)).toBe("X > 0");
    expect(evaluate(statement.conclusion, { X: 1n, X$null: false })).toBe(true);
    expect(evaluate(statement.conclusion, { X: 1n, X$null: true })).toBe(false);
    expect(evaluate(statement.domains[0]!, { X: 9007199254740992n })).toBe(false);
  });

  test("IR survives JSON round trips and alone determines SMT export", () => {
    const program = typed("p(1). q(X, _: X >= 0) :- p(X), X >= 0.");
    const logical = generateLogicalObligations(program);
    const roundtrip = JSON.parse(JSON.stringify(logical)) as typeof logical;
    expect(roundtrip.map(exportSmtObligation)).toEqual(generateObligations(program));
    const goal = roundtrip[0]!;
    const changed = exportSmtObligation({
      ...goal,
      statement: { ...goal.statement!, conclusion: FALSE },
    });
    expect(changed.script).toContain("(assert (not false))");
    expect("script" in goal).toBe(false);
    expect("logic" in goal).toBe(false);
  });

  test.each(["/", "%"])("%s keeps truncating signs and rejects zero divisors", (op) => {
    const [goal] = goals(`
      input predicate p(x: integer, y: integer, z: integer).
      q(X, Y, Z, _: X ${op} Y = Z) :- p(X, Y, Z).
    `);
    for (let x = -8; x <= 8; x++) {
      for (let y = -4; y <= 4; y++) {
        const z = y === 0 ? 0 : op === "/" ? Math.trunc(x / y) : x % y;
        const env = { X: BigInt(x), Y: BigInt(y), Z: BigInt(z) };
        expect(evaluate(goal!.statement!.conclusion, env)).toBe(y !== 0);
        if (y !== 0) {
          expect(evaluate(goal!.statement!.conclusion, { ...env, Z: env.Z + 1n })).toBe(false);
        }
      }
    }
  });

  test("overflow is a conclusion failure, but head definedness is a premise", () => {
    const [local] = goals("input predicate p(x: integer). q(X, _: X + 1 > X) :- p(X).");
    expect(evaluate(local!.statement!.conclusion, { X: 9007199254740990n })).toBe(true);
    expect(evaluate(local!.statement!.conclusion, { X: 9007199254740991n })).toBe(false);
    const [head] = goals("input predicate p(x: integer). q(X, X + 1 as Y, _: Y > X) :- p(X).");
    const premises = head!.statement!.hypotheses;
    expect(
      premises.every((p) =>
        evaluate(p, { X: 9007199254740990n, Y: 9007199254740991n, Y$null: false }),
      ),
    ).toBe(true);
    expect(
      premises.every((p) =>
        evaluate(p, { X: 9007199254740991n, Y: 9007199254740992n, Y$null: false }),
      ),
    ).toBe(false);
  });

  test("dominating Booleans and negation-as-failure retain definedness", () => {
    const [or] = goals("input predicate p(x: integer). q(X, _: X > 0 || X / 0 > 0) :- p(X).");
    expect(evaluate(or!.statement!.conclusion, { X: 1n })).toBe(true);
    expect(evaluate(or!.statement!.conclusion, { X: -1n })).toBe(false);
    const [negative] = goals(
      "input predicate p(x: integer). q(X, _: X > 0) :- p(X), not (X / 0 > 0).",
    );
    expect(negative!.statement!.hypotheses.every((p) => evaluate(p, { X: 1n }))).toBe(true);
  });

  test("unsupported goals retain a reason without a fake logical statement", () => {
    const [goal] = goals('input predicate p(x: string). q(X, _: X = "yes") :- p(X).');
    expect(goal!.statement).toBeNull();
    expect(goal!.unsupportedReason).toContain("a string variable");
    expect(exportSmtObligation(goal!).logic).toBeNull();
  });
});
