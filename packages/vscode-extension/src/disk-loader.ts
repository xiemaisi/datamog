import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import type { ExtDecl } from "datamog-core";
import { csvRowsFromKeyed } from "datamog-csv/parse-content";
import { type Backend, type ExtensionalLoader, type LoadResult, insertRows } from "datamog-engine";
import { parseJsonContent } from "datamog-json/parse-content";
import { parseJsonlContent } from "datamog-jsonl/parse-content";
import { parseParquetContent } from "datamog-parquet/parse-content";

// Extensions probed for each extensional predicate, in precedence order
// (matching the CLI's loader registration: CSV, then whole-file JSON, then
// JSONL, then Parquet). The first existing file wins.
const EXTENSIONS = [".csv", ".json", ".jsonl", ".parquet"] as const;

/**
 * Read a file as an `ArrayBuffer`. `readFile` hands back a `Buffer` that may
 * be a view into a larger pooled allocation, so its `buffer` needs slicing to
 * the file's own bytes.
 */
async function readArrayBuffer(path: string): Promise<ArrayBuffer> {
  const buf = await readFile(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Loads extensional data from files sitting next to the `.dl` program,
 * one file per predicate (`edge.csv`, `config.json`, `events.jsonl`).
 *
 * This is the Node counterpart to the engine's Bun-only directory loader:
 * it reads with `node:fs` instead of `Bun.file`, and parses through the
 * platform-neutral `parse-content` entry points so behaviour and error
 * shapes match the CLI and playground loaders.
 */
export class DiskLoader implements ExtensionalLoader {
  readonly name = "vscode-disk";

  constructor(private readonly directory: string) {}

  /** Resolve the data file for a predicate, or `undefined` if none exists. */
  fileFor(decl: ExtDecl): { path: string; ext: string } | undefined {
    for (const ext of EXTENSIONS) {
      const path = join(this.directory, `${decl.predicate}${ext}`);
      if (existsSync(path)) return { path, ext };
    }
    return undefined;
  }

  async canLoad(decl: ExtDecl): Promise<boolean> {
    return this.fileFor(decl) !== undefined;
  }

  async load(decl: ExtDecl, backend: Backend): Promise<LoadResult> {
    const match = this.fileFor(decl);
    if (!match) return { rowsLoaded: 0 };

    const rows =
      match.ext === ".parquet"
        ? await parseParquetContent(await readArrayBuffer(match.path), decl, {
            source: match.path,
          })
        : this.parse(await readFile(match.path, "utf8"), decl, match.ext, match.path);
    await insertRows(backend, decl, rows);
    return { rowsLoaded: rows.length };
  }

  private parse(
    content: string,
    decl: ExtDecl,
    ext: string,
    source: string,
  ): Record<string, unknown>[] {
    switch (ext) {
      case ".csv":
        return parseCsvContent(content, decl, source);
      case ".json":
        return parseJsonContent(content, decl, { source });
      default:
        return parseJsonlContent(content, decl, { source });
    }
  }
}

/**
 * Parse header-keyed CSV content into typed rows. Mirrors the playground's
 * in-memory CSV loader, but uses `csv-parse/sync` (Node) rather than the
 * browser build, and threads real source line numbers into `csvRowsFromKeyed`
 * so coercion errors point at the right line.
 */
function parseCsvContent(
  content: string,
  decl: ExtDecl,
  source: string,
): Record<string, unknown>[] {
  let parsed: { record: string[]; info: { lines: number } }[];
  try {
    parsed = parseCsv(content, {
      columns: false,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
      info: true,
    }) as unknown as { record: string[]; info: { lines: number } }[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`CSV parse error for '${source}': ${message}`);
  }

  const header = parsed[0]?.record;
  if (!header) return [];

  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) throw new Error(`${source}: duplicate field '${name}'`);
    seen.add(name);
  }

  // Reject a header missing a declared column up front, like the CLI and
  // playground CSV loaders. `csvRowsFromKeyed`'s own presence check runs
  // per record, so it is skipped for a header-only file (no records) and the
  // missing column would otherwise pass silently.
  for (const col of decl.columns) {
    if (!header.includes(col.name)) throw new Error(`${source}: missing field '${col.name}'`);
  }

  const dataRecords = parsed.slice(1);
  const records = dataRecords.map(({ record, info }) => {
    // Reject malformed rows the same way the Bun `CsvLoader` and the
    // playground loader do: a row with more fields than the header, or a
    // short row when the header width matches the declared arity. Without
    // this check the capped build loop silently dropped extra fields,
    // accepting a too-long row that every other loader rejects.
    if (
      record.length > header.length ||
      (record.length < header.length && header.length === decl.columns.length)
    ) {
      throw new Error(
        `${source} line ${info.lines}: expected ${header.length} fields but got ${record.length}`,
      );
    }
    const out: Record<string, string> = {};
    for (let i = 0; i < record.length && i < header.length; i++) {
      out[header[i]!] = record[i]!;
    }
    return out;
  });

  return csvRowsFromKeyed(records, decl, {
    source,
    lineNumOf: (i) => dataRecords[i]!.info.lines,
  });
}
