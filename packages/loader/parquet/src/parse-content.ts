import type { ExtDecl } from "datamog-core";
import { checkColumnValue } from "datamog-engine";
import { parquetReadObjects } from "hyparquet";

export interface ParseParquetOptions {
  /** Used in error messages to identify the source (file path or predicate name). */
  source?: string;
}

/**
 * Parse a Parquet file into typed rows according to `decl`. Only the
 * declared columns are decoded — that is the point of a columnar format,
 * and a declaration naming a column the file lacks is an error rather
 * than an empty column. Shared between the directory-based
 * `ParquetLoader` and the CLI's explicit-file loader, and deliberately
 * free of `node:`/`Bun.*` imports so a browser consumer can reach it via
 * the `datamog-parquet/parse-content` subpath.
 *
 * Compression: hyparquet decodes uncompressed and Snappy out of the box
 * (Snappy being what pyarrow, DuckDB and Spark write by default). A file
 * in another codec fails with hyparquet's own message naming the codec.
 */
export async function parseParquetContent(
  buffer: ArrayBuffer,
  decl: ExtDecl,
  options: ParseParquetOptions = {},
): Promise<Record<string, unknown>[]> {
  const source = options.source ?? `${decl.predicate}.parquet`;
  let rows: Record<string, unknown>[];
  try {
    rows = await parquetReadObjects({
      file: buffer,
      columns: decl.columns.map((c) => c.name),
      rowFormat: "object",
    });
  } catch (e) {
    // hyparquet's errors ("parquet column not found: x", "parquet file
    // invalid (footer != PAR1)") name neither the file nor the predicate,
    // which is unhelpful when several inputs load at once.
    throw new Error(`${source}: ${(e as Error).message}`);
  }

  return rows.map((row, i) => {
    const out: Record<string, unknown> = {};
    for (const col of decl.columns) {
      const context = `${source} row ${i + 1}, column '${col.name}'`;
      out[col.name] = checkColumnValue(fromParquet(row[col.name], context), col, context);
    }
    return out;
  });
}

/**
 * Map a cell hyparquet produced onto the value model. Three of its output
 * shapes have no Datamog counterpart:
 *
 *   - `INT64` (pyarrow's and DuckDB's default integer) arrives as a
 *     `bigint`, while an `integer` is a safe JS integer. One outside that
 *     range is an error, not a silent rounding.
 *   - a date / timestamp column arrives as a `Date`; there is no date
 *     type, so it loads as its ISO 8601 text.
 *   - raw bytes (a `FIXED_LEN_BYTE_ARRAY` with no logical type) have no
 *     representation at all. Strings, UUIDs and decimals are already
 *     decoded by the time they reach here, so this is the leftover case.
 *
 * Recurses through lists and structs, since those carry the same shapes
 * (a `LIST<INT64>` is an array of `bigint`) into a `value` column.
 */
function fromParquet(value: unknown, context: string): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(`Integer ${value} is outside the safe integer range (${context})`);
    }
    return n;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    throw new Error(`Unsupported binary column data (${context})`);
  }
  if (Array.isArray(value)) return value.map((v) => fromParquet(v, context));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromParquet(v, context)]));
  }
  return value;
}
