import { create as createNativeBackend, formatIterationCap } from "datamog-backend-native";
import type { IterationCapInfo, TraceEvent } from "datamog-backend-native";
import { PostgresSqlDialect } from "datamog-backend-postgres/dialect";
import { create as createSeminaiveBackend } from "datamog-backend-seminaive";
import { SqliteSqlDialect } from "datamog-backend-sqlite/dialect";
import { sqljsBackendForDatabase } from "datamog-backend-sqljs";
import {
  AnalyzerError,
  findInertPolarity,
  findInfiniteRisks,
  findPredicateReferences,
  findRecursiveCalls,
} from "datamog-core";
import type { AnalyzedProgram, FinitenessCycle, FinitenessCycleNode } from "datamog-core";
import {
  type Backend,
  DatamogExecutor,
  type QueryResult,
  type SqlDialect,
  type TranslationResult,
  translate,
} from "datamog-engine";
import { ParseError } from "datamog-parser";
import { collectCompletionCandidates } from "../lib/completion-candidates.ts";
import { InMemoryCsvLoader, UrlCsvLoader } from "../lib/csv-loader.ts";
import { InMemoryJsonlLoader } from "../lib/jsonl-loader.ts";

// Re-exported from `completion-candidates.ts` so the bridge keeps importing
// the completion types from one place.
export type {
  CompletionCandidate,
  CompletionKind,
  CompletionResult,
} from "../lib/completion-candidates.ts";

export type BackendName = "sqlite" | "postgres" | "native" | "seminaive";

/** Backends that evaluate Datalog directly in-memory (step-path). */
export type StepEngine = Extract<BackendName, "native" | "seminaive">;

function dialectFor(name: BackendName): SqlDialect | null {
  switch (name) {
    case "sqlite":
      return new SqliteSqlDialect();
    case "postgres":
      return new PostgresSqlDialect();
    case "native":
    case "seminaive":
      // In-memory evaluators have no SQL dialect; callers should route to
      // `step` instead of `dry-run`.
      return null;
  }
}

export interface SourceSpan {
  start: number;
  end: number;
}

/**
 * Replace each cycle node's default `predicate[N]` label with an elided
 * rule-head form `predicate(..., expr, ...)` derived from the
 * representative rule's source. Leading/trailing ellipses are dropped
 * at column boundaries (first/last argument). Falls back to the
 * default label when the node has no head-term span (e.g. synthesised
 * AST). Done in the worker because the source string lives here, not
 * in the core analyser.
 */
function elideCycleLabels(cycle: FinitenessCycle, source: string): FinitenessCycle {
  return {
    ...cycle,
    nodes: cycle.nodes.map((n) => ({ ...n, label: elideLabel(n, source) })),
  };
}

function elideLabel(node: FinitenessCycleNode, source: string): string {
  const span = node.headTermSpan;
  if (!span || node.headArity <= 0) return node.label;
  const expr = source.slice(span.offset, span.end).trim();
  if (!expr) return node.label;
  const parts: string[] = [];
  if (node.columnIndex > 0) parts.push("...");
  parts.push(expr);
  if (node.columnIndex < node.headArity - 1) parts.push("...");
  return `${node.predicate}(${parts.join(", ")})`;
}

/**
 * Element of the Datalog source that the hover UI should treat as a unit:
 * a whole rule, its head, a body atom/equality/filter/range, or a query.
 * The editor looks up the *innermost* element at the cursor position when
 * emitting a hover range.
 */
export interface AstElement extends SourceSpan {
  kind: "rule" | "head" | "atom" | "equality" | "filter" | "range" | "query";
}

export interface DryRunResult {
  result: TranslationResult;
  /** Hoverable source elements, sorted ascending by (size, start). */
  elements: AstElement[];
}

/**
 * Step-through evaluation result. `events` is a linear log of what the
 * naive evaluator did (stratum-start → iteration-start → rule-applied… →
 * iteration-end → stratum-end); `schema` and `strata` give the UI the
 * structural context it needs to render predicates and group events.
 */
export interface StepResult {
  events: TraceEvent[];
  /** Column names for every predicate (EDB: declared names; IDB: col1..N). */
  schema: Record<string, string[]>;
  /** Predicates in each stratum, in dependency order. */
  strata: Array<{ predicates: string[]; recursive: boolean }>;
  /** Predicates declared as extensional (so the UI can distinguish EDB vs IDB). */
  extensionals: string[];
  /** Source text + CST span for each rule, indexed by (predicate, ruleIndex). */
  rules: Record<string, Array<{ text: string; span: SourceSpan }>>;
  /** Query results (same shape as `execute`). */
  queries: QueryResult[];
  /**
   * Set when evaluation stopped on the iteration cap. A ready-to-show
   * message; the queries above are the partial (prefix) result.
   */
  iterationCap?: string;
}

