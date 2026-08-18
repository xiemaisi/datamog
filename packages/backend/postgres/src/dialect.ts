import type { BitwiseOp, PrimitiveType, Rule, TypedProgram } from "datamog-core";
import {
  type MutualRuleTranslator,
  SQL_TYPE_MAP,
  type SqlDialect,
  colList,
  ident,
  mutualCteParts,
} from "datamog-engine";

/**
 * Replace IEEE Infinity / NaN with SQL NULL. Used at jsonb-construction
 * sites so a non-finite float doesn't produce a backend-specific jsonb
 * leaf (or raise on cast) — see `jsonArray` / `jsonObject` below for
 * the detailed rationale. Postgres treats NaN as larger than any
 * non-NaN value in comparisons, so `ABS(x) > MAX_VALUE` catches both
 * `±Infinity` and NaN — no separate NaN check needed.
 */
function finiteOrNull(floatSql: string): string {
  return `(CASE WHEN ABS(${floatSql}) > 1.7976931348623157e308 THEN NULL ELSE ${floatSql} END)`;
}

/**
 * A JSON `null` leaf stays a JSONB `'null'` rather than becoming SQL NULL.
 *
 * This used to be `NULLIF(x, 'null'::jsonb)`, collapsing the two. §8 of
 * doc/design/null-as-a-value.md needs them apart: SQL NULL in a `value`-typed
 * expression means *undefined*, so a missing key withholds its row while a key
 * that is present and holds a null derives one carrying it. Kept as a named
 * identity rather than deleted at its four call sites, so the places that
 * deliberately do *not* collapse stay visible next to sqlite's matching
 * `jsonScalarAsCanonical`.
 */
function jsonNullPreserved(jsonSql: string): string {
  return jsonSql;
}

/** Reinterpret the low 32 bits of an integer expression as signed int32. */
function i32(expr: string): string {
  return `(((((${expr})::bigint & 4294967295) + 2147483648) & 4294967295) - 2147483648)`;
}

export class PostgresSqlDialect implements SqlDialect {
  readonly name = "postgres";
  readonly supportsNonLinearRecursion = false;

  sqlType(type: PrimitiveType): string {
    // `jsonb` (binary JSON) over `json` because it canonicalises numbers
    // and key order on storage — that's what gives Postgres native
    // structural equality under `=`, `DISTINCT`, and `UNION`. The text
    // `json` type would compare textually and silently break joins.
    if (type === "value") return "JSONB";
    if (type === "integer") return "BIGINT";
    // Postgres `REAL` is single-precision float4 (~7 digits), but Datamog
    // floats are 64-bit doubles everywhere else (sqlite `REAL` is 8-byte,
    // native is a JS number) and every Postgres runtime float op already
    // casts to `double precision`. Store float columns as float8 too, so a
    // loaded double keeps full precision and equality/join/dedup match the
    // other backends instead of silently truncating.
    if (type === "float") return "DOUBLE PRECISION";
    return SQL_TYPE_MAP[type];
  }

  valueInsertPlaceholder(placeholder: string): string {
    // The loader binds the canonical JSON *text* for a value column. Bun's
    // pg driver sends a bare string param as a JSON string scalar, so a
    // plain `$n` (or even `$n::jsonb`) would store `'[...]'` as a jsonb
    // string, not an array. Casting through `text` first forces the param to
    // be read as JSON source text and parsed into structured `JSONB`.
    return `${placeholder}::text::jsonb`;
  }

  jsonSubscript(receiverSql: string, indexSql: string, indexIsString: boolean): string {
    // jsonb's `->` operator handles both forms: string → object key, integer
    // → array element. Force the index expression's SQL type so that mixed
    // JSON shapes (object indexed with integer, array indexed with string)
    // return NULL rather than raising, which is the *undefined* reading and
    // withholds the row. A present key holding a JSON null keeps its `'null'`
    // and derives a row (§8).
    const cast = indexIsString ? "TEXT" : "INTEGER";
    return jsonNullPreserved(`(${receiverSql} -> CAST(${indexSql} AS ${cast}))`);
  }

