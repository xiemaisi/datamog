// Refinement annotations, checked at runtime. A contract lowers to a
// synthesised integrity constraint, so a violation arrives as one, reported
// after evaluation and before any query runs.
// See doc/design/refinement-annotations.md §4.5 and phase 3.

import { describe, expect, test } from "bun:test";
import { create } from "datamog-backend-seminaive";
import { ConstraintViolationError, DatamogExecutor } from "datamog-engine";

async function run(source: string): Promise<Record<string, unknown>[][]> {
  const backend = await create();
  try {
    return (await new DatamogExecutor(backend).execute(source)).map((r) => r.rows);
  } finally {
    await backend.close();
  }
}

async function violation(source: string): Promise<string> {
  try {
    await run(source);
  } catch (e) {
    if (e instanceof ConstraintViolationError) return e.message;
    throw e;
  }
  throw new Error("expected a contract violation");
}

describe("checking a contract", () => {
  test("a holding contract is silent and the position is gone", async () => {
    const rows = await run(`
      edge(1, 2). edge(2, 5).
      span(X, Y, _: Y > X) :- edge(X, Y).
      ?- span(A, B).
    `);
    expect(rows[0]).toEqual([
      { A: 1, B: 2 },
      { A: 2, B: 5 },
    ]);
  });

  test("a violation names the annotation and the tuple", async () => {
    const message = await violation(`
      edge(5, 2).
      span(X, Y, _: Y > X) :- edge(X, Y).
      ?- span(A, B).
    `);
    expect(message).toContain("Y > X");
    expect(message).toContain("Col1 = 5");
    expect(message).toContain("Col2 = 2");
  });

  test("several refinements on one rule are reported individually", async () => {
    // A single rule's contract is a conjunction, and a conjunction splits
    // exactly, so the failing claim is named rather than the first one.
    const message = await violation(`
      p(0, 2).
      r(X, Y, _: Y > X, _: X > 0) :- p(X, Y).
      ?- r(A, B).
    `);
    expect(message).toContain("X > 0");
    expect(message).not.toContain("Y > X");
  });

  test("a named computed position can be constrained", async () => {
    const rows = await run(`
      tok(1). tok(2).
      sp(I, I + 1 as K, _: I < K) :- tok(I).
      ?- sp(A, B).
    `);
    expect(rows[0]).toHaveLength(2);
  });
});

describe("sibling rules disjoin", () => {
  const program = `
    p(1, 2). q(9, 3).
    r(X, Y, _: Y > X) :- p(X, Y).
    r(X, Y, _: Y < X) :- q(X, Y).
  `;

  test("a tuple need only satisfy the claim of some rule", async () => {
    expect((await run(`${program}\n?- r(A, B).`))[0]).toHaveLength(2);
  });

  test("a tuple satisfying none of them violates", async () => {
    const message = await violation(`
      p(4, 4). q(9, 3).
      r(X, Y, _: Y > X) :- p(X, Y).
      r(X, Y, _: Y < X) :- q(X, Y).
      ?- r(A, B).
    `);
    expect(message).toContain("Col1 = 4");
  });

  test("an unannotated sibling makes the contract vacuous, so nothing is checked", async () => {
    const rows = await run(`
      p(1, 2). q(9, 3).
      r(X, Y, _: Y > X) :- p(X, Y).
      r(X, Y) :- q(X, Y).
      ?- r(A, B).
    `);
    expect(rows[0]).toHaveLength(2);
  });
});

describe("a constrained position that cannot be computed", () => {
  test("withholds its tuple, so the contract holds rather than being violated", async () => {
    // This used to be a violation, and its no longer being one is the payoff
    // doc/design/null-as-a-value.md §10 predicts. `Y = X + 1` overflows the
    // integer domain, so it has no value, so the conjunct does not hold and no
    // tuple is derived. A contract constrains the tuples that exist, and there
    // are none, so there is nothing to violate.
    //
    // The same fact is what makes the *static* obligation discharge: a derived
    // tuple now witnesses its own definedness, so `def(X + 1)` is a hypothesis
    // rather than a case the proof has to cover.
    const rows = await run(`
      seed(9007199254740991).
      r(X, Y, _: Y > X) :- seed(X), Y = X + 1.
      ?- r(A, B).
    `);
    expect(rows[0]).toEqual([]);
  });

  test("but a genuine counterexample is still reported", async () => {
    // Lest the above be read as the check having gone quiet.
    const message = await violation(`
      seed(5).
      r(X, Y, _: Y > X) :- seed(X), Y = X - 1.
      ?- r(A, B).
    `);
    expect(message).toContain("Y > X");
  });
});

describe("a proposition that has no value at a derived tuple", () => {
  test("is a counterexample, like a false one", async () => {
    // The tuple exists, so the contract has something to say about it, and it
    // holds of a tuple only where the proposition is *true*. A proposition
    // without a value there is therefore a violation, which is the same reading
    // the obligation encoder takes when it asks for `def(formula)` alongside
    // `formula` (§15.21, §15.27).
    //
    // The check is negation as failure over the proposition rather than `!` over
    // it; `!` propagates the absence and reports nothing, which silently passed
    // every such tuple.
    const message = await violation(`
      seed(0). seed(4).
      r(X, _: 10 / X > 1) :- seed(X).
      ?- r(A).
    `);
    expect(message).toContain("10 / X > 1");
  });

  test("and a nullable operand is one, since arithmetic propagates the null", async () => {
    // Position 3 rejects arithmetic on a nullable operand, but the check it runs
    // on skips synthesised statements, so a refinement is where a nullable
    // operand can still reach an operation. It now reports rather than passing.
    const message = await violation(`
      seed(1). seed(null).
      r(X, _: X + 1 > 0) :- seed(X).
      ?- r(A).
    `);
    expect(message).toContain("X + 1 > 0");
  });
});