interface CstNode {
  offset: number;
  end: number;
}

function extractAstElements(analyzed: AnalyzedProgram): AstElement[] {
  const elements: AstElement[] = [];
  const push = (kind: AstElement["kind"], node: { $cstNode?: CstNode }) => {
    const c = node.$cstNode;
    if (c) elements.push({ kind, start: c.offset, end: c.end });
  };
  for (const rules of analyzed.rules.values()) {
    for (const rule of rules) {
      push("rule", rule);
      push("head", rule.head);
      for (const elem of rule.body) {
        switch (elem.$type) {
          case "Literal":
            push("atom", elem);
            break;
          case "Equality":
            push("equality", elem);
            break;
          case "Filter":
            push("filter", elem);
            break;
          case "RangeAtom":
            push("range", elem);
            break;
        }
      }
    }
  }
  for (const query of analyzed.queries) {
    push("query", query);
    for (const elem of query.body) {
      switch (elem.$type) {
        case "Literal":
          push("atom", elem);
          break;
        case "Equality":
          push("equality", elem);
          break;
        case "Filter":
          push("filter", elem);
          break;
        case "RangeAtom":
          push("range", elem);
          break;
      }
    }
  }
  // Sort by size ascending (smallest first), so "innermost element" lookup
  // can short-circuit on the first match.
  elements.sort((a, b) => a.end - a.start - (b.end - b.start));
  return elements;
}

interface InitMessage {
  type: "init";
}

interface ExecuteMessage {
  type: "execute";
  id: number;
  source: string;
  csvData: Record<string, string>;
  jsonlData: Record<string, string>;
  csvUrlData: Record<string, string>;
}

interface DryRunMessage {
  type: "dry-run";
  id: number;
  source: string;
  backend: BackendName;
}

interface LintMessage {
  type: "lint";
  id: number;
  source: string;
}

interface StepMessage {
  type: "step";
  id: number;
  source: string;
  csvData: Record<string, string>;
  jsonlData: Record<string, string>;
  csvUrlData: Record<string, string>;
  engine: StepEngine;
  /** Per-stratum fixed-point cap; omitted means unlimited. */
  maxIterations?: number;
}

interface CompleteMessage {
  type: "complete";
  id: number;
  source: string;
  offset: number;
}

type WorkerMessage =
  | InitMessage
  | ExecuteMessage
  | DryRunMessage
  | LintMessage
  | StepMessage
  | CompleteMessage;

const SQL_JS_CDN = "https://sql.js.org/dist";

// Cache the in-flight initialisation promise rather than the module itself
// so concurrent callers (e.g. an `init` message immediately followed by
// `execute`) share a single fetch + eval + initSqlJs cycle. With a plain
// `if (!sqlModule)` guard, both calls would see `null` between the first
// `await fetch` and the eventual assignment, and each would download and
// initialise sql.js independently.
//
// On rejection (typically a transient network failure fetching sql-wasm.js
// from the CDN) we drop the cached promise, otherwise every subsequent
// call would resolve to the same rejected promise and the worker would be
// permanently stuck — there'd be no way to recover without reloading the
// page.
// biome-ignore lint/suspicious/noExplicitAny: sql.js types vary by bundler
let sqlModulePromise: Promise<any> | null = null;

function ensureSqlJs() {
  if (!sqlModulePromise) {
    const p = (async () => {
      // sql.js is a UMD bundle that Vite can't import as ESM in a module worker.
      // Load it via fetch + globalThis eval, which is how it's designed to work in browsers.
      const response = await fetch(`${SQL_JS_CDN}/sql-wasm.js`);
      const scriptText = await response.text();
      // `(0, eval)` forces *indirect* eval so the script runs in the global
      // scope and its `initSqlJs` assignment reaches `globalThis`.
      // biome-ignore lint/security/noGlobalEval: sql.js UMD needs global eval to register initSqlJs
      // biome-ignore lint/style/noCommaOperator: the indirect-eval idiom relies on the comma operator
      (0, eval)(scriptText);
      // biome-ignore lint/suspicious/noExplicitAny: set by sql.js UMD script
      const initSqlJs = (globalThis as any).initSqlJs;
      return initSqlJs({
        locateFile: (file: string) => `${SQL_JS_CDN}/${file}`,
      });
    })();
    sqlModulePromise = p;
    p.catch(() => {
      if (sqlModulePromise === p) sqlModulePromise = null;
    });
  }
  return sqlModulePromise;
}

/**
 * Build the per-request loader chain from the user-supplied data
 * textareas. Each predicate in `csvData` or `jsonlData` becomes one entry
 * in the corresponding `Map`; only the format the user actually picked
 * for a predicate appears here, so a single predicate is never claimed by
 * both loaders. The CSV loader is registered first to match the historic
 * default, but `canLoad` keys off the predicate name, so order is
 * irrelevant for correctness.
 */
