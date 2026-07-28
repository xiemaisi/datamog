import type { PrimitiveType, Query } from "datamog-core";
import { coerceBooleanColumns, coerceJsonColumns } from "./result-coerce.ts";

/** How many counterexample rows a violation message spells out before eliding. */
const MAX_REPORTED_ROWS = 5;

/** One violated integrity constraint, with the rows that violate it. */
export interface ConstraintViolation {
  /** Predicate name for an `error predicate`; undefined for an anonymous `!-`. */
  predicate?: string;
  /** Source text of the constraint, used to identify an anonymous `!-`. */
  source?: string;
  /** Counterexamples: the constraint's non-empty extension. */
  rows: Record<string, unknown>[];
  /** Source offsets of the constraint, for editors that underline the failure. */
  offset?: number;
  end?: number;
}

/**
 * A program's integrity constraints were not all empty. Thrown after the
 * constraints are evaluated and before any query is, so no result is produced
 * from data the program itself declares invalid.
 */
export class ConstraintViolationError extends Error {
  constructor(
    readonly violations: ConstraintViolation[],
    /** Source file the program was parsed from, when known. */
    readonly file?: string,
  ) {
    super(formatConstraintViolations(violations));
    this.name = "ConstraintViolationError";
  }
}

/** Identify a constraint in a message: its predicate name, else its source text. */
function describe(violation: ConstraintViolation): string {
  const { predicate } = violation;
  if (predicate === undefined) {
    return violation.source ? `\`${violation.source}\`` : "constraint";
  }
  // Elaboration freshens an imported module's predicates with a per-instance
  // `<importer>$<n>$` prefix, so a constraint inside a module reaches us under a
  // name the user never wrote. Report its own name and the import chain that
  // brought it in. Users cannot write `$`, so a `$` here is always a prefix.
  const parts = predicate.split("$");
  if (parts.length === 1) return `'${predicate}'`;
  const importChain = parts
    .filter((_, i) => i % 2 === 0)
    .slice(0, -1)
    .join(" -> ");
  return `'${parts[parts.length - 1]}' (from the module bound to '${importChain}')`;
}

/** Render one counterexample as `col = value, col = value`, or `()` if ground. */
function formatRow(row: Record<string, unknown>): string {
  const entries = Object.entries(row);
  if (entries.length === 0) return "()";
  return entries.map(([k, v]) => `${k} = ${JSON.stringify(v) ?? "null"}`).join(", ");
}

/**
 * One-line-per-violation, user-facing explanation. Shared so the CLI, REPL,
 * embed, and playground phrase a violation identically (mirroring
 * `formatIterationCap` in the native backend).
 */
export function formatConstraintViolations(violations: readonly ConstraintViolation[]): string {
  const lines: string[] = [];
  for (const v of violations) {
    const n = v.rows.length;
    lines.push(
      `Constraint ${describe(v)} is violated by ${n} ${n === 1 ? "row" : "rows"}:`,
      ...v.rows.slice(0, MAX_REPORTED_ROWS).map((r) => `  ${formatRow(r)}`),
    );
    if (n > MAX_REPORTED_ROWS) lines.push(`  ... and ${n - MAX_REPORTED_ROWS} more`);
  }
  return lines.join("\n");
}

/**
 * Post-process a constraint's raw result rows the same way the executor
 * post-processes a query's: uniformise backend-specific value shapes, then
 * project away helper columns (for a ground constraint this leaves `{}` per
 * matching row, the same "yes" signal a ground query produces).
 */
export function projectConstraintRows(
  rawRows: Record<string, unknown>[],
  columnTypes: Record<string, PrimitiveType>,
): Record<string, unknown>[] {
  const coerced = coerceJsonColumns(coerceBooleanColumns(rawRows, columnTypes), columnTypes);
  const keys = Object.keys(columnTypes);
  return coerced.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = row[key];
    return out;
  });
}

/** Build a violation for a constraint whose extension came back non-empty. */
export function toViolation(query: Query, rows: Record<string, unknown>[]): ConstraintViolation {
  return {
    predicate: query.outputName,
    source: query.$cstNode?.text,
    rows,
    offset: query.$cstNode?.offset,
    end: query.$cstNode?.end,
  };
}
