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

  test.each([
    "input predicate p(x: integer?). q(X) :- p(X).",
    "input predicate p(x: integer). q(X + 1) :- p(X).",
    "input predicate p(x: integer). q(X) :- p(X), not p(X).",
    "input predicate p(x: integer). q(X) :- p(X), X > 0.",
    "input predicate p(x: integer). q(X) :- p(X). q(X) :- r(X). r(X) :- q(X).",
  ])("rejects unsupported relational semantics: %s", (source) => {
    expect(() => exportLeanRelation(typed(source), "q", "Q")).toThrow();
  });
});
