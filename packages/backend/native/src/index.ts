import { validateStructuralColumn } from "datamog-core";
// Native in-memory Datalog backend. See ./evaluator.ts for the evaluation
// algorithm and ./values.ts for term evaluation semantics.

import type { ExtDecl, Query, TypedProgram } from "datamog-core";
import {
  type Backend,
  type ConstraintViolation,
  ConstraintViolationError,
  type ExtensionalLoader,
  type QueryResult,
  isJsonValue,
  loadExtensionalData,
  toViolation,
} from "datamog-engine";
import type { EvaluatorOptions, IterationCapInfo } from "./base-evaluator.ts";
import { NaiveEvaluator } from "./evaluator.ts";
import type { TraceCallback } from "./trace.ts";

export {
  BaseDatalogEvaluator,
  type EvaluatorOptions,
  type FixpointOptions,
  type IterationCapInfo,
} from "./base-evaluator.ts";
export { NaiveEvaluator } from "./evaluator.ts";
export type { Relation } from "./planner.ts";
export {
  type DeltaOverride,
  type RulePlan,
  type Step,
  addRow,
  buildVarTypes,
  clearRelation,
  enumerate,
  evalAggregate,
  makeRelation,
  matchAtom,
  planRule,
  rowKey,
} from "./planner.ts";
export type { SourceSpan, TraceCallback, TraceEvent, TraceTuple } from "./trace.ts";
export {
  type Substitution,
  type TypeEnv,
  type Value,
  compareOp,
  evalTerm,
  logicalEq,
} from "./values.ts";

/**
 * One-line, user-facing explanation of an iteration cap being hit. Shared so
 * the CLI, embed, and playground phrase it identically. See
 * `doc/design/finiteness-checking.md`.
 */
export function formatIterationCap(info: IterationCapInfo): string {
  const preds = info.predicates.map((p) => `'${p}'`).join(", ");
  return `Stopped after ${info.iteration} iterations without reaching a fixed point (${preds} still producing rows). The result is incomplete: add a bound (e.g. a comparison like X < 10) or raise the iteration cap.`;
}

export interface NativeBackendOptions {
  /**
   * If supplied, `NaiveEvaluator` will invoke this callback during
   * evaluation with stratum/iteration/rule events. See `TraceEvent` for
   * the event shape; `computeAll()` emits events in the order documented
   * there.
   */
  trace?: TraceCallback;
  /**
   * Maximum fixed-point passes per stratum. Undefined means unlimited (run to
   * the least fixed point, the pre-existing behaviour). See
   * `doc/design/finiteness-checking.md`.
   */
  maxIterations?: number;
  /**
   * Called once after evaluation if a stratum hit the iteration cap without
   * converging. The partial (prefix) results are still returned.
   */
  onIterationCap?(info: IterationCapInfo): void;
}

/**
 * Minimal evaluator surface needed to wire one up as a `Backend`. Both
 * `NaiveEvaluator` and `SemiNaiveEvaluator` (in `datamog-backend-seminaive`)
 * satisfy this — the factory below takes either constructor.
 */
export interface DatalogEvaluator {
  appendEdb(predicate: string, rows: Record<string, unknown>[]): void;
  computeAll(): void;
  runQuery(query: Query): QueryResult;
  /** Set when a stratum hit the iteration cap without converging. */
  readonly capInfo?: IterationCapInfo;
}

export type DatalogEvaluatorCtor<E extends DatalogEvaluator> = new (
  analyzed: TypedProgram,
  opts?: EvaluatorOptions,
) => E;

/**
 * Build a `Backend` driven by an in-memory Datalog evaluator. Used by
 * the naive and semi-naive backends — the only thing that varies between
 * them is which evaluator constructor is passed in (and the wording of
 * the SQL-execute error). The evaluator is created lazily on first
 * `evaluateProgram` so the same backend instance can be re-used across
 * executor runs with different typed programs.
 */
