import type { BitwiseOp, PrimitiveType, Rule, TypedProgram } from "datamog-core";
import {
  type MutualRuleTranslator,
  type SqlDialect,
  colList,
  compareJsonbObjectKeys,
  ident,
  mutualCteParts,
} from "datamog-engine";

/**
 * True if `sql` is an integer literal. Accepts bare `42` / `-42` and the
 * parenthesised form `(-42)` that the translator emits for UnaryExpr
 * wrapping a NumberLiteral — without this, negative-literal range bounds
 * would fall back to the 0 anchor and silently truncate the range.
 */
function isIntLiteral(sql: string): boolean {
  return /^\s*(?:-?\d+|\(-\d+\))\s*$/.test(sql);
}

/** Strip the wrapping parens from `(-N)` for inlining as an anchor/cap. */
function stripLiteralParens(sql: string): string {
  const m = sql.match(/^\s*\((-\d+)\)\s*$/);
  return m ? m[1]! : sql;
}

/**
 * Re-encode a SQLite-typed scalar as canonical JSON text. SQLite's
 * `json_extract` and `json_each.value` return *typed* SQLite values
 * (TEXT for json strings, INTEGER for json booleans, etc.) — which
 * means information is lost: a JSON string `"true"` and a JSON boolean
 * `true` both come back as ambiguous SQLite values. The executor
 * round-trips value columns through `JSON.parse`, so a string that
 * happens to look like a JSON literal (`"42"`, `"true"`) silently
 * round-trips to the wrong type.
 *
 * Wrapping with this CASE makes every json-shaped result come back as
 * canonical JSON text, so `JSON.parse` always recovers the original
 * shape. The shape distinguishes leaves by `typePath` — usually a
 * `json_type(src, path)` call for a `json_extract` result, or
 * `${alias}.type` for a `json_each` row.
 */
/**
 * Replace IEEE Infinity / NaN with SQL NULL. JSON has no representation
 * for non-finite numerics; when one slips into a json_array / json_object
 * (e.g. via arithmetic overflow), SQLite emits `9e999` / `nan` text that
 * the executor's `JSON.parse` interprets as JS Infinity / NaN —
 * diverging from the native path which substitutes JSON null. Wrap
 * float-typed elements with this CASE so the round-trip lands at JSON
 * null on every backend.
 */
function finiteOrNull(floatSql: string): string {
  return `(CASE WHEN ABS(${floatSql}) > 1.7976931348623157e308 OR ${floatSql} <> ${floatSql} THEN NULL ELSE ${floatSql} END)`;
}

/**
 * Reinterpret the low 32 bits of a 64-bit SQLite integer expression as a
 * signed 32-bit value, so bit ops match the int32 (Java/JS) result on the
 * Postgres and native backends. Pure arithmetic (`& + -`) so it needs no
 * XOR operator: take the low 32 bits, then map the [2^31, 2^32) half onto
 * the negative range.
 */
function i32(expr: string): string {
  return `(((((${expr}) & 4294967295) + 2147483648) & 4294967295) - 2147483648)`;
}

function jsonScalarAsCanonical(typeSql: string, valueSql: string): string {
  // A JSON `null` leaf is the canonical text `'null'`, not SQL NULL. That is §8
  // of doc/design/null-as-a-value.md and the whole reason `value` spells its null
  // the JSON way (§9.3): SQL NULL in a `value`-typed expression has to be free to
  // mean *undefined*, so that a missing key withholds its row while a key that is
  // present and holds a null derives one carrying it. Collapsing the two, which
  // this used to do, is what made them indistinguishable.
  return `(CASE
    WHEN ${typeSql} = 'text' THEN json_quote(${valueSql})
    WHEN ${typeSql} = 'true' THEN 'true'
    WHEN ${typeSql} = 'false' THEN 'false'
    WHEN ${typeSql} = 'null' THEN 'null'
    ELSE ${valueSql}
  END)`;
}

function canonicalJsonSql(jsonSql: string, typeSql: string, scalarSql: string, depth = 2): string {
  if (depth <= 0) {
    return jsonScalarAsCanonical(typeSql, scalarSql);
  }
  const alias = `__dm_json_${depth}`;
  const child = canonicalJsonSql(`${alias}.value`, `${alias}.type`, `${alias}.value`, depth - 1);
  const keyOrder = `length(CAST(${alias}.key AS BLOB)), CAST(${alias}.key AS BLOB)`;
  const arrayOrder = `CAST(${alias}.key AS INTEGER)`;
  return `(CASE ${typeSql}
    WHEN 'object' THEN COALESCE((
      SELECT json_group_object(${alias}.key, json(${child}) ORDER BY ${keyOrder})
      FROM json_each(${jsonSql}) AS ${alias}
    ), '{}')
    WHEN 'array' THEN COALESCE((
      SELECT json_group_array(json(${child}) ORDER BY ${arrayOrder})
      FROM json_each(${jsonSql}) AS ${alias}
    ), '[]')
    ELSE ${jsonScalarAsCanonical(typeSql, scalarSql)}
  END)`;
}

