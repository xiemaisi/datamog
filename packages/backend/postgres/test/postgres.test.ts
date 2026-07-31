import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ExtDecl } from "datamog-core";
import {
  type Backend,
  DatamogExecutor,
  type ExtensionalLoader,
  type LoadResult,
  insertRows,
} from "datamog-engine";
import { create } from "../src/index.ts";

/**
 * Minimal loader that hands a pre-parsed JSON value to a single
 * value-typed predicate through the shared `insertRows` path. Lets a
 * test exercise the loader's INSERT (which binds canonical JSON text to a
 * JSONB column) without reaching for a file or the network.
 */
function valueLoader(predicate: string, value: unknown): ExtensionalLoader {
  return {
    name: "test-value",
    async canLoad(decl: ExtDecl): Promise<boolean> {
      return decl.predicate === predicate;
    },
    async load(decl: ExtDecl, backend: Backend): Promise<LoadResult> {
      const rows = [{ [decl.columns[0]!.name]: value }];
      await insertRows(backend, decl, rows);
      return { rowsLoaded: rows.length };
    },
  };
}

const HAS_DATABASE_URL = Boolean(process.env.DATABASE_URL);

// Gated on DATABASE_URL because these tests need a live Postgres server.
// The repo's devcontainer brings one up via docker-compose; outside that
// (vanilla checkout, CI without a service container) the suite skips.
// The schema is wiped before each test to keep them independent, and again
// after the last one so the suite leaves nothing behind — point DATABASE_URL
// only at a dedicated dev/test database.
describe.skipIf(!HAS_DATABASE_URL)("postgres backend (DATABASE_URL)", () => {
  let backend: Backend;

  /**
   * Drop every object in the schema. Unlike the in-memory backends, Postgres
   * keeps tables and views after the process exits, so a run has to both start
   * clean and leave clean: leftovers would otherwise collide with the next run
   * (`CREATE RECURSIVE VIEW` has no `OR REPLACE` form) and sit in the database
   * afterwards.
   */
  async function resetSchema(): Promise<void> {
    await Bun.sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await Bun.sql`CREATE SCHEMA public`;
  }

  beforeAll(async () => {
    backend = await create();
  });

  afterAll(async () => {
    // Before `close()`: the reset needs the connection.
    await resetSchema();
    await backend.close();
  });

  beforeEach(async () => {
    await resetSchema();
  });

  test("end-to-end: EDB facts + non-recursive IDB rule", async () => {
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      person("alice", 30).
      person("bob", 17).
      adult(N) :- person(N, A), A >= 18.
      ?- adult(N).
    `);
    expect(results[0]!.rows).toEqual([{ N: "alice" }]);
  });

  test("recursive IDB compiles to CREATE RECURSIVE VIEW and terminates", async () => {
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      edge(1, 2). edge(2, 3). edge(3, 4).
      reach(X, Y) :- edge(X, Y).
      reach(X, Z) :- edge(X, Y), reach(Y, Z).
      ?- reach(1, Z).
    `);
    const rows = [...results[0]!.rows].sort((a, b) => (a.Z as number) - (b.Z as number));
    expect(rows).toEqual([{ Z: 2 }, { Z: 3 }, { Z: 4 }]);
  });

  test("Regression: boolean-typed query columns coerce to true/false", async () => {
    // Mirrors the same-named test in engine/test/executor.test.ts. The
    // sqlite case exercises the executor's 0/1 → bool coercion pass;
    // Postgres returns native bool, so this confirms the coercion pass
    // is a no-op for an already-typed driver.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      flag("alice", true).
      flag("bob",   false).
      derived(N, B) :- flag(N, B).
      comparison(N, B) :- flag(N, _), B = (N == "alice").
      ?- derived(N, B).
      output predicate cmp(N, B) :- comparison(N, B).
    `);
    const sortByName = (rows: Record<string, unknown>[]) =>
      [...rows].sort((a, b) => (a.N as string).localeCompare(b.N as string));
    expect(sortByName(results[0]!.rows)).toEqual([
      { N: "alice", B: true },
      { N: "bob", B: false },
    ]);
    expect(sortByName(results[1]!.rows)).toEqual([
      { N: "alice", B: true },
      { N: "bob", B: false },
    ]);
  });

  test("`null` literal, `=`/`<>` (logical), `==`/`!=` (3VL)", async () => {
    // Cross-backend invariant from §5 of the spec: divide-by-zero
    // yields NULL, `=`/`<>` are NULL-aware (IS NOT DISTINCT FROM in
    // postgres), `==`/`!=` keep 3VL. Same shape as the SQLite version.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      t(0). t(1). t(2).
      maybe_null(X, Y, IsNull, EqEq) :-
        t(X),
        Y = 1 / X,
        IsNull = (Y = null),
        EqEq = (Y == null).

      filter_logical(X) :- t(X), Y = 1 / X, Y = null.
      filter_compute(X) :- t(X), Y = 1 / X, Y == null.
      neq_logical(X)    :- t(X), Y = 1 / X, Y <> null.
      ?- maybe_null(X, Y, IsNull, EqEq).
      output predicate fl(X) :- filter_logical(X).
      output predicate fc(X) :- filter_compute(X).
      output predicate nl(X) :- neq_logical(X).
    `);
    const sorted = (rows: Record<string, unknown>[]) =>
      [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(sorted(results[0]!.rows)).toEqual([
      { X: 0, Y: null, IsNull: true, EqEq: null },
      { X: 1, Y: 1, IsNull: false, EqEq: null },
      { X: 2, Y: 0, IsNull: false, EqEq: null },
    ]);
    expect(results[1]!.rows).toEqual([{ X: 0 }]);
    expect(results[2]!.rows).toEqual([]);
    expect(sorted(results[3]!.rows)).toEqual([{ X: 1 }, { X: 2 }]);
  });

  test("primitive conversions: parse string → integer / float / boolean (NULL on bad input)", async () => {
    // Pins the strict-canonical parsing rule on Postgres. The sqlite
    // backend exercises the same set via the example suite (which
    // requires cross-backend agreement) — this test confirms the
    // Postgres regex emit produces identical NULL-on-failure behaviour
    // when run against a float Postgres engine, where the regex
    // operator (`~`) and BIGINT/DOUBLE PRECISION casts come into play.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      raw_int("42").  raw_int("-7").  raw_int("0").
      raw_int("01").  raw_int("-0").  raw_int("1.5"). raw_int("bad").
      raw_float("3.14"). raw_float("-0.5"). raw_float("1.0"). raw_float("1").
      raw_float("01.5"). raw_float("1.").  raw_float("bad").
      raw_bool("true"). raw_bool("false"). raw_bool("True"). raw_bool("yes").
      pi(R, N) :- raw_int(R),  N = to_integer(R).
      pr(R, N) :- raw_float(R), N = to_float(R).
      pb(R, B) :- raw_bool(R), B = to_boolean(R).
      ?- pi(R, N). output predicate opr(R, N) :- pr(R, N). output predicate opb(R, B) :- pb(R, B).
    `);
    const sorted = (rows: Record<string, unknown>[]) =>
      [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(sorted(results[0]!.rows)).toEqual(
      sorted([
        { R: "42", N: 42 },
        { R: "-7", N: -7 },
        { R: "0", N: 0 },
        { R: "01", N: null },
        { R: "-0", N: null },
        { R: "1.5", N: null },
        { R: "bad", N: null },
      ]),
    );
    expect(sorted(results[1]!.rows)).toEqual(
      sorted([
        { R: "3.14", N: 3.14 },
        { R: "-0.5", N: -0.5 },
        { R: "1.0", N: 1 },
        { R: "1", N: 1 },
        { R: "01.5", N: null },
        { R: "1.", N: null },
        { R: "bad", N: null },
      ]),
    );
    expect(sorted(results[2]!.rows)).toEqual(
      sorted([
        { R: "true", B: true },
        { R: "false", B: false },
        { R: "True", B: null },
        { R: "yes", B: null },
      ]),
    );
  });

  test("to_float rejects out-of-range decimals without aborting the query", async () => {
    // Postgres checks the canonical decimal shape before casting, but a
    // syntactically-valid decimal can still be outside double
    // precision's range. A plain CAST would raise and abort the whole
    // query; it should instead produce NULL, matching the native
    // evaluator's finite-result gate.
    const huge = "9".repeat(400);
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      raw("${huge}").
      raw("1.5").
      parsed(R, N) :- raw(R), N = to_float(R).
      ?- parsed(R, N).
    `);
    const byInput = new Map(results[0]!.rows.map((r) => [r.R, r.N]));
    expect(byInput.get(huge)).toBe(null);
    expect(byInput.get("1.5")).toBe(1.5);
  });

  test("guarded conversions on literals do not abort the query", async () => {
    // Postgres may fold constant casts inside dead CASE branches during
    // planning, so guarded conversions must cast the CASE result rather
    // than casting only in the THEN branch. Literal bad inputs exercise
    // that plan-time path directly.
    const huge = "9".repeat(400);
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      r(I, F, J) :- I = to_integer("bad"), F = to_float("${huge}"), J = parse_json("not json").
      ?- r(I, F, J).
    `);
    expect(results[0]!.rows).toEqual([{ I: null, F: null, J: null }]);
  });

  test("math overflow guards do not abort the query", async () => {
    // Postgres raises on EXP / POWER overflow. The SQL emitter must
    // prove the result is in range before evaluating the function,
    // returning NULL for the same inputs that native maps to NULL.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      r(E, P) :- E = exp(1000.0), P = 10.0 ** 400.0.
      ?- r(E, P).
    `);
    expect(results[0]!.rows).toEqual([{ E: null, P: null }]);
  });

  test("primitive auto-lift round-trips through as_* on Postgres", async () => {
    // Primitive arguments to a `value`-typed slot lift via to_jsonb
    // (formerly the explicit `to_json` builtin). Round-tripping back
    // through `as_*` recovers the source primitive. We use array
    // literals to introduce values without depending on the
    // `numeric`/BIGINT-as-string Bun pg driver wrinkles that bite the
    // raw `vals(...)` projection.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      lifted(JR, JB, JS) :- JR = [2.5][0], JB = [true][0], JS = ["hello"][0].
      round_trip(R2, B2, S2) :-
        lifted(JR, JB, JS),
        R2 = as_float(JR), B2 = as_boolean(JB), S2 = as_string(JS).
      ?- round_trip(R2, B2, S2).
    `);
    expect(results[0]!.rows).toEqual([{ R2: 2.5, B2: true, S2: "hello" }]);
  });

  test("parse_json: valid JSON parses, malformed → NULL (no query abort)", async () => {
    // The Postgres dialect routes parse_json through
    // `pg_input_is_valid(text, 'jsonb')` to convert malformed input into
    // NULL. It also filters JSON null and non-finite numeric leaves after
    // parsing: jsonb accepts `null` and numerics like `9e999`, but native
    // and SQLite collapse those cases to SQL NULL per spec §2.9.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      raw("{\\"a\\":1,\\"b\\":2}").
      raw("[1,2,3]").
      raw("null").
      raw("9e999").
      raw("[1,9e999]").
      raw("not json").
      parsed(S, J) :- raw(S), J = parse_json(S).
      ?- parsed(S, J).
    `);
    const byInput = new Map(results[0]!.rows.map((r) => [r.S, r.J]));
    // jsonb canonicalises object keys, so the round-trip preserves
    // the parsed shape.
    expect(byInput.get('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
    expect(byInput.get("[1,2,3]")).toEqual([1, 2, 3]);
    expect(byInput.get("null")).toBe(null);
    expect(byInput.get("9e999")).toBe(null);
    expect(byInput.get("[1,9e999]")).toBe(null);
    expect(byInput.get("not json")).toBe(null);
  });

  test("Regression: JSON null leaves collapse after value extraction", async () => {
    // Postgres jsonb distinguishes JSON null from SQL NULL. Datamog's
    // runtime does not, so subscript/iteration/function-call boundaries
    // must collapse extracted JSON null leaves before downstream logic sees
    // them.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      data([null]).
      sub(V, IsNull, Kind, Encoded, Has) :-
        data(J),
        V = J[0],
        IsNull = (V = null),
        Kind = type_of(V),
        Encoded = to_json(V),
        Has = has_key(V, "x").
      iter(V, IsNull) :- data(J), array_element(J, 0, V), IsNull = (V = null).
      ?- sub(V, IsNull, Kind, Encoded, Has).
      output predicate oiter(V, IsNull) :- iter(V, IsNull).
    `);
    expect(results[0]!.rows).toEqual([
      { V: null, IsNull: true, Kind: null, Encoded: null, Has: null },
    ]);
    expect(results[1]!.rows).toEqual([{ V: null, IsNull: true }]);
  });

  test("to_json uses jsonb canonical object-key order", async () => {
    // Pins the backend order that canonical-TEXT backends mirror:
    // jsonb sorts object keys by UTF-8 byte length, then byte value.
    // The dialect strips jsonb's serializer whitespace, but leaves
    // that recursive key order intact.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      r(S) :- J = {"b": 2, "aa": 1, "a": 3}, S = to_json(J).
      ?- r(S).
    `);
    expect(results[0]!.rows).toEqual([{ S: '{"a":3,"b":2,"aa":1}' }]);
  });

  test("value aggregates sort canonical text with portable collation", async () => {
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      data(["😀"]).
      data(["￿"]).
      cat(concat(J)) :- data(J).
      vals(list(J)) :- data(J).
      ?- cat(C).
      output predicate ovals(L) :- vals(L).
    `);
    expect(results[0]!.rows).toEqual([{ C: '["￿"],["😀"]' }]);
    expect(results[1]!.rows).toEqual([{ L: [["￿"], ["😀"]] }]);
  });

  test("Regression: NULL subscript / slice indices propagate to NULL", async () => {
    // Pins the spec §5.4 NULL-propagation behaviour for the postgres
    // dialect's CASE-guarded SUBSTR. Vanilla Postgres SUBSTR with a
    // negative `for` argument errors; the translator's CASE both handles
    // negative bounds and now an explicit `IS NULL THEN NULL` branch.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      words("hello").
      sub(W, S)        :- words(W), I = 1 / 0, S = W[I].
      slice_start(W, S):- words(W), I = 1 / 0, S = W[I:3].
      slice_end(W, S)  :- words(W), J = 1 / 0, S = W[1:J].
      ?- sub(W, S).
      output predicate ss(W, S) :- slice_start(W, S).
      output predicate se(W, S) :- slice_end(W, S).
    `);
    expect(results[0]!.rows).toEqual([{ W: "hello", S: null }]);
    expect(results[1]!.rows).toEqual([{ W: "hello", S: null }]);
    expect(results[2]!.rows).toEqual([{ W: "hello", S: null }]);
  });

  test("Regression: loader-inserted value column is structured JSONB, not a string", async () => {
    // The loader binds the canonical JSON *text* of a value column. Without
    // the dialect's `::text::jsonb` placeholder cast, Bun's pg driver stores
    // that text as a JSONB *string scalar*, so `jsonb_typeof` is 'string'
    // and `array_element` / `object_entry` see no array/object and yield
    // nothing — silently breaking every JSON-loader-driven program on
    // Postgres (e.g. the pokedex tutorial). This pins the parsed-array shape.
    const loader = valueLoader("doc", [
      { id: 1, name: "ok" },
      { id: 2, name: "two" },
    ]);
    const executor = new DatamogExecutor(backend, [loader]);
    const results = await executor.execute(`
      input predicate doc(data: value).
      shape(T, N) :- doc(D), T = type_of(D), N = length(D).
      item(Name) :-
        doc(D),
        array_element(D, _, P),
        Name = as_string(P["name"]).
      ?- shape(T, N).
      output predicate oitem(Name) :- item(Name).
    `);
    // Before the fix: T = 'string', N = the text length, item = no rows.
    expect(results[0]!.rows).toEqual([{ T: "array", N: 2 }]);
    const names = [...results[1]!.rows].map((r) => r.Name).sort();
    expect(names).toEqual(["ok", "two"]);
  });
});
