// Semi-naive in-memory Datalog backend. Public surface mirrors
// `datamog-backend-native`: `create()` returns a `Backend` that exposes
// `insertRows` / `evaluateProgram` and is driven by `DatamogExecutor`.

import { createEvaluatorBackend } from "datamog-backend-native";
import type { Backend } from "datamog-engine";
import { SemiNaiveEvaluator } from "./evaluator.ts";

export { SemiNaiveEvaluator } from "./evaluator.ts";
export { formatIterationCap } from "datamog-backend-native";
export type {
  IterationCapInfo,
  Relation,
  SourceSpan,
  TraceCallback,
  TraceEvent,
  TraceTuple,
} from "datamog-backend-native";

export interface SemiNaiveBackendOptions {
  /**
   * Trace callback receives the same event shape as the naive backend so
   * existing consumers (e.g. the playground step view) work unchanged.
   */
  trace?: import("datamog-backend-native").TraceCallback;
  /**
   * Maximum fixed-point passes per stratum (priming counts as pass one).
   * Undefined means unlimited. See `doc/design/finiteness-checking.md`.
   */
  maxIterations?: number;
  /** Called once after evaluation if a stratum hit the iteration cap. */
  onIterationCap?(info: import("datamog-backend-native").IterationCapInfo): void;
}

export async function create(options: SemiNaiveBackendOptions = {}): Promise<Backend> {
  return createEvaluatorBackend(SemiNaiveEvaluator, { ...options, name: "Seminaive" });
}
