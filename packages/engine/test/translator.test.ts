import { describe, expect, test } from "bun:test";
import { PostgresSqlDialect } from "datamog-backend-postgres";
import { SqliteSqlDialect } from "datamog-backend-sqlite";
import { type AnalyzerError, analyze, inferTypes } from "datamog-core";
import { parse } from "datamog-parser";
import type { SqlDialect } from "../src/dialect.ts";
import { translate } from "../src/translator.ts";

const postgres = new PostgresSqlDialect();
const sqlite = new SqliteSqlDialect();

function translateSource(source: string, dialect: SqlDialect = postgres) {
  return translate(inferTypes(analyze(parse(source))), dialect);
}

const translateTyped = translateSource;

/** Normalize whitespace for comparison */
function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("translator", () => {
  test("generates CREATE TABLE for ext declaration", () => {
    const result = translateSource("input predicate parent(name: string, child: string).");
    expect(result.createTables).toHaveLength(1);
    expect(norm(result.createTables[0]!)).toBe(
      'CREATE TABLE IF NOT EXISTS "parent" ( "name" TEXT NOT NULL, "child" TEXT NOT NULL );',
    );
  });

  test("quotes escaped predicate and column identifiers in SQL", () => {
    const result = translateSource(
      'input predicate `http-event`(`content-type`: string, `quote"col`: integer).',
    );
    expect(norm(result.createTables[0]!)).toBe(
      'CREATE TABLE IF NOT EXISTS "http-event" ( "content-type" TEXT NOT NULL, "quote""col" INTEGER NOT NULL );',
    );
  });

  test("maps SQL types correctly", () => {
    const result = translateSource(
      "input predicate t(a: string, b: integer, c: float, d: boolean).",
    );
    const sql = norm(result.createTables[0]!);
    expect(sql).toContain('"a" TEXT NOT NULL');
    expect(sql).toContain('"b" INTEGER NOT NULL');
    // Float columns are float8 on Postgres: `REAL` is single-precision
    // float4, which would truncate the 64-bit doubles the other backends
    // store and break cross-backend equality/join on full-precision values.
    expect(sql).toContain('"c" DOUBLE PRECISION NOT NULL');
    expect(sql).toContain('"d" BOOLEAN NOT NULL');
  });

  test("omits NOT NULL for nullable input predicate columns", () => {
    const result = translateSource("input predicate t(a: string, b: integer?, c: value?).");
    const sql = norm(result.createTables[0]!);
    expect(sql).toContain('"a" TEXT NOT NULL');
    expect(sql).toContain('"b" INTEGER,');
    expect(sql).toContain('"c" JSONB');
    expect(sql).not.toContain('"b" INTEGER NOT NULL');
    expect(sql).not.toContain('"c" JSONB NOT NULL');
  });

  test("emits TRUE/FALSE for boolean literals", () => {
    const result = translateSource(`
      input predicate flag(name: string, on: boolean).
      live(N) :- flag(N, true).
      dead(N) :- flag(N, false).
    `);
    const live = result.createViews.find((v) => v.includes('"live"'))!;
    const dead = result.createViews.find((v) => v.includes('"dead"'))!;
    expect(norm(live)).toContain('"on" = TRUE');
    expect(norm(dead)).toContain('"on" = FALSE');
  });

  test("generates CREATE VIEW for non-recursive rule", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      grandparent(X, Y) :- parent(X, Z), parent(Z, Y).
    `);
    expect(result.createViews).toHaveLength(1);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('CREATE OR REPLACE VIEW "grandparent"');
    expect(sql).toContain("FROM");
    expect(sql).not.toContain("RECURSIVE");
  });

  test("generates join conditions from shared variables", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      grandparent(X, Y) :- parent(X, Z), parent(Z, Y).
    `);
    const sql = norm(result.createViews[0]!);
    // Z is shared between parent(X, Z) and parent(Z, Y)
    // Should produce a join condition on the child column of b0 and name column of b1.
    // Both columns are declared without `?`, so neither can hold NULL and the
    // plain `=` agrees with the null-aware form.
    expect(sql).toContain('__b0."child" = __b1."name"');
  });

  test("a join on a nullable column stays null-aware", () => {
    const result = translateSource(`
      input predicate parent(name: string?, child: string?).
      grandparent(X, Y) :- parent(X, Z), parent(Z, Y).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('__b0."child" IS NOT DISTINCT FROM __b1."name"');
  });

  test("a guard on a nullable join column recovers the plain equality", () => {
    // `Z <> null` proves the shared variable non-null, so the null-aware form
    // has nothing left to do. See doc/design/nullness-tracking.md §4.2.
    const result = translateSource(`
      input predicate parent(name: string?, child: string?).
      grandparent(X, Y) :- parent(X, Z), parent(Z, Y), Z <> null.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('__b0."child" = __b1."name"');
    expect(sql).not.toContain("IS NOT DISTINCT FROM");
  });

  test("generates WHERE for constants in rule body", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      alice_child(X) :- parent("alice", X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("__b0.\"name\" = 'alice'");
  });

  test("generates UNION for multiple rules with same head", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      related(X, Y) :- parent(X, Y).
      related(X, Y) :- parent(Y, X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("UNION");
  });

  test("generates CREATE RECURSIVE VIEW for recursive rules", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    `);
    expect(result.createViews).toHaveLength(1);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("CREATE RECURSIVE VIEW");
    expect(sql).toContain("UNION");
  });

  test("folds two recursive rules into one LATERAL term (postgres)", () => {
    const result = translateSource(`
      input predicate edge(a: integer, b: integer).
      reach(X, Y) :- edge(X, Y).
      reach(X, Y) :- reach(X, Z), edge(Z, Y).
      reach(X, Y) :- reach(X, Z), edge(Y, Z).
    `);
    const sql = norm(result.createViews[0]!);
    // Postgres allows one recursive term holding one reference to the CTE, so
    // the two recursive rules share a single `FROM "reach"` and read the
    // previous iteration through its alias.
    expect(sql).toContain("LATERAL");
    expect(sql.match(/FROM "reach"/g)).toHaveLength(1);
    expect(sql).toContain('"reach" AS __rec');
    expect(sql).toContain("__rec.");
  });

  test("leaves a single recursive rule as a plain union term (postgres)", () => {
    const result = translateSource(`
      input predicate edge(a: integer, b: integer).
      reach(X, Y) :- edge(X, Y).
      reach(X, Y) :- reach(X, Z), edge(Z, Y).
    `);
    // One recursive rule needs no folding, and the flat form is the clearer SQL.
    expect(norm(result.createViews[0]!)).not.toContain("LATERAL");
  });

  test("sqlite keeps the flat multi-branch union for two recursive rules", () => {
    const result = translateSource(
      `
      input predicate edge(a: integer, b: integer).
      reach(X, Y) :- edge(X, Y).
      reach(X, Y) :- reach(X, Z), edge(Z, Y).
      reach(X, Y) :- reach(X, Z), edge(Y, Z).
    `,
      sqlite,
    );
    // SQLite accepts what Postgres rejects, so it defines no `singleRecursiveTerm`.
    expect(norm(result.createViews[0]!)).not.toContain("LATERAL");
  });

  test("generates SELECT for query with constants", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
      ?- ancestor("alice", X).
    `);
    expect(result.queries).toHaveLength(1);
    const sql = norm(result.queries[0]!);
    expect(sql).toContain("SELECT");
    expect(sql).toContain("'alice'");
  });

  test("generates SELECT for query with all variables", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
      ?- ancestor(X, Y).
    `);
    const sql = norm(result.queries[0]!);
    expect(sql).toContain("SELECT");
    // Should select all columns
    expect(sql).toContain("col1");
    expect(sql).toContain("col2");
  });

  test("handles facts (rules with empty body)", () => {
    const result = translateSource('base("hello").');
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("SELECT");
    expect(sql).toContain("'hello'");
  });

  test("handles constants in rule head", () => {
    const result = translateSource(`
      input predicate items(name: string).
      tagged(X, "yes") :- items(X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("'yes' AS col2");
    expect(sql).toContain('__b0."name" AS col1');
  });

  test("don't-care variables do not create join conditions", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      has_child(X) :- parent(X, _).
    `);
    const sql = norm(result.createViews[0]!);
    // The _ should not produce a join — just select X from parent
    expect(sql).toContain('__b0."name" AS col1');
    expect(sql).not.toContain("WHERE");
  });

  test("views are ordered by dependencies", () => {
    const result = translateSource(`
      input predicate edge(src: string, dst: string).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
      reachable(X) :- path("start", X).
    `);
    expect(result.createViews).toHaveLength(2);
    const firstView = norm(result.createViews[0]!);
    const secondView = norm(result.createViews[1]!);
    expect(firstView).toContain('"path"');
    expect(secondView).toContain('"reachable"');
  });

  test("number constants in queries", () => {
    const result = translateSource(`
      input predicate scores(name: string, score: integer).
      high(X) :- scores(X, 100).
      ?- high(X).
    `);
    const viewSql = norm(result.createViews[0]!);
    expect(viewSql).toContain('__b0."score" = 100');
  });

  test("generates SQL for arithmetic expression in head", () => {
    const result = translateSource(`
      input predicate scores(name: string, score: integer).
      doubled(X, Y) :- scores(X, S), Y = S * 2.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("AS col2");
    expect(sql).toContain("* 2");
  });

  test("generates SQL for expression in atom argument", () => {
    const result = translateSource(`
      input predicate nums(val: integer).
      input predicate offsets(delta: integer).
      shifted(X) :- nums(X), offsets(X + 1).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("+ 1)");
  });

  test("translates && to SQL AND", () => {
    const result = translateSource(`
      input predicate t(a: boolean, b: boolean).
      r(C) :- t(A, B), C = A && B.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain(" AND ");
  });

  test("translates || to SQL OR", () => {
    const result = translateSource(`
      input predicate t(a: boolean, b: boolean).
      r(C) :- t(A, B), C = A || B.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain(" OR ");
  });

  test("translates comparison expression to SQL", () => {
    const result = translateSource(`
      input predicate t(a: integer).
      r(C) :- t(X), C = X > 0.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("> 0");
  });

  test("translates = / <> in expression position to the null-aware operators", () => {
    const result = translateSource(`
      input predicate t(a: integer).
      r1(C) :- t(X), C = (X = 0).
      r2(C) :- t(X), C = (X <> 0).
    `);
    const sql1 = norm(result.createViews[0]!);
    expect(sql1).toContain("IS NOT DISTINCT FROM 0");
    const sql2 = norm(result.createViews[1]!);
    expect(sql2).toContain("IS DISTINCT FROM 0");
  });

  test("compound filter translates with AND", () => {
    const result = translateSource(`
      input predicate t(a: integer, b: integer).
      r(X, Y) :- t(X, Y), (X > 0) && (Y < 10).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("AND");
    expect(sql).toContain("> 0");
    expect(sql).toContain("< 10");
  });

  test("translates ! to SQL NOT", () => {
    const result = translateSource(`
      input predicate t(a: boolean).
      r(C) :- t(A), C = !A.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("NOT ");
  });

  test("generates SQL for comparison", () => {
    const result = translateSource(`
      input predicate scores(name: string, score: integer).
      high(X) :- scores(X, S), S > 80.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("> 80");
  });

  test("string ordering comparisons use portable collation", () => {
    const pg = translateSource(`
      input predicate words(a: string, b: string).
      before(A, B) :- words(A, B), A < B.
    `);
    expect(norm(pg.createViews[0]!)).toContain(`(__b0."a" COLLATE "C") < (__b0."b" COLLATE "C")`);

    const sq = translateSource(
      `
        input predicate words(a: string, b: string).
        before(A, B) :- words(A, B), A < B.
      `,
      sqlite,
    );
    expect(norm(sq.createViews[0]!)).toContain(
      `(__b0."a" COLLATE BINARY) < (__b0."b" COLLATE BINARY)`,
    );
  });

  test("generates SQL for <> comparison", () => {
    const result = translateSource(`
      input predicate pairs(a: integer, b: integer).
      diff(X, Y) :- pairs(X, Y), X <> Y.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("IS DISTINCT FROM");
  });

  test("generates SQL for = constraint (non-binding equality)", () => {
    // Body `X + 1 = Y` is a constraint — both sides bound. This routes through
    // the dialect's logical-equality emitter (Postgres uses `IS NOT DISTINCT
    // FROM`, SQLite uses `IS`). Nullable columns, since a non-null side would
    // take the plain `=` instead.
    const result = translateSource(`
      input predicate pairs(a: integer?, b: integer?).
      match(X, Y) :- pairs(X, Y), X + 1 = Y.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("+ 1) IS NOT DISTINCT FROM");
  });

  test("generates SQL for equality binding used in head", () => {
    const result = translateSource(`
      input predicate base(x: integer).
      computed(X, Y) :- base(X), Y = X + 10.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("+ 10");
    expect(sql).toContain("AS col2");
  });

  test("uses || for string concatenation with type info", () => {
    const result = translateTyped(`
      input predicate words(w: string).
      prefixed(R) :- words(W), R = "hello_" + W.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("||");
    expect(sql).not.toContain("+");
  });

  test("uses + for integer arithmetic with type info", () => {
    const result = translateTyped(`
      input predicate nums(x: integer).
      inc(X, Y) :- nums(X), Y = X + 1.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("+");
    expect(sql).not.toContain("||");
  });

  test("generates LENGTH for length()", () => {
    const result = translateSource(`
      input predicate words(w: string).
      lengths(W, N) :- words(W), N = length(W).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("LENGTH(");
  });

  test("upper/lower emit portable ASCII-only case folding", () => {
    const result = translateSource(`
      input predicate words(w: string).
      folded(U, L) :- words(W), U = upper(W), L = lower(W).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).not.toContain("UPPER(");
    expect(sql).not.toContain("LOWER(");
    expect(sql).toContain(`REPLACE(__b0."w", 'a', 'A')`);
    expect(sql).toContain(`, 'Z', 'z')`);
  });

  test("generates SUBSTR for subscript", () => {
    const result = translateSource(`
      input predicate words(w: string).
      first_char(W, C) :- words(W), C = W[0].
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("SUBSTR(");
    expect(sql).toContain("+ 1, 1)");
  });

  test("generates SUBSTR for slice", () => {
    const result = translateSource(`
      input predicate words(w: string).
      mid(W, S) :- words(W), S = W[1:3].
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("SUBSTR(");
  });

  test("generates SUBSTR with one argument for open-ended slice W[s:]", () => {
    const result = translateSource(`
      input predicate words(w: string).
      tail(W, S) :- words(W), S = W[2:].
    `);
    const sql = norm(result.createViews[0]!);
    // Two-argument SUBSTR (no length), offset by +1 for 1-based indexing.
    expect(sql).toMatch(/SUBSTR\([^,]+, \(2\) \+ 1\)/);
  });

  test("generates SUBSTR with length for open-start slice W[:e]", () => {
    const result = translateSource(`
      input predicate words(w: string).
      head(W, S) :- words(W), S = W[:3].
    `);
    const sql = norm(result.createViews[0]!);
    // Three-argument SUBSTR starting at 1 with length e.
    expect(sql).toMatch(/SUBSTR\([^,]+, 1, \(3\)\)/);
  });

  test("omits SUBSTR entirely for full slice W[:]", () => {
    const result = translateSource(`
      input predicate words(w: string).
      copy(W, S) :- words(W), S = W[:].
    `);
    const sql = norm(result.createViews[0]!);
    // Neither endpoint given → the object is returned as-is, no SUBSTR wrapper.
    expect(sql).not.toContain("SUBSTR");
  });

  test("generates GROUP BY for computed non-aggregate head term", () => {
    // A head arg that is a BinaryExpr (not a Variable, Literal, or Aggregate)
    // must appear in GROUP BY. Exercises the non-Variable branch of the
    // aggregate-rule head loop.
    const result = translateSource(`
      input predicate t(a: integer, b: integer).
      shifted(X + 1, count(*)) :- t(X, _).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("COUNT(*)");
    expect(sql).toMatch(/GROUP BY [^ ]*__b0[^ ]*\."a" \+ 1/);
  });

  test("generates NOT EXISTS for negated atoms", () => {
    const result = translateSource(`
      input predicate node(name: string).
      input predicate edge(src: string, dst: string).
      reachable(X) :- edge("start", X).
      unreachable(X) :- node(X), not reachable(X).
    `);
    const views = result.createViews;
    const unreachableView = views.find((v) => norm(v).includes('"unreachable"'));
    expect(unreachableView).toBeDefined();
    const sql = norm(unreachableView!);
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain('SELECT 1 FROM "reachable"');
    // The subquery should bind to the outer variable. Non-null columns, so the
    // binding is a plain `=`.
    expect(sql).toContain('"col1" = __b0."name"');
  });

  test("generates a tagged combined CTE for mutual recursion (postgres)", () => {
    // Use the typed translation path because the synthesised empty anchor
    // for `odd` (whose rules are purely recursive) needs `columnTypes` to
    // emit the `CAST(NULL AS INTEGER)` projection.
    const result = translateTyped(`
      input predicate base(x: integer).
      even(X) :- base(X).
      even(X) :- odd(X).
      odd(X) :- even(X).
    `);
    // One view per predicate in the mutually recursive group
    expect(result.createViews).toHaveLength(2);
    const evenView = result.createViews.find((v) => norm(v).includes('VIEW "even"'));
    const oddView = result.createViews.find((v) => norm(v).includes('VIEW "odd"'));
    expect(evenView).toBeDefined();
    expect(oddView).toBeDefined();
    // Postgres has never implemented mutual recursion between WITH items, so
    // the SCC becomes one tagged CTE and each view filters its own rows out.
    const even = norm(evenView!);
    expect(even).toContain("WITH RECURSIVE");
    expect(even).toContain('"__mutual_odd_even"(__tag, col1)');
    expect(even).not.toContain('"even"(col1)');
    expect(even).toContain(`WHERE __tag = 'even'`);
    expect(norm(oddView!)).toContain(`WHERE __tag = 'odd'`);
    // And one recursive term naming the CTE once, the rest inside a LATERAL.
    expect(even).toContain("LATERAL");
    expect(even.match(/FROM "__mutual_odd_even"/g)).toHaveLength(2); // recursive term + final SELECT
  });

  test("pads a narrower predicate inside the select list, not after WHERE (postgres)", () => {
    const result = translateTyped(`
      input predicate e(a: integer, b: integer).
      seed(X: integer) :- e(X, _).
      p(X) :- seed(X).
      p(X) :- q(X, _).
      q(X, Y) :- p(X), e(X, Y).
    `);
    const view = norm(result.createViews.find((v) => norm(v).includes('VIEW "p"'))!);
    // `p(X) :- q(X, _)` is folded into the LATERAL, where its only body atom is
    // the SCC reference and so leaves the branch with a WHERE but no FROM. The
    // NULL padding still belongs in the select list: appending it at the end of
    // the branch would put it after the WHERE and not parse.
    expect(view).toContain(`CAST(NULL AS INTEGER) WHERE __rec."__tag" = 'q'`);
    // The broken form: padding trailing a completed WHERE condition.
    expect(view).not.toMatch(/= '\w+', CAST\(NULL/);
  });

  test("sqlite tags the same SCC but unions the branches flat", () => {
    const result = translateTyped(
      `
      input predicate base(x: integer).
      even(X) :- base(X).
      even(X) :- odd(X).
      odd(X) :- even(X).
    `,
      sqlite,
    );
    // SQLite spells it `CREATE VIEW IF NOT EXISTS "even"`, so match the name.
    const evenView = result.createViews.find((v) => norm(v).includes('"even" AS'));
    expect(evenView).toBeDefined();
    const even = norm(evenView!);
    expect(even).toContain('"__mutual_odd_even"(__tag, col1)');
    expect(even).not.toContain("LATERAL");
    // SQLite is untyped enough not to need the anchor's padding cast.
    expect(even).not.toContain("CAST(NULL AS");
  });

  test("generates generate_series for binding range (postgres)", () => {
    const result = translateTyped(`
      nums(X) :- X in [1 .. 5].
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("generate_series(1, 5)");
    expect(sql).toContain('"value"');
  });

  test("generates BETWEEN for filter range (non-variable expr)", () => {
    const result = translateTyped(`
      input predicate vals(x: integer).
      filtered(X) :- vals(X), X + 1 in [1 .. 100].
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("BETWEEN 1 AND 100");
  });

  test("generates BETWEEN for variable range with non-integer bounds", () => {
    const result = translateTyped(`
      input predicate base(x: float).
      filtered(X) :- base(X), X in [0.5 .. 9.5].
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("BETWEEN 0.5 AND 9.5");
    expect(sql).not.toContain("generate_series");
  });

  test("generates generate_series with expression bounds", () => {
    const result = translateTyped(`
      input predicate base(x: integer, y: integer).
      inrange(X, Z) :- base(X, Y), Z in [Y .. Y + 10].
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("generate_series(");
    expect(sql).toContain("+ 10)");
  });

  test("generates GROUP BY for aggregate rule", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      num_children(P, count(C)) :- parent(P, C).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('CREATE OR REPLACE VIEW "num_children"');
    expect(sql).toContain("COUNT(");
    expect(sql).toContain("GROUP BY");
  });

  test("generates COUNT(*) for count(*)", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      total(count(*)) :- parent(_, _).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("COUNT(*)");
    expect(sql).not.toContain("GROUP BY");
  });

  test("treats count(_0) as a normal user variable aggregate", () => {
    const result = translateSource(`
      input predicate parent(name: string, child: string).
      total(count(_0)) :- parent(_0, _).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("COUNT(");
    expect(sql).not.toContain("COUNT(*)");
  });

  test("generates SUM aggregate", () => {
    const result = translateSource(`
      input predicate scores(name: string, score: integer).
      totals(X, sum(S)) :- scores(X, S).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("SUM(");
    expect(sql).toContain("GROUP BY");
  });

  test("generates aggregate with expression argument", () => {
    const result = translateSource(`
      input predicate items(part: string, qty: integer, cost: integer).
      total_cost(P, sum(Q * C)) :- items(P, Q, C).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("SUM(");
    expect(sql).toContain("*");
    expect(sql).toContain("GROUP BY");
  });

  test("generates all aggregate functions", () => {
    for (const [func, sqlFunc] of [
      ["count", "COUNT"],
      ["sum", "SUM"],
      ["avg", "AVG"],
      ["min", "MIN"],
      ["max", "MAX"],
    ] as const) {
      const result = translateSource(`
        input predicate t(a: string, b: integer).
        r(X, ${func}(Y)) :- t(X, Y).
      `);
      const sql = norm(result.createViews[0]!);
      expect(sql).toContain(`${sqlFunc}(`);
    }
  });

  test("string aggregates order with portable collation", () => {
    const result = translateSource(`
      input predicate words(w: string).
      r(min(W), max(W), concat(W), list(W)) :- words(W).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain(`MIN((__b0."w" COLLATE "C"))`);
    expect(sql).toContain(`MAX((__b0."w" COLLATE "C"))`);
    expect(sql).toContain(`ORDER BY (__b0."w" COLLATE "C")`);
  });

  test("generates UNION of aggregate rules", () => {
    const result = translateSource(`
      input predicate t1(a: string, b: integer).
      input predicate t2(a: string, b: integer).
      totals(X, sum(Y)) :- t1(X, Y).
      totals(X, sum(Y)) :- t2(X, Y).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("UNION");
    expect(sql).toContain("GROUP BY");
  });

  test("generates STRING_AGG for concat (postgres)", () => {
    const result = translateSource(`
      input predicate items(group_name: string, item: string).
      concat_items(G, concat(I)) :- items(G, I).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("STRING_AGG(");
    expect(sql).toContain("::TEXT");
    // ORDER BY pins the per-group output to a stable order across
    // backends — without it the planner could enumerate group rows in
    // any order, silently diverging from the native evaluator.
    expect(sql).toMatch(/ORDER BY/i);
  });

  test("Regression: concat on value-typed args canonicalises before STRING_AGG (postgres)", () => {
    // `STRING_AGG(jsonb_col::TEXT, ',' ORDER BY jsonb_col)` would
    // emit Postgres jsonb's natural text serialisation, which inserts
    // a space after `:` and `,` outside strings (`{"a": 1}, {"b": 2}`).
    // SQLite (canonical-TEXT storage) and native (`canonicalizeJson`)
    // produce no-whitespace canonical text, so spec §6's "identical
    // across every backend" promise breaks for `concat(value)`. Route
    // value-typed concat args through `jsonStringify` (the same
    // regex-strip used by `to_json`) before they reach the aggregate.
    const result = translateSource(`
      input predicate data(j: value).
      result(concat(J)) :- data(J).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("STRING_AGG(");
    // The value column must NOT flow through bare `::TEXT` — that's
    // what produces the diverging whitespace. The `jsonStringify`
    // helper's signature `regexp_replace(... ::text ...)` is what we
    // expect instead.
    expect(sql).toContain("regexp_replace");
    expect(sql).toContain(`COLLATE "C"`);
    expect(sql).not.toMatch(/STRING_AGG\(__b\d+\."j"::TEXT/);
  });

  test("generates JSONB_AGG for list with `value` arg (postgres)", () => {
    const result = translateSource(`
      input predicate events(group_name: string, payload: value).
      collected(G, list(P)) :- events(G, P).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("JSONB_AGG(");
    // Sort by the jsonb's text form so per-group order matches the
    // canonical text ordering used by the native evaluator.
    expect(sql).toMatch(/ORDER BY .*::TEXT/i);
    expect(sql).toContain(`COLLATE "C"`);
    // FILTER clause skips SQL NULLs so the array doesn't carry JSON
    // null entries for missing rows.
    expect(sql).toMatch(/FILTER \(WHERE/i);
  });

  test("generates JSONB_AGG for list with primitive arg, no ::TEXT cast (postgres)", () => {
    // Primitive arguments are auto-lifted via `to_jsonb`, but the
    // ORDER BY must keep the raw column so numeric columns sort
    // numerically — `::TEXT` here would lex-sort `[10, 2]` as
    // `[10, 2]`, diverging from the native JS `<` comparator.
    const result = translateSource(`
      input predicate t(g: string, n: integer).
      collected(G, list(N)) :- t(G, N).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("JSONB_AGG(");
    expect(sql).toContain("to_jsonb(");
    expect(sql).toMatch(/ORDER BY/i);
    expect(sql).not.toMatch(/ORDER BY .*::TEXT/i);
  });

  test("Regression: list with float arg guards non-finite values before JSON lift", () => {
    const result = translateSource(`
      input predicate data(x: float).
      collected(list(X)) :- data(X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("JSONB_AGG(");
    expect(sql).toContain('to_jsonb((CASE WHEN ABS(__b0."x")');
    expect(sql).toContain('THEN NULL ELSE __b0."x" END)');
  });

  test("primitive atom args lift via to_jsonb when column is `value` (postgres)", () => {
    // `t(5)` over a value column emits `j = to_jsonb(5)` instead of
    // `j = 5` (which would error on Postgres: jsonb = integer).
    const result = translateSource(`
      input predicate t(j: value).
      r("match") :- t(5).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("to_jsonb(5)");
    expect(sql).toMatch(/__b0\."j" = to_jsonb\(5\)/);
  });

  test("primitive query args lift via to_jsonb when column is `value` (postgres)", () => {
    const result = translateSource(`
      input predicate t(j: value).
      ?- t(5).
    `);
    const sql = norm(result.queries[0]!);
    expect(sql).toContain('"j" = to_jsonb(5)');
  });

  test("shared integer/value variable projects the integer, lifts only the join (postgres)", () => {
    // X's meet type is integer, so the head projects the integer column
    // unlifted; only the equality against the `value` column lifts.
    const result = translateSource(`
      input predicate i(x: integer).
      input predicate j(x: value).
      r(X) :- i(X), j(X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('to_jsonb(__b0."x") = __b1."x"');
    expect(sql).toContain('__b0."x" AS col1');
    expect(sql).not.toContain('to_jsonb(__b0."x") AS col1');
  });

  test("shared integer/value projection is independent of atom order (postgres)", () => {
    // `value` atom first: the head must still project the integer column
    // (__b1), never the `value` column, so the result type is identical.
    const result = translateSource(`
      input predicate i(x: integer).
      input predicate j(x: value).
      r(X) :- j(X), i(X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('__b1."x" AS col1');
    expect(sql).toContain('to_jsonb(__b1."x") = __b0."x"');
    expect(sql).not.toContain('to_jsonb(__b0."x") AS col1');
  });

  test("primitive value-function args lift via to_jsonb (postgres)", () => {
    const result = translateSource(`
      r(T, S, N) :- T = type_of(5), S = to_json("hi"), N = as_integer(5).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("jsonb_typeof(to_jsonb(5))");
    expect(sql).toContain("regexp_replace((to_jsonb('hi'))::text");
    expect(sql).toContain("jsonb_typeof(to_jsonb(5)) = 'number'");
  });

  test("primitive iteration sources lift before json iteration (postgres)", () => {
    const result = translateSource(`
      input predicate p(x: integer).
      r(K, V) :- p(X), object_entry(X, K, V).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("jsonb_typeof(to_jsonb(__b0.\"x\")) = 'object'");
    expect(sql).toContain("jsonb_each(CASE WHEN");
  });

  test("comparison J = 5 (value vs int) lifts the primitive side (postgres)", () => {
    const result = translateSource(`
      input predicate t(j: value).
      r(J) :- t(J), J = 5.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("to_jsonb(5)");
  });

  test("filter equality J = 5 (value vs int) lifts the primitive side (postgres)", () => {
    // Binding-shaped equality where J is already bound by t(J) becomes a
    // filter equality, and the primitive side is lifted so both operands are
    // jsonb. The literal `5` cannot be NULL, so the comparison itself is a
    // plain `=`; what this test pins is the lift.
    const result = translateSource(`
      input predicate t(j: value).
      r(J) :- t(J), J = 5.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("= to_jsonb(5)");
  });

  test("IDB column unifies to value across primitive and value rules (postgres)", () => {
    // Sibling rules contribute integer (5) and json ([1,2]) heads
    // for `data`. The column unifies upward to json; the integer
    // branch's head emission lifts via to_jsonb so both UNION
    // members produce JSONB.
    const result = translateSource(`
      data(5).
      data([1, 2]).
      ?- data(X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("to_jsonb(5)");
    expect(sql).toContain("jsonb_build_array(1, 2)");
  });

  test("rejects non-linear recursion", () => {
    expect(() =>
      translateSource(`
      input predicate edge(src: string, dst: string).
      tc(X, Y) :- edge(X, Y).
      tc(X, Z) :- tc(X, Y), tc(Y, Z).
    `),
    ).toThrow(/Non-linear recursion is not supported by postgres.*'tc'/);
  });

  test("rejects parity-stratified recursion", () => {
    const source = `
      input predicate composite(e: string).
      input predicate child(parent: string, kid: string).
      constant(E) :- composite(E), not bad^(E).
      bad^(E) :- child(E, C), not constant(C).
    `;
    expect(() => translateSource(source)).toThrow(
      /Parity-stratified recursion is not supported by postgres.*'bad\^'/,
    );
    expect(() => translateSource(source)).toThrow(/--backend native/);
  });

  test("compiles an inert sigil like any other predicate", () => {
    // One polarity in the stratum, so there is nothing to alternate against
    // and the ordinary translation is correct.
    const result = translateSource(`
      input predicate edge(src: string, dst: string).
      tc^(X, Y) :- edge(X, Y).
      tc^(X, Z) :- edge(X, Y), tc^(Y, Z).
      ?- tc^(X, Y).
    `);
    expect(result.createViews.join("\n")).toContain("tc");
  });

  test("mutual recursion with dependent non-recursive predicate", () => {
    // Typed path needed: `odd` has only recursive rules so the dialect
    // synthesises an empty anchor that requires `columnTypes`.
    const result = translateTyped(`
      input predicate base(x: integer).
      even(X) :- base(X).
      even(X) :- odd(X).
      odd(X) :- even(X).
      all_even(X) :- even(X).
    `);
    // 2 views for even/odd (mutual recursion) + 1 for all_even
    expect(result.createViews).toHaveLength(3);
    const allEvenView = result.createViews.find((v) => norm(v).includes('VIEW "all_even"'));
    expect(allEvenView).toBeDefined();
    expect(norm(allEvenView!)).not.toContain("RECURSIVE");
  });

  test("repeated variables in query atom produce a join condition", () => {
    const result = translateSource(`
      input predicate p(a: string, b: string).
      ?- p(X, X).
    `);
    const sql = norm(result.queries[0]!);
    // The outer SELECT aliases the projected column to the user's
    // variable name; the inner SELECT (synthetic rule) sources
    // `col1` from `p.a` and emits a join condition between
    // `p.a` and `p.b` for the repeated variable.
    expect(sql).toContain('AS "X"');
    expect(sql).toMatch(/"a" AS (col1|"col1")/);
    expect(sql).not.toMatch(/"b" AS .*"X"/);
    expect(sql).toMatch(/"a" = [^,)]*"b"/);
  });

  test("repeated variables in query atom on IDB predicate", () => {
    const result = translateSource(`
      input predicate e(a: string, b: string).
      q(A, B) :- e(A, B).
      ?- q(X, X).
    `);
    const sql = norm(result.queries[0]!);
    expect(sql).toContain('AS "X"');
    expect(sql).toMatch(/"col1" = [^,)]*"col2"/);
  });

  test("integer literal head arg is omitted from GROUP BY", () => {
    const result = translateSource(`
      input predicate t(x: integer).
      r(2, count(X)) :- t(X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("2 AS col1");
    expect(sql).toContain("COUNT(");
    // A bare integer in GROUP BY would be positional; the literal head arg
    // must not appear there at all.
    expect(sql).not.toContain("GROUP BY 2");
    expect(sql).not.toContain("GROUP BY");
  });

  test("string literal head arg is omitted from GROUP BY", () => {
    const result = translateSource(`
      input predicate t(x: integer).
      r("total", count(X)) :- t(X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("'total' AS col1");
    expect(sql).not.toContain("GROUP BY");
  });

  test("equality can forward-reference a later equality", () => {
    const result = translateSource(`
      input predicate t(x: integer).
      r(Z) :- t(X), Z = Y * 2, Y = X + 1.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('(__b0."x" + 1) * 2');
  });

  test("equality can bind a bare variable on the right", () => {
    const result = translateSource(`
      input predicate t(x: integer).
      renamed(X) :- t(Y), Y = X.
      incremented(Y) :- t(X), X + 1 = Y.
    `);
    // Single-rule views emit `SELECT DISTINCT` so the view is a set even when
    // the rule projects away a body variable.
    expect(norm(result.createViews[0]!)).toContain('SELECT DISTINCT __b0."x" AS col1');
    expect(norm(result.createViews[1]!)).toContain('SELECT DISTINCT (__b0."x" + 1) AS col1');
  });

  test("equality-bound value variable keeps value type for subscript", () => {
    const result = translateSource(
      `
      r(V) :- J = {"a": 1}, V = J["a"].
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("json_each");
    expect(sql).not.toContain("SUBSTR");
  });

  test("range bound referencing an equality-bound integer variable binds the range", () => {
    const result = translateTyped(`
      input predicate t(x: integer).
      r(Z) :- t(X), Y = X + 1, Z in [1 .. Y].
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('generate_series(1, (__b0."x" + 1))');
    expect(sql).not.toContain("BETWEEN");
  });

  test("range bound referencing a range-bound integer variable binds the range", () => {
    const result = translateTyped(`
      r(X, Y) :- X in [1 .. 5], Y in [X .. 10].
    `);
    const sql = norm(result.createViews[0]!);
    // Y's range should use generate_series (binding), not BETWEEN (filter).
    expect(sql.match(/generate_series\(/g)?.length).toBe(2);
    expect(sql).not.toContain("BETWEEN");
  });

  test("anonymous variables in query atoms are not projected", () => {
    const result = translateSource(`
      input predicate p(a: integer, b: integer).
      ?- p(X, _).
    `);
    const sql = norm(result.queries[0]!);
    // X is the only projected column; the inner SELECT sources `col1`
    // from `p.a`, and the outer aliases it to `X`.
    expect(sql).toContain('AS "X"');
    expect(sql).toMatch(/"a" AS (col1|"col1")/);
    // The desugared anonymous name (e.g. "_0") must not leak into the SELECT.
    expect(sql).not.toMatch(/AS "_\d+"/);
    expect(sql).not.toMatch(/AS "\$anon\d+"/);
  });

  test("variable bound to integer literal is omitted from GROUP BY", () => {
    const result = translateSource(`
      input predicate t(x: integer).
      r(Y, count(X)) :- t(X), Y = 5.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("5 AS col1");
    // A bare integer in GROUP BY is interpreted positionally; Y binds to
    // the literal 5 via equality, so it must be omitted from GROUP BY.
    expect(sql).not.toContain("GROUP BY 5");
    expect(sql).not.toContain("GROUP BY");
  });

  test("variable bound to a negative integer literal is also omitted from GROUP BY", () => {
    // A negative literal reaches termToSql via UnaryExpr and comes out as
    // `(-5)`; the old `isLiteralBinding` regex didn't accept the parens
    // and let the binding slip into GROUP BY.
    const result = translateSource(`
      input predicate t(x: integer).
      r(Y, count(X)) :- t(X), Y = -5.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("(-5) AS col1");
    expect(sql).not.toContain("GROUP BY");
  });

  test("slice with start > end returns empty string", () => {
    const result = translateSource(`
      input predicate t(s: string).
      r(R) :- t(S), R = S[4:2].
    `);
    const sql = norm(result.createViews[0]!);
    // Must not produce SUBSTR with a negative length; use a guarded CASE.
    expect(sql).toContain("CASE WHEN");
    expect(sql).toContain("ELSE ''");
  });

  test("division wraps the divisor with NULLIF for cross-backend consistency", () => {
    const result = translateSource(`
      input predicate t(x: integer, y: integer).
      r(X, Y, Z) :- t(X, Y), Z = X / Y.
    `);
    const sql = norm(result.createViews[0]!);
    // Postgres would otherwise raise on `/ 0`, while SQLite returns
    // NULL natively. Wrapping the divisor normalises both to NULL.
    expect(sql).toContain('NULLIF(__b0."y", 0)');
  });

  test("modulo wraps the divisor with NULLIF", () => {
    const result = translateSource(`
      input predicate t(x: integer, y: integer).
      r(X, Y, Z) :- t(X, Y), Z = X % Y.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('% NULLIF(__b0."y", 0)');
  });

  test("float modulo emits a portable real remainder expression", () => {
    const result = translateSource(`
      input predicate t(x: float, y: float).
      r(X, Y, Z) :- t(X, Y), Z = X % Y.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).not.toContain('% NULLIF(__b0."y", 0)');
    expect(sql).toContain('CEIL((__b0."x" / NULLIF(__b0."y", 0)))');
    expect(sql).toContain('FLOOR((__b0."x" / NULLIF(__b0."y", 0)))');
  });

  test("round/2 routes through dialect-specific portable emission", () => {
    const pg = translateSource(`
      input predicate t(x: float, n: integer).
      r(Z) :- t(X, N), Z = round(X, N).
    `);
    const pgSql = norm(pg.createViews[0]!);
    expect(pgSql).toContain(`ROUND((__b0."x")::numeric, __b0."n")`);
    expect(pgSql).toContain("DOUBLE PRECISION");

    const sq = translateSource(
      `
        input predicate t(x: integer, n: integer).
        r(Z) :- t(X, N), Z = round(X, N).
      `,
      sqlite,
    );
    const sqSql = norm(sq.createViews[0]!);
    expect(sqSql).toContain(`WHEN (__b0."n") < 0`);
    expect(sqSql).toContain("POWER(10");
    expect(sqSql).toContain("CAST(");
  });

  test("exp pre-checks overflow before calling EXP", () => {
    const result = translateSource(`
      input predicate t(x: float).
      r(X, Z) :- t(X), Z = exp(X).
    `);
    const sql = norm(result.createViews[0]!);
    // Postgres raises on EXP(1000), so the overflow guard must not put
    // EXP itself in the WHEN condition.
    expect(sql).toContain("LN(1.7976931348623157e308");
    expect(sql).not.toContain("ABS(EXP");
  });

  test("float arithmetic results are finite-guarded", () => {
    const result = translateSource(`
      input predicate t(x: float, y: float).
      r(P, Q, R) :- t(X, Y), P = X * Y, Q = X / Y, R = X % Y.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('CASE WHEN ABS((__b0."x" * __b0."y"))');
    expect(sql).toContain('CASE WHEN ABS((__b0."x" / NULLIF(__b0."y", 0)))');
    expect(sql).toContain("THEN NULL");
    expect(sql).toContain("<>"); // NaN guard for SQLite/sql.js.
  });

  test("sqrt of a negative argument returns NULL (not an error)", () => {
    const result = translateSource(`
      input predicate t(x: float).
      r(X, Z) :- t(X), Z = sqrt(X).
    `);
    const sql = norm(result.createViews[0]!);
    // Guard with CASE so Postgres doesn't raise on negative input.
    expect(sql).toContain("SQRT(CASE WHEN");
    expect(sql).toContain("< 0 THEN NULL");
  });

  test("ln of zero or negative returns NULL (not an error)", () => {
    const result = translateSource(`
      input predicate t(x: float).
      r(X, Z) :- t(X), Z = ln(X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("LN(CASE WHEN");
    expect(sql).toContain("<= 0 THEN NULL");
  });

  test("** guards against negative-base/fractional-exp and zero-to-negative", () => {
    const result = translateSource(`
      input predicate t(x: float, y: float).
      r(X, Y, Z) :- t(X, Y), Z = X ** Y.
    `);
    const sql = norm(result.createViews[0]!);
    // Guard clause must be outside POWER so the function isn't even
    // called in the domain-error cases — Postgres would otherwise
    // raise "cannot take logarithm of ..." or similar.
    expect(sql).toContain("CASE");
    expect(sql).toContain("FLOOR");
    expect(sql).toContain("< 0 AND");
    expect(sql).toContain("LN(NULLIF(ABS");
    expect(sql).not.toContain("ABS(POWER");
    expect(sql).toContain("POWER(");
  });

  test("`value` slice routes through the dialect's jsonSlice hook", () => {
    // Subscripts on json receivers hit `dialect.jsonSubscript`; slices
    // hit a separate `jsonSlice` path. Confirms the translator
    // dispatches on receiver type and that both bound forms (start
    // present, end implicit) reach the dialect's array-subset emit.
    const pg = translateSource(`
      input predicate p(j: value).
      r(S) :- p(J), S = J[1:3].
    `);
    expect(norm(pg.createViews[0]!)).toContain("jsonb_array_elements");
    // Native returns NULL for non-array receivers; Postgres would raise
    // on `jsonb_array_elements({})` without the dialect-level type guard.
    expect(norm(pg.createViews[0]!)).toContain("jsonb_typeof");

    const sqlite = translateSource(
      `input predicate p(j: value).
       r(S) :- p(J), S = J[1:3].`,
      new SqliteSqlDialect(),
    );
    expect(norm(sqlite.createViews[0]!)).toContain("json_each");
    expect(norm(sqlite.createViews[0]!)).toContain("json_group_array");
    expect(norm(sqlite.createViews[0]!)).toContain("json_type");
  });

  test("Regression: non-linear recursion error carries the offending rule's position", () => {
    // Compiling `p(X, Y) :- p(X, Z), p(Z, Y).` against a dialect
    // without non-linear-recursion support throws an `AnalyzerError`
    // — but the throw site at `translateViews` used to omit `offset`
    // and `end`, leaving the playground squiggly anchored at byte 0.
    // The offending rule is the one with multiple recursive body
    // atoms; pick its position so the user lands on the right rule.
    const source = `input predicate edge(src: string, dst: string).
path(X, Y) :- edge(X, Y).
path(X, Y) :- path(X, Z), path(Z, Y).
?- path(X, Y).
`;
    let caught: unknown;
    try {
      translate(inferTypes(analyze(parse(source))), postgres);
    } catch (e) {
      caught = e;
    }
    const err = caught as AnalyzerError;
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Non-linear recursion is not supported/);
    // The recursive rule starts on line 3 — its byte offset is the
    // start of `path(X, Y) :- path(X, Z), path(Z, Y).`.
    const ruleStart = source.indexOf("path(X, Y) :- path(X, Z)");
    expect(err.offset).toBe(ruleStart);
    expect(err.end).toBeGreaterThan(ruleStart);
  });

  test("function call with a `null` arg falls back to a first-arity-match overload", () => {
    // `null` has no static type, so `resolveCall` can't pick a unique
    // overload during type inference (for `abs`, the integer and float
    // overloads disagree on result type). The translator's fallback
    // path then picks the first arity-matching overload off the
    // registry and emits its SQL — every viable overload produces
    // semantically-equivalent SQL on a NULL input, so the choice is
    // safe. Confirms that path doesn't crash and produces ABS(NULL).
    const result = translateSource(`
      input predicate p(x: integer).
      r(X) :- p(X), X = abs(null).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("ABS(NULL)");
  });

  test("to_string emits CAST AS TEXT for numeric inputs", () => {
    const result = translateSource(`
      input predicate t(x: integer).
      r(X, S) :- t(X), S = to_string(X).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("CAST(");
    expect(sql).toContain("AS TEXT");
  });

  test("to_string of boolean renders 'true' / 'false' literally", () => {
    // SQLite has no native boolean type; CAST AS TEXT would render
    // 1/0. The CASE form keeps every backend producing identical string.
    const result = translateSource(`
      input predicate t(b: boolean).
      r(B, S) :- t(B), S = to_string(B).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("CASE WHEN");
    expect(sql).toContain("'true'");
    expect(sql).toContain("'false'");
  });

  test("to_integer goes through the dialect parse hook (Postgres regex form)", () => {
    const result = translateSource(`
      input predicate w(s: string).
      r(S, N) :- w(S), N = to_integer(S).
    `);
    const sql = norm(result.createViews[0]!);
    // Postgres uses a regex pre-check before the INTEGER cast.
    expect(sql).toContain("~");
    expect(sql).toContain("CAST((CASE WHEN");
    expect(sql).toContain("INTEGER");
  });

  test("to_float on SQLite uses the GLOB validation chain", () => {
    const result = translateSource(
      `input predicate w(s: string).
       r(S, N) :- w(S), N = to_float(S).`,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    // Distinct from Postgres's regex form: the SQLite emit is a chain
    // of GLOB rejections culminating in `CAST AS REAL`.
    expect(sql).toContain("GLOB");
    expect(sql).toContain("CAST(");
    expect(sql).toContain("AS REAL");
  });

  test("to_float on Postgres gates the double-precision cast", () => {
    const result = translateSource(`
      input predicate w(s: string).
      r(S, N) :- w(S), N = to_float(S).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("pg_input_is_valid");
    expect(sql).toContain("CAST((CASE WHEN");
    expect(sql).toContain("DOUBLE PRECISION");
  });

  test("to_boolean strictly matches 'true' / 'false' literals", () => {
    const result = translateSource(`
      input predicate w(s: string).
      r(S, B) :- w(S), B = to_boolean(S).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("'true'");
    expect(sql).toContain("'false'");
    expect(sql).toContain("CASE");
  });

  test("parse_json on Postgres gates ::jsonb cast on pg_input_is_valid", () => {
    const result = translateSource(`
      input predicate raw(s: string).
      parsed(J) :- raw(S), J = parse_json(S).
    `);
    const sql = norm(result.createViews[0]!);
    // Malformed input must NULL out, not raise — so the cast input is
    // a CASE gated by pg_input_is_valid.
    expect(sql).toContain("pg_input_is_valid");
    expect(sql).toContain("CAST((CASE WHEN");
    expect(sql).toContain("AS jsonb");
  });

  test("Regression: Postgres parse_json rejects JSON null and non-finite numeric leaves", () => {
    // Spec §2.9 collapses JSON null leaves to SQL NULL and rejects JSON
    // numbers that cannot round-trip through Datamog's finite JS-number
    // runtime. Postgres jsonb accepts both `null` and huge numeric leaves
    // like `9e999`, so the dialect must explicitly filter the parsed tree.
    const result = translateSource(`
      input predicate raw(s: string).
      parsed(J) :- raw(S), J = parse_json(S).
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("WITH RECURSIVE __datamog_parse_json");
    expect(sql).toContain("jsonb_typeof(j) <> 'null'");
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).toContain("jsonb_each");
    expect(sql).toContain("pg_input_is_valid(v #>> '{}', 'double precision')");
  });

  test("Regression: Postgres value extraction collapses JSON null leaves", () => {
    // JSON null is preserved inside compound values, but once a subscript
    // or iterator exposes that leaf as a value expression it must become
    // SQL NULL. Otherwise equality/function calls observe a Postgres-only
    // jsonb null value that native and SQLite have already collapsed.
    const result = translateSource(`
      from_subscript(V) :- J = [null], V = J[0].
      from_iter(V) :- J = [null], array_element(J, 0, V).
      kind(T) :- J = [null], T = type_of(J[0]).
      encoded(S) :- J = [null], S = to_json(J[0]).
      present(B) :- J = [null], B = has_key(J[0], "x").
    `);
    const sql = result.createViews.map(norm).join("\n");
    expect(sql).toContain("NULLIF((jsonb_build_array(NULL) -> CAST(0 AS INTEGER)), 'null'::jsonb)");
    expect(sql).toMatch(/NULLIF\(__b\d+\._v, 'null'::jsonb\)/);
    expect(sql).toContain("NULLIF(jsonb_typeof(");
    expect(sql).toContain("WHEN jsonb_typeof(");
    expect(sql).toContain("= 'null' THEN NULL");
  });

  test("parse_json on SQLite gates json() on json_valid", () => {
    const result = translateSource(
      `input predicate raw(s: string).
       parsed(J) :- raw(S), J = parse_json(S).`,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("json_valid(");
    expect(sql).toContain("json(");
  });

  test("keys / values / to_json compile on Postgres", () => {
    const result = translateSource(`
      input predicate p(j: value).
      hk(B) :- p(J), B = has_key(J, "id").
      ks(K) :- p(J), K = keys(J).
      vs(V) :- p(J), V = values(J).
      ser(S) :- p(J), S = to_json(J).
    `);
    const sql = result.createViews.map(norm).join("\n");
    // has_key: jsonb key-existence operator, gated on object type.
    expect(sql).toContain("? 'id'");
    // keys: jsonb_object_keys + sorted aggregate, gated on object type.
    expect(sql).toContain("jsonb_object_keys");
    expect(sql).toMatch(/jsonb_typeof.*= 'object'/);
    // values: jsonb_each + ORDER BY key for cross-backend determinism.
    expect(sql).toContain("jsonb_each");
    expect(sql).toContain(`ORDER BY (key COLLATE "C")`);
    // to_json: regex_replace strips the spaces jsonb::text inserts.
    expect(sql).toContain("regexp_replace");
    expect(sql).toContain("::text");
  });

  test("keys / values / to_json compile on SQLite", () => {
    const result = translateSource(
      `
      input predicate p(j: value).
      hk(B) :- p(J), B = has_key(J, "id").
      ks(K) :- p(J), K = keys(J).
      vs(V) :- p(J), V = values(J).
      ser(S) :- p(J), S = to_json(J).
    `,
      sqlite,
    );
    const sql = result.createViews.map(norm).join("\n");
    // keys / values: json_each subqueries gated on object type.
    expect(sql).toMatch(/json_type.*= 'object'/);
    expect(sql).toContain("json_each");
    expect(sql).toContain("je.key = 'id'");
    expect(sql).toContain("json_quote(key)");
    expect(sql).toContain("COLLATE BINARY");
    // to_json: stored TEXT is already canonical, no transformation.
    // The `ser` view's projection is just the column reference.
    const ser = result.createViews.find((v) => v.includes('"ser"'))!;
    expect(norm(ser)).not.toContain("regexp_replace");
  });

  test("recursive predicate with no non-recursive rule gets an empty anchor", () => {
    const result = translateTyped(`
      p(X) :- X = "hi", p(X).
    `);
    const sql = norm(result.createViews[0]!);
    // Without an anchor, Postgres and SQLite both reject the CTE
    // with "circular reference". Synthesise a zero-row SELECT so the
    // least-fixed-point semantics (empty) compiles cleanly.
    expect(sql).toContain("CAST(NULL AS TEXT) AS col1");
    expect(sql).toContain("WHERE 1 = 0");
    expect(sql).toContain("UNION");
  });

  test("queries on EDB predicates use SELECT DISTINCT for set semantics", () => {
    const result = translateSource(`
      input predicate p(a: integer, b: integer).
      ?- p(X, Y).
    `);
    const sql = norm(result.queries[0]!);
    expect(sql).toContain("SELECT DISTINCT");
  });

  test("queries on single-rule IDB predicates also use SELECT DISTINCT", () => {
    // A single-rule non-recursive IDB view inherits any duplicates from its
    // source (no UNION to dedup through). Without DISTINCT, querying such a
    // view loses Datalog's set semantics.
    const result = translateSource(`
      input predicate t(x: integer).
      q(X) :- t(X).
      ?- q(X).
    `);
    const sql = norm(result.queries[0]!);
    expect(sql).toContain("SELECT DISTINCT");
  });

  test("rejects empty bracket access 'W[]'", () => {
    // Grammar allows both `start` and `sliceColon` to be absent, which
    // produced a Subscript with no index and crashed the translator with
    // a cryptic "undefined is not an object". Reject it at post-processing.
    expect(() =>
      translateSource(`
        input predicate w(s: string).
        r(C) :- w(W), C = W[].
      `),
    ).toThrow(/Empty bracket access/);
  });

  test("rejects negated-only query atom as unsafe", () => {
    // `?- not t(X).` is now caught by the shared safety pass — `X` is
    // mentioned only inside a negated atom, so the projection
    // variable has no body binding.
    expect(() =>
      translateSource(`
        input predicate t(x: integer).
        ?- not t(X).
      `),
    ).toThrow(/Unsafe variable 'X'/);
  });

  test("Regression: U+0001 in source-literal strings doesn't corrupt span stripping", () => {
    // The translator marks AST→SQL spans by wrapping fragments with
    // the control characters U+0001 (start) and U+0002 (end). A user-
    // written string literal that happens to contain those bytes
    // would otherwise look like a span boundary to `stripSpanMarks`,
    // which would treat the bytes between them as `offset,end`, fail
    // to parse a numeric, and — most damaging — eat the float SQL that
    // sits between two stray U+0001 chars. SQL string literals are
    // bounded by `'...'` with `''` doubling for embedded quotes, so
    // the stripper can detect that it's inside a literal and ignore
    // the markers there.
    //
    // The tight reproduction: two body equalities with U+0001 in each
    // RHS literal. The two stray U+0001s sit a few chars apart in the
    // emitted SQL, the stripper bridges them as if they were a span
    // header, and the SQL between (`' AS col1, 'b`) gets consumed.
    // Build the U+0001 via a JS escape so the source-file bytes don't
    // carry a literal control character.
    const u1 = String.fromCharCode(0x01);
    const source = `foo(X, Y) :- X = "a${u1}", Y = "b${u1}c".\n?- foo(A, B).`;
    const result = translateSource(source);
    const sql = result.createViews[0]!;
    // Both column aliases should be present — pre-fix, `AS col1` was
    // eaten and the SELECT list collapsed to just one column.
    expect(sql).toContain("AS col1");
    expect(sql).toContain("AS col2");
    // Both literals should round-trip intact, with their U+0001 bytes
    // preserved (the SQL engine accepts arbitrary bytes in a literal).
    expect(sql).toContain(`'a${u1}'`);
    expect(sql).toContain(`'b${u1}c'`);
    // No NaN spans leak into the view's span list.
    for (const span of result.viewSpans[0] ?? []) {
      expect(Number.isNaN(span.astStart)).toBe(false);
      expect(Number.isNaN(span.astEnd)).toBe(false);
    }
  });

  test("array literal compiles to jsonb_build_array on Postgres", () => {
    const result = translateSource(`
      input predicate t(x: integer).
      r(X, J) :- t(X), J = [X, X + 1, X * 2].
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("jsonb_build_array");
  });

  test("object literal compiles to jsonb_build_object on Postgres with quoted keys", () => {
    const result = translateSource(`
      input predicate t(x: integer).
      r(X, J) :- t(X), J = {"x": X, "double": X * 2}.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("jsonb_build_object('x'");
    expect(sql).toContain("'double'");
  });

  test("nested object/array literal", () => {
    const result = translateSource(`
      input predicate t(x: integer).
      r(J) :- t(X), J = {"vals": [X, X + 1]}.
    `);
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("jsonb_build_object('vals'");
    expect(sql).toContain("jsonb_build_array");
  });
});

describe("translator (sqlite dialect)", () => {
  test("generates CREATE VIEW IF NOT EXISTS for non-recursive rule", () => {
    const result = translateSource(
      `
      input predicate parent(name: string, child: string).
      grandparent(X, Y) :- parent(X, Z), parent(Z, Y).
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS");
    expect(sql).not.toContain("OR REPLACE");
    expect(sql).not.toContain("RECURSIVE");
  });

  test("generates WITH RECURSIVE inside CREATE VIEW for recursive rule", () => {
    const result = translateSource(
      `
      input predicate parent(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS");
    expect(sql).toContain("WITH RECURSIVE");
    expect(sql).toContain('SELECT * FROM "ancestor"');
  });

  test("generates recursive CTE for binding range (sqlite)", () => {
    const result = translateTyped(
      `
      nums(X) :- X in [1 .. 5].
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    // SQLite uses a recursive CTE subquery instead of generate_series
    expect(sql).toContain("WITH RECURSIVE");
    expect(sql).toContain('"value"');
    expect(sql).toContain(">= 1");
    expect(sql).toContain("<= 5");
    expect(sql).not.toContain("generate_series");
  });

  test("sqlite range with literal integer bounds inlines them in the CTE", () => {
    const result = translateTyped(
      `
      nums(X) :- X in [0 .. 15000].
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    // The CTE should terminate at the literal upper bound, not the old
    // hard-coded 10000 that silently truncated the range.
    expect(sql).toContain('"value" < 15000');
    expect(sql).not.toContain('"value" < 10000');
  });

  test("sqlite range with correlated high bound uses exact correlated generation", () => {
    const result = translateTyped(
      `
      input predicate base(n: integer).
      nums(N, X) :- base(N), X in [0 .. N - 1].
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    // SQLite FROM-subqueries are not lateral, but json_each arguments are
    // correlated. The range should therefore use an exact per-row recursive
    // CTE rather than a fixed fallback cap that silently truncates large
    // dynamic ranges.
    expect(sql).toContain("json_each((WITH RECURSIVE");
    expect(sql).toContain('"value" < (__b0."n" - 1)');
    expect(sql).not.toContain("1000000");
    expect(sql).toContain('<= (__b0."n" - 1)');
  });

  test("sqlite range with a negative integer literal lower bound", () => {
    // The translator emits `(-3)` (UnaryExpr-wrapped) for a negative
    // literal. Without recognising that as an integer literal the
    // anchor silently falls back to 0 and the generated series misses
    // the negative portion of the range.
    const result = translateTyped(
      `
      r(X) :- X in [-3 .. 2].
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain('SELECT -3 AS "value"');
    expect(sql).toContain('"value" < 2');
  });

  test("generates GROUP_CONCAT for concat (sqlite)", () => {
    const result = translateSource(
      `
      input predicate items(group_name: string, item: string).
      concat_items(G, concat(I)) :- items(G, I).
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("GROUP_CONCAT(");
    expect(sql).not.toContain("STRING_AGG");
    // ORDER BY makes the per-group output deterministic on SQLite too.
    expect(sql).toMatch(/ORDER BY/i);
  });

  test("generates JSON_GROUP_ARRAY for list with `value` arg (sqlite)", () => {
    const result = translateSource(
      `
      input predicate events(group_name: string, payload: value).
      collected(G, list(P)) :- events(G, P).
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("JSON_GROUP_ARRAY(");
    expect(sql).not.toContain("JSONB_AGG");
    // Inner `json(...)` parses the canonical-TEXT json so the
    // grouped array nests structural values rather than escaping
    // them as string literals.
    expect(sql).toMatch(/JSON_GROUP_ARRAY\(json\(/i);
    // ORDER BY (canonical-TEXT) gives a per-group order matching the
    // native evaluator and Postgres's C-collated jsonb text ordering.
    expect(sql).toMatch(/ORDER BY/i);
    expect(sql).toContain("COLLATE BINARY");
    // FILTER skips SQL NULL inputs; outer NULLIF maps an all-NULL
    // group's `'[]'` back to SQL NULL so list returns NULL on empty
    // groups, matching concat and the rest of the family.
    expect(sql).toMatch(/FILTER \(WHERE/i);
    expect(sql).toMatch(/NULLIF\(/i);
  });

  test("generates JSON_GROUP_ARRAY with json_quote for string list (sqlite)", () => {
    // String columns lift via `json_quote` to add surrounding quotes.
    // The FILTER must reference the raw `argSql`, not the quoted
    // form, because `json_quote(NULL)` returns the JSON `'null'` text
    // rather than SQL NULL — without this, all-NULL groups would
    // emit a JSON `null` per row.
    const result = translateSource(
      `
      input predicate t(g: string, w: string).
      collected(G, list(W)) :- t(G, W).
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("JSON_GROUP_ARRAY(");
    expect(sql).toContain("json_quote(");
    expect(sql).toMatch(/FILTER \(WHERE/i);
    // ORDER BY references the raw argument, not the json_quote'd
    // form — string columns sort by their natural lex order.
    expect(sql).not.toMatch(/ORDER BY .*json_quote/i);
  });

  test("generates CREATE VIEW IF NOT EXISTS for aggregate rule (sqlite)", () => {
    const result = translateSource(
      `
      input predicate parent(name: string, child: string).
      num_children(P, count(C)) :- parent(P, C).
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS");
    expect(sql).toContain("COUNT(");
    expect(sql).toContain("GROUP BY");
  });

  test("rejects non-linear recursion", () => {
    expect(() =>
      translateSource(
        `
      input predicate edge(src: string, dst: string).
      tc(X, Y) :- edge(X, Y).
      tc(X, Z) :- tc(X, Y), tc(Y, Z).
    `,
        sqlite,
      ),
    ).toThrow(/Non-linear recursion is not supported by sqlite.*'tc'/);
  });

  test("generates WITH RECURSIVE for mutual recursion", () => {
    const result = translateSource(
      `
      input predicate base(x: integer).
      even(X) :- base(X).
      even(X) :- odd(X).
      odd(X) :- even(X).
    `,
      sqlite,
    );
    expect(result.createViews).toHaveLength(2);
    const evenView = result.createViews.find((v) => norm(v).includes('NOT EXISTS "even"'));
    expect(evenView).toBeDefined();
    const sql = norm(evenView!);
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS");
    expect(sql).toContain("WITH RECURSIVE");
    // SQLite uses a combined CTE with tag discrimination for mutual recursion
    expect(sql).toContain("__tag");
    expect(sql).toContain("'even'");
    expect(sql).toContain("'odd'");
  });

  test("mutual recursion pads the SELECT list, not the tail of the body", () => {
    // With predicates of differing arity, smaller predicates need NULL
    // padding to match the combined CTE's column count. Those NULLs must
    // live in the SELECT list (before FROM) — appending them to the whole
    // body put them after the WHERE clause and produced invalid SQL.
    const result = translateTyped(
      `
      input predicate base(x: integer).
      a(X) :- base(X).
      a(X) :- b(X, X).
      b(X, Y) :- a(X), Y = X + 1.
    `,
      sqlite,
    );
    const allSql = result.createViews.map(norm).join("\n");
    // The padding NULL for predicate `a` (arity 1 vs combined 2) should
    // appear in the SELECT list of a-tagged branches, right before FROM.
    expect(allSql).toMatch(/SELECT 'a' AS __tag,[^;]*?,\s*NULL\s+FROM/);
    // And must NOT appear dangling at the end of a branch (after FROM or
    // a WHERE clause) — that was the original bug.
    expect(allSql).not.toMatch(/NULL\s*(?:UNION|\))/);
  });

  test("mutual recursion CTE strips the SELECT token past leading span markers", () => {
    const result = translateSource(
      `
      input predicate base(x: integer).
      even(X) :- base(X).
      even(X) :- odd(X).
      odd(X) :- even(X).
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    // If the `SELECT ` prefix isn't stripped, the combined CTE rows end up
    // as `SELECT 'even' AS __tag, SELECT ...` — a syntax error. The correct
    // form has exactly one SELECT per UNION branch.
    expect(sql).not.toMatch(/SELECT '(?:even|odd)' AS __tag, SELECT /);
  });

  test("self-recursive rule works when the recursive rule appears first", () => {
    const result = translateSource(
      `
      input predicate e(a: integer, b: integer).
      path(X, Z) :- path(X, Y), e(Y, Z).
      path(X, Y) :- e(X, Y).
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    // SQLite requires the non-recursive anchor before the recursive term in
    // a WITH RECURSIVE UNION. The translator must reorder.
    const anchorIdx = sql.indexOf('FROM "e" AS __b0 UNION');
    const recIdx = sql.indexOf('FROM "path" AS');
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(recIdx).toBeGreaterThan(-1);
    expect(anchorIdx).toBeLessThan(recIdx);
  });

  test("array literal with value-typed element wraps with json() to mark as JSON", () => {
    const result = translateSource(
      `
      input predicate t(j: value).
      r(JJ) :- t(J), JJ = [J, J].
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    expect(sql).toContain("json_array(json(");
  });

  test("object literal compiles to json_object on SQLite with quoted keys, sorted in jsonb order", () => {
    const result = translateSource(
      `
      input predicate t(x: integer).
      r(X, J) :- t(X), J = {"b": X, "aa": X * 2, "a": X + 1}.
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    // Keys are sorted by the dialect so two literals that differ only
    // in source order produce the same canonical text. The order must
    // match Postgres jsonb canonicalisation: byte length first, then byte
    // value, so "a", "b", "aa" rather than JS's "a", "aa", "b".
    expect(sql).toContain("json_object('a'");
    expect(sql.indexOf("'a'")).toBeLessThan(sql.indexOf("'b'"));
    expect(sql.indexOf("'b'")).toBeLessThan(sql.indexOf("'aa'"));
  });

  test("array literal with boolean elements lifts via json() so true/false survive", () => {
    const result = translateSource(
      `
      r(J) :- J = [true, false].
    `,
      sqlite,
    );
    const sql = norm(result.createViews[0]!);
    // SQLite stores booleans as 0/1; the dialect must lift via toJson +
    // json() so the JSON renders as true/false rather than 1/0.
    expect(sql).toContain("json_array(json(");
    expect(sql).toContain("'true'");
    expect(sql).toContain("'false'");
  });
});

describe("translator — source maps", () => {
  test("emits a span per positive body atom", () => {
    const source = `input predicate edge(src: string, dst: string).
reach(X) :- edge("a", X), edge(X, "b").`;
    const result = translate(inferTypes(analyze(parse(source))), sqlite);
    const [sql] = result.createViews;
    const [spans] = result.viewSpans;
    expect(sql).toBeDefined();
    expect(spans).toBeDefined();

    // Atom spans should point at the exact `edge(...)` substrings in the source.
    const atomStart1 = source.indexOf('edge("a", X)');
    const atomEnd1 = atomStart1 + 'edge("a", X)'.length;
    const atomStart2 = source.indexOf("edge(X, ", atomEnd1);
    const atomEnd2 = atomStart2 + 'edge(X, "b")'.length;

    const atomSpans = spans!.filter(
      (s) =>
        (s.astStart === atomStart1 && s.astEnd === atomEnd1) ||
        (s.astStart === atomStart2 && s.astEnd === atomEnd2),
    );
    // Two atoms, each contributing at least the FROM alias.
    expect(atomSpans.length).toBeGreaterThanOrEqual(2);

    // Each atom span covers a float substring of the emitted SQL.
    for (const s of atomSpans) {
      expect(s.sqlStart).toBeLessThan(s.sqlEnd);
      expect(s.sqlEnd).toBeLessThanOrEqual(sql!.length);
      expect(sql!.slice(s.sqlStart, s.sqlEnd)).toContain("__b");
    }
  });

  test("emits a span for the head atom and for the whole rule", () => {
    const source = `input predicate edge(src: string, dst: string).
reach(X) :- edge("a", X).`;
    const result = translate(inferTypes(analyze(parse(source))), sqlite);
    const [spans] = result.viewSpans;

    const headStart = source.indexOf("reach(X)");
    const headEnd = headStart + "reach(X)".length;
    expect(spans!.some((s) => s.astStart === headStart && s.astEnd === headEnd)).toBe(true);

    const ruleStart = headStart;
    const ruleEnd = source.indexOf(".", ruleStart) + 1;
    expect(spans!.some((s) => s.astStart === ruleStart && s.astEnd === ruleEnd)).toBe(true);
  });

  test("strips span markers from the visible SQL", () => {
    const result = translate(
      inferTypes(
        analyze(
          parse(`input predicate edge(src: string, dst: string).
reach(X) :- edge("a", X).`),
        ),
      ),
      sqlite,
    );
    expect(result.createViews[0]!).not.toContain("\u0001");
    expect(result.createViews[0]!).not.toContain("\u0002");
  });

  test("marks query atoms", () => {
    const source = `input predicate edge(src: string, dst: string).
reach(X) :- edge("a", X).
?- reach(X).`;
    const result = translate(inferTypes(analyze(parse(source))), sqlite);
    const [spans] = result.querySpans;
    const queryStart = source.indexOf("?- reach(X).");
    const queryEnd = queryStart + "?- reach(X).".length;
    expect(spans!.some((s) => s.astStart === queryStart && s.astEnd === queryEnd)).toBe(true);
  });
});

describe("translator — null literal and logical equality", () => {
  test("null literal emits SQL NULL on every dialect", () => {
    const source = `input predicate t(a: integer, b: integer).
maybe(X, B) :- t(X, _), B = (X = null).
?- maybe(X, B).`;
    for (const d of [sqlite, postgres]) {
      const result = translateTyped(source, d);
      // The view body should contain a literal NULL somewhere — we don't
      // pin the exact formatting because each dialect wraps differently.
      expect(result.createViews.join("\n")).toContain("NULL");
    }
  });

  test("`=` (logical equality) emits IS / IS NOT DISTINCT FROM per dialect", () => {
    // Nullable columns: with non-null ones the plain `=` agrees and is emitted
    // instead, which the nullness test below covers.
    const source = `input predicate t(a: integer?, b: integer?).
q(X, Y) :- t(X, Y), X = Y.
?- q(X, Y).`;
    const sqliteSql = translateTyped(source, sqlite).createViews.join("\n");
    expect(sqliteSql).toContain(" IS ");
    expect(sqliteSql).not.toContain(" IS NOT DISTINCT FROM ");

    const pgSql = translateTyped(source, postgres).createViews.join("\n");
    expect(pgSql).toContain("IS NOT DISTINCT FROM");
  });

  test("`<>` (logical inequality) emits IS NOT / IS DISTINCT FROM per dialect", () => {
    const source = `input predicate t(a: integer, b: integer).
q(X, Y) :- t(X, Y), X <> Y.
?- q(X, Y).`;
    const sqliteSql = translateTyped(source, sqlite).createViews.join("\n");
    expect(sqliteSql).toContain(" IS NOT ");

    const pgSql = translateTyped(source, postgres).createViews.join("\n");
    expect(pgSql).toContain("IS DISTINCT FROM");
  });

  test("a repeated variable joins like a spelled-out `=`, whatever the nullness", () => {
    // The two forms denote the same relation, so they must emit the same
    // operator. See doc/design/null.md §4. Which operator that is depends on
    // whether a NULL can reach the join, so check both declarations: the
    // invariant is that the two spellings agree, not that either operator is
    // always the one emitted.
    const cases = [
      { columns: "a: integer, b: integer", expected: '__b0."a" = __b0."b"' },
      { columns: "a: integer?, b: integer?", expected: '__b0."a" IS __b0."b"' },
    ];
    for (const { columns, expected } of cases) {
      const shared = `input predicate t(${columns}).
q(X, Y) :- t(X, Y), X = Y.
?- q(X, Y).`;
      const repeated = `input predicate t(${columns}).
q(X, X) :- t(X, X).
?- q(X, Y).`;
      for (const source of [shared, repeated]) {
        const sql = translateTyped(source, sqlite).createViews.join("\n");
        expect(sql).toContain(expected);
      }
    }
  });
});

describe("bitwise / shift operators", () => {
  const expr = (op: string, dialect: SqlDialect): string => {
    const result = translateSource(
      `
      input predicate t(x: integer, y: integer).
      r(X, Y, Z) :- t(X, Y), Z = X ${op} Y.
    `,
      dialect,
    );
    return norm(result.createViews[0]!).match(/SELECT (.*?) FROM/)![1]!;
  };

  test("Postgres: &, | pass through; XOR is spelled #", () => {
    expect(expr("&", postgres)).toContain('((__b0."x") & (__b0."y"))');
    expect(expr("|", postgres)).toContain('((__b0."x") | (__b0."y"))');
    // Postgres `^` is exponentiation; bitwise XOR is `#`.
    expect(expr("^", postgres)).toContain('((__b0."x") # (__b0."y"))');
  });

  test("Postgres: shift count is masked mod 32; >> is the native shift", () => {
    expect(expr("<<", postgres)).toContain('((__b0."x") << ((__b0."y") & 31))');
    expect(expr(">>", postgres)).toContain('((__b0."x") >> ((__b0."y") & 31))');
  });

  test("Postgres: >>> masks to unsigned 32-bit in bigint and reinterprets as int", () => {
    const sql = expr(">>>", postgres);
    expect(sql).toContain('(__b0."x")::bigint & 4294967295');
    expect(sql).toContain(")::int");
  });

  test("SQLite: XOR is emulated since SQLite has no ^ operator", () => {
    const sql = expr("^", sqlite);
    expect(sql).not.toContain("#");
    expect(sql).toContain('(((__b0."x") | (__b0."y")) & ~((__b0."x") & (__b0."y")))');
  });

  test("SQLite: << masks the count and wraps the 64-bit result to int32", () => {
    const sql = expr("<<", sqlite);
    expect(sql).toContain('(__b0."x") << ((__b0."y") & 31)');
    // int32 reinterpret wrap (no XOR operator needed — pure arithmetic).
    expect(sql).toContain("& 4294967295) + 2147483648) & 4294967295) - 2147483648");
  });

  test("SQLite: >> is the native arithmetic shift with a masked count", () => {
    expect(expr(">>", sqlite)).toContain('((__b0."x") >> ((__b0."y") & 31))');
  });

  test("SQLite: >>> masks the operand to unsigned 32-bit then wraps", () => {
    expect(expr(">>>", sqlite)).toContain('((__b0."x") & 4294967295) >> ((__b0."y") & 31)');
  });
});
