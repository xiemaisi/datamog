import type { BitwiseOp, PrimitiveType, Rule, TypedProgram } from "datamog-core";

/**
 * Interface for dialect-specific SQL generation.
 * Each SQL backend (Postgres, SQLite, etc.) implements this interface
 * to control how DDL and dialect-specific expressions are produced.
 */
export interface SqlDialect {
  readonly name: string;

  /** Whether this dialect supports non-linear recursion (multiple recursive body atoms). */
  readonly supportsNonLinearRecursion: boolean;

  /** Wrap a UNION body into a CREATE VIEW for a non-recursive predicate. */
  createView(name: string, body: string): string;

  /** Wrap a UNION body into a CREATE VIEW for a self-recursive predicate. */
  createRecursiveView(name: string, columns: string, body: string): string;

  /**
   * Combine the recursive rules of one predicate into a single recursive term.
   *
   * Implement this when the dialect cannot take a flat
   * `anchor UNION rec1 UNION rec2` body. Postgres cannot: it allows exactly one
   * recursive term, containing exactly one reference to the CTE, so a predicate
   * with two recursive rules has to be folded into one branch. SQLite and
   * sql.js accept the flat form and leave this undefined.
   *
   * Only called when there is more than one recursive rule. Each entry of
   * `recursive` has already been translated with its own self-referencing atom
   * bound to `selfAlias` instead of to a `FROM` entry of its own, so the
   * implementation supplies the single reference and joins the branches to it.
   * See `doc/design/postgres-alignment.md`.
   */
  singleRecursiveTerm?(predicate: string, selfAlias: string, recursive: string[]): string;

  /**
   * Generate CREATE VIEW statements for a mutually recursive SCC (stratum).
   *
   * @param stratum - predicate names in the SCC
   * @param arities - arity of each predicate
   * @param rules - rules for each predicate
   * @param analyzed - the full analyzed program (for column resolution)
   * @param translateRule - callback to translate a single rule to a SQL SELECT;
   *   the dialect may pass renameMap/tagMap to control table references
   * @returns one CREATE VIEW string per predicate
   */
  createMutuallyRecursiveViews(
    stratum: string[],
    arities: ReadonlyMap<string, number>,
    rules: ReadonlyMap<string, Rule[]>,
    analyzed: TypedProgram,
    translateRule: (
      rule: Rule,
      renameMap?: Map<string, string>,
      tagMap?: Map<string, string>,
    ) => string,
  ): string[];

  /** Generate a FROM clause element for a binding range (integer series). */
  rangeSource(alias: string, lowSql: string, highSql: string): string;

  /** Return additional WHERE conditions for a binding range (empty if not needed). */
  rangeConditions(alias: string, lowSql: string, highSql: string): string[];

  /** Generate SQL for the concat aggregate function. */
  concat(argSql: string): string;

  /**
   * Generate SQL for the `list` aggregate: collect values into a json
   * array. `valueSql` is the JSON-form value to insert (already lifted
   * via `toJson` for primitive args; equal to `argSql` for value args).
   * `argSql` is the original argument expression — used for the NULL
   * filter and for ordering, so primitive columns sort by their
   * natural value (numeric for numbers, lex for strings) instead of
   * by the lifted text. `argIsJson` lets the dialect decide whether
   * to cast the order key to text: Postgres jsonb's natural ordering
   * is type-tag-then-value, which would put all strings before all
   * arrays etc.; casting to text puts structurally equal values
   * adjacently (matching native `canonicalizeJson` and SQLite's
   * canonical-TEXT storage).
   *
   * NULL inputs are skipped; an empty / all-NULL group produces NULL
   * (matching `concat` and the rest of the aggregate family).
   */
  jsonAgg(valueSql: string, argSql: string, argIsJson: boolean): string;

  /**
   * Emit a null-aware equality (`=` operator and body-level Equality
   * constraint). `null = null` must be true, `null = X` must be false.
   * Postgres uses `IS NOT DISTINCT FROM`; SQLite/sql.js use `IS`
   * (which has been null-aware since SQLite 3.0; both shipped engines
   * are far newer). Inverted form is `<>` / `IS NOT` / `IS DISTINCT
   * FROM`.
   */
  logicalEq(leftSql: string, rightSql: string): string;
  logicalNeq(leftSql: string, rightSql: string): string;

  /**
   * Force portable string ordering for comparisons and aggregate ORDER BY.
   * Native compares strings by Unicode code point. On UTF-8 SQL backends,
   * binary collation gives the same order and avoids locale-dependent
   * defaults (especially on Postgres).
   */
  stringOrder(sql: string): string;