export function createEvaluatorBackend<E extends DatalogEvaluator>(
  EvaluatorCtor: DatalogEvaluatorCtor<E>,
  options: NativeBackendOptions & { name: string },
): Backend {
  const { trace, maxIterations, onIterationCap } = options;
  let evaluator: E | null = null;
  let acceptingInserts = false;
  let closed = false;
  // If a caller invokes `insertRows` before `evaluateProgram` we buffer
  // here and replay once the evaluator exists.
  const bufferedInserts: { decl: ExtDecl; rows: Record<string, unknown>[] }[] = [];

  function assertOpen(): void {
    if (closed) {
      throw new Error(`${options.name} backend is closed`);
    }
  }

  // Pin the object to `Backend` so `this` inside the methods narrows to
  // the concrete backend type rather than the wrapping `Promise<Backend>`
  // — without the annotation, `loader.load(decl, this)` infers `this` as
  // `Backend | PromiseLike<Backend>` and the call fails to type-check.
  const backend: Backend = {
    sqlDialect: null,

    async execute(): Promise<Record<string, unknown>[]> {
      throw new Error(
        `${options.name} backend does not execute SQL. Use DatamogExecutor, which dispatches via Backend.evaluateProgram.`,
      );
    },

    async insertRows(decl: ExtDecl, rows: Record<string, unknown>[]): Promise<void> {
      assertOpen();
      // Direct backend inserts bypass the shared loader helper. Validate the
      // entire structural batch before buffering/appending any rows.
      rows.forEach((row, i) => {
        for (const column of decl.columns) {
          if (!column.shape) continue;
          const value = row[column.name] === undefined && column.nullable ? null : row[column.name];
          if (!isJsonValue(value))
            throw new Error(
              `Predicate '${decl.predicate}', row ${i + 1}, column '${column.name}': expected JSON value`,
            );
          validateStructuralColumn(value, column, `Predicate '${decl.predicate}', row ${i + 1}`);
        }
      });
      if (evaluator && acceptingInserts) {
        evaluator.appendEdb(decl.predicate, rows);
      } else {
        bufferedInserts.push({ decl, rows });
      }
    },

    async evaluateProgram(
      analyzed: TypedProgram,
      loaders: ExtensionalLoader[],
    ): Promise<QueryResult[]> {
      assertOpen();
      const ev = new EvaluatorCtor(analyzed, { trace, maxIterations });
      evaluator = ev;
      acceptingInserts = true;
      try {
        for (const { decl, rows } of bufferedInserts) {
          ev.appendEdb(decl.predicate, rows);
        }
        bufferedInserts.length = 0;

        // Loaders call `insertRows(backend, decl, rows)`, which uses our
        // `insertRows` (see above) to feed the evaluator.
        await loadExtensionalData(analyzed, loaders, this);
        assertOpen();
      } finally {
        acceptingInserts = false;
      }

      ev.computeAll();
      if (ev.capInfo) onIterationCap?.(ev.capInfo);

      // Integrity constraints are checked before any query is projected, so a
      // violated program produces no results at all. `runQuery` already returns
      // rows in the uniform shape (native values need no coercion), so the rows
      // are the counterexamples as-is.
      const violations: ConstraintViolation[] = [];
      for (const constraint of analyzed.constraints) {
        const { rows } = ev.runQuery(constraint);
        if (rows.length > 0) violations.push(toViolation(constraint, rows));
      }
      if (violations.length > 0) {
        throw new ConstraintViolationError(violations, analyzed.sourceFile);
      }

      const results: QueryResult[] = [];
      for (const query of analyzed.queries) {
        const result = ev.runQuery(query);
        if (query.outputName) result.label = query.outputName;
        results.push(result);
      }
      return results;
    },

    close(): void {
      closed = true;
      evaluator = null;
      acceptingInserts = false;
      bufferedInserts.length = 0;
    },
  };
  return backend;
}

export async function create(options: NativeBackendOptions = {}): Promise<Backend> {
  return createEvaluatorBackend(NaiveEvaluator, { ...options, name: "Native" });
}