  jsonSlice(receiverSql: string, startSql: string | null, endSql: string | null): string {
    // Postgres has no slice operator on jsonb. Build the sub-array via
    // `jsonb_array_elements` filtered by ordinality, then reaggregate.
    // Wrap the element subquery so the predicate-row column references
    // ($) correlate correctly. `array_length` provides the implicit
    // upper bound when `endSql` is omitted; `0` is the implicit lower
    // bound when `startSql` is omitted.
    const start = startSql ?? "0";
    const end = endSql ?? `(SELECT jsonb_array_length(${receiverSql}))`;
    return `(CASE WHEN jsonb_typeof(${receiverSql}) = 'array' THEN
      (SELECT COALESCE(jsonb_agg(value ORDER BY ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(${receiverSql}) WITH ORDINALITY AS t(value, ordinality)
      WHERE ordinality - 1 >= ${start} AND ordinality - 1 < ${end})
      ELSE NULL END)`;
  }

  jsonIterate(
    kind: "object" | "array",
    sourceSql: string,
    alias: string,
  ): { fromSql: string; keySql: string; valueSql: string } {
    // Postgres has separate functions for object iteration (jsonb_each)
    // and array iteration (jsonb_array_elements_with_ordinality). Both
    // need LATERAL so the source expression can reference an outer
    // column. Wrap the source in a CASE so non-{object,array} payloads
    // produce a NULL input — Postgres's set-returning JSON functions
    // emit zero rows for NULL, mirroring the native evaluator's
    // shape-mismatch → no rows behaviour.
    if (kind === "object") {
      const guarded = `CASE WHEN jsonb_typeof(${sourceSql}) = 'object' THEN ${sourceSql} ELSE NULL END`;
      return {
        fromSql: `LATERAL jsonb_each(${guarded}) AS ${alias}(_k, _v)`,
        keySql: `${alias}._k`,
        valueSql: jsonNullPreserved(`${alias}._v`),
      };
    }
    const guarded = `CASE WHEN jsonb_typeof(${sourceSql}) = 'array' THEN ${sourceSql} ELSE NULL END`;
    return {
      fromSql: `LATERAL jsonb_array_elements(${guarded}) WITH ORDINALITY AS ${alias}(_v, _o)`,
      keySql: `(${alias}._o - 1)::INTEGER`,
      valueSql: jsonNullPreserved(`${alias}._v`),
    };
  }

  jsonTypeOf(jsonSql: string): string {
    // jsonb_typeof already returns the canonical spec strings
    // ('object' | 'array' | 'string' | 'number' | 'boolean' | 'null'), and
    // `'null'` is now among the answers rather than hidden: a JSON null is an
    // ordinary value and reporting its type is what `type_of` is for (§8).
    return `jsonb_typeof(${jsonSql})`;
  }

  jsonAsString(jsonSql: string): string {
    // `x #>> '{}'` extracts the jsonb value as text. For string
    // leaves this returns the unquoted content; for any other shape
    // it would return the JSON form, so we gate by jsonb_typeof.
    return `(CASE WHEN jsonb_typeof(${jsonSql}) = 'string'
      THEN ${jsonSql} #>> '{}' ELSE NULL END)`;
  }

  jsonAsInteger(jsonSql: string): string {
    // jsonb canonicalises numbers numerically — `1.0` and `1` become
    // the same numeric, so a lexical type check (like SQLite/sql.js
    // use) wouldn't distinguish int-form from float-form. Instead,
    // check that the numeric is integer-valued and within JS safe-
    // integer range (±2^53 - 1, matching native `as_integer.value`),
    // then cast. The pre-fix bounds were the wider INT64 range
    // (±2^63), so values in (2^53, 2^63] passed through as
    // precision-lost JS numbers instead of NULL — divergence from
    // native, which rejects anything outside JS safe range. The
    // repeated `(jsonSql #>> '{}')::numeric` costs nothing meaningful
    // — Postgres CSEs identical sub-expressions during planning.
    const num = `(${jsonSql} #>> '{}')::numeric`;
    return `(CASE WHEN jsonb_typeof(${jsonSql}) = 'number'
      AND ${num} = trunc(${num})
      AND ${num} BETWEEN -9007199254740991 AND 9007199254740991
      THEN ${num}::bigint ELSE NULL END)`;
  }

