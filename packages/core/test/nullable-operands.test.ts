import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { AnalyzerError, analyze } from "../src/analyzer.ts";
import { inferTypes } from "../src/types.ts";

// Position 3's second half: an operation that computes needs a value, so a
// nullable operand is a static error and has to be narrowed first. Comparisons
// are the exception, being strict at null: a guard failing is a guard doing its
// job. See doc/design/null-as-a-value.md §5 and §15.22.

const check = (source: string) => inferTypes(analyze(parse(source)));
const decl = "input predicate p(a: integer?, b: string?, v: value).\n";

describe("an operation that computes rejects a nullable operand", () => {
  test("arithmetic, either side", () => {
    expect(() => check(`${decl}q(X) :- p(A, _, _), X = A + 1.`)).toThrow(
      /`A` can be null, and `\+` needs a value/,
    );
    expect(() => check(`${decl}q(X) :- p(A, _, _), X = 1 - A.`)).toThrow(/can be null/);
  });

  test("negation, bitwise, string concatenation", () => {
    expect(() => check(`${decl}q(X) :- p(A, _, _), X = -A.`)).toThrow(/negation needs a value/);
    expect(() => check(`${decl}q(X) :- p(A, _, _), X = A & 1.`)).toThrow(
      /the bitwise `&` needs a value/,
    );
    expect(() => check(`${decl}q(X) :- p(_, B, _), X = B + "!".`)).toThrow(/can be null/);
  });

  test("a builtin with a primitive parameter", () => {
    expect(() => check(`${decl}q(X) :- p(_, B, _), X = upper(B).`)).toThrow(
      /`upper` needs a value/,
    );
  });

  test("the value aggregates, but not `count` or `list`", () => {
    for (const agg of ["sum", "avg", "min", "max"]) {
      expect(() => check(`${decl}q(${agg}(A)) :- p(A, _, _).`)).toThrow(
        new RegExp(`\`${agg}\` needs a value`),
      );
    }
    expect(() => check(`${decl}q(concat(B)) :- p(_, B, _).`)).toThrow(/`concat` needs a value/);
    // These two can see a null and neither returns one: `count` counts it and
    // `list` collects it (§7, §11.2).
    expect(() => check(`${decl}q(count(A)) :- p(A, _, _).`)).not.toThrow();
    expect(() => check(`${decl}q(list(A)) :- p(A, _, _).`)).not.toThrow();
  });

  test("a range bound", () => {
    expect(() => check(`${decl}q(X) :- p(A, _, _), X in [A .. 10].`)).toThrow(
      /a range bound needs a value/,
    );
  });

  test("the error is an AnalyzerError, so it carries a source position", () => {
    let caught: unknown;
    try {
      check(`${decl}q(X) :- p(A, _, _), X = A + 1.`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AnalyzerError);
    expect((caught as AnalyzerError).offset).toBeGreaterThan(0);
  });
});

describe("what it does not reject", () => {
  test("a guarded operand", () => {
    const typed = check(`${decl}q(X) :- p(A, _, _), A <> null, X = A + 1.`);
    expect(typed.nullness.columnNullness.get("q")).toEqual([false]);
  });

  test("a comparison, which takes a null and is strict at it", () => {
    expect(() => check(`${decl}q(A) :- p(A, _, _), A < 10.`)).not.toThrow();
    expect(() => check(`${decl}q(A) :- p(A, _, _), A = null.`)).not.toThrow();
    expect(() => check(`${decl}q(A) :- p(A, _, _), A <> 3.`)).not.toThrow();
  });

  test("a non-null column, which is the ordinary case", () => {
    expect(() => check("input predicate n(a: integer).\nq(X) :- n(A), X = A + 1.")).not.toThrow();
  });

  test("a `value` operand, whose null the JSON spelling carries", () => {
    // §9.3: a `value` spells its null inside the value, so a SQL NULL there
    // already means undefined and there is no ambiguity for this rule to protect.
    // Which is also what keeps every fold over a proof term legal, a proof-term
    // argument being a `value` subscript.
    expect(() => check(`${decl}q(X) :- p(_, _, V), X = V["k"].`)).not.toThrow();
    expect(() => check(`${decl}q(X) :- p(_, _, V), X = type_of(V).`)).not.toThrow();
  });

  test("a null passed straight through, which stores rather than computes", () => {
    const typed = check(`${decl}q(A) :- p(A, _, _).`);
    expect(typed.nullness.columnNullness.get("q")).toEqual([true]);
  });
});
