// Navigation state for the step-through viewer. Given a trace (produced
// by the native backend) plus a chosen granularity, compute:
//   - the ordered list of "stops" (event indices where the user can pause)
//   - per-stop reconstructed relation contents
//   - the tuples newly added between the previous stop and the current one
//
// Reconstruction is replay-from-scratch rather than incremental. Programs
// that fit in the playground are small enough that this stays cheap and
// the code stays obvious.

import type { TraceEvent, TraceTuple } from "datamog-backend-native";
import { bigintSafeReplacer } from "datamog-engine";

export type Granularity = "rule" | "iteration" | "stratum";

export interface Stop {
  /** Index into `events`. -1 means "before any event ran" (initial state). */
  eventIndex: number;
  /** Event that triggers this stop, or undefined for the synthetic start stop. */
  event?: TraceEvent;
}

export interface RelationSnapshot {
  /** Tuples visible at this stop, in insertion order. */
  tuples: TraceTuple[];
  /** Keys of tuples added between the previous stop and this one. */
  newlyAddedKeys: Set<string>;
}

export interface Snapshot {
  /** Predicate → relation state at the current stop. */
  relations: Map<string, RelationSnapshot>;
}

export function tupleKey(t: TraceTuple): string {
  // `bigintSafeReplacer` survives BigInt cells — Postgres BIGINT
  // columns can land in trace tuples via the executor's row pipeline,
  // and bare `JSON.stringify` throws on them.
  return JSON.stringify(t.values, bigintSafeReplacer);
}

/**
 * Build the ordered list of stop points for the given granularity. Every
 * granularity includes a synthetic "before" stop (eventIndex = -1) so the
 * user can land on the empty-database state before anything runs.
 */
export function computeStops(events: TraceEvent[], granularity: Granularity): Stop[] {
  const stops: Stop[] = [{ eventIndex: -1 }];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (isStop(e, granularity)) stops.push({ eventIndex: i, event: e });
  }
  return stops;
}

function isStop(event: TraceEvent, granularity: Granularity): boolean {
  // edb-loaded stops are visible at every granularity — EDB loading is a
  // natural anchor point and there are only a handful of them.
  if (event.kind === "edb-loaded") return true;
  // So is the end of a parity round: it is the only place where relations
  // shrink, so skipping past it would show tuples that are no longer there.
  if (event.kind === "round-end") return true;
  switch (granularity) {
    case "rule":
      return event.kind === "rule-applied";
    case "iteration":
      return event.kind === "iteration-end";
    case "stratum":
      return event.kind === "stratum-end";
  }
}

/**
 * Replay events[0..upTo] to compute the full relation state, along with
 * the set of tuples added strictly after `sinceEvent` (for highlighting).
 * `sinceEvent` is the previous stop's eventIndex, or -1 for the first stop.
 */
export function snapshotAt(
  events: TraceEvent[],
  upTo: number,
  sinceEvent: number,
  schema: Record<string, string[]>,
): Snapshot {
  const relations = new Map<string, RelationSnapshot>();
  for (const predicate of Object.keys(schema)) {
    relations.set(predicate, { tuples: [], newlyAddedKeys: new Set() });
  }

  for (let i = 0; i <= upTo; i++) {
    const e = events[i]!;
    if (e.kind === "edb-loaded") {
      const rel = relations.get(e.predicate);
      if (!rel) continue;
      const isNew = i > sinceEvent;
      // edb-loaded resets the relation to the loaded tuples. It fires at
      // most once per predicate, so this branch simply seeds the relation.
      rel.tuples = [...e.tuples];
      if (isNew) {
        rel.newlyAddedKeys = new Set(e.tuples.map(tupleKey));
      }
    } else if (e.kind === "rule-applied") {
      const rel = relations.get(e.predicate);
      if (!rel) continue;
      const isNew = i > sinceEvent;
      const seen = new Set(rel.tuples.map(tupleKey));
      for (const t of e.added) {
        const k = tupleKey(t);
        if (!seen.has(k)) {
          rel.tuples.push(t);
          seen.add(k);
        }
        if (isNew) rel.newlyAddedKeys.add(k);
      }
    } else if (e.kind === "relation-cleared") {
      // The one non-append event: a parity stratum rebuilds its maximal
      // relations from empty each round, so the replay has to drop them too or
      // the panel keeps showing tuples the evaluator has retracted.
      const rel = relations.get(e.predicate);
      if (!rel) continue;
      rel.tuples = [];
      rel.newlyAddedKeys = new Set();
    }
  }
  return { relations };
}

/** Human-readable one-liner summarising what happened at this stop. */
export function captionFor(stop: Stop, schema: Record<string, string[]>): string {
  if (!stop.event) return "Before evaluation begins — all intensional relations are empty.";
  const e = stop.event;
  switch (e.kind) {
    case "edb-loaded":
      return `Loaded ${e.tuples.length} row${e.tuples.length === 1 ? "" : "s"} into extensional predicate '${e.predicate}'.`;
    case "rule-applied": {
      const pluralAdded = e.added.length === 1 ? "" : "s";
      if (e.added.length === 0) {
        return `Stratum ${e.stratum} · iter ${e.iteration}: rule for '${e.predicate}' produced ${e.derived} tuple${e.derived === 1 ? "" : "s"}, all already present.`;
      }
      return `Stratum ${e.stratum} · iter ${e.iteration}: rule for '${e.predicate}' added ${e.added.length} new tuple${pluralAdded} (${e.derived} derived).`;
    }
    case "iteration-end":
      return e.added === 0
        ? `Stratum ${e.stratum} · iter ${e.iteration}: no new tuples — fixed point reached.`
        : `Stratum ${e.stratum} · iter ${e.iteration} complete: ${e.added} new tuple${e.added === 1 ? "" : "s"}.`;
    case "stratum-end":
      return `Stratum ${e.stratum} converged after ${e.iterations} iteration${e.iterations === 1 ? "" : "s"}.`;
    case "round-end":
      return `Stratum ${e.stratum} · round ${e.round} complete: the minimal side grew, the maximal side was rebuilt.`;
    case "relation-cleared":
      return `Stratum ${e.stratum} · round ${e.round}: cleared '${e.predicate}' (${e.removed} tuple${e.removed === 1 ? "" : "s"}) to rebuild it against the minimal side.`;
    default:
      void schema;
      return "";
  }
}
