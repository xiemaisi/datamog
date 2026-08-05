import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { findNullnessRisks } from "../src/nullness-diagnostics.ts";
import { inferTypes } from "../src/types.ts";

// Warnings for the two shapes where a NULL goes unnoticed: a filter that
// evaluates to one, and two comparisons that look like a partition but are not.
// See doc/design/nullness-tracking.md §1, payoff 2.

function risks(source: string) {
  return findNullnessRisks(inferTypes(analyze(parse(source))));
}

function codes(source: string): string[] {
  return risks(source).map((d) => d.code);
}

describe("nullable filter", () => {
  test("a nullable boolean column in filter position warns", () => {
    const source = `
      input predicate p(a: integer, ok: boolean?).
      q(X) :- p(X, B), B.
    `;
    expect(codes(source)).toEqual(["nullable-filter"]);
    expect(risks(source)[0]!.message).toContain("<> null");
  });

  test("a total comparison does not warn", () => {
    // Comparison is total, so an ordering filter on a nullable column never
    // evaluates to NULL and this warning is not the right one for it.
    const source = `
      input predicate p(a: integer?).
      q(X) :- p(X), X < 2.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("a partial projection into boolean position warns", () => {
    // Written `!as_boolean(V)` rather than bare: a body element of the shape
    // `name(args)` parses as an atom, so the bare call would be read as a
    // reference to an undefined predicate.
    const source = `
      input predicate p(v: value).
      q(V) :- p(V), !as_boolean(V).
    `;
    expect(codes(source)).toEqual(["nullable-filter"]);
  });

  test("a guarded nullable boolean does not warn", () => {
    const source = `
      input predicate p(a: integer, ok: boolean?).
      q(X) :- p(X, B), B <> null, B.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("a non-null boolean column does not warn", () => {
    const source = `
      input predicate p(a: integer, ok: boolean).
      q(X) :- p(X, B), B.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("a NULL propagated through a connective warns", () => {
    const source = `
      input predicate p(a: integer?, ok: boolean?).
      q(X) :- p(X, B), B && (X < 2).
    `;
    expect(codes(source)).toEqual(["nullable-filter"]);
  });
});

describe("ordering gap", () => {
  test("complementary comparisons across two rules warn once", () => {
    const source = `
      input predicate p(a: integer?).
      lo(X) :- p(X), X < 2.
      hi(X) :- p(X), X >= 2.
    `;
    expect(codes(source)).toEqual(["nullable-ordering-gap"]);
    expect(risks(source)[0]!.message).toContain("leave out NULL");
  });

  test("`<=` pairs with `>`", () => {
    const source = `
      input predicate p(a: integer?).
      lo(X) :- p(X), X <= 2.
      hi(X) :- p(X), X > 2.
    `;
    expect(codes(source)).toEqual(["nullable-ordering-gap"]);
  });

  test("a non-null column has no gap to warn about", () => {
    const source = `
      input predicate p(a: integer).
      lo(X) :- p(X), X < 2.
      hi(X) :- p(X), X >= 2.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("a guard in both branches closes the gap", () => {
    const source = `
      input predicate p(a: integer?).
      lo(X) :- p(X), X <> null, X < 2.
      hi(X) :- p(X), X <> null, X >= 2.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("non-complementary comparisons do not warn", () => {
    // `<` and `>` leave out the boundary value too, but that is an ordinary
    // logic slip rather than the NULL gap this warning is about.
    const source = `
      input predicate p(a: integer?).
      lo(X) :- p(X), X < 2.
      hi(X) :- p(X), X > 2.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("both halves in one body is a contradiction, not a gap", () => {
    const source = `
      input predicate p(a: integer?).
      none(X) :- p(X), (X < 2) && (X >= 2).
    `;
    expect(codes(source)).toEqual([]);
  });

  test("different operands do not pair up", () => {
    const source = `
      input predicate p(a: integer?, b: integer?).
      lo(X) :- p(X, _), X < 2.
      hi(Y) :- p(_, Y), Y >= 2.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("a query body counts as one of the two sides", () => {
    const source = `
      input predicate p(a: integer?).
      lo(X) :- p(X), X < 2.
      ?- p(X), X >= 2.
    `;
    expect(codes(source)).toEqual(["nullable-ordering-gap"]);
  });
});
