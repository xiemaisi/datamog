import { describe, expect, test } from "bun:test";
import { create as native } from "datamog-backend-native";
import { create as postgres } from "datamog-backend-postgres";
import { create as seminaive } from "datamog-backend-seminaive";
import { create as sqlite } from "datamog-backend-sqlite";
import { create as sqljs } from "datamog-backend-sqljs";
import { analyze, inferTypes } from "datamog-core";
import { type Backend, DatamogExecutor, type ExtensionalLoader, insertRows } from "datamog-engine";
import { parse, parseRaw } from "datamog-parser";

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
    test("bare nominal types check heads, payloads and nested aliases without changing proofs", async () => {
      expect(
        await run(
          "type Proofs = [p]. p() :: C(3). box() :: B([P]:Proofs) :- P:p. answer(P:p) :- P:p. ?- answer(P).",
        ),
      ).toEqual([[{ P: { $proof: "p::C", args: [3] } }]]);
      await expect(run("p() :: C. q() :: C. answer(P:p) :- P:q. ?- answer(P).")).rejects.toThrow(
        "expected proof of 'p'",
      );
      await expect(
        run('p() :: C. answer({"$proof":"p::C","args":[]}:p). ?- answer(P).'),
      ).rejects.toThrow("expected proof of 'p'");
      await expect(run("p() :: C. input predicate data(x: [p]).")).rejects.toThrow("external JSON");
    });
    test("constructor contracts publish scalar operands without changing proof payloads", async () => {
      const source = 'p() :: C(3: float, "label"). answer(X/2, L) :- P:p, P=C(X,L).';
      expect(await run(`${source} ?- answer(N,L).`)).toEqual([[{ N: 1.5, L: "label" }]]);
      expect(await run(`${source} proof(P) :- P:p. ?- proof(P).`)).toEqual([
        [{ P: { $proof: "p::C", args: [3, "label"] } }],
      ]);
    });
    test("constructor structural aliases and nullable payloads work across backends", async () => {
      expect(
        await run(
          'type Payload = {total: float}. invoice() :: Invoice({"total":3}: Payload). tax(N/2) :- P:invoice, P=Invoice(D), N=D["total"]. ?- tax(T).',
        ),
      ).toEqual([[{ T: 1.5 }]]);
      expect(
        await run("p() :: C(null: integer?). answer(X) :- P:p, P=C(X). ?- answer(N)."),
      ).toEqual([[{ N: null }]]);
      await expect(run('p() :: C("3": integer). ?- P:p.')).rejects.toThrow("payload 1");
      await expect(
        run("p() :: C(3: value). answer(X*2) :- P:p, P=C(X). ?- answer(N)."),
      ).rejects.toThrow("numeric operands");
    });
    test("dynamic projections forward shapes, null values and absence", async () => {
      expect(
        await run(`
        rows([{"n": 7}, {"n": 9}]). index(0). index(1). index(2).
        selected(A[I]) :- rows(A), index(I).
        answer(P["n"] + 1) :- selected(P).
        ?- answer(N).
      `),
      ).toEqual([[{ N: 8 }, { N: 10 }]]);
      const nullable = `rows([7, null]). index(0). index(1). index(2).
        selected(A[I]) :- rows(A), index(I).
        answer(N + 1) :- selected(N), N <> null.`;
      const selected = (await run(`${nullable} ?- selected(N).`))[0]!;
      expect(selected).toHaveLength(2);
      expect(selected).toContainEqual({ N: null });
      expect(selected).toContainEqual({ N: 7 });
      expect(await run(`${nullable} ?- answer(N).`)).toEqual([[{ N: 8 }]]);
    });
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

for (const [name, create] of [
  ["native", native],
  ["seminaive", seminaive],
] as const)
  test(`${name} insertion rechecks structural contracts after declaration edits`, async () => {
    const decl = inferTypes(analyze(parse("input predicate p(x: {n: integer})."))).extDecls.get(
      "p",
    )!;
    const backend = await create();
    try {
      await backend.insertRows!(decl, [{ x: { n: 1 } }]);
      decl.columns[0]!.shape = inferTypes(
        analyze(parse("input predicate p(x: {n: string}).")),
      ).extDecls.get("p")!.columns[0]!.shape;
      await expect(backend.insertRows!(decl, [{ x: { n: 2 } }])).rejects.toThrow("expected string");
      await backend.insertRows!(decl, [{ x: { n: "two" } }]);
    } finally {
      await backend.close();
    }
  });

test("shared insertion preserves late nested errors without inserting a batch prefix", async () => {
  const decl = inferTypes(
    analyze(parse("input predicate p(x: [{child: {n: integer}?}]).")),
  ).extDecls.get("p")!;
  let calls = 0;
  const backend: Backend = {
    sqlDialect: null,
    async execute() {
      calls++;
      return [];
    },
    close() {},
  };
  const rows: Record<string, unknown>[] = Array.from({ length: 100 }, () => ({
    x: [{ child: null }],
  }));
  rows.push({ x: [{ child: { n: "bad" } }] });
  await expect(insertRows(backend, decl, rows)).rejects.toThrow(
    `row 101, column 'x': $[0]["child"]["n"]: expected integer`,
  );
  expect(calls).toBe(0);
});

test("shared and direct interpreter insertions reject nominal declarations before empty batches", async () => {
  const decl = parseRaw("p() :: C. input predicate data(x: {optional?: [p]}).").statements[1]!;
  if (decl.$type !== "ExtDecl") throw new Error("expected input");
  let calls = 0;
  const sqlBackend: Backend = {
    sqlDialect: null,
    async execute() {
      calls++;
      return [];
    },
    close() {},
  };
  await expect(insertRows(sqlBackend, decl, [])).rejects.toThrow("external JSON");
  await expect(insertRows(sqlBackend, decl, [{ x: {} }])).rejects.toThrow("external JSON");
  expect(calls).toBe(0);
  for (const create of [native, seminaive]) {
    const backend = await create();
    try {
      await expect(backend.insertRows!(decl, [])).rejects.toThrow("external JSON");
      await expect(backend.insertRows!(decl, [{ x: {} }])).rejects.toThrow("external JSON");
    } finally {
      await backend.close();
    }
  }
});