  /**
   * Render `round(x, n)`. SQLite ignores negative `n` in its built-in
   * ROUND, and Postgres does not provide `round(double precision, int)`,
   * so dialects own the portable arity-2 emission.
   */
  roundToScale(valueSql: string, scaleSql: string, resultType: "integer" | "float"): string;

  /**
   * Render `integer / integer` division with truncation toward zero.
   *
   * Currently no shipped dialect overrides this — Postgres and SQLite
   * both truncate integer `/` natively. Kept on the interface for
   * future backends whose `/` is floating-point-valued: such a dialect supplies
   * a `divideIntegers` hook (e.g. emitting `//`) and the translator
   * routes through it when both operands are integer-typed.
   */
  divideIntegers?(leftSql: string, rightSql: string): string;

  /**
   * Emit a bitwise / shift operation on 32-bit signed two's-complement
   * integers (Java/JS `int` semantics): `>>` is arithmetic (sign-
   * extending), `>>>` is logical (zero-fill), the shift count is taken
   * mod 32, and the result wraps to int32. Backends diverge enough that
   * each owns the emission: SQLite has no `^` or `>>>` and computes in
   * 64-bit (results need wrapping); Postgres spells XOR `#`, lacks `>>>`,
   * and its INTEGER is already 32-bit. NULL operands propagate to NULL
   * natively on every backend. See spec §5.9.
   */
  bitwise(op: BitwiseOp, leftSql: string, rightSql: string): string;

  /**
   * Map a Datamog `PrimitiveType` to the dialect's SQL type name. Used in
   * `CREATE TABLE` columns and `CAST(NULL AS …)` projections. Defaults
   * to `SQL_TYPE_MAP` (the names valid on every shipped backend);
   * Postgres overrides `json` to `JSONB` for native structural
   * equality.
   */
  sqlType?(type: PrimitiveType): string;

  /**
   * Wrap the bind placeholder used to insert a `value`-typed column so the
   * canonical JSON text lands as a structured value rather than a JSON
   * string scalar. The loader always binds the canonical text (so
   * SQLite/sql.js `TEXT` columns get exactly the canonical form); Postgres
   * overrides this to cast the placeholder into `JSONB` so the text is
   * parsed instead of stored as a quoted string. Defaults to the
   * placeholder unchanged.
   */
  valueInsertPlaceholder?(placeholder: string): string;

  /**
   * Index into a JSON value. `indexIsString` selects between object-key
   * lookup (when the index expression has string type) and array-element
   * lookup (integer type). The result is a JSON value (or NULL on missing
   * key / out-of-range index / wrong-shape receiver).
   *
   * Used only when the receiver expression has type `json` — the
   * translator dispatches on the receiver's inferred type at the
   * Subscript / Slice case.
   */
  jsonSubscript(receiverSql: string, indexSql: string, indexIsString: boolean): string;

  /**
   * Slice a JSON array. Bounds are integer expressions (or `null` for
   * an open end). Result is a JSON array; an empty range (start >= end)
   * returns the empty array, mirroring Python-style slice semantics.
   * Slicing a non-array receiver returns SQL NULL.
   */
  jsonSlice(receiverSql: string, startSql: string | null, endSql: string | null): string;

  /**
   * Generate a FROM-clause source that iterates a JSON value as
   * (key, value) pairs (object-kind) or (index, value) pairs
   * (array-kind). Returns both the FROM fragment and the column
   * expressions to reference the key (or index) and value at the
   * given alias. Iteration over a value of the wrong shape (e.g.
   * `object_entry` on an array, or anything on a primitive leaf)
   * yields zero rows — matching the native evaluator's behaviour.
   *
   * The split return shape lets each dialect pick the natural column
   * names (`key`/`value` on SQLite/sql.js's `json_each`, or aliased
   * names on Postgres's `jsonb_each`) without forcing the translator
   * into a wrapping SELECT — which would require LATERAL syntax that
   * SQLite/sql.js don't support.
   */
  jsonIterate(
    kind: "object" | "array",
    sourceSql: string,
    alias: string,
  ): { fromSql: string; keySql: string; valueSql: string };

  /**
   * Return the canonical type name of a JSON value as a SQL TEXT
   * expression, picking from the spec set: `'object'`, `'array'`,
   * `'string'`, `'number'`, `'boolean'`, `'null'`. Used both for the
   * `type_of` builtin and as the guard inside the `as_*` coercions.
   * Each backend's native typeof function (`json_type` / `jsonb_typeof`)
   * uses different strings and finer distinctions (e.g. SQLite splits
   * numbers into `'integer'`/`'real'` and booleans into `'true'`/
   * `'false'`); the hook collapses those to the spec set.
   */
  jsonTypeOf(jsonSql: string): string;

