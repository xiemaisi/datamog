import { describe, expect, test } from "bun:test";
import { type HeadAnnotation, parse } from "datamog-parser";
import { AnalyzerError, analyze } from "../src/analyzer.ts";
import { inferTypes } from "../src/types.ts";

// Optional but checked head type annotations on intensional predicates
// (`h(x: integer)`). The annotation is lifted onto the head's `argTypes` during
// parsing, then checked against inference. Annotations are per rule and per
// argument: a rule may annotate any subset of its head arguments, and sibling
// rules may annotate differently or omit annotations. Each annotated position
// must equal or widen that rule's own inferred contribution.

function check(source: string) {
  const program = parse(source);
  const analyzed = analyze(program);
  return inferTypes(analyzed);
}

describe("head type annotations", () => {
  test("parsing lifts annotations onto head.argTypes and unwraps the term", () => {
    const program = parse('p("a": string, 2: integer).');
    const rule = program.statements[0] as {
      head: { args: { $type: string }[]; argTypes?: (HeadAnnotation | undefined)[] };
    };
    expect(rule.head.argTypes).toEqual([
      { type: "string", nullable: false },
      { type: "integer", nullable: false },
    ]);
    // The wrapper is gone: the args are ordinary terms again.
    expect(rule.head.args[0]!.$type).toBe("StringLiteral");
    expect(rule.head.args[1]!.$type).toBe("NumberLiteral");
  });

  test("no annotations leaves argTypes absent", () => {
    const program = parse("p(1, 2).");
    const rule = program.statements[0] as { head: { argTypes?: unknown } };
    expect(rule.head.argTypes).toBeUndefined();
  });

  test("correct annotations pass and do not change inferred types", () => {
    const typed = check(`
      input predicate edge(a: integer, b: integer).
      reach(x: integer, y: integer) :- edge(x, y).
      reach(x: integer, z: integer) :- reach(x, y), edge(y, z).
    `);
    expect(typed.columnTypes.get("reach")).toEqual(["integer", "integer"]);
  });

  test("annotating value documents looseness (widening is allowed)", () => {
    const typed = check("p(1: value).");
    expect(typed.columnTypes.get("p")).toEqual(["integer"]);
  });

  test("annotation narrower than inference is rejected", () => {
    // The column holds arbitrary values; claiming `integer` is unsound.
    expect(() =>
      check(`
        input predicate raw(v: value).
        p(x: integer) :- raw(x).
      `),
    ).toThrow(/column 1 is annotated 'integer' but inferred as 'value'/);
  });

  test("wrong annotation is rejected (string on an integer column)", () => {
    expect(() => check("p(1: string).")).toThrow(
      /column 1 is annotated 'string' but inferred as 'integer'/,
    );
  });

  test("integer may be annotated as float (numeric widening)", () => {
    const typed = check("p(1: float).");
    expect(typed.columnTypes.get("p")).toEqual(["integer"]);
  });

  test("float annotated as integer is rejected", () => {
    expect(() => check("p(1.5: integer).")).toThrow(/annotated 'integer' but inferred as 'float'/);
  });

  test("a rule may annotate some head arguments and omit others", () => {
    const typed = check("pair(1: integer, 2).");
    expect(typed.columnTypes.get("pair")).toEqual(["integer", "integer"]);
  });

  test("an annotated position is still checked when siblings are unannotated", () => {
    expect(() => check("pair(1: string, 2).")).toThrow(
      /column 1 is annotated 'string' but inferred as 'integer'/,
    );
  });

  test("one rule may be annotated while a sibling rule is not", () => {
    const typed = check(`
      p(1: integer).
      p(2).
    `);
    expect(typed.columnTypes.get("p")).toEqual(["integer"]);
  });

  test("sibling rules may carry different annotations, each valid", () => {
    // rule 1 annotates integer (contributes integer), rule 2 annotates value
    // (contributes integer, which value widens). Both check out. The column's
    // inferred type stays integer — annotations do not drive codegen.
    const typed = check(`
      input predicate q(v: integer).
      p(1: integer).
      p(x: value) :- q(x).
    `);
    expect(typed.columnTypes.get("p")).toEqual(["integer"]);
  });

  test("aggregate head positions can be annotated and are checked", () => {
    const typed = check(`
      input predicate edge(a: integer, b: integer).
      fanout(x: integer, count(y): integer) :- edge(x, y).
    `);
    expect(typed.columnTypes.get("fanout")).toEqual(["integer", "integer"]);
  });

  test("a wrong annotation on an aggregate position is rejected", () => {
    expect(() =>
      check(`
        input predicate edge(a: integer, b: integer).
        tally(x: integer, count(y): string) :- edge(x, y).
      `),
    ).toThrow(/column 2 is annotated 'string' but inferred as 'integer'/);
  });

  test("the checked error is an AnalyzerError", () => {
    expect(() => check("p(1: string).")).toThrow(AnalyzerError);
  });
});

