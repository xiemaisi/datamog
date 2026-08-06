import { describe, expect, test } from "bun:test";
import { type IterationCapInfo, addRow, create, makeRelation } from "datamog-backend-native";
import type { ExtDecl } from "datamog-core";
import {
  DatamogExecutor,
  type ExtensionalLoader,
  type LoadResult,
  insertRows,
} from "datamog-engine";

async function run(source: string): Promise<Record<string, unknown>[][]> {
  const backend = await create();
  const executor = new DatamogExecutor(backend);
  try {
    const results = await executor.execute(source);
    return results.map((r) => r.rows);
  } finally {
    await backend.close();
  }
}

function sortRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function runCapped(
  source: string,
  maxIterations: number,
): Promise<{ rows: Record<string, unknown>[][]; capInfo: IterationCapInfo | undefined }> {
  let capInfo: IterationCapInfo | undefined;
  const backend = await create({
    maxIterations,
    onIterationCap: (info) => {
      capInfo = info;
    },
  });
  try {
    const results = await new DatamogExecutor(backend).execute(source);
    return { rows: results.map((r) => r.rows), capInfo };
  } finally {
    await backend.close();
  }
}

describe("native backend — iteration cap", () => {
  test("stops a runaway arithmetic recursion and reports the growing predicate", async () => {
    // s counts up forever; the cap turns the hang into a bounded prefix.
    const source = `
      seed(0).
      s(X) :- seed(X).
      s(Y) :- s(X), Y = X + 1.
      ?- s(N).
    `;
    const { rows, capInfo } = await runCapped(source, 5);
    expect(capInfo).toBeDefined();
    expect(capInfo?.predicates).toContain("s");
    expect(capInfo?.iteration).toBe(5);
    // 5 passes over `s(Y) :- s(X), Y = X + 1` starting from {0} yield {0..4}.
    expect(rows[0]).toHaveLength(5);
  });

  test("a converging program is unaffected by a generous cap", async () => {
    const source = `
      edge(1, 2).
      edge(2, 3).
      edge(3, 4).
      path(A, B) :- edge(A, B).
      path(A, C) :- edge(A, B), path(B, C).
      ?- path(A, B).
    `;
    const { rows, capInfo } = await runCapped(source, 50);
    expect(capInfo).toBeUndefined();
    // 3 direct edges + closure {(1,3),(1,4),(2,4)} = 6 pairs.
    expect(rows[0]).toHaveLength(6);
  });
});

describe("native backend — basics", () => {
  test("Regression: relation keys distinguish JSON string leaves from compounds", () => {
    // Relation dedup uses a string key per tuple. The key builder used to
    // canonicalise compound JSON values but leave primitive string leaves
    // raw before the outer JSON.stringify, so the value string "[1]" and
    // the array [1] both keyed as ["[1]"] and one tuple was dropped.
    const rel = makeRelation();
    expect(addRow(rel, ["[1]"])).toBe(true);
    expect(addRow(rel, [[1]])).toBe(true);
    expect(addRow(rel, ["{}"])).toBe(true);
    expect(addRow(rel, [{}])).toBe(true);
    expect(rel.tuples).toEqual([["[1]"], [[1]], ["{}"], [{}]]);
  });

  test("Regression: native facts keep JSON strings and matching compounds distinct", async () => {
    // The relation-key collision was visible through ordinary fact
    // insertion too: once the predicate widened to `value`, the JSON string
    // leaf "[1]" and the array [1] hashed to the same tuple key and one
    // fact disappeared.
    const results = await run(`
      p("[1]").
      p([1]).
      p("{}").
      p({}).
      ?- p(X).
    `);
    expect(sortRows(results[0]!)).toEqual(
      sortRows([{ X: "[1]" }, { X: [1] }, { X: "{}" }, { X: {} }]),
    );
  });

  test("facts and a simple non-recursive rule", async () => {
    const results = await run(`
      parent("alice", "bob").
      parent("alice", "carol").
      parent("bob", "dave").

      child(Y, X) :- parent(X, Y).

      ?- child(Y, "alice").
    `);
    expect(sortRows(results[0]!)).toEqual([{ Y: "bob" }, { Y: "carol" }]);
  });

  test("recursive transitive closure", async () => {
    const results = await run(`
      edge(1, 2).
      edge(2, 3).
      edge(3, 4).

      tc(X, Y) :- edge(X, Y).
      tc(X, Y) :- edge(X, Z), tc(Z, Y).

      ?- tc(1, Y).
    `);
    expect(sortRows(results[0]!)).toEqual([{ Y: 2 }, { Y: 3 }, { Y: 4 }]);
  });

  test("ground query against an EDB returns the empty-tuple `yes` row when matched", async () => {
    // No projected variables → the only output is the empty row,
    // signalling "yes" / "the query is satisfied". A miss produces
    // zero rows.
    const hit = await run(`
      p(1).
      p(2).
      ?- p(2).
    `);
    expect(hit[0]).toEqual([{}]);

    const miss = await run(`
      p(1).
      ?- p(2).
    `);
    expect(miss[0]).toEqual([]);
  });

  test("query repeats the same variable — tuple must match in both positions", async () => {
    const results = await run(`
      edge(1, 1).
      edge(1, 2).
      edge(2, 2).
      ?- edge(X, X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 2 }]);
  });
});

describe("native backend — stratified negation", () => {
  test("not p(X) filters out matching rows", async () => {
    const results = await run(`
      all(1). all(2). all(3). all(4).
      excluded(2). excluded(4).
      kept(X) :- all(X), not excluded(X).
      ?- kept(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 3 }]);
  });

  test("not X = Y negates a built-in comparison atom", async () => {
    const results = await run(`
      u(1). u(2).
      distinct(X, Y) :- u(X), u(Y), not X = Y.
      ?- distinct(X, Y).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { X: 1, Y: 2 },
      { X: 2, Y: 1 },
    ]);
  });

  test("not Age < Bound negates an ordering atom", async () => {
    const results = await run(`
      person("alice", 30). person("bob", 15). person("carol", 18).
      adult(N) :- person(N, Age), not Age < 18.
      ?- adult(N).
    `);
    expect(sortRows(results[0]!)).toEqual([{ N: "alice" }, { N: "carol" }]);
  });
});

describe("native backend — aggregates", () => {
  test("sum grouped by key", async () => {
    const results = await run(`
      scores("alice", 10).
      scores("alice", 20).
      scores("bob", 5).
      totals(S, sum(N)) :- scores(S, N).
      ?- totals(S, T).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { S: "alice", T: 30 },
      { S: "bob", T: 5 },
    ]);
  });

  test("count(*) counts rows regardless of value", async () => {
    const results = await run(`
      observed(1). observed(2). observed(3).
      n(count(*)) :- observed(_).
      ?- n(N).
    `);
    expect(results[0]).toEqual([{ N: 3 }]);
  });

  test("min / max / avg / concat", async () => {
    const results = await run(`
      scores("alice", 10). scores("alice", 30). scores("alice", 20).
      stats(S, min(N), max(N), avg(N), concat(N)) :- scores(S, N).
      ?- stats(S, Lo, Hi, Avg, All).
    `);
    const row = results[0]![0]!;
    expect(row.S).toEqual("alice");
    expect(row.Lo).toEqual(10);
    expect(row.Hi).toEqual(30);
    expect(row.Avg).toEqual(20);
    // concat is now order-stabilised across backends — values are
    // sorted by the natural ordering of their type (numeric here), then
    // comma-joined.
    expect(row.All).toEqual("10,20,30");
  });

  test("concat sorts numerically, not lexicographically", async () => {
    // Two-digit values let us tell numeric and lex orders apart: lex
    // would put "10" before "2" (the strings compare char-by-char).
    const results = await run(`
      t(2). t(10). t(7).
      joined(concat(N)) :- t(N).
      ?- joined(All).
    `);
    expect(results[0]![0]!.All).toEqual("2,7,10");
  });

  test("list collects `value`s sorted by canonical text", async () => {
    // Build `value`s via ArrayLiteral so the column is value-typed,
    // then aggregate. Sorting by the canonical-JSON text form puts
    // `[1,2]` before `[1,3]` and `[2,1]`. The result is a JSON array
    // (a `JsonValue[]`), not the comma-joined string `concat`
    // would produce.
    const results = await run(`
      raw("alice", 1, 3). raw("alice", 1, 2). raw("alice", 2, 1).
      tagged(S, [A, B]) :- raw(S, A, B).
      collected(S, list(J)) :- tagged(S, J).
      ?- collected(S, L).
    `);
    expect(results[0]![0]!.S).toEqual("alice");
    expect(results[0]![0]!.L).toEqual([
      [1, 2],
      [1, 3],
      [2, 1],
    ]);
  });

  test("Regression: value aggregates sort canonical text by Unicode code point", async () => {
    // Canonical JSON text is still a Datamog string for aggregate ordering.
    // JS's native string comparison would put the high-surrogate pair for
    // 😀 before U+FFFF, while SQL's portable text order puts U+FFFF first.
    const results = await run(`
      data(["😀"]).
      data(["￿"]).
      cat(concat(J)) :- data(J).
      vals(list(J)) :- data(J).
      ?- cat(C).
      output predicate vl(L) :- vals(L).
    `);
    expect(results[0]).toEqual([{ C: '["￿"],["😀"]' }]);
    expect(results[1]).toEqual([{ L: [["￿"], ["😀"]] }]);
  });

  test("list returns NULL when every group row is NULL", async () => {
    // Match the rest of the aggregate family: an all-NULL group
    // collapses to NULL rather than `[]`. `parse_json("not json")`
    // produces SQL NULL on the native side, giving us a deterministic
    // way to seed all-NULL groups.
    const results = await run(`
      bad("alice"). bad("alice").
      with_null(S, J) :- bad(S), J = parse_json("not json").
      collected(S, list(J)) :- with_null(S, J).
      ?- collected(S, L).
    `);
    expect(results[0]![0]!.L).toBeNull();
  });

  test("list auto-promotes integer arguments and sorts numerically", async () => {
    // Two-digit values let us tell numeric and lex orders apart, just
    // as in the parallel concat test: lex would put 10 before 2.
    const results = await run(`
      t(2). t(10). t(7).
      collected(list(N)) :- t(N).
      ?- collected(L).
    `);
    expect(results[0]![0]!.L).toEqual([2, 7, 10]);
  });

  test("list auto-promotes string arguments", async () => {
    const results = await run(`
      t("carol"). t("alice"). t("bob").
      collected(list(W)) :- t(W).
      ?- collected(L).
    `);
    expect(results[0]![0]!.L).toEqual(["alice", "bob", "carol"]);
  });

  test("list auto-promotes boolean arguments (false before true)", async () => {
    // Distinct keys keep both `true` rows in the relation — Datalog
    // has set semantics, so `t(true). t(true).` would collapse.
    const results = await run(`
      t(1, true). t(2, true). t(3, false).
      collected(list(B)) :- t(_, B).
      ?- collected(L).
    `);
    expect(results[0]![0]!.L).toEqual([false, true, true]);
  });
});