export class SqliteSqlDialect implements SqlDialect {
  readonly name = "sqlite";
  readonly supportsNonLinearRecursion = false;

  createView(name: string, body: string): string {
    return `CREATE VIEW IF NOT EXISTS ${ident(name)} AS\n  ${body}\n;`;
  }

  createRecursiveView(name: string, columns: string, body: string): string {
    return `CREATE VIEW IF NOT EXISTS ${ident(name)} AS\n  WITH RECURSIVE ${ident(name)}(${columns}) AS (\n  ${body}\n  )\n  SELECT * FROM ${ident(name)}\n;`;
  }

  createMutuallyRecursiveViews(
    stratum: string[],
    arities: ReadonlyMap<string, number>,
    rules: ReadonlyMap<string, Rule[]>,
    analyzed: TypedProgram,
    translateRule: MutualRuleTranslator,
  ): string[] {
    // SQLite does not support mutually recursive CTEs. We merge all
    // predicates in the SCC into a single self-recursive CTE with a
    // discriminator tag column, then create views that filter by tag.
    // SQLite requires non-recursive terms before recursive ones in the
    // UNION, which is the order `mutualCteParts` returns them in; unlike
    // Postgres it takes any number of recursive branches, so they go in flat
    // and it needs no padding casts.
    const { combinedName, combinedCols, baseParts, recParts } = mutualCteParts(
      stratum,
      arities,
      rules,
      analyzed,
      this,
      translateRule,
      { typedPadding: false },
    );
    const unionParts = [...baseParts, ...recParts];

    const unionBody = unionParts.join("\n    UNION\n  ");
    const withBlock = `WITH RECURSIVE ${ident(combinedName)}(${combinedCols}) AS (\n  ${unionBody}\n  )`;

    const views: string[] = [];
    for (const predicate of stratum) {
      const arity = arities.get(predicate)!;
      const selectCols = colList(arity);
      views.push(
        `CREATE VIEW IF NOT EXISTS ${ident(predicate)} AS\n  ${withBlock}\n  SELECT ${selectCols} FROM ${ident(combinedName)} WHERE __tag = '${predicate.replace(/'/g, "''")}'\n;`,
      );
    }
    return views;
  }

  rangeSource(alias: string, lowSql: string, highSql: string): string {
    const gen = `__gen_${alias}`;
    if (!isIntLiteral(lowSql) || !isIntLiteral(highSql)) {
      // SQLite subqueries in FROM are not lateral, but table-valued
      // functions are: their arguments can reference earlier FROM aliases.
      // Build the exact per-row range inside a correlated scalar CTE, then
      // expose its JSON array through json_each. This avoids the old
      // fixed -1M..1M fallback that silently dropped values just outside
      // the cap when bounds were dynamic.
      return `json_each((WITH RECURSIVE ${gen}("value") AS (SELECT ${lowSql} AS "value" UNION ALL SELECT "value" + 1 FROM ${gen} WHERE "value" < ${highSql}) SELECT json_group_array("value") FROM ${gen})) AS ${alias}`;
    }
    const anchor = stripLiteralParens(lowSql);
    const cap = stripLiteralParens(highSql);
    return `(WITH RECURSIVE ${gen}("value") AS (SELECT ${anchor} AS "value" UNION ALL SELECT "value" + 1 FROM ${gen} WHERE "value" < ${cap}) SELECT "value" FROM ${gen}) AS ${alias}`;
  }

  rangeConditions(alias: string, lowSql: string, highSql: string): string[] {
    return [`${alias}."value" >= ${lowSql}`, `${alias}."value" <= ${highSql}`];
  }

  concat(argSql: string): string {
    // The explicit `ORDER BY` makes the per-group output deterministic
    // — without it, SQLite is free to enumerate group rows in any
    // order, which would otherwise diverge silently from the
    // STRING_AGG behaviour on Postgres and from the native
    // evaluator's sorted output. SQLite ≥ 3.44 supports ORDER BY
    // inside GROUP_CONCAT; bun:sqlite and the modern sql.js builds
    // both ship a recent enough SQLite.
    // Concatenation's identity over an empty group, per §7.
    return `COALESCE(GROUP_CONCAT(${argSql}, ',' ORDER BY ${argSql}), '')`;
  }