  jsonAsFloat(jsonSql: string): string {
    // Match native `as_float.value` (`Number.isFinite(args[0]) ? v : null`):
    // a JSON number that's IEEE non-finite (Infinity / NaN — reachable
    // by chained arithmetic captured into a value column, or via
    // `parse_json` on a SQLite-side value that survived the round-trip)
    // coerces to NULL, not Infinity. Without this guard the
    // cross-backend `as_float` output diverges. Use ABS-vs-MAX_VALUE
    // since Postgres treats NaN as larger than every non-NaN, so the
    // single check catches both Infinity and NaN.
    const cast = `(${jsonSql} #>> '{}')::double precision`;
    return `(CASE WHEN jsonb_typeof(${jsonSql}) = 'number' AND ABS(${cast}) <= 1.7976931348623157e308
      THEN ${cast} ELSE NULL END)`;
  }

  jsonAsBoolean(jsonSql: string): string {
    return `(CASE WHEN jsonb_typeof(${jsonSql}) = 'boolean'
      THEN (${jsonSql} #>> '{}')::boolean ELSE NULL END)`;
  }

  jsonLength(jsonSql: string): string {
    return `(CASE jsonb_typeof(${jsonSql})
      WHEN 'array' THEN jsonb_array_length(${jsonSql})
      WHEN 'object' THEN (SELECT count(*)::integer FROM jsonb_object_keys(${jsonSql}))
      WHEN 'string' THEN length(${jsonSql} #>> '{}')
      ELSE NULL
    END)`;
  }

  jsonHasKey(jsonSql: string, keySql: string): string {
    // A JSON null receiver falls through to FALSE rather than NULL: `has_key`
    // answers a yes/no question and a null has no keys. sqlite and the
    // interpreter already answered FALSE here, so the extra `'null'` arm this
    // used to carry was a Postgres-only divergence (§8).
    return `(CASE
      WHEN ${jsonSql} IS NULL OR ${keySql} IS NULL THEN NULL
      WHEN jsonb_typeof(${jsonSql}) = 'object' THEN (${jsonSql} ? ${keySql})
      ELSE FALSE
    END)`;
  }

  jsonKeys(jsonSql: string): string {
    // `jsonb_object_keys` returns one row per key as TEXT, in storage
    // (i.e. canonical sorted) order. Aggregate with explicit ORDER BY
    // for determinism even on planner orderings that don't preserve
    // source-order. `jsonb_agg(text_expr)` auto-lifts each text to a
    // jsonb string, so the output is a jsonb array of strings.
    // COALESCE handles the empty-object case — `jsonb_agg` over zero
    // rows returns NULL, but jq-style `keys({})` is `[]`.
    return `(CASE WHEN jsonb_typeof(${jsonSql}) = 'object'
      THEN COALESCE(
        (SELECT jsonb_agg(k ORDER BY ${this.stringOrder("k")}) FROM jsonb_object_keys(${jsonSql}) AS k),
        '[]'::jsonb)
      ELSE NULL END)`;
  }

  jsonValues(jsonSql: string): string {
    // `jsonb_each` exposes both key and value; ORDER BY key in the
    // backend's portable string order gives deterministic per-row output
    // that matches `jsonKeys` element-for-element. Empty-object → `[]`.
    return `(CASE WHEN jsonb_typeof(${jsonSql}) = 'object'
      THEN COALESCE(
        (SELECT jsonb_agg(value ORDER BY ${this.stringOrder("key")}) FROM jsonb_each(${jsonSql})),
        '[]'::jsonb)
      ELSE NULL END)`;
  }