describe("native backend — expressions", () => {
  test("divide-by-zero returns NULL", async () => {
    const results = await run(`
      n(0). n(2). n(4).
      half(X, Y) :- n(X), Y = X / 0.
      ?- half(X, Y).
    `);
    // All three map to NULL — tuples dedup via JSON; (0,null),(2,null),(4,null).
    expect(sortRows(results[0]!)).toEqual([
      { X: 0, Y: null },
      { X: 2, Y: null },
      { X: 4, Y: null },
    ]);
  });

  test("integer vs float division matches type inference", async () => {
    const results = await run(`
      iv(7).
      q(R) :- iv(X), R = X / 2.
      ?- q(R).
    `);
    // Both operands integer → truncating division.
    expect(results[0]).toEqual([{ R: 3 }]);
  });

  test("float division when either operand is float", async () => {
    const results = await run(`
      rv(7.0).
      q(R) :- rv(X), R = X / 2.
      ?- q(R).
    `);
    expect(results[0]).toEqual([{ R: 3.5 }]);
  });

  test("binding range over integers", async () => {
    const results = await run(`
      n(X) :- X in [1 .. 3].
      ?- n(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 2 }, { X: 3 }]);
  });

  test("string concatenation with +", async () => {
    const results = await run(`
      greet("alice"). greet("bob").
      hello(S) :- greet(N), S = "hi " + N.
      ?- hello(S).
    `);
    expect(sortRows(results[0]!)).toEqual([{ S: "hi alice" }, { S: "hi bob" }]);
  });

  test("subscript and slice", async () => {
    const results = await run(`
      word("hello").
      r(A, B) :- word(W), A = W[0], B = W[1:3].
      ?- r(A, B).
    `);
    expect(results[0]).toEqual([{ A: "h", B: "el" }]);
  });

  test("sqrt of negative returns NULL", async () => {
    const results = await run(`
      nums(-4.0). nums(9.0).
      r(X, Y) :- nums(X), Y = sqrt(X).
      ?- r(X, Y).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { X: -4, Y: null },
      { X: 9, Y: 3 },
    ]);
  });
});

