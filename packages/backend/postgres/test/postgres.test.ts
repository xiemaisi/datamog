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
      comparison(N, B) :- flag(N, _), B = (N = "alice").
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

  test("Regression: a bare `null` reaching a typed slot is cast, not left unknown", async () => {
    // Postgres types a bare `NULL` as `unknown` and then refuses to resolve
    // anything polymorphic against it, where the SQLite family is dynamically
    // typed and does not care. Two places have to cast, and both are only
    // reachable now that `null` is a value with a type of its own:
    //
    // - a `null`-typed view column, or `SELECT DISTINCT` from the view fails
    //   with "could not determine polymorphic type because input has type
    //   unknown";
    // - the lift into a `value` slot, where `to_jsonb(anyelement)` fails the
    //   same way, so the dialect emits the jsonb null literal instead.
    //
    // What the query returns matters less here than that it runs at all: a
    // missing cast raises rather than returning the wrong rows.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      lit(X) :- X = null.
      lifted(J) :- J = to_json(null).
      i(X) :- X = as_integer(null).
      s(X) :- X = as_string(null).
      ?- lit(X).
      output predicate ol(J) :- lifted(J).
      output predicate oi(X) :- i(X).
      output predicate os(X) :- s(X).
    `);
    expect(results[0]!.rows).toEqual([{ X: null }]);
    expect(results[1]!.rows).toEqual([{ J: "null" }]);
    // `as_integer` of a null has no value, so these derive nothing.
    expect(results[2]!.rows).toEqual([]);
    expect(results[3]!.rows).toEqual([]);
  });

  test("`null` literal, null-aware `=` / `<>`, and strict ordering", async () => {
    // Cross-backend invariant from §5.4 of the spec: `=`/`<>` are null-aware
    // (IS NOT DISTINCT FROM on Postgres) and the orderings are strict at null.
    // Same shape as the SQLite version, including where the nulls come from: the
    // literal, not `1 / X`, which now has no value rather than a null one, so its
    // row is withheld. These facts are what `Y = 1 / X` used to yield for
    // `{0, 1, 2}`.
    //
    // A strict ordering is Postgres's own behaviour, so the emit here is the bare
    // operator; the wrappers that made it total are gone from every dialect.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      t(0, null). t(1, 1). t(2, 0).
      maybe_null(X, Y, IsNull) :- t(X, Y), IsNull = (Y = null).
      ordered(X, Below, AtMost) :- t(X, Y), Below = (Y < 1), AtMost = (Y <= Y).
      filter_logical(X) :- t(X, Y), Y = null.
      neq_logical(X)    :- t(X, Y), Y <> null.
      not_below(X)      :- t(X, Y), not (Y < 1).
      ?- maybe_null(X, Y, IsNull).
      output predicate od(X, Below, AtMost) :- ordered(X, Below, AtMost).
      output predicate fl(X) :- filter_logical(X).
      output predicate nl(X) :- neq_logical(X).
      output predicate nb(X) :- not_below(X).
    `);
    const sorted = (rows: Record<string, unknown>[]) =>
      [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(sorted(results[0]!.rows)).toEqual([
      { X: 0, Y: null, IsNull: true },
      { X: 1, Y: 1, IsNull: false },
      { X: 2, Y: 0, IsNull: false },
    ]);
    // No X=0 row: an ordering over its null has no value to bind.
    expect(sorted(results[1]!.rows)).toEqual([
      { X: 1, Below: false, AtMost: true },
      { X: 2, Below: true, AtMost: true },
    ]);
    expect(results[2]!.rows).toEqual([{ X: 0 }]);
    expect(sorted(results[3]!.rows)).toEqual([{ X: 1 }, { X: 2 }]);
    // Condition position is unchanged, which is the point of §4.1: the ordering
    // fails to hold at the null either way, so `not` holds there either way.
    expect(sorted(results[4]!.rows)).toEqual([{ X: 0 }, { X: 1 }]);
  });

  test("primitive conversions: parse string → integer / float / boolean (no row on bad input)", async () => {
    // Pins the strict-canonical parsing rule on Postgres. The sqlite
    // backend exercises the same set via the example suite (which
    // requires cross-backend agreement) — this test confirms the
    // Postgres regex emit produces identical behaviour when run against a
    // float Postgres engine, where the regex operator (`~`) and
    // BIGINT/DOUBLE PRECISION casts come into play.
    //
    // A failed conversion has no value, so its rule derives no row for that
    // input: the rejected strings are the ones absent below, not the ones
    // paired with NULL. Which is also the point of the "without aborting"
    // tests further down, since a raise would take the whole query with it.
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
    // `01`, `-0`, `1.5` and `bad` are rejected, so they get no row.
    expect(sorted(results[0]!.rows)).toEqual(
      sorted([
        { R: "42", N: 42 },
        { R: "-7", N: -7 },
        { R: "0", N: 0 },
      ]),
    );
    // `01.5` and `1.` are not canonical decimals, nor is `bad` one at all.
    expect(sorted(results[1]!.rows)).toEqual(
      sorted([
        { R: "3.14", N: 3.14 },
        { R: "-0.5", N: -0.5 },
        { R: "1.0", N: 1 },
        { R: "1", N: 1 },
      ]),
    );
    // The two boolean spellings are exactly `true` and `false`.
    expect(sorted(results[2]!.rows)).toEqual(
      sorted([
        { R: "true", B: true },
        { R: "false", B: false },
      ]),
    );
  });

  test("to_float rejects out-of-range decimals without aborting the query", async () => {
    // Postgres checks the canonical decimal shape before casting, but a
    // syntactically-valid decimal can still be outside double precision's
    // range. A plain CAST would raise and abort the whole query; the guard
    // makes the expression undefined instead, so the row is dropped and the
    // sound one still comes back. That surviving row is what the test turns
    // on: a raise would leave nothing at all.
    const huge = "9".repeat(400);
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      raw("${huge}").
      raw("1.5").
      parsed(R, N) :- raw(R), N = to_float(R).
      ?- parsed(R, N).
    `);
    expect(results[0]!.rows).toEqual([{ R: "1.5", N: 1.5 }]);
  });

  test("guarded conversions on literals do not abort the query", async () => {
    // Postgres may fold constant casts inside dead CASE branches during
    // planning, so guarded conversions must cast the CASE result rather
    // than casting only in the THEN branch. Literal bad inputs exercise
    // that plan-time path directly.
    const huge = "9".repeat(400);
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      bad(I, F, J) :- I = to_integer("bad"), F = to_float("${huge}"), J = parse_json("not json").
      good(I) :- I = to_integer("42").
      ?- bad(I, F, J).
      output predicate ok(I) :- good(I).
    `);
    // Each conversion fails, so the rule derives nothing. The companion rule
    // is what distinguishes that from a query the planner aborted.
    expect(results[0]!.rows).toEqual([]);
    expect(results[1]!.rows).toEqual([{ I: 42 }]);
  });

  test("math overflow guards do not abort the query", async () => {
    // Postgres raises on EXP / POWER overflow. The SQL emitter must prove the
    // result is in range before evaluating the function, leaving the same
    // inputs undefined that native leaves undefined.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      over(E, P) :- E = exp(1000.0), P = 10.0 ** 400.0.
      under(E) :- E = exp(1.0).
      ?- over(E, P).
      output predicate ok(E) :- under(E).
    `);
    expect(results[0]!.rows).toEqual([]);
    expect(results[1]!.rows).toEqual([{ E: Math.E }]);
  });

  test("integer arithmetic overflow leaves the tuple underived", async () => {
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      safe(X) :- X = 9007199254740990 + 1.
      add(X)  :- X = 9007199254740991 + 1.
      sub(X)  :- X = -9007199254740991 - 1.
      mul(X)  :- X = 94906266 * 94906266.
      ?- safe(X).
      output predicate oa(X) :- add(X).
      output predicate osu(X) :- sub(X).
      output predicate om(X) :- mul(X).
    `);
    // One rule per case rather than one rule with four columns: a single
    // overflowing column now withholds the whole tuple, which would hide the
    // three sound ones.
    expect(results[0]!.rows).toEqual([{ X: Number.MAX_SAFE_INTEGER }]);
    expect(results[1]!.rows).toEqual([]);
    expect(results[2]!.rows).toEqual([]);
    expect(results[3]!.rows).toEqual([]);
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

  test("parse_json: valid JSON parses, malformed derives nothing (no query abort)", async () => {
    // The Postgres dialect routes parse_json through
    // `pg_input_is_valid(text, 'jsonb')`, so malformed input leaves the call
    // undefined rather than raising. `"null"` parses to the JSON null *value*,
    // and a non-finite numeric leaf is still rejected, jsonb accepting `9e999`
    // where no backend can represent it (spec §2.9).
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
    // Absent rather than null-valued: no row was derived for these three.
    expect(byInput.has("9e999")).toBe(false);
    expect(byInput.has("[1,9e999]")).toBe(false);
    expect(byInput.has("not json")).toBe(false);
  });

  test("Regression: a JSON null leaf survives value extraction as a value", async () => {
    // Postgres jsonb distinguishes JSON null from SQL NULL, and so does
    // Datamog now: an extracted `null` leaf is the null value, and the
    // operations over it answer about a value rather than collapsing. The
    // dialect used to force the collapse at every extraction boundary, which
    // is what null-as-a-value.md §8 removes.
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
      { V: null, IsNull: true, Kind: "null", Encoded: "null", Has: false },
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

  test("Regression: an undefined subscript / slice index derives nothing", async () => {
    // Pins the postgres dialect's CASE-guarded SUBSTR against the same program
    // the SQLite version uses. Vanilla Postgres SUBSTR with a negative `for`
    // argument raises, so the guard has to be there whatever the index is; what
    // changed is that `I = 1 / 0` does not hold, so no row reaches the
    // subscript and a raise would be the only way to fail this test.
    const executor = new DatamogExecutor(backend);
    const results = await executor.execute(`
      words("hello").
      sub(W, S)        :- words(W), I = 1 / 0, S = W[I].
      slice_start(W, S):- words(W), I = 1 / 0, S = W[I:3].
      slice_end(W, S)  :- words(W), J = 1 / 0, S = W[1:J].
      backwards(W, S)  :- words(W), S = W[4:1].
      ?- sub(W, S).
      output predicate ss(W, S) :- slice_start(W, S).
      output predicate se(W, S) :- slice_end(W, S).
      output predicate bw(W, S) :- backwards(W, S).
    `);
    expect(results[0]!.rows).toEqual([]);
    expect(results[1]!.rows).toEqual([]);
    expect(results[2]!.rows).toEqual([]);
    // The negative-length case is still reachable, and still `''` rather than a
    // raise, which is the half of the guard the three above no longer exercise.
    expect(results[3]!.rows).toEqual([{ W: "hello", S: "" }]);
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