  integerSum(argSql: string): string {
    const positive = `TOTAL(CASE WHEN ${argSql} > 0 THEN ${argSql} ELSE 0 END)`;
    const negative = `TOTAL(CASE WHEN ${argSql} < 0 THEN -(${argSql}) ELSE 0 END)`;
    // Empty group first, so it yields 0 rather than NULL: `+`'s identity, per
    // §7. Overflow still yields NULL, which means undefined. The two have to be
    // told apart and only this order does it (§9.4).
    return `(CASE WHEN COUNT(${argSql}) = 0 THEN 0
      WHEN ${positive} <= 9007199254740991
      AND ${negative} <= 9007199254740991
      THEN CAST(${positive} - ${negative} AS INTEGER) ELSE NULL END)`;
  }

  jsonAgg(
    valueSql: string,
    argSql: string,
    argIsJson: boolean,
    argMayBeUndefined: boolean,
  ): string {
    // SQLite stores `value`s as canonical TEXT, so ordering by the
    // raw `argSql` works for both shapes: value columns sort by their
    // canonical-TEXT form, and primitive columns sort by their natural
    // SQL value (numeric for numbers, lex for strings, 0/1 for booleans).
    // For value columns, force BINARY collation explicitly so the order
    // matches Datamog's portable string order for canonical JSON text.
    //
    // `json(valueSql)` parses the TEXT into a JSON value: for json
    // arguments `valueSql` is the raw canonical TEXT, for primitive
    // arguments it's the `toJson`-lifted form (`json_quote(s)` for
    // strings, `CAST(n AS TEXT)` for numbers, `'true'`/`'false'`
    // CASE for booleans). Either way, `json_group_array` nests the
    // value structurally rather than escaping it.
    //
    // The `FILTER` tests the *original* `argSql` rather than `valueSql`, because
    // the lift has already turned a SQL NULL into the text `'null'`
    // (`json_quote(NULL)` returns that, not SQL NULL) and there would be nothing
    // left to test. Whether to filter at all depends on what a NULL there means:
    // an undefined contribution goes, a `null` value stays as a JSON null.
    //
    // `JSON_GROUP_ARRAY` already returns '[]' over an empty group, which is
    // append's identity and what §7 wants. The `NULLIF(..., '[]')` this used to
    // carry turned that into NULL on purpose.
    //
    // A null element sorts first (§7). For a primitive argument that is SQLite's
    // default ASC ordering and needs nothing said; for a `value` argument the
    // null is a JSON null in canonical TEXT, so it would otherwise sort at `null`
    // among the other leaves, between `[7]` and `{"k":1}`. A leading key puts it
    // where the spec says regardless of the argument's type.
    const orderKey = argIsJson
      ? `(CASE WHEN json_type(${argSql}) = 'null' THEN 0 ELSE 1 END), ${this.stringOrder(argSql)}`
      : argSql;
    const filter = argMayBeUndefined ? ` FILTER (WHERE ${argSql} IS NOT NULL)` : "";
    return `JSON_GROUP_ARRAY(json(${valueSql}) ORDER BY ${orderKey})${filter}`;
  }

  logicalEq(leftSql: string, rightSql: string): string {
    // SQLite's `IS` / `IS NOT` are null-aware equality (have been since
    // 3.0). Both bun:sqlite and the modern sql.js builds ship recent
    // enough engines, so this is portable across the SQLite path.
    return `(${leftSql} IS ${rightSql})`;
  }

  logicalNeq(leftSql: string, rightSql: string): string {
    return `(${leftSql} IS NOT ${rightSql})`;
  }

  stringOrder(sql: string): string {
    return `(${sql} COLLATE BINARY)`;
  }

  bitwise(op: BitwiseOp, leftSql: string, rightSql: string): string {
    const l = i32(leftSql);
    const r = i32(rightSql);
    // Shift count mod 32 (Java/JS semantics), matching the native backend.
    const count = `((${rightSql}) & 31)`;
    switch (op) {
      case "&":
        return i32(`(${l} & ${r})`);
      case "|":
        return i32(`(${l} | ${r})`);
      // SQLite has no XOR operator: a ^ b = (a | b) & ~(a & b).
      case "^":
        return i32(`((${l} | ${r}) & ~(${l} & ${r}))`);
      case "<<":
        return i32(`(${l} << ${count})`);
      case ">>":
        return i32(`(${l} >> ${count})`);
      // Logical shift: mask the operand to unsigned 32-bit, shift, then
      // reinterpret the result as signed int32.
      case ">>>":
        return i32(`((${l} & 4294967295) >> ${count})`);
    }
  }