describe("native backend — recursion shapes", () => {
  test("non-linear recursion (pairwise sum) reaches fixed point", async () => {
    // Starting from {2}, repeated pairwise sums bounded by 16 saturate
    // to every even number in [2, 16] — the evaluator must keep iterating
    // until no new tuples appear.
    const results = await run(`
      base(2).
      reach(X) :- base(X).
      reach(Z) :- reach(X), reach(Y), Z = X + Y, Z <= 16.
      ?- reach(X).
    `);
    const got = new Set(results[0]!.map((r) => r.X));
    expect(got).toEqual(new Set([2, 4, 6, 8, 10, 12, 14, 16]));
  });

  test("mutual recursion", async () => {
    const results = await run(`
      base(0).
      even(X) :- base(X).
      even(X) :- odd(Y), X = Y + 1, X <= 6.
      odd(X) :- even(Y), X = Y + 1, X <= 6.
      ?- even(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 0 }, { X: 2 }, { X: 4 }, { X: 6 }]);
  });
});

describe("native backend — body elements", () => {
  test("constant argument in body atom filters by that column", async () => {
    const results = await run(`
      p(1, "a"). p(2, "b"). p(3, "a").
      q(X) :- p(X, "a").
      ?- q(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 3 }]);
  });

  // The planner hoists a computed atom argument into a fresh variable plus
  // an equality (`gcd(A-B, B, N)` -> `gcd(H, B, N), H = A-B`), so the
  // argument may reference a variable bound anywhere in the body regardless
  // of source order. These cases all diverge from the SQL backends unless
  // that hoisting happens.
  test("computed atom arg references a var bound by another position of the same atom", async () => {
    // `A-B` in `gcd(A-B, B, N)` reads B, bound by the second position of the
    // same atom. Subtraction gcd of (6, 4): 6-4=2, then 4-2=2 -> gcd(2,2,2).
    const results = await run(`
      num(N) :- N in [1..10].
      gcd(A, A, A) :- num(A).
      gcd(A, B, N) :- num(A), gcd(A-B, B, N).
      gcd(A, B, N) :- num(B), gcd(A, B-A, N).
      ?- gcd(6, 4, N).
    `);
    expect(sortRows(results[0]!)).toEqual([{ N: 2 }]);
  });

  test("computed atom arg references a var bound by a later atom", async () => {
    // `s(X+Y)` appears before the atoms binding X and Y.
    const results = await run(`
      a(1). a(2). a(3).
      b(10). b(20).
      s(11). s(22).
      p(X, Y) :- s(X+Y), a(X), b(Y).
      ?- p(X, Y).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { X: 1, Y: 10 },
      { X: 2, Y: 20 },
    ]);
  });

  test("computed atom arg references a var bound by an equality", async () => {
    // `val(K*N)` references N, bound by the equality `N = 2`.
    const results = await run(`
      num(1). num(2). num(3).
      val(4). val(6).
      p(K) :- N = 2, num(K), val(K * N).
      ?- p(K).
    `);
    expect(sortRows(results[0]!)).toEqual([{ K: 2 }, { K: 3 }]);
  });

  test("computed atom args that reference each other across two atoms", async () => {
    // `p(X, Y+1), q(Y, X+1)` is a cycle: p's second arg needs Y (from q) and
    // q's second arg needs X (from p). Hoisting both into filters lets the
    // atoms bind X and Y first, then the constraints check as filters.
    const results = await run(`
      p(1, 3).
      q(2, 2).
      r(X, Y) :- p(X, Y+1), q(Y, X+1).
      ?- r(X, Y).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1, Y: 2 }]);
  });

  test("computed atom arg matching a NULL column joins null-aware", async () => {
    // `n(A, A/0)` stores a NULL second column (divide by zero) and the body
    // atom `n(A, 1/0)` computes NULL for that position. Atom matching is
    // null-aware, so the two NULLs match and every row survives. The
    // hoisted constraint uses `=`, the language's only equality, so a
    // hoisted argument behaves exactly like an unhoisted one.
    const results = await run(`
      e(1). e(2).
      n(A, A/0) :- e(A).
      p(A) :- e(A), n(A, 1/0).
      ?- p(A).
    `);
    expect(sortRows(results[0]!)).toEqual([{ A: 1 }, { A: 2 }]);
  });

  test("anonymous variables stand for distinct any-values", async () => {
    // Two `_` in the same atom do NOT imply equality — they desugar to
    // distinct fresh names, so every tuple matches regardless of column 2.
    const results = await run(`
      p(1, 10). p(1, 20). p(2, 30).
      q(X) :- p(X, _).
      ?- q(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 2 }]);
  });

  test("all comparison operators", async () => {
    const results = await run(`
      n(1). n(2). n(3). n(4). n(5).
      lt(X, Y) :- n(X), n(Y), X < Y, X = 2.

      ?- lt(X, Y).
      output predicate le(X, Y) :- n(X), n(Y), X <= Y, X = 2.
      output predicate gt(X, Y) :- n(X), n(Y), X > Y, X = 4.
      output predicate ge(X, Y) :- n(X), n(Y), X >= Y, X = 4.
      output predicate ne(X, Y) :- n(X), n(Y), X <> Y, X = 3.
    `);
    expect(sortRows(results[0]!)).toEqual([
      { X: 2, Y: 3 },
      { X: 2, Y: 4 },
      { X: 2, Y: 5 },
    ]);
    expect(sortRows(results[1]!)).toEqual([
      { X: 2, Y: 2 },
      { X: 2, Y: 3 },
      { X: 2, Y: 4 },
      { X: 2, Y: 5 },
    ]);
    expect(sortRows(results[2]!)).toEqual([
      { X: 4, Y: 1 },
      { X: 4, Y: 2 },
      { X: 4, Y: 3 },
    ]);
    expect(sortRows(results[3]!)).toEqual([
      { X: 4, Y: 1 },
      { X: 4, Y: 2 },
      { X: 4, Y: 3 },
      { X: 4, Y: 4 },
    ]);
    expect(sortRows(results[4]!)).toEqual([
      { X: 3, Y: 1 },
      { X: 3, Y: 2 },
      { X: 3, Y: 4 },
      { X: 3, Y: 5 },
    ]);
  });

  test("filter range constrains an already-bound variable", async () => {
    const results = await run(`
      n(1). n(3). n(5). n(7). n(9).
      mid(X) :- n(X), X in [3 .. 7].
      ?- mid(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 3 }, { X: 5 }, { X: 7 }]);
  });

  test("negation with multi-column atom and partial binding", async () => {
    const results = await run(`
      edge("a", "b"). edge("a", "c"). edge("b", "c").
      node("a"). node("b"). node("c").
      source(X) :- node(X), not edge(_, X).
      ?- source(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: "a" }]);
  });

  test("forward-reference binding: equality can use a var bound by a later atom", async () => {
    // Y is bound by atom `p(Y)`, but the equality `Z = Y + 1` appears before
    // the atom in source order. The planner's readiness loop schedules the
    // equality after Y is available.
    const results = await run(`
      p(10). p(20).
      q(Z) :- Z = Y + 1, p(Y).
      ?- q(Z).
    `);
    expect(sortRows(results[0]!)).toEqual([{ Z: 11 }, { Z: 21 }]);
  });

  test("non-binding equality as a constraint", async () => {
    // When the LHS is a complex expression, equality acts as a filter.
    const results = await run(`
      p(1, 2). p(3, 7). p(4, 5).
      sumEq(X, Y) :- p(X, Y), X + Y = 10.
      ?- sumEq(X, Y).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 3, Y: 7 }]);
  });

  test("default plus named outputs run in declaration order", async () => {
    const results = await run(`
      p(1). p(2). p(3).
      ?- p(1).
      output predicate px(X) :- p(X).
    `);
    expect(results.length).toBe(2);
    expect(results[0]).toEqual([{}]);
    expect(sortRows(results[1]!)).toEqual([{ X: 1 }, { X: 2 }, { X: 3 }]);
  });

  test("identical tuples produced by different rules are deduplicated", async () => {
    const results = await run(`
      a(1). a(2).
      b(2). b(3).
      r(X) :- a(X).
      r(X) :- b(X).
      ?- r(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 2 }, { X: 3 }]);
  });
});

describe("native backend — built-in functions", () => {
  test("string functions: upper, lower, trim, replace, length", async () => {
    const results = await run(`
      s("  Hello World  ").
      r(U, L, T, R, N) :-
        s(X),
        U = upper(X),
        L = lower(X),
        T = trim(X),
        R = replace(X, "World", "Datalog"),
        N = length(X).
      ?- r(U, L, T, R, N).
    `);
    expect(results[0]).toEqual([
      {
        U: "  HELLO WORLD  ",
        L: "  hello world  ",
        T: "Hello World",
        R: "  Hello Datalog  ",
        N: 15,
      },
    ]);
  });

  test("Regression: upper/lower only fold ASCII letters", async () => {
    // SQLite's built-in UPPER/LOWER only case-fold ASCII letters; JS
    // `toUpperCase` / `toLowerCase` case-fold Unicode too (`é` → `É`,
    // `ß` → `SS`). Native used the JS calls directly, so non-ASCII
    // strings diverged from SQLite. Datamog's portable string functions
    // now leave non-ASCII code points unchanged while still folding A-Z.
    const results = await run(`
      r(A, B, C, D) :-
        A = upper("éclair"),
        B = lower("ÉCLAIR"),
        C = upper("straße"),
        D = lower("HELLO").
      ?- r(A, B, C, D).
    `);
    expect(results[0]).toEqual([{ A: "éCLAIR", B: "Éclair", C: "STRAßE", D: "hello" }]);
  });

  test("Regression: string ordering follows Unicode code point order", async () => {
    // JS compares strings by UTF-16 code unit, so a non-BMP character
    // such as U+1F600 (😀, represented as a high surrogate followed by
    // a low surrogate) sorts before U+FFFF (￿). SQLite's binary UTF-8
    // collation sorts by Unicode code point, where U+FFFF < U+1F600.
    // Native comparisons and string aggregate ordering now mirror the
    // portable backend order instead of JS's default `<`.
    const results = await run(`
      s("😀").
      s("￿").
      cmp(L, G) :- L = ("😀" < "￿"), G = ("😀" > "￿").
      agg(min(S), max(S), concat(S), list(S)) :- s(S).
      ?- cmp(L, G).
      output predicate ag(Min, Max, Joined, Listed) :- agg(Min, Max, Joined, Listed).
    `);
    expect(results[0]).toEqual([{ L: false, G: true }]);
    expect(results[1]).toEqual([{ Min: "￿", Max: "😀", Joined: "￿,😀", Listed: ["￿", "😀"] }]);
  });

  test("math functions: abs, round, floor, ceil, exp", async () => {
    const results = await run(`
      r(A, Rn, F, C, E) :-
        A = abs(-3),
        Rn = round(3.7),
        F = floor(3.7),
        C = ceil(3.2),
        E = exp(0).
      ?- r(A, Rn, F, C, E).
    `);
    expect(results[0]).toEqual([{ A: 3, Rn: 4, F: 3, C: 4, E: 1 }]);
  });

  test("round with two args is float-valued", async () => {
    const results = await run(`
      r(X) :- X = round(3.14159, 2).
      ?- r(X).
    `);
    expect(results[0]).toEqual([{ X: 3.14 }]);
  });

  test("Regression: round half-values away from zero (matches SQL ROUND, not JS Math.round)", async () => {
    // JS `Math.round(-0.5)` is `0` — it rounds half toward +Infinity.
    // SQLite's `ROUND(-0.5)` is `-1` — round half away from zero. The
    // native evaluator used `Math.round` directly, so a program with
    // negative half-values produced different integer columns on
    // native vs SQL backends. Spec §6 promises identical output, and
    // the SQL convention is the more common one. Switch native to
    // round half away from zero (`sign(x) * Math.round(abs(x))`).
    const results = await run(`
      r(A, B, C, D, E, F) :-
        A = round(0.5),
        B = round(-0.5),
        C = round(1.5),
        D = round(-1.5),
        E = round(2.5),
        F = round(-2.5).
      ?- r(A, B, C, D, E, F).
    `);
    expect(results[0]).toEqual([{ A: 1, B: -1, C: 2, D: -2, E: 3, F: -3 }]);
  });

  test("Regression: round/2 also rounds half away from zero", async () => {
    // `round(x, n)` shares the same half-tie-break with `round(x)`.
    // Without the fix, `round(-0.05, 1)` was 0 on native and -0.1 on
    // SQL.
    const results = await run(`
      r(A, B) :- A = round(0.05, 1), B = round(-0.05, 1).
      ?- r(A, B).
    `);
    expect(results[0]).toEqual([{ A: 0.1, B: -0.1 }]);
  });

  test("Regression: round/2 supports negative precision", async () => {
    // SQLite's two-argument ROUND ignores negative precision, so
    // `round(123.45, -1)` came back as 123 on SQL while native rounded
    // to the nearest ten. Pin the intended decimal-place semantics here:
    // negative n rounds to the left of the decimal point.
    const results = await run(`
      r(A, B, C, D, E, F, G) :-
        A = round(123.45, -1),
        B = round(15.0, -1),
        C = round(149, -2),
        D = round(1.23, 400),
        E = round(1.23, -400),
        F = round(1.0 / 0.0, -400),
        G = round(1.23, 1 / 0).
      ?- r(A, B, C, D, E, F, G).
    `);
    expect(results[0]).toEqual([{ A: 120, B: 20, C: 100, D: 1.23, E: 0, F: null, G: null }]);
  });

  test("ln of non-positive returns NULL", async () => {
    const results = await run(`
      v(-1.0). v(0.0). v(1.0).
      r(X, L) :- v(X), L = ln(X).
      ?- r(X, L).
    `);
    // Order across sortRows isn't meaningful for this case (numbers keyed by
    // JSON string compare unpredictably for negatives); assert as a set.
    const rows = results[0]!;
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.X === 1)?.L).toBe(0);
    expect(rows.find((r) => r.X === -1)?.L).toBe(null);
    expect(rows.find((r) => r.X === 0)?.L).toBe(null);
  });

  test("** edge cases: fractional exponent on negative base → NULL", async () => {
    const results = await run(`
      r(P) :- P = (-2.0) ** 0.5.
      ?- r(P).
    `);
    expect(results[0]).toEqual([{ P: null }]);
  });

  test("** edge case: zero base with negative exponent → NULL", async () => {
    const results = await run(`
      r(P) :- P = 0.0 ** (-1.0).
      ?- r(P).
    `);
    expect(results[0]).toEqual([{ P: null }]);
  });

  test("Regression: exp(huge) returns NULL on overflow, not Infinity", async () => {
    // `Math.exp(1000)` produces JS `Infinity`, an IEEE special value.
    // Spec §5.4's design principle is that runtime-partial operations
    // yield NULL rather than IEEE specials, so semantics agree across
    // every backend. The original `exp.float` impl returned `Math.exp(x)`
    // unguarded, so a literal that captured the result —
    // `J = [exp(1000.0)]` — silently collapsed to `[null]` via
    // `JSON.stringify`'s Infinity-to-null coercion (when the
    // ArrayLiteral case round-trips through `canonicalizeJson`), giving
    // the user no signal that the input had overflowed. Match the
    // `as_float.value` validator's `Number.isFinite` gate so non-finite
    // results are surfaced as NULL explicitly.
    const results = await run(`
      r(P) :- P = exp(1000.0).
      ?- r(P).
    `);
    expect(results[0]).toEqual([{ P: null }]);
  });

  test("Regression: bare float arithmetic overflow returns NULL", async () => {
    // The expression language should stay total over finite inputs:
    // overflow is represented as NULL at the arithmetic operation, not
    // as an IEEE Infinity that only gets scrubbed later by JSON/value
    // construction boundaries.
    const factors = new Array(37).fill("1000000000.0").join(" * ");
    const results = await run(`
      r(P) :- P = ${factors}.
      ?- r(P).
    `);
    expect(results[0]).toEqual([{ P: null }]);
  });

  test("Regression: ** with overflowing result returns NULL", async () => {
    // Same shape as exp overflow: `2.0 ** 2000.0` produces JS
    // `Infinity`. The `**` guards cover the explicit domain errors
    // (negative base + fractional exp, zero base + negative exp) and
    // overflow.
    const results = await run(`
      r(P) :- P = 2.0 ** 2000.0.
      ?- r(P).
    `);
    expect(results[0]).toEqual([{ P: null }]);
  });

  test("** with valid inputs evaluates normally", async () => {
    const results = await run(`
      r(P) :- P = 2.0 ** 3.0.
      ?- r(P).
    `);
    expect(results[0]).toEqual([{ P: 8 }]);
  });

  test("parse_json on inline string returns the parsed `value`", async () => {
    const results = await run(`
      r(J) :- J = parse_json("{\\"a\\":1,\\"b\\":2}").
      ?- r(J).
    `);
    // Object keys are canonicalised (sorted) on the native path so
    // structural equality with EDB-loaded JSON agrees.
    expect(results[0]).toEqual([{ J: { a: 1, b: 2 } }]);
  });

  test("parse_json on malformed input returns NULL", async () => {
    const results = await run(`
      r(J) :- J = parse_json("not json").
      ?- r(J).
    `);
    expect(results[0]).toEqual([{ J: null }]);
  });

  test("Regression: parse_json rejects non-finite numeric leaves", async () => {
    // `JSON.parse("[9e999]")` yields `[Infinity]` in JS. The native
    // parser used to canonicalise that through JSON.stringify, silently
    // replacing the leaf with JSON null. Match the loaders and SQL
    // backends instead: non-finite numeric leaves make parse_json return
    // SQL NULL for the whole input.
    const results = await run(`
      r(J) :- J = parse_json("[9e999]").
      ?- r(J).
    `);
    expect(results[0]).toEqual([{ J: null }]);
  });

  test("parse_json sorts object keys (matches Postgres jsonb canonicalisation)", async () => {
    const results = await run(`
      r(J) :- J = parse_json("{\\"b\\":1,\\"a\\":2}").
      ?- r(J).
    `);
    // The user-visible parsed object should have keys in sorted order
    // — same canonical form as values inserted via the EDB pipeline.
    const j = results[0]![0]!.J as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["a", "b"]);
  });

  test("Regression: canonical JSON uses Postgres jsonb object-key order", async () => {
    // jsonb stores object keys in UTF-8 byte-length order, then byte order:
    // "a", "b", "aa". JS's default object-key sort would put "aa"
    // before "b", so native `to_json` and canonical value storage diverged
    // from the Postgres backend for otherwise identical object literals.
    const results = await run(`
      r(J, S) :- J = {"b": 2, "aa": 1, "a": 3}, S = to_json(J).
      ?- r(J, S).
    `);
    const j = results[0]![0]!.J as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["a", "b", "aa"]);
    expect(results[0]![0]!.S).toBe('{"a":3,"b":2,"aa":1}');
  });

  test("Regression: keys / values sort object keys by Unicode code point", async () => {
    // JS's default string sort uses UTF-16 code units, where 😀 sorts
    // before ￿ because the high surrogate is smaller than U+FFFF.
    // SQL backends use binary UTF-8/C collation for portable string
    // order, which follows Unicode code point order: U+FFFF < U+1F600.
    const results = await run(`
      r(K, V) :- J = {"😀": 1, "￿": 2}, K = keys(J), V = values(J).
      ?- r(K, V).
    `);
    expect(results[0]).toEqual([{ K: ["￿", "😀"], V: [2, 1] }]);
  });

  test("mod operator and mod by zero", async () => {
    const results = await run(`
      n(10). n(7). n(3).
      r(X, M, Z) :- n(X), M = X % 3, Z = X % 0.
      ?- r(X, M, Z).
    `);
    const rows = results[0]!;
    expect(rows.length).toBe(3);
    // Mod by zero → NULL for every row.
    for (const row of rows) expect(row.Z).toBe(null);
    // Mod by 3 matches the integer remainder.
    const byX = new Map(rows.map((r) => [r.X, r.M]));
    expect(byX.get(10)).toBe(1);
    expect(byX.get(7)).toBe(1);
    expect(byX.get(3)).toBe(0);
  });

  test("array literal builds a JSON array, mixing primitive types and null", async () => {
    const results = await run(`
      r(J) :- J = [1, "two", true, null].
      ?- r(J).
    `);
    expect(results[0]).toEqual([{ J: [1, "two", true, null] }]);
  });

  test("object literal canonicalises key order", async () => {
    const results = await run(`
      r(J) :- J = {"b": 2, "a": 1}.
      ?- r(J).
    `);
    const j = results[0]![0]!.J as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["a", "b"]);
  });

  test("array literal can be subscripted directly", async () => {
    const results = await run(`
      r(V) :- V = as_integer([10, 20, 30][1]).
      ?- r(V).
    `);
    expect(results[0]).toEqual([{ V: 20 }]);
  });
});

describe("native backend — subscript & slice edges", () => {
  test("subscript out of bounds returns empty string", async () => {
    const results = await run(`
      w("abc").
      r(A, B) :- w(W), A = W[10], B = W[0].
      ?- r(A, B).
    `);
    expect(results[0]).toEqual([{ A: "", B: "a" }]);
  });

  test("slice with missing start defaults to 0", async () => {
    const results = await run(`
      w("hello").
      r(A) :- w(W), A = W[:3].
      ?- r(A).
    `);
    expect(results[0]).toEqual([{ A: "hel" }]);
  });

  test("slice with missing end defaults to length", async () => {
    const results = await run(`
      w("hello").
      r(A) :- w(W), A = W[2:].
      ?- r(A).
    `);
    expect(results[0]).toEqual([{ A: "llo" }]);
  });

  test("slice with end <= start returns empty string", async () => {
    const results = await run(`
      w("hello").
      r(A) :- w(W), A = W[3:3], X = W[4:2].
      ?- r(A).
    `);
    // Both A and X would be empty; the rule has only A in the head.
    expect(results[0]).toEqual([{ A: "" }]);
  });
});

describe("native backend — aggregate edges", () => {
  test("ungrouped aggregate over empty body yields one default row (matches SQL)", async () => {
    // SQL emits one row from `SELECT agg(...) FROM empty` (no GROUP BY) —
    // sum is NULL, count would be 0. The native backend mirrors that so
    // a `total(sum(X))` rule produces the same one-row result on every
    // backend, even when no body tuples exist.
    const results = await run(`
      p(X) :- X in [1 .. 0].
      total(sum(X)) :- p(X).
      ?- total(T).
    `);
    expect(results[0]).toEqual([{ T: null }]);
  });

  test("a literal-bound head variable keeps its value in the empty-group row", async () => {
    // `G = "all"` is the spelled-out form of the literal head argument below, so
    // both must derive the same tuple (null.md §4). The empty group has no
    // substitution to read `G` from, so its value comes from the binding.
    const spelledOut = await run(`
      p(X) :- X in [1 .. 0].
      total(G, sum(X)) :- p(X), G = "all".
      ?- total(G, T).
    `);
    const literal = await run(`
      p(X) :- X in [1 .. 0].
      total("all", sum(X)) :- p(X).
      ?- total(G, T).
    `);
    expect(spelledOut[0]).toEqual([{ G: "all", T: null }]);
    expect(spelledOut[0]).toEqual(literal[0]);
  });

  test("a literal filter on an atom-bound group emits no empty-group row", async () => {
    const results = await run(`
      input predicate p(g: string).
      q(G, count(*)) :- p(G), G = "all".
      ?- q(G, N).
    `);
    expect(results[0]).toEqual([]);
  });

  test("aggregate with grouping columns over empty body still yields no rows", async () => {
    // With at least one non-aggregate head position, an empty body produces
    // no groups and therefore no output rows — same as `GROUP BY ...` in SQL.
    const results = await run(`
      p(X) :- X in [1 .. 0].
      grouped(X, sum(X)) :- p(X).
      ?- grouped(X, T).
    `);
    expect(results[0]).toEqual([]);
  });

  test("count(X) ignores NULL arguments; count(*) counts all rows", async () => {
    // v(X, Y) where Y=X/0 is always null for X≠0.
    const results = await run(`
      v(1). v(2). v(3).
      q(X, Y) :- v(X), Y = X / 0.
      cnt(count(Y)) :- q(_, Y).
      star(count(*)) :- q(_, _).
      ?- cnt(N).
      output predicate st(N) :- star(N).
    `);
    expect(results[0]).toEqual([{ N: 0 }]);
    expect(results[1]).toEqual([{ N: 3 }]);
  });

  test("aggregate over a computed expression", async () => {
    // sum should reduce over `X + Y`, not just a bare variable.
    const results = await run(`
      p(1, 2). p(3, 4). p(5, 6).
      tot(sum(X + Y)) :- p(X, Y).
      ?- tot(T).
    `);
    // (1+2) + (3+4) + (5+6) = 21
    expect(results[0]).toEqual([{ T: 21 }]);
  });

  test("concat joins values across a group", async () => {
    const results = await run(`
      t("a", 1). t("a", 2). t("a", 3).
      joined(K, concat(N)) :- t(K, N).
      ?- joined(K, G).
    `);
    expect(results[0]!.length).toBe(1);
    expect(results[0]![0]!.K).toEqual("a");
    // concat is order-stabilised across backends — values come
    // out sorted by their natural ordering.
    expect(results[0]![0]!.G).toEqual("1,2,3");
  });
});

describe("native backend — more body shapes", () => {
  test("same variable in two positions of a single atom", async () => {
    // Repeating `X` in both columns constrains the atom to tuples where
    // both columns hold the same value (self-loops in a graph).
    const results = await run(`
      edge(1, 1). edge(1, 2). edge(2, 2). edge(2, 3).
      loop(X) :- edge(X, X).
      ?- loop(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 2 }]);
  });

  test("self-join: two body atoms of the same predicate", async () => {
    // Classic grandparent rule — parent appears twice in the body.
    const results = await run(`
      parent("a", "b"). parent("b", "c"). parent("c", "d").
      grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
      ?- grandparent(X, Z).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { X: "a", Z: "c" },
      { X: "b", Z: "d" },
    ]);
  });

  test("lexicographic comparison on string values", async () => {
    const results = await run(`
      w("cat"). w("ant"). w("bat"). w("dog").
      low(S) :- w(S), S < "c".
      ?- low(S).
    `);
    expect(sortRows(results[0]!)).toEqual([{ S: "ant" }, { S: "bat" }]);
  });

  test("boolean column values flow through equality comparisons", async () => {
    // Datamog has no boolean literal in source, so booleans reach the
    // evaluator only via loaders. We feed rows through an inline loader
    // and verify comparison-by-equality against another boolean column.
    const { create } = await import("datamog-backend-native");
    const { DatamogExecutor, insertRows } = await import("datamog-engine");

    const backend = await create();
    const executor = new DatamogExecutor(backend, [
      {
        name: "flag-fixture",
        async canLoad(decl) {
          return decl.predicate === "flag";
        },
        async load(decl, b) {
          await insertRows(b, decl, [
            { name: "alice", on: true, target: true },
            { name: "bob", on: false, target: true },
            { name: "carol", on: true, target: true },
          ]);
          return { rowsLoaded: 3 };
        },
      },
    ]);
    try {
      const results = await executor.execute(`
        input predicate flag(name: string, on: boolean, target: boolean).
        matched(N) :- flag(N, B, B).
        ?- matched(N).
      `);
      expect(sortRows(results[0]!.rows)).toEqual([{ N: "alice" }, { N: "carol" }]);
    } finally {
      await backend.close();
    }
  });

  test("negated atom with constant arguments", async () => {
    // `not p(X, "excluded")` filters X values that have a matching tuple
    // in the second column.
    const results = await run(`
      status("a", "ok"). status("b", "excluded"). status("c", "ok").
      admitted(X) :- status(X, _), not status(X, "excluded").
      ?- admitted(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: "a" }, { X: "c" }]);
  });

  test("unary minus in an arithmetic expression", async () => {
    const results = await run(`
      n(3). n(7).
      r(X, Y) :- n(X), Y = -X + 1.
      ?- r(X, Y).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { X: 3, Y: -2 },
      { X: 7, Y: -6 },
    ]);
  });

  test("range with a computed upper bound", async () => {
    // Upper bound depends on a variable bound by an atom, exercising the
    // planner's readiness-based scheduling of range steps.
    const results = await run(`
      word("abcd").
      at(I, C) :- word(W), I in [0 .. length(W) - 1], C = W[I].
      ?- at(I, C).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { C: "a", I: 0 },
      { C: "b", I: 1 },
      { C: "c", I: 2 },
      { C: "d", I: 3 },
    ]);
  });

  test("expression-binding chain across forward references", async () => {
    // B's RHS references A; A's RHS references C; C is bound by the atom.
    // All three sit above the atom in source order, so the planner must
    // iterate readiness until every binding is schedulable.
    const results = await run(`
      n(5).
      r(A, B) :- B = A + 1, A = C * 2, n(C).
      ?- r(A, B).
    `);
    expect(results[0]).toEqual([{ A: 10, B: 11 }]);
  });
});