describe("head annotations as consumer contracts (assume-guarantee)", () => {
  test("a consumer is held to a predicate's declared type, not its inferred type", () => {
    // p is declared value though it currently produces only integers. A
    // consumer must treat p as value, so arithmetic on p's output is rejected.
    expect(() =>
      check(`
        input predicate raw(v: integer).
        p(X: value) :- raw(X).
        q(Z) :- p(Y), Z = Y + 1.
      `),
    ).toThrow(/requires numeric/);
  });

  test("a consumer that treats the column as value is accepted, codegen stays inferred", () => {
    const typed = check(`
      input predicate raw(v: integer).
      p(X: value) :- raw(X).
      q(Y) :- p(Y).
    `);
    // The declaration is a contract, not a storage directive: the inferred
    // (codegen) types are unchanged, so nothing is JSON-wrapped at runtime.
    expect(typed.columnTypes.get("p")).toEqual(["integer"]);
    expect(typed.columnTypes.get("q")).toEqual(["integer"]);
  });

  test("a predicate's own recursive body sees its inferred type, not its declaration", () => {
    // count_down is declared value but its body does integer arithmetic on its
    // own recursive result. Self-references use the inferred (integer) type, so
    // this is accepted rather than rejected as `value - 1`.
    const typed = check(`
      input predicate base(v: integer).
      count_down(N: value) :- base(N).
      count_down(N) :- count_down(M), M > 0, N = M - 1.
    `);
    expect(typed.columnTypes.get("count_down")).toEqual(["integer"]);
  });

  test("an external consumer of that predicate is still held to value", () => {
    expect(() =>
      check(`
        input predicate base(v: integer).
        count_down(N: value) :- base(N).
        count_down(N) :- count_down(M), M > 0, N = M - 1.
        bad(Z) :- count_down(K), Z = K + 1.
      `),
    ).toThrow(/requires numeric/);
  });

  test("a predicate sourcing from a value-contracted callee cannot claim integer", () => {
    // raw is declared value; p copies it. p annotating integer is unsound under
    // raw's contract, even though raw currently holds integers.
    expect(() =>
      check(`
        input predicate seed(v: integer).
        raw(V: value) :- seed(V).
        p(X: integer) :- raw(X).
      `),
    ).toThrow(/column 1 is annotated 'integer' but inferred as 'value'/);
  });
});

// The nullness half of the same annotation: `h(x: integer?)`. Checked in the
// same direction as the type (declared must equal or widen inferred) and, like
// the type, never used to drive inference. See
// doc/design/nullness-tracking.md §3.3.
describe("head nullness annotations", () => {
  test("parsing records the `?` alongside the type", () => {
    const program = parse("p(1: integer, 2: integer?).");
    const rule = program.statements[0] as {
      head: { argTypes?: (HeadAnnotation | undefined)[] };
    };
    expect(rule.head.argTypes).toEqual([
      { type: "integer", nullable: false },
      { type: "integer", nullable: true },
    ]);
  });

  test("`?` is accepted where the rule can produce a NULL", () => {
    // Integer division truncates, so the type stays integer; what the `?`
    // records is the zero divisor.
    const typed = check(`
      input predicate p(a: integer, b: integer).
      ratio(X: integer?) :- p(A, B), X = A / B.
    `);
    expect(typed.columnTypes.get("ratio")).toEqual(["integer"]);
    expect(typed.nullness.columnNullness.get("ratio")).toEqual([true]);
  });

  test("omitting `?` where the rule can produce a NULL is rejected", () => {
    expect(() =>
      check(`
        input predicate p(a: integer, b: integer).
        ratio(X: integer) :- p(A, B), X = A / B.
      `),
    ).toThrow(/column 1 is annotated 'integer' but this rule can produce NULL/);
  });

  test("`?` on a provably non-null column is allowed and documents looseness", () => {
    // The mirror of annotating `value` on an integer column: the declaration
    // may be looser than the body, never tighter.
    const typed = check(`
      input predicate p(a: integer).
      q(X: integer?) :- p(X).
    `);
    // Inference is unchanged by the annotation; only the contract widens.
    expect(typed.nullness.columnNullness.get("q")).toEqual([false]);
    expect(typed.nullness.publishedNullness.get("q")).toEqual([true]);
  });

  test("a guard is enough to justify omitting `?`", () => {
    const typed = check(`
      input predicate p(a: integer?).
      q(X: integer) :- p(X), X <> null.
    `);
    expect(typed.nullness.columnNullness.get("q")).toEqual([false]);
  });

  test("annotations are per rule, so siblings may disagree", () => {
    const typed = check(`
      input predicate p(a: integer, b: integer).
      q(X: integer) :- p(X, _).
      q(X: integer?) :- p(A, B), X = A / B.
    `);
    expect(typed.nullness.columnNullness.get("q")).toEqual([true]);
  });

  test("an aggregate position takes the annotation too", () => {
    expect(() =>
      check(`
        input predicate p(a: integer?).
        total(sum(X): integer) :- p(X).
      `),
    ).toThrow(/column 1 is annotated 'integer' but this rule can produce NULL/);
  });
});