  roundToScale(valueSql: string, scaleSql: string, resultType: "integer" | "float"): string {
    const factor = `POWER(10, ${scaleSql})`;
    const negativeScale = `((CASE WHEN (${valueSql}) < 0 THEN -1 ELSE 1 END) * FLOOR(ABS(${valueSql}) * ${factor} + 0.5) / ${factor})`;
    const rounded = `(CASE WHEN (${valueSql}) IS NULL OR (${scaleSql}) IS NULL THEN NULL WHEN (${scaleSql}) < 0 AND ${factor} = 0 THEN 0 WHEN (${scaleSql}) < 0 THEN ${negativeScale} ELSE ROUND(${valueSql}, ${scaleSql}) END)`;
    return resultType === "integer" ? `CAST(${rounded} AS INTEGER)` : rounded;
  }

  jsonSubscript(receiverSql: string, indexSql: string, _indexIsString: boolean): string {
    // Iterate the receiver's entries with `json_each` and compare the key
    // literally, matching Postgres's `->`/`->>` and the native evaluator's
    // `Object.hasOwn`. This handles both index kinds without branching:
    // `json_each` keys an object by its text keys and an array by integer
    // keys, and a comparison across storage classes (a string index vs an
    // array's integer key, or an integer index vs an object's text key)
    // never matches, so cross-kind access yields SQL NULL just as the native
    // evaluator does. A scalar/null receiver has no matching entry.
    //
    // Crucially `json_each` references the receiver exactly once, so a chained
    // `V["a"]["b"]` / `V[0][0]` grows the SQL linearly instead of duplicating
    // the receiver per level (which overflowed SQLite's parser). The
    // translator guards negative integer indices before this hook.
    const value = jsonScalarAsCanonical("je.type", "je.value");
    return `(SELECT ${value}
      FROM json_each(${receiverSql}) AS je
      WHERE je.key = ${indexSql}
      LIMIT 1)`;
  }

  jsonSlice(receiverSql: string, startSql: string | null, endSql: string | null): string {
    // SQLite's json_extract path syntax doesn't support slices.
    // Build the sub-array via json_each + json_group_array; `key` is
    // already integer-typed so no CAST is needed. Empty range → '[]'
    // (SQLite returns '[]' from json_group_array of zero rows
    // directly; the COALESCE is belt-and-braces).
    // `json_each.value` returns SQLite-typed scalar leaves (1/0 for
    // booleans, raw TEXT for strings) and JSON text for nested arrays /
    // objects. Re-canonicalise each element and mark it as JSON before
    // aggregating, or a slice like `["x", true, {"a":1}]` becomes
    // `["x",1,"{\"a\":1}"]` after the executor parses the result.
    //
    // Slicing a non-array `value` returns SQL NULL, matching the native
    // evaluator. Without the outer type guard, `json_each({})`
    // reaggregates object entries into `[]` or a value array.
    const start = startSql ?? "0";
    const value = jsonScalarAsCanonical("je.type", "je.value");
    // Bind the receiver once (as `r.v`): the array guard, the default end
    // bound, and json_each would otherwise each re-embed it, so a chained
    // `V[0][1:3]` grew the SQL exponentially and overflowed the parser.
    const end = endSql ?? "json_array_length(r.v)";
    return `(SELECT CASE WHEN json_type(r.v) = 'array' THEN
      COALESCE((SELECT json_group_array(json(${value}))
        FROM (SELECT type, value, key FROM json_each(r.v)
              WHERE key >= ${start} AND key < ${end}
              ORDER BY key) AS je), '[]')
      ELSE NULL END
    FROM (SELECT ${receiverSql} AS v) AS r)`;
  }

