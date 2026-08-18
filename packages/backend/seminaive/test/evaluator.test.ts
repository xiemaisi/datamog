import { describe, expect, test } from "bun:test";
import { type IterationCapInfo, create } from "datamog-backend-seminaive";
import { DatamogExecutor } from "datamog-engine";

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

describe("seminaive backend — iteration cap", () => {
  test("stops a runaway arithmetic recursion and reports the growing predicate", async () => {
    // Priming seeds {0}; each delta pass adds one integer. A cap of 5 total
    // passes (priming + 4 deltas) leaves {0..4}, matching the naive backend.
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
    expect(rows[0]).toHaveLength(6);
  });
});

describe("seminaive backend — basics", () => {
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

describe("seminaive backend — stratified negation", () => {
  test("not p(X) filters out matching rows", async () => {
    const results = await run(`
      all(1). all(2). all(3). all(4).
      excluded(2). excluded(4).
      kept(X) :- all(X), not excluded(X).
      ?- kept(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 3 }]);
  });
});

describe("seminaive backend — aggregates", () => {
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
    // concat is order-stabilised across backends — values are
    // sorted by their natural ordering then comma-joined.
    expect(row.All).toEqual("10,20,30");
  });

  test("concat sorts numerically, not lexicographically", async () => {
    const results = await run(`
      t(2). t(10). t(7).
      joined(concat(N)) :- t(N).
      ?- joined(All).
    `);
    expect(results[0]![0]!.All).toEqual("2,7,10");
  });
});

describe("seminaive backend — expressions", () => {
  test("divide-by-zero derives no tuple", async () => {
    const results = await run(`
      n(0). n(2). n(4).
      half(X, Y) :- n(X), Y = X / 0.
      ?- half(X, Y).
    `);
    // Division by zero has no value, so no row survives to carry it (§1).
    expect(results[0]).toEqual([]);
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

  test("sqrt of negative derives no tuple", async () => {
    const results = await run(`
      nums(-4.0). nums(9.0).
      r(X, Y) :- nums(X), Y = sqrt(X).
      ?- r(X, Y).
    `);
    // Only the in-domain input derives a row.
    expect(sortRows(results[0]!)).toEqual([{ X: 9, Y: 3 }]);
  });
});

describe("seminaive backend — recursion shapes", () => {
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

describe("seminaive backend — body elements", () => {
  test("constant argument in body atom filters by that column", async () => {
    const results = await run(`
      p(1, "a"). p(2, "b"). p(3, "a").
      q(X) :- p(X, "a").
      ?- q(X).
    `);
    expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: 3 }]);
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
      output predicate q(X) :- p(X).
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

describe("seminaive backend — built-in functions", () => {
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

  test("ln of non-positive derives no tuple", async () => {
    const results = await run(`
      v(-1.0). v(0.0). v(1.0).
      r(X, L) :- v(X), L = ln(X).
      ?- r(X, L).
    `);
    // Order across sortRows isn't meaningful for this case (numbers keyed by
    // JSON string compare unpredictably for negatives); assert as a set.
    // Only `ln(1)` is in domain; the other two withhold their rows.
    const rows = results[0]!;
    expect(rows.length).toBe(1);
    expect(rows.find((r) => r.X === 1)?.L).toBe(0);
  });

  test("** edge cases: fractional exponent on negative base → no tuple", async () => {
    const results = await run(`
      r(P) :- P = (-2.0) ** 0.5.
      ?- r(P).
    `);
    // The expression has no value, so the rule derives no tuple (§1).
    expect(results[0]).toEqual([]);
  });

  test("** edge case: zero base with negative exponent → no tuple", async () => {
    const results = await run(`
      r(P) :- P = 0.0 ** (-1.0).
      ?- r(P).
    `);
    // The expression has no value, so the rule derives no tuple (§1).
    expect(results[0]).toEqual([]);
  });

  test("** with valid inputs evaluates normally", async () => {
    const results = await run(`
      r(P) :- P = 2.0 ** 3.0.
      ?- r(P).
    `);
    expect(results[0]).toEqual([{ P: 8 }]);
  });

  test("Regression: exp / ** that overflow derive no tuple (seminaive shares native's values.ts)", async () => {
    // Seminaive reuses native's `values.ts`, so the runtime-partial
    // overflow guard added there must hold here too. Pin it.
    const results = await run(`
      r(E, P) :- E = exp(1000.0), P = 2.0 ** 2000.0.
      ?- r(E, P).
    `);
    // Both overflow, so both are undefined and the rule derives nothing.
    expect(results[0]).toEqual([]);
  });

  test("mod operator, and mod by zero withholding the row", async () => {
    const results = await run(`
      n(10). n(7). n(3).
      r(X, M) :- n(X), M = X % 3.
      z(X, Z) :- n(X), Z = X % 0.
      ?- r(X, M).
      output predicate zz(X, Z) :- z(X, Z).
    `);
    // Mod by zero has no value and takes the row with it, so only the good
    // column survives, in its own rule.
    expect(results[1]).toEqual([]);
    const byX = new Map(results[0]!.map((r) => [r.X, r.M]));
    expect(byX.get(10)).toBe(1);
    expect(byX.get(7)).toBe(1);
    expect(byX.get(3)).toBe(0);
  });
});

describe("seminaive backend — subscript & slice edges", () => {
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

describe("seminaive backend — aggregate edges", () => {
  test("ungrouped aggregate over empty body yields one default row (matches SQL)", async () => {
    // SQL emits one row from `SELECT agg(...) FROM empty` (no GROUP BY) —
    // sum is NULL, count would be 0. The seminaive backend mirrors that
    // so a `total(sum(X))` rule produces the same one-row result on
    // every backend, even when no body tuples exist.
    const results = await run(`
      p(X) :- X in [1 .. 0].
      total(sum(X)) :- p(X).
      ?- total(T).
    `);
    // `sum` folds with 0, so an empty group is 0 rather than NULL (§7). The row
    // still exists, which is what this test is about.
    expect(results[0]).toEqual([{ T: 0 }]);
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

  test("count counts a null like any other value; count(*) counts rows", async () => {
    // §11.2, reversing what this used to pin. `count` counts values and `null` is
    // one, so a column of nulls counts them. SQL's `COUNT(col)` skips NULLs, which
    // is the right rule for an *undefined* contribution and the wrong one for a
    // null, so the emit chooses between `COUNT(col)` and `COUNT(*)` on whether the
    // argument can be undefined.
    const results = await run(`
      v(1). v(2). v(3).
      q(X, null) :- v(X).
      cnt(count(Y)) :- q(_, Y).
      star(count(*)) :- q(_, _).
      ?- cnt(N).
      output predicate s(N) :- star(N).
    `);
    expect(results[0]).toEqual([{ N: 3 }]);
    expect(results[1]).toEqual([{ N: 3 }]);
  });

  test("but a contribution with no value is not counted", async () => {
    // The other side of the same rule: `10 / (X - 2)` has no value at X = 2, so
    // that row contributes to neither the count nor any other aggregate, while
    // `count(*)` still sees it.
    const results = await run(`
      v(1). v(2). v(3).
      cnt(count(Z)) :- v(X), Z = 10 / (X - 2).
      star(count(*)) :- v(_).
      ?- cnt(N).
      output predicate s(N) :- star(N).
    `);
    expect(results[0]).toEqual([{ N: 2 }]);
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
    expect(results[0]![0]!.G).toEqual("1,2,3");
  });
});

describe("seminaive backend — more body shapes", () => {
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
    const { create } = await import("datamog-backend-seminaive");
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

describe("seminaive backend — stratification and dependency depth", () => {
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

describe("seminaive backend — more expression & aggregate coverage", () => {
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

describe("seminaive backend — query plumbing", () => {
  test("QueryResult.source carries the original Datalog query string", async () => {
    // The CLI's table output depends on this; a regression would silently
    // blank the `-- <header>` line for native runs.
    const { create } = await import("datamog-backend-seminaive");
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

describe("seminaive backend — backend lifecycle", () => {
  test("a single backend instance supports repeated execute() calls", async () => {
    const { create } = await import("datamog-backend-seminaive");
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
    const { create } = await import("datamog-backend-seminaive");
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
    // Same shared backend wrapper as the native evaluator: inserts outside an
    // active loader/evaluateProgram phase must be buffered for the next run,
    // not appended to stale evaluator state from the previous run.
    const { create } = await import("datamog-backend-seminaive");
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
});