  jsonStringify(jsonSql: string): string {
    // Postgres jsonb's `::text` serializer inserts a space after `:`
    // and `,` *outside* strings (e.g. `{"a": 1, "b": 2}`). The
    // canonical form on every other backend has no whitespace, so we
    // strip those spaces here. The regex consumes JSON strings whole
    // (so a `, ` or `: ` inside a string is preserved), then matches
    // the gap forms `, ` and `: ` separately. The replacement
    // concatenates the three capture groups: exactly one is non-
    // empty per match.
    //
    // Pattern breakdown:
    //   ("(?:[^"\\]|\\.)*")  — JSON string: opening quote, then chars
    //                          that are neither quote nor backslash, or
    //                          backslash-escapes (\", \\, \n, \uXXXX
    //                          all caught via `\\.` consuming the
    //                          escape lead-in)
    //   (,) [space]          — comma followed by a space
    //   (:) [space]          — colon followed by a space
    //
    // A JSON `null` leaf serialises to the four characters `null`, like every
    // other leaf. It used to collapse to SQL NULL here, which is the last of
    // the collapses null-as-a-value.md §8 removes: a JSON null is a value now,
    // and its serialisation is a string.
    return `regexp_replace((${jsonSql})::text, '("(?:[^"\\\\]|\\\\.)*")|(,) |(:) ', '\\1\\2\\3', 'g')`;
  }

  createView(name: string, body: string): string {
    return `CREATE OR REPLACE VIEW ${ident(name)} AS\n  ${body}\n;`;
  }

  createRecursiveView(name: string, columns: string, body: string): string {
    return `CREATE RECURSIVE VIEW ${ident(name)} (${columns}) AS (\n  ${body}\n);`;
  }

  /**
   * Fold several recursive rules into the one recursive term Postgres allows.
   *
   * `anchor UNION rec1 UNION rec2` parses as `(anchor UNION rec1) UNION rec2`,
   * putting a self-reference in the non-recursive half, and parenthesising it
   * the other way only trades that error for `recursive reference ... must not
   * appear more than once`. Naming the CTE once in `FROM` and unioning the
   * rules inside a `LATERAL` satisfies both rules: each branch reads the
   * previous iteration through `selfAlias`'s columns rather than through a
   * mention of the CTE.
   *
   * Recursion here is linear (the analyzer rejects a rule with two recursive
   * body atoms), so every rule has exactly one self-reference and this shape
   * always applies.
   */
  singleRecursiveTerm(predicate: string, selfAlias: string, recursive: string[]): string {
    const branches = recursive.join("\n      UNION\n      ");
    return `SELECT __lat.* FROM ${ident(predicate)} AS ${selfAlias}, LATERAL (\n      ${branches}\n    ) AS __lat`;
  }

  /**
   * Compile a mutually recursive SCC to one tagged CTE, as SQLite does.
   *
   * Postgres has never implemented mutual recursion between `WITH` items, so
   * the obvious shape -- one CTE per predicate, referring to each other -- is
   * rejected outright. Merging the SCC into a single self-recursive CTE with a
   * `__tag` discriminator sidesteps that, and a view per predicate filters its
   * own rows back out.
   *
   * The recursive branches are then folded through `singleRecursiveTerm`, since
   * one CTE for the whole SCC necessarily has a branch per rule and Postgres
   * allows only one recursive term naming the CTE once. Padding NULLs are cast:
   * Postgres takes the CTE's column types from the anchor, where a bare NULL
   * would resolve to `text` and then collide with the recursive term.
   */
  createMutuallyRecursiveViews(
    stratum: string[],
    arities: ReadonlyMap<string, number>,
    rules: ReadonlyMap<string, Rule[]>,
    analyzed: TypedProgram,
    translateRule: MutualRuleTranslator,
  ): string[] {
    const selfAlias = "__rec";
    const { combinedName, combinedCols, baseParts, recParts } = mutualCteParts(
      stratum,
      arities,
      rules,
      analyzed,
      this,
      translateRule,
      { typedPadding: true, selfAlias },
    );
    const unionParts = [...baseParts];
    if (recParts.length > 0) {
      unionParts.push(this.singleRecursiveTerm(combinedName, selfAlias, recParts));
    }
    const unionBody = unionParts.join("\n    UNION\n  ");
    const withBlock = `WITH RECURSIVE ${ident(combinedName)}(${combinedCols}) AS (\n  ${unionBody}\n  )`;

    return stratum.map((predicate) => {
      const selectCols = colList(arities.get(predicate)!);
      return `CREATE OR REPLACE VIEW ${ident(predicate)} AS\n  ${withBlock}\n  SELECT ${selectCols} FROM ${ident(combinedName)} WHERE __tag = '${predicate.replace(/'/g, "''")}'\n;`;
    });
  }

