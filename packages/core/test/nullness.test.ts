import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { inferTypes } from "../src/types.ts";

// Nullness inference: which columns can hold SQL NULL, and which variables a
// body proves cannot. See doc/design/nullness-tracking.md §4 for the design and
// §4.2 for the refinement table these tests walk.

/** Per-column nullness of `predicate`. */
function cols(source: string, predicate: string): boolean[] {
  const typed = inferTypes(analyze(parse(source)));
  const nullness = typed.nullness.columnNullness.get(predicate);
  expect(nullness).toBeDefined();
  return [...nullness!];
}

/** The variables the first rule of `predicate` proves non-null. */
function proven(source: string, predicate: string): string[] {
  const typed = inferTypes(analyze(parse(source)));
  const rule = typed.rules.get(predicate)![0]!;
  return [...typed.nullness.nonNullVars.get(rule.body)!].sort();
}

describe("extensional columns", () => {
  test("a column takes its declared `?`", () => {
    const source = "input predicate p(a: integer, b: integer?).\nq(X, Y) :- p(X, Y).";
    expect(cols(source, "p")).toEqual([false, true]);
  });

  test("an unannotated column defaults to non-null along with its `string` type", () => {
    const source = "input predicate p(a).\nq(X) :- p(X).";
    expect(cols(source, "p")).toEqual([false]);
  });
});

describe("propagation into intensional columns", () => {
  test("a non-null source keeps the column non-null", () => {
    const source = "input predicate p(a: integer).\nq(X) :- p(X).";
    expect(cols(source, "q")).toEqual([false]);
  });

  test("a nullable source makes it nullable", () => {
    const source = "input predicate p(a: integer?).\nq(X) :- p(X).";
    expect(cols(source, "q")).toEqual([true]);
  });

  test("one nullable sibling rule is enough", () => {
    const source = `
      input predicate p(a: integer).
      input predicate r(a: integer?).
      q(X) :- p(X).
      q(X) :- r(X).
    `;
    expect(cols(source, "q")).toEqual([true]);
  });

  test("a bare null head argument originates nullness", () => {
    // A sibling rule has to type the column, a bare `null` having no type of
    // its own (null.md §7).
    const source = `
      input predicate p(a: integer).
      q(X, 1) :- p(X).
      q(X, null) :- p(X).
    `;
    expect(cols(source, "q")).toEqual([false, true]);
  });
});

