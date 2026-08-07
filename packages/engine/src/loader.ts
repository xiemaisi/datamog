import type { ColumnDecl, ExtDecl, PrimitiveType, TypedProgram } from "datamog-core";
import type { Backend } from "./backend.ts";
import { ident } from "./dialect.ts";
import { type JsonValue, canonicalizeJson, isJsonValue } from "./json-canonical.ts";

export interface LoadResult {
  rowsLoaded: number;
}

export interface ExtensionalLoader {
  readonly name: string;
  canLoad(decl: ExtDecl): Promise<boolean>;
  load(decl: ExtDecl, backend: Backend): Promise<LoadResult>;
}

/**
 * For each extensional declaration, ask each loader in order whether it
 * can supply data and dispatch to the first match. A declaration with no
 * matching loader stays empty — declared-but-unloaded EDBs are valid
 * (rules over them simply produce no rows), and direct `insertRows` calls
 * let callers populate predicates without going through a loader.
 */
export async function loadExtensionalData(
  analyzed: TypedProgram,
  loaders: ExtensionalLoader[],
  backend: Backend,
): Promise<void> {
  for (const decl of analyzed.extDecls.values()) {
    for (const loader of loaders) {
      if (await loader.canLoad(decl)) {
        await loader.load(decl, backend);
        break;
      }
    }
  }
}

/**
 * Insert each row from `rows` into the extensional table described by
 * `decl`. The SQL statement is built once and reused across rows; values
 * are taken from each row by column name in declaration order.
 *
 * Backends that don't speak SQL (e.g. the native evaluator) can implement
 * `Backend.insertRows` to bypass the SQL path entirely; when present it's
 * used here instead of emitting `INSERT` statements.
 */
export async function insertRows(
  backend: Backend,
  decl: ExtDecl,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  // Canonicalise every value-typed column on insert so cross-backend
  // textual equality coincides with structural equality (SQLite/sql.js
  // store JSON as TEXT and compare textually). Postgres `jsonb`
  // canonicalises natively, so passing the canonical text in is
  // harmless. Native backend stores parsed JS values, so we
  // round-trip through `JSON.parse(canonical)` to get a canonical-
  // key-ordered structure — without this, native object key order
  // mirrors the input file rather than the canonical form, and result
  // sets serialise differently (e.g. `JSON.stringify`-keyed dedup or
  // sort) from the SQL backends.
  const jsonCols = decl.columns.filter((c) => c.type === "value");
  const isSqlPath = !backend.insertRows;
  const normalised = rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const col of decl.columns) {
      const v = row[col.name];
      if (v === null || v === undefined) {
        if (!col.nullable) {
          throw new Error(`Expected non-null value for column '${col.name}'`);
        }
        out[col.name] = null;
        continue;
      }
      if (col.type === "integer") out[col.name] = checkValue(v, "integer", `column '${col.name}'`);
    }
    if (jsonCols.length > 0) {
      for (const col of jsonCols) {
        const v = out[col.name];
        if (v === null) continue;
        const value = validateDirectJsonValue(v, col);
        const canonical = canonicalizeJson(value);
        out[col.name] = isSqlPath ? canonical : (JSON.parse(canonical) as JsonValue);
      }
    }
    return out;
  });
  if (backend.insertRows) {
    await backend.insertRows(decl, normalised);
    return;
  }
  // Datalog has set semantics — duplicate EDB rows would otherwise inflate
  // aggregate results (`sum`, `count`, …) on SQL backends, while the native
  // evaluator stores rows in a Set and so produces lower numbers. Dedup
  // here so every backend agrees, regardless of whether the source data
  // (CSV, JSONL, Google Sheets) carries duplicates.
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const row of normalised) {
    const key = JSON.stringify(decl.columns.map((c) => row[c.name]));
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  const columns = decl.columns.map((c) => ident(c.name)).join(", ");
  // `value` columns bind the canonical JSON text; some dialects (Postgres)
  // must cast that text into their native JSON type at the placeholder, or
  // the driver stores it as a JSON string scalar rather than a structured
  // value (so `array_element` / `object_entry` would see a string and yield
  // nothing). Primitive columns bind the placeholder unchanged.
  const wrapValue = backend.sqlDialect?.valueInsertPlaceholder;
  const placeholders = decl.columns
    .map((c, i) => {
      const ph = `$${i + 1}`;
      return c.type === "value" && wrapValue ? wrapValue.call(backend.sqlDialect, ph) : ph;
    })
    .join(", ");
  const sql = `INSERT INTO ${ident(decl.predicate)} (${columns}) VALUES (${placeholders})`;
  for (const row of deduped) {
    const values = decl.columns.map((c) => row[c.name]);
    await backend.execute(sql, values);
  }
}

function validateDirectJsonValue(value: unknown, column: ColumnDecl): JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`Expected a value for column '${column.name}': contains non-finite number`);
  }
  return value;
}