  rangeSource(alias: string, lowSql: string, highSql: string): string {
    return `generate_series(${lowSql}, ${highSql}) AS ${alias}("value")`;
  }

  rangeConditions(_alias: string, _lowSql: string, _highSql: string): string[] {
    return [];
  }

  logicalEq(leftSql: string, rightSql: string): string {
    return `(${leftSql} IS NOT DISTINCT FROM ${rightSql})`;
  }

  logicalNeq(leftSql: string, rightSql: string): string {
    return `(${leftSql} IS DISTINCT FROM ${rightSql})`;
  }

  stringOrder(sql: string): string {
    return `(${sql} COLLATE "C")`;
  }

  bitwise(op: BitwiseOp, leftSql: string, rightSql: string): string {
    const l = i32(leftSql);
    const r = i32(rightSql);
    // Shift count mod 32 (Java/JS semantics), matching the native backend.
    // Cast to `int`: Postgres defines its shift operators as `<type> << int4`
    // only, so a bigint count finds no operator now that `integer` is BIGINT.
    // The mask makes 0..31, so narrowing cannot overflow.
    const count = `(((${rightSql})::bigint & 31)::int)`;
    switch (op) {
      case "&":
        return i32(`(${l} & ${r})`);
      case "|":
        return i32(`(${l} | ${r})`);
      // Postgres spells bitwise XOR `#` (`^` is exponentiation).
      case "^":
        return i32(`(${l} # ${r})`);
      case "<<":
        return i32(`(${l} << ${count})`);
      case ">>":
        return i32(`(${l} >> ${count})`);
      // No `>>>` in Postgres: mask the operand to unsigned 32-bit in
      // bigint, shift, then reinterpret the result as signed int32.
      case ">>>":
        return i32(`((${l} & 4294967295) >> ${count})`);
    }
  }

  roundToScale(valueSql: string, scaleSql: string, resultType: "integer" | "float"): string {
    const rounded = `ROUND((${valueSql})::numeric, ${scaleSql})`;
    return resultType === "integer" ? rounded : `CAST(${rounded} AS DOUBLE PRECISION)`;
  }

  parseStringAsInteger(textSql: string): string {
    // Canonical form: `0`, or non-zero leading digit with optional
    // minus. Rejects leading zeros (`'01'`), the surface form `'-0'`
    // (which round-trips through `to_string` to `'0'`), and explicit
    // `+` signs. A 16-digit candidate always fits BIGINT, so the first
    // cast is safe; the outer check narrows it to the JS safe range.
    const candidate = `CAST((CASE WHEN ${textSql} ~ '^(0|-?[1-9][0-9]*)$'
      AND length(replace(${textSql}, '-', '')) <= 16
      THEN ${textSql} ELSE NULL END) AS BIGINT)`;
    return `(CASE WHEN ABS(${candidate}) <= 9007199254740991 THEN ${candidate} ELSE NULL END)`;
  }

  toJson(valueSql: string, valueType: PrimitiveType): string {
    // The `null` type has one value, so the answer is the jsonb null literal
    // and the operand need not be read at all. Emitting it is also the only
    // option: `to_jsonb` is polymorphic over `anyelement`, and a bare `NULL`
    // arrives untyped, which Postgres rejects with "could not determine
    // polymorphic type because input has type unknown".
    if (valueType === "null") return "'null'::jsonb";
    // `to_jsonb` accepts any other primitive type and produces the matching
    // jsonb leaf — the discriminator otherwise only matters on SQLite, where
    // text storage forces per-type emission.
    return `to_jsonb(${valueSql})`;
  }