  jsonIterate(
    kind: "object" | "array",
    sourceSql: string,
    alias: string,
  ): { fromSql: string; keySql: string; valueSql: string } {
    // SQLite's `json_each` is a table-valued function with implicit
    // lateral semantics — a comma-join FROM source can reference outer
    // columns without `LATERAL` (which SQLite doesn't support anyway).
    // Wrapping json_each in a derived `(SELECT ... FROM json_each)`
    // would lose that property, so we expose the natural `key`/`value`
    // columns at the alias and let the translator reference them by
    // their per-dialect names. Guard the source via CASE: when its
    // type doesn't match `kind`, json_each receives NULL and produces
    // zero rows — mirroring the native evaluator's shape-mismatch
    // behaviour.
    const expectedType = kind === "object" ? "'object'" : "'array'";
    const guarded = `CASE WHEN json_type(${sourceSql}) = ${expectedType} THEN ${sourceSql} ELSE NULL END`;
    return {
      fromSql: `json_each(${guarded}) AS ${alias}`,
      keySql: `${alias}.key`,
      valueSql: jsonScalarAsCanonical(`${alias}.type`, `${alias}.value`),
    };
  }

  jsonTypeOf(jsonSql: string): string {
    // SQLite's `json_type` distinguishes integer / floating-point numbers and
    // true/false booleans; collapse to the spec set so output agrees across
    // backends. A JSON null answers `'null'`: it is an ordinary value with an
    // ordinary type name, and reporting it is what `type_of` is for (§8). Only a
    // SQL NULL receiver, meaning the expression had no value at all, gives NULL,
    // and the enclosing definedness guard withholds that row anyway.
    return `(CASE json_type(${jsonSql})
      WHEN 'true' THEN 'boolean'
      WHEN 'false' THEN 'boolean'
      WHEN 'integer' THEN 'number'
      WHEN 'real' THEN 'number'
      WHEN 'text' THEN 'string'
      WHEN 'null' THEN 'null'
      ELSE json_type(${jsonSql})
    END)`;
  }

  jsonAsString(jsonSql: string): string {
    // `json_extract(x, '$')` on a json string-leaf returns the
    // unquoted TEXT value — exactly what we want for `as_string`. For
    // any other shape we return NULL.
    return `(CASE WHEN json_type(${jsonSql}) = 'text'
      THEN json_extract(${jsonSql}, '$') ELSE NULL END)`;
  }

  jsonAsInteger(jsonSql: string): string {
    // Match native `as_integer.value` (`v < MIN_SAFE_INTEGER || v >
    // MAX_SAFE_INTEGER → null`): SQLite's `CAST(... AS INTEGER)`
    // saturates to INT64 range, so an out-of-safe-range integer would
    // survive as a precision-lost value instead of NULL — diverging
    // from native, which rejects anything outside ±2^53 - 1 (the JS
    // safe-integer range).
    //
    // Accept both lexical integer-form (json_type 'integer') and
    // integer-valued reals (json_type 'real'): native `as_integer.value`
    // accepts any number with `v === Math.trunc(v)`, so `as_integer(3.0)`
    // is 3, and a float literal `3.0` lifted to a value reaches SQLite as
    // the text "3.0" (json_type 'real') because it bypasses json
    // canonicalisation. Gating on 'integer' alone dropped these to NULL,
    // diverging from native / seminaive / Postgres. The
    // `CAST(... AS REAL) = ${cast}` guard rejects fractional reals (1.5),
    // and the safe-integer range post-check
    // rejects values within INT64 but outside JS safe range — reachable
    // via `parse_json`, which preserves the source text without
    // canonicalisation.
    const ext = `json_extract(${jsonSql}, '$')`;
    const cast = `CAST(${ext} AS INTEGER)`;
    return `(CASE WHEN json_type(${jsonSql}) IN ('integer', 'real')
      AND CAST(${ext} AS REAL) = ${cast}
      AND ABS(${cast}) <= 9007199254740991
      THEN ${cast} ELSE NULL END)`;
  }

  jsonAsFloat(jsonSql: string): string {
    // Match native `as_float.value` (`Number.isFinite(args[0]) ? v : null`):
    // a JSON number that's IEEE non-finite (Infinity / NaN, reachable
    // from legacy or hand-seeded JSON text such as `9e999`) coerces to
    // NULL, not Infinity. Without this guard the cross-backend
    // `as_float` output diverges: native NULL vs SQLite Infinity.
    const cast = `CAST(json_extract(${jsonSql}, '$') AS REAL)`;
    return `(CASE WHEN json_type(${jsonSql}) IN ('integer', 'real')
      AND ABS(${cast}) <= 1.7976931348623157e308
      AND ${cast} = ${cast}
      THEN ${cast} ELSE NULL END)`;
  }

  jsonAsBoolean(jsonSql: string): string {
    // SQLite has no native boolean type — return 1/0 here and rely on
    // the executor's `coerceBooleanColumns` to lift it back to JS
    // true/false at the result-row boundary, matching how every other
    // boolean-valued expression flows.
    return `(CASE json_type(${jsonSql})
      WHEN 'true' THEN 1
      WHEN 'false' THEN 0
      ELSE NULL
    END)`;
  }

