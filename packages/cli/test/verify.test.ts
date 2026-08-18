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

  // One property, swept over the constructs a refinement can contain, rather
  // than a case per construct. `discharged` and a violation are contradictory
  // answers to the same question, and every unsoundness this encoder has had
  // reported exactly that pair: a spelling or a literal that the encoder read
  // one way and the synthesised `!-` read another. A construct the encoder
  // declines is fine here — `skipped` and `counterexample` both keep the run's
  // answer — so the assertion is one-directional on purpose.
  describe("a discharged contract is never violated by the run", () => {
    const cases: [name: string, source: string][] = [
      // Both spellings of the one inequality, which must agree.
      ["<> against null", "q(null).\nq(5).\np(A, _: A <> null) :- q(A), A <> null."],
      ["!= against null", "q(null).\nq(5).\np(A, _: A != null) :- q(A), A <> null."],
      ["<> between variables", "q(1, 2).\np(A, B, _: A <> B) :- q(A, B), A < B."],
      ["!= between variables", "q(1, 2).\np(A, B, _: A != B) :- q(A, B), A < B."],
      // An integral-valued float literal is still a float, so `/` must not be
      // read as truncating.
      ["integral float literal", "q(3).\np(A, _: A / 2.0 <= 1) :- q(A), A = 3."],
      ["integer literal", "q(3).\np(A, _: A / 2 <= 1) :- q(A), A = 3."],
      ["float literal in an ordering", "q(3).\np(A, _: A > 2.0) :- q(A), A = 3."],
      // Truncation and sign, where the two readings differ.
      ["negative truncating division", "q(-7).\np(A, _: A / 2 = -3) :- q(A), A = -7."],
      ["modulo sign", "q(-7).\np(A, _: A % 3 = -1) :- q(A), A = -7."],
      // Partiality as a hypothesis: the tuple witnesses its own definedness.
      [
        "division guarded by the body",
        "q(10, 0).\nq(10, 2).\np(A, B, A / B as C, _: C >= 0) :- q(A, B), A > 0, B > 0.",
      ],
      [
        "overflow on a computed position",
        "q(9007199254740990).\np(A, A + 1 as B, _: B > A) :- q(A).",
      ],
      // Negation as failure, which is not the positive reading.
      ["negated filter", "q(1).\nq(200).\np(A, _: A <= 100) :- q(A), not (A > 100)."],
      ["negated ordering both ways", "q(1).\nq(200).\np(A, _: A < 100) :- q(A), not (A >= 100)."],
      // The connectives, whose definedness is not their operands'.
      ["conjunction of guards", "q(3, 4).\np(A, B, _: A < B) :- q(A, B), A > 0 && A < B."],
      ["disjunction in the claim", "q(3).\np(A, _: A > 0 || A < 0) :- q(A), A <> 0."],
      // A nullable operand, where `$null` must survive.
      [
        "nullable column proved non-null",
        "input predicate e(x: integer, y: integer?).\np(X, Y, _: Y > X) :- e(X, Y), Y <> null, Y > X.",
      ],
      // The induction hypothesis at a self-reference.
      ["self-reference", "n(0 as N, _: N >= 0).\nn(N + 1 as M, _: M >= 0) :- n(N), N <= 3."],
    ];

    for (const [name, source] of cases) {
      test(name, async () => {
        const verdicts = await verify(source);
        // One-directional on purpose: declining to reason about a construct is
        // sound, so `skipped` and `counterexample` are both fine. Only claiming
        // a proof the run then breaks is a bug.
        if (!verdicts.some((v) => v.status === "discharged")) return;
        expect(await violated(source)).toBe(false);
      });
    }

    // The guard that keeps the sweep above from going quietly vacuous: if the
    // encoder regressed to discharging nothing, every case would return early
    // and still pass. The exact number is not the point, so this is a floor.
    test("the sweep discharges most of its cases", async () => {
      const discharged = await Promise.all(
        cases.map(async ([, source]) =>
          (await verify(source)).some((v) => v.status === "discharged"),
        ),
      );
      expect(discharged.filter(Boolean).length).toBeGreaterThanOrEqual(cases.length - 4);
    });
  });
});
