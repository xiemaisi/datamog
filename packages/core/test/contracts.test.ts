import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { findInertContracts } from "../src/contracts.ts";

// Refinement annotations, front end only: the position erases, the formula is
// validated against the head's positions, and a partly-annotated predicate is
// reported as vacuous. What the contract *does* is checked in the seminaive
// backend's suite, since it lowers to a constraint and needs an evaluator.
// See doc/design/refinement-annotations.md phases 0 and 1.

describe("the refinement position is not a column", () => {
  test("it erases, so the predicate has the arity it reads as having", () => {
    const analyzed = analyze(
      parse(`
        edge(1, 2).
        span(X, Y, _: Y > X) :- edge(X, Y).
      `),
    );
    expect(analyzed.arities.get("span")).toBe(2);
  });

  test("a refinement must sit on a `_`", () => {
    expect(() => parse("p(1,2).\nr(X, Y: Y > X) :- p(X, Y).")).toThrow(
      /must sit on a `_` position/,
    );
  });

  test("a refinement may only mention a head position", () => {
    expect(() => parse("p(1,2).\nr(X, _: Y > X) :- p(X, Y).")).toThrow(
      /only mention a head position/,
    );
  });

  test("a computed position is mentionable once named", () => {
    expect(() => parse("tok(1).\nsp(I, I + 1 as K, _: I < K) :- tok(I).")).not.toThrow();
  });

  test("an unnamed position the formula does not mention is fine", () => {
    expect(() => parse("p(1).\nr(X, X + 1, _: X > 0) :- p(X).")).not.toThrow();
  });
});

describe("the contract lowers to a constraint", () => {
  const constraints = (source: string) => analyze(parse(source)).constraints;

  test("one per refinement when the predicate has a single rule", () => {
    expect(constraints("p(1,2).\nr(X, Y, _: Y > X, _: X > 0) :- p(X, Y).")).toHaveLength(2);
  });

  test("one shared check when sibling rules disjoin", () => {
    expect(
      constraints(`
        p(1, 2). q(9, 3).
        r(X, Y, _: Y > X) :- p(X, Y).
        r(X, Y, _: Y < X) :- q(X, Y).
      `),
    ).toHaveLength(1);
  });

  test("none when a sibling is unannotated, since the contract is vacuous", () => {
    expect(
      constraints(`
        p(1, 2). q(9, 3).
        r(X, Y, _: Y > X) :- p(X, Y).
        r(X, Y) :- q(X, Y).
      `),
    ).toHaveLength(0);
  });
});

describe("inert contracts", () => {
  test("a partly annotated predicate warns", () => {
    const diagnostics = findInertContracts(
      analyze(
        parse(`
          p(1, 2). q(9, 3).
          r(X, Y, _: Y > X) :- p(X, Y).
          r(X, Y) :- q(X, Y).
        `),
      ),
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["inert-contract"]);
    expect(diagnostics[0]!.message).toContain("'r'");
  });

  test("a fully annotated one does not", () => {
    expect(findInertContracts(analyze(parse("p(1,2).\nr(X, Y, _: Y > X) :- p(X, Y).")))).toEqual(
      [],
    );
  });

  test("a predicate with no annotations does not", () => {
    expect(findInertContracts(analyze(parse("p(1,2).\nr(X, Y) :- p(X, Y).")))).toEqual([]);
  });
});
