# Bug Hunting in Datamog

Project-specific investigation techniques, reusable helpers, and historical bug
patterns for developers and coding agents. No personal tools or configuration
are required. Read [DEVELOPMENT.md](../DEVELOPMENT.md) for setup and testing and
[the language specification](spec.md) for current semantics.

Commit references below describe historical fixes, not outstanding bugs. Old SQL
shapes and helper names explain what to look for; verify them against current
code before applying a remedy. Paths in code spans are repository-relative.
Run the shell examples from the repository root.

## Project shape (relevant to bug yield)

Datamog is a Datalog → SQL translator with **five backends sharing one spec** (`packages/backend/{postgres,sqlite,sqljs,native,seminaive}`). Most behaviour bugs are **cross-backend parity violations**: one backend disagrees with another on the same input, or with the documented runtime in `doc/spec.md` (allowing its explicit backend limitations). Cross-backend parity is the highest-yield lens; treat it as the default starting point for any new round.

The native evaluator (`packages/backend/native/src/values.ts`, `planner.ts`) is a useful comparison implementation. The language specification defines the intended behavior; a disagreement can be a bug in either backend, or both.

## Investigation patterns and historical fixes

### 1. Cross-backend operator parity on edge inputs

For each runtime operator / built-in, walk the matrix `<spec promise> × <native impl> × <SQL emission> × <per-dialect override>`. Investigate divergences against the current spec and its documented limitations. Edge inputs that have repeatedly surfaced bugs:

- **Negative integer subscript / slice bounds** on a `value` — native short-circuits to NULL or `[]`; SQL backends without explicit guards either throw (SQLite) or return wrong values (Postgres `jsonb -> -1` returns the last element). Fixed for `value` subscript (`9923b86`) and `value` slice (`c5fe5dd`); the string-subscript path was already guarded.
- **Aggregates on non-orderable / non-canonical types**: `min`/`max` on boolean or `value` (rejected at analyze time, `121a826`); `concat` on boolean (SQL emit wraps in CASE, `552abe9`) or `value` (native uses `canonicalizeJson` instead of `String(v)`, `4c9208d`).
- **NULL receiver on slice / subscript** — both dialects' WHERE-based `value` slice unfolds NULL into `[]`; needs explicit IS-NULL guard. Fixed in `caaa041`.
- **Object-keyed `value` subscript with special characters** — SQLite path `'$.' || key` mis-parses dotted keys as nested access. Use `'$."' || key || '"'` (`9b76196`).
- **`value`-literal construction at compile time without semantic canonicalisation** — SQLite's `json_object(k1, v1, k2, v2, ...)` preserves argument order in its TEXT output, so two object literals that differ only in source key order failed dedup, joins, and `=` on SQLite/sql.js while unifying on native (uses `canonicalizeJson`) and Postgres (jsonb canonicalises on storage). The historical fix sorted entries lexicographically; current canonical ordering is UTF-8 byte length first, then byte value (§2.9). Check ordering in the dialect's `jsonObject` before emitting (`dcd92d9`). The same constructor drift showed up for duplicate object keys: native object construction and Postgres jsonb use last-write-wins, while SQLite preserves duplicate textual entries (`{"a":1,"a":2}`), making the decoded value and `to_json` disagree. Collapse duplicates before emitting (`5528e75`). The current spec §2.9 also requires canonical key ordering for `parse_json`; check parsed and literal construction paths together.
- **Postgres `jsonb::TEXT` re-serialiser inserts whitespace** — `'{"a":1}'::jsonb::text` returns `{"a": 1}` (with a space). Anywhere a jsonb value is converted to text and then surfaced (or compared, or concatenated) the result diverges from SQLite's canonical-TEXT storage and from native `canonicalizeJson`. Sites: `concat(value)` was emitting `STRING_AGG(jsonb::TEXT, ...)` directly, producing `{"a": 1},{"b": 2}` on Postgres vs `{"a":1},{"b":2}` everywhere else (`628407d`). The fix routes value args through `dialect.jsonStringify` first (the same regex-strip used by `to_json`). When auditing a new aggregate / display path that touches a value column on Postgres, ask whether the path goes through `::text` or `to_text()` *without* `regexp_replace`; if so it's the same shape. The existing `jsonAgg` ORDER BY uses `::TEXT` for sort-key only (output is jsonb), and the spaces don't change pairwise sort ordering, so that site is fine — but the rule of thumb is "if the `::text` value reaches the user or a string-typed column, wrap it".
- **JSON null vs SQL NULL boundaries** — audit `parseJson`, `jsonSubscript`, `jsonIterate`, `jsonTypeOf`, `jsonStringify`, `jsonHasKey`, and constructor/aggregate lifts together. The old collapse of JSON null into SQL NULL (`2d7157a`) is superseded: JSON null is now a value, while SQL NULL in a `value` expression represents undefinedness. Missing keys must withhold rows; present null-valued keys must survive (spec §§2.9, 5.4).
- **Primitive-to-`value` embedding must scrub floats in every constructor / aggregate** — value literals guarded float elements, but `list(float)` lifted through `dialect.toJson` directly, so overflow/NaN produced backend-specific JSON leaves instead of Datamog `null` (`d2b17fd`). Whenever a primitive typed expression crosses into `value`, check literals, `to_json`, aggregate `list`, direct inserts, and SQL dialect hooks together. Float paths need `finiteOrNull` / `scrubNonFiniteForJson`; integer paths need the portable bounds used by loaders and `as_integer.value`.
- **SQLite lexical `json_type` gates assume canonicalisation, but float literals lifted to `value` arrive as `'real'` text** — SQLite's `jsonAsInteger` gated on `json_type = 'integer'`, on the assumption that JSON integers are always lexically integer-form after canonicalisation. But a primitive float lifted into a value goes through `primitiveToJsonSql` = `CAST(3.0 AS TEXT)` = "3.0" (json_type `'real'`), bypassing canonicalisation, so `as_integer(3.0)` returned NULL on SQLite/sql.js while native / seminaive / Postgres all return 3 (spec §2.9: an integer-valued numeric leaf yields the integer). Fix relaxed the gate to `IN ('integer', 'real')` with a `CAST(... AS REAL) = CAST(... AS INTEGER)` integer-valued guard (`ed46a4a`). The sibling `jsonAsFloat` already used `IN ('integer','real')`, so it was the lone instance. When auditing any SQLite dialect hook that gates on `json_type = 'integer'` / `= 'real'`, ask whether a float-literal-lifted or `parse_json`-sourced value (neither canonicalised lexically) reaches it with the "wrong" lexical type. Empirically diff native vs sqlite for the integer-valued-float input.

