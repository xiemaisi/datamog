import { describe, expect, test } from "bun:test";
import { create as native } from "datamog-backend-native";
import { create as postgres } from "datamog-backend-postgres";
import { create as seminaive } from "datamog-backend-seminaive";
import { create as sqlite } from "datamog-backend-sqlite";
import { create as sqljs } from "datamog-backend-sqljs";
import { analyze, inferTypes } from "datamog-core";
import { type Backend, DatamogExecutor, type ExtensionalLoader, insertRows } from "datamog-engine";
import { parse } from "datamog-parser";

const engines: [string, () => Promise<Backend>][] = [
  ["native", native],
  ["seminaive", seminaive],
  ["sqlite", sqlite],
  ["sqljs", sqljs],
];
if (process.env.DATABASE_URL)
  engines.push([
    "postgres",
    async () => {
      const sql = new Bun.SQL(
        process.env.DATAMOG_EXAMPLES_DATABASE_URL ?? process.env.DATABASE_URL!,
        { max: 1 },
      );
      const schema = `typed_operands_${crypto.randomUUID().replaceAll("-", "")}`;
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema}`);
      const backend = await postgres(sql);
      return {
        ...backend,
        async close() {
          try {
            await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
          } finally {
            await backend.close();
          }
        },
      };
    },
  ]);
for (const [name, create] of engines)
  describe(`typed operands (${name})`, () => {
    async function run(source: string, loaders: ExtensionalLoader[] = []) {
      const backend = await create();
      try {
        return (await new DatamogExecutor(backend, loaders).execute(source)).map((r) => r.rows);
      } finally {
        await backend.close();
      }
    }
    test("type aliases drive scalar extraction and structural input validation", async () => {
      const source = `type Person = {name: string, age: Age}. type Age = integer.
        input predicate people(p: Person).
        person(P: Person) :- people(P).
        answer(upper(P["name"]), P["age"] + 1) :- person(P).
        ?- answer(N, A).`;
      const loader = (age: unknown): ExtensionalLoader => ({
        name: "test",
        async canLoad() {
          return true;
        },
        async load(decl, backend) {
          await insertRows(backend, decl, [{ p: { name: "Ada", age } }]);
          return { rowsLoaded: 1 };
        },
      });
      expect(await run(source, [loader(41)])).toEqual([[{ N: "ADA", A: 42 }]]);
      await expect(run(source, [loader("41")])).rejects.toThrow('$["age"]');
    });
    test("structural input contracts validate before typed field operations", async () => {
      const source = `input predicate people(person: {name: string, age?: integer, scores: [integer]}).
        answer(upper(P["name"]), P["scores"][0] + 1) :- people(P).
        ?- answer(N, S).`;
      const loader = (person: unknown): ExtensionalLoader => ({
        name: "test",
        async canLoad() {
          return true;
        },
        async load(decl, backend) {
          await insertRows(backend, decl, [{ person }]);
          return { rowsLoaded: 1 };
        },
      });
      expect(await run(source, [loader({ name: "Ada", scores: [7] })])).toEqual([
        [{ N: "ADA", S: 8 }],
      ]);
      for (const person of [
        { name: "Ada", scores: ["7"] },
        { name: "Ada", scores: [7], extra: true },
        { scores: [7] },
        { name: "Ada", scores: [7], age: null },
      ])
        await expect(run(source, [loader(person)])).rejects.toThrow();
    });
    test("structural head contracts support computed fields and consumer extraction", async () => {
      expect(
        await run(`
        n(7).
        p({"n": X + 1, "name": "Ada"}: {n: integer, name: string, extra?: boolean}) :- n(X).
        q(P: {n: integer, name: string, extra?: boolean}) :- p(P).
        answer(P["n"] + 1, upper(P["name"])) :- q(P).
        ?- answer(N, S).
      `),
      ).toEqual([[{ N: 9, S: "ADA" }]]);
    });
    test("record and tuple arithmetic, string and boolean operations", async () => {
      expect(
        await run(`
      p({"age": 41, "name": "ada", "ok": true}, [2, 2.5]).
      result(A, N, B, F) :- p(P, T), A = P["age"] + T[0], N = upper(P["name"]), B = !P["ok"], F = abs(T[1]).
      ?- result(A, N, B, F).
    `),
      ).toEqual([[{ A: 43, N: "ADA", B: false, F: 2.5 }]]);
    });
    test("proof payload arithmetic and builtins through bindings", async () => {
      expect(
        await run(`
      n(7). xs(0) :: Nil. xs(N + 1) :: Cons :- n(H), xs(N), N < 2.
      answer(H + 1, abs(H)) :- Cons(H, _) = P, P : xs.
      ?- answer(A, B).
    `),
      ).toEqual([[{ A: 8, B: 7 }]]);
    });
    test("missing fields stay absent, while nullable results remain values", async () => {
      expect(
        await run(`
      p({"x": 2}). p({}).
      q(P["x"] + 1) :- p(P).
      nullable({"x": null}).
      r(P["x"]) :- nullable(P).
      output predicate qout(X) :- q(X).
      output predicate rout(X) :- r(X).
    `),
      ).toEqual([[{ X: 3 }], [{ X: null }]]);
    });
    test("nullable arithmetic requires and honors a variable guard", async () => {
      expect(
        await run(`
      p({"x": 2}). p({"x": null}). p({}).
      q(X + 1) :- p(P), X = P["x"], X <> null.
      ?- q(X).
    `),
      ).toEqual([[{ X: 3 }]]);
    });
    test("nested string access and dynamic homogeneous array indexing", async () => {
      expect(
        await run(`
        p({"name": "ada"}, [2, 3]).
        answer(upper(P["name"][0]), A[I] + 1) :- p(P, A), I in [0 .. 1].
        ?- answer(S, N).
      `),
      ).toEqual([
        [
          { S: "A", N: 3 },
          { S: "A", N: 4 },
        ],
      ]);
    });
    test("integer division and remainder use integer extraction", async () => {
      expect(
        await run(`p({"n": 7}). answer(P["n"] / 2, P["n"] % 2) :- p(P). ?- answer(D, R).`),
      ).toEqual([[{ D: 3, R: 1 }]]);
    });
    test("aggregate arithmetic uses inferred JSON element types", async () => {
      expect(
        await run(`p({"n": 7}). p({"n": 9}). total(sum(P["n"] + 1)) :- p(P). ?- total(N).`),
      ).toEqual([[{ N: 18 }]]);
    });
    test("shared record constraints narrow field operations regardless of body order", async () => {
      for (const body of ["a(P), b(P)", "b(P), a(P)"]) {
        expect(
          await run(
            `a({"x": 1}). a({"x": "s"}). b({"x": 1}). answer(P["x"] + 1) :- ${body}. ?- answer(N).`,
          ),
        ).toEqual([[{ N: 2 }]]);
      }
    });
    test("equality constraints refine existing payload bindings", async () => {
      expect(
        await run(
          `p({"x": 1}). p({"x": "s"}). answer(V + 1) :- p(P), V = P["x"], W = V, W = 1. ?- answer(N).`,
        ),
      ).toEqual([[{ N: 2 }]]);
    });
    test("nested matches recover a selected payload from a union of proof types", async () => {
      expect(
        await run(`
        n(7). s("s").
        a() :: A :- n(X).
        b() :: B :- s(X).
        choice(P) :- P : a.
        choice(P) :- P : b.
        box() :: Box(P) :- choice(P).
        answer(X + 1) :- Box(a::A(X)) = P.
        ?- answer(N).
      `),
      ).toEqual([[{ N: 8 }]]);
    });
    test("dependent wrapper results enable subsequent typed expressions", async () => {
      expect(
        await run(`p({"s": "ada"}). q(upper(P["s"])) :- p(P). r(lower(X)) :- q(X). ?- r(X).`),
      ).toEqual([[{ X: "ada" }]]);
    });
  });

test("opaque published contracts and unguarded nullable operands are not implicitly cast", () => {
  for (const source of [
    'p(P: value) :- P = {"x": 1}. q(P["x"] + 1) :- p(P).',
    'p({"x": 1}). p({"x": null}). q(P["x"] + 1) :- p(P).',
    "input predicate p(x: value). q(X + 1) :- p(X).",
  ])
    expect(() => inferTypes(analyze(parse(source)))).toThrow();
});

test("re-analysis re-proves implicit conversions after a contract is widened", () => {
  const program = analyze(parse('p({"x": 1}). q(P["x"] + 1) :- p(P).'));
  expect(inferTypes(program).columnTypes.get("q")).toEqual(["integer"]);
  expect(inferTypes(program).columnTypes.get("q")).toEqual(["integer"]);
  const declaration = analyze(parse('p(P: value) :- P = {"x": 1}.')).rules.get("p")![0]!.head
    .argTypes;
  program.rules.get("p")![0]!.head.argTypes = declaration;
  expect(() => inferTypes(program)).toThrow();
});

for (const [name, create] of [
  ["native", native],
  ["seminaive", seminaive],
] as const)
  test(`${name} direct inserts reject an entire malformed structural batch`, async () => {
    const program = inferTypes(analyze(parse("input predicate p(x: {n: integer}). ?- p(X).")));
    const backend = await create();
    try {
      await expect(
        backend.insertRows!(program.extDecls.get("p")!, [{ x: { n: 1 } }, { x: { n: "bad" } }]),
      ).rejects.toThrow("row 2");
      expect((await backend.evaluateProgram!(program, []))[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

test("shared insertion validates the whole batch before calling a backend", async () => {
  const decl = inferTypes(analyze(parse("input predicate p(x: [integer])."))).extDecls.get("p")!;
  let calls = 0;
  const backend: Backend = {
    sqlDialect: null,
    async execute() {
      calls++;
      return [];
    },
    close() {},
  };
  await expect(insertRows(backend, decl, [{ x: [1] }, { x: ["bad"] }])).rejects.toThrow("row 2");
  expect(calls).toBe(0);
});