  /**
   * `as_string` — return the underlying string of a json string-leaf, or
   * SQL NULL on any other JSON shape. The input is canonical JSON text
   * on TEXT-storing backends; the implementation must handle the
   * dialect's quote-stripping behaviour.
   */
  jsonAsString(jsonSql: string): string;

  /**
   * `as_integer` — return the integer value of a json number that is
   * integer-valued and fits in a 64-bit signed integer; otherwise
   * SQL NULL. Detection strategy varies by dialect (lexical
   * `json_type` check on SQLite/sql.js after canonicalisation;
   * numeric `% 1 = 0` check on Postgres, since `jsonb` canonicalises
   * numbers numerically).
   */
  jsonAsInteger(jsonSql: string): string;

  /**
   * `as_float` — return the value of a json number as a SQL float
   * (REAL / DOUBLE PRECISION); SQL NULL on any other JSON shape
   * (including JSON null, boolean, string, object, array).
   */
  jsonAsFloat(jsonSql: string): string;

  /**
   * `as_boolean` — return the value of a json boolean as a SQL boolean
   * (or 0/1 on SQLite, which the executor's `coerceBooleanColumns`
   * normalises). SQL NULL on any other JSON shape.
   */
  jsonAsBoolean(jsonSql: string): string;

  /**
   * `length` — overloaded across array length, object key count, and
   * string length. Anything else (numbers, booleans, json null) maps
   * to SQL NULL. The dispatch happens at runtime via the dialect's
   * type-check function; each branch uses the dialect's natural length
   * primitive.
   */
  jsonLength(jsonSql: string): string;

  /**
   * `has_key(V, K)` — true when V is an object with own key K, false
   * for non-object values and absent keys. SQL NULL arguments should
   * propagate to SQL NULL, matching the rest of the built-in function
   * family.
   */
  jsonHasKey(jsonSql: string, keySql: string): string;

  /**
   * `keys(V)` — return a sorted array of the object's keys (each as a
   * JSON string), or SQL NULL when `V` is not an object. Empty object
   * → empty array `[]`. Backends rely on their natural key-iteration
   * primitive (`jsonb_object_keys` on Postgres, `json_each` on
   * SQLite/sql.js); the explicit `ORDER BY` makes the per-row output
   * deterministic across backends in Datamog's portable string order.
   */
  jsonKeys(jsonSql: string): string;

  /**
   * `values(V)` — return an array of the object's values, ordered by
   * key for cross-backend determinism, or SQL NULL when `V` is not
   * an object. Empty object → empty array `[]`. Mirrors `jsonKeys`
   * via the same key-iteration primitive.
   */
  jsonValues(jsonSql: string): string;

  /**
   * `to_json(V)` — serialise a `value` to its canonical JSON text:
   * object keys sorted in Postgres jsonb-canonical order, numbers
   * normalised, no whitespace inserted.
   * The output is identical across every backend (so it's safe as a
   * hash / dedup key) and matches the native `canonicalizeJson`
   * function. Inverse of `parse_json`.
   *
   * Postgres `jsonb::text` adds whitespace after `:` and `,` outside
   * strings; the implementation strips those in a quote-aware way.
   * SQLite / sql.js store the canonical TEXT directly so the
   * implementation is a no-op cast.
   */
  jsonStringify(jsonSql: string): string;

  /**
   * `to_integer(string)` — parse a string expression as a canonical
   * decimal integer (optional leading `-`, ASCII digits, no leading
   * zeros, no whitespace, base 10). Returns SQL NULL on any malformed
   * input or on values outside the dialect's integer range. Each
   * dialect picks its own validation strategy: Postgres uses a regex
   * pre-check (its `CAST` raises on failure), SQLite uses a
   * roundtrip-via-TEXT comparison (its `CAST` is silent and lossy).
   */
  parseStringAsInteger(textSql: string): string;

  /**
   * `to_float(string)` — parse a string expression as a canonical
   * decimal floating-point value (optional leading `-`, ASCII digits,
   * optional `.<digits>` fraction). Returns SQL NULL on malformed
   * input. Exponent forms (`1e10`) are intentionally not accepted
   * here so cross-backend formatting agreement is straightforward;
   * users who need them can compose with arithmetic.
   */
  parseStringAsFloat(textSql: string): string;