When you fix one edge-case parity bug, **immediately search for parallel sites with `rg`** — the slice fix follows the subscript fix, the boolean `concat` fix surfaces the `value` `concat` fix.

### 2. Loader-side validation drift from native `as_*.value`

Compare the native `as_*.value` builtins (`packages/backend/native/src/values.ts`) with `coerceValue` and `checkValue` in `packages/engine/src/loader.ts`. Check each against its specified conversion and ingestion contract; they need not share an implementation. Drift has been found three times: integer (`isInteger` → `isSafeInteger`, `f7f67e8`), float (`typeof === "number"` → `Number.isFinite`, `6543cf6`), value (no validation → `isJsonValue` rejects non-finite numbers, `bb612e9`). When auditing a new validator, paste both implementations side by side.

(Pre-rename, the type was called `json` and the keys were `as_*.json` — same vein, different names. Commit 654be07 renamed.)

The same shape extends to **input parsing** — anywhere a string parses to a typed value (CSV cells, JSONL primitives, range bounds, source-code numeric literals), confirm the parser is at least as strict as the native runtime that consumes the value. For string-based loaders, "strict" means Datamog's canonical numeric surface forms, not merely "JS can parse it": reject leading-zero forms (`01`, `01.5`), surface `-0`, exponent forms (`1e3`), and integers outside the current safe-integer range (see the specification’s input type-checking rules). The former 9-digit ingestion limit (`55b5c87`) is historical.

The same shape also applies to **direct API ingestion**. `insertRows` bypasses file loaders, so typed `value` cells and stringified JSON cells must still be validated with `isJsonValue` before `canonicalizeJson`. Direct inserts of `"9e999"` / `Infinity` used to silently canonicalise to JSON `null` (`c5e2df4`). The fact that CSV / JSONL loaders are strict does not protect programmatic ingestion surfaces.

