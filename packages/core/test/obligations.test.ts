import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { generateObligations, obligationScript } from "../src/obligations.ts";
import { inferTypes } from "../src/types.ts";

// Phase 2 of doc/design/refinement-annotations.md: obligations as SMT-LIB 2.
// No solver runs here or anywhere in the package, so these pin the encoding
// rather than the verdict.

const script = (source: string) => obligationScript(inferTypes(analyze(parse(source))));
const obligations = (source: string) => generateObligations(inferTypes(analyze(parse(source))));

describe("the script", () => {
  test("declares the fragment and one block per refinement", () => {
    const out = script(`
      p(1, 2).
      r(X, Y, _: Y > X, _: X > 0) :- p(X, Y).
    `);
    expect(out).toContain("(set-logic QF_LIA)");
    expect(out.match(/\(check-sat\)/g)).toHaveLength(2);
    expect(out).toContain("; r rule 1: Y > X");
    expect(out).toContain("; r rule 1: X > 0");
  });

  test("says so when there is nothing to discharge", () => {
    expect(script("p(1, 2).\nr(X, Y) :- p(X, Y).")).toContain("no refinement contracts");
  });

  test("asserts the negated goal, so unsat is what discharges", () => {
    const out = script("p(1, 2).\nr(X, Y, _: Y > X) :- p(X, Y).");
    expect(out).toContain("(assert (not ");
    expect(out).toContain("unsat discharges the obligation");
  });
});

describe("the encoding does not delegate to the solver", () => {
  test("an ordering is false at NULL rather than SMT-LIB's", () => {
    // `<` requires both sides non-null; the pair encoding is what makes that
    // expressible at all. `Y` is nullable because integer arithmetic can leave
    // the domain.
    const out = script("p(1).\nr(X, Y, _: Y > X) :- p(X), Y = X + 1.");
    expect(out).toContain("Y$null");
    expect(out).toContain("(not Y$null)");
  });

  test("a variable the body proves non-null gets no companion", () => {
    // Left free, a solver falsifies the ordering by making a column null that
    // never can be, and every contract over an integer column fails for a
    // reason the program excludes.
    const out = script("p(1, 2).\nr(X, Y, _: Y > X) :- p(X, Y).");
    expect(out).not.toContain("$null");
  });

  test("a variable is confined to the integer domain", () => {
    // Declared `Int` and left unbounded, a solver falsifies an overflow guard
    // with a value no tuple can hold.
    const out = script("p(1, 2).\nr(X, Y, _: Y > X) :- p(X, Y).");
    expect(out).toContain("(assert (and (<= (- 9007199254740991) X) (<= X 9007199254740991)))");
  });

  test("the logic widens when the program divides by a variable", () => {
    // QF_LIA rejects a nonlinear script outright rather than answering, so
    // declaring it would lose every block in the file.
    expect(script("p(1, 2).\nr(X, Y, _: Y > 0) :- p(X, Y), Y = 100 / X.")).toContain(
      "(set-logic QF_NIA)",
    );
    expect(script("p(1, 2).\nr(X, Y, _: Y > X) :- p(X, Y).")).toContain("(set-logic QF_LIA)");
  });

  test("arithmetic carries the integer domain, since leaving it is NULL", () => {
    const out = script("p(1).\nr(X, X + 1 as K, _: K > X) :- p(X).");
    expect(out).toContain("9007199254740991");
  });

  test("division truncates rather than flooring", () => {
    // SMT-LIB's `div` floors; Datamog truncates toward zero, so the encoding
    // writes it out.
    const out = script("p(4).\nr(X, X / 2 as H, _: H >= 0) :- p(X).");
    expect(out).toContain("(ite (>=");
    expect(out).toContain("(abs ");
  });

  test("a named position contributes its definition", () => {
    // `as` rewrites nothing, so without this the goal would have no
    // hypothesis connecting K to X + 1.
    const out = script("p(1).\nr(X, X + 1 as K, _: K > X) :- p(X).");
    expect(out).toContain("(= K (+ X 1))");
  });
});

