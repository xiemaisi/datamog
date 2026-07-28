import { describe, expect, test } from "bun:test";
import { create } from "datamog-backend-sqlite";
import { type ModuleResolver, analyze, elaborate, inferTypes } from "datamog-core";
import { parseRaw, postProcess } from "datamog-parser";
import type { QueryResult } from "../src/backend.ts";
import { DatamogExecutor } from "../src/executor.ts";

// End-to-end: elaborate `:=` module bindings on a raw entry program, then run
// the merged program on a backend. Proves the resolver assembles a valid,
// runnable program from the expansion pass.
const MODULES: Record<string, string> = {
  "reach.dl": `
    input predicate edge(src: integer, dst: integer).
    output predicate reach(X, Y) :- edge(X, Y).
    output predicate reach(X, Z) :- reach(X, Y), edge(Y, Z).
  `,
  // graph.dl imports filter.dl for its edge relation (a nested instantiation).
  "filter.dl": `
    input predicate raw(a: integer, b: integer).
    output predicate keep(X, Y) :- raw(X, Y), X < Y.
  `,
  "graph.dl": `
    input predicate src(a: integer, b: integer).
    input predicate edge(a: integer, b: integer) := keep from "filter.dl"(raw = src).
    output predicate reach(X, Y) :- edge(X, Y).
    output predicate reach(X, Z) :- reach(X, Y), edge(Y, Z).
  `,
  // Exposes its result via a `?-` default output rather than a named export.
  "asc.dl": `
    input predicate p(a: integer, b: integer).
    ?- p(X, Y), X < Y.
  `,
  // An ADT (Option) parameterised over its element predicate.
  "option.dl": `
    input predicate elem(v: value).
    output predicate opt() :: None.
    output predicate opt() :: Some :- elem(V).
  `,
  // Asserts an invariant about its own input, both anonymously and by name.
  "checked.dl": `
    input predicate p(a: integer, b: integer).
    !- p(X, Y), X > Y.
    error predicate self_loop(X) :- p(X, X).
    output predicate keep(X, Y) :- p(X, Y).
  `,
};
// Fresh parse per call (elaborate mutates the returned AST).
const resolve: ModuleResolver = (ref) => ({ program: parseRaw(MODULES[ref]!), file: ref });

async function run(source: string): Promise<QueryResult[]> {
  const { program } = elaborate(parseRaw(source), resolve, "main.dl");
  postProcess(program);
  const backend = await create();
  try {
    return await new DatamogExecutor(backend).executeAnalyzed(inferTypes(analyze(program)));
  } finally {
    await backend.close();
  }
}

const sortRows = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const byLabel = (results: QueryResult[], label: string) =>
  sortRows(results.find((r) => r.label === label)!.rows);

