#!/usr/bin/env bun
import { dirname, extname, resolve } from "node:path";
import type { IterationCapInfo } from "datamog-backend-native";
import type { DataSource, ElaborationResult, ExtDecl } from "datamog-core";
import {
  AnalyzerError,
  analyze,
  checkModuleBoundaries,
  elaborate,
  findInertContracts,
  findInertPolarity,
  findInfiniteRisks,
  findNullnessRisks,
  inferTypes,
  obligationScript,
} from "datamog-core";
import { CsvLoader, parseCsvContent } from "datamog-csv";
import {
  type Backend,
  DatamogExecutor,
  type ExtensionalLoader,
  type LoadResult,
  type SqlDialect,
  expandGitHubShorthand,
  insertRows,
  rowsToMermaid,
  translate,
} from "datamog-engine";
import { createNodeModuleResolver } from "datamog-engine/module-resolver";
import { type GSheetAuth, GSheetLoader } from "datamog-gsheet";
import { JsonLoader, parseJsonContent } from "datamog-json";
import { JsonlLoader, parseJsonlContent } from "datamog-jsonl";
import {
  MermaidLoader,
  mermaidEdgesToRows,
  parseMermaidGraph,
  validateMermaidColumns,
} from "datamog-mermaid";
import { ParseError, parseRaw, postProcess } from "datamog-parser";
import { bigintSafeReplacer, formatCellAsString, prettifyProofRows } from "./output.ts";
import { runRepl } from "./repl-driver.ts";

function usage(exitCode = 1): never {
  console.error("Usage: datamog [global options] <program.dl> [output] [--<input> <source>]...");
  console.error("       datamog --repl [--json] [global options]");
  console.error();
  console.error("  <program.dl>   Path to a Datamog (.dl) source file");
  console.error("  [output]       Output predicate to evaluate: an `output predicate` name, or");
  console.error("                 `default`. Defaults to the program's `?-` default output.");
  console.error("  no program.dl  Start an interactive REPL");
  console.error();
  console.error("Input flags (after the program):");
  console.error("  --<input> <source>   Supply data for input predicate <input> from a file or");
  console.error("                       URL (.csv/.jsonl/.json/.mmd), a Google Sheets URL, or a");
  console.error(
    "                       GitHub shorthand github:OWNER/REPO/PATH[#REF] (gh: alias).",
  );
  console.error("                       A kebab-case flag (--road-network) aliases the exact");
  console.error("                       predicate name (road_network) when unambiguous.");
  console.error("  --input name=source  Same, for an input whose name is not a valid flag.");
  console.error("                       An input with no flag auto-loads from");
  console.error("                       <input>.{csv,jsonl,json,mmd} in the data directory.");
  console.error();
  console.error("Global options (before the program):");
  console.error("  --output-format <format>   table (default), csv, jsonl, jsonl-flat, mermaid,");
  console.error("                             or ascii-graph");
  console.error("  --backend <backend>        postgres, sqlite, sqljs, native, or seminaive");
  console.error(
    "                             (default: postgres if DATABASE_URL is set, else sqlite)",
  );
  console.error("  --data-dir <path>          Directory to auto-load inputs from (default: the");
  console.error("                             program's directory; working directory in --repl)");
  console.error("  --all                      Evaluate every output, not just one (table only)");
  console.error("  --dry-run                  Print generated SQL without executing");
  console.error("  --obligations              Print refinement proof obligations as SMT-LIB 2");
  console.error("  --strict-contracts         Treat refinement-contract advisories as errors");
  console.error("  --warn-finiteness          Print a warning for each predicate column whose");
  console.error("                             values may grow unboundedly across iterations");
  console.error("  --max-iterations <n>       Cap fixed-point passes per stratum and stop with a");
  console.error("                             note instead of looping (native/seminaive only)");
  console.error("  --csv-no-header            CSV inputs have no header row");
  console.error("  --repl                     Start an interactive REPL (default with no program)");
  console.error("  --json                     In REPL mode, emit ndjson events on stdout");
  console.error("  -h, --help                 Show this help message");
  console.error();
  console.error("Environment:");
  console.error(
    "  DATABASE_URL                    Postgres connection string (uses in-memory SQLite if not set)",
  );
  console.error(
    "  GOOGLE_API_KEY                  API key for Google Sheets (public sheets, read-only)",
  );
  console.error("  GOOGLE_SERVICE_ACCOUNT_EMAIL    Service account email (for private sheets)");
  console.error(
    "  GOOGLE_PRIVATE_KEY              Service account private key (for private sheets)",
  );
  process.exit(exitCode);
}