function buildLoaders(
  csvData: Record<string, string>,
  jsonlData: Record<string, string>,
  csvUrlData: Record<string, string>,
): Array<InMemoryCsvLoader | InMemoryJsonlLoader | UrlCsvLoader> {
  const loaders: Array<InMemoryCsvLoader | InMemoryJsonlLoader | UrlCsvLoader> = [];
  const csvMap = new Map(Object.entries(csvData));
  if (csvMap.size > 0) loaders.push(new InMemoryCsvLoader(csvMap));
  const jsonlMap = new Map(Object.entries(jsonlData));
  if (jsonlMap.size > 0) loaders.push(new InMemoryJsonlLoader(jsonlMap));
  const csvUrlMap = new Map(Object.entries(csvUrlData).filter(([, url]) => url.trim() !== ""));
  if (csvUrlMap.size > 0) loaders.push(new UrlCsvLoader(csvUrlMap));
  return loaders;
}

// biome-ignore lint/suspicious/noExplicitAny: sql.js module shape varies by bundler
function createBackend(SQL: any): Backend {
  return sqljsBackendForDatabase(new SQL.Database());
}

/**
 * `Error.message` for thrown `Error` instances, the stringified form
 * for everything else. Matches what every worker handler used to do
 * inline; preferring `.message` strips the leading `"Error: "` prefix
 * that `String(err)` would produce.
 */
function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `fn` and post a `<kind>-result` / `<kind>-error` message back to
 * the main thread. `resultKey` is `"results"` for the execute handler
 * (which posts an array) and `"result"` for the others. Handlers with
 * bespoke error semantics (e.g. lint, which packages parse errors as a
 * diagnostic instead of an error envelope) keep their own try/catch.
 */
