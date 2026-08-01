// Trace events emitted by `NaiveEvaluator` when a `trace` callback is
// supplied. Events carry only deltas (newly-added tuples per rule
// application) so a consumer can replay them in order to reconstruct any
// intermediate state.
//
// Event sequence emitted by `computeAll`:
//
//   edb-loaded*                       (one per EDB that was populated)
//   (for each stratum, in dep order:)
//     stratum-start
//     (repeated until a no-op iteration:)
//       iteration-start
//       rule-applied*                 (one per rule, per iteration)
//       iteration-end
//     stratum-end
//
// A parity stratum (`stratum-start` with `parity: true`) runs several fixed
// points back to back, wrapped in round-start / round-end. Its maximal
// relations are rebuilt from empty each round, which is the one point where
// the stream is not append-only: `relation-cleared` says a relation's tuples
// were dropped, and a consumer accumulating tuples must drop them too. The
// `iteration` counter stays monotone across a stratum's rounds.
//
//     stratum-start (parity: true)
//     (repeated until the maximal relations stop changing:)
//       round-start
//       iteration-start / rule-applied* / iteration-end      (minimal side)
//       relation-cleared*             (one per maximal predicate)
//       iteration-start / rule-applied* / iteration-end      (maximal side)
//       round-end
//     stratum-end

import type { Value } from "./values.ts";

export interface SourceSpan {
  offset: number;
  end: number;
}

/** A concrete tuple in a trace event, rendered with its column headers. */
export interface TraceTuple {
  values: Value[];
}

export type TraceEvent =
  | {
      kind: "edb-loaded";
      predicate: string;
      tuples: TraceTuple[];
    }
  | {
      kind: "stratum-start";
      stratum: number;
      predicates: string[];
      recursive: boolean;
      /** True when the stratum holds both polarities and runs the alternating
       *  fixed point (`doc/design/parity-stratification.md` §4). */
      parity: boolean;
    }
  | {
      kind: "round-start";
      stratum: number;
      round: number;
    }
  | {
      kind: "round-end";
      stratum: number;
      round: number;
    }
  | {
      kind: "relation-cleared";
      stratum: number;
      round: number;
      predicate: string;
      /** Tuples the relation held before being emptied. */
      removed: number;
    }
  | {
      kind: "stratum-end";
      stratum: number;
      iterations: number;
    }
  | {
      kind: "iteration-start";
      stratum: number;
      iteration: number;
    }
  | {
      kind: "iteration-end";
      stratum: number;
      iteration: number;
      added: number;
    }
  | {
      kind: "rule-applied";
      stratum: number;
      iteration: number;
      predicate: string;
      /** Rule's position among its predicate's rules. */
      ruleIndex: number;
      /** CST span of the whole rule, for editor highlighting. */
      ruleSpan?: SourceSpan;
      /** CST span of the rule head (tighter highlight target). */
      headSpan?: SourceSpan;
      /** Total tuples produced by this rule application, pre-dedup. */
      derived: number;
      /** Tuples that survived dedup and were appended to the relation. */
      added: TraceTuple[];
    };

export type TraceCallback = (event: TraceEvent) => void;
