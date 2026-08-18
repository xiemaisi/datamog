import { bigintSafeReplacer, formatProofTerm } from "datamog-engine";

/**
 * Render a result-row cell as a string suitable for the playground's
 * tables and step-debugger relation views. `value`-typed columns
 * arrive as parsed JS values (objects / arrays), so a bare
 * `String(v)` would collapse every distinct `value` to the literal
 * string
 * `"[object Object]"`. Stringify compounds as JSON instead so the
 * displayed cell carries the actual value.
 *
 * `bigintSafeReplacer` survives BigInt cells — Postgres BIGINT columns
 * arrive as JS `BigInt` via `Bun.sql`, and bare `JSON.stringify`
 * throws `cannot serialize BigInt` outright.
 *
 * Mirrors `formatCellAsString` in `packages/cli/src/output.ts` and
 * `cellToString` in `packages/engine/src/mermaid-output.ts` — every
 * surface that renders rows for a human goes through this shape now.
 *
 * A `null` renders as the text `null`, not as a blank. It is an ordinary value
 * with a name, and this is the surface where telling it from `""` matters most: the
 * CLI's table shows `null` (via `console.table`), so a blank here made the
 * playground and the walkthrough disagree about the same program. CSV output is the
 * one place that keeps the blank, because the loader reads an empty cell back as a
 * null and the pair has to round-trip.
 *
 * Proof-term cells (the `{"$proof", "args"}` objects a named rule
 * produces) render in constructor form `Ctor(...)`, matching the CLI's
 * table output.
 */
export function formatCell(value: unknown): string {
  if (value === null) return "null";
  // No absence can reach a cell, no column holding one. Defensive only.
  if (value === undefined) return "";
  const proof = formatProofTerm(value);
  if (proof !== undefined) return proof;
  if (typeof value === "object") return JSON.stringify(value, bigintSafeReplacer);
  return String(value);
}
