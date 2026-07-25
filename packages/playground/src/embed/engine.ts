// Main-thread engine for the embeddable mini-playground. Unlike the full
// playground (which runs everything in a Web Worker and can fall back to
// sql.js), the embed targets tiny tutorial programs, so it evaluates them
// directly on the main thread with the pure-TS native/seminaive backend.
// No worker, no WASM.
import {
  type IterationCapInfo,
  create as createNative,
  formatIterationCap,
} from "datamog-backend-native";
import { create as createSeminaive } from "datamog-backend-seminaive";
import { AnalyzerError, findInfiniteRisks } from "datamog-core";
import { DatamogExecutor, type QueryResult } from "datamog-engine";
import { ParseError } from "datamog-parser";
import { InMemoryCsvLoader } from "../lib/csv-loader.ts";
import { InMemoryJsonlLoader } from "../lib/jsonl-loader.ts";

export { collectCompletionCandidates } from "../lib/completion-candidates.ts";

/** In-memory interpreters the embed can run with. */
export type EmbedEngine = "native" | "seminaive";

/** Pre-baked extensional data, keyed by predicate name. */
export interface EmbedData {
  /** CSV text (with header row) per predicate. */
  csv?: Record<string, string>;
  /** JSONL text (one object per line) per predicate. */
  jsonl?: Record<string, string>;
}

export interface SimpleDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
}

export interface EmbedLintResult {
  diagnostics: SimpleDiagnostic[];
  /** True when the program has at least one `?-` query. */
  hasQueries: boolean;
}

/**
 * Parse + analyse `source`, returning error/warning diagnostics for the
 * editor's squiggly underlines. A thrown parse/analyse error becomes a
 * single error diagnostic at its source span (whole-document if the span
 * is unknown); finiteness risks become warnings.
 */
export function lintSource(source: string): EmbedLintResult {
  try {
    const typed = DatamogExecutor.prepare(source);
    const diagnostics: SimpleDiagnostic[] = findInfiniteRisks(typed).map((d) => ({
      from: d.offset ?? 0,
      to: d.end ?? source.length,
      severity: "warning",
      message: d.message,
    }));
    return { diagnostics, hasQueries: typed.queries.length > 0 };
  } catch (err) {
    const diag: SimpleDiagnostic = {
      from: 0,
      to: source.length,
      severity: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    if (err instanceof ParseError || err instanceof AnalyzerError) {
      if (err.offset !== undefined) diag.from = err.offset;
      if (err.end !== undefined) diag.to = err.end;
    }
    return { diagnostics: [diag], hasQueries: false };
  }
}

function buildLoaders(data: EmbedData): Array<InMemoryCsvLoader | InMemoryJsonlLoader> {
  const loaders: Array<InMemoryCsvLoader | InMemoryJsonlLoader> = [];
  const csv = Object.entries(data.csv ?? {});
  if (csv.length > 0) loaders.push(new InMemoryCsvLoader(new Map(csv)));
  const jsonl = Object.entries(data.jsonl ?? {});
  if (jsonl.length > 0) loaders.push(new InMemoryJsonlLoader(new Map(jsonl)));
  return loaders;
}

/**
 * Default per-stratum iteration cap for embeds. Tutorial programs converge in
 * far fewer passes, so this only ever trips a genuinely non-terminating
 * snippet (which would otherwise freeze the host page's tab). See
 * `doc/design/finiteness-checking.md`.
 */
export const DEFAULT_EMBED_MAX_ITERATIONS = 1000;

export interface RunProgramOptions {
  /** Per-stratum fixed-point cap. Defaults to `DEFAULT_EMBED_MAX_ITERATIONS`. */
  maxIterations?: number;
  /** Invoked if evaluation stopped early on the cap. */
  onIterationCap?(info: IterationCapInfo): void;
}

/**
 * Evaluate the whole program against the pre-baked data and return one
 * result per `?-` query. The backend is created and closed per run so a
 * failed run leaves no evaluator state behind. A per-stratum iteration cap is
 * on by default so a non-terminating snippet stops instead of freezing the
 * main thread.
 */
export async function runProgram(
  source: string,
  data: EmbedData,
  engine: EmbedEngine = "native",
  opts: RunProgramOptions = {},
): Promise<QueryResult[]> {
  const backend = await (engine === "seminaive" ? createSeminaive : createNative)({
    maxIterations: opts.maxIterations ?? DEFAULT_EMBED_MAX_ITERATIONS,
    onIterationCap: opts.onIterationCap,
  });
  try {
    return await new DatamogExecutor(backend, buildLoaders(data)).execute(source);
  } finally {
    await backend.close();
  }
}

export { formatIterationCap };