  jsonLength(jsonSql: string): string {
    return `(CASE json_type(${jsonSql})
      WHEN 'array' THEN json_array_length(${jsonSql})
      WHEN 'object' THEN (SELECT count(*) FROM json_each(${jsonSql}))
      WHEN 'text' THEN length(json_extract(${jsonSql}, '$'))
      ELSE NULL
    END)`;
  }

  jsonHasKey(jsonSql: string, keySql: string): string {
    return `(CASE
      WHEN ${jsonSql} IS NULL OR ${keySql} IS NULL THEN NULL
      WHEN json_type(${jsonSql}) = 'object' THEN EXISTS (
        SELECT 1 FROM json_each(${jsonSql}) AS je
        WHERE je.key = ${keySql}
      )
      ELSE 0
    END)`;
  }

  jsonKeys(jsonSql: string): string {
    // `json_each` exposes an object's `key` column as TEXT; aggregate
    // with `json_quote(key)` so the result is a JSON array of strings
    // (without the quote each TEXT key would land in the array as a
    // number-shaped value via SQLite's auto-detection). Empty object
    // → `'[]'` directly; `json_group_array` over zero rows already
    // produces that, so no COALESCE needed.
    return `(CASE WHEN json_type(${jsonSql}) = 'object'
      THEN (SELECT json_group_array(json(json_quote(key)) ORDER BY ${this.stringOrder("key")}) FROM json_each(${jsonSql}))
      ELSE NULL END)`;
  }

  jsonValues(jsonSql: string): string {
    // `json_each.value` returns the natural SQLite type for primitive
    // leaves (INTEGER / REAL / TEXT) and JSON text for arrays /
    // objects; route through `jsonScalarAsCanonical` so booleans,
    // strings, and `null` come back in their canonical JSON form
    // before they hit `json_group_array`. Without this, a boolean
    // value would land in the array as `0`/`1` instead of
    // `false`/`true`. ORDER BY key in the backend's portable string
    // order matches `jsonKeys` element-for-element. Empty object →
    // `'[]'` from `json_group_array`.
    const value = jsonScalarAsCanonical("je.type", "je.value");
    return `(CASE WHEN json_type(${jsonSql}) = 'object'
      THEN (SELECT json_group_array(json(${value}) ORDER BY ${this.stringOrder("je.key")}) FROM json_each(${jsonSql}) AS je)
      ELSE NULL END)`;
  }

  jsonStringify(jsonSql: string): string {
    // SQLite stores `value`s as canonical JSON TEXT (jsonb key order, no
    // whitespace). Object/array/quoted-string/true/false/null leaves are
    // already TEXT, but a numeric scalar leaf carries SQLite numeric
    // affinity, so cast to TEXT to get the canonical decimal text that
    // `to_json` (spec: returns a string) and `concat` require — otherwise
    // `to_json(parse_json("42"))` is the number 42, not the text "42".
    return `CAST(${jsonSql} AS TEXT)`;
  }

  toJson(valueSql: string, valueType: PrimitiveType): string {
    // SQLite stores JSON as canonical TEXT. Numbers stringify to their
    // decimal form (matching JSON's number grammar — `'1.0'` here will
    // round-trip through the executor's `JSON.parse` to JS `1`, in
    // agreement with Postgres's `to_jsonb`). Booleans need explicit
    // `'true'` / `'false'` literals because SQLite renders bools as
    // 0/1; strings need `json_quote` to add the surrounding quotes and
    // escape any embedded special characters.
    if (valueType === "integer" || valueType === "float") {
      return `CAST(${valueSql} AS TEXT)`;
    }
    if (valueType === "boolean") {
      return `(CASE WHEN ${valueSql} THEN 'true' WHEN NOT (${valueSql}) THEN 'false' END)`;
    }
    if (valueType === "string") {
      return `json_quote(${valueSql})`;
    }
    // The `null` type lifts to the JSON null, spelled as canonical text rather
    // than SQL NULL: inside a `value` a null is a value, and SQL NULL there means
    // undefined (§8, §9.3).
    if (valueType === "null") {
      return "'null'";
    }
    throw new Error(`SQLite toJson: unsupported source type '${valueType}'`);
  }