/**
 * Coerce a string value to the given SQL type, throwing on invalid values.
 * Use for string-based formats like CSV and Google Sheets.
 */
export function coerceValue(value: string, type: PrimitiveType, context?: string): unknown {
  const ctx = context ? ` (${context})` : "";
  switch (type) {
    case "string":
      return value;
    case "integer": {
      // Canonical integer syntax, matching `to_integer`: `0` or a non-zero
      // leading digit with an optional `-`, inside the JS safe-integer range.
      const trimmed = value.trim();
      if (!/^(0|-?[1-9]\d*)$/.test(trimmed)) {
        throw new Error(`Invalid integer value '${value}'${ctx}`);
      }
      const n = Number(trimmed);
      if (!Number.isSafeInteger(n)) {
        throw new Error(`Invalid integer value '${value}'${ctx}`);
      }
      return n;
    }
    case "float": {
      // Canonical float syntax, matching `to_float`: no leading zeros
      // except plain `0`, no exponent form, and no surface `-0`.
      const trimmed = value.trim();
      if (!/^((0|-?[1-9]\d*)(\.\d+)?|-0\.\d+)$/.test(trimmed)) {
        throw new Error(`Invalid float value '${value}'${ctx}`);
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid float value '${value}'${ctx}`);
      }
      return n;
    }
    case "boolean": {
      // Trim like the integer/float cases — otherwise `" true "` from a CSV
      // with padded fields would be rejected, while the numeric types (and
      // `coerceValue` overall) is lenient about surrounding whitespace.
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes") return true;
      if (v === "false" || v === "0" || v === "no") return false;
      throw new Error(`Invalid boolean value '${value}'${ctx}`);
    }
    case "value": {
      // Allow string-typed JSON cells to pass through after a parse — useful
      // for CSV-shaped sources that carry JSON in a single column. Reject
      // unparseable input with a clear error rather than letting
      // canonicalisation crash later.
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch (e) {
        throw new Error(`Invalid JSON value '${value}'${ctx}: ${(e as Error).message}`);
      }
      // `JSON.parse` silently rounds out-of-range numerics to
      // `Infinity` / `-Infinity`. Re-serialising via `JSON.stringify`
      // (the SQL backends do this on insert) collapses `Infinity` to
      // `null`, so the SQL side ends up with different data than the
      // native side, which retains the `Infinity`. The sibling
      // `checkValue` path used by JSONL already rejects these via
      // `isJsonValue`; mirror that gate here.
      if (!isJsonValue(parsed)) {
        throw new Error(`Invalid JSON value '${value}'${ctx}: contains non-finite number`);
      }
      return parsed;
    }
  }
}

/**
 * Coerce a string cell for a declared extensional column. Nullable
 * columns treat an empty / whitespace-only cell as runtime NULL; all
 * other cells use the normal type-specific coercion.
 */
export function coerceColumnValue(value: string, column: ColumnDecl, context?: string): unknown {
  if (column.nullable && value.trim() === "") return null;
  // An unannotated column defaults to `string` (parseRaw already sets this).
  return coerceValue(value, column.type ?? "string", context);
}

/**
 * Validate that a native JS value matches the expected SQL type.
 * Use for already-typed formats like JSONL.
 */
export function checkValue(value: unknown, type: PrimitiveType, context?: string): unknown {
  const ctx = context ? ` (${context})` : "";
  switch (type) {
    case "string":
      if (typeof value === "string") return value;
      throw new Error(`Expected string but got ${typeof value}${ctx}`);
    case "integer":
      // `Number.isSafeInteger` rather than `Number.isInteger`: by
      // the time we see a parsed JSONL value, `JSON.parse` has
      // already rounded any number outside ±(2^53 - 1) to a nearby
      // representable integer, so `Number.isInteger` would happily
      // accept the rounded value and the precision loss never
      // surfaces.
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
      throw new Error(`Expected integer but got ${JSON.stringify(value)}${ctx}`);
    case "float":
      // `Number.isFinite` rather than just `typeof === "number"`:
      // `JSON.parse` silently rounds out-of-range exponents like
      // `1e500` to `Infinity`, and a hand-built JS value can carry
      // `NaN`; both poison downstream arithmetic. Match the
      // `as_float.value` builtin's gate (values.ts:387).
      if (typeof value === "number" && Number.isFinite(value)) return value;
      throw new Error(
        `Expected float but got ${typeof value === "number" ? value : typeof value}${ctx}`,
      );
    case "boolean":
      if (typeof value === "boolean") return value;
      throw new Error(`Expected boolean but got ${typeof value}${ctx}`);
    case "value":
      if (isJsonValue(value)) return value;
      throw new Error(`Expected a value but got ${typeof value}${ctx}`);
  }
}

/** Validate an already-typed value for a declared extensional column. */
export function checkColumnValue(value: unknown, column: ColumnDecl, context?: string): unknown {
  if (value === null && column.nullable) return null;
  return checkValue(value, column.type ?? "string", context);
}