  jsonArray(elements: ReadonlyArray<{ sql: string; type: PrimitiveType | undefined }>): string {
    // `jsonb_build_array` auto-lifts primitive arguments and passes
    // jsonb values through unchanged. SQL NULL becomes JSON null. A
    // non-finite float (Infinity / NaN, from arithmetic overflow such
    // as a chained `1e9 * 1e9 * ...`) would either raise on the cast
    // or produce a backend-specific jsonb leaf — diverging from the
    // native path that substitutes JSON null. Guard each float arg
    // with `isfinite` so the cross-backend output agrees.
    if (elements.length === 0) return "'[]'::jsonb";
    const args = elements.map((e) => (e.type === "float" ? finiteOrNull(e.sql) : e.sql));
    return `jsonb_build_array(${args.join(", ")})`;
  }

  jsonObject(
    entries: ReadonlyArray<{
      key: string;
      valueSql: string;
      valueType: PrimitiveType | undefined;
    }>,
  ): string {
    if (entries.length === 0) return "'{}'::jsonb";
    const args = entries
      .map((e) => {
        const value = e.valueType === "float" ? finiteOrNull(e.valueSql) : e.valueSql;
        return `'${e.key.replace(/'/g, "''")}', ${value}`;
      })
      .join(", ");
    return `jsonb_build_object(${args})`;
  }

  parseJson(textSql: string): string {
    // `pg_input_is_valid(text, 'jsonb')` (PG16+) checks parseability
    // without raising — the natural complement to `to_integer` / `to_float`'s
    // regex pre-check. Gate the cast on it so malformed input becomes
    // NULL rather than a query-aborting error.
    //
    // PostgreSQL jsonb can also represent two shapes Datamog deliberately
    // cannot observe as runtime `value`s: a JSON null leaf (which the
    // runtime collapses to SQL NULL) and numeric leaves that are valid
    // jsonb numerics but outside JavaScript's finite double range (e.g.
    // `9e999`, which native JSON.parse turns into Infinity and rejects).
    // Walk the parsed jsonb tree and reject those numeric leaves before
    // the value reaches result decoding or downstream value operators.
    //
    // JSONB canonicalises on storage, so accepted values behave like any
    // other jsonb: keys sorted, numbers normalised, structural equality
    // under `=`.
    return `(WITH RECURSIVE __datamog_parse_json(j) AS (
      SELECT CAST((CASE WHEN pg_input_is_valid(${textSql}, 'jsonb')
        THEN ${textSql} ELSE NULL END) AS jsonb)
    ),
    __datamog_json_walk(v) AS (
      SELECT j FROM __datamog_parse_json WHERE j IS NOT NULL
      UNION ALL
      SELECT child.value
      FROM __datamog_json_walk AS walk
      CROSS JOIN LATERAL (
        SELECT value FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(walk.v) = 'array' THEN walk.v ELSE '[]'::jsonb END
        )
        UNION ALL
        SELECT value FROM jsonb_each(
          CASE WHEN jsonb_typeof(walk.v) = 'object' THEN walk.v ELSE '{}'::jsonb END
        )
      ) AS child(value)
    )
    -- A top-level JSON null parses to the null value and is deliberately not
    -- excluded here, so parse_json of it derives a row carrying null (see §8).
    SELECT CASE WHEN j IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM __datamog_json_walk
        WHERE jsonb_typeof(v) = 'number'
          AND NOT pg_input_is_valid(v #>> '{}', 'double precision')
      )
      THEN j ELSE NULL END
    FROM __datamog_parse_json)`;
  }