  jsonArray(elements: ReadonlyArray<{ sql: string; type: PrimitiveType | undefined }>): string {
    // SQLite's `json_array` accepts SQL-typed arguments directly: TEXT
    // becomes JSON string, INTEGER/REAL become JSON number, NULL becomes
    // JSON null. Booleans are stored as 0/1 INTEGER and would emit `[1]`
    // for `[true]`, so we lift them via `toJson` (`'true'`/`'false'`
    // text) and re-mark as JSON with `json(...)`. Already-JSON values
    // are TEXT in this storage scheme, so they too need the `json(...)`
    // wrap or `json_array` would re-quote them as strings.
    //
    // Float elements pass through unmodified except for one edge: a
    // non-finite REAL (Infinity / NaN, produced by arithmetic overflow
    // such as a chained `1e9 * 1e9 * ...`) round-trips through
    // `json_array` as the textually-divergent `9e999` / `nan`, which
    // the executor's JSON.parse interprets as JS Infinity / NaN —
    // diverging from the native ArrayLiteral path which substitutes
    // null for non-finite values. Guard each float with a finiteness
    // CASE so the cross-backend output agrees.
    const args = elements.map((e) => {
      if (e.type === undefined) return e.sql;
      if (e.type === "float") return finiteOrNull(e.sql);
      if (e.type === "string" || e.type === "integer") return e.sql;
      return `json(${e.type === "value" ? e.sql : this.toJson(e.sql, e.type)})`;
    });
    return `json_array(${args.join(", ")})`;
  }

