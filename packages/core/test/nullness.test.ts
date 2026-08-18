import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { inferTypes } from "../src/types.ts";

// Nullness inference: which columns can hold SQL NULL, and which variables a
// body proves cannot. See doc/design/nullness-tracking.md §4 for the design and
// §4.2 for the refinement table these tests walk.

/** Per-column nullness of `predicate`. */
function cols(source: string, predicate: string): boolean[] {
  const typed = inferTypes(analyze(parse(source)));
  const nullness = typed.nullness.columnNullness.get(predicate);
  expect(nullness).toBeDefined();
  return [...nullness!];
}

/** The variables the first rule of `predicate` proves non-null. */
function proven(source: string, predicate: string): string[] {
  const typed = inferTypes(analyze(parse(source)));
  const rule = typed.rules.get(predicate)![0]!;
  return [...typed.nullness.nonNullVars.get(rule.body)!].sort();
}

describe("extensional columns", () => {
  test("a column takes its declared `?`", () => {
    const source = "input predicate p(a: integer, b: integer?).\nq(X, Y) :- p(X, Y).";
    expect(cols(source, "p")).toEqual([false, true]);
  });

  test("an unannotated column defaults to non-null along with its `string` type", () => {
    const source = "input predicate p(a).\nq(X) :- p(X).";
    expect(cols(source, "p")).toEqual([false]);
  });
});

describe("propagation into intensional columns", () => {
  test("a non-null source keeps the column non-null", () => {
    const source = "input predicate p(a: integer).\nq(X) :- p(X).";
    expect(cols(source, "q")).toEqual([false]);
  });

  test("a nullable source makes it nullable", () => {
    const source = "input predicate p(a: integer?).\nq(X) :- p(X).";
    expect(cols(source, "q")).toEqual([true]);
  });

  test("one nullable sibling rule is enough", () => {
    const source = `
      input predicate p(a: integer).
      input predicate r(a: integer?).
      q(X) :- p(X).
      q(X) :- r(X).
    `;
    expect(cols(source, "q")).toEqual([true]);
  });

  test("a bare null head argument originates nullness", () => {
    // A sibling rule has to type the column, a bare `null` having no type of
    // its own (null.md §7).
    const source = `
      input predicate p(a: integer).
      q(X, 1) :- p(X).
      q(X, null) :- p(X).
    `;
    expect(cols(source, "q")).toEqual([false, true]);
  });
});

