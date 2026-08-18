// Mermaid output formatting helpers shared between the CLI's
// `--output-format mermaid` path and the playground's `MermaidView`.
// Both render a query result as a Mermaid `graph TD` definition; keeping
// one implementation here means the escaping/labeling rules can't drift
// between the two surfaces.

import { bigintSafeReplacer } from "./json-canonical.ts";

const EDGE_LABEL_BREAKERS = /---->|--->|-->|=====>|====>|===>|==>|-\.->|---|===|[|\r\n;]/g;

// Mermaid flowchart keywords its lexer grabs even mid-statement, so they
// can't stand alone as a node id: `b4 --> end` is a parse error because
// `end` closes a `subgraph`. Matched case-insensitively — Mermaid only
// reserves the lowercase token, but rewriting `End`/`END` too is harmless
// and shields us from renderer version differences.
const MERMAID_RESERVED = /^(?:end|subgraph|graph|flowchart)$/i;

/**
 * Escape an arbitrary string into a Mermaid node identifier. A safe
 * id (alphanumerics + `.`/`-`/`_`, starting with `\w`) is returned
 * unchanged; anything else becomes `safeId["original label"]`, with `"`
 * inside the label escaped as Mermaid's HTML entity `#quot;`. When the
 * input collapses to an empty safe-id (every char was special, or the
 * value itself was empty) we fall back to `n` so we don't emit invalid
 * Mermaid like `[""] --> B`. A reserved keyword (e.g. `end`) takes the
 * quoted-label path too, with a `_`-suffixed id (`end_["end"]`) so the
 * emitted id is no longer the bare keyword while the label still reads
 * `end`.
 */
export function mermaidEscape(id: string): string {
  if (/^[\w][\w.-]*$/.test(id) && !MERMAID_RESERVED.test(id)) return id;
  let safeId = id.replace(/[^a-zA-Z0-9_]/g, "_") || "n";
  if (MERMAID_RESERVED.test(safeId)) safeId += "_";
  return `${safeId}["${id.replace(/"/g, "#quot;").replace(/[\r\n]/g, " ")}"]`;
}

/**
 * Render an array of result rows as a Mermaid `graph TD`. The first
 * column is treated as the source, the second as the target, and the
 * third (when present) as an inline edge label rendered with
 * `-- label -->`. Pipes, semicolons, arrow tokens, and CR/LF inside
 * labels collapse to spaces: they are Mermaid syntax in this context
 * and would otherwise terminate the label, start another statement, or
 * split the edge across multiple lines. Returns an empty `graph TD\n`
 * when given no rows so callers can still hand the output to a renderer
 * without special-casing the empty case.
 */
export function rowsToMermaid(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "graph TD\n";
  const keys = Object.keys(rows[0]!);
  const lines = ["graph TD"];
  for (const row of rows) {
    const src = cellToString(row[keys[0]!]);
    const dst = cellToString(row[keys[1]!]);
    const label = keys.length >= 3 ? cellToString(row[keys[2]!]) : "";
    const arrow = label ? `-- ${label.replace(EDGE_LABEL_BREAKERS, " ")} -->` : "-->";
    lines.push(`    ${mermaidEscape(src)} ${arrow} ${mermaidEscape(dst)}`);
  }
  return lines.join("\n");
}

// Render a row cell as a string suitable for a Mermaid label. JSON
// compounds (objects / arrays) come back from the executor as parsed
// JS values, so a bare `String(v)` would produce the literal
// `"[object Object]"` — every json node would collapse to the same
// id, rendering a meaningless graph. Stringify compounds as JSON
// instead so the label carries the actual value.
//
// `bigintSafeReplacer` survives BigInt cells (Postgres BIGINT columns
// arrive as JS BigInt via `Bun.sql`) — bare `JSON.stringify` throws
// on those.
//
// A `null` renders as the text `null` for the same reason, one step further in:
// it is an ordinary value with a name, and mapping it to `""` collapsed it onto
// the empty string. Both then sanitised to the fallback id `n`, so a row ending
// in a `null` and one ending in `""` drew *one* node and the graph asserted an
// edge that does not exist. No absence can reach a cell (no column holds one), so
// `undefined` here is defensive only.
function cellToString(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, bigintSafeReplacer);
  return String(value);
}