  parseStringAsFloat(textSql: string): string {
    // Same shape as `parseStringAsInteger`: regex pre-check then cast.
    // Canonical form mirrors `to_string(float)`'s output: no leading
    // zeros on the integer part, no leading `+`. Trailing zeros in the
    // fraction are tolerated (`'1.0'`, `'1.50'`) since they don't
    // change the value. Negative zero is allowed only when paired with
    // a fraction (`-0.5`) — `-0` alone is rejected as non-canonical.
    //
    // A syntactically-valid decimal can still be too large for
    // `double precision`; `pg_input_is_valid` keeps that cast from
    // aborting the query and maps it to NULL like the native evaluator's
    // Number.isFinite gate.
    return `CAST((CASE WHEN ${textSql} ~ '^((0|-?[1-9][0-9]*)(\\.[0-9]+)?|-0\\.[0-9]+)$'
      AND pg_input_is_valid(${textSql}, 'double precision')
      THEN ${textSql} ELSE NULL END) AS DOUBLE PRECISION)`;
  }

  concat(argSql: string): string {
    // Explicit `ORDER BY` for deterministic per-group output across
    // backends. Without it the planner is free to enumerate group rows
    // in any order, which silently diverges from SQLite/sql.js and the
    // native evaluator. We sort by the original argument expression
    // before the `::TEXT` cast so numeric values keep their natural
    // (numeric, not lexicographic) order.
    //
    // `COALESCE` supplies concatenation's identity over an empty group, per §7,
    // as SQLite's arm does. Without it `STRING_AGG` returns NULL there, which
    // means undefined, and `concat` cannot be undefined, so nothing downstream
    // withholds the row and the column carries a NULL no other backend produces.
    return `COALESCE(STRING_AGG(${argSql}::TEXT, ',' ORDER BY ${argSql}), '')`;
  }

  integerSum(argSql: string): string {
    const value = `(${argSql})::numeric`;
    const positive = `SUM(CASE WHEN ${value} > 0 THEN ${value} ELSE 0 END)`;
    const negative = `SUM(CASE WHEN ${value} < 0 THEN -${value} ELSE 0 END)`;
    // Empty group first, so it yields 0 rather than NULL (§7); overflow still
    // yields NULL, meaning undefined. Only this order tells them apart (§9.4).
    return `(CASE WHEN COUNT(${argSql}) = 0 THEN 0
      WHEN ${positive} <= 9007199254740991
      AND ${negative} <= 9007199254740991
      THEN ${positive} - ${negative} ELSE NULL END)`;
  }

  jsonAgg(
    valueSql: string,
    argSql: string,
    argIsJson: boolean,
    argMayBeUndefined: boolean,
  ): string {
    // `JSONB_AGG` returns NULL on empty groups, matching the rest of
    // the SQL aggregate family. Sort key choice differs by argument
    // shape: jsonb arguments cast to text so structurally equal
    // values sort adjacently (jsonb's natural ordering is
    // type-tag-then-value, which would diverge from SQLite's
    // canonical-TEXT-storage ordering and from the native
    // `canonicalizeJson` sort). Force C collation on that text key so
    // non-BMP leaves match Datamog's portable string order. Primitive
    // arguments sort by the raw SQL value — numeric for numbers, lex
    // for strings — matching SQLite's default ORDER BY semantics and
    // the native comparator. The FILTER tests the *original* argument
    // so we skip rows that were SQL-NULL on input rather than rows whose
    // lifted form happens to be a JSON `null`, and it is emitted only where such
    // a NULL means undefined rather than the `null` value.
    //
    // A null element sorts first (§7), and this dialect has to ask for it twice.
    // A primitive null argument is a SQL NULL, which Postgres sorts last under
    // ASC, hence `NULLS FIRST`. A `value` null argument is a JSON null, not a SQL
    // NULL, so it sorts at the text `null` among the other leaves unless a
    // leading key lifts it out.
    const orderKey = argIsJson
      ? `(CASE WHEN jsonb_typeof(${argSql}) = 'null' THEN 0 ELSE 1 END), ${this.stringOrder(`(${argSql})::TEXT`)}`
      : argSql;
    const filter = argMayBeUndefined ? ` FILTER (WHERE ${argSql} IS NOT NULL)` : "";
    // `JSONB_AGG` returns NULL over an empty group, so coalesce to append's
    // identity, which is what §7 wants and what sqlite gives for free.
    return `COALESCE(JSONB_AGG(${valueSql} ORDER BY ${orderKey} NULLS FIRST)${filter}, '[]'::jsonb)`;
  }
}