  /**
   * `to_json(x)` — lift a primitive value into a `value`. The
   * `valueType` discriminates the four overloads (`integer`, `float`,
   * `boolean`, `string`) so each dialect can pick the right form
   * without re-checking the source expression. Postgres collapses to
   * a single `to_jsonb` call; SQLite needs distinct emission per type
   * (numbers via `CAST AS TEXT`, booleans via a `'true'`/`'false'`
   * CASE, strings via `json_quote`).
   */
  toJson(valueSql: string, valueType: PrimitiveType): string;

  /**
   * Build a JSON array from a list of element expressions. Each element
   * is given as the `(sql, type)` pair from the translator: `type` is the
   * inferred Datamog type (or `undefined` for the polymorphic `null`
   * literal), `sql` is the rendered SQL expression. Primitive elements
   * are auto-lifted to JSON inside the dialect implementation; already-
   * `json` elements pass through. SQL `NULL` becomes JSON `null`.
   */
  jsonArray(elements: ReadonlyArray<{ sql: string; type: PrimitiveType | undefined }>): string;

  /**
   * Build a JSON object from a list of (string-key, value) entries. `key`
   * is the unquoted text of the source-level string literal; `value` and
   * `valueType` describe the value expression as in `jsonArray`.
   */
  jsonObject(
    entries: ReadonlyArray<{
      key: string;
      valueSql: string;
      valueType: PrimitiveType | undefined;
    }>,
  ): string;

  /**
   * `parse_json(s)` — parse a string expression as JSON. Returns SQL
   * NULL on malformed input rather than raising, to match the rest
   * of the string-to-X parsing family (`to_integer` / `to_float` /
   * `to_boolean`). Each dialect's parser+validator differs: Postgres
   * gates the `::jsonb` cast on `pg_input_is_valid` (PG16+); SQLite
   * gates the `json()` call on `json_valid` and rejects numeric leaves
   * that overflow to IEEE non-finite values.
   *
   * Cross-backend canonicalisation note: parse_json results should use
   * the same canonical key order as EDB-loaded values and object
   * literals, so textually-different but structurally-equal JSON
   * objects unify in joins/dedup.
   */
  parseJson(textSql: string): string;
}

/** Map a Datamog PrimitiveType to the dialect's SQL type name, falling back to the default. */
export function sqlTypeFor(dialect: SqlDialect, type: PrimitiveType): string {
  return dialect.sqlType ? dialect.sqlType(type) : SQL_TYPE_MAP[type];
}

/** Quote an identifier. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Generate a comma-separated list of positional column names: col1, col2, ... */
export function colList(arity: number): string {
  // A nullary predicate is represented as a single constant marker column
  // (see the translator's nullary handling), so it declares one column.
  if (arity === 0) return "col1";
  return Array.from({ length: arity }, (_, i) => `col${i + 1}`).join(", ");
}

/**
 * Map a Datamog `PrimitiveType` to its dialect-agnostic SQL type name. The
 * names here happen to be valid in every backend we ship (Postgres,
 * SQLite, sql.js) so a single table works for `CREATE TABLE` columns
 * as well as `CAST(NULL AS …)` projections in synthesised empty
 * anchors. Per-dialect overrides (`SqlDialect.sqlType`) handle the
 * exceptions — Postgres maps `json` to `JSONB`.
 */
export const SQL_TYPE_MAP: Record<PrimitiveType, string> = {
  string: "TEXT",
  integer: "INTEGER",
  float: "REAL",
  boolean: "BOOLEAN",
  // `value` (the union of primitive + array + object) is stored as
  // canonical TEXT JSON on SQLite/sql.js; Postgres overrides this to
  // JSONB for native structural equality.
  value: "TEXT",
};

/**
 * Synthesise a zero-row anchor SELECT for a recursive view whose rules
 * are all self- or cross-referential. `WITH RECURSIVE` rejects a CTE
 * with no anchor branch (SQLite raises "circular reference"; Postgres
 * raises a similar error), so we prepend a typed empty SELECT that
 * evaluates to zero rows but pins the column types.
 *
 * Shared by the translator's self-recursive path and the Postgres
 * dialect's mutually-recursive path.
 */
export function emptyAnchor(
  arity: number,
  colTypes: readonly PrimitiveType[],
  dialect: SqlDialect,
): string {
  // A nullary predicate's anchor pins its single constant marker column.
  if (arity === 0) return "SELECT 1 AS col1 WHERE 1 = 0";
  const nulls: string[] = [];
  for (let i = 0; i < arity; i++) {
    nulls.push(`CAST(NULL AS ${sqlTypeFor(dialect, colTypes[i]!)}) AS col${i + 1}`);
  }
  return `SELECT ${nulls.join(", ")} WHERE 1 = 0`;
}
