import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { findNullnessRisks } from "../src/nullness-diagnostics.ts";
import { inferTypes } from "../src/types.ts";

// Warnings for the shapes where a NULL goes unnoticed: a filter that evaluates
// to one, two comparisons that look like a partition but are not, and a negated
// ordering, which keeps the NULL row rather than excluding it.
// See doc/design/nullness-tracking.md §1, payoff 2.

function risks(source: string) {
  return findNullnessRisks(inferTypes(analyze(parse(source))));
}

function undefinedRisks(source: string) {
  return findNullnessRisks(inferTypes(analyze(parse(source))), { warnUndefined: true });
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

  test("a partial projection into boolean position warns about nothing", () => {
    // `as_boolean` of a non-boolean has no value rather than a null one, so this
    // no longer reaches boolean position at all. Nor is it the undefined-expression
    // warning's business: that one exists because an undefined *value* leaves the
    // row absent with nothing to say so, whereas an undefined filter drops its row
    // exactly as the old NULL did, which is a filter's job either way.
    //
    // Written `!as_boolean(V)` rather than bare because a body element of the
    // shape `name(args)` parses as an atom, so the bare call would be read as a
    // reference to an undefined predicate.
    const source = `
      input predicate p(v: value).
      q(V) :- p(V), !as_boolean(V).
    `;
    expect(codes(source)).toEqual([]);
    expect(undefinedRisks(source)).toEqual([]);
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

describe("negated ordering", () => {
  const decl = "input predicate p(a: integer?).\n";

  test("negating an ordering on a nullable operand warns", () => {
    // `X < 2` has no value at a null, so it does not hold, so `not (X < 2)` does
    // and the row stays, where the complement `X >= 2` drops it.
    expect(codes(`${decl}q(X) :- p(X), not (X < 2).`)).toEqual(["nullable-negated-ordering"]);
  });

  test("every ordering operator is covered", () => {
    for (const op of ["<", "<=", ">", ">="]) {
      expect(codes(`${decl}q(X) :- p(X), not (X ${op} 2).`)).toEqual(["nullable-negated-ordering"]);
    }
  });

  test("a guard that proves the operand non-null silences it", () => {
    expect(codes(`${decl}q(X) :- p(X), X <> null, not (X < 2).`)).toEqual([]);
  });

  test("a non-null operand never warns", () => {
    const nonNull = "input predicate p(a: integer).\n";
    expect(codes(`${nonNull}q(X) :- p(X), not (X < 2).`)).toEqual([]);
  });

  test("a plain ordering is not this warning", () => {
    expect(codes(`${decl}q(X) :- p(X), X < 2.`)).toEqual([]);
  });

  test("the expression operator has no gap, so it does not warn", () => {
    // `!` propagates the absence rather than complementing it, so `!(X < 2)`
    // drops the null row exactly as `X >= 2` does. Verified on native and sqlite:
    // over `p(1). p(5). p(null).` both give `{5}` where `not (X < 2)` gives
    // `{5, null}`. Only the `not` spelling diverges from the complement.
    expect(codes(`${decl}q(X) :- p(X), !(X < 2).`)).toEqual([]);
    expect(codes(`${decl}q(X) :- p(X), !(!(X < 2)).`)).toEqual([]);
  });

  test("but a `!` inside a `not` still warns, the `not` deciding the outcome", () => {
    // `!(X < 2)` has no value at a null, and `not` holds of that, so the row
    // stays. The gap belongs to the outermost construct.
    expect(codes(`${decl}q(X) :- p(X), not (!(X < 2)).`)).toEqual(["nullable-negated-ordering"]);
  });

  test("it reaches an ordering nested under a connective", () => {
    expect(codes(`${decl}q(X) :- p(X), not ((X < 2) && (X > 0)).`)).toEqual([
      "nullable-negated-ordering",
      "nullable-negated-ordering",
    ]);
  });
});

describe("undefined expressions (opt-in)", () => {
  // The mitigation for partiality's one real cost: a rule can derive fewer
  // tuples than its body suggests and nothing in the output says so.
  // See doc/design/null-as-a-value.md §14.1 and §15.14.

  test("a partial expression in a binding equality warns, naming it", () => {
    const source = `
      input predicate n(x: integer).
      q(X, Y) :- n(X), Y = 10 / X.
    `;
    const ds = undefinedRisks(source);
    expect(ds.map((d) => d.code)).toEqual(["undefined-expression"]);
    expect(ds[0]!.message).toContain("10 / X");
    expect(ds[0]!.severity).toBe("warning");
  });

  test("a partial expression in a head argument warns too", () => {
    const source = `
      input predicate n(x: integer).
      q(10 / X) :- n(X).
    `;
    expect(undefinedRisks(source).map((d) => d.code)).toEqual(["undefined-expression"]);
  });

  test("it is off unless asked for", () => {
    // Measured, not assumed: on by default this fires 192 times across
    // `examples/`, because partial operations are pervasive and usually
    // deliberate. §15.14 records the measurement and the decision.
    const source = `
      input predicate n(x: integer).
      q(X, Y) :- n(X), Y = 10 / X.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("a total expression does not warn", () => {
    const source = `
      input predicate n(x: integer).
      q(X, Y) :- n(X), Y = X & 1.
    `;
    expect(undefinedRisks(source)).toEqual([]);
  });

  test("one warning per rule, not one per partial operation", () => {
    // A rule that divides twice has one problem, not two.
    const source = `
      input predicate n(x: integer, y: integer).
      q(A, B) :- n(X, Y), A = 10 / X, B = 10 / Y.
    `;
    expect(undefinedRisks(source)).toHaveLength(1);
  });

  test("a null literal is not undefined, so it does not warn", () => {
    // The distinction the whole design rests on: a `null` is a value.
    const source = `
      input predicate n(x: integer).
      q(X, null) :- n(X).
    `;
    expect(undefinedRisks(source)).toEqual([]);
  });
});

describe("`<>` on a partial operand", () => {
  // The flagship divergence of doc/design/null-as-a-value.md §4.2, and the whole
  // mitigation for it. On by default, unlike the general partiality warning: it
  // fires once across the 76 single-file examples, where that one fires 192 times.

  test("warns and names the other reading", () => {
    const source = `
      input predicate n(x: integer, y: integer).
      q(X) :- n(X, Y), X <> 10 / Y.
    `;
    const ds = risks(source);
    expect(ds.map((d) => d.code)).toEqual(["partial-inequality"]);
    expect(ds[0]!.message).toContain("10 / Y");
    expect(ds[0]!.message).toContain("not (a = b)");
  });

  test("does not warn where both operands always have a value", () => {
    const source = `
      input predicate n(x: integer, y: integer).
      q(X) :- n(X, Y), X <> Y.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("nor for `=`, which has no competing reading", () => {
    const source = `
      input predicate n(x: integer, y: integer).
      q(X) :- n(X, Y), X = 10 / Y.
    `;
    expect(codes(source)).toEqual([]);
  });

  test("reaches inside a compound filter", () => {
    const source = `
      input predicate n(x: integer, y: integer).
      q(X) :- n(X, Y), Y > 0 && X <> 10 / Y.
    `;
    expect(codes(source)).toEqual(["partial-inequality"]);
  });

  test("`!=` warns too, being the same operator spelled differently", () => {
    const source = `
      input predicate n(x: integer, y: integer).
      q(X) :- n(X, Y), X != 10 / Y.
    `;
    expect(codes(source)).toEqual(["partial-inequality"]);
  });
});
