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
    // expressible at all. `Y` is nullable because its column is declared so,
    // which since null-as-a-value.md is the only way a variable becomes nullable.
    const out = script(`
      input predicate p(a: integer?).
      r(X, Y, _: Y > X) :- p(Y), X = 0.
    `);
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

  test("a head expression's definedness is a hypothesis, not a null case", () => {
    // A derived tuple witnesses its own definedness (§10): `X + 1` outside the
    // integer domain has no value, so no tuple carries it and the contract says
    // nothing about that case. Asserting the domain as a *hypothesis* is what
    // says so. Modelling the overflow as a NULL instead is what used to falsify
    // every plausible invariant over a computed position, `fibonacci`'s
    // `Curr <= Next` among them.
    const out = script("p(1).\nr(X, X + 1 as K, _: K > X) :- p(X).");
    const domain = "(and (<= (- 9007199254740991) (+ X 1)) (<= (+ X 1) 9007199254740991))";
    expect(out).toContain(`(assert ${domain})`);
    // And the goal is about the values alone: no domain condition rides along
    // inside it, which is what an `isNull` disjunct would have put there.
    const goal = out.split("\n").find((l) => l.startsWith("(assert (not "))!;
    expect(goal).not.toContain("9007199254740991");
  });

  test("division by zero is undefinedness too, not a null", () => {
    const out = script("p(4).\nr(X, Y, X / Y as H, _: H >= 0) :- p(X), q(Y).\nq(2).");
    // The divisor being non-zero is a hypothesis about which tuples exist, so it
    // is asserted rather than folded into a null condition on the quotient.
    expect(out).toContain("(not (= Y 0))");
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

describe("a negated body conjunct is negation as failure", () => {
  // `not e` holds wherever `e` fails to hold, which is where `e` is false *and*
  // where it has no value, so the negation wraps the whole reading of the
  // conjunct. Asserting `(not value)` instead reads the guard positively, and
  // `_: X > 100` under a body that excludes exactly that was discharged.
  const assertsOf = (out: string) => out.split("\n").filter((l) => l.startsWith("(assert "));

  test("the hypothesis is that the conjunct did not hold", () => {
    const out = script("p(5).\nq(X, _: X > 100) :- p(X), not (X > 100).");
    expect(assertsOf(out)).toContain("(assert (not (> X 100)))");
    expect(assertsOf(out)).not.toContain("(assert (> X 100))");
  });

  test("a negated equality goes the same way, the grammar making it a filter", () => {
    const out = script("p(5).\nq(X, _: X > 100) :- p(X), not X = 5.");
    expect(assertsOf(out)).toContain("(assert (not (or (and false false) (and true (= X 5)))))");
    expect(assertsOf(out)).not.toContain("(assert (or (and false false) (and true (= X 5))))");
  });

  test("a partial conjunct keeps its definedness under the negation", () => {
    // `not (100 / X > 0)` holds at `X = 0`, the quotient having no value there,
    // so the divisor condition belongs inside the negation, not beside it.
    const out = script("p(4).\nq(X, _: X > 0) :- p(X), not (100 / X > 0).");
    expect(out).toContain("(assert (not (and (not (= X 0)) (> ");
  });

  test("a positive filter still contributes it directly", () => {
    const out = script("p(5).\nq(X, _: X > 100) :- p(X), X > 100.");
    expect(assertsOf(out)).toContain("(assert (> X 100))");
  });
});

describe("a connective's definedness is stated, not assumed", () => {
  test("an operand that can leave the integer domain puts its condition in the goal", () => {
    // The goal is `def ∧ value` and is asserted negated, so a `def` of `true`
    // discharges the claim wherever the product overflows: `X * 1000000000` has
    // no value there, the conjunction has none either, and every backend
    // reports the contract violated.
    const out = script(
      "p(9007200, 0).\nq(X, Y, _: X * 1000000000 > 0 && Y >= 0) :- p(X, Y), X > 0, Y >= 0.",
    );
    const goal = out.split("\n").find((l) => l.startsWith("(assert (not "))!;
    expect(goal).toContain("(<= (* X 1000000000) 9007199254740991)");
  });

  test("a dominating operand gives the term a value whatever the other side does", () => {
    // `false && e` is false and `true || e` is true, so a defined dominating
    // side is one of the three ways the term has a value; the third is both
    // sides having one.
    const nullable = "input predicate p(a: integer?, b: integer).";
    expect(script(`${nullable}\nq(X, Y, _: X > 0 && Y > 0) :- p(X, Y).`)).toContain(
      "(or (and (not X$null) (not (> X 0))) (not (> Y 0)) (not X$null))",
    );
    expect(script(`${nullable}\nq(X, Y, _: X > 0 || Y > 0) :- p(X, Y).`)).toContain(
      "(or (and (not X$null) (> X 0)) (> Y 0) (not X$null))",
    );
  });

  test("two total operands leave the goal bare", () => {
    const out = script("p(1, 2).\nq(X, Y, _: Y > X && X > 0) :- p(X, Y).");
    expect(out).toContain("(assert (not (and (> Y X) (> X 0))))");
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
