import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { type AnalyzerError, analyze } from "../src/analyzer.ts";
import { inferTypes } from "../src/types.ts";

describe("analyzer", () => {
  test("classifies input predicate predicates", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
    `);
    const result = analyze(program);
    expect(result.extDecls.has("parent")).toBe(true);
    expect(result.rules.has("ancestor")).toBe(true);
    expect(result.rules.has("parent")).toBe(false);
  });

  test("builds dependency graph", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    `);
    const result = analyze(program);
    expect(result.dependencies.get("ancestor")).toEqual(new Set(["parent", "ancestor"]));
  });

  test("detects self-recursion", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    `);
    const result = analyze(program);
    expect(result.recursivePredicates.has("ancestor")).toBe(true);
  });

  test("detects non-recursive predicates", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      grandparent(X, Y) :- parent(X, Z), parent(Z, Y).
    `);
    const result = analyze(program);
    expect(result.recursivePredicates.has("grandparent")).toBe(false);
  });

  test("errors on duplicate input predicate declaration", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      input predicate parent(name: string, child: string).
    `);
    expect(() => analyze(program)).toThrow(/multiple times/);
  });

  test("rejects duplicate input predicate column names", () => {
    const program = parse(`
      input predicate parent(name: string, name: string).
    `);
    expect(() => analyze(program)).toThrow(/duplicate column name 'name'/);
  });

  test("rejects a source binding (resolver not wired up yet)", () => {
    // A `:=` binding is elaborated away by the module resolver before analysis;
    // until that exists, a surviving binding must error rather than be ignored.
    expect(() => analyze(parse('input predicate p(a: integer) := "p.csv".'))).toThrow(
      /source bindings.*not yet supported/,
    );
    expect(() =>
      analyze(
        parse('input predicate d(a: integer, b: integer) := reach from "reach.dl"(edge = e).'),
      ),
    ).toThrow(/not yet supported/);
  });

  test("allows built-in function names as input predicate columns", () => {
    // Columns are non-callable (declared `name: type`, matched positionally),
    // so like variables they may reuse a built-in function name without
    // quoting. The reservation only applies to predicate names, where a bare
    // `f(...)` would be ambiguous with a call to the built-in.
    for (const name of ["length", "count", "object_entry", "sum"]) {
      const program = parse(`input predicate t(${name}: integer).`);
      expect(() => analyze(program)).not.toThrow();
    }
  });

  test("allows quoted reserved predicate and column names", () => {
    const program = parse(`
      input predicate \`length\`(\`count\`: integer).
      \`sum\`(X) :- \`length\`(X).
      ?- \`sum\`(X).
    `);
    const result = analyze(program);
    expect(result.extDecls.has("length")).toBe(true);
    expect(result.rules.has("sum")).toBe(true);
  });

  test("errors on arity mismatch between rules", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      related(X, Y) :- parent(X, Y).
      related(X) :- parent(X, "alice").
    `);
    expect(() => analyze(program)).toThrow(/arity/);
  });

  test("errors on arity mismatch in rule body", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      wrong(X) :- parent(X).
    `);
    expect(() => analyze(program)).toThrow(/arity 2 but is used with 1/);
  });

  test("errors on arity mismatch in query", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      ?- parent(X).
    `);
    expect(() => analyze(program)).toThrow(/arity 2 but is used with 1/);
  });

  test("errors on predicate that is both EDB and IDB", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      parent(X, Y) :- parent(X, Y).
    `);
    expect(() => analyze(program)).toThrow(/both an input predicate and defined by rules/);
  });

  test("topological sort produces valid order", () => {
    const program = parse(`
      input predicate edge(src: string, dst: string).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
      reachable(X) :- path("start", X).
    `);
    const result = analyze(program);
    const strata = result.sortedStrata;
    const pathIdx = strata.findIndex((s) => s.includes("path"));
    const reachableIdx = strata.findIndex((s) => s.includes("reachable"));
    expect(pathIdx).toBeLessThan(reachableIdx);
  });

  test("detects mutual recursion", () => {
    const program = parse(`
      input predicate base(x: integer).
      even(X) :- base(X).
      even(X) :- odd(X).
      odd(X) :- even(X).
    `);
    const result = analyze(program);
    expect(result.recursivePredicates.has("even")).toBe(true);
    expect(result.recursivePredicates.has("odd")).toBe(true);
    // even and odd should be in the same stratum
    const stratum = result.sortedStrata.find((s) => s.includes("even"));
    expect(stratum).toContain("odd");
  });

  test("collects queries", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
      ?- ancestor("alice", X).
    `);
    const result = analyze(program);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]?.body[0]).toMatchObject({ $type: "Literal", predicate: "ancestor" });
  });

  test("accepts stratified negation", () => {
    const program = parse(`
      input predicate node(name: string).
      input predicate edge(src: string, dst: string).
      reachable(X) :- edge("start", X).
      reachable(X) :- edge(Y, X), reachable(Y).
      unreachable(X) :- node(X), not reachable(X).
    `);
    const result = analyze(program);
    expect(result.rules.has("unreachable")).toBe(true);
    expect(result.negativeDependencies.get("unreachable")).toEqual(new Set(["reachable"]));
  });

  test("rejects unstratifiable negation", () => {
    const program = parse(`
      input predicate base(x: string).
      foo(X) :- base(X), not bar(X).
      bar(X) :- base(X), not foo(X).
    `);
    expect(() => analyze(program)).toThrow(/not stratifiable/);
  });

  test("rejects self-negation", () => {
    const program = parse(`
      input predicate base(x: string).
      foo(X) :- base(X), not foo(X).
    `);
    expect(() => analyze(program)).toThrow(/not stratifiable/);
  });

  test("rejects unsafe negation", () => {
    const program = parse(`
      input predicate base(x: string).
      input predicate bar(x: string, y: string).
      foo(X) :- base(X), not bar(X, Y).
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable 'Y'/);
  });

  test("accepts safe equality", () => {
    const program = parse(`
      input predicate scores(name: string, score: integer).
      doubled(X, Y) :- scores(X, S), Y = S * 2.
    `);
    const result = analyze(program);
    expect(result.rules.has("doubled")).toBe(true);
  });

  test("accepts equality binding from either side", () => {
    const program = parse(`
      input predicate base(x: integer).
      rename(X) :- base(Y), Y = X.
      plus_one(Y) :- base(X), X + 1 = Y.
    `);
    const result = analyze(program);
    expect(result.rules.has("rename")).toBe(true);
    expect(result.rules.has("plus_one")).toBe(true);
  });

  test("rejects unsafe equality RHS variable", () => {
    const program = parse(`
      input predicate base(x: integer).
      bad(X) :- base(X), Y = X + Z.
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable 'Z'/);
  });

  test("accepts chained equalities", () => {
    const program = parse(`
      input predicate base(x: integer).
      chain(X, Z) :- base(X), Y = X + 1, Z = Y * 2.
    `);
    const result = analyze(program);
    expect(result.rules.has("chain")).toBe(true);
  });

  test("rejects unsafe head variable from expression", () => {
    const program = parse(`
      input predicate base(x: integer).
      bad(X, Y) :- base(X).
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable 'Y'/);
  });

  test("a bare null does not ground a variable", () => {
    // `null` is polymorphic, so `X = null` says nothing about what X holds
    // and cannot determine the column's type. Binding X anyway produces a
    // column no rule constrains, reported far from the cause.
    expect(() => analyze(parse("q(X) :- X = null."))).toThrow(/Unsafe variable 'X'/);
    // Either side, and it does not matter that a sibling rule types the column.
    expect(() => analyze(parse("q(X) :- null = X."))).toThrow(/Unsafe variable 'X'/);
    expect(() => analyze(parse("q(1). q(X) :- X = null."))).toThrow(/Unsafe variable 'X'/);
    // Nor does it help to route it through another variable: an ungrounded N
    // leaves the range unable to ground X. Body elements are checked before
    // head variables, so the report names N at the equality that fails to
    // ground it, rather than X, which no edit can fix without fixing N.
    expect(() => analyze(parse("q(X) :- N = null, X in [1 .. N]."))).toThrow(
      /Unsafe variable 'N' in left-hand side of equality/,
    );
  });

  test("an equality whose other side mentions the variable grounds nothing", () => {
    // Grounding X means evaluating the other side, which needs X already. The
    // fixed-point callers reject these by never finding the other side ready,
    // but a caller that only asks "could this ground X" needs the direct
    // answer: reading `X = X` as a binding is what let a float-bounded range
    // beside it pass for a filter and then diverge across backends.
    expect(() => analyze(parse("q(X) :- X = X."))).toThrow(/Unsafe variable 'X'/);
    expect(() => analyze(parse("q(X) :- X = X + 1."))).toThrow(/Unsafe variable 'X'/);
    // A genuine binding from the same shape is unaffected.
    expect(
      analyze(parse("input predicate t(x: integer).\nq(Y) :- t(X), Y = X + 1.")).rules.has("q"),
    ).toBe(true);
  });

  test("naming the type grounds a null", () => {
    // A call's result type is fixed by its signature whatever its argument
    // denotes, so it supplies the type the bare literal cannot. The value is
    // still NULL at runtime.
    for (const cast of ["as_integer", "as_string", "as_float", "as_boolean"]) {
      expect(analyze(parse(`q(X) :- X = ${cast}(null).`)).rules.has("q")).toBe(true);
    }
    expect(analyze(parse('q(X) :- X = parse_json("null").')).rules.has("q")).toBe(true);
    // Arithmetic works the same way, since an untyped operand is ignored.
    expect(analyze(parse("q(X) :- X = null + 0.")).rules.has("q")).toBe(true);
  });

  test("a null equality still filters an already-grounded variable", () => {
    // `X = null` is unaffected where X is grounded elsewhere: it stays the
    // null-aware filter that selects NULL rows.
    const program = parse(`
      input predicate t(x: integer?).
      nulls(X) :- t(X), X = null.
    `);
    expect(analyze(program).rules.has("nulls")).toBe(true);
  });

  test("accepts safe comparison", () => {
    const program = parse(`
      input predicate scores(name: string, score: integer).
      high(X) :- scores(X, S), S > 80.
    `);
    const result = analyze(program);
    expect(result.rules.has("high")).toBe(true);
  });

  test("rejects unsafe variable in comparison", () => {
    const program = parse(`
      input predicate base(x: integer).
      bad(X) :- base(X), Y > 10.
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable 'Y'/);
  });

  test("handles facts (rules with empty body)", () => {
    const program = parse(`
      base("hello").
      derived(X) :- base(X).
    `);
    const result = analyze(program);
    expect(result.rules.has("base")).toBe(true);
    expect(result.rules.get("base")).toHaveLength(1);
    expect(result.rules.get("base")?.[0]?.body).toHaveLength(0);
  });

  test("accepts range atom binding a variable", () => {
    const program = parse(`
      foo(X) :- X in [1 .. 10].
    `);
    const result = analyze(program);
    expect(result.rules.has("foo")).toBe(true);
  });

  test("accepts range atom with bound expression", () => {
    const program = parse(`
      input predicate nums(x: integer).
      filtered(X) :- nums(X), X in [1 .. 100].
    `);
    const result = analyze(program);
    expect(result.rules.has("filtered")).toBe(true);
  });

  test("accepts range with expression bounds from safe variables", () => {
    const program = parse(`
      input predicate base(x: integer, y: integer).
      inrange(X) :- base(X, Y), X in [Y .. Y + 10].
    `);
    const result = analyze(program);
    expect(result.rules.has("inrange")).toBe(true);
  });

  test("rejects range with unsafe variable in bounds", () => {
    const program = parse(`
      input predicate base(x: integer).
      bad(X) :- base(X), X in [Y .. 10].
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable 'Y'/);
  });

  test("rejects range with unsafe non-variable expression", () => {
    const program = parse(`
      input predicate base(x: integer).
      bad(X) :- base(X), Y + 1 in [1 .. 10].
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable 'Y'/);
  });

  test("accepts aggregate rule with count", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      num_children(P, count(C)) :- parent(P, C).
    `);
    const result = analyze(program);
    expect(result.rules.has("num_children")).toBe(true);
  });

  test("accepts aggregate rule with count(*)", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      total(count(*)) :- parent(_, _).
    `);
    const result = analyze(program);
    expect(result.rules.has("total")).toBe(true);
  });

  test("accepts aggregate rule with no grouping variables", () => {
    const program = parse(`
      input predicate scores(name: string, score: integer).
      total_score(sum(S)) :- scores(_, S).
    `);
    const result = analyze(program);
    expect(result.rules.has("total_score")).toBe(true);
  });

  test("rejects count(_): the row-count idiom is count(*)", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      total(count(_)) :- parent(_, _).
    `);
    expect(() => analyze(program)).toThrow(/count\(\*\)/);
  });

  test("rejects '*' in an aggregate other than count", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      total(sum(*)) :- parent(_, _).
    `);
    expect(() => analyze(program)).toThrow(/only valid as the argument of count\(\*\)/);
  });

  test("rejects '*' outside count(*)", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      bad(P) :- parent(P, *).
    `);
    expect(() => analyze(program)).toThrow(/count\(\*\)|Unsafe/);
  });

  test("rejects mixed aggregate and non-aggregate rules", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      foo(P, count(C)) :- parent(P, C).
      foo("nobody", 0).
    `);
    expect(() => analyze(program)).toThrow(/both aggregate and non-aggregate/);
  });

  test("rejects aggregate embedded in expression", () => {
    const program = parse(`
      input predicate scores(name: string, score: integer).
      bad(X, sum(S) + 1) :- scores(X, S).
    `);
    expect(() => analyze(program)).toThrow(/top-level head argument/);
  });

  test("rejects nested aggregates", () => {
    const program = parse(`
      input predicate scores(name: string, score: integer).
      bad(X, count(sum(S))) :- scores(X, S).
    `);
    expect(() => analyze(program)).toThrow(/Nested aggregate/);
  });

  test("rejects recursive aggregate predicate", () => {
    const program = parse(`
      input predicate edge(src: string, dst: string).
      cnt(X, count(Y)) :- edge(X, Y).
      cnt(X, count(Y)) :- cnt(X, Y).
    `);
    expect(() => analyze(program)).toThrow(/cannot be recursive/);
  });

  test("rejects rules disagreeing on aggregate positions", () => {
    const program = parse(`
      input predicate t(a: integer, b: integer).
      foo(X, count(Y)) :- t(X, Y).
      foo(count(X), Y) :- t(X, Y).
    `);
    expect(() => analyze(program)).toThrow(/disagree on which head positions/);
  });

  test("rejects rules disagreeing on which aggregate function to apply", () => {
    // Regression: the analyzer only checked that aggregate POSITIONS
    // matched across rules — `total(X, count(*)) :- p(X).` and
    // `total(X, sum(Y)) :- q(X, Y).` both have an aggregate at
    // column 2, so the position check passed and the program was
    // accepted. The translator then emitted both rules into a SQL
    // `UNION` whose `col2` carried a `count` value from one branch
    // and a `sum` value from the other — a single column mixing
    // semantically incompatible aggregates. Reject at analyse time
    // so the error surfaces with a source position.
    const program = parse(`
      input predicate p(x: integer).
      input predicate q(x: integer, y: integer).
      total(X, count(*)) :- p(X).
      total(X, sum(Y)) :- q(X, Y).
    `);
    expect(() => analyze(program)).toThrow(/aggregate function/);
  });

  test("rejects aggregate in a fact (empty body)", () => {
    const program = parse("total(count(*)).");
    expect(() => analyze(program)).toThrow(/cannot contain an aggregate/);
  });

  test("rejects list(_) — only count(*) is special-cased", () => {
    // `count(*)` translates to `COUNT(*)` and counts rows regardless
    // of value. No other aggregate has a meaningful interpretation
    // for the don't-care marker — `list(_)` would conceptually mean
    // "collect a placeholder per row", which has no useful semantics
    // and would diverge between backends. Reject via the existing
    // safety check (anonymous vars unsafe outside positive atoms +
    // `count(*)`).
    const program = parse(`
      input predicate t(x: integer).
      r(list(_)) :- t(_).
    `);
    expect(() => analyze(program)).toThrow(/don't-care variable/);
  });

  test("rejects aggregate-in-fact even with constant argument", () => {
    const program = parse("total(sum(1)).");
    expect(() => analyze(program)).toThrow(/cannot contain an aggregate/);
  });

  test("rejects count(_X) where _X is an unbound user-typed variable", () => {
    // `_X` starts with underscore but isn't the parser's anonymous `_`
    // (which gets rewritten to an internal-only name). It must be bound
    // in the body before it can appear in `count(...)`, otherwise we'd
    // silently emit `COUNT(*)` against an unrelated join.
    const program = parse(`
      input predicate parent(name: string, child: string).
      total(count(_X)) :- parent(_, _).
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable '_X'/);
  });

  test("rejects count(_0) where _0 is an unbound user-typed variable", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      total(count(_0)) :- parent(_, _).
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable '_0'/);
  });

  test("rejects not p(_Y) with an unbound user-typed _Y", () => {
    // Same reasoning as count(_X): `_Y` is user-typed and must be bound
    // somewhere, not treated as the anonymous don't-care variable.
    const program = parse(`
      input predicate edge(src: string, dst: string).
      lonely(X) :- edge(X, _), not edge(_Y, X).
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable '_Y'/);
  });

  test("accepts multiple aggregate rules for same predicate", () => {
    const program = parse(`
      input predicate t1(a: string, b: integer).
      input predicate t2(a: string, b: integer).
      totals(X, sum(Y)) :- t1(X, Y).
      totals(X, sum(Y)) :- t2(X, Y).
    `);
    const result = analyze(program);
    expect(result.rules.has("totals")).toBe(true);
  });

  test("rejects aggregate function name as predicate", () => {
    const program = parse(`
      input predicate base(x: integer).
      count(X) :- base(X).
    `);
    expect(() => analyze(program)).toThrow(/conflicts with built-in aggregate/);
  });

  test("rejects aggregate function name as input predicate predicate", () => {
    const program = parse(`
      input predicate sum(x: integer).
    `);
    expect(() => analyze(program)).toThrow(/conflicts with built-in aggregate/);
  });

  test("rejects ordinary built-in function name as predicate", () => {
    const program = parse(`
      input predicate base(x: string).
      length(X) :- base(X).
    `);
    expect(() => analyze(program)).toThrow(/conflicts with built-in function 'length'/);
  });

  test("rejects undefined predicate in rule body", () => {
    const program = parse(`
      input predicate parnt(name: string, child: string).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    `);
    expect(() => analyze(program)).toThrow(/Predicate 'parent' is not defined/);
  });

  test("rejects undefined predicate in query", () => {
    const program = parse(`
      input predicate parent(name: string, child: string).
      ?- ancestor("alice", X).
    `);
    expect(() => analyze(program)).toThrow(/Predicate 'ancestor' is not defined/);
  });

  test("detects non-linear self-recursion", () => {
    const program = parse(`
      input predicate edge(src: string, dst: string).
      tc(X, Y) :- edge(X, Y).
      tc(X, Z) :- tc(X, Y), tc(Y, Z).
    `);
    const result = analyze(program);
    expect(result.nonLinearPredicates.has("tc")).toBe(true);
  });

  test("linear recursion is not flagged as non-linear", () => {
    const program = parse(`
      input predicate edge(src: string, dst: string).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- edge(X, Z), path(Z, Y).
    `);
    const result = analyze(program);
    expect(result.nonLinearPredicates.has("path")).toBe(false);
  });

  test("detects non-linear mutual recursion", () => {
    const program = parse(`
      input predicate base(x: integer).
      a(X) :- base(X).
      a(X) :- b(X), a(X).
      b(X) :- a(X).
    `);
    const result = analyze(program);
    expect(result.nonLinearPredicates.has("a")).toBe(true);
    expect(result.nonLinearPredicates.has("b")).toBe(true);
  });

  test("linear mutual recursion is not flagged", () => {
    const program = parse(`
      input predicate base(x: integer).
      even(X) :- base(X).
      even(X) :- odd(X).
      odd(X) :- even(X).
    `);
    const result = analyze(program);
    expect(result.nonLinearPredicates.has("even")).toBe(false);
    expect(result.nonLinearPredicates.has("odd")).toBe(false);
  });

  test("rejects unknown function on the LHS of an equality", () => {
    // `checkFunctionCalls` used to only recurse into `elem.expr`, so
    // `unknownfn(X) = 5` passed analysis and only failed at translation.
    const program = parse(`
      input predicate t(x: integer).
      r(X) :- t(X), unknownfn(X) = 5.
    `);
    expect(() => analyze(program)).toThrow(/Unknown function 'unknownfn'/);
  });

  test("rejects negated-only query atom as unsafe", () => {
    // `?- not t(X).` — X is mentioned only inside a negated atom, so
    // no body binding grounds it and the projection variable is
    // unsafe. The safety pass rejects it.
    const program = parse(`
      input predicate t(x: integer).
      ?- not t(X).
    `);
    expect(() => analyze(program)).toThrow(/Unsafe variable 'X'/);
  });

  test("accepts safe negated literals in queries", () => {
    // `?- t(X), not t2(X)` is the classical use case: positive atom
    // grounds X, the negated atom then constrains.
    const program = parse(`
      input predicate t(x: integer).
      input predicate t2(x: integer).
      ?- t(X), not t2(X).
    `);
    expect(() => analyze(program)).not.toThrow();
  });

  describe("built-in body atoms (object_entry / array_element)", () => {
    test("rejects input predicate declaration that shadows a built-in", () => {
      const program = parse(`
        input predicate object_entry(o: value, k: string, v: value).
      `);
      expect(() => analyze(program)).toThrow(/'object_entry' conflicts with built-in body atom/);
    });

    test("rejects rule head that shadows a built-in", () => {
      const program = parse(`
        input predicate p(x: integer).
        array_element(X) :- p(X).
      `);
      expect(() => analyze(program)).toThrow(/'array_element' conflicts with built-in body atom/);
    });

    test("rejects negated built-in body atom", () => {
      const program = parse(`
        input predicate p(j: value).
        r(K, V) :- p(J), not object_entry(J, K, V).
      `);
      expect(() => analyze(program)).toThrow(/'object_entry' cannot be negated/);
    });

    test("rejects built-in as the only query body element (source-arg unsafe)", () => {
      // The source-arg `J` of `object_entry` must be safe, but
      // nothing else in the query body grounds it.
      const program = parse(`
        input predicate p(j: value).
        ?- object_entry(J, K, V).
      `);
      expect(() => analyze(program)).toThrow(/Unsafe variable 'J'/);
    });

    test("allows built-in body atoms in queries when source arg is safe", () => {
      // `?- p(J), object_entry(J, K, V).` is the classical
      // multi-literal query shape that uses object iteration; `p`
      // grounds `J`, so the built-in is safe to fire.
      const program = parse(`
        input predicate p(j: value).
        ?- p(J), object_entry(J, K, V).
      `);
      expect(() => analyze(program)).not.toThrow();
    });

    test("rejects wrong arity", () => {
      const program = parse(`
        input predicate p(j: value).
        r(K) :- p(J), object_entry(J, K).
      `);
      expect(() => analyze(program)).toThrow(/Built-in 'object_entry' has arity 3/);
    });

    test("rejects unsafe source argument", () => {
      // Source variable J is never bound by any positive atom — the
      // built-in atom can't fire because there's no value to iterate.
      // The analyzer walks head before body, so K (which depends on J
      // via the iteration's bind chain) gets flagged first; the
      // underlying cause is still J's unsafety.
      const program = parse(`
        input predicate p(x: integer).
        r(K, V) :- p(X), object_entry(J, K, V).
      `);
      expect(() => analyze(program)).toThrow(/Unsafe variable/);
    });

    test("accepts safe source argument", () => {
      const program = parse(`
        input predicate p(j: value).
        r(K, V) :- p(J), object_entry(J, K, V).
      `);
      expect(() => analyze(program)).not.toThrow();
    });

    test("source argument accepts primitive-to-value auto-lift", () => {
      const program = parse(`
        input predicate p(x: integer).
        r(K, V) :- p(X), object_entry(X, K, V).
      `);
      expect(() => inferTypes(analyze(program))).not.toThrow();
    });

    test("built-in body atoms do not contribute to dependency graph", () => {
      const program = parse(`
        input predicate p(j: value).
        r(K, V) :- p(J), object_entry(J, K, V).
      `);
      const result = analyze(program);
      // Only 'p' is a float dependency of 'r'. Without skipping built-ins,
      // 'object_entry' would show up in the deps set and be misclassified.
      expect(result.dependencies.get("r")).toEqual(new Set(["p"]));
    });
  });

  describe("source file on errors", () => {
    // Source positions generalise to name their file (for the module system):
    // the file threads through parse -> analyze -> inferTypes and lands on any
    // error each stage throws. File-less input (a REPL chunk / stdin) leaves it
    // undefined.
    const analyzeFileOf = (src: string, file?: string): string | undefined => {
      try {
        analyze(parse(src, file), file);
      } catch (e) {
        return (e as AnalyzerError).file;
      }
      return "NO ERROR";
    };

    test("an analyzer error carries the source file", () => {
      // `X` in the head is not bound by any positive body atom -> unsafe.
      expect(analyzeFileOf("p(X) :- q(Y).", "prog.dl")).toBe("prog.dl");
      expect(analyzeFileOf("p(X) :- q(Y).")).toBeUndefined();
    });

    test("a type-inference error carries the source file", () => {
      const src = 'input predicate w(x: string).\nbad(X) :- w(X), X in ["a" .. "z"].';
      try {
        inferTypes(analyze(parse(src, "prog.dl"), "prog.dl"));
        throw new Error("expected a type error");
      } catch (e) {
        expect((e as AnalyzerError).file).toBe("prog.dl");
      }
    });
  });
});
