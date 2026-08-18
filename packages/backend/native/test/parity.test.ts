// Parity-stratified recursion in the in-memory evaluators: the alternating
// fixed point, ⊤ in round 0, and the round/clear trace events. The seminaive
// backend runs the same programs in its own suite and must agree tuple for
// tuple. See doc/design/parity-stratification.md §4 and §10.

import { describe, expect, test } from "bun:test";
import { type IterationCapInfo, type TraceEvent, create } from "datamog-backend-native";
import { DatamogExecutor } from "datamog-engine";

async function run(source: string): Promise<Record<string, unknown>[][]> {
  const backend = await create();
  try {
    const results = await new DatamogExecutor(backend).execute(source);
    return results.map((r) => r.rows);
  } finally {
    await backend.close();
  }
}

async function traceOf(source: string): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  const backend = await create({ trace: (e) => events.push(e) });
  try {
    await new DatamogExecutor(backend).execute(source);
    return events;
  } finally {
    await backend.close();
  }
}

function col(rows: Record<string, unknown>[], name: string): unknown[] {
  return rows.map((r) => r[name]).sort();
}

// (1+2)*x is not constant, (1+2)*4 is. `x` is neither literal nor composite,
// so no rule can ever make it constant.
const CONSTANT_EXPRESSIONS = `
  literal("n1"). literal("n2"). literal("n4").
  composite("add"). composite("mul_x"). composite("mul_4").
  child("add", "n1").   child("add", "n2").
  child("mul_x", "add"). child("mul_x", "x").
  child("mul_4", "add"). child("mul_4", "n4").

  constant(E) :- literal(E).
  constant(E) :- composite(E), not has_nonconstant_child^(E).

  has_nonconstant_child^(E) :- child(E, C), not constant(C).

  ?- constant(E).
`;

// Both rules apply the same anti-monotone operator, so `win` rises to the
// positions with a forced win and `not_lost^` falls to those that are not
// definitely lost. The gap between them is the draws.
const GAME = `
  win(P)       :- move(P, Q), not not_lost^(Q).
  not_lost^(P) :- move(P, Q), not win(Q).
`;

