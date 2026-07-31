import type { PrimitiveType } from "datamog-core";

/**
 * SQLite (and sql.js) have no native BOOLEAN type — `TRUE`/`FALSE`
 * keywords and comparison results round-trip as JS `0`/`1`. Postgres
 * and the native evaluators round-trip as JS `true`/`false`. To give
 * every backend a uniform result shape, walk each result row
 * and coerce 0/1 → false/true at columns whose declared type is
 * boolean. The check on the value (`=== 0 || === 1`) is naturally a
 * no-op for backends that already return native booleans, since
 * `true === 1` is `false` in JS.
 */
export function coerceBooleanColumns(
  rows: Record<string, unknown>[],
  columnTypes: Record<string, PrimitiveType>,
): Record<string, unknown>[] {
  const booleanCols = Object.entries(columnTypes)
    .filter(([, t]) => t === "boolean")
    .map(([k]) => k);
  if (booleanCols.length === 0) return rows;
  return rows.map((row) => {
    let copy: Record<string, unknown> | null = null;
    for (const col of booleanCols) {
      const v = row[col];
      if (v === 0 || v === 1) {
        if (!copy) copy = { ...row };
        copy[col] = v === 1;
      }
    }
    return copy ?? row;
  });
}

/**
 * `Bun.sql` hands back Postgres `BIGINT` and `NUMERIC` as JS strings, so that a
 * value too large for a double is not silently rounded. `count(*)`, `sum`,
 * `avg`, and the `to_integer` / `to_float` conversions all produce one of those
 * types, which made a Postgres `count` of 4 arrive as `"4"` where SQLite,
 * sql.js, and the interpreters all give `4`. Convert at columns whose declared
 * type is numeric, so every backend exposes the same shape.
 *
 * A magnitude above `Number.MAX_SAFE_INTEGER` does lose precision in the
 * conversion. That is inherent in having one result shape: the interpreters
 * compute in JS numbers and SQLite returns them, so no backend was ever exact
 * up there, and a `"9007199254740993"` string from Postgres alone would be a
 * difference in type rather than a gain in accuracy.
 */
export function coerceNumericColumns(
  rows: Record<string, unknown>[],
  columnTypes: Record<string, PrimitiveType>,
): Record<string, unknown>[] {
  const numericCols = Object.entries(columnTypes)
    .filter(([, t]) => t === "integer" || t === "float")
    .map(([k]) => k);
  if (numericCols.length === 0) return rows;
  return rows.map((row) => {
    let copy: Record<string, unknown> | null = null;
    for (const col of numericCols) {
      const v = row[col];
      // Only strings need converting; every other backend already returns a
      // number here. An unparseable string is left alone rather than turned
      // into NaN, so a surprise from some future backend stays visible.
      if (typeof v !== "string") continue;
      const n = Number(v);
      if (v.trim() === "" || !Number.isFinite(n)) continue;
      if (!copy) copy = { ...row };
      copy[col] = n;
    }
    return copy ?? row;
  });
}

/**
 * Cross-backend uniformisation for value-typed result columns. SQLite
 * stores JSON as TEXT (canonical-string round-trip); Postgres jsonb
 * arrives as a parsed JS structure; native already holds parsed JS.
 * Parse string-shaped values back to JS objects / arrays / primitives
 * so every backend exposes the same shape to consumers (`row.col ===
 * { ... }`, not a stringified blob).
 *
 * SQLite's `json_extract` of a string-leaf returns an unquoted TEXT
 * value (`'hello'`, not `'"hello"'`), which fails JSON.parse — that's
 * fine: keep the string as-is, since the user's intended value is
 * already a primitive.
 */
export function coerceJsonColumns(
  rows: Record<string, unknown>[],
  columnTypes: Record<string, PrimitiveType>,
): Record<string, unknown>[] {
  const jsonCols = Object.entries(columnTypes)
    .filter(([, t]) => t === "value")
    .map(([k]) => k);
  if (jsonCols.length === 0) return rows;
  return rows.map((row) => {
    let copy: Record<string, unknown> | null = null;
    for (const col of jsonCols) {
      const v = row[col];
      if (typeof v !== "string") continue;
      try {
        const parsed = JSON.parse(v);
        if (!copy) copy = { ...row };
        copy[col] = parsed;
      } catch {
        // SQLite json_extract returned a raw string-leaf (e.g. `hello`
        // without quotes). Keep the string value as-is — JSON.parse
        // can't round-trip it but the user-visible result is still a
        // string primitive, which is the same thing the native backend
        // would produce for that subscript.
      }
    }
    return copy ?? row;
  });
}
