import { expect, test } from "bun:test";
import { ParseError, parse, parseRaw, postProcess } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { checkModuleBoundaries, elaborate } from "../src/elaborate.ts";
import { validateStructuralColumn } from "../src/structural-declarations.ts";
import { inferTypes } from "../src/types.ts";

const typed = (source: string) => inferTypes(analyze(parse(source)));

test("aliases are transparent in input columns, named heads and nested shapes", () => {
  const aliases = typed(`
    type Person = {name: Name, age?: Age, scores: [Age?]}.
    type Name = string. type Age = integer.
    input predicate people(p: Person).
    person({"name": "Ada", "scores": [7]} as P: Person).
    answer(upper(P["name"]), P["scores"][0]) :- person(P).
  `);
  const inline = typed(`
    input predicate people(p: {name: string, age?: integer, scores: [integer?]}).
    person({"name": "Ada", "scores": [7]} as P: {name: string, age?: integer, scores: [integer?]}).
    answer(upper(P["name"]), P["scores"][0]) :- person(P).
  `);
  expect(aliases.columnTypes).toEqual(inline.columnTypes);
  expect(aliases.semanticColumnTypes).toEqual(inline.semanticColumnTypes);
  expect(aliases.publishedSemanticColumnTypes).toEqual(inline.publishedSemanticColumnTypes);
  const decl = aliases.extDecls.get("people")!.columns[0]!;
  expect(() =>
    validateStructuralColumn({ name: "Ada", scores: [null, 7] }, decl, "row 1"),
  ).not.toThrow();
  expect(() => validateStructuralColumn({ name: "Ada", scores: ["7"] }, decl, "row 1")).toThrow(
    '$["scores"][0]',
  );
});

test("alias nullability composes with nullable uses without changing scalar storage", () => {
  const program = typed(`
    type Age = integer?. type Ages = [Age]. type Nothing = null.
    input predicate p(age: Age, again: Age?, scores: Ages?, nil: Nothing).
    q(null: Age). r([1, null]: Ages).
  `);
  expect(program.columnTypes.get("p")).toEqual(["integer", "integer", "value", "null"]);
  expect(program.nullness.columnNullness.get("p")).toEqual([true, true, true, true]);
  expect(program.publishedTypes.get("q")).toEqual(["integer"]);
  const arrays = program.extDecls.get("p")!.columns[2]!;
  expect(() => validateStructuralColumn(null, arrays, "row 1")).not.toThrow();
  expect(() => validateStructuralColumn([1, null], arrays, "row 1")).not.toThrow();
  expect(() => typed("type Age = integer. p(null: Age).")).toThrow();
});

test("aliases retain published generality and cannot assert opaque shapes", () => {
  expect(() =>
    typed(`type Person = {age: integer}. p(P: value) :- P = {"age": 7}. q(P: Person) :- p(P).`),
  ).toThrow("structural annotation");
  expect(() => typed(`type Person = {age: integer}. p({"age": "7"}: Person).`)).toThrow(
    "structural annotation",
  );
  expect(() =>
    typed(`type Person = {age: integer}. p({"age": 7}: Person). q(P["age"] + 1) :- p(P).`),
  ).not.toThrow();
  expect(() =>
    typed(`type Opaque = value. p({"age": 7}: Opaque). q(P["age"] + 1) :- p(P).`),
  ).toThrow();
});

test("type is contextual and aliases share neither predicate nor variable namespaces", () => {
  expect(() =>
    typed("type Person = integer. Person(1). type(2). p(Person: Person) :- Person(Person)."),
  ).not.toThrow();
  expect(() => typed("type `an age` = integer. input predicate p(x: `an age`).")).not.toThrow();
  expect(() => typed("type integer = string.")).toThrow();
  expect(() => typed("type `integer` = string.")).toThrow("primitive type");
  expect(() => typed("type `$private` = string.")).toThrow("may not start");
});