### 3. `String(v)` where `v` could be a `value`

Renders `"[object Object]"` to users. Found four times in this codebase: CLI CSV (`06f116a`), Mermaid output (`0aa672a`), playground `ResultsPanel`, playground step-debugger `formatValue` (`ed69d58`). Three sibling helpers now cover the surfaces:

- `packages/cli/src/output.ts::formatCellAsString` — CLI CSV
- `packages/engine/src/mermaid-output.ts::cellToString` — Mermaid edge cells
- `packages/playground/src/lib/format-cell.ts::formatCell` — playground tables / step-debugger

When a future surface needs to display row cells, route through one of these (or add a parallel helper). Grep for `String(row[` / `String(val)` / `String(v)` / template-literal interpolation of cell values whenever the project introduces a new display path.

### 4. Source-prefix uniformity in error messages

User-facing parse / load errors should be prefixed with `<source> line N: ...` (or `<source>: ...` for whole-file errors). Found drift in mermaid loader (`f7f67e8`) and gsheet public CSV BOM handling (`ea60cc9`). When auditing a new loader's error path, compare with `parseJsonlContent` (`packages/loader/jsonl/src/parse-content.ts`) which has the canonical wording.

### 5. `ParseError` / `AnalyzerError` carry positions; bare `Error` doesn't

The playground worker and VS Code validator only extract `offset` / `end` from `ParseError` and `AnalyzerError` instances. A `throw new Error(...)` in a user-facing pipeline loses the squiggly position. Found in `postProcess`'s empty-bracket path (`184023b`). When auditing a `throw new Error(...)` site, ask whether the playground would surface this and whether the offending term has a CST node available.

### 6. VS Code validator vs playground linter parity

Two surfaces run the same analysis pipeline; one might omit a step. Found two drifts: post-process diagnostic position not routed through `findNodeAtOffset`, and `findInfiniteRisks` warnings not surfaced (`bc10785`). Whenever the playground worker (`packages/playground/src/worker/executor.ts`) gains a new lint output (`recursiveCalls`, `predicateReferences`, finiteness warnings), check whether the VS Code validator (`packages/vscode-extension/src/datamog-validator.ts`) emits the equivalent.

### 7. Surface drift when the grammar gains a new token

When `packages/parser/src/datamog.langium` gains a new keyword, operator, or delimiter, three downstream "surface" files need to be updated in lock-step or the editor experience drifts:

- `packages/playground/src/lib/highlight.ts` — CodeMirror StreamLanguage tokeniser. The unhandled-character tail (`stream.next(); return null`) silently swallows new tokens and CodeMirror's bracket-matching plugin can't pair them.
- `packages/vscode-extension/syntaxes/datamog.tmLanguage.json` — TextMate grammar. New operators/punctuation that aren't in the `operator` regex render with the default editor color.
- `packages/vscode-extension/language-configuration.json` — `brackets` / `autoClosingPairs` / `surroundingPairs`. New paired delimiters won't auto-close or bracket-match.

Found three together for the new `{` `}` ObjectLiteral delimiters (`3c4d755`); also `mod` keyword removal / `#` comment marker in `af29118` touched the same three surfaces. When auditing a new grammar token, walk all three surfaces explicitly. The playground highlighter is now unit-testable via `datamogToken` (exported from `highlight.ts`) — drive it with a `StringStream` for a focused regression test.

### 8. Explicit user mappings must fail closed

CLI/config mappings from user-written names to declared program entities should reject every ambiguous or unresolved key before execution. `--extensional p=a.csv --extensional p=b.csv` used to silently keep the first loader and ignore the second (`d973cb5`), and `--extensional typo=data.csv` used to match no extensional declaration at all, leaving the EDB empty while the command exited successfully (`11c4b3b`). Future mapping surfaces should validate duplicate names, empty names, unknown names, unsupported sources, and "override" semantics explicitly; otherwise a typo is indistinguishable from a legitimate empty result.

### 9. Native backend lifecycle around `insertRows`

