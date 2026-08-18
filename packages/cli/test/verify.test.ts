// Discharging obligations with a real solver. Skipped where none is installed,
// so a checkout without z3 still runs green.

import { describe, expect, test } from "bun:test";
import { create as createNative } from "datamog-backend-native";
import { analyze, generateObligations, inferTypes } from "datamog-core";
import { ConstraintViolationError, DatamogExecutor } from "datamog-engine";
import { parse } from "datamog-parser";
import { DEFAULT_SOLVER, verifyObligations } from "../src/verify.ts";

const solver = DEFAULT_SOLVER.split(/\s+/)[0]!;
const withSolver = Bun.which(solver) ? describe : describe.skip;

const verify = (source: string) =>
  verifyObligations(generateObligations(inferTypes(analyze(parse(source)))));

const statuses = async (source: string) => (await verify(source)).map((v) => v.status);

/**
 * Whether running the program finds a tuple that breaks a contract. A
 * refinement lowers to a synthesised constraint check, so a verdict and a run
 * answer the same question and disagreeing is a bug in one of them.
 */
async function violated(source: string): Promise<boolean> {
  const backend = await createNative();
  try {
    await new DatamogExecutor(backend, []).execute(source);
    return false;
  } catch (e) {
    if (e instanceof ConstraintViolationError) return true;
    throw e;
  } finally {
    await backend.close();
  }
}

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

  test("a negated guard is read as failure, so the verdict matches the run", async () => {
    // `not (X > 100)` excludes exactly the tuples the contract claims, and
    // reading the guard positively proved a claim every backend reports
    // violated.
    const broken = "p(5). p(7).\nq(X, _: X > 100) :- p(X), not (X > 100).";
    expect(await statuses(broken)).toEqual(["counterexample"]);
    expect(await violated(broken)).toBe(true);

    // The converse is a theorem, and the positive reading lost it.
    const sound = "p(5). p(7).\nq(X, _: X >= 0) :- p(X), not (X < 0).";
    expect(await statuses(sound)).toEqual(["discharged"]);
    expect(await violated(sound)).toBe(false);
  });

  test("a conjunction must have a value, so an overflowing operand breaks it", async () => {
    // `X * 1000000000` leaves the integer domain at this row, so the
    // conjunction has no value and the contract does not hold there. Giving
    // `&&` an unconditional definedness discharged it while every runnable
    // backend reported the contract violated.
    const program =
      "p(9007200, 0).\nq(X, Y, _: X * 1000000000 > 0 && Y >= 0) :- p(X, Y), X > 0, Y >= 0.";
    expect(await statuses(program)).toEqual(["counterexample"]);
    expect(await violated(program)).toBe(true);
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