test("Boolean, comparison and conditional refinements keep their expression meaning", () => {
  for (const source of [
    "p(B, _: B) :- B = true.",
    "p(X, _: X > 0) :- X = 1.",
    "p(B, _: B ? true : false) :- B = true.",
    "type B = boolean. p(B, _: (B)) :- B = true.",
  ])
    expect(() => typed(source)).not.toThrow();
});

test("unknown, duplicate, and recursive aliases fail even when unused, with source spans", () => {
  for (const [source, message] of [
    ["type A = Missing.", "Unknown type alias 'Missing'"],
    ["input predicate p(x: Missing).", "Unknown type alias 'Missing'"],
    ["p(1: Missing).", "Unknown type alias 'Missing'"],
    ["type A = integer. type A = string.", "Duplicate type alias 'A'"],
    ["type A = integer. type `A` = string.", "Duplicate type alias 'A'"],
    ["type A = A.", "Recursive type alias"],
    ["type A = {next?: B}. type B = [A].", "Recursive type alias"],
    ["type A = {x: integer, x: string}.", "Duplicate structural field"],
  ]) {
    try {
      parse(source!, "aliases.dl");
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).message).toContain(message!);
      expect((error as ParseError).file).toBe("aliases.dl");
      expect((error as ParseError).offset).toBeNumber();
      expect((error as ParseError).end).toBeGreaterThan((error as ParseError).offset!);
    }
  }
});

test("exponential alias expansion is rejected rather than weakening a contract", () => {
  const source = ["type T0 = integer."];
  for (let i = 1; i < 20; i++) source.push(`type T${i} = {a: T${i - 1}, b: T${i - 1}}.`);
  expect(() => parse(source.join("\n"))).toThrow("expansion exceeds");
});

test("each alias use has independent shape nodes and correct AST parents", () => {
  const program = parseRaw("type A = {n: [integer]}. input predicate p(a: A, b: A).");
  const decl = program.statements.find((s) => s.$type === "ExtDecl")!;
  const [a, b] = decl.columns;
  expect(a!.shape).not.toBe(b!.shape);
  expect(a!.shape!.$container).toBe(a);
  expect(b!.shape!.$container).toBe(b);
  if (a!.shape!.$type === "RecordType" && b!.shape!.$type === "RecordType") {
    expect(a!.shape.fields[0]!.value.shape).not.toBe(b!.shape.fields[0]!.value.shape);
    expect(a!.shape.fields[0]!.$container).toBe(a!.shape);
    expect(a!.shape.fields[0]!.value.$container).toBe(a!.shape.fields[0]);
  }
});

test("module aliases resolve locally before boundaries and cannot leak across files", () => {
  const modules: Record<string, string> = {
    "ints.dl":
      "type Item = {n: integer}. input predicate data(x: Item). output predicate out(P: Item) :- data(P).",
    "strings.dl": 'type Item = {s: string}. output predicate out({"s": "ok"}: Item).',
  };
  const check = (entry: string) => {
    const result = elaborate(
      parseRaw(entry, "entry.dl"),
      (file) => ({ program: parseRaw(modules[file]!, file), file }),
      "entry.dl",
    );
    postProcess(result.program);
    const program = inferTypes(analyze(result.program));
    checkModuleBoundaries(program, result.boundaries);
    return program;
  };
  const source = `type Item = {n: integer}. p({"n": 7}).
    input predicate ints(x: Item) := out from "ints.dl"(data = p).
    input predicate strings(x: {s: string}) := out from "strings.dl".`;
  expect(() => check(source)).not.toThrow();
  expect(() => check(source.replace('p({"n": 7})', 'p({"n": "bad"})'))).toThrow("structural");
  expect(() => check('input predicate strings(x: Item) := out from "strings.dl".')).toThrow(
    "Unknown type alias 'Item'",
  );
  modules["unknown.dl"] = "input predicate data(x: Item). output predicate out(P) :- data(P).";
  expect(() =>
    check(
      'type Item = integer. p(7). input predicate q(x: Item) := out from "unknown.dl"(data = p).',
    ),
  ).toThrow("Unknown type alias 'Item'");
});
