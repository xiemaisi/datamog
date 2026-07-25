import type { FinitenessCycle, NegationCycle } from "datamog-core";
import type { QueryResult } from "datamog-engine";
import { lazyAsync } from "../lib/lazy.ts";
import type {
  AstElement,
  BackendName,
  CompletionCandidate,
  CompletionKind,
  CompletionResult,
  DryRunResult,
  SourceSpan,
  StepEngine,
  StepResult,
} from "./executor.ts";

export type {
  AstElement,
  BackendName,
  CompletionCandidate,
  CompletionKind,
  CompletionResult,
  DryRunResult,
  SourceSpan,
  StepEngine,
  StepResult,
};
export type { FinitenessCycle, NegationCycle };

/**
 * Discriminated union for cycle data attached to a diagnostic.
 * Drives the "Show cycle" action in the lint tooltip and the
 * in-source highlight on hover. Currently has two variants:
 *   - finiteness: a value-flow cycle the analyser flagged as
 *     potentially-unbounded.
 *   - negation: a predicate-dependency cycle that goes through a
 *     `not` body atom and breaks stratification.
 */
export type ActiveCycle =
  | { kind: "finiteness"; cycle: FinitenessCycle }
  | { kind: "negation"; cycle: NegationCycle };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type WorkerResponse =
  | { type: "init-done" }
  | { type: "init-error"; error: string }
  | { type: "execute-result"; id: number; results: QueryResult[] }
  | { type: "execute-error"; id: number; error: string }
  | { type: "dry-run-result"; id: number; result: DryRunResult }
  | { type: "dry-run-error"; id: number; error: string }
  | { type: "lint-result"; id: number; result: LintResult }
  | { type: "lint-error"; id: number; error: string }
  | { type: "step-result"; id: number; result: StepResult }
  | { type: "step-error"; id: number; error: string }
  | { type: "complete-result"; id: number; result: CompletionResult }
  | { type: "complete-error"; id: number; error: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./executor.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;

      if (msg.type === "init-done" || msg.type === "init-error") {
        // Handled by initPromise
        return;
      }

      const req = pending.get(msg.id);
      if (!req) return;
      pending.delete(msg.id);

      if ("error" in msg) {
        req.reject(new Error(msg.error));
      } else if (msg.type === "execute-result") {
        req.resolve(msg.results);
      } else {
        req.resolve(msg.result);
      }
    };
  }
  return worker;
}

// `lazyAsync` clears the cached promise on rejection, so a transient
// init failure (e.g. the worker's sql.js fetch fails because the CDN
// is briefly unreachable) doesn't permanently brick the bridge — the
// next caller retries from scratch.
export const init = lazyAsync(
  (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const w = getWorker();
      const handler = (e: MessageEvent) => {
        if (e.data.type === "init-done") {
          w.removeEventListener("message", handler);
          resolve();
        } else if (e.data.type === "init-error") {
          w.removeEventListener("message", handler);
          reject(new Error(e.data.error));
        }
      };
      w.addEventListener("message", handler);
      w.postMessage({ type: "init" });
    }),
);

/**
 * Send a request to the worker and wait for the matching response. Each
 * request gets a fresh `id`; the message handler in `getWorker` looks the
 * id up in `pending` and resolves/rejects the right promise. Centralising
 * the await-init / nextId++ / Promise / pending.set / postMessage dance
 * keeps every public method below to a single line.
 */
async function request<R>(payload: Record<string, unknown>): Promise<R> {
  await init();
  const id = nextId++;
  return new Promise<R>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    getWorker().postMessage({ ...payload, id });
  });
}

export function execute(
  source: string,
  csvData: Record<string, string>,
  jsonlData: Record<string, string>,
  csvUrlData: Record<string, string>,
): Promise<QueryResult[]> {
  return request({ type: "execute", source, csvData, jsonlData, csvUrlData });
}

export function dryRun(source: string, backend: BackendName): Promise<DryRunResult> {
  return request({ type: "dry-run", source, backend });
}

export function step(
  source: string,
  csvData: Record<string, string>,
  jsonlData: Record<string, string>,
  csvUrlData: Record<string, string>,
  engine: StepEngine,
  maxIterations?: number,
): Promise<StepResult> {
  return request({ type: "step", source, csvData, jsonlData, csvUrlData, engine, maxIterations });
}

export interface LintDiagnostic {
  message: string;
  from?: number;
  to?: number;
  severity: "error" | "warning";
  /**
   * Cycle data, if available, for the "Show cycle" affordance:
   *   - finiteness warnings carry a value-flow cycle (predicate
   *     columns + growing edges).
   *   - non-stratified-negation errors carry a predicate-dependency
   *     cycle with the offending negative edge marked.
   */
  cycle?: ActiveCycle;
}

export interface PredicateReferenceSpan {
  /** Byte offset of the predicate name (just the IDENT). */
  start: number;
  end: number;
  /** Byte offset to scroll to when the user Cmd/Ctrl+clicks the reference. */
  target: number;
}

export interface LintResult {
  diagnostics: LintDiagnostic[];
  /**
   * Body atoms whose predicate sits in the same SCC as their rule's
   * head. The editor renders a superscript glyph after each one so
   * the reader can see the recursion without reading the whole rule.
   */
  recursiveCalls: SourceSpan[];
  /**
   * Predicate-name spans (in body atoms and queries) along with the
   * offset of the predicate's definition. Drives the editor's
   * Cmd/Ctrl+click jump-to-definition.
   */
  predicateReferences: PredicateReferenceSpan[];
  /**
   * True when the program has at least one `?-` query. Programs
   * without a query produce no output, so the playground disables
   * the Run button until the user adds one. False on parse/analyse
   * failure (no analysed program means no observable queries).
   */
  hasQueries: boolean;
}

export function lint(source: string): Promise<LintResult> {
  return request({ type: "lint", source });
}

export function complete(source: string, offset: number): Promise<CompletionResult> {
  return request({ type: "complete", source, offset });
}