describe("native backend — parity-stratified recursion", () => {
  test("computes constant expressions through a double negation", async () => {
    const [rows] = await run(CONSTANT_EXPRESSIONS);
    expect(col(rows!, "E")).toEqual(["add", "mul_4", "n1", "n2", "n4"]);
  });

  test("a maximal predicate can recurse positively into itself", async () => {
    // `bad` means "has a non-constant descendant", so `constant` now needs
    // every descendant constant rather than every child.
    const [rows] = await run(`
      literal("n1").
      composite("add"). composite("outer").
      child("add", "n1"). child("outer", "add"). child("outer", "x").

      constant(E) :- literal(E).
      constant(E) :- composite(E), not bad^(E).

      bad^(E) :- child(E, C), not constant(C).
      bad^(E) :- child(E, C), bad^(C).

      ?- constant(E).
    `);
    expect(col(rows!, "E")).toEqual(["add", "n1"]);
  });

  test("solves a finite game, and the two bounds meet", async () => {
    // Nim, two heaps of at most 2. A position is winning iff its nim-sum is
    // nonzero, which for this board is everything except 0-0, 1-1 and 2-2.
    const moves: string[] = [];
    for (let a = 0; a <= 2; a++) {
      for (let b = 0; b <= 2; b++) {
        for (let x = 0; x < a; x++) moves.push(`move("${a}${b}", "${x}${b}").`);
        for (let y = 0; y < b; y++) moves.push(`move("${a}${b}", "${a}${y}").`);
      }
    }
    const [winning, notLost] = await run(`
      ${moves.join("\n")}
      ${GAME}
      output predicate winning(P) :- win(P).
      output predicate maybe(P) :- not_lost^(P).
    `);
    const expected = ["01", "02", "10", "12", "20", "21"];
    expect(col(winning!, "P")).toEqual(expected);
    // Nim is determined: no position sits in the gap.
    expect(col(notLost!, "P")).toEqual(expected);
  });

  test("a drawn game leaves the gap non-empty", async () => {
    // a and b chase each other forever; c wins by moving to a dead end.
    const [winning, notLost] = await run(`
      move("a", "b"). move("b", "a"). move("c", "dead").
      ${GAME}
      output predicate winning(P) :- win(P).
      output predicate maybe(P) :- not_lost^(P).
    `);
    expect(col(winning!, "P")).toEqual(["c"]);
    expect(col(notLost!, "P")).toEqual(["a", "b", "c"]);
  });

  test("⊤ is only ever observed by a negated atom", async () => {
    // A maximal predicate whose only rule is self-referential. Its SCC holds
    // one polarity, so the sigil is inert and this is the ordinary empty
    // recursive-only fixed point plus the base fact, not the greatest fixed
    // point (which would be every integer).
    const [rows] = await run(`
      p^(0).
      p^(X: integer) :- p^(X).
      ?- p^(X).
    `);
    expect(rows!.map((r) => r.X)).toEqual([0]);
  });

  test("rebuilding the maximal side each round keeps its base facts", async () => {
    const [rows] = await run(`
      node("a"). node("b").
      suspect^("a").
      suspect^(X) :- node(X), not cleared(X).
      cleared(X) :- node(X), not suspect^(X).
      output predicate still_suspect(X) :- suspect^(X).
    `);
    expect(col(rows!, "X")).toEqual(["a", "b"]);
  });

  test("a maximal predicate may be proof-carrying (spec 8.6)", async () => {
    // Each side of a parity stratum is a least fixed point, so a maximal
    // predicate's derivations are finite and its proof terms are ordinary.
    // Here the proof records which child made the parent non-constant.
    const facts = `
      literal("n1"). composite("add"). composite("mul").
      child("add", "n1").
      child("mul", "n1"). child("mul", "x").
      constant(E) :- literal(E).
      constant(E) :- composite(E), not bad^(E).
    `;
    const [proofs] = await run(`
      ${facts}
      bad^(E) :: Nonconstant :- child(E, C), not constant(C).
      ?- P : bad^(E).
    `);
    expect(proofs).toEqual([{ E: "mul", P: { $proof: "bad::Nonconstant", args: ["x"] } }]);

    // Naming the rules must not change which tuples are derived.
    const [named] = await run(`
      ${facts}
      bad^(E) :: Nonconstant :- child(E, C), not constant(C).
      ?- constant(E).
    `);
    const [unnamed] = await run(`
      ${facts}
      bad^(E) :- child(E, C), not constant(C).
      ?- constant(E).
    `);
    expect(named).toEqual(unnamed!);
    expect(col(named!, "E")).toEqual(["add", "n1"]);
  });
});

describe("native backend — parity trace events", () => {
  test("marks the stratum, brackets each round, and reports clears", async () => {
    const events = await traceOf(CONSTANT_EXPRESSIONS);
    const parityStart = events.find((e) => e.kind === "stratum-start" && e.parity);
    expect(parityStart).toBeDefined();
    expect((parityStart as { predicates: string[] }).predicates.sort()).toEqual([
      "constant",
      "has_nonconstant_child",
    ]);

    // Every round brackets a clear of the maximal relation.
    const rounds = events.filter((e) => e.kind === "round-start").length;
    expect(rounds).toBeGreaterThan(1);
    expect(events.filter((e) => e.kind === "round-end")).toHaveLength(rounds);
    const cleared = events.filter((e) => e.kind === "relation-cleared");
    expect(cleared).toHaveLength(rounds);
    expect(cleared.every((e) => e.predicate === "has_nonconstant_child")).toBe(true);
    // The first clear drops nothing (round 0 starts the relation at ⊤, which
    // holds no explicit tuples); later ones drop the previous round's value.
    expect((cleared[0] as { removed: number }).removed).toBe(0);
    expect((cleared[1] as { removed: number }).removed).toBeGreaterThan(0);
  });

  test("keeps the iteration counter monotone across rounds", async () => {
    const events = await traceOf(CONSTANT_EXPRESSIONS);
    const parityStratum = events
      .filter((e) => e.kind === "iteration-start")
      .filter(
        (e) => e.stratum === events.find((s) => s.kind === "stratum-start" && s.parity)?.stratum,
      );
    const iterations = parityStratum.map((e) => (e as { iteration: number }).iteration);
    expect(iterations).toEqual([...iterations].sort((a, b) => a - b));
    expect(new Set(iterations).size).toBe(iterations.length);
  });

  test("a single-polarity stratum runs no rounds", async () => {
    const events = await traceOf(`
      p^(0).
      p^(X: integer) :- p^(X).
      ?- p^(X).
    `);
    expect(events.filter((e) => e.kind === "round-start")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "stratum-start" && e.parity)).toHaveLength(0);
  });
});