const BACKEND_NAMES = ["postgres", "sqlite", "sqljs", "native", "seminaive"] as const;
type BackendName = (typeof BACKEND_NAMES)[number];

const OUTPUT_FORMATS = ["table", "csv", "jsonl", "jsonl-flat", "mermaid", "ascii-graph"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

function isBackendName(value: string | undefined): value is BackendName {
  return value !== undefined && (BACKEND_NAMES as readonly string[]).includes(value);
}

function isOutputFormat(value: string | undefined): value is OutputFormat {
  return value !== undefined && (OUTPUT_FORMATS as readonly string[]).includes(value);
}

async function createSqlDialect(name: BackendName): Promise<SqlDialect> {
  switch (name) {
    case "postgres": {
      const { PostgresSqlDialect } = await import("datamog-backend-postgres");
      return new PostgresSqlDialect();
    }
    case "sqljs":
    case "sqlite": {
      const { SqliteSqlDialect } = await import("datamog-backend-sqlite");
      return new SqliteSqlDialect();
    }
    case "native":
      throw new Error("--dry-run is not supported for the native backend (no SQL is produced)");
    case "seminaive":
      throw new Error("--dry-run is not supported for the seminaive backend (no SQL is produced)");
  }
}

/**
 * Iteration-cap options for the in-memory backends. Undefined cap → no options
 * (unlimited, the default). The cap only applies to native/seminaive; SQL
 * backends ignore it.
 */
function capOptions(
  maxIterations: number | undefined,
  format: (info: IterationCapInfo) => string,
): { maxIterations?: number; onIterationCap?(info: IterationCapInfo): void } {
  if (maxIterations === undefined) return {};
  return {
    maxIterations,
    onIterationCap: (info) => {
      console.error(format(info));
    },
  };
}

async function createBackend(name: BackendName, maxIterations?: number): Promise<Backend> {
  switch (name) {
    case "postgres": {
      const { create } = await import("datamog-backend-postgres");
      return create();
    }
    case "sqljs": {
      const { create } = await import("datamog-backend-sqljs");
      return create();
    }
    case "sqlite": {
      const { create } = await import("datamog-backend-sqlite");
      return create();
    }
    case "native": {
      const { create, formatIterationCap } = await import("datamog-backend-native");
      return create(capOptions(maxIterations, formatIterationCap));
    }
    case "seminaive": {
      const { create, formatIterationCap } = await import("datamog-backend-seminaive");
      return create(capOptions(maxIterations, formatIterationCap));
    }
  }
}

// Exported so a focused unit test can verify the spreadsheet-ID
// extraction without invoking the loader (which needs network + auth).
// `[^/?#]+` stops at the path separator, the query-string boundary, AND
// the URL fragment marker — bare `[^/]+` would let a `?gid=...` query
// or a `#fragment` leak into the captured ID, producing a malformed
// CSV-export URL when the loader appends `/export?format=csv`.
export const GSHEET_URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/?#]+)/;

export type ExplicitSourceFormat = ".csv" | ".jsonl" | ".json" | ".mmd";
const EXPLICIT_SOURCE_FORMATS: readonly ExplicitSourceFormat[] = [
  ".csv",
  ".jsonl",
  ".json",
  ".mmd",
];

function httpUrlFor(source: string): URL | undefined {
  try {
    const url = new URL(source);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function explicitSourceFormat(source: string): ExplicitSourceFormat | undefined {
  const url = httpUrlFor(source);
  const ext = extname(url ? url.pathname : source).toLowerCase();
  return (EXPLICIT_SOURCE_FORMATS as readonly string[]).includes(ext)
    ? (ext as ExplicitSourceFormat)
    : undefined;
}

/**
 * Loader for an explicit source → predicate mapping supplied by an input flag
 * (`--<input> <source>` or `--input name=source`).
 */
export class ExplicitSourceLoader implements ExtensionalLoader {
  readonly name: string;
  private predicateName: string;
  private source: string;
  private format: ExplicitSourceFormat;
  private hasHeader: boolean;

  constructor(
    predicateName: string,
    source: string,
    format: ExplicitSourceFormat,
    hasHeader: boolean,
  ) {
    this.predicateName = predicateName;
    this.source = httpUrlFor(source)?.href ?? resolve(source);
    this.format = format;
    this.hasHeader = hasHeader;
    this.name = `explicit:${predicateName}`;
  }

  async canLoad(decl: ExtDecl): Promise<boolean> {
    return decl.predicate === this.predicateName;
  }

  async load(decl: ExtDecl, backend: Backend): Promise<LoadResult> {
    const content = await this.readText();

    if (this.format === ".csv") {
      return this.loadCsv(content, decl, backend);
    }
    if (this.format === ".jsonl") {
      return this.loadJsonl(content, decl, backend);
    }
    if (this.format === ".json") {
      return this.loadJson(content, decl, backend);
    }
    if (this.format === ".mmd") {
      return this.loadMermaid(content, decl, backend);
    }
    throw new Error(
      `Unsupported source format '${this.format}' for predicate '${this.predicateName}'`,
    );
  }

  private async readText(): Promise<string> {
    const url = httpUrlFor(this.source);
    if (!url) {
      return Bun.file(this.source).text();
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch input source '${url.href}' for predicate '${this.predicateName}': ${response.status} ${response.statusText}`,
      );
    }
    return response.text();
  }

  private async loadCsv(content: string, decl: ExtDecl, backend: Backend): Promise<LoadResult> {
    const rows = parseCsvContent(content, decl, {
      hasHeader: this.hasHeader,
      source: this.source,
    });
    await insertRows(backend, decl, rows);
    return { rowsLoaded: rows.length };
  }

  private async loadJsonl(content: string, decl: ExtDecl, backend: Backend): Promise<LoadResult> {
    const rows = parseJsonlContent(content, decl, { source: this.source });
    await insertRows(backend, decl, rows);
    return { rowsLoaded: rows.length };
  }

  private async loadJson(content: string, decl: ExtDecl, backend: Backend): Promise<LoadResult> {
    const rows = parseJsonContent(content, decl, { source: this.source });
    await insertRows(backend, decl, rows);
    return { rowsLoaded: rows.length };
  }

  private async loadMermaid(content: string, decl: ExtDecl, backend: Backend): Promise<LoadResult> {
    validateMermaidColumns(decl);
    const rows = mermaidEdgesToRows(decl, parseMermaidGraph(content));
    await insertRows(backend, decl, rows);
    return { rowsLoaded: rows.length };
  }
}

function parseInputArg(arg: string): { name: string; source: string } {
  const eqIdx = arg.indexOf("=");
  if (eqIdx === -1) {
    console.error(`Invalid --input: expected name=source, got '${arg}'`);
    process.exit(1);
  }
  const name = arg.slice(0, eqIdx);
  const source = arg.slice(eqIdx + 1);
  if (name === "") {
    console.error(`Invalid --input: name is empty in '${arg}'`);
    process.exit(1);
  }
  if (source === "") {
    console.error(`Invalid --input: source is empty in '${arg}'`);
    process.exit(1);
  }
  return { name, source };
}

/** Value of a value-taking flag, or exit with a diagnostic if it is missing. */
function requireValue(args: string[], idx: number, flag: string): string {
  const value = args[idx];
  // Reject a following option (`--data-dir --dry-run`): the values these flags
  // take are names, dirs, or enums, never `-`-leading, so a `-`-leading token
  // is a forgotten value, not the value itself. Otherwise the next flag is
  // silently swallowed and its effect lost.
  if (value === undefined || value.startsWith("-")) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  return value;
}

/**
 * Resolve a `--<flag>` after the program to one of the program's input
 * predicate names: an exact match, else a unique match after normalising both
 * sides (lowercase, strip `-`/`_`) so `--road-network` reaches `road_network`
 * or `roadNetwork`. Ambiguity or no match is a diagnostic exit.
 */
function resolveInputFlag(flagName: string, inputNames: string[]): string {
  if (inputNames.includes(flagName)) return flagName;
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const target = norm(flagName);
  const matches = inputNames.filter((n) => norm(n) === target);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    console.error(
      `--${flagName} is ambiguous; it matches ${matches.join(", ")}. Use the exact predicate name.`,
    );
    process.exit(1);
  }
  console.error(
    inputNames.length > 0
      ? `--${flagName} is not an input predicate. Available: ${inputNames.join(", ")}.`
      : `--${flagName} is not an input predicate; the program declares none.`,
  );
  process.exit(1);
}

function resolveGSheetAuth(): GSheetAuth | undefined {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (email && key) {
    return { serviceAccountEmail: email, privateKey: key };
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (apiKey) {
    return { apiKey };
  }

  return undefined;
}

/**
 * Parse the entry, elaborate its `:=` source bindings into one merged program
 * (resolving module imports relative to the entry file), and post-process it.
 * Returns the merged program plus the data-file bindings for loader setup.
 */
function loadProgram(source: string, file: string): ElaborationResult {
  const raw = parseRaw(source, file);
  let result: ElaborationResult;
  try {
    result = elaborate(raw, createNodeModuleResolver(), file);
  } catch (e) {
    if (e instanceof AnalyzerError) e.file ??= file;
    throw e;
  }
  try {
    postProcess(result.program);
  } catch (e) {
    if (e instanceof ParseError) e.file ??= file;
    throw e;
  }
  return result;
}

function formatFromName(name: string): ExplicitSourceFormat | undefined {
  switch (name) {
    case "csv":
      return ".csv";
    case "jsonl":
      return ".jsonl";
    case "json":
      return ".json";
    case "mermaid":
    case "mmd":
      return ".mmd";
    default:
      return undefined;
  }
}

/** Loaders for `input predicate P(...) := "file" [as fmt]` data-file bindings.
 *  A local path resolves relative to the binding's own file; a URL / `gh:`
 *  source is taken as-is. The format is the `as` override or the extension. */
function buildDataSourceLoaders(
  dataSources: DataSource[],
  csvHasHeader: boolean,
): ExtensionalLoader[] {
  const loaders: ExtensionalLoader[] = [];
  for (const ds of dataSources) {
    let src: string;
    try {
      src = expandGitHubShorthand(ds.source);
    } catch (e) {
      console.error(`Invalid source for '${ds.predicate}' (${ds.source}): ${(e as Error).message}`);
      process.exit(1);
    }
    if (!httpUrlFor(src)) {
      src = resolve(ds.baseFile ? dirname(ds.baseFile) : process.cwd(), src);
    }
    const format = ds.format ? formatFromName(ds.format) : explicitSourceFormat(src);
    if (ds.format && !format) {
      console.error(
        `Unknown format '${ds.format}' for '${ds.predicate}' (expected csv, jsonl, json, mermaid)`,
      );
      process.exit(1);
    }
    if (!format) {
      console.error(
        `Cannot infer a format for '${ds.predicate}' from source '${ds.source}'; add 'as <format>'`,
      );
      process.exit(1);
    }
    loaders.push(new ExplicitSourceLoader(ds.predicate, src, format, csvHasHeader));
  }
  return loaders;
}

function buildExplicitLoaders(
  mappings: { name: string; source: string }[],
  csvHasHeader: boolean,
): ExtensionalLoader[] {
  // Reject the same input mapped twice (`--p a --p b`) — the duplicate would
  // silently no-op (the first loader wins, since `ExplicitSourceLoader.canLoad`
  // matches by predicate name and the executor stops at the first hit).
  // Without this check the user has no signal that the second flag had no
  // effect, which is genuinely confusing if it was a typo or override
  // attempt.
  const seen = new Map<string, string>();
  for (const { name, source } of mappings) {
    const prev = seen.get(name);
    if (prev !== undefined) {
      console.error(
        `Input source for predicate '${name}' specified twice (first '${prev}', then '${source}')`,
      );
      process.exit(1);
    }
    seen.set(name, source);
  }

  const loaders: ExtensionalLoader[] = [];
  const gsheetSheets: Record<string, { spreadsheetId: string }> = {};

  for (const { name, source: rawSource } of mappings) {
    let source: string;
    try {
      source = expandGitHubShorthand(rawSource);
    } catch (e) {
      console.error(`Invalid source for input '${name}' (${rawSource}): ${(e as Error).message}`);
      process.exit(1);
    }

    const gsheetMatch = GSHEET_URL_RE.exec(source);
    if (gsheetMatch) {
      gsheetSheets[name] = { spreadsheetId: gsheetMatch[1]! };
      continue;
    }

    const format = explicitSourceFormat(source);
    if (!format) {
      const url = httpUrlFor(source);
      const ext = extname(url ? url.pathname : source).toLowerCase();
      console.error(
        `Unsupported source format '${ext}' for input '${name}' (${source}) (expected ${EXPLICIT_SOURCE_FORMATS.join(", ")})`,
      );
      process.exit(1);
    }

    loaders.push(new ExplicitSourceLoader(name, source, format, csvHasHeader));
  }

  if (Object.keys(gsheetSheets).length > 0) {
    const auth = resolveGSheetAuth();
    loaders.push(new GSheetLoader({ auth, sheets: gsheetSheets }));
  }

  return loaders;
}

function validateInputMappings(
  mappings: { name: string; source: string }[],
  inputNames: string[],
): void {
  const names = new Set(inputNames);
  for (const { name } of mappings) {
    if (names.has(name)) continue;
    console.error(
      names.size > 0
        ? `Input '${name}' is not an input predicate. Available: ${[...names].join(", ")}.`
        : `Input '${name}' is not an input predicate; the program declares none.`,
    );
    process.exit(1);
  }
}

async function printResult(header: string, rows: Record<string, unknown>[], format: OutputFormat) {
  switch (format) {
    case "table":
      console.log(`-- ${header}`);
      if (rows.length === 0) {
        // Empty result set — no binding satisfied the query.
        console.log("no");
      } else if (rows.length === 1 && Object.keys(rows[0]!).length === 0) {
        // Ground query with at least one matching binding — the
        // projection is empty, so all matches collapse to one
        // zero-column row.
        console.log("yes");
      } else {
        console.table(prettifyProofRows(rows));
      }
      console.log();
      break;
    case "csv": {
      if (rows.length === 0) break;
      const keys = Object.keys(rows[0]!);
      console.log(keys.join(","));
      for (const row of rows) {
        console.log(keys.map((k) => csvEscape(formatCellAsString(row[k]))).join(","));
      }
      break;
    }
    case "jsonl":
      for (const row of rows) {
        console.log(JSON.stringify(row, bigintSafeReplacer));
      }
      break;
    case "jsonl-flat":
      for (const row of rows) {
        console.log(JSON.stringify(Object.values(row), bigintSafeReplacer));
      }
      break;
    case "mermaid":
      console.log(rowsToMermaid(rows));
      break;
    case "ascii-graph": {
      if (rows.length === 0) break;
      const { renderMermaidASCII } = await import("beautiful-mermaid");
      console.log(renderMermaidASCII(rowsToMermaid(rows)));
      break;
    }
  }
}

function emitFinitenessWarnings(analyzed: Parameters<typeof findInfiniteRisks>[0]): void {
  const diags = findInfiniteRisks(analyzed);
  for (const d of diags) {
    console.error(`warning: ${d.message}`);
  }
}

/**
 * The refinement checker's advisories. Warnings by default, since the teaching
 * default stays permissive, and errors under `--strict-contracts` so CI can
 * take the strict reading. The flag governs them as a class rather than this
 * one diagnostic, so a later advisory is promoted by the same switch.
 * See doc/design/refinement-annotations.md §2.2 and §11.4.
 *
 * Returns whether anything was reported, so a strict run can exit non-zero.
 */
function emitContractDiagnostics(
  analyzed: Parameters<typeof findInertContracts>[0],
  strict: boolean,
): boolean {
  const diagnostics = findInertContracts(analyzed);
  for (const d of diagnostics) {
    console.error(`${strict ? "error" : "warning"}: ${d.message}`);
  }
  return diagnostics.length > 0;
}

// An inert `^` is always reported, unlike finiteness risks, which are opt-in
// behind --warn-finiteness. It costs one SCC walk and means the sigil never
// silently does nothing. See doc/design/parity-stratification.md §11.
function emitPolarityWarnings(analyzed: Parameters<typeof findInertPolarity>[0]): void {
  for (const d of findInertPolarity(analyzed)) {
    console.error(`warning: ${d.message}`);
  }
}

// Also always reported, and for the same reason: the symptom of both is a row
// that quietly is not there. Neither fires unless a NULL can actually reach the
// place in question, so a program with no nullable columns never sees these.
function emitNullnessWarnings(typed: Parameters<typeof findNullnessRisks>[0]): void {
  for (const d of findNullnessRisks(typed)) {
    console.error(`warning: ${d.message}`);
  }
}

function csvEscape(value: string): string {
  // `\r` on its own (old-Mac line endings) is as structurally significant
  // for CSV as `\n`; without it a value containing a bare CR would leak
  // through unquoted and corrupt the row layout on reparse.
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);

  let programPath: string | undefined;
  let dataDir: string | undefined;
  let dryRun = false;
  let csvNoHeader = false;
  let warnFiniteness = false;
  let strictContracts = false;
  let obligations = false;
  let allOutputs = false;
  let backendOverride: BackendName | undefined;
  let outputFormat: OutputFormat = "table";
  let maxIterations: number | undefined;
  let replMode = false;
  let jsonMode = false;
  // Data sources for input predicates. `--input name=source` is self-describing
  // (it names its own predicate), so it is a global usable before the program
  // and in --repl; the `--<input> source` sugar (resolved after the program)
  // adds to the same list.
  const inputMappings: { name: string; source: string }[] = [];

  // Phase 1: global options precede the program. Stop at the first bare token,
  // which is the program path; everything after it is program-specific (the
  // output positional and per-input flags) and is parsed once the program's
  // inputs and outputs are known. Globals come first so an option is never
  // mistaken for a flag naming an input predicate.
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--csv-no-header") csvNoHeader = true;
    else if (arg === "--warn-finiteness") warnFiniteness = true;
    else if (arg === "--strict-contracts") strictContracts = true;
    else if (arg === "--obligations") obligations = true;
    else if (arg === "--all") allOutputs = true;
    else if (arg === "--repl") replMode = true;
    else if (arg === "--json") jsonMode = true;
    else if (arg === "--input")
      inputMappings.push(parseInputArg(requireValue(args, ++i, "--input")));
    else if (arg.startsWith("--input="))
      inputMappings.push(parseInputArg(arg.slice("--input=".length)));
    else if (arg === "--data-dir") dataDir = requireValue(args, ++i, "--data-dir");
    else if (arg === "--backend") {
      const value = args[++i];
      if (!isBackendName(value)) {
        console.error(`Invalid backend: ${value} (expected ${BACKEND_NAMES.join(", ")})`);
        process.exit(1);
      }
      backendOverride = value;
    } else if (arg === "--output-format") {
      const value = args[++i];
      if (!isOutputFormat(value)) {
        console.error(`Invalid output format: ${value} (expected ${OUTPUT_FORMATS.join(", ")})`);
        process.exit(1);
      }
      outputFormat = value;
    } else if (arg === "--max-iterations") {
      const value = requireValue(args, ++i, "--max-iterations");
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`Invalid --max-iterations: ${value} (expected a positive integer)`);
        process.exit(1);
      }
      maxIterations = n;
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg} (global options must come before the program)`);
      usage();
    } else {
      programPath = arg;
      break;
    }
  }
  // Tokens after the program: an optional output positional, then input flags.
  const rest = programPath !== undefined ? args.slice(i + 1) : [];

  if (replMode || programPath === undefined) {
    if (programPath !== undefined) {
      console.error("--repl does not take a program file");
      process.exit(1);
    }
    if (dryRun || warnFiniteness || allOutputs || outputFormat !== "table") {
      console.error(
        "REPL mode is incompatible with --dry-run / --warn-finiteness / --all / --output-format",
      );
      process.exit(1);
    }
    const backendName: BackendName =
      backendOverride ?? (process.env.DATABASE_URL ? "postgres" : "sqlite");
    if (backendName === "postgres" && !process.env.DATABASE_URL) {
      console.error("Error: DATABASE_URL environment variable is required for --backend postgres");
      process.exit(1);
    }
    await runRepl({
      backendName,
      jsonMode,
      dataDir: dataDir ? resolve(dataDir) : process.cwd(),
      csvHasHeader: !csvNoHeader,
      explicitLoaders: buildExplicitLoaders(inputMappings, !csvNoHeader),
      createBackend: () => createBackend(backendName, maxIterations),
    });
    return;
  }

  if (jsonMode) {
    console.error("--json is only valid together with --repl");
    process.exit(1);
  }

  const dlFile = Bun.file(resolve(programPath));
  if (!(await dlFile.exists())) {
    console.error(`File not found: ${programPath}`);
    process.exit(1);
  }
  dataDir = dataDir ? resolve(dataDir) : dirname(resolve(programPath));
  const source = await dlFile.text();
  const { program, dataSources, boundaries } = loadProgram(source, programPath);

  // Discover the program's inputs and outputs. The `output` marker and `?-`
  // queries are all visible in the elaborated program, before analysis.
  const inputNames: string[] = [];
  const outputPreds = new Set<string>();
  let hasDefault = false;
  for (const stmt of program.statements) {
    if (stmt.$type === "ExtDecl") inputNames.push(stmt.predicate);
    else if (stmt.$type === "Rule") {
      // The analyzer treats an `output predicate` named `default` as the
      // file's default output (like a `?-`), not a named output.
      if (stmt.output) {
        if (stmt.head.predicate === "default") hasDefault = true;
        else outputPreds.add(stmt.head.predicate);
      }
    } else if (stmt.$type === "Query" && !stmt.isError) hasDefault = true;
  }
  const outputNames = [...outputPreds];

  // Phase 2: the output positional (if any) and the per-input flags. Input
  // mappings from phase 1 (`--input`) accumulate with these.
  let output: string | undefined;
  const flagMappings: { flagName: string; source: string }[] = [];
  let j = 0;
  if (rest[0] !== undefined && !rest[0].startsWith("-")) {
    output = rest[0];
    j = 1;
  }
  for (; j < rest.length; j++) {
    const arg = rest[j]!;
    if (arg === "--input") {
      inputMappings.push(parseInputArg(requireValue(rest, ++j, "--input")));
    } else if (arg.startsWith("--input=")) {
      inputMappings.push(parseInputArg(arg.slice("--input=".length)));
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flagMappings.push({ flagName: arg.slice(2, eq), source: arg.slice(eq + 1) });
      } else {
        const flagName = arg.slice(2);
        const value = rest[++j];
        if (value === undefined || value.startsWith("-")) {
          console.error(
            `--${flagName} requires a source (a path, URL, gh: shorthand, or Google Sheets URL)`,
          );
          process.exit(1);
        }
        flagMappings.push({ flagName, source: value });
      }
    } else {
      console.error(
        `Unexpected argument: ${arg} (the output must come directly after the program)`,
      );
      usage();
    }
  }
  for (const { flagName, source } of flagMappings) {
    inputMappings.push({ name: resolveInputFlag(flagName, inputNames), source });
  }
  validateInputMappings(inputMappings, inputNames);

  // Resolve which output to evaluate.
  if (allOutputs && output !== undefined) {
    console.error("--all cannot be combined with an explicit output");
    process.exit(1);
  }
  const selected = output ?? "default";
  if (!allOutputs) {
    if (selected === "default" && !hasDefault) {
      console.error(
        outputNames.length > 0
          ? `Program has no default output (a \`?-\` query). Name an output (${outputNames.join(", ")}) or use --all.`
          : "Program has no default output (a `?-` query) and no named outputs.",
      );
      process.exit(1);
    }
    if (selected !== "default" && !outputNames.includes(selected)) {
      const available = [...outputNames, ...(hasDefault ? ["default"] : [])];
      console.error(
        available.length > 0
          ? `Unknown output '${selected}'. Available: ${available.join(", ")}.`
          : `Unknown output '${selected}'. The program declares no outputs.`,
      );
      process.exit(1);
    }
  }
  if (allOutputs && outputFormat !== "table") {
    console.error(
      `--output-format ${outputFormat} cannot be combined with --all (it produces several results)`,
    );
    process.exit(1);
  }

  const backendName: BackendName =
    backendOverride ?? (process.env.DATABASE_URL ? "postgres" : "sqlite");

  const analyzed = inferTypes(analyze(program, programPath));
  checkModuleBoundaries(analyzed, boundaries);
  emitPolarityWarnings(analyzed);
  emitNullnessWarnings(analyzed);
  if (emitContractDiagnostics(analyzed, strictContracts) && strictContracts) {
    process.exitCode = 1;
    return;
  }
  // The script is the deliverable; nothing here runs a solver.
  if (obligations) {
    process.stdout.write(obligationScript(analyzed));
    return;
  }

  if (dryRun) {
    if (warnFiniteness) emitFinitenessWarnings(analyzed);
    const sqlDialect = await createSqlDialect(backendName);
    const translation = translate(analyzed, sqlDialect);
    for (const stmt of translation.createTables) {
      console.log(stmt);
      console.log();
    }
    for (const stmt of translation.createViews) {
      console.log(stmt);
      console.log();
    }
    // Constraints run before any query, so preview them in that order. They are
    // not outputs, so output selection does not apply.
    for (const sql of translation.constraints) {
      console.log(sql);
      console.log();
    }
    analyzed.queries.forEach((query, idx) => {
      if (allOutputs || (query.outputName ?? "default") === selected) {
        console.log(translation.queries[idx]!);
        console.log();
      }
    });
    return;
  }

  if (warnFiniteness) {
    emitFinitenessWarnings(analyzed);
  }

  if (backendName === "postgres" && !process.env.DATABASE_URL) {
    console.error("Error: DATABASE_URL environment variable is required for --backend postgres");
    process.exit(1);
  }

  const explicitLoaders = buildExplicitLoaders(inputMappings, !csvNoHeader);
  // Precedence: an explicit `--input` beats a program `:=` data binding, which
  // beats the auto-load-by-convention directory loaders.
  const dataSourceLoaders = buildDataSourceLoaders(dataSources, !csvNoHeader);
  const backend = await createBackend(backendName, maxIterations);
  const executor = new DatamogExecutor(backend, [
    ...explicitLoaders,
    ...dataSourceLoaders,
    new CsvLoader({ directory: dataDir, hasHeader: !csvNoHeader }),
    // The JSONL loader's single-json-column case also matches `.jsonl` files,
    // so place the JSON file loader earlier — its `canLoad` checks for a
    // `.json` (singular) file specifically, so the two don't compete.
    new JsonLoader({ directory: dataDir }),
    new JsonlLoader({ directory: dataDir }),
    new MermaidLoader({ directory: dataDir }),
  ]);

  try {
    const results = await executor.executeAnalyzed(analyzed);
    const chosen = allOutputs
      ? results
      : results.filter((r) => (r.label ?? "default") === selected);

    if (outputFormat === "mermaid" || outputFormat === "ascii-graph") {
      for (const result of chosen) {
        if (result.rows.length > 0) {
          const colCount = Object.keys(result.rows[0]!).length;
          // 2 columns => `src --> dst`; 3 columns => `src -- label --> dst`.
          if (colCount !== 2 && colCount !== 3) {
            console.error(
              `--output-format ${outputFormat} requires a binary or ternary predicate (2 or 3 columns), but got ${colCount}`,
            );
            process.exit(1);
          }
        }
      }
    }

    for (const result of chosen) {
      // Named outputs print under the output predicate's name; the `?-` default
      // prints under "default".
      const header = result.label ?? (result.sql === "" ? (result.source ?? "") : result.sql);
      await printResult(header, result.rows, outputFormat);
    }
  } finally {
    await backend.close();
  }
}

// Top-level run only when invoked directly (`bun run main.ts`); skip when
// imported (e.g. by unit tests that exercise small helpers like
// `GSHEET_URL_RE`).
if (import.meta.main) {
  main().catch((err) => {
    // `ParseError` / `AnalyzerError` carry the source file when the program
    // came from one; prefix it so a failing run names the file (a `?-` from
    // stdin/REPL has no file and renders as before).
    const file =
      err && typeof err === "object" && "file" in err ? (err as { file?: string }).file : undefined;
    const message = err?.message ?? String(err);
    console.error(file ? `${file}: ${message}` : message);
    process.exit(1);
  });
}
