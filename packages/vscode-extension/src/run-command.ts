import * as path from "node:path";
import { create as createSeminaiveBackend } from "datamog-backend-seminaive";
import type { TypedProgram } from "datamog-core";
import { DatamogExecutor, type QueryResult } from "datamog-engine";
import { createNodeModuleResolver } from "datamog-engine/module-resolver";
import * as vscode from "vscode";
import { DiskLoader } from "./disk-loader.ts";

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Datamog");
  }
  return channel;
}

/** Register the `datamog.run` command and its Output channel. */
export function registerRunCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("datamog.run", runActiveFile));
}

/**
 * Run the active `.dl` file through the in-process seminaive backend and show
 * its default output -- the one the file's `?-` query defines -- in the
 * "Datamog" Output channel. That is what `datamog <file>` prints; named
 * `output predicate`s are evaluated but not displayed, since this command
 * takes no arguments to select one with.
 *
 * Evaluates the buffer as-is (no save required). Extensional data is loaded
 * from sibling files next to a saved program (`<predicate>.csv/.json/.jsonl`,
 * via {@link DiskLoader}); predicates with no data file — or any extensional
 * at all in an unsaved buffer — are flagged by {@link warnAboutMissingData}.
 */
async function runActiveFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "datamog") {
    vscode.window.showWarningMessage("Datamog: open a .dl file to run it.");
    return;
  }

  const doc = editor.document;
  const source = doc.getText();
  const out = getChannel();
  out.clear();
  out.show(true);
  out.appendLine(`=== Datamog: run ${vscode.workspace.asRelativePath(doc.uri)} (seminaive) ===`);
  out.appendLine("");

  // Load extensional data from files sitting next to the .dl program
  // (edge.csv, config.json, …). Only file-scheme documents have an on-disk
  // directory; an unsaved buffer can't resolve sibling data files.
  const dataDir = doc.uri.scheme === "file" ? path.dirname(doc.uri.fsPath) : undefined;
  const loader = dataDir ? new DiskLoader(dataDir) : undefined;
  // The absolute path lets `from "mod.dl"` imports resolve relative to the
  // buffer; it also names the file in diagnostics. An unsaved buffer has no
  // path, so imports can't be resolved (and there's no directory to load from).
  const file = doc.uri.scheme === "file" ? doc.uri.fsPath : undefined;

  const backend = await createSeminaiveBackend();
  try {
    const started = Date.now();
    // Prepare separately from execution so we can inspect the analysed
    // program (here: warn about extensional predicates with no data file).
    // `prepareElaborated` resolves any `:=` module imports from disk first.
    const { program: analyzed } = DatamogExecutor.prepareElaborated(
      source,
      createNodeModuleResolver(),
      file,
    );
    await warnAboutMissingData(out, analyzed, loader, dataDir);
    const results = await new DatamogExecutor(backend, loader ? [loader] : []).executeAnalyzed(
      analyzed,
    );
    const elapsed = Date.now() - started;

    // The analysed program carries one result per `output predicate` as well as
    // one for the `?-` query, and there is at most one default. Show the
    // default, as the CLI does when given no output to select.
    const chosen = results.filter((r) => (r.label ?? "default") === "default");
    if (chosen.length === 0) {
      const named = results.map((r) => r.label).filter((label) => label !== undefined);
      out.appendLine(
        named.length > 0
          ? `No default output in this file. It declares ${named.join(", ")}; add a \`?-\` query for the one you want to see.`
          : "No default output in this file (no `?-` query) — nothing to display.",
      );
      out.appendLine("");
    }
    for (const result of chosen) {
      renderResult(out, result);
    }
    out.appendLine(`Done in ${elapsed} ms.`);
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    // `ParseError`/`AnalyzerError` carry the source file; prefix it when set.
    const errFile =
      err && typeof err === "object" && "file" in err ? (err as { file?: string }).file : undefined;
    const message = errFile ? `${errFile}: ${base}` : base;
    out.appendLine(`error: ${message}`);
    vscode.window.showErrorMessage(`Datamog: ${message}`);
  } finally {
    await backend.close();
  }
}

/**
 * Warn when extensional predicates won't be populated: either the buffer is
 * unsaved (no directory to read sibling data files from), or some predicate
 * has no matching `<predicate>.{csv,json,jsonl}` file next to the program.
 */
async function warnAboutMissingData(
  out: vscode.OutputChannel,
  analyzed: TypedProgram,
  loader: DiskLoader | undefined,
  dataDir: string | undefined,
): Promise<void> {
  if (analyzed.extDecls.size === 0) return;

  if (!loader) {
    out.appendLine(
      "note: save the file to load extensional data from sibling data files; extensional relations are empty for unsaved buffers.",
    );
    out.appendLine("");
    vscode.window.showWarningMessage(
      "Datamog: extensional relations are empty — save the file so data can be loaded from sibling .csv/.json/.jsonl files.",
    );
    return;
  }

  const missing: string[] = [];
  for (const [predicate, decl] of analyzed.extDecls) {
    if (!(await loader.canLoad(decl))) missing.push(predicate);
  }
  if (missing.length === 0) return;

  const names = missing.sort().join(", ");
  out.appendLine(
    `note: no data file for ${names} in ${dataDir}; these extensional relations will be empty. Add <predicate>.csv, .json, or .jsonl next to the program.`,
  );
  out.appendLine("");
  vscode.window.showWarningMessage(
    `Datamog: no data file for ${missing.length} extensional ${plural(missing.length, "relation", "relations")} (${names}) — looked for <predicate>.csv/.json/.jsonl next to the program.`,
  );
}

function renderResult(out: vscode.OutputChannel, result: QueryResult): void {
  out.appendLine(result.source ?? "(query)");

  const rows = result.rows;
  // Mirror the CLI's ground-query convention: empty result is "no", a single
  // column-less row is "yes"; otherwise render the rows as a table.
  if (rows.length === 0) {
    out.appendLine("  no");
    out.appendLine("");
    return;
  }
  if (rows.length === 1 && Object.keys(rows[0]!).length === 0) {
    out.appendLine("  yes");
    out.appendLine("");
    return;
  }

  out.appendLine(formatTable(rows));
  out.appendLine(`  (${rows.length} ${plural(rows.length, "row", "rows")})`);
  out.appendLine("");
}

function formatTable(rows: Record<string, unknown>[]): string {
  const keys = Object.keys(rows[0]!);
  const widths = keys.map((key) =>
    Math.max(key.length, ...rows.map((row) => formatCell(row[key]).length)),
  );
  const renderRow = (cells: string[]) =>
    `  ${cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ")}`;

  const lines = [renderRow(keys), renderRow(widths.map((w) => "-".repeat(w)))];
  for (const row of rows) {
    lines.push(renderRow(keys.map((key) => formatCell(row[key]))));
  }
  return lines.join("\n");
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