describe("native backend — parity strata and the iteration cap", () => {
  test("stops inside a parity stratum and reports it", async () => {
    let capInfo: IterationCapInfo | undefined;
    const backend = await create({
      maxIterations: 3,
      onIterationCap: (info) => {
        capInfo = info;
      },
    });
    try {
      const results = await new DatamogExecutor(backend).execute(CONSTANT_EXPRESSIONS);
      // The cap lands mid-alternation, so the minimal side is a sound
      // under-estimate rather than a wrong answer: literals only, no folding.
      expect(col(results[0]!.rows, "E")).toEqual(["n1", "n2", "n4"]);
    } finally {
      await backend.close();
    }
    expect(capInfo).toBeDefined();
    expect(capInfo!.predicates.sort()).toEqual(["constant", "has_nonconstant_child"]);
  });

  test("a cap in an earlier stratum does not abandon a later parity one", async () => {
    // `counter` runs away and gets capped; the parity stratum after it must
    // still be evaluated rather than bailing out on the leftover capInfo.
    const backend = await create({ maxIterations: 6 });
    try {
      const results = await new DatamogExecutor(backend).execute(`
        counter(0).
        counter(N + 1) :- counter(N).

        literal("n1").
        composite("add").
        child("add", "n1").
        constant(E) :- literal(E).
        constant(E) :- composite(E), not bad^(E).
        bad^(E) :- child(E, C), not constant(C).

        output predicate folded(E) :- constant(E).
      `);
      const folded = results.find((r) => r.label === "folded")!;
      expect(col(folded.rows, "E")).toEqual(["add", "n1"]);
    } finally {
      await backend.close();
    }
  });

  // The ⊤ marker is scoped to the stratum, and a cap is the exit that skips the
  // `clearRelation` loop which normally drops it. A leaked marker is not a
  // near-miss: a positive read of the relation throws an internal error, and a
  // negated read takes the "⊤ holds of everything" branch and answers the
  // complement of the truth under nothing but the ordinary cap warning. Both
  // need a *maximal* predicate to be read after the cap, which is what the two
  // cap tests above never do.
  //
  // `reach` needs more passes than the cap allows, so the cap lands in the
  // minimal phase of round 0, before any clear has run.
  const CAP_IN_MINIMAL_PHASE = `
    n(0). n(1). n(2). n(3). n(4).
    start(0).
    special(9).
    reach(X) :- start(X).
    reach(Y) :- reach(X), Y = X + 1, Y <= 4.
    reach(X) :- special(X), not ok^(X).
    ok^(X) :- n(X), not reach(X).
  `;

  test("a cap in the minimal phase leaves no maximal relation at ⊤", async () => {
    const backend = await create({ maxIterations: 3 });
    try {
      // Querying the maximal predicate positively: at ⊤ this throws
      // `positive atom on 'ok' read it at ⊤` instead of returning rows.
      const results = await new DatamogExecutor(backend).execute(
        `${CAP_IN_MINIMAL_PHASE}\n?- ok^(X).`,
      );
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("a negated read after a cap does not answer as though ⊤ held", async () => {
    const source = `${CAP_IN_MINIMAL_PHASE}\noutput predicate not_ok(X) :- n(X), not ok^(X).`;
    const capped = await create({ maxIterations: 3 });
    let cappedRows: unknown[];
    try {
      const results = await new DatamogExecutor(capped).execute(source);
      cappedRows = results.find((r) => r.label === "not_ok")!.rows;
    } finally {
      await capped.close();
    }
    // A leaked ⊤ makes `not ok^(X)` fail for every `X`, so the answer collapses
    // to nothing — the complement of what the partial relations hold.
    expect(cappedRows.length).toBeGreaterThan(0);
    expect(col(cappedRows as Record<string, unknown>[], "X")).toEqual([0, 1, 2, 3, 4]);
  });
});
