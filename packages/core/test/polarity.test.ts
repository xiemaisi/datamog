// Parity-stratified recursion: the `^` sigil, the polarity check that replaces
// the old "no negation inside an SCC" rule, and the inert-sigil warning.
// See doc/design/parity-stratification.md and spec §4.3.

import { describe, expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze, findInertPolarity } from "../src/index.ts";

const EDBS = `
  input predicate literal(e: string).
  input predicate composite(e: string).
  input predicate child(parent: string, kid: string).
`;

describe("polarity check", () => {
  test("accepts recursion through two negations", () => {
    const result = analyze(
      parse(`${EDBS}
        constant(E) :- literal(E).
        constant(E) :- composite(E), not bad^(E).
        bad^(E) :- child(E, C), not constant(C).
      `),
    );
    expect(result.maximalPredicates).toEqual(new Set(["bad"]));
    // One SCC holding both predicates: this is the parity cycle.
    expect(result.sortedStrata.some((s) => s.length === 2 && s.includes("bad"))).toBe(true);
  });

  test("rejects a negated call between two minimal predicates", () => {
    const program = parse(`${EDBS}
      constant(E) :- composite(E), not bad(E).
      bad(E) :- child(E, C), not constant(C).
    `);
    expect(() => analyze(program)).toThrow(/not stratifiable/);
    // The message points at the fix.
    expect(() => analyze(program)).toThrow(/mark exactly one of them maximal/);
  });

  test("rejects a negated call between two maximal predicates", () => {
    const program = parse(`${EDBS}
      constant^(E) :- composite(E), not bad^(E).
      bad^(E) :- child(E, C), not constant^(C).
    `);
    expect(() => analyze(program)).toThrow(/not stratifiable/);
  });

  test("rejects a positive call across polarities", () => {
    const program = parse(`${EDBS}
      win(P) :- child(P, Q), lose^(Q).
      lose^(Q) :- composite(Q), not win(Q).
    `);
    expect(() => analyze(program)).toThrow(/opposite polarity.*must be negated/);
  });

  test("rejects self-negation whichever polarity it carries", () => {
    for (const src of [
      `${EDBS} foo(X) :- literal(X), not foo(X).`,
      `${EDBS} foo^(X) :- literal(X), not foo^(X).`,
    ]) {
      expect(() => analyze(parse(src))).toThrow(/not stratifiable/);
    }
  });

  test("leaves negation across strata alone", () => {
    const result = analyze(
      parse(`${EDBS}
        reachable(X) :- child("root", X).
        reachable(X) :- child(Y, X), reachable(Y).
        frontier(X) :- literal(X), not reachable(X).
      `),
    );
    expect(result.maximalPredicates.size).toBe(0);
  });
});

describe("sigil spelling", () => {
  test("rejects a call that omits the sigil", () => {
    const program = parse(`${EDBS}
      constant(E) :- composite(E), not bad(E).
      bad^(E) :- child(E, C), not constant(C).
    `);
    expect(() => analyze(program)).toThrow(/'bad' is a maximal predicate; write 'bad\^' here/);
  });

  test("rejects a call that adds a sigil the definition does not have", () => {
    const program = parse(`${EDBS}
      constant(E) :- composite(E), not bad^(E).
      bad(E) :- child(E, C), not constant(C).
    `);
    expect(() => analyze(program)).toThrow(/'bad' is not a maximal predicate/);
  });

  test("rejects rules for one predicate that disagree", () => {
    const program = parse(`${EDBS}
      bad^(E) :- literal(E).
      bad(E) :- composite(E).
    `);
    expect(() => analyze(program)).toThrow(/'bad' is a maximal predicate/);
  });

  test("accepts a maximal input predicate and consistently sigilled calls", () => {
    const result = analyze(
      parse(`
        input predicate supplied^(x: string).
        copied^(X) :- supplied^(X).
        ?- copied^(X).
      `),
    );
    expect(result.maximalPredicates).toEqual(new Set(["supplied", "copied"]));
  });

  test("rejects a sigil on a minimal extensional predicate", () => {
    const program = parse(`${EDBS}
      p(X) :- not literal^(X), composite(X).
    `);
    expect(() => analyze(program)).toThrow(/'literal' is not a maximal predicate/);
  });

  test("rejects a sigil in a query", () => {
    const program = parse(`${EDBS}
      p(X) :- literal(X).
      ?- p^(X).
    `);
    expect(() => analyze(program)).toThrow(/'p' is not a maximal predicate/);
  });

  test("labels a maximal output with its sigil", () => {
    const result = analyze(
      parse(`${EDBS}
        output predicate bad^(E) :- child(E, C), not constant(C).
        constant(E) :- literal(E), not bad^(E).
      `),
    );
    expect(result.queries.map((q) => q.outputName)).toEqual(["bad^"]);
  });

  test("rejects a maximal error predicate", () => {
    const program = parse(`${EDBS}
      error predicate bad^(E) :- literal(E).
    `);
    expect(() => analyze(program)).toThrow(/integrity constraint cannot be maximal/);
  });
});

describe("findInertPolarity", () => {
  test("says nothing about a real parity cycle", () => {
    const result = analyze(
      parse(`${EDBS}
        constant(E) :- literal(E).
        constant(E) :- composite(E), not bad^(E).
        bad^(E) :- child(E, C), not constant(C).
      `),
    );
    expect(findInertPolarity(result)).toEqual([]);
  });

  test("warns about a sigil outside any recursive cycle", () => {
    const result = analyze(
      parse(`${EDBS}
        sink^(X) :- literal(X), not composite(X).
      `),
    );
    const diags = findInertPolarity(result);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.predicate).toBe("sink");
    expect(diags[0]!.code).toBe("inert-maximal");
    expect(diags[0]!.message).toMatch(/not part of a recursive cycle/);
    expect(diags[0]!.offset).toBeGreaterThan(0);
  });

  test("warns about a cycle whose every member is maximal", () => {
    const result = analyze(
      parse(`${EDBS}
        tc^(X, Y) :- child(X, Y).
        tc^(X, Z) :- child(X, Y), tc^(Y, Z).
      `),
    );
    const diags = findInertPolarity(result);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toMatch(/every predicate in its recursive cycle is maximal/);
  });
});
