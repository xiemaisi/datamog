import { describe, expect, test } from "bun:test";
import { parseRaw, postProcess } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { type ModuleResolver, checkModuleBoundaries, elaborate } from "../src/elaborate.ts";
import { inferTypes } from "../src/types.ts";

const MODULES: Record<string, string> = {
  "reach.dl": `
    input predicate edge(src: integer, dst: integer).
    output predicate reach(X, Y) :- edge(X, Y).
    output predicate reach(X, Z) :- reach(X, Y), edge(Y, Z).
  `,
  // A module that exposes its result via a `?-` default output.
  "keep.dl": `
    input predicate n(a: integer, b: integer).
    ?- n(X, Y), X < Y.
  `,
  // A wiring cycle: a.dl instantiates b.dl and vice versa.
  "a.dl": `
    input predicate p(x: integer) := q from "b.dl".
    output predicate q(X) :- p(X).
  `,
  "b.dl": `
    input predicate p(x: integer) := q from "a.dl".
    output predicate q(X) :- p(X).
  `,
  // Pass-through modules: they do not exploit their input's type, so the
  // flattened within-program check catches nothing and the boundary check is
  // the only thing enforcing the declared type.
  "sink.dl": `
    input predicate p(x: integer).
    output predicate out(X) :- p(X).
  `,
  "vsink.dl": `
    input predicate p(x: value).
    output predicate out(X) :- p(X).
  `,
  // A module whose output is declared wider than it produces.
  "widen.dl": `
    input predicate seed(v: integer).
    output predicate out(X: value) :- seed(X).
  `,
  // A proof-carrying output (an ADT), whose constructor is qualified by whatever
  // predicate its rule lands on.
  "adt.dl": `
    input predicate elem(v: value).
    output predicate opt() :: Some :- elem(V).
  `,
  // A proof-carrying output with value columns of its own.
  "adt-pair.dl": `
    input predicate e(a: integer, b: integer).
    output predicate tc(X, Y) :: Step :- e(X, Y).
  `,
  // A module carrying its own data: `extra` is bound to a file inside the module.
  "carries-data.dl": `
    input predicate seed(a: integer).
    input predicate extra(a: integer) := "extra.csv".
    output predicate all(X) :- seed(X).
    output predicate all(X) :- extra(X).
  `,
  // An interface with one primitive input and one defaulted (derived) input:
  // `derived` falls back to sink.dl unless the importer wires it.
  "iface.dl": `
    input predicate base(a: integer).
    input predicate derived(a: integer) := out from "sink.dl"(p = base).
    output predicate result(X) :- derived(X).
  `,
};
// Fresh parse per call (elaborate mutates the returned AST in place).
const resolve: ModuleResolver = (ref) => ({ program: parseRaw(MODULES[ref]!), file: ref });

// biome-ignore lint/suspicious/noExplicitAny: the helpers walk heterogeneous raw AST nodes.
type Stmt = any;
const extDecls = (s: Stmt[]) => s.filter((x) => x.$type === "ExtDecl").map((x) => x.predicate);
const rules = (s: Stmt[]) => s.filter((x) => x.$type === "Rule");
const bodyPreds = (r: Stmt) =>
  r.body.filter((e: Stmt) => e.$type === "Literal").map((e: Stmt) => e.predicate);
const byHead = (s: Stmt[], pred: string) => rules(s).filter((r) => r.head.predicate === pred);
/** An importer's declared name is an alias rule over the instance's output; this
 *  is the instance-side predicate it projects. */
const instanceOutput = (s: Stmt[], local: string): string => {
  const alias = byHead(s, local);
  expect(alias).toHaveLength(1);
  return bodyPreds(alias[0])[0];
};

