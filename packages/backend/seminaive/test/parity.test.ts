// Parity-stratified recursion on the seminaive backend. The alternating driver
// itself is shared (BaseDatalogEvaluator.runParityStratum); what is exercised
// here is that seminaive's fixed-point driver behaves correctly when it is
// re-entered once per round with a partly-populated relation. Results must
// match the native suite tuple for tuple.

import { describe, expect, test } from "bun:test";
import { create as createNative } from "datamog-backend-native";
import { create } from "datamog-backend-seminaive";
import { DatamogExecutor } from "datamog-engine";

async function runOn(
  make: typeof create | typeof createNative,
  source: string,
): Promise<Record<string, unknown>[][]> {
  const backend = await make();
  try {
    const results = await new DatamogExecutor(backend).execute(source);
    return results.map((r) => r.rows);
  } finally {
    await backend.close();
  }
}

/** Run on both interpreters, assert they agree, and return the shared answer. */
async function runBoth(source: string): Promise<Record<string, unknown>[][]> {
  const [seminaive, native] = await Promise.all([
    runOn(create, source),
    runOn(createNative, source),
  ]);
  const sorted = (rs: Record<string, unknown>[][]) =>
    rs.map((r) => [...r].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  expect(sorted(seminaive)).toEqual(sorted(native));
  return seminaive;
}

function col(rows: Record<string, unknown>[], name: string): unknown[] {
  return rows.map((r) => r[name]).sort();
}

describe("seminaive backend — parity-stratified recursion", () => {
  test("computes constant expressions, agreeing with native", async () => {
    const [rows] = await runBoth(`
      literal("n1"). literal("n2"). literal("n4").
      composite("add"). composite("mul_x"). composite("mul_4").
      child("add", "n1").   child("add", "n2").
      child("mul_x", "add"). child("mul_x", "x").
      child("mul_4", "add"). child("mul_4", "n4").

      constant(E) :- literal(E).
      constant(E) :- composite(E), not has_nonconstant_child^(E).

      has_nonconstant_child^(E) :- child(E, C), not constant(C).

      ?- constant(E).
    `);
    expect(col(rows!, "E")).toEqual(["add", "mul_4", "n1", "n2", "n4"]);
  });

  test("resumes the minimal side correctly after the maximal side shrinks", async () => {
    // A chain deep enough that the minimal side gains tuples in several
    // rounds. Seminaive re-primes each round, so a rule that could not fire
    // before must fire now against tuples derived in an earlier round.
    const [rows] = await runBoth(`
      literal("leaf").
      composite("c1"). composite("c2"). composite("c3"). composite("c4").
      child("c1", "leaf"). child("c2", "c1"). child("c3", "c2"). child("c4", "c3").

      constant(E) :- literal(E).
      constant(E) :- composite(E), not bad^(E).
      bad^(E) :- child(E, C), not constant(C).

      ?- constant(E).
    `);
    expect(col(rows!, "E")).toEqual(["c1", "c2", "c3", "c4", "leaf"]);
  });

  test("solves a drawn game, agreeing with native", async () => {
    const [winning, notLost] = await runBoth(`
      move("a", "b"). move("b", "a"). move("c", "dead").
      win(P)       :- move(P, Q), not not_lost^(Q).
      not_lost^(P) :- move(P, Q), not win(Q).
      output predicate winning(P) :- win(P).
      output predicate maybe(P) :- not_lost^(P).
    `);
    expect(col(winning!, "P")).toEqual(["c"]);
    expect(col(notLost!, "P")).toEqual(["a", "b", "c"]);
  });

  test("mutual recursion inside the minimal class still works", async () => {
    // One SCC, three predicates: `even`/`odd` recurse positively into each
    // other (same polarity, so a positive call is legal) and both negate
    // `blocked^`, which negates them back. 7 and 8 sit on a chain with no
    // route from 0, so 8 stays blocked at the fixed point.
    const [evens, odds, blocked] = await runBoth(`
      succ(0, 1). succ(1, 2). succ(2, 3). succ(3, 4). succ(7, 8).

      even(0).
      even(N) :- succ(M, N), odd(M), not blocked^(N).
      odd(N)  :- succ(M, N), even(M), not blocked^(N).
      blocked^(N) :- succ(M, N), not even(M), not odd(M).

      output predicate evens(N) :- even(N).
      output predicate odds(N) :- odd(N).
      output predicate still_blocked(N) :- blocked^(N).
    `);
    expect(col(evens!, "N")).toEqual([0, 2, 4]);
    expect(col(odds!, "N")).toEqual([1, 3]);
    expect(col(blocked!, "N")).toEqual([8]);
  });
});