async function respond<T>(
  id: number,
  kind: "execute" | "dry-run" | "step",
  fn: () => Promise<T>,
  resultKey: "result" | "results" = "result",
): Promise<void> {
  try {
    const value = await fn();
    self.postMessage({ type: `${kind}-result`, id, [resultKey]: value });
  } catch (err) {
    self.postMessage({ type: `${kind}-error`, id, error: formatError(err) });
  }
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      await ensureSqlJs();
      self.postMessage({ type: "init-done" });
    } catch (err) {
      self.postMessage({ type: "init-error", error: formatError(err) });
    }
    return;
  }

  if (msg.type === "execute") {
    let backend: Backend | undefined;
    try {
      await respond(
        msg.id,
        "execute",
        async () => {
          const SQL = await ensureSqlJs();
          backend = createBackend(SQL);
          const loaders = buildLoaders(msg.csvData, msg.jsonlData, msg.csvUrlData);
          const executor = new DatamogExecutor(backend, loaders);
          return executor.execute(msg.source);
        },
        "results",
      );
    } finally {
      // Free the WASM SQLite database even on error so the worker doesn't
      // leak a database handle every time the user runs an invalid program.
      await backend?.close();
    }
    return;
  }

  if (msg.type === "dry-run") {
    await respond(msg.id, "dry-run", async () => {
      const dialect = dialectFor(msg.backend);
      if (!dialect) {
        throw new Error(`Backend '${msg.backend}' produces no SQL — use 'step' instead`);
      }
      const analyzed = DatamogExecutor.prepare(msg.source);
      const result = translate(analyzed, dialect);
      const elements = extractAstElements(analyzed);
      const payload: DryRunResult = { result, elements };
      return payload;
    });
    return;
  }

  if (msg.type === "lint") {
    try {
      const typed = DatamogExecutor.prepare(msg.source);
      // Errors above are throws; warnings are static-analysis findings
      // returned as data. Surface `findInertPolarity` and `findInfiniteRisks`
      // results as severity:"warning" diagnostics so the editor renders them
      // as yellow squigglies instead of red.
      const diagnostics = [
        ...findInertPolarity(typed).map((d) => ({
          message: d.message,
          from: d.offset,
          to: d.end,
          severity: "warning" as const,
          cycle: undefined,
        })),
        ...findInfiniteRisks(typed).map((d) => ({
          message: d.message,
          from: d.offset,
          to: d.end,
          severity: "warning" as const,
          cycle: d.cycle
            ? {
                kind: "finiteness" as const,
                cycle: elideCycleLabels(d.cycle, msg.source),
              }
            : undefined,
        })),
      ];
      // Recursive-call spans drive the editor's superscript glyph
      // after each body atom that loops back into its rule's SCC.
      const recursiveCalls = findRecursiveCalls(typed).map((c) => ({
        start: c.offset,
        end: c.end,
      }));
      // Predicate references drive the editor's Cmd/Ctrl+click
      // jump-to-definition.
      const predicateReferences = findPredicateReferences(typed).map((r) => ({
        start: r.offset,
        end: r.end,
        target: r.definitionOffset,
      }));
      self.postMessage({
        type: "lint-result",
        id: msg.id,
        result: {
          diagnostics,
          recursiveCalls,
          predicateReferences,
          // A constraints-only program has something to run too: checking its
          // constraints is the point of running it.
          hasQueries: typed.queries.length > 0 || typed.constraints.length > 0,
        },
      });
    } catch (err: unknown) {
      const diag: {
        message: string;
        from?: number;
        to?: number;
        severity: "error";
        cycle?: { kind: "negation"; cycle: import("datamog-core").NegationCycle };
      } = {
        message: formatError(err),
        severity: "error",
      };
      // ParseError now carries `offset`/`end` alongside `line`/`column`, so
      // both error classes expose the same byte-offset surface.
      if (err instanceof ParseError || err instanceof AnalyzerError) {
        diag.from = err.offset;
        diag.to = err.end;
      }
      // Non-stratified-negation errors carry a dependency cycle —
      // surface it on the error diagnostic so the linter can offer the
      // same "Show cycle" action as the finiteness warning case.
      if (err instanceof AnalyzerError && err.cycle) {
        diag.cycle = { kind: "negation", cycle: err.cycle };
      }
      // Parse/analyse failed → there is no analyzed program to read
      // recursive calls or predicate references from; fall back to
      // empty lists so the editor clears any markers from the previous
      // successful lint.
      self.postMessage({
        type: "lint-result",
        id: msg.id,
        result: {
          diagnostics: [diag],
          recursiveCalls: [],
          predicateReferences: [],
          hasQueries: false,
        },
      });
    }
    return;
  }

  if (msg.type === "step") {
    let backend: Backend | undefined;
    try {
      await respond(msg.id, "step", async () => {
        const events: TraceEvent[] = [];
        let capInfo: IterationCapInfo | undefined;
        const createStepBackend =
          msg.engine === "seminaive" ? createSeminaiveBackend : createNativeBackend;
        backend = await createStepBackend({
          trace: (e) => events.push(e),
          maxIterations: msg.maxIterations,
          onIterationCap: (info) => {
            capInfo = info;
          },
        });
        const loaders = buildLoaders(msg.csvData, msg.jsonlData, msg.csvUrlData);
        const executor = new DatamogExecutor(backend, loaders);
        // Parse + analyse once and reuse for both running the program and
        // building the schema/strata/rules attached to the result.
        const analyzed = DatamogExecutor.prepare(msg.source);
        const queries = await executor.executeAnalyzed(analyzed);

        const schema: Record<string, string[]> = {};
        for (const decl of analyzed.extDecls.values()) {
          schema[decl.predicate] = decl.columns.map((c) => c.name);
        }
        for (const pred of analyzed.rules.keys()) {
          const arity = analyzed.arities.get(pred) ?? 0;
          schema[pred] = Array.from({ length: arity }, (_, i) => `col${i + 1}`);
        }
        const strata = analyzed.sortedStrata.map((predicates) => ({
          predicates: [...predicates],
          recursive: predicates.some((p) => analyzed.recursivePredicates.has(p)),
        }));
        const rules: Record<string, Array<{ text: string; span: SourceSpan }>> = {};
        for (const [predicate, predRules] of analyzed.rules) {
          rules[predicate] = predRules.map((r) => {
            const cst = r.$cstNode;
            return {
              text: cst?.text ?? "",
              span: cst ? { start: cst.offset, end: cst.end } : { start: 0, end: 0 },
            };
          });
        }
        const result: StepResult = {
          events,
          schema,
          strata,
          extensionals: [...analyzed.extDecls.keys()],
          rules,
          queries,
          iterationCap: capInfo ? formatIterationCap(capInfo) : undefined,
        };
        return result;
      });
    } finally {
      // Mirrors the execute path's finally — drop the backend even on
      // error so a failed step run doesn't keep its evaluator state alive.
      await backend?.close();
    }
    return;
  }

  if (msg.type === "complete") {
    try {
      const candidates = collectCompletionCandidates(msg.source, msg.offset);
      self.postMessage({
        type: "complete-result",
        id: msg.id,
        result: { candidates },
      });
    } catch (err) {
      // `parseLenient` shouldn't throw, but if Chevrotain ever does
      // (e.g. on a malformed UTF-16 surrogate pair the lexer can't
      // recover from), surface an empty list rather than wedging the
      // editor: completion is a best-effort hint, not a hard error.
      self.postMessage({
        type: "complete-error",
        id: msg.id,
        error: formatError(err),
      });
    }
    return;
  }
};