describe("a consumer may assume what a producer promised", () => {
  test("a positive atom contributes its predicate's contract", () => {
    const out = script(`
      edge(1, 2).
      slot(X, Y, _: Y > X) :- edge(X, Y).
      merged(X, Z, _: Z > X) :- slot(X, Y), slot(Y, Z).
    `);
    // Transitivity: the goal needs both atoms' contracts, in the caller's own
    // variables rather than the producer's.
    expect(out).toContain("(> Y X)");
    expect(out).toContain("(> Z Y)");
  });

  test("a negated atom does not, since absence promises nothing", () => {
    const out = script(`
      edge(1, 2). other(3, 4).
      slot(X, Y, _: Y > X + 1) :- edge(X, Y).
      gap(A, B, _: B > A) :- other(A, B), not slot(A, B).
    `);
    expect(out).not.toContain("(+ A 1)");
  });

  test("an unannotated sibling makes the contract vacuous, so it contributes nothing", () => {
    const out = script(`
      edge(1, 2). skew(9, 3).
      slot(X, Y, _: Y > X) :- edge(X, Y).
      slot(X, Y) :- skew(X, Y).
      merged(X, Z, _: Z > X) :- slot(X, Y), slot(Y, Z).
    `);
    expect(out).not.toContain("(> Z Y)");
  });

  test("a self-reference contributes it too, which is the inductive hypothesis", () => {
    // The induction is on the derivation, and every rule of the predicate gets
    // its own obligation, so the step is discharged for all of them or none.
    const out = script(`
      seed(0 as Z, _: Z >= 0).
      tick(N, _: N >= 0) :- seed(N).
      tick(N + 1 as M, _: M >= 0) :- tick(N), N < 10.
    `);
    expect(out).toContain("(>= N 0)");
  });
});

describe("what it declines to emit", () => {
  test("a rule with an aggregate in the head, which needs phase 4's machinery", () => {
    const out = script("p(1, 2).\nr(X, count(Y) as N, _: N >= 0) :- p(X, Y).");
    expect(out).toContain("not emitted");
    expect(out).toContain("aggregate in the head");
  });

  test("a hypothesis outside the fragment is dropped, not fatal", () => {
    // The string equality cannot be encoded in QF_LIA, but dropping a
    // hypothesis only weakens the goal, so the obligation is still emitted.
    const out = script(`
      tok(1).
      sp(NT, I, I + 1 as K, _: I < K) :- tok(I), NT = "x".
    `);
    expect(out).toContain("(check-sat)");
    expect(out).not.toContain("not emitted");
  });

  test("a goal over a non-integer position, which QF_LIA cannot state", () => {
    // Every declared sort is `Int`. Encoding a `string` or a `float` as one
    // could discharge an obligation for the wrong reason, which is the one
    // direction that must not happen.
    for (const [type, source] of [
      ["string", "input predicate p(a: string, b: string).\nr(X, Y, _: Y > X) :- p(X, Y)."],
      ["float", "input predicate p(a: float).\nr(X, _: X > 1.5) :- p(X)."],
    ] as const) {
      const out = script(source);
      expect(out).toContain(`not emitted, outside tier 1: a ${type} variable`);
      expect(out).not.toContain("(check-sat)");
    }
  });

  test("a non-integer literal, which would be ill-typed against an Int declaration", () => {
    const out = script("p(1).\nr(X, _: X > 1.5) :- p(X).");
    expect(out).toContain("not emitted, outside tier 1: a non-integer literal");
    expect(out).not.toContain("1.5)");
  });

  test("nothing at all for a predicate whose contract is vacuous", () => {
    expect(
      obligations(`
        p(1, 2). q(9, 3).
        r(X, Y, _: Y > X) :- p(X, Y).
        r(X, Y) :- q(X, Y).
      `),
    ).toEqual([]);
  });
});