describe("module binding end-to-end", () => {
  test("two instances of one module wire to different relations", async () => {
    // The aliased outputs (road_reach / flight_reach) inherit reach.dl's
    // `output` marker, so analysis synthesises a query for each. Result columns
    // carry the importer's declared names (a, b), not the module's head vars.
    const results = await run(`
      road(1, 2). road(2, 3).
      flight(10, 20).
      input predicate road_reach(a: integer, b: integer)   := reach from "reach.dl"(edge = road).
      input predicate flight_reach(a: integer, b: integer) := reach from "reach.dl"(edge = flight).
    `);
    expect(byLabel(results, "road_reach")).toEqual([
      { a: 1, b: 2 },
      { a: 1, b: 3 },
      { a: 2, b: 3 },
    ]);
    expect(byLabel(results, "flight_reach")).toEqual([{ a: 10, b: 20 }]);
  });

  test("resolves a nested module import (graph.dl imports filter.dl)", async () => {
    // filter keeps edges with a < b: base {(1,2),(2,3),(3,1)} -> {(1,2),(2,3)};
    // graph's reach is that relation's transitive closure.
    const results = await run(`
      base(1, 2). base(2, 3). base(3, 1).
      input predicate g(a: integer, b: integer) := reach from "graph.dl"(src = base).
    `);
    expect(byLabel(results, "g")).toEqual([
      { a: 1, b: 2 },
      { a: 1, b: 3 },
      { a: 2, b: 3 },
    ]);
  });

  test("imports a module's default (?-) output", async () => {
    // asc.dl's default output keeps rows with a < b; import wires p and exposes
    // it as `ordered`, columns relabelled to the importer's declaration.
    const results = await run(`
      raw(1, 2). raw(5, 3). raw(4, 9).
      input predicate ordered(lo: integer, hi: integer) := from "asc.dl"(p = raw).
    `);
    expect(byLabel(results, "ordered")).toEqual([
      { lo: 1, hi: 2 },
      { lo: 4, hi: 9 },
    ]);
  });

  test("prepareElaborated resolves imports and checks boundary types", async () => {
    const { program } = DatamogExecutor.prepareElaborated(
      `road(1, 2). road(2, 3).
       input predicate rr(a: integer, b: integer) := reach from "reach.dl"(edge = road).`,
      resolve,
      "main.dl",
    );
    const backend = await create();
    try {
      const results = await new DatamogExecutor(backend).executeAnalyzed(program);
      expect(byLabel(results, "rr")).toEqual([
        { a: 1, b: 2 },
        { a: 1, b: 3 },
        { a: 2, b: 3 },
      ]);
    } finally {
      await backend.close();
    }

    // A declared type that disagrees with the module's output is rejected.
    expect(() =>
      DatamogExecutor.prepareElaborated(
        `road(1, 2). input predicate rr(a: string, b: string) := reach from "reach.dl"(edge = road).`,
        resolve,
        "main.dl",
      ),
    ).toThrow(/column 1 has type 'integer' but 'string'/);
  });

  test("a boundary rejects a declared type narrower than the module output", () => {
    // option.dl's output column is `value`; declaring the importing column
    // `integer` promises more than the module proves. The boundary check is a
    // directional subtype test, so this narrowing is rejected rather than
    // silently letting `narrowed` carry arbitrary values.
    expect(() =>
      DatamogExecutor.prepareElaborated(
        `n(1). n(2). input predicate narrowed(o: integer) := opt from "option.dl"(elem = n).`,
        resolve,
        "main.dl",
      ),
    ).toThrow(/bound to 'narrowed': column 1 has type 'value' but 'integer' was declared/);
  });

  test("imported ADT constructors are writable and distinct per instance", async () => {
    // Two Option instances; each instance's constructors are named after its
    // binding (int_opt::Some, colour_opt::Some), so both are matchable at once.
    const results = await run(`
      n(1). n(2).
      colour("red").
      input predicate int_opt(o: value)    := opt from "option.dl"(elem = n).
      input predicate colour_opt(o: value) := opt from "option.dl"(elem = colour).
      output predicate int_some(V)    :- P : int_opt,    P = int_opt::Some(V).
      output predicate colour_some(V) :- Q : colour_opt, Q = colour_opt::Some(V).
    `);
    expect(byLabel(results, "int_some")).toEqual([{ V: 1 }, { V: 2 }]);
    expect(byLabel(results, "colour_some")).toEqual([{ V: "red" }]);
  });

  test("an imported module's constraints are checked against the wired data", async () => {
    // A module's invariants hold wherever it is instantiated, so its `!-` and
    // `error predicate` statements survive elaboration and run in the importer.
    expect(
      run(`
        pair(1, 2).
        pair(5, 3).
        input predicate ok(a: integer, b: integer) := keep from "checked.dl"(p = pair).
        ?- ok(X, Y).
      `),
    ).rejects.toThrow(/Constraint `!- p\(X, Y\), X > Y\.` is violated by 1 row/);
  });

  test("a violated module constraint is named without its instance prefix", async () => {
    // Elaboration renames `self_loop` to `ok$0$self_loop`; the message must
    // report the name the module author wrote, plus the binding it came in via.
    expect(
      run(`
        pair(1, 1).
        input predicate ok(a: integer, b: integer) := keep from "checked.dl"(p = pair).
        ?- ok(X, Y).
      `),
    ).rejects.toThrow(/Constraint 'self_loop' \(from the module bound to 'ok'\) is violated/);
  });

  test("a satisfied module constraint leaves the import working", async () => {
    const results = await run(`
      pair(1, 2).
      pair(3, 4).
      input predicate ok(a: integer, b: integer) := keep from "checked.dl"(p = pair).
      ?- ok(X, Y).
    `);
    expect(sortRows(results[0]!.rows)).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });
});