describe("elaborate", () => {
  test("instantiates a named module export, aliasing it to the input's name", () => {
    const entry = parseRaw(`
      road(1, 2). road(2, 3).
      input predicate road_reach(a: integer, b: integer) := reach from "reach.dl"(edge = road).
      ?- road_reach(1, X).
    `);
    const { program, dataSources } = elaborate(entry, resolve, "main.dl");
    const stmts = program.statements;

    // The bound input and the module's wired input are gone; the importer's name
    // is an alias rule over the instance's `reach` output.
    expect(extDecls(stmts)).toEqual([]);
    const output = instanceOutput(stmts, "road_reach");
    expect(output).toMatch(/^road_reach\$\d+\$reach$/);
    const reachRules = byHead(stmts, output);
    expect(reachRules).toHaveLength(2);
    // edge -> road (the actual); the recursive self-reference is freshened too.
    expect(bodyPreds(reachRules[0])).toEqual(["road"]);
    expect(bodyPreds(reachRules[1])).toEqual([output, "road"]);
    expect(dataSources).toEqual([]);

    // The merged program is a valid ordinary program (no binding left to reject).
    postProcess(program);
    expect(() => analyze(program)).not.toThrow();
  });

  test("the alias rule names the instance's columns after the declaration", () => {
    const entry = parseRaw(`
      road(1, 2).
      input predicate road_reach(a: integer, b: integer) := reach from "reach.dl"(edge = road).
    `);
    const { program } = elaborate(entry, resolve, "main.dl");
    const headVars = (r: Stmt) =>
      r.head.args.map((x: Stmt) => (x.$type === "Variable" ? x.name : x.$type));
    const alias = byHead(program.statements, "road_reach")[0];
    // The alias projects the instance under the declared column names, and is
    // exposed so it prints; the instance keeps the module's own head vars.
    expect(headVars(alias)).toEqual(["a", "b"]);
    expect(alias.output).toBe(true);
    expect(
      headVars(byHead(program.statements, instanceOutput(program.statements, "road_reach"))[0]),
    ).toEqual(["X", "Y"]);
  });

  test("collects data-file bindings and clears them", () => {
    const entry = parseRaw(`
      input predicate p(a: integer) := "data/p.csv".
      input predicate q(a: integer) := "q.txt" as csv.
      ?- p(X).
    `);
    const { program, dataSources } = elaborate(entry, resolve, "main.dl");

    expect(dataSources).toEqual([
      { predicate: "p", source: "data/p.csv", format: undefined, baseFile: "main.dl" },
      { predicate: "q", source: "q.txt", format: "csv", baseFile: "main.dl" },
    ]);
    // The declarations survive as free EDBs with their bindings stripped.
    expect(extDecls(program.statements).sort()).toEqual(["p", "q"]);
    postProcess(program);
    expect(() => analyze(program)).not.toThrow();
  });

  test("imports a module's default (?-) output as a named predicate", () => {
    const entry = parseRaw(`
      val(1, 2).
      input predicate kept(x: integer, y: integer) := from "keep.dl"(n = val).
    `);
    const { program } = elaborate(entry, resolve, "main.dl");
    // The default `?-` became a rule aliased to `kept`, exposed so it prints.
    const keptRules = rules(program.statements).filter((r) => r.head.predicate === "kept");
    expect(keptRules.length).toBeGreaterThan(0);
    expect(keptRules.every((r) => r.output)).toBe(true);
    postProcess(program);
    expect(() => analyze(program)).not.toThrow();
  });

  test("shares one instance between bindings with the same module and wiring", () => {
    // Two outputs of one interface, wired the same way: one expansion, two
    // aliases. `iface.dl` has a nested default too, which is shared with it.
    const entry = parseRaw(`
      seed(1).
      input predicate r1(a: integer) := result from "iface.dl"(base = seed).
      input predicate r2(a: integer) := result from "iface.dl"(base = seed).
    `);
    const { program } = elaborate(entry, resolve, "main.dl");
    const stmts = program.statements;
    expect(instanceOutput(stmts, "r1")).toBe(instanceOutput(stmts, "r2"));
    // One copy of the module's rule, and one copy of the nested sink.dl instance.
    const heads = rules(stmts).map((r) => r.head.predicate as string);
    expect(heads.filter((h) => h.endsWith("$result"))).toHaveLength(1);
    expect(heads.filter((h) => h.endsWith("$out"))).toHaveLength(1);
    postProcess(program);
    expect(() => analyze(program)).not.toThrow();
  });

  test("does not share when the wiring differs", () => {
    const entry = parseRaw(`
      seed(1). other(2).
      input predicate r1(a: integer) := result from "iface.dl"(base = seed).
      input predicate r2(a: integer) := result from "iface.dl"(base = other).
    `);
    const { program } = elaborate(entry, resolve, "main.dl");
    const stmts = program.statements;
    expect(instanceOutput(stmts, "r1")).not.toBe(instanceOutput(stmts, "r2"));
    const heads = rules(stmts).map((r) => r.head.predicate as string);
    expect(heads.filter((h) => h.endsWith("$result"))).toHaveLength(2);
  });

  test("shares a proof-carrying output at the name level, so the constructor is one", () => {
    // A proof-carrying output cannot be aliased by a rule (proof-carrying-ness
    // does not propagate through one), so it is renamed for the first site and
    // the second site's name is rewritten to it. Same wiring, same constructor.
    const entry = parseRaw(`
      n(1).
      input predicate o1(o: value) := opt from "adt.dl"(elem = n).
      input predicate o2(o: value) := opt from "adt.dl"(elem = n).
      first(V)  :- P : o1, P = o1::Some(V).
      second(V) :- Q : o2, Q = o2::Some(V).
    `);
    const { program } = elaborate(entry, resolve, "main.dl");
    const stmts = program.statements;
    // One expansion, under the first site's name; `o2` defines nothing.
    const own = byHead(stmts, "o1");
    expect(own).toHaveLength(1);
    expect(own[0].ruleName).toBe("Some");
    expect(byHead(stmts, "o2")).toEqual([]);
    // Both sites' references now name the one predicate, including the
    // constructor qualifiers.
    expect(bodyPreds(byHead(stmts, "first")[0])).toEqual(["o1"]);
    expect(bodyPreds(byHead(stmts, "second")[0])).toEqual(["o1"]);
    const qualifiers = rules(stmts)
      .flatMap((r: Stmt) => r.body)
      .flatMap((e: Stmt) => (e.$type === "Equality" ? [e.expr] : []))
      .filter((e: Stmt) => e?.$type === "FunctionCall")
      .map((e: Stmt) => e.qualifier);
    expect(qualifiers).toEqual(["o1", "o1"]);
  });

  test("relabels a proof-carrying output's value columns from the declaration", () => {
    // The declaration counts the implicit proof column, so it is one longer than
    // the head; the value columns still take the declared names.
    const entry = parseRaw(`
      base(1, 2).
      input predicate p(orig: integer, dest: integer, why: value)
        := tc from "adt-pair.dl"(e = base).
    `);
    const { program } = elaborate(entry, resolve, "main.dl");
    const rule = byHead(program.statements, "p")[0];
    expect(rule.head.args.map((a: Stmt) => a.name)).toEqual(["orig", "dest"]);
  });

  test("keeps ADT instantiations distinct when their wiring differs", () => {
    // The Option story: two element types, two instances, two constructors.
    const entry = parseRaw(`
      n(1). colour("red").
      input predicate int_opt(o: value)    := opt from "adt.dl"(elem = n).
      input predicate colour_opt(o: value) := opt from "adt.dl"(elem = colour).
    `);
    const { program } = elaborate(entry, resolve, "main.dl");
    const stmts = program.statements;
    for (const local of ["int_opt", "colour_opt"]) {
      const own = byHead(stmts, local);
      expect(own).toHaveLength(1);
      expect(own[0].ruleName).toBe("Some");
    }
    expect(bodyPreds(byHead(stmts, "int_opt")[0])).toEqual(["n"]);
    expect(bodyPreds(byHead(stmts, "colour_opt")[0])).toEqual(["colour"]);
  });

  test("rejects a default import when the module has no `?-` default", () => {
    // reach.dl exposes only named outputs, no `?-`.
    const entry = parseRaw('input predicate best(x: integer) := from "reach.dl".');
    expect(() => elaborate(entry, resolve, "main.dl")).toThrow(/no.*default output/);
  });

  test("rejects a module instantiation cycle", () => {
    const entry = parseRaw('input predicate top(x: integer) := q from "a.dl".');
    expect(() => elaborate(entry, resolve, "main.dl")).toThrow(/module import cycle/);
  });

  test("uses an input's `:=` default when the importer does not wire it", () => {
    const entry = parseRaw(`
      seed(1).
      input predicate r(a: integer) := result from "iface.dl"(base = seed).
    `);
    const { program } = elaborate(entry, resolve, "main.dl");
    const stmts = program.statements;
    const resultRule = byHead(stmts, instanceOutput(stmts, "r"))[0];
    // `derived` resolved to the nested sink.dl instance's freshened output.
    expect(bodyPreds(resultRule)).toEqual([expect.stringMatching(/^derived\$\d+\$out$/)]);
    postProcess(program);
    expect(() => analyze(program)).not.toThrow();
  });

  test("an actual overrides an input's `:=` default, and the default is not built", () => {
    const entry = parseRaw(`
      seed(1).
      mine(2).
      input predicate r(a: integer) := result from "iface.dl"(base = seed, derived = mine).
    `);
    const { program } = elaborate(entry, resolve, "main.dl");
    const stmts = program.statements;
    expect(bodyPreds(byHead(stmts, instanceOutput(stmts, "r"))[0])).toEqual(["mine"]);
    // The overridden default's module was never expanded.
    const heads = rules(stmts).map((s: Stmt) => s.head.predicate as string);
    expect(heads.filter((h) => h.endsWith("$out"))).toEqual([]);
    postProcess(program);
    expect(() => analyze(program)).not.toThrow();
  });

  test("instantiates a data-carrying module twice, one EDB per instance", () => {
    const entry = parseRaw(`
      a(1). b(2).
      extra(3).
      input predicate p(x: integer) := all from "carries-data.dl"(seed = a).
      input predicate q(x: integer) := all from "carries-data.dl"(seed = b).
    `);
    const { program, dataSources } = elaborate(entry, resolve, "main.dl");

    // Each instance declares (and loads) its own freshened copy of `extra`,
    // distinct from each other and from the importer's own `extra`.
    const decls = extDecls(program.statements);
    expect(decls).toHaveLength(2);
    expect(new Set(decls).size).toBe(2);
    // The prefix names the importing input, so the copies are p$N$extra / q$N$extra.
    for (const d of decls) expect(d).toMatch(/^[pq]\$\d+\$extra$/);
    expect(dataSources.map((d) => d.predicate).sort()).toEqual(decls.sort());
    for (const d of dataSources) expect(d.source).toBe("extra.csv");

    // The importer's own `extra` rule is untouched by the instances.
    postProcess(program);
    expect(() => analyze(program)).not.toThrow();
  });

  test("rejects an actual that names no input of the module", () => {
    const entry = parseRaw(`
      seed(1).
      input predicate r(a: integer) := result from "iface.dl"(base = seed, drived = seed).
    `);
    expect(() => elaborate(entry, resolve, "main.dl")).toThrow(/has no input 'drived' to wire/);
  });

  test("rejects an unsupplied module input (not wired or bound)", () => {
    // reach.dl's `edge` input is neither wired nor `:=`-bound here; a module
    // never auto-loads, so this is an error rather than an empty relation.
    const entry = parseRaw('input predicate d(a: integer, b: integer) := reach from "reach.dl".');
    expect(() => elaborate(entry, resolve, "main.dl")).toThrow(/input 'edge' is not supplied/);
  });
});

