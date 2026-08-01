// The step panel replays trace events to reconstruct relation state. Almost
// every event only appends, so the replay accumulates; `relation-cleared` is
// the exception, emitted when a parity stratum rebuilds its maximal relations
// between rounds. Miss it and the panel shows tuples the evaluator retracted.

import { describe, expect, test } from "bun:test";
import { type TraceEvent, create } from "datamog-backend-native";
import { DatamogExecutor } from "datamog-engine";
import { computeStops, snapshotAt } from "../src/lib/trace-state.ts";

const PARITY_PROGRAM = `
  literal("n1").
  composite("add"). composite("mul_x").
  child("add", "n1"). child("mul_x", "add"). child("mul_x", "x").

  constant(E) :- literal(E).
  constant(E) :- composite(E), not bad^(E).
  bad^(E) :- child(E, C), not constant(C).

  ?- constant(E).
`;

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

const SCHEMA = {
  literal: ["e"],
  composite: ["e"],
  child: ["parent", "kid"],
  constant: ["col1"],
  bad: ["col1"],
};

describe("trace replay of a parity stratum", () => {
  test("drops the maximal relation's tuples at a clear", async () => {
    const events = await traceOf(PARITY_PROGRAM);
    const clearIndexes = events.flatMap((e, i) => (e.kind === "relation-cleared" ? [i] : []));
    expect(clearIndexes.length).toBeGreaterThan(1);

    // Take a clear that actually removed something, and compare the replayed
    // state just before it with the state just after.
    const idx = clearIndexes.find((i) => (events[i] as { removed: number }).removed > 0)!;
    const before = snapshotAt(events, idx - 1, -1, SCHEMA);
    const after = snapshotAt(events, idx, -1, SCHEMA);
    expect(before.relations.get("bad")!.tuples.length).toBeGreaterThan(0);
    expect(after.relations.get("bad")!.tuples).toEqual([]);
    // The minimal side is untouched by the clear.
    expect(after.relations.get("constant")!.tuples).toEqual(
      before.relations.get("constant")!.tuples,
    );
  });

  test("ends with the evaluator's own answer, not an accumulation", async () => {
    const events = await traceOf(PARITY_PROGRAM);
    const final = snapshotAt(events, events.length - 1, -1, SCHEMA);
    // `mul_x` is the only expression with a non-constant child at the fixed
    // point. Without honouring the clears, `bad` would still hold `add` too,
    // from the round before `add` was shown to be constant.
    expect(final.relations.get("bad")!.tuples.map((t) => t.values[0])).toEqual(["mul_x"]);
    expect(
      final.relations
        .get("constant")!
        .tuples.map((t) => t.values[0])
        .sort(),
    ).toEqual(["add", "n1"]);
  });

  test("makes every round end a stop, at any granularity", async () => {
    const events = await traceOf(PARITY_PROGRAM);
    const rounds = events.filter((e) => e.kind === "round-end").length;
    for (const granularity of ["rule", "iteration", "stratum"] as const) {
      const stops = computeStops(events, granularity);
      expect(stops.filter((s) => s.event?.kind === "round-end")).toHaveLength(rounds);
    }
  });
});