The native and seminaive backends are stateful wrappers around an evaluator, and direct `insertRows` has three distinct phases: before the first `execute`, during loader ingestion inside `execute`, and after a completed run. The after-run case regressed because inserts appended to a stale evaluator instance and were lost on the next execution (`d18f58b`). Any change to evaluator lifecycle, loader orchestration, or backend reuse should test all three phases, plus repeated `execute()` on a single backend instance. SQL backends naturally persist EDB rows in tables; native backends need explicit buffering to match that behavior.

### 10. Quoted identifiers (`QUOTED_IDENT`) put arbitrary chars into SQL identifiers and string literals

Backtick-quoted predicate / column / variable names (grammar terminal `QUOTED_IDENT`, `` /`(\\.|[^`\\\n\r])+`/ ``) permit characters that break naive SQL string-building — most importantly a single quote (`` `o'brien` ``, `` `it's` ``). Two distinct failure modes surfaced together (`b28b6ed`):
- **`stripSpanMarks` (`packages/engine/src/translator.ts`) only tracked single-quoted *string* state** when removing its U+0001/U+0002 span markers. A `'` inside a double-quoted *identifier* (`"it's"` — how every SQL backend emits the name) flipped `inString` and desynced the stripper, leaking raw control chars to SQLite/sql.js ("unrecognized token"). ANY program with a single-quoted-name predicate/column used in a rule crashed all SQL backends while native ran fine. Fix taught the stripper about double-quoted identifiers (`""` escape). When auditing any SQL state-machine that scans emitted SQL (marker stripping, `findTopLevelFrom`, span tracking), confirm it accounts for BOTH `'...'` strings and `"..."` identifiers, since a quoted name can carry the other delimiter.
- **Predicate names emitted as SQL string literals** (the SQLite combined-CTE `__tag` discriminator, `'<predicate>' AS __tag` and `WHERE __tag = '<predicate>'`, plus the translator's tag conditions) weren't escaped, so `p'q` produced the broken literal `'p'q'`. Fix applied `'` -> `''` at all five sites. This is the "unused safe primitive" pattern — the escape was already used for string-literal *values* (`translator.ts` ~972) and object keys (`dialect.ts` ~601) but not for name-as-literal sites. When auditing SQL emission, grep for `'${...name/predicate/tag/key...}'` template literals that DON'T go through `.replace(/'/g, "''")`; error-message strings (`throw new Error(\`...'${predicate}'...\`)`) are fine, only SQL-bound literals matter.

### 11. Query-body validation is a near-duplicate of rule-body validation and drifts

`inferTypes` in `packages/core/src/types.ts` validates rule bodies and query (`?-`) bodies with two SEPARATE but near-identical `switch (elem.$type)` loops (`Literal` / `Equality` / `Filter` / `RangeAtom`). They drift: the query-body `Equality` case once omitted the `checkComparableTypes` call the rule case makes, and the query-body `Filter` case carried an extra `&& t !== "value"` exemption the rule case lacks — so a `?-` query was accepted where the equivalent rule was rejected (`2170d1a`). When auditing any per-element validation, diff the query loop against the rule loop case-by-case; the same `analyze`/`inferTypes` logic should accept/reject a body element identically whether it sits in a rule or a query. The general shape (two parallel implementations of the same thing drifting apart) recurs across this codebase's near-duplicate paths: rule-vs-query (analyzer, translator SQL emission, native projection), the loader trio (`directory-loader` / vscode `disk-loader` / playground in-memory), and the VS Code validator vs playground worker (vein 6). To test: construct the same construct in both halves and confirm identical accept/reject (use `inferTypes(analyze(parse(src)))`, NOT `analyze()` alone — type checks live in `inferTypes`).

### 12. Parsers that "skip rather than corrupt" must apply that rule to every malformed shape

The mermaid parser (`packages/loader/mermaid/src/mermaid-parser.ts`) deliberately drops edges whose node id can't be cleanly extracted (e.g. `[orphan]` with no id prefix) — its `extractNodeId` returns `""` precisely so a bogus id "would [not] silently corrupt downstream joins". But the same parser fed an unsupported `&` fan-out token (`A & B --> C`) straight through and emitted the literal node id `"A & B"` — exactly the corruption the orphan guard avoids (`cbc9637`). When a parser/loader has an explicit "skip/reject rather than emit a corrupt value" principle, audit *every* unsupported/malformed input shape against it: an out-of-subset construct should be rejected consistently, not silently turned into a junk id/value that fails to join. The fix is small (detect the unsupported operator outside brackets, drop the line); preserve the legitimate in-bracket/in-label occurrences (`A[x & y]`, `A -->|a & b| C`). Loader subset limitations like this are best documented in the loader README too, so dropped input isn't a surprise.