describe("operations", () => {
  test("division is partial whatever its operands", () => {
    const source = `
      input predicate p(a: integer, b: integer).
      q(X) :- p(A, B), X = A / B.
    `;
    expect(cols(source, "q")).toEqual([true]);
  });

  test("integer arithmetic is total", () => {
    const source = `
      input predicate p(a: integer).
      q(X) :- p(A), X = A + 1.
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("float arithmetic can overflow to non-finite", () => {
    const source = `
      input predicate p(a: float).
      q(X) :- p(A), X = A * 2.0.
    `;
    expect(cols(source, "q")).toEqual([true]);
  });

  test("string concatenation is total", () => {
    const source = `
      input predicate p(a: string).
      q(X) :- p(A), X = A + "!".
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("a partial builtin originates nullness, a total one does not", () => {
    const source = `
      input predicate p(a: string).
      parsed(X) :- p(A), X = to_integer(A).
      upped(X) :- p(A), X = upper(A).
    `;
    expect(cols(source, "parsed")).toEqual([true]);
    expect(cols(source, "upped")).toEqual([false]);
  });

  test("comparison is total, so a comparison result is never null", () => {
    const source = `
      input predicate p(a: integer?).
      q(B) :- p(A), B = (A < 2).
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("construction is not propagation: an array of nulls is a value", () => {
    const source = `
      input predicate p(a: integer?).
      q(X) :- p(A), X = [A].
    `;
    expect(cols(source, "q")).toEqual([false]);
  });
});

describe("refinement from body constraints", () => {
  const decl = "input predicate p(a: integer?).\n";

  test("`X <> null` proves it", () => {
    expect(cols(`${decl}q(X) :- p(X), X <> null.`, "q")).toEqual([false]);
  });

  test("`not (X = null)` proves the same fact", () => {
    expect(cols(`${decl}q(X) :- p(X), not (X = null).`, "q")).toEqual([false]);
  });

  test("a strict comparison proves both sides", () => {
    expect(cols(`${decl}q(X) :- p(X), X < 100.`, "q")).toEqual([false]);
    expect(cols(`${decl}q(X) :- p(X), 100 > X.`, "q")).toEqual([false]);
  });

  test("`<=` and `>=` prove nothing, holding of two nulls", () => {
    expect(cols(`${decl}q(X) :- p(X), X <= 100.`, "q")).toEqual([true]);
    expect(cols(`${decl}q(X) :- p(X), X >= 100.`, "q")).toEqual([true]);
  });

  test("`not (X < 2)` proves nothing: that is where the null row lives", () => {
    expect(cols(`${decl}q(X) :- p(X), not (X < 2).`, "q")).toEqual([true]);
  });

  test("a range atom proves it", () => {
    expect(cols(`${decl}q(X) :- p(X), X in [1 .. 10].`, "q")).toEqual([false]);
  });

  test("`&&` proves what either side does", () => {
    expect(cols(`${decl}q(X) :- p(X), (X <> null) && (X <= 100).`, "q")).toEqual([false]);
  });

  test("`||` proves it only when both branches do", () => {
    expect(cols(`${decl}q(X) :- p(X), (X <> null) || (X > 5).`, "q")).toEqual([false]);
    expect(cols(`${decl}q(X) :- p(X), (X <> null) || (X <= 5).`, "q")).toEqual([true]);
  });

  test("a guard reaches through a strict operation", () => {
    const source = `${decl}q(X) :- p(Y), Y <> null, X = Y + 1.`;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("a strict builtin carries the guard to its argument", () => {
    const source = `
      input predicate p(a: string?).
      q(X) :- p(X), length(X) > 0.
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("a non-strict operator blocks the walk", () => {
    // `(X <> null) <> null` is non-null whatever X is, so it proves nothing.
    const source = `${decl}q(X) :- p(X), (X <> null) <> null.`;
    expect(cols(source, "q")).toEqual([true]);
  });

  test("a shared variable takes the non-null side", () => {
    const source = `
      input predicate p(a: integer?).
      input predicate r(a: integer).
      q(X) :- p(X), r(X).
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("a negated atom proves nothing", () => {
    const source = `
      input predicate p(a: integer?).
      input predicate r(a: integer).
      q(X) :- p(X), not r(X).
    `;
    expect(cols(source, "q")).toEqual([true]);
  });

  test("order does not matter: a guard written last refines an atom written first", () => {
    const before = `${decl}q(X) :- X <> null, p(X).`;
    const after = `${decl}q(X) :- p(X), X <> null.`;
    expect(cols(before, "q")).toEqual([false]);
    expect(cols(after, "q")).toEqual([false]);
  });

  test("refinement is reported per body, naming the proven variables", () => {
    const source = `
      input predicate p(a: integer?, b: integer?).
      q(X) :- p(X, Y), X <> null, Y <= 3.
    `;
    expect(proven(source, "q")).toEqual(["X"]);
  });
});

describe("aggregates", () => {
  test("count is never null, even over a nullable column", () => {
    const source = `
      input predicate p(a: integer?).
      q(count(X)) :- p(X).
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("sum propagates its argument's nullness", () => {
    const nullable = `
      input predicate p(a: integer?).
      q(sum(X)) :- p(X).
    `;
    const nonNull = `
      input predicate p(a: integer).
      q(sum(X)) :- p(X).
    `;
    expect(cols(nullable, "q")).toEqual([true]);
    expect(cols(nonNull, "q")).toEqual([false]);
  });
});

describe("recursion", () => {
  test("a non-null base case gives a non-null recursive column", () => {
    const source = `
      input predicate edge(a: integer, b: integer).
      path(X, Y) :- edge(X, Y).
      path(X, Z) :- path(X, Y), edge(Y, Z).
    `;
    expect(cols(source, "path")).toEqual([false, false]);
  });

  test("a nullable base case widens the whole fixed point", () => {
    const source = `
      input predicate edge(a: integer?, b: integer?).
      path(X, Y) :- edge(X, Y).
      path(X, Z) :- path(X, Y), edge(Y, Z).
    `;
    expect(cols(source, "path")).toEqual([true, true]);
  });

  test("nullness introduced only in the recursive step still reaches the column", () => {
    const source = `
      input predicate edge(a: integer, b: integer).
      path(X, Y) :- edge(X, Y).
      path(X, Z) :- path(X, Y), edge(Y, W), Z = W / 2.
    `;
    expect(cols(source, "path")).toEqual([false, true]);
  });
});