describe("operations", () => {
  test("a partial operation originates no nullness, because it yields no value", () => {
    // These three used to be nullable, and the reason they are not is the point
    // of doc/design/null-as-a-value.md: a zero divisor, an integer overflow and
    // a non-finite float each leave the expression with *no value*, so the row
    // is withheld rather than kept with a NULL in it. Nothing null-valued ever
    // reaches the column.
    const source = `
      input predicate p(a: integer, b: integer, f: float).
      divided(X) :- p(A, B, _), X = A / B.
      overflowed(X) :- p(A, _, _), X = A + 1.
      unfinite(X) :- p(_, _, F), X = F * 2.0.
    `;
    expect(cols(source, "divided")).toEqual([false]);
    expect(cols(source, "overflowed")).toEqual([false]);
    expect(cols(source, "unfinite")).toEqual([false]);
  });

  test("a null cannot reach arithmetic at all, so the guard makes it non-null", () => {
    // Position 3 (§5) rejects a nullable operand outright, so the propagation
    // path is unreachable from a `T?` column: guarding is the only way to write
    // the rule, and the guard is what makes the result non-null.
    const source = `
      input predicate p(a: integer?).
      q(X) :- p(A), A <> null, X = A + 1.
    `;
    expect(cols(source, "q")).toEqual([false]);
    expect(() =>
      cols(
        `
      input predicate p(a: integer?).
      q(X) :- p(A), X = A + 1.
    `,
        "q",
      ),
    ).toThrow(/can be null, and `\+` needs a value/);
  });

  test("propagation is still what happens where a null can reach an operator", () => {
    // A `value` operand is exempt (§9.3: it spells its null the JSON way, so
    // there is no SQL NULL to disambiguate), and that is the case where the
    // propagation branch of `mayBeNull` still earns its keep.
    const source = `
      input predicate p(a: value).
      q(X) :- p(A), X = A["k"].
    `;
    expect(cols(source, "q")).toEqual([true]);
  });

  test("string concatenation is total", () => {
    const source = `
      input predicate p(a: string).
      q(X) :- p(A), X = A + "!".
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("no builtin originates nullness unless its result can be a JSON null", () => {
    // A failed `to_integer` has no value rather than a null, so it originates
    // nothing. `parse_json` is the exception, and for a real reason: its result
    // is `value`-typed and `parse_json("null")` is the null value.
    const source = `
      input predicate p(a: string).
      parsed(X) :- p(A), X = to_integer(A).
      upped(X) :- p(A), X = upper(A).
      jsonified(X) :- p(A), X = parse_json(A).
    `;
    expect(cols(source, "parsed")).toEqual([false]);
    expect(cols(source, "upped")).toEqual([false]);
    expect(cols(source, "jsonified")).toEqual([true]);
  });

  test("comparison is total, so a comparison result is never null", () => {
    const source = `
      input predicate p(a: integer?).
      q(B) :- p(A), B = (A < 2).
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("construction is not propagation: an array of nulls is a value", () => {
    const source = `
      input predicate p(a: integer?).
      q(X) :- p(A), X = [A].
    `;
    expect(cols(source, "q")).toEqual([false]);
  });
});

describe("refinement from body constraints", () => {
  const decl = "input predicate p(a: integer?).\n";

  test("`X <> null` proves it", () => {
    expect(cols(`${decl}q(X) :- p(X), X <> null.`, "q")).toEqual([false]);
  });

  test("`not (X = null)` proves the same fact", () => {
    expect(cols(`${decl}q(X) :- p(X), not (X = null).`, "q")).toEqual([false]);
  });

  test("a strict comparison proves both sides", () => {
    expect(cols(`${decl}q(X) :- p(X), X < 100.`, "q")).toEqual([false]);
    expect(cols(`${decl}q(X) :- p(X), 100 > X.`, "q")).toEqual([false]);
  });

  test("`<=` and `>=` prove it too, every ordering being strict at null", () => {
    // These proved nothing while `null <= null` was true by convention. §4.1
    // makes an ordering have no value at a null instead, so one that holds has
    // non-null operands, exactly as `<` and `>` did.
    expect(cols(`${decl}q(X) :- p(X), X <= 100.`, "q")).toEqual([false]);
    expect(cols(`${decl}q(X) :- p(X), X >= 100.`, "q")).toEqual([false]);
  });

  test("`not (X < 2)` proves nothing: that is where the null row lives", () => {
    expect(cols(`${decl}q(X) :- p(X), not (X < 2).`, "q")).toEqual([true]);
  });

  test("a range atom proves it", () => {
    expect(cols(`${decl}q(X) :- p(X), X in [1 .. 10].`, "q")).toEqual([false]);
  });

  test("`&&` proves what either side does", () => {
    expect(cols(`${decl}q(X) :- p(X), (X <> null) && (X <= 100).`, "q")).toEqual([false]);
  });

  test("`||` proves it only when both branches do", () => {
    expect(cols(`${decl}q(X) :- p(X), (X <> null) || (X > 5).`, "q")).toEqual([false]);
    // One branch that proves nothing is enough to lose it. `X = null` is the
    // branch to use now that every ordering proves its operands non-null.
    expect(cols(`${decl}q(X) :- p(X), (X <> null) || (X = null).`, "q")).toEqual([true]);
  });

  test("a guard reaches through a strict operation", () => {
    const source = `${decl}q(X) :- p(Y), Y <> null, X = Y & 1.`;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("a strict builtin carries the guard to its argument", () => {
    const source = `
      input predicate p(a: string?).
      q(X) :- p(X), length(X) > 0.
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("a non-strict operator blocks the walk", () => {
    // `(X <> null) <> null` is non-null whatever X is, so it proves nothing.
    const source = `${decl}q(X) :- p(X), (X <> null) <> null.`;
    expect(cols(source, "q")).toEqual([true]);
  });

  test("a shared variable takes the non-null side", () => {
    const source = `
      input predicate p(a: integer?).
      input predicate r(a: integer).
      q(X) :- p(X), r(X).
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("a negated atom proves nothing", () => {
    const source = `
      input predicate p(a: integer?).
      input predicate r(a: integer).
      q(X) :- p(X), not r(X).
    `;
    expect(cols(source, "q")).toEqual([true]);
  });

  test("order does not matter: a guard written last refines an atom written first", () => {
    const before = `${decl}q(X) :- X <> null, p(X).`;
    const after = `${decl}q(X) :- p(X), X <> null.`;
    expect(cols(before, "q")).toEqual([false]);
    expect(cols(after, "q")).toEqual([false]);
  });

  test("refinement is reported per body, naming the proven variables", () => {
    // Both, and `Y` is the interesting one: `Y <= 3` now proves it non-null,
    // where it proved nothing while `<=` held of two nulls.
    const source = `
      input predicate p(a: integer?, b: integer?).
      q(X) :- p(X, Y), X <> null, Y <= 3.
    `;
    expect(proven(source, "q")).toEqual(["X", "Y"]);
  });

  test("a variable no conjunct constrains stays unproven", () => {
    const source = `
      input predicate p(a: integer?, b: integer?).
      q(X) :- p(X, Y), X <> null, Y = null.
    `;
    expect(proven(source, "q")).toEqual(["X"]);
  });

  test("`not (!(X < 2))` proves nothing, there being no double-negation law here", () => {
    // `!` propagates an absence rather than complementing it, so `!(X < 2)` has no
    // value at a null `X` and `not` holds of it: the null row survives the
    // conjunct. Eliminating the two negations would claim `X < 2`, which proves
    // `X` non-null, and that claim is false of the row that is actually there.
    //
    // It mattered twice before it was fixed: the join lowered to a plain `=` and
    // lost a null-to-null match on SQL while the interpreters kept it, and
    // Position 3 accepted `X + 1` over an operand that can be null.
    expect(cols(`${decl}q(X) :- p(X), not (!(X < 2)).`, "q")).toEqual([true]);
    // The other direction is sound and still narrows: `!e` is true only where `e`
    // has a value and is false.
    expect(cols(`${decl}q(X) :- p(X), !(X = null).`, "q")).toEqual([false]);
  });
});

// No aggregate is nullable, whatever it aggregates and whether or not it groups.
// §7 of null-as-a-value.md is why: an aggregate with a monoid identity folds an
// empty group to that identity (`sum` to 0, `concat` to "", `list` to `[]`), and
// one without an identity (`avg`, `min`, `max`) is undefined there, so the row is
// withheld instead of emitted with a NULL in it. Nulls among the inputs are
// skipped by the fold. This is why the grouping analysis no longer bears on
// nullness at all: `isGroupingArg` decides whether the empty-group row exists,
// not what is in it. Its own tests live with the translator and the interpreters.
describe("aggregates", () => {
  test("count is never null, even over a nullable column", () => {
    const source = `
      input predicate p(a: integer?).
      q(count(X)) :- p(X).
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("nor is an ungrouped sum, which folds an empty group to 0", () => {
    const source = `
      input predicate p(a: integer).
      q(sum(X)) :- p(X).
    `;
    expect(cols(source, "q")).toEqual([false]);
  });

  test("nor is one over a guarded nullable column, grouped or not", () => {
    // `sum` needs a value, so a `T?` argument is rejected (§5) and the guard is
    // how the rule gets written. Which means the value aggregates never meet a
    // null at all; only `count` and `list` can, and neither returns one.
    const grouped = `
      input predicate p(g: string, a: integer?).
      q(G, sum(X)) :- p(G, X), X <> null.
    `;
    const ungrouped = `
      input predicate p(g: string, a: integer?).
      q(sum(X)) :- p(_, X), X <> null.
    `;
    expect(cols(grouped, "q")).toEqual([false, false]);
    expect(cols(ungrouped, "q")).toEqual([false]);
  });

  test("a value aggregate rejects a nullable argument rather than skipping nulls", () => {
    const source = `
      input predicate p(a: integer?).
      lo(min(X)) :- p(X).
    `;
    expect(() => cols(source, "lo")).toThrow(/can be null, and `min` needs a value/);
  });

  test("count and list take one, and still return no null", () => {
    // The two aggregates a null can reach: `count` counts it (§11.2) and `list`
    // collects it (§7). Both answer with something that is not a null.
    const source = `
      input predicate p(a: integer?).
      n(count(X)) :- p(X).
      l(list(X)) :- p(X).
    `;
    expect(cols(source, "n")).toEqual([false]);
    expect(cols(source, "l")).toEqual([false]);
  });
});

describe("recursion", () => {
  test("a non-null base case gives a non-null recursive column", () => {
    const source = `
      input predicate edge(a: integer, b: integer).
      path(X, Y) :- edge(X, Y).
      path(X, Z) :- path(X, Y), edge(Y, Z).
    `;
    expect(cols(source, "path")).toEqual([false, false]);
  });

  test("a nullable base case widens the whole fixed point", () => {
    const source = `
      input predicate edge(a: integer?, b: integer?).
      path(X, Y) :- edge(X, Y).
      path(X, Z) :- path(X, Y), edge(Y, Z).
    `;
    expect(cols(source, "path")).toEqual([true, true]);
  });

  test("nullness introduced only in the recursive step still reaches the column", () => {
    const source = `
      input predicate edge(a: integer, b: integer).
      input predicate weight(w: integer?).
      path(X, Y) :- edge(X, Y).
      path(X, Z) :- path(X, Y), edge(Y, _), weight(Z).
    `;
    expect(cols(source, "path")).toEqual([false, true]);
  });

  test("a partial operation in the recursive step introduces none", () => {
    const source = `
      input predicate edge(a: integer, b: integer).
      path(X, Y) :- edge(X, Y).
      path(X, Z) :- path(X, Y), edge(Y, W), Z = W / 2.
    `;
    expect(cols(source, "path")).toEqual([false, false]);
  });
});