### 13. Field-presence checks on parsed user objects must use `Object.hasOwn`, not `in`

Loaders that validate a declared column is present in a parsed data object used `col.name in obj`, which walks the prototype chain. `JSON.parse` and csv-parse produce objects backed by `Object.prototype`, so a column declared with a name like `toString` / `valueOf` / `constructor` / `hasOwnProperty` matched the *inherited* member even when the data lacked the key. On CSV the missing-field error was bypassed and the column was silently dropped from the row (the inherited function is omitted by `JSON.stringify`); on JSONL it surfaced a confusing "got function" type error instead of "missing field"; a `__proto__`-named column would silently bind the prototype object. Fixed in `csvRowsFromKeyed` and the JSONL object branch (`ed46a4a`). The CsvLoader and playground csv-loader happen to pre-guard with `header.includes(col.name)` (array membership, safe), but the gsheet and vscode disk loaders pass records straight to `csvRowsFromKeyed`, so the shared primitive had to be correct standalone. When auditing any presence/absence check on a `JSON.parse` / csv-parse / user-supplied object, prefer `Object.hasOwn(obj, key)` over `key in obj` and over `obj[key] === undefined` (the inherited function is not `undefined`). This is the CodeQL `js/prototype-polluting-assignment` / `hasOwnProperty`-shadowing shape.

### 14. `output predicate` synthesis is a hand-rolled parallel of the `?-` query path and drifts from it

The `output predicate` feature (`analyze()` in `packages/core/src/analyzer.ts`, ~lines 255-305) turns a marked rule into a synthetic query pushed onto `analyzed.queries` with `outputName = predicate`; a `?-` query is the "default" output (`outputName = "default"`). This synthesis is NOT the real query path — it hand-builds the projection variables and the body atom, so it drifts from what an equivalent hand-written `?- p(V1..Vn)` produces. Three drift bugs landed in one session (`3037cde`, `cd03bfe`): the synthesis named an *injected* proof column `colN` (a real name) so it leaked into the output, where a `?- p(N)` query binds it to a `$anon` synthetic name that `queryProjection` drops (spec §8.3); and `output predicate default` (a rule literally named `default`) was treated inconsistently across three sites that special-case the *string* `"default"` — the analyzer's one-default enforcement (correct), the REPL dedup gate (`incremental.ts`, re-emitted it every chunk), and the CLI's parse-scan availability check (`main.ts`, reported "no default output"). When auditing anything output-related: (a) confirm a synthesised output query behaves identically to the hand-written `?- p(V1..Vn)` it stands for — same projected columns, same hidden synthetics, same accept/reject — by running both forms through `runBoth` (both backends) and diffing; (b) grep for `"default"` string comparisons (`=== "default"` / `!== "default"`) and check every site agrees on whether an `output predicate default` rule counts as the default. The distinguishing fact the REPL needs (transient `?-` vs persistent output rule) now lives on the `Query.isOutput` marker, not the name string.

### 15. SQL-codegen shape bugs: set-vs-bag, receiver duplication, storage-vs-runtime gates

A cluster of high-yield cross-backend bugs (vein 1) live in how `translator.ts` and the `SqlDialect`s emit SQL, not in operator math. Three shapes recurred in one round (`782995d`, `e4892b8`):