describe("native backend — stratification and dependency depth", () => {
  test("negation against a recursively-computed predicate", async () => {
    // `tc` is recursive (linear); `unreachable` sits one stratum above it
    // and negates over the fully-computed `tc`. Stratification is what
    // makes this safe, and the evaluator must process tc to fixed point
    // *before* evaluating unreachable.
    const results = await run(`
      node("a"). node("b"). node("c"). node("d").
      edge("a", "b"). edge("b", "c").

      tc(X, Y) :- edge(X, Y).
      tc(X, Y) :- edge(X, Z), tc(Z, Y).

      unreachable(X, Y) :- node(X), node(Y), X <> Y, not tc(X, Y).
      ?- unreachable("a", Y).
    `);
    // From "a", tc reaches {b, c}. Unreachable = {d}; X <> Y rules out "a".
    expect(sortRows(results[0]!)).toEqual([{ Y: "d" }]);
  });

  test("non-recursive chain deeper than two rules", async () => {
    // a ← b ← c ← d. Tests that the stratum ordering propagates values
    // through a chain of non-recursive predicates.
    const results = await run(`
      d(1). d(2). d(3).
      c(X) :- d(X), X > 1.
      b(X) :- c(X).
      a(X) :- b(X).
      ?- a(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 2 }, { X: 3 }]);
  });

  test("EDB with no matching loader stays empty and yields no rows", async () => {
    // `extensional` declares a table; there's no loader here, so the
    // evaluator leaves the relation empty. Rules over it should compute
    // to the empty set without error.
    const results = await run(`
      input predicate raw(x: integer).
      derived(X) :- raw(X), X > 0.
      ?- derived(X).
    `);
    expect(results[0]).toEqual([]);
  });
});

describe("native backend — more expression & aggregate coverage", () => {
  test("two binding ranges produce a cartesian product", async () => {
    const results = await run(`
      pair(X, Y) :- X in [1 .. 2], Y in [10 .. 12].
      ?- pair(X, Y).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { X: 1, Y: 10 },
      { X: 1, Y: 11 },
      { X: 1, Y: 12 },
      { X: 2, Y: 10 },
      { X: 2, Y: 11 },
      { X: 2, Y: 12 },
    ]);
  });

  test("aggregate grouped by multiple keys", async () => {
    const results = await run(`
      sale("a", "red", 1).  sale("a", "red", 4).
      sale("a", "blue", 2).
      sale("b", "red", 3).
      totals(S, C, sum(N)) :- sale(S, C, N).
      ?- totals(S, C, T).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { C: "blue", S: "a", T: 2 },
      { C: "red", S: "a", T: 5 },
      { C: "red", S: "b", T: 3 },
    ]);
  });

  test("nested function calls evaluate inside-out", async () => {
    const results = await run(`
      s("  Hello  ").
      r(X) :- s(W), X = upper(trim(W)).
      ?- r(X).
    `);
    expect(results[0]).toEqual([{ X: "HELLO" }]);
  });

  test("+ concatenates a string and a numeric operand", async () => {
    const results = await run(`
      score(42).
      label(L) :- score(N), L = "n=" + N.
      ?- label(L).
    `);
    expect(results[0]).toEqual([{ L: "n=42" }]);
  });

  test("min and max over string values use lexicographic order", async () => {
    const results = await run(`
      w("cat"). w("ant"). w("dog"). w("bat").
      bounds(min(S), max(S)) :- w(S).
      ?- bounds(Lo, Hi).
    `);
    expect(results[0]).toEqual([{ Lo: "ant", Hi: "dog" }]);
  });

  test("sum and avg over float-typed values return float totals", async () => {
    const results = await run(`
      p(1.5). p(2.5). p(3.0).
      stats(sum(X), avg(X)) :- p(X).
      ?- stats(S, A).
    `);
    expect(results[0]).toEqual([{ S: 7, A: 7 / 3 }]);
  });
});

describe("native backend — query plumbing", () => {
  test("QueryResult.source carries the original Datalog query string", async () => {
    // The CLI's table output depends on this; a regression would silently
    // blank the `-- <header>` line for native runs.
    const { create } = await import("datamog-backend-native");
    const { DatamogExecutor } = await import("datamog-engine");
    const backend = await create();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        p(1). p(2).
        ?- p(X).
      `);
      expect(results[0]!.source).toBeDefined();
      expect(results[0]!.source).toContain("?- p(X).");
      expect(results[0]!.sql).toBe("");
    } finally {
      await backend.close();
    }
  });
});