  jsonObject(
    entries: ReadonlyArray<{
      key: string;
      valueSql: string;
      valueType: PrimitiveType | undefined;
    }>,
  ): string {
    // SQLite's `json_object` emits entries in argument order and stores
    // the result as TEXT, so source order leaks into the canonical
    // form. The native evaluator (`values.ts`'s ObjectLiteral case)
    // routes construction through `canonicalizeJson`, which sorts keys
    // in Postgres jsonb's canonical order; Postgres's `jsonb_build_object`
    // produces jsonb (sorted on storage). Without sorting here, two
    // literals that differ only in source key order would fail dedup,
    // joins, and `=` on SQLite/sql.js while unifying everywhere else.
    // Sort entries in the same jsonb order so every backend agrees on
    // the canonical form.
    // `jsonb_build_object('a', 1, 'a', 2)` and the native evaluator's
    // object-literal construction both use last-write-wins semantics for
    // duplicate keys. SQLite's `json_object('a', 1, 'a', 2)` preserves both
    // textual entries, so collapse duplicates before sorting/emitting.
    const deduped = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) {
      deduped.set(entry.key, entry);
    }
    const sorted = [...deduped.values()].sort((a, b) => compareJsonbObjectKeys(a.key, b.key));
    const args = sorted.map((e) => {
      const key = `'${e.key.replace(/'/g, "''")}'`;
      let value: string;
      if (e.valueType === undefined) {
        value = e.valueSql;
      } else if (e.valueType === "float") {
        // Same finiteness guard as `jsonArray` for float elements.
        value = finiteOrNull(e.valueSql);
      } else if (e.valueType === "string" || e.valueType === "integer") {
        value = e.valueSql;
      } else {
        value = `json(${e.valueType === "value" ? e.valueSql : this.toJson(e.valueSql, e.valueType)})`;
      }
      return `${key}, ${value}`;
    });
    return `json_object(${args.join(", ")})`;
  }

  parseJson(textSql: string): string {
    // `json_valid(text)` is silent — returns 1 for parseable JSON, 0
    // for malformed or NULL input. Gate `json()` on it so a bad parse
    // becomes NULL rather than a runtime error. That NULL is the *undefined*
    // reading and the enclosing definedness guard withholds the row.
    //
    // A top-level `null` parses successfully and yields the JSON null value, so
    // it is deliberately not excluded here: `parse_json("null")` derives a row
    // carrying null. This used to carry `AND json_type(j) <> 'null'`, which was
    // the same collapse §8 removes from the accessors.
    //
    // SQLite accepts numeric leaves such as `9e999` and exposes them as
    // IEEE Infinity through `json_each`/`json_tree`; JSONL/CSV loaders and
    // native `parse_json` reject those as non-representable JSON values.
    // Walk the parsed tree and reject any numeric leaf outside the finite
    // JS Number range before it reaches result decoding.
    //
    // `json()` minifies the input but preserves source object-key order.
    // Route parseable values through a bounded recursive SQL expression
    // that sorts object entries in the same canonical order used by
    // object literals and EDB inserts. That keeps ordinary parse_json
    // results join/dedup-compatible with equivalent values from other
    // sources on SQLite/sql.js as well as Postgres/native.
    const canonical = canonicalJsonSql("j", "json_type(j)", "json_extract(j, '$')");
    const num = "CAST(jt.atom AS REAL)";
    return `(WITH __datamog_parse_json(j) AS (
      SELECT CASE WHEN json_valid(${textSql}) THEN json(${textSql}) ELSE NULL END
    )
    SELECT CASE WHEN j IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM json_tree(j) AS jt
        WHERE jt.type IN ('integer', 'real')
          AND (${num} != ${num} OR ABS(${num}) > 1.7976931348623157e308)
      )
      THEN ${canonical} ELSE NULL END
    FROM __datamog_parse_json)`;
  }

  parseStringAsInteger(textSql: string): string {
    // SQLite's `CAST(textval AS INTEGER)` is silent — `'abc'` becomes
    // 0, `'1.5'` becomes 1, `'01'` becomes 1, and oversized values
    // saturate at INT64_MIN/MAX without raising. To enforce strict
    // canonical decimal form, round-trip the cast: if the integer's
    // canonical text representation differs from the input at all, the
    // input wasn't canonical.
    //
    // Catches: leading zeros (`'01'` → 1 → `'1'` ≠ `'01'`), trailing
    // junk (`'1.5'` → 1 → `'1'` ≠ `'1.5'`), `'-0'` (→ 0 → `'0'`),
    // empty / whitespace-padded strings, overflow, and so on.
    //
    const cast = `CAST(${textSql} AS INTEGER)`;
    return `(CASE WHEN ${textSql} = CAST(${cast} AS TEXT)
      AND ${cast} BETWEEN -9007199254740991 AND 9007199254740991
      THEN ${cast} ELSE NULL END)`;
  }

  parseStringAsFloat(textSql: string): string {
    // SQLite has no regex operator and no string-form for floats that
    // round-trips both `'1'` and `'1.0'` (the engine canonicalises
    // both to the `'1.0'` form via CAST AS TEXT, so the integer-style
    // input would be rejected). Validate the input as canonical
    // decimal floating-point text via a chain of GLOB checks instead.
    // Each check rejects one disallowed shape; falling through means
    // the input is valid and gets cast. The final finiteness guard is
    // still needed because a huge canonical decimal casts to Infinity
    // on SQLite, while the native parser returns NULL for non-finite
    // results.
    //
    // Canonical form (matches the Postgres regex): `0`, `-?[1-9][0-9]*`,
    // or either with a `\\.[0-9]+` fraction; plus the special case
    // `-0.<frac>` for negative fractional zero. Rejects empty, leading
    // `+` (any non-digit/dot/minus), leading zeros, multiple minuses,
    // misplaced minus, multiple dots, dangling dots, and `-0` alone.
    // SQLite's GLOB uses `^` (not `!`) as the set-negation marker —
    // `[!0-9]` would match a literal `!` or any digit, which silently
    // accepts garbage. Use `[^…]` everywhere a negated set is needed.
    return `(CASE
      WHEN ${textSql} IS NULL THEN NULL
      WHEN ${textSql} = '' THEN NULL
      WHEN ${textSql} GLOB '*[^0-9.-]*' THEN NULL
      WHEN ${textSql} GLOB '*-*-*' THEN NULL
      WHEN ${textSql} GLOB '?*-*' AND NOT ${textSql} GLOB '-*' THEN NULL
      WHEN ${textSql} GLOB '*.*.*' THEN NULL
      WHEN ${textSql} GLOB '0[0-9]' THEN NULL
      WHEN ${textSql} GLOB '0[0-9][0-9]*' THEN NULL
      WHEN ${textSql} GLOB '0[0-9]?*' THEN NULL
      WHEN ${textSql} GLOB '-0[0-9]' THEN NULL
      WHEN ${textSql} GLOB '-0[0-9][0-9]*' THEN NULL
      WHEN ${textSql} GLOB '-0[0-9]?*' THEN NULL
      WHEN ${textSql} = '-0' THEN NULL
      WHEN ${textSql} = '-' THEN NULL
      WHEN ${textSql} = '.' THEN NULL
      WHEN ${textSql} = '-.' THEN NULL
      WHEN ${textSql} GLOB '*.' THEN NULL
      WHEN ${textSql} GLOB '.*' THEN NULL
      WHEN ${textSql} GLOB '-.*' THEN NULL
      ELSE ${finiteOrNull(`CAST(${textSql} AS REAL)`)}
    END)`;
  }
}
