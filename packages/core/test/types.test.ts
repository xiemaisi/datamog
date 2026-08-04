import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { AnalyzerError, analyze } from "../src/analyzer.ts";
import { columnTypesCompatible, inferTypes } from "../src/types.ts";

function getTypes(source: string) {
  const program = parse(source);
  const analyzed = analyze(program);
  return inferTypes(analyzed);
}

describe("type inference", () => {
  test("EDB types come from declarations", () => {
    const typed = getTypes("input predicate t(a: string, b: integer, c: float, d: boolean).");
    expect(typed.columnTypes.get("t")).toEqual(["string", "integer", "float", "boolean"]);
  });

  test("unannotated EDB columns default to string", () => {
    const typed = getTypes("input predicate person(name, age: integer, city).");
    expect(typed.columnTypes.get("person")).toEqual(["string", "integer", "string"]);
  });

  test("an unannotated column used numerically is a type error", () => {
    // string default: arithmetic needs an explicit `: integer`/`: float`.
    expect(() =>
      getTypes(`
        input predicate nums(x).
        doubled(Y) :- nums(X), Y = X * 2.
      `),
    ).toThrow(/requires numeric operands.*'string'/);
  });

  test("IDB inherits types from EDB via variable binding", () => {
    const typed = getTypes(`
      input predicate parent(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
    `);
    expect(typed.columnTypes.get("ancestor")).toEqual(["string", "string"]);
  });

  test("IDB inherits integer type", () => {
    const typed = getTypes(`
      input predicate scores(name: string, score: integer).
      high(X, S) :- scores(X, S), S > 80.
    `);
    expect(typed.columnTypes.get("high")).toEqual(["string", "integer"]);
  });

  test("arithmetic expression produces integer", () => {
    const typed = getTypes(`
      input predicate base(x: integer).
      doubled(X, D) :- base(X), D = X * 2.
    `);
    expect(typed.columnTypes.get("doubled")).toEqual(["integer", "integer"]);
  });

  test("arithmetic with float promotes to float", () => {
    const typed = getTypes(`
      input predicate base(x: integer).
      halved(X, H) :- base(X), H = X / 2.5.
    `);
    expect(typed.columnTypes.get("halved")![1]).toBe("float");
  });

  test("string literal in head produces string", () => {
    const typed = getTypes(`
      input predicate items(name: string).
      tagged(X, "yes") :- items(X).
    `);
    expect(typed.columnTypes.get("tagged")).toEqual(["string", "string"]);
  });

  test("boolean literal in head produces boolean", () => {
    const typed = getTypes(`
      input predicate items(name: string).
      flagged(X, true) :- items(X).
    `);
    expect(typed.columnTypes.get("flagged")).toEqual(["string", "boolean"]);
  });

  test("boolean literal as fact column seeds boolean type", () => {
    const typed = getTypes(`
      flag("a", true).
      flag("b", false).
    `);
    expect(typed.columnTypes.get("flag")).toEqual(["string", "boolean"]);
  });

  test("&& produces boolean", () => {
    const typed = getTypes(`
      input predicate t(a: boolean, b: boolean).
      r(C) :- t(A, B), C = A && B.
    `);
    expect(typed.columnTypes.get("r")).toEqual(["boolean"]);
  });

  test("|| produces boolean", () => {
    const typed = getTypes(`
      input predicate t(a: boolean, b: boolean).
      r(C) :- t(A, B), C = A || B.
    `);
    expect(typed.columnTypes.get("r")).toEqual(["boolean"]);
  });

  test("! produces boolean", () => {
    const typed = getTypes(`
      input predicate t(a: boolean).
      r(C) :- t(A), C = !A.
    `);
    expect(typed.columnTypes.get("r")).toEqual(["boolean"]);
  });

  test("comparison in expression position infers boolean", () => {
    const typed = getTypes(`
      input predicate t(a: integer).
      r(C) :- t(X), C = X > 0.
    `);
    expect(typed.columnTypes.get("r")).toEqual(["boolean"]);
  });

  test("= and <> in expression position infer boolean", () => {
    const typed = getTypes(`
      input predicate t(a: integer).
      eq_zero(C) :- t(X), C = (X = 0).
      ne_zero(C) :- t(X), C = (X <> 0).
    `);
    expect(typed.columnTypes.get("eq_zero")).toEqual(["boolean"]);
    expect(typed.columnTypes.get("ne_zero")).toEqual(["boolean"]);
  });

  test("compound boolean expression filter", () => {
    const typed = getTypes(`
      input predicate t(a: integer, b: integer).
      r(X, Y) :- t(X, Y), (X > 0) && (Y < 10).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer", "integer"]);
  });

  test("+ with string operand infers string (concatenation)", () => {
    const typed = getTypes(`
      input predicate words(w: string).
      prefixed(R) :- words(W), R = "hello_" + W.
    `);
    expect(typed.columnTypes.get("prefixed")).toEqual(["string"]);
  });

  test("chained IDB type propagation", () => {
    const typed = getTypes(`
      input predicate base(x: integer).
      step1(X, Y) :- base(X), Y = X + 1.
      step2(A, B) :- step1(A, B).
    `);
    expect(typed.columnTypes.get("step1")).toEqual(["integer", "integer"]);
    expect(typed.columnTypes.get("step2")).toEqual(["integer", "integer"]);
  });

  test("recursive predicate types converge", () => {
    const typed = getTypes(`
      input predicate edge(src: string, dst: string).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
    `);
    expect(typed.columnTypes.get("path")).toEqual(["string", "string"]);
  });

  test("multiple rules join types", () => {
    const typed = getTypes(`
      input predicate a(x: integer).
      input predicate b(x: float).
      combined(X) :- a(X).
      combined(X) :- b(X).
    `);
    // integer joined with float → float
    expect(typed.columnTypes.get("combined")).toEqual(["float"]);
  });

  test("fact with number literal", () => {
    const typed = getTypes('base(42, "hello").');
    expect(typed.columnTypes.get("base")).toEqual(["integer", "string"]);
  });

  test("range-bound variable has integer type", () => {
    const typed = getTypes(`
      nums(X) :- X in [1 .. 10].
    `);
    expect(typed.columnTypes.get("nums")).toEqual(["integer"]);
  });

  test("rejects range with non-numeric bounds", () => {
    expect(() =>
      getTypes(`
        input predicate words(w: string).
        bad(X) :- words(X), X in ["a" .. "z"].
      `),
    ).toThrow(/non-numeric type/);
  });

  test("rejects subscript with float-typed index", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(C) :- w(W), C = W[1.5].
      `),
    ).toThrow(/Subscript index must have integer type.*'float'/);
  });

  test("rejects subscript with string-typed index", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(C) :- w(W), C = W["0"].
      `),
    ).toThrow(/Subscript index must have integer type.*'string'/);
  });

  test("rejects slice with float-typed bounds", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(S) :- w(W), S = W[1.5:2.5].
      `),
    ).toThrow(/Slice start must have integer type.*'float'/);
  });

  test("rejects arithmetic with a string operand (string - integer)", () => {
    // `-`, `*`, `/`, `%` require numeric operands; the old BinaryExpr
    // validator only recursed into subterms and didn't check the op.
    expect(() =>
      getTypes(`
        input predicate t(s: string).
        r(X) :- t(S), X = S - 1.
      `),
    ).toThrow(/Operator '-' requires numeric operands.*'string'/);
  });

  test("rejects + on boolean + integer (neither numeric nor concat)", () => {
    expect(() =>
      getTypes(`
        input predicate t(b: boolean).
        r(X) :- t(B), X = B + 1.
      `),
    ).toThrow(/Operator '\+' requires numeric or string operands.*'boolean'/);
  });

  test("Regression: rejects + on string + boolean (cross-backend divergent)", () => {
    // Same shape as the string + json regression above. Booleans are
    // stored differently across backends — SQLite stores them as 0/1
    // INTEGER, so `'x:' || true` renders as `'x:1'`; the native
    // evaluator's `${l}${r}` template renders as `'x:true'`; Postgres
    // depends on the cast. Spec §6 promises identical output across
    // every backend, so reject the mix at analyse time.
    expect(() =>
      getTypes(`
        r(X) :- X = "tag=" + true.
      `),
    ).toThrow(/Operator '\+'.*'boolean'/);
  });

  test("Regression: rejects + on string + value (cross-backend divergent)", () => {
    // The string-concat branch of `validateBinaryExprTypes` short-circuited
    // on `leftType === "string" || rightType === "string"` without checking
    // the OTHER side. So a `"prefix" + [1, 2]` rule passed analysis, then
    // diverged at runtime: SQLite's `||` concatenated the canonical JSON
    // text (`"prefix[1,2]"`); the native evaluator's `${l}${r}` template
    // literal called JS `Array.toString` on the json array (`"prefix1,2"`)
    // — and `[object Object]` for objects. Same `String(v)` shape as the
    // CLI / Mermaid / playground render fixes (vein 3 in the project hints),
    // but inside an arithmetic operator. There is no `to_string(json)` —
    // mixing string and json under `+` has no defined cross-backend
    // meaning, so reject at analyse time.
    expect(() =>
      getTypes(`
        r(X) :- X = "prefix" + [1, 2].
      `),
    ).toThrow(/Operator '\+'.*'value'/);
    // Same shape with the json on the left.
    expect(() =>
      getTypes(`
        r(X) :- X = {"a": 1} + "suffix".
      `),
    ).toThrow(/Operator '\+'.*'value'/);
  });

  test("rejects sum of a string argument", () => {
    expect(() =>
      getTypes(`
        input predicate t(s: string).
        r(sum(S)) :- t(S).
      `),
    ).toThrow(/Aggregate 'sum' requires a numeric argument.*'string'/);
  });

  test("rejects avg of a string argument", () => {
    expect(() =>
      getTypes(`
        input predicate t(s: string).
        r(avg(S)) :- t(S).
      `),
    ).toThrow(/Aggregate 'avg' requires a numeric argument.*'string'/);
  });

  test("rejects min on a boolean argument", () => {
    // Regression: `validateAggregateArgType` only checked numericity
    // for `sum` / `avg`; `min` / `max` slipped through any type
    // including `boolean` and `json`. Per the function's own
    // doc-comment ("`min`/`max` accept any orderable type"), an
    // orderable type is `integer` / `float` / `string` — booleans
    // and `value`s aren't orderable in the spec sense and the
    // native evaluator's `compareOp` (`values.ts:557`) throws on
    // them. Reject at analyse time so the user sees a clear,
    // position-bearing error rather than a runtime exception.
    expect(() =>
      getTypes(`
        input predicate t(b: boolean).
        r(min(B)) :- t(B).
      `),
    ).toThrow(/Aggregate 'min' requires.*'boolean'/);
  });

  test("list accepts primitive arguments and infers value result", () => {
    // Primitive arguments are auto-lifted to JSON (string → JSON
    // string, integer/float → JSON number, boolean → JSON true/false)
    // so a `list(X)` over a primitive column produces a json array.
    for (const colType of ["string", "integer", "float", "boolean"] as const) {
      const typed = getTypes(`
        input predicate t(g: string, x: ${colType}).
        r(G, list(X)) :- t(G, X).
      `);
      expect(typed.columnTypes.get("r")).toEqual(["string", "value"]);
    }
  });

  test("rejects max on a value argument", () => {
    // Same shape as the boolean case — `value`s have no
    // cross-backend ordering (Postgres jsonb has a "natural"
    // ordering, SQLite stores TEXT and uses lexicographic, native
    // throws). Reject up front so cross-backend results stay
    // consistent.
    expect(() =>
      getTypes(`
        input predicate t(j: value).
        r(max(J)) :- t(J).
      `),
    ).toThrow(/Aggregate 'max' requires.*'value'/);
  });

  test("rejects atom arg whose literal type conflicts with declared column", () => {
    // `t(5)` where `t` has column type `string` used to be accepted silently.
    expect(() =>
      getTypes(`
        input predicate t(x: string).
        r(X) :- t(5), X = "x".
      `),
    ).toThrow(/Argument 1 of 't\(\.\.\.\)' has type 'integer' but column is declared as 'string'/);
  });

  test("rejects a variable whose type in one atom conflicts with another", () => {
    // `r(X) :- p(X), q(X)` with `p: integer` and `q: string` used to silently
    // pick the first type and leak through.
    expect(() =>
      getTypes(`
        input predicate p(a: integer).
        input predicate q(a: string).
        r(X) :- p(X), q(X).
      `),
    ).toThrow(/Variable 'X' has conflicting types/);
  });

  test("rejects binding range with float-typed bounds", () => {
    // The LHS `Y` is a bare variable, so the range is meant to bind Y.
    // The translator can only synthesise an integer series, so the
    // analyser rejects float-typed bounds on a binding range (they would
    // otherwise surface as an "Unbound variable" crash downstream).
    expect(() =>
      getTypes(`
        input predicate base(x: float).
        ranged(X, Y) :- base(X), Y in [X .. X + 1.0].
      `),
    ).toThrow(/Binding range.*requires integer bounds/);
  });

  test("Regression: a range atom in a query body is validated like a rule body", () => {
    // Query-body validation is a near-duplicate of rule-body validation and
    // drifted: the query `RangeAtom` case skipped `checkRangeExprTypes`, so a
    // `?-` accepted a float binding range and a non-numeric range expression
    // that the equivalent rule rejects. The two then diverged at runtime
    // (sqlite threw "Unbound variable" / returned [] where native returned
    // rows). Both must be rejected at analyse time, like the rule forms.
    expect(() => getTypes("?- X in [1.5 .. 3].")).toThrow(/Binding range.*requires integer bounds/);
    expect(() => getTypes('s("hi"). ?- s(X), X in [1 .. 3].')).toThrow(
      /Range expression has non-numeric type/,
    );
  });

  test("Regression: a binding range types its variable only if both bounds are typed", () => {
    // A `null` bound has no type, so the range determines nothing about `X`.
    // Typing `X` from the other bound alone passes every static check and then
    // leaves the translator with no series to build: sqlite throws "Unbound
    // variable 'X'" where native returns no rows. The binding-equality path
    // already declines in the same situation, so the two must agree.
    //
    // The bound is a literal here because that is what still reaches this
    // path. Routing the untyped bound through a variable
    // (`N = null, X in [1 .. N]`) is caught earlier, by safety: a bare `null`
    // does not ground `N`.
    expect(() => getTypes("q(X) :- X in [1 .. null].")).toThrow(
      /Cannot infer type of column 1 of predicate 'q'/,
    );
  });

  test("accepts range filter with float expression", () => {
    const typed = getTypes(`
      input predicate vals(x: float).
      filtered(X) :- vals(X), X in [0 .. 100].
    `);
    expect(typed.columnTypes.get("filtered")).toEqual(["float"]);
  });

  test("sibling rules producing string and integer widen the column to value", () => {
    // Across rules the column is a join (least upper bound). A string from one
    // rule and an integer from another have no common primitive supertype, so
    // the column holds both as JSON: `value`. (Within a single rule this same
    // pair is a meet and still errors; see the shared-atom-variable tests.)
    const typed = getTypes(`
      input predicate words(w: string).
      input predicate nums(n: integer).
      mixed(X) :- words(X).
      mixed(X) :- nums(X).
    `);
    expect(typed.columnTypes.get("mixed")).toEqual(["value"]);
  });

  test("sibling rules producing boolean and string widen the column to value", () => {
    const typed = getTypes(`
      input predicate flags(b: boolean).
      input predicate names(n: string).
      mixed(X) :- flags(X).
      mixed(X) :- names(X).
    `);
    expect(typed.columnTypes.get("mixed")).toEqual(["value"]);
  });

  test("facts of incompatible primitive types at the same position widen to value", () => {
    const typed = getTypes(`
      r(1).
      r("hello").
    `);
    expect(typed.columnTypes.get("r")).toEqual(["value"]);
  });

  test("integer and float are still joined as float (numeric widening)", () => {
    const typed = getTypes(`
      input predicate ints(n: integer).
      input predicate reals(n: float).
      both(X) :- ints(X).
      both(X) :- reals(X).
    `);
    expect(typed.columnTypes.get("both")).toEqual(["float"]);
  });

  test("rejects comparison between integer and string literal", () => {
    expect(() =>
      getTypes(`
        input predicate t(n: integer).
        r(X) :- t(X), X > "5".
      `),
    ).toThrow(/Cannot compare 'integer' and 'string' in comparison/);
  });

  test("rejects comparison between boolean and integer", () => {
    expect(() =>
      getTypes(`
        input predicate flags(b: boolean).
        input predicate nums(n: integer).
        r(X, Y) :- flags(X), nums(Y), X > Y.
      `),
    ).toThrow(/Cannot compare/);
  });

  test("accepts comparison between integer and float (numeric widening)", () => {
    const typed = getTypes(`
      input predicate ints(n: integer).
      input predicate reals(n: float).
      r(X, Y) :- ints(X), reals(Y), X > Y.
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer", "float"]);
  });

  test("rejects ordering comparison on booleans", () => {
    expect(() =>
      getTypes(`
        input predicate flags(b: boolean).
        r(X, Y) :- flags(X), flags(Y), X > Y.
      `),
    ).toThrow(/Operator '>' does not order booleans/);
  });

  test("accepts equality and inequality between booleans", () => {
    const typed = getTypes(`
      input predicate flags(b: boolean).
      same(X, Y) :- flags(X), flags(Y), X = Y.
      diff(X, Y) :- flags(X), flags(Y), X <> Y.
    `);
    expect(typed.columnTypes.get("same")).toEqual(["boolean", "boolean"]);
    expect(typed.columnTypes.get("diff")).toEqual(["boolean", "boolean"]);
  });

  test("accepts boolean literal in comparison against boolean column", () => {
    const typed = getTypes(`
      input predicate flags(name: string, on: boolean).
      live(N) :- flags(N, B), B = true.
    `);
    expect(typed.columnTypes.get("live")).toEqual(["string"]);
  });

  test("rejects non-binding equality between incompatible types", () => {
    expect(() =>
      getTypes(`
        input predicate t(a: integer).
        r(X) :- t(X), X + 1 = "hello".
      `),
    ).toThrow(/Cannot compare 'integer' and 'string' in equality/);
  });

  test("rejects incompatible equality when the left variable is already bound", () => {
    expect(() =>
      getTypes(`
        input predicate t(a: integer).
        r(X) :- t(X), X = "hello".
      `),
    ).toThrow(/Cannot compare 'integer' and 'string' in equality/);
  });

  test("rejects negative literal as subscript index", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(C) :- w(W), C = W[-1].
      `),
    ).toThrow(/Negative subscript index/);
  });

  test("rejects negative literal as slice start", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(S) :- w(W), S = W[-2:].
      `),
    ).toThrow(/Negative slice start/);
  });

  test("rejects negative literal as slice end", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(S) :- w(W), S = W[0:-1].
      `),
    ).toThrow(/Negative slice end/);
  });

  test("variable-valued indices are still allowed (can't prove non-negative)", () => {
    const typed = getTypes(`
      input predicate w(s: string, i: integer).
      r(C) :- w(W, I), C = W[I].
    `);
    expect(typed.columnTypes.get("r")).toEqual(["string"]);
  });

  test("subscript and slice results wait for receiver type across out-of-order equalities", () => {
    // `X = Y[0]` / `S = Y[0:1]` appear before `Y = [[1], [2]]`, so the
    // first fixed-point pass does not yet know whether Y is a string or a
    // value. Inferring string by default mis-typed the result predicates
    // and made SQL result coercion leave nested JSON as text.
    const typed = getTypes(`
      r(X) :- X = Y[0], Y = [[1], [2]].
      s(S) :- S = Y[0:1], Y = [[1], [2]].
    `);
    expect(typed.columnTypes.get("r")).toEqual(["value"]);
    expect(typed.columnTypes.get("s")).toEqual(["value"]);
  });
});

