import { describe, expect, test } from "bun:test";
import type { ExtDecl } from "../src/index.ts";
import { parse } from "../src/index.ts";

// The `:=` source binding on an input predicate: a data file (bare string,
// optional `as <format>` override) or a module instantiation (`[export] from
// "mod.dl"(actuals)`). Grammar/parse only here; the resolver that acts on the
// binding is not built yet (the analyzer rejects a surviving binding).
const bindingOf = (src: string) => {
  const decl = parse(src).statements[0] as ExtDecl;
  expect(decl.$type).toBe("ExtDecl");
  return decl.binding;
};

describe("input predicate source binding", () => {
  test("no binding when omitted", () => {
    expect(bindingOf("input predicate p(a: integer).")).toBeUndefined();
  });

  test("records maximal polarity on a module binding", () => {
    const decl = parse('input predicate best^(x: integer) := result from "solver.dl".')
      .statements[0] as ExtDecl;
    expect(decl.maximal).toBe(true);
    expect(decl.binding?.export).toBe("result");
  });

  test("data file: bare string", () => {
    const b = bindingOf('input predicate p(a: integer) := "data/p.csv".');
    expect(b?.source).toBe("data/p.csv");
    expect(b?.export).toBeUndefined();
    expect(b?.format).toBeUndefined();
    expect(b?.actuals).toEqual([]);
  });

  test("data file: `as <format>` override", () => {
    const b = bindingOf('input predicate p(a: integer) := "p.txt" as csv.');
    expect(b?.source).toBe("p.txt");
    expect(b?.format).toBe("csv");
    expect(b?.export).toBeUndefined();
  });

  test("module default output (export omitted)", () => {
    const b = bindingOf('input predicate best(x: integer) := from "solver.dl".');
    expect(b?.source).toBe("solver.dl");
    expect(b?.export).toBeUndefined();
    expect(b?.format).toBeUndefined();
    expect(b?.actuals).toEqual([]);
  });

  test("module named export", () => {
    const b = bindingOf('input predicate dist(a: integer, b: integer) := reach from "reach.dl".');
    expect(b?.export).toBe("reach");
    expect(b?.source).toBe("reach.dl");
    expect(b?.actuals).toEqual([]);
  });

  test("module named export with actuals", () => {
    const b = bindingOf(
      'input predicate d(a: integer, b: integer) := reach from "reach.dl"(edge = road, weight = w).',
    );
    expect(b?.export).toBe("reach");
    expect(b?.actuals.map((x) => [x.param, x.arg])).toEqual([
      ["edge", "road"],
      ["weight", "w"],
    ]);
  });

  test("module default output with actuals", () => {
    const b = bindingOf(
      'input predicate c(a: integer, b: integer) := from "reach.dl"(edge = road).',
    );
    expect(b?.export).toBeUndefined();
    expect(b?.actuals.map((x) => [x.param, x.arg])).toEqual([["edge", "road"]]);
  });

  // `from`/`as` are contextual keywords: usable as ordinary identifiers outside
  // the binding slots (they are common words, e.g. edge columns `from`/`to`).
  test("`from` and `as` remain usable as identifiers", () => {
    const prog = parse(
      "input predicate edge(from: integer, to: integer).\nas(from, X) :- edge(from, X).",
    );
    const decl = prog.statements[0] as ExtDecl;
    expect(decl.columns.map((c) => c.name)).toEqual(["from", "to"]);
    // A predicate named `as` with a body atom `edge` reading the `from` column.
    expect(prog.statements[1]?.$type).toBe("Rule");
  });
});
