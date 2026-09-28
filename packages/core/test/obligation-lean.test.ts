import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { exportLeanObligation, exportLeanRelation } from "../src/obligation-lean.ts";
import { generateLogicalObligations } from "../src/obligations.ts";
import { inferTypes } from "../src/types.ts";

const typed = (source: string) => inferTypes(analyze(parse(source)));
const goal = (source: string) => generateLogicalObligations(typed(source))[0]!;

describe("optional Lean export", () => {
  test("retains bounds, nullness, definedness, and quantification without source identifiers", () => {
    const output = exportLeanObligation(
      goal(`
      input predicate p(x: integer?, y: integer).
      q(X, Y, _: X / Y > 0) :- p(X, Y), Y <> 0.
    `),
      "claim",
    );
    expect(output).toContain("∀ (v0 : Int) (v1 : Prop) (v2 : Int)");
    expect(output).toContain("9007199254740991");
    expect(output).toContain("Datamog.truncDiv");
    expect(output).toContain("¬ v1");
    expect(output).toContain("→");
    expect(output).not.toContain("X");
  });

  test("unsupported structural goals cannot become Lean True", () => {
    const unsupported = goal("input predicate p(x: value). q(X, _: X = [1]) :- p(X).");
    expect(unsupported.statement).toBeNull();
    expect(() => exportLeanObligation(unsupported, "claim")).toThrow("Unsupported Lean goal");
  });

  test("declaration names cannot inject Lean commands", () => {
    expect(() =>
      exportLeanObligation(goal("p(1 as X, _: X > 0)."), "x\naxiom bad : False"),
    ).toThrow("Invalid Lean declaration name");
  });

  test("reachability constructors come from both defining rules", () => {
    const output = exportLeanRelation(
      typed(`
      input predicate edge(a: integer, b: integer).
      reach(X, Y) :- edge(X, Y).
      reach(X, Z) :- reach(X, Y), edge(Y, Z).
    `),
      "reach",
      "Reach",
    );
    expect(output).toContain("inductive Reach (input0 : Datamog.SafeInt → Datamog.SafeInt → Prop)");
    expect(output).toContain("| rule0");
    expect(output).toContain("| rule1");
    expect(output).toContain("(Reach input0 v0 v2) → (input0 v2 v1) → Reach input0 v0 v1");
  });

  test("computed integer heads require a bounded output witness", () => {
    const output = exportLeanRelation(
      typed("input predicate p(x: integer). q(X, X + 1) :- p(X)."),
      "q",
      "Q",
    );
    expect(output).toContain("(w0 : Datamog.SafeInt)");
    expect(output).toContain("(w0.val = v0.val + (1 : Int)) → Q input0 v0 w0");
  });

  test.each([
    ["X < 0", "(v0.val < (0 : Int))"],
    ["X <= 7", "(v0.val ≤ (7 : Int))"],
    ["0 > X", "((0 : Int) > v0.val)"],
    ["7 >= X", "((7 : Int) ≥ v0.val)"],
    ["X >= -7", "(v0.val ≥ (-7 : Int))"],
    ["X < Y", "(v0.val < v1.val)"],
  ])("integer guard %s is a constructor premise", (guard, expected) => {
    const output = exportLeanRelation(
      typed(`input predicate p(x: integer, y: integer). q(X, Y) :- ${guard}, p(X, Y).`),
      "q",
      "Q",
    );
    expect(output).toContain(`${expected} → (input0 v0 v1) → Q input0 v0 v1`);
  });

  test.each([
    "not X < 0",
    "X < 0.5",
    "X < 9007199254740992",
    "X < 1.0",
    "X / 0 < 1",
    "X < 0 || X > 1",
    "X <> 0",
  ])("unsupported guard %s fails explicitly", (guard) => {
    expect(() =>
      exportLeanRelation(typed(`input predicate p(x: integer). q(X) :- p(X), ${guard}.`), "q", "Q"),
    ).toThrow();
  });

  test.each([
    "input predicate p(x: integer?). q(X) :- p(X).",
    "input predicate p(x: integer). q(X * 2) :- p(X).",
    "input predicate p(x: integer). q((X + 1) + 1) :- p(X).",
    "input predicate p(x: integer). q(X) :- p(X + 1).",
    "input predicate p(x: integer). q(X) :- p(X), not p(X).",
    "input predicate p(x: integer). q(X) :- p(X), X + 1 > 0.",
    "input predicate p(x: integer). q(X) :- p(X). q(X) :- r(X). r(X) :- q(X).",
  ])("rejects unsupported relational semantics: %s", (source) => {
    expect(() => exportLeanRelation(typed(source), "q", "Q")).toThrow();
  });
});