describe("type inference validation errors", () => {
  test("rejects unary minus on a string operand", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(N) :- w(S), N = -S.
      `),
    ).toThrow(/Unary minus requires a numeric operand.*'string'/);
  });

  test("rejects subscript on a non-string operand", () => {
    expect(() =>
      getTypes(`
        input predicate n(v: integer).
        r(C) :- n(V), C = V[0].
      `),
    ).toThrow(/Subscript requires a string or value operand.*'integer'/);
  });

  test("rejects slice on a non-string operand", () => {
    expect(() =>
      getTypes(`
        input predicate n(v: integer).
        r(C) :- n(V), C = V[0:1].
      `),
    ).toThrow(/Slice requires a string or value operand.*'integer'/);
  });

  test("rejects removed len() builtin", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(L) :- w(W), L = len(W).
      `),
    ).toThrow(/Unknown function 'len'/);
  });

  test("rejects upper() on a non-string argument", () => {
    expect(() =>
      getTypes(`
        input predicate n(v: integer).
        r(U) :- n(V), U = upper(V).
      `),
    ).toThrow(/Function 'upper' expects argument 1 to have type string; got 'integer'/);
  });

  test("rejects replace() with a non-string argument", () => {
    expect(() =>
      getTypes(`
        input predicate n(v: integer).
        r(U) :- n(V), U = replace(V, "a", "b").
      `),
    ).toThrow(/Function 'replace' expects argument 1 to have type string; got 'integer'/);
  });

  test("rejects sqrt() on a string argument", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(Q) :- w(S), Q = sqrt(S).
      `),
    ).toThrow(/Function 'sqrt' expects argument 1 to have type float or integer; got 'string'/);
  });

  test("rejects floor() on a string argument", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(F) :- w(S), F = floor(S).
      `),
    ).toThrow(/Function 'floor' expects argument 1 to have type float or integer; got 'string'/);
  });

  test("rejects range with non-numeric upper bound", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(X) :- w(S), X in [1 .. S].
      `),
    ).toThrow(/Range upper bound has non-numeric type 'string'/);
  });

  test("rejects range with non-numeric expression", () => {
    expect(() =>
      getTypes(`
        input predicate w(s: string).
        r(S) :- w(S), S in [0 .. 10].
      `),
    ).toThrow(/Range expression has non-numeric type 'string'/);
  });

  test("rejects replace() with a non-string second argument", () => {
    // First arg string, second arg integer — exercises the second iteration
    // of the `replace` argument-type loop (first iteration passes).
    expect(() =>
      getTypes(`
        input predicate n(v: integer).
        r(U) :- n(V), U = replace("hello", V, "x").
      `),
    ).toThrow(/Function 'replace' expects argument 2 to have type string; got 'integer'/);
  });

  describe("value coercion / introspection functions", () => {
    test("as_string accepts primitive arguments via value embedding", () => {
      const t = getTypes(`
        input predicate t(s: string).
        r(X) :- t(S), X = as_string(S).
      `);
      expect(t.columnTypes.get("r")).toEqual(["string"]);
    });

    test("as_integer accepts primitive arguments via value embedding", () => {
      const t = getTypes(`
        input predicate t(n: integer).
        r(X) :- t(N), X = as_integer(N).
      `);
      expect(t.columnTypes.get("r")).toEqual(["integer"]);
    });

    test("length accepts string arguments", () => {
      const t = getTypes(`
        input predicate words(w: string).
        r(L) :- words(W), L = length(W).
      `);
      expect(t.columnTypes.get("r")).toEqual(["integer"]);
    });

    test("length accepts non-string primitives via value embedding", () => {
      const t = getTypes(`
        input predicate t(n: integer).
        r(L) :- t(N), L = length(N).
      `);
      expect(t.columnTypes.get("r")).toEqual(["integer"]);
    });

    test("type_of accepts primitive arguments via value embedding", () => {
      const t = getTypes(`
        input predicate t(b: boolean).
        r(T) :- t(B), T = type_of(B).
      `);
      expect(t.columnTypes.get("r")).toEqual(["string"]);
    });

    test("as_integer return type is integer (composes with arithmetic)", () => {
      const t = getTypes(`
        input predicate p(j: value).
        r(N) :- p(J), N = as_integer(J["x"]) + 1.
      `);
      expect(t.columnTypes.get("r")).toEqual(["integer"]);
    });

    test("type_of return type is string", () => {
      const t = getTypes(`
        input predicate p(j: value).
        r(T) :- p(J), T = type_of(J).
      `);
      expect(t.columnTypes.get("r")).toEqual(["string"]);
    });

    test("has_key returns boolean, embeds the first arg, and requires a string key", () => {
      const t = getTypes(`
        input predicate p(j: value).
        r(B) :- p(J), B = has_key(J, "id").
      `);
      expect(t.columnTypes.get("r")).toEqual(["boolean"]);

      expect(() =>
        getTypes(`
          input predicate p(j: value).
          r(B) :- p(J), B = has_key(J, 0).
        `),
      ).toThrow(/Function 'has_key' expects argument 2 to have type string; got 'integer'/);
      const lifted = getTypes(`
        input predicate p(s: string).
        r(B) :- p(S), B = has_key(S, "id").
      `);
      expect(lifted.columnTypes.get("r")).toEqual(["boolean"]);
    });

    test("keys / values return value (an array `value`)", () => {
      const t = getTypes(`
        input predicate p(j: value).
        ks(K) :- p(J), K = keys(J).
        vs(V) :- p(J), V = values(J).
      `);
      expect(t.columnTypes.get("ks")).toEqual(["value"]);
      expect(t.columnTypes.get("vs")).toEqual(["value"]);
    });

    test("to_json returns string (canonical JSON text)", () => {
      const t = getTypes(`
        input predicate p(j: value).
        r(S) :- p(J), S = to_json(J).
      `);
      expect(t.columnTypes.get("r")).toEqual(["string"]);
    });

    test("keys / values / to_json accept primitive arguments via value embedding", () => {
      const t = getTypes(`
        input predicate p(s: string).
        ks(K) :- p(S), K = keys(S).
        vs(V) :- p(S), V = values(S).
        ser(T) :- p(S), T = to_json(S).
      `);
      expect(t.columnTypes.get("ks")).toEqual(["value"]);
      expect(t.columnTypes.get("vs")).toEqual(["value"]);
      expect(t.columnTypes.get("ser")).toEqual(["string"]);
    });

    test("as_boolean return type is boolean", () => {
      const t = getTypes(`
        input predicate p(j: value).
        r(B) :- p(J), B = as_boolean(J["flag"]).
      `);
      expect(t.columnTypes.get("r")).toEqual(["boolean"]);
    });
  });

  describe("primitive conversions (to_*)", () => {
    test("to_string of integer / float / boolean all return string", () => {
      const t = getTypes(`
        input predicate p(i: integer, r: float, b: boolean).
        si(I, S) :- p(I, _, _), S = to_string(I).
        sr(R, S) :- p(_, R, _), S = to_string(R).
        sb(B, S) :- p(_, _, B), S = to_string(B).
      `);
      expect(t.columnTypes.get("si")).toEqual(["integer", "string"]);
      expect(t.columnTypes.get("sr")).toEqual(["float", "string"]);
      expect(t.columnTypes.get("sb")).toEqual(["boolean", "string"]);
    });

    test("to_integer / to_float / to_boolean return their target type", () => {
      const t = getTypes(`
        input predicate w(s: string).
        i(N)  :- w(S), N = to_integer(S).
        r(N)  :- w(S), N = to_float(S).
        b(B)  :- w(S), B = to_boolean(S).
      `);
      expect(t.columnTypes.get("i")).toEqual(["integer"]);
      expect(t.columnTypes.get("r")).toEqual(["float"]);
      expect(t.columnTypes.get("b")).toEqual(["boolean"]);
    });

    test("to_string rejects string argument (no identity overload)", () => {
      // Identity casts add noise without changing the value — users
      // already have a string and should pass it through directly.
      expect(() =>
        getTypes(`
          input predicate w(s: string).
          r(S) :- w(S), R = to_string(S).
        `),
      ).toThrow(
        /Function 'to_string' expects argument 1 to have type boolean or float or integer; got 'string'/,
      );
    });

    test("to_integer rejects integer argument (no identity overload)", () => {
      expect(() =>
        getTypes(`
          input predicate p(i: integer).
          r(N) :- p(I), N = to_integer(I).
        `),
      ).toThrow(/Function 'to_integer' expects argument 1 to have type string; got 'integer'/);
    });

    test("to_float rejects integer argument (use integer→float promotion)", () => {
      // For widening integer to float, the promotion happens implicitly
      // wherever a float-typed slot is needed; an explicit conversion
      // would just bloat the rule body.
      expect(() =>
        getTypes(`
          input predicate p(i: integer).
          r(N) :- p(I), N = to_float(I).
        `),
      ).toThrow(/Function 'to_float' expects argument 1 to have type string; got 'integer'/);
    });

    test("`value` subscript with a float-typed index is rejected", () => {
      // JSON subscript accepts integer (array index) or string (object
      // key) — float doesn't dispatch to either and would crash inside
      // the dialect's `jsonSubscript` if it slipped through.
      expect(() =>
        getTypes(`
          input predicate p(j: value).
          input predicate f(x: float).
          r(V) :- p(J), f(X), V = J[X].
        `),
      ).toThrow(/JSON subscript index must have integer or string type.*'float'/);
    });

    test("query atom argument with the wrong type is rejected", () => {
      // `validateTypes` walks queries too — without this, `?- p(123).`
      // against a `string`-typed column passes type-check, executes,
      // and silently returns no rows because `123` never matches a
      // string column.
      expect(() =>
        getTypes(`
          input predicate p(name: string).
          ?- p(42).
        `),
      ).toThrow(
        /Argument 1 of 'p\(\.\.\.\)' has type 'integer' but column is declared as 'string'/,
      );
    });

    test("a column that no rule constrains the type of is rejected", () => {
      // The null literal is polymorphic, so `r(null).` contributes nothing to
      // the column's type. The fixed-point iteration converges with it still
      // undefined; the finalisation pass catches that explicitly.
      expect(() =>
        getTypes(`
          r(null).
        `),
      ).toThrow(/Cannot infer type of column 1 of predicate 'r'/);
    });

    test("Regression: 'Cannot infer type of column' carries the rule's head-arg position", () => {
      // The finalisation throw at types.ts:119 used to emit an
      // AnalyzerError with no offset/end, so the playground's lint
      // squiggly underlined position 0–1 instead of the offending
      // head argument. Verify the error now points at the first
      // rule's head arg for the unconstrained column.
      const source = "r(null).";
      let caught: unknown;
      try {
        getTypes(source);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AnalyzerError);
      const err = caught as AnalyzerError;
      const argOffset = source.indexOf("null");
      expect(err.offset).toBe(argOffset);
      expect(err.end).toBe(argOffset + "null".length);
    });

    test("parse_json maps string to value", () => {
      const t = getTypes(`
        input predicate raw(s: string).
        parsed(S, J) :- raw(S), J = parse_json(S).
      `);
      expect(t.columnTypes.get("parsed")).toEqual(["string", "value"]);
    });

    test("parse_json rejects non-string argument", () => {
      expect(() =>
        getTypes(`
          input predicate p(i: integer).
          r(K) :- p(I), K = parse_json(I).
        `),
      ).toThrow(/Function 'parse_json' expects argument 1 to have type string; got 'integer'/);
    });
  });

  test("rejects && on a non-boolean operand", () => {
    expect(() =>
      getTypes(`
        input predicate t(a: integer, b: boolean).
        r(C) :- t(X, B), C = X && B.
      `),
    ).toThrow(/Operator '&&' requires boolean operands.*'integer'/);
  });

  test("rejects || on a non-boolean operand", () => {
    expect(() =>
      getTypes(`
        input predicate t(a: string, b: boolean).
        r(C) :- t(S, B), C = B || S.
      `),
    ).toThrow(/Operator '\|\|' requires boolean operands.*'string'/);
  });

  test("rejects ! on a non-boolean operand", () => {
    expect(() =>
      getTypes(`
        input predicate t(a: integer).
        r(C) :- t(X), C = !X.
      `),
    ).toThrow(/Logical '!' requires a boolean operand.*'integer'/);
  });

  test("rejects filter that isn't boolean-typed", () => {
    expect(() =>
      getTypes(`
        input predicate t(a: integer).
        r(X) :- t(X), X + 1.
      `),
    ).toThrow(/Filter expression must be boolean.*'integer'/);
  });

  test("rejects ordering comparison on booleans", () => {
    expect(() =>
      getTypes(`
        input predicate t(a: boolean, b: boolean).
        r(X, Y) :- t(X, Y), X > Y.
      `),
    ).toThrow(/'>' does not order booleans/);
  });

  test("rejects comparison between incompatible types", () => {
    expect(() =>
      getTypes(`
        input predicate t(a: integer, b: string).
        r(X, Y) :- t(X, Y), X < Y.
      `),
    ).toThrow(/Cannot compare 'integer' and 'string' in comparison/);
  });
});

describe("type inference — function and aggregate return types", () => {
  test("abs(integer) infers integer column type", () => {
    const typed = getTypes(`
      input predicate base(x: integer).
      r(A) :- base(X), A = abs(X).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer"]);
  });

  test("abs(float) infers float column type", () => {
    const typed = getTypes(`
      input predicate base(x: float).
      r(A) :- base(X), A = abs(X).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["float"]);
  });

  test("round(x) infers integer; round(x, n) infers float", () => {
    const typed = getTypes(`
      input predicate base(x: float).
      r1(R) :- base(X), R = round(X).
      r2(R) :- base(X), R = round(X, 2).
    `);
    expect(typed.columnTypes.get("r1")).toEqual(["integer"]);
    expect(typed.columnTypes.get("r2")).toEqual(["float"]);
  });

  test("concat aggregate infers string column type", () => {
    const typed = getTypes(`
      input predicate t(g: string, item: string).
      r(G, concat(I)) :- t(G, I).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["string", "string"]);
  });

  test("list aggregate infers value column type", () => {
    const typed = getTypes(`
      input predicate t(g: string, item: value).
      r(G, list(I)) :- t(G, I).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["string", "value"]);
  });

  test("primitive-to-value auto-lift accepted at body atom args", () => {
    // `t(5)` over a value column would previously have been rejected
    // ("Argument 1 of 't(...)' has type 'integer' but column is
    // declared as 'value'"). Auto-lifting at the unify-with-json
    // boundary lets the translator emit a `to_jsonb` (or per-dialect
    // equivalent) so the comparison crosses the type-tag boundary.
    const typed = getTypes(`
      input predicate t(j: value).
      r(M) :- t(5), M = "match".
    `);
    expect(typed.columnTypes.get("r")).toEqual(["string"]);
  });

  test("primitive-to-value auto-lift accepted in comparison ops", () => {
    const typed = getTypes(`
      input predicate t(j: value).
      r(J) :- t(J), J = 5.
    `);
    expect(typed.columnTypes.get("r")).toEqual(["value"]);
  });

  test("IDB column unification widens primitive + json to json", () => {
    // Sibling rules contributing different types to the same IDB
    // column unify upward to `json` — the translator emits a
    // `to_jsonb` lift on the primitive branch so every UNION member
    // produces the column's declared SQL type.
    const typed = getTypes(`
      data(5).
      data([1, 2]).
      r(X) :- data(X).
    `);
    expect(typed.columnTypes.get("data")).toEqual(["value"]);
    expect(typed.columnTypes.get("r")).toEqual(["value"]);
  });

  test("ordering ops on `value` stay rejected even with primitive on the other side", () => {
    // The lift loosening only applies to equality variants. Ordering
    // ops have no defined cross-backend behavior on json, so
    // `J < 5` (or any `<`/`<=`/`>`/`>=` with json on either side) is
    // still a type error.
    expect(() =>
      getTypes(`
        input predicate t(j: value).
        r(J) :- t(J), J < 5.
      `),
    ).toThrow(/'<' is not defined on value/);
  });

  test("primitive-to-value auto-lift accepted in value function arguments", () => {
    const typed = getTypes(`
      r(T, S, N) :- T = type_of(5), S = to_json("hi"), N = as_integer(5).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["string", "string", "integer"]);
  });

  test("shared atom variable takes the meet: value narrows to the primitive", () => {
    // X must be a valid value in both the integer and the value column, so its
    // type is the greatest lower bound (integer), not the join (value). X is
    // genuinely integer-valued — the value column merely accepts it.
    const typed = getTypes(`
      input predicate i(x: integer).
      input predicate j(x: value).
      r(X) :- i(X), j(X).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer"]);
  });

  test("shared atom variable order does not affect the meet", () => {
    const typed = getTypes(`
      input predicate i(x: integer).
      input predicate j(x: value).
      r(X) :- j(X), i(X).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer"]);
  });

  test("shared atom variable takes the meet: integer/float narrows to integer", () => {
    const typed = getTypes(`
      input predicate i(x: integer).
      input predicate f(x: float).
      r(X) :- i(X), f(X).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer"]);
  });

  test("meet lets a shared integer/float variable be used in an integer-only op", () => {
    // Under the old join this variable widened to float and `X & 1` was
    // rejected as bitwise-on-float. The meet keeps it integer.
    const typed = getTypes(`
      input predicate i(x: integer).
      input predicate f(x: float).
      r(X, B) :- i(X), f(X), B = X & 1.
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer", "integer"]);
  });

  test("primitive-to-value auto-lift accepted at built-in body atom sources", () => {
    const typed = getTypes(`
      input predicate p(x: integer).
      r(K, V) :- p(X), object_entry(X, K, V).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["string", "value"]);
  });

  test("range bound variable's type is inferred when bounds are bound by later atoms", () => {
    // The safety check and translator Pass 2 are order-independent across a
    // rule body; type inference must be too. Previously a single-pass
    // rebuildVarTypes couldn't resolve `X in [Y..Z]` when Y and Z are bound
    // by an atom appearing after the range.
    const typed = getTypes(`
      input predicate nums(n: integer).
      r(X) :- X in [Y..Z], nums(Y), nums(Z).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer"]);
  });

  test("equality-bound variable's type resolves across body order", () => {
    const typed = getTypes(`
      input predicate nums(n: integer).
      r(D) :- D = Y + 1, nums(Y).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer"]);
  });

  test("reversed equality-bound variable's type resolves across body order", () => {
    const typed = getTypes(`
      input predicate nums(n: integer).
      r(D) :- Y + 1 = D, nums(Y).
    `);
    expect(typed.columnTypes.get("r")).toEqual(["integer"]);
  });

  test("equality-bound variable waits for all expression variable types", () => {
    // `D = Y / 2` can look integer-typed if Y is still unknown and only
    // the literal `2` is visible. Wait until `Y = 1.0` has typed Y as
    // float, otherwise downstream uses of D can choose integer division.
    const typed = getTypes(`
      r(E) :- D = Y / 2, Y = 1.0, E = D / 2.
    `);
    expect(typed.columnTypes.get("r")).toEqual(["float"]);
  });

  test("Regression: query-body equality between incompatible types is rejected like a rule body", () => {
    // The query-body validator's `Equality` case validated each operand
    // expression but, unlike the rule-body case, never called
    // `checkComparableTypes` — so a type conflict that the equivalent
    // rule rejects (`Cannot compare 'integer' and 'string'`) was silently
    // accepted in a `?-` query, despite the comment promising query
    // bodies "get a full type-check".
    expect(() =>
      getTypes(`
        input predicate s(x: integer).
        ?- s(X), Y = X, Y = "hello".
      `),
    ).toThrow(/Cannot compare 'integer' and 'string' in equality/);
  });

  test("Regression: query-body filter must be boolean (no `value` exemption) like a rule body", () => {
    // The query-body `Filter` case allowed `t !== "boolean" && t !==
    // "value"`, exempting a bare `value` filter that the rule-body case
    // (which only permits `boolean`) rejects. A `?-` query using a
    // value-typed term as a filter was therefore silently accepted.
    expect(() =>
      getTypes(`
        input predicate v(x: value).
        ?- v(V), V.
      `),
    ).toThrow(/Filter expression must be boolean, got 'value'/);
  });
});

describe("bitwise / shift operator types", () => {
  test("bitwise / shift expressions produce integer", () => {
    const typed = getTypes(`
      input predicate base(x: integer).
      masked(X, M) :- base(X), M = X & 255.
      shifted(X, S) :- base(X), S = (X << 2) | 1.
      xored(X, R) :- base(X), R = X ^ 1, X >>> 1 = 0.
    `);
    expect(typed.columnTypes.get("masked")).toEqual(["integer", "integer"]);
    expect(typed.columnTypes.get("shifted")).toEqual(["integer", "integer"]);
    expect(typed.columnTypes.get("xored")).toEqual(["integer", "integer"]);
  });

  test("rejects a bitwise op with a float operand", () => {
    expect(() =>
      getTypes(`
        input predicate t(f: float).
        r(X) :- t(F), X = F & 1.
      `),
    ).toThrow(/Operator '&' requires integer operands.*'float'/);
  });

  test("rejects a shift op with a string operand", () => {
    expect(() =>
      getTypes(`
        input predicate t(s: string).
        r(X) :- t(S), X = S << 1.
      `),
    ).toThrow(/Operator '<<' requires integer operands.*'string'/);
  });

  test("rejects a bitwise op with a value operand", () => {
    expect(() =>
      getTypes(`
        input predicate t(v: value).
        r(X) :- t(V), X = V | 1.
      `),
    ).toThrow(/Operator '\|' requires integer operands.*'value'/);
  });
});

describe("exponentiation operator ** types", () => {
  test("** is always float, even for integer operands", () => {
    const typed = getTypes(`
      input predicate base(x: integer).
      sq(X, S) :- base(X), S = X ** 2.
    `);
    // X ** 2 has integer operands but a float result, like the old power().
    expect(typed.columnTypes.get("sq")).toEqual(["integer", "float"]);
  });

  test("rejects ** with a string operand", () => {
    expect(() =>
      getTypes(`
        input predicate t(s: string).
        r(X) :- t(S), X = S ** 2.
      `),
    ).toThrow(/Operator '\*\*' requires numeric operands.*'string'/);
  });
});

describe("columnTypesCompatible (directional subtype check)", () => {
  test("declared may equal or widen the inferred type", () => {
    expect(columnTypesCompatible("integer", "integer")).toBe(true);
    expect(columnTypesCompatible("integer", "value")).toBe(true); // widen to value
    expect(columnTypesCompatible("integer", "float")).toBe(true); // numeric widening
    expect(columnTypesCompatible("string", "value")).toBe(true);
  });

  test("declaring narrower than the inferred type is rejected", () => {
    expect(columnTypesCompatible("value", "integer")).toBe(false);
    expect(columnTypesCompatible("float", "integer")).toBe(false);
    expect(columnTypesCompatible("value", "string")).toBe(false);
  });

  test("unrelated types are incompatible either way", () => {
    expect(columnTypesCompatible("string", "integer")).toBe(false);
    expect(columnTypesCompatible("integer", "string")).toBe(false);
  });
});