describe("module boundary type-checking", () => {
  // Elaborate + analyze + infer + check boundaries, mirroring the CLI pipeline.
  const check = (src: string): void => {
    const { program, boundaries } = elaborate(parseRaw(src), resolve, "main.dl");
    postProcess(program);
    checkModuleBoundaries(inferTypes(analyze(program)), boundaries);
  };

  test("accepts a well-typed import", () => {
    expect(() =>
      check(`
        road(1, 2).
        input predicate best(a: integer, b: integer) := reach from "reach.dl"(edge = road).
      `),
    ).not.toThrow();
  });

  test("rejects an output whose declared column type is wrong", () => {
    // reach produces integers (road is integer), but best declares string.
    expect(() =>
      check(`
        road(1, 2).
        input predicate best(a: string, b: string) := reach from "reach.dl"(edge = road).
      `),
    ).toThrow(/bound to 'best': column 1 has type 'integer' but 'string'/);
  });

  test("rejects an actual whose column type does not match the module input", () => {
    // labels is a string EDB wired to reach.dl's integer `edge` input.
    expect(() =>
      check(`
        input predicate labels(a: string, b: string).
        input predicate best(a: string, b: string) := reach from "reach.dl"(edge = labels).
      `),
    ).toThrow(/actual 'labels' wired to input 'edge'.*column 1 has type 'string' but 'integer'/);
  });

  test("rejects an output arity mismatch", () => {
    expect(() =>
      check(`
        road(1, 2).
        input predicate best(a: integer) := reach from "reach.dl"(edge = road).
      `),
    ).toThrow(/bound to 'best': expected 1 column\(s\) but the wired predicate has 2/);
  });

  test("rejects an actual whose declared type is wider than the module input", () => {
    // `thing` is declared value though it currently produces integers. sink.dl
    // requires an integer input; the contract, not the current reality, is what
    // must fit, so wiring `thing` in is rejected.
    expect(() =>
      check(`
        raw(1). raw(2).
        thing(V: value) :- raw(V).
        input predicate result(x: value) := out from "sink.dl"(p = thing).
      `),
    ).toThrow(/actual 'thing' wired to input 'p'.*column 1 has type 'value' but 'integer'/);
  });

  test("accepts an actual whose declared type matches a value input", () => {
    // Same value-declared `thing`, but the module input is value: the contract
    // fits, so the wiring is fine. It is the narrowing that was rejected above,
    // not the annotation.
    expect(() =>
      check(`
        raw(1). raw(2).
        thing(V: value) :- raw(V).
        input predicate result(x: value) := out from "vsink.dl"(p = thing).
      `),
    ).not.toThrow();
  });

  test("rejects importing a value-contracted output under a narrower declaration", () => {
    // widen.dl's output is declared value; importing it as integer would narrow
    // the module's advertised contract, so it is rejected even though the
    // output currently holds integers.
    expect(() =>
      check(`
        nums(1).
        input predicate result(x: integer) := out from "widen.dl"(seed = nums).
      `),
    ).toThrow(/bound to 'result': column 1 has type 'value' but 'integer'/);
  });
});