- **Set-vs-bag**: `translateViews` dedups multi-rule IDB views via `UNION`, but a single-rule non-recursive view was a lone `SELECT` (a bag). A rule that projects away a body variable then held duplicates, so an aggregate reading it over-counted on the SQL backends while the interpreters (which dedup IDB tuples) gave the set. Whenever SQL relies on `UNION`/`DISTINCT` for set semantics, check the degenerate single-branch path. The `?-` query projection applies `DISTINCT` (so a plain query hides the bug); it surfaces when a projecting IDB feeds an aggregate.
- **Receiver duplication**: `SqliteSqlDialect.jsonSubscript`/`jsonSlice` re-embedded the receiver expression several times (the type guard + the extraction), so chained `V["a"]["b"]` / `V[0][0]` grew the SQL exponentially and overflowed SQLite's parser. Postgres referenced it once and was fine. When a dialect hook takes a sub-expression it must reference it a bounded number of times (route through one `json_each(receiver)`, or bind it once via `(SELECT ${receiver} AS v)`); grep every `${receiverSql}` / `${...Sql}` that appears 2+ times in one emitted string.
- **`to_json`/`jsonStringify` numeric affinity**: SQLite stores `value`s as canonical TEXT, but a numeric scalar leaf keeps numeric affinity, so the identity `jsonStringify` returned a number where a `string` was promised, breaking dedup/join/equality. `CAST(... AS TEXT)` at the value->text boundary.
- **Storage-vs-runtime gate drift** (a vein-2 instance): historical loaders disagreed over int4 versus safe-integer limits. The current integer input contract uses the safe-integer range. Compare every ingestion path against that contract, including the actual SQL column type, rather than reinstating the old 9-digit limit.

To hunt: run the same program on sqlite AND native (the `executeOnSqliteAndNative` helper in `packages/engine/test/executor.test.ts`) over projecting IDBs feeding aggregates, chained/nested `value` access, `to_json`/`concat` of numeric-leaf values, and integer-boundary inputs per format.

## Safe primitives (look for unused sites)

- **`lazyAsync`** (`packages/playground/src/lib/lazy.ts`) — wraps a Promise loader so a transient rejection is not cached forever. Migrate any hand-rolled `let xPromise = null; if (!xPromise) ...` lazy singleton in the playground.
- **`canonicalizeJson`** (`packages/engine/src/json-canonical.ts`) — orders object keys by UTF-8 byte length, then byte value, before stringifying (spec §2.9). Use anywhere a JSON value becomes a Set/Map key, dedup token, or comparison string. Drifts here cause cross-backend join / dedup / aggregate divergences. For compound row keys, canonicalise **every cell** before the outer row stringify — not only object / array cells — or a JSON string leaf like `"[1]"` can collide with the array `[1]` (`5948f22`).
- **`isJsonValue`** (`packages/engine/src/loader.ts`) — recursive type guard that rejects non-finite numbers. Mirror its shape for any new json-validating path.
- **`scrubNonFiniteForJson`** (`packages/backend/native/src/values.ts`) — native helper that replaces non-finite numeric leaves with `null` when typed primitive values are embedded into `value` containers. SQL emission has parallel `finiteOrNull` / `finiteFloatOrNullSql` guards. Use this shape for any new aggregate or constructor that lifts floats into `value` (`d2b17fd`).
- **`AnalyzerError(msg, offset, end)`** — always prefer the 3-arg form when a CST node is available; the playground squiggly defaults to byte 0 otherwise.
- **`ParseError`** (`packages/parser/src/parse-error.ts`) — extracted to a separate module specifically so `postProcess` can throw it without circular imports. Mirror this if another producer needs to throw a position-bearing parse error.
- **`coerceValue`** (`packages/engine/src/loader.ts`) — canonical string-to-Datamog-value coercion for CSV / Google Sheets / CSV-shaped sources. Use this instead of raw `Number(...)`, `parseInt`, Boolean truthiness, or ad-hoc JSON parsing so string loaders reject the same non-canonical and non-representable inputs.
- **`csvRowsFromKeyed`** (`packages/loader/csv/src/parse-content.ts`) — uniform "missing field 'X'" wording with line-number tracking. Use for any new CSV-shaped ingestion path.
- **`formatCell` / `formatCellAsString` / `cellToString`** — display helpers for `value` cells (see vein 3).
- **`bigintSafeReplacer`** (`packages/engine/src/json-canonical.ts`, re-exported from `cli/src/output.ts`) — `JSON.stringify` replacer that survives BigInt cells (Postgres BIGINT via `Bun.sql`). Bare `JSON.stringify(value)` throws `cannot serialize BigInt` outright on a BigInt cell. Used by CLI CSV/JSONL (`formatCellAsString`), Mermaid output (`cellToString`), playground tables (`formatCell`), playground JSON view (`JsonView`), playground table row keys (`results-panel.tsx`), and step-debugger tuple keys (`trace-state.ts`). When auditing a new path that calls `JSON.stringify(row)` / `JSON.stringify(row.col)` over a value that could carry a BIGINT cell, route through the replacer.

