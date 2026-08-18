// Discharging obligations with a real solver. Skipped where none is installed,
// so a checkout without z3 still runs green.

import { describe, expect, test } from "bun:test";
import { analyze, generateObligations, inferTypes } from "datamog-core";
import { parse } from "datamog-parser";
import { DEFAULT_SOLVER, verifyObligations } from "../src/verify.ts";

const solver = DEFAULT_SOLVER.split(/\s+/)[0]!;
const withSolver = Bun.which(solver) ? describe : describe.skip;

const verify = (source: string) =>
  verifyObligations(generateObligations(inferTypes(analyze(parse(source)))));

withSolver(`with ${solver}`, () => {
  test("a claim the body entails is discharged", async () => {
    const verdicts = await verify(`
      edge(1, 2).
      slot(X, Y, _: Y > X) :- edge(X, Y).
      merged(X, Z, _: Z > X) :- slot(X, Y), slot(Y, Z).
    `);
    // `merged` is transitivity over the two atoms' contracts. `slot`'s own
    // claim is about the data, not a theorem, so it is not discharged.
    expect(verdicts.map((v) => [v.obligation.predicate, v.status])).toEqual([
      ["slot", "counterexample"],
      ["merged", "discharged"],
    ]);
  });

  test("an overflow no longer falsifies a claim over a computed position", async () => {
    // §10's payoff, and the thing to run a solver at rather than assert about
    // the encoding: `Prev + Curr` leaving the integer domain derives no tuple,
    // so a contract over the tuples that exist has nothing to answer for. This
    // is `examples/fibonacci` reduced to the one rule that used to fail.
    const verdicts = await verify(`
      step(1, 0 as P0, 1 as C0, _: 0 <= P0, _: P0 <= C0).
      step(I + 1, Curr, Prev + Curr as Next, _: 0 <= Curr, _: Curr <= Next) :-
        step(I, Prev, Curr), I < 10.
    `);
    expect(verdicts.map((v) => v.status)).toEqual([
      "discharged",
      "discharged",
      "discharged",
      "discharged",
    ]);
  });

  test("a counterexample names the assignment that falsifies the claim", async () => {
    const [verdict] = await verify("p(1, 2).\nr(X, Y, _: Y > X) :- p(X, Y).");
    expect(verdict!.status).toBe("counterexample");
    expect(verdict!.detail).toContain("(X ");
  });

  test("an obligation outside the fragment is skipped, not failed", async () => {
    const [verdict] = await verify(
      "input predicate p(a: string, b: string).\nr(X, Y, _: Y > X) :- p(X, Y).",
    );
    expect(verdict!.status).toBe("skipped");
    expect(verdict!.detail).toContain("a string variable");
  });

  test("a solver that is not there fails once, not once per obligation", async () => {
    const program = "p(1, 2).\nr(X, Y, _: Y > X) :- p(X, Y).";
    const obligations = generateObligations(inferTypes(analyze(parse(program))));
    await expect(verifyObligations(obligations, "datamog-no-such-solver")).rejects.toThrow(
      /--solver/,
    );
  });
});