describe("native backend — backend lifecycle", () => {
  test("a single backend instance supports repeated execute() calls", async () => {
    const { create } = await import("datamog-backend-native");
    const { DatamogExecutor } = await import("datamog-engine");
    const backend = await create();
    const executor = new DatamogExecutor(backend);
    try {
      const first = await executor.execute(`
        p(1). p(2).
        ?- p(X).
      `);
      expect(sortRows(first[0]!.rows)).toEqual([{ X: 1 }, { X: 2 }]);

      // Running a completely different program on the same backend
      // instance must not leak relations from the first run.
      const second = await executor.execute(`
        q("a"). q("b"). q("c").
        ?- q(Y).
      `);
      expect(sortRows(second[0]!.rows)).toEqual([{ Y: "a" }, { Y: "b" }, { Y: "c" }]);
    } finally {
      await backend.close();
    }
  });

  test("insertRows feeds rows into the EDB via the loader interface", async () => {
    // Minimal ExtensionalLoader that forwards hand-built rows through
    // insertRows; exercises the Backend.insertRows hook end-to-end.
    const { create } = await import("datamog-backend-native");
    const { DatamogExecutor, insertRows } = await import("datamog-engine");

    const backend = await create();
    const executor = new DatamogExecutor(backend, [
      {
        name: "fixture",
        async canLoad(decl) {
          return decl.predicate === "score";
        },
        async load(decl, b) {
          await insertRows(b, decl, [
            { name: "alice", n: 10 },
            { name: "bob", n: 25 },
          ]);
          return { rowsLoaded: 2 };
        },
      },
    ]);
    try {
      const results = await executor.execute(`
        input predicate score(name: string, n: integer).
        winners(Who) :- score(Who, N), N > 15.
        ?- winners(Who).
      `);
      expect(sortRows(results[0]!.rows)).toEqual([{ Who: "bob" }]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: direct insertRows after a completed run feeds the next execute", async () => {
    // `createEvaluatorBackend` kept the previous evaluator instance after
    // execute() returned, so a later direct insertRows() appended to stale
    // program state. If the next program used a different input predicate
    // predicate this threw immediately; if it reused a predicate name, the
    // inserted rows were silently lost when the next evaluator was created.
    const { create } = await import("datamog-backend-native");
    const { DatamogExecutor, insertRows } = await import("datamog-engine");

    const backend = await create();
    const executor = new DatamogExecutor(backend);
    try {
      await executor.execute("p(1). ?- p(X).");

      const source = `
        input predicate score(name: string, n: integer).
        ?- score(Name, N).
      `;
      const decl = DatamogExecutor.prepare(source).extDecls.get("score")!;
      await insertRows(backend, decl, [{ name: "alice", n: 10 }]);

      const results = await executor.execute(source);
      expect(results[0]!.rows).toEqual([{ Name: "alice", N: 10 }]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: close during loader ingestion does not leak rows into the next run", async () => {
    // `close()` cleared the evaluator and buffered rows, but left the
    // in-loader accepting-inserts flag set. If an async loader resumed after
    // close, its rows were buffered and replayed into the next execute on the
    // same backend.
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const loader: ExtensionalLoader = {
      name: "slow",
      async canLoad(): Promise<boolean> {
        return true;
      },
      async load(decl: ExtDecl, backend): Promise<LoadResult> {
        await loadGate;
        await insertRows(backend, decl, [{ x: 1 }]);
        return { rowsLoaded: 1 };
      },
    };

    const { create } = await import("datamog-backend-native");
    const backend = await create();
    const executor = new DatamogExecutor(backend, [loader]);
    const first = executor.execute(`
      input predicate p(x: integer).
      ?- p(X).
    `);
    await Promise.resolve();
    await backend.close();
    releaseLoad();

    await expect(first).rejects.toThrow(/closed/);
    await expect(
      executor.execute(`
        input predicate p(x: integer).
        ?- p(X).
      `),
    ).rejects.toThrow(/closed/);
  });
});

describe("native backend — NULL semantics (§5.4)", () => {
  test("filter drops a row when its comparison produces NULL", async () => {
    // `10 / X` is NULL when X = 0, so `10/X > 0` is NULL, which the
    // filter treats as "doesn't match" — the X=0 row is dropped. The
    // X=2 and X=4 rows survive (10/X is 5 and 2 respectively, both > 0).
    // Without 3VL filtering, the X=0 row would either survive (NULL →
    // true) or raise (NULL coercion error).
    const results = await run(`
      t(0). t(2). t(4).
      q(X) :- t(X), 10 / X > 0.
      ?- q(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 2 }, { X: 4 }]);
  });

  test("binding equality keeps a row when the bound value is NULL", async () => {
    // `Y = 1/X` binds Y even if the RHS is NULL. The row is NOT dropped;
    // Y just carries NULL into the head. Without this, dividing-by-zero
    // would silently lose rows.
    const results = await run(`
      t(0). t(2). t(4).
      q(X, Y) :- t(X), Y = 1 / X.
      ?- q(X, Y).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { X: 0, Y: null },
      { X: 2, Y: 0 },
      { X: 4, Y: 0 },
    ]);
  });

  test("`null` literal, null-aware `=` / `<>`, and total ordering", async () => {
    // Comparison is total: `=` / `<>` are null-aware (`null = null` is
    // true), and ordering treats null as an isolated point, so `Y < 1` is
    // false rather than null for the NULL row. See doc/design/null.md §5.
    const results = await run(`
      t(0). t(1). t(2).
      maybe_null(X, Y, IsNull, Below, AtMost) :-
        t(X),
        Y = 1 / X,
        IsNull = (Y = null),
        Below = (Y < 1),
        AtMost = (Y <= Y).

      ?- maybe_null(X, Y, IsNull, Below, AtMost).
      output predicate filter_logical(X) :- t(X), Y = 1 / X, Y = null.
      output predicate neq_logical(X)    :- t(X), Y = 1 / X, Y <> null.
      output predicate not_below(X)      :- t(X), Y = 1 / X, not (Y < 1).
    `);
    // For X=0, Y is null. For X=1,2, Y is integer (integer/integer
    // truncates: 1/1=1, 1/2=0). `Y <= Y` is reflexive even at null.
    expect(sortRows(results[0]!)).toEqual([
      { X: 0, Y: null, IsNull: true, Below: false, AtMost: true },
      { X: 1, Y: 1, IsNull: false, Below: false, AtMost: true },
      { X: 2, Y: 0, IsNull: false, Below: true, AtMost: true },
    ]);
    // `Y = null` keeps the X=0 row, drops the others.
    expect(results[1]).toEqual([{ X: 0 }]);
    // `Y <> null` is the inverse of `Y = null`.
    expect(sortRows(results[2]!)).toEqual([{ X: 1 }, { X: 2 }]);
    // `not (Y < 1)` complements `Y < 1`, the NULL row included.
    expect(sortRows(results[3]!)).toEqual([{ X: 0 }, { X: 1 }]);
  });

  test("`!=` is the same operator as `<>`, null-awareness included", async () => {
    // A spelling, not a second operator: normalised away in `parseRaw`, so
    // it cannot drift from `<>`. Notably `Y != null` is true/false, never
    // null, because there is only the one null-aware inequality.
    const results = await run(`
      t(0). t(1).
      p(X, Y) :- t(X), Y = 1 / X.
      ?- p(A, B), p(C, D), B != D.
      output predicate angle(A, B, C, D) :- p(A, B), p(C, D), B <> D.
      output predicate guard(X) :- p(X, Y), Y != null.
    `);
    expect(sortRows(results[0]!)).toEqual(sortRows(results[1]!));
    expect(sortRows(results[0]!)).toEqual([
      { A: 0, B: null, C: 1, D: 1 },
      { A: 1, B: 1, C: 0, D: null },
    ]);
    expect(results[2]).toEqual([{ X: 1 }]);
  });

  test("all-NULL aggregate group: sum/avg/min/max/concat → NULL", async () => {
    // Group 1 has every row's expression evaluate to NULL (1/0); group
    // 2 has well-defined values. Per §5.4, all-NULL groups produce NULL
    // for these aggregates rather than 0 or an error.
    const results = await run(`
      t(1, 0). t(1, 0). t(2, 1). t(2, 2).
      sums(G, sum(Y))           :- t(G, V), Y = 1 / V.
      avgs(G, avg(Y))           :- t(G, V), Y = 1 / V.
      mins(G, min(Y))           :- t(G, V), Y = 1 / V.
      maxs(G, max(Y))           :- t(G, V), Y = 1 / V.
      cats(G, concat(Y))  :- t(G, V), Y = 1 / V.
      ?- sums(G, T).
      output predicate av(G, T) :- avgs(G, T).
      output predicate mn(G, T) :- mins(G, T).
      output predicate mx(G, T) :- maxs(G, T).
      output predicate ct(G, T) :- cats(G, T).
    `);
    // Group 2: 1/1=1, 1/2=0 (integer division truncates), so sum=1,
    // avg=0.5, min=0, max=1, concat="0,1".
    expect(sortRows(results[0]!)).toEqual([
      { G: 1, T: null },
      { G: 2, T: 1 },
    ]);
    expect(sortRows(results[1]!)).toEqual([
      { G: 1, T: null },
      { G: 2, T: 0.5 },
    ]);
    expect(sortRows(results[2]!)).toEqual([
      { G: 1, T: null },
      { G: 2, T: 0 },
    ]);
    expect(sortRows(results[3]!)).toEqual([
      { G: 1, T: null },
      { G: 2, T: 1 },
    ]);
    expect(sortRows(results[4]!)).toEqual([
      { G: 1, T: null },
      { G: 2, T: "0,1" },
    ]);
  });
});

describe("native backend — conjunctive queries", () => {
  test("two-literal join query projects both variables", async () => {
    const results = await run(`
      parent("alice", "bob").
      parent("bob", "carol").
      ?- parent(P, C), parent(C, GC).
    `);
    expect(sortRows(results[0]!)).toEqual([{ P: "alice", C: "bob", GC: "carol" }]);
  });

  test("query body equality binds and projects the new variable", async () => {
    const results = await run(`
      t(10). t(20).
      ?- t(X), Y = X + 1.
    `);
    expect(sortRows(results[0]!)).toEqual([
      { X: 10, Y: 11 },
      { X: 20, Y: 21 },
    ]);
  });

  test("query body filter narrows the projection", async () => {
    const results = await run(`
      t(1). t(5). t(10).
      ?- t(X), X > 3.
    `);
    // sortRows uses JSON-string sort, so `{"X":10}` < `{"X":5}`.
    expect(sortRows(results[0]!)).toEqual([{ X: 10 }, { X: 5 }]);
  });

  test("query body range generates rows directly", async () => {
    const results = await run(`
      ?- I in [1 .. 3].
    `);
    expect(sortRows(results[0]!)).toEqual([{ I: 1 }, { I: 2 }, { I: 3 }]);
  });

  test("safe negated literal in query body excludes matches", async () => {
    const results = await run(`
      t(1). t(2). t(3).
      excluded(2).
      ?- t(X), not excluded(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 3 }]);
  });

  test("anonymous _ in multi-literal query body is not projected", async () => {
    const results = await run(`
      parent("alice", "bob").
      parent("bob", "carol").
      parent("dave", "eve").
      ?- parent("alice", C), parent(C, _).
    `);
    // C is the only projected column; the join with the second
    // parent atom filters out C='bob' only — and "carol" has no
    // recorded children, so we get bob only via the alice->bob,
    // bob->carol chain. The `_` placeholder doesn't project.
    expect(sortRows(results[0]!)).toEqual([{ C: "bob" }]);
  });

  test("an aggregate may sit inside a head expression", async () => {
    // The 1-based rank minus one, which the corpus otherwise writes as two
    // predicates. Grouping is by Name, since only the second argument
    // contains an aggregate.
    const results = await run(`
      name("bea"). name("ann"). name("cid").
      index(N, count(Other) - 1) :- name(N), name(Other), Other <= N.
      ?- index(N, I).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { N: "ann", I: 0 },
      { N: "bea", I: 1 },
      { N: "cid", I: 2 },
    ]);
  });

  test("a named head argument can be used by the head's other arguments", async () => {
    const results = await run(`
      q(1). q(2). q(3).
      p(count(*) as N, N + 1) :- q(_).
      ?- p(A, B).
    `);
    expect(results[0]).toEqual([{ A: 3, B: 4 }]);
  });

  test("a name may be referenced by an earlier argument", async () => {
    // Order-independent, like every other binding in the language.
    const results = await run(`
      q(1). q(2).
      p(N + 1, count(*) as N) :- q(_).
      ?- p(A, B).
    `);
    expect(results[0]).toEqual([{ A: 3, B: 2 }]);
  });

  test("naming does not disturb grouping", async () => {
    const results = await run(`
      q("a", 1). q("a", 2). q("b", 3).
      p(K, count(*) as N, N * 10) :- q(K, _).
      ?- p(K, N, M).
    `);
    expect(sortRows(results[0]!)).toEqual([
      { K: "a", N: 2, M: 20 },
      { K: "b", N: 1, M: 10 },
    ]);
  });

  test("an ungrouped aggregate expression still yields its one row", async () => {
    const results = await run(`
      q(1). q(2). q(3).
      total(count(*) * 10 - 1) :- q(_).
      ?- total(T).
    `);
    expect(results[0]).toEqual([{ T: 29 }]);
  });

  test("negating a proof-carrying predicate ignores the proof column (spec 8.3)", async () => {
    // `p(1)` has two derivations, `p(2)` one, `p(3)` none. Writing `not p(X)`
    // at the declared arity would be an arity error if the implicit proof
    // column counted as an argument, so this pins that it does not, and that
    // the atom asks whether any proof exists rather than a particular one.
    const results = await run(`
      seed(1). seed(2). seed(3).
      p(X) :: A :- seed(X), X < 3.
      p(X) :: B :- seed(X), X < 2.
      unproven(X) :- seed(X), not p(X).
      ?- unproven(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 3 }]);
  });
});
