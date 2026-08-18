import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { findNullnessRisks } from "../src/nullness-diagnostics.ts";
import { inferTypes } from "../src/types.ts";

// The `defined(e)` builtin, doc/design/null-as-a-value.md §11.6. Its polarity is
// the whole design: strictness makes an undefined argument leave the call without
// a value, so `defined(e)` fails there and `not (defined(e))` holds. The runtime
// behaviour is checked against every backend in the executor and evaluator
// suites; this pins the static surface.

const check = (source: string) => inferTypes(analyze(parse(source)));
const codes = (source: string) => findNullnessRisks(check(source)).map((d) => d.code);

describe("defined", () => {
  test("takes any base type and answers boolean", () => {
    const typed = check(`
      input predicate p(i: integer, f: float, s: string, b: boolean, v: value).
      q(A, B, C, D, E) :-
        p(I, F, S, Bo, V),
        A = defined(I), B = defined(F), C = defined(S), D = defined(Bo), E = defined(V).
    `);
    expect(typed.columnTypes.get("q")).toEqual([
      "boolean",
      "boolean",
      "boolean",
      "boolean",
      "boolean",
    ]);
  });

  test("takes a nullable argument, unlike every other operation", () => {
    // Position 3 (§5) requires a non-null operand everywhere else. Asking whether
    // something has a value cannot require it to have one, so `defined` is exempt.
    expect(() =>
      check(`
        input predicate p(a: integer?).
        q(B) :- p(A), B = defined(A).
      `),
    ).not.toThrow();
  });

  test("never returns null, so a filter over it is not flagged", () => {
    // It answers for a null rather than propagating one, which is the registry's
    // `strict: false`. Without that the nullable-filter warning fires on a
    // perfectly good guard.
    const source = `
      input predicate p(a: integer?).
      q(A) :- p(A), defined(A).
    `;
    expect(check(source).nullness.columnNullness.get("q")).toEqual([true]);
    expect(codes(source)).toEqual(["constant-defined"]);
  });

  test("`defined(X)` on a bare variable warns, being always true", () => {
    // §11.6's third rider. The trap is that it reads like `X <> null` and is not.
    const source = `
      input predicate p(a: integer?).
      q(A) :- p(A), defined(A).
    `;
    const risks = findNullnessRisks(check(source));
    expect(risks.map((d) => d.code)).toEqual(["constant-defined"]);
    expect(risks[0]!.message).toContain("A <> null");
  });

  test("a compound argument does not warn: that is the useful case", () => {
    const source = `
      input predicate p(a: integer, b: integer).
      q(A) :- p(A, B), defined(10 / B).
    `;
    expect(codes(source)).toEqual([]);
  });

  test("the bare body form works, negated or not", () => {
    // `name(args)` in body position parses as an atom, and post-processing turns
    // this one into a filter carrying the `negated` flag. So `not defined(e)`
    // reads as written and means negation as failure over the condition, which is
    // what makes it hold where `e` has no value.
    expect(() =>
      check(`
        input predicate p(a: integer, b: integer).
        q(A) :- p(A, B), not defined(10 / B).
        r(A) :- p(A, B), defined(10 / B).
      `),
    ).not.toThrow();
  });

  test("a bare call to any other builtin still says what to write", () => {
    expect(() =>
      check(`
        input predicate p(a: string).
        q(A) :- p(A), upper(A).
      `),
    ).toThrow(/'upper' is a built-in function, not a predicate/);
  });

  test("wrong arity is reported at parse time, not as an unknown predicate", () => {
    expect(() =>
      check(`
        input predicate p(a: integer, b: integer).
        q(A) :- p(A, B), defined(A, B).
      `),
    ).toThrow(/'defined' takes 1 argument but is used with 2/);
  });
});