## Empirical setup pattern

Use a small reproduction to check a suspected bug. This example catches the expected validation error:

```bash
cat <<'EOF' | bun run -
import { coerceValue } from "./packages/engine/src/loader.ts";
try {
  console.log(coerceValue("9007199254740993", "integer"));
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
EOF
```

Record the actual output and compare it with the expected behavior. For cross-backend parity claims, instantiate two backends in the same script and diff their outputs:

```bash
cat <<'EOF' | bun run -
import { create as createSqlite } from "./packages/backend/sqlite/src/index.ts";
import { create as createNative } from "./packages/backend/native/src/index.ts";
import { DatamogExecutor } from "./packages/engine/src/executor.ts";
const source = 'p(X) :- X = type_of(parse_json("null")). ?- p(X).';
for (const [name, create] of [["sqlite", createSqlite], ["native", createNative]] as const) {
  const backend = await create();
  try {
    console.log(name, JSON.stringify(await new DatamogExecutor(backend).execute(source)));
  } finally {
    await backend.close();
  }
}
EOF
```

Matching outputs rule out a divergence for that input, but both backends can still violate the specification. Compare results as sets when row order is unspecified.

## Current limitations and superseded caveats

- **`to_string(float)` of an integer-valued float** — `"1"` versus `"1.0"` is a documented display variance (spec §2.6). Do not generalize that exception to JSON equality, joins, or deduplication: §2.9 requires canonical values. Reproduce those differences separately and check the current contract.
- **Historical `parse_json` key-order variance is superseded.** Spec §2.9 now requires parsed keys to use the same canonical ordering as loaded and constructed values, including nested objects. A key-order difference that breaks joins or deduplication is worth investigating.
- **String subscript out-of-range returning `""`** — explicitly specified in §§2.6 and 5.4. A missing `value` subscript instead has no value and withholds its row.
- **Backend persistence between executions** — reuse can intentionally preserve input data. Check the caller’s lifecycle and the direct `insertRows` contract (pattern 9) before calling persistence a leak; use fresh backends for independent reproductions.
- **Defensive bounds checks (`start >= 0`) in CodeMirror decoration filters** — only triggered if the linter emits invalid spans, which would itself be a bug upstream. Not worth fixing in isolation.
- **Strings with an embedded NUL (`U+0000`) diverging on `length`/subscript/slice** — reachable via `parse_json("\"\\u0000\"")`. Native/seminaive count code points; SQLite/sql.js `LENGTH`/`SUBSTR` stop at the NUL (C-string terminator); PostgreSQL `text`/`jsonb` cannot store `U+0000` at all, so three-backend parity is unreachable. Documented as a non-portable-input limitation in `doc/spec.md` §2.6 (the subscript/slice "Cross-backend variance" note), This is a documented input limitation, not a new parity regression.
- **Historical deep `parse_json` chain limits** — at the time of `e4892b8`, `parse_json` emitted a large recursive-CTE / nested-CASE SQL that already sits near SQLite's parser stack limit, so a chain like `parse_json(s)[0][1:3]` can still overflow even after the receiver-duplication fix (`e4892b8`) made subscript/slice grow linearly. Chains on ordinary receivers (value columns, object/array literals) work to a much greater depth. Reducing `parse_json`'s own SQL depth is a separate, larger change; reproduce against current code before reporting it as a new receiver-duplication bug.
- **Historical `parse_json("null")` collapse is superseded.** It produces a JSON null value; `type_of(parse_json("null"))` returns `"null"`. A missing key or invalid parse is undefined. Do not restore the former collapse of these cases.

## Stop-condition note

In a historical investigation, three bugs surfaced in a tight cluster (rounds 18-20) *after* two zero-bug rounds. The pattern was "same `String(v)` shape in another file". When you find a fix worth sweeping, the consecutive-zero counter should reset — the signal is "no fresh shapes worth sweeping", not "the round counter said zero".
