// Equivalences the spec states, checked as properties rather than as outputs.
//
// Every defect the four audits found was the same shape: two things that must
// agree, don't. Coverage does not catch that — `obligations.ts` was at 100% of
// functions and lines while discharging contracts the run rejects — because the
// tests knew what the code *did*, not what it *should*. These tests know only that
// two programs must produce the same answer, so they need no expected output and
// cannot be satisfied by pinning current behaviour.
//
// Each case runs both programs on three engines: the naive interpreter, the
// seminaive one, and the SQLite translator. That checks two things at once, which
// is why the assertion is worth its cost:
//
//   - the equivalence holds, on every engine;
//   - the engines agree with each other, on both programs.
//
// A divergence in either direction is a bug in one of them. sql.js and Postgres go
// through the same translator and are covered per example by `examples.test.ts`.

import { describe, expect, test } from "bun:test";
import { create as createNative } from "datamog-backend-native";
import { create as createSeminaive } from "datamog-backend-seminaive";
import { create as createSqlite } from "datamog-backend-sqlite";
import { analyze, inferTypes } from "datamog-core";
import { type Backend, DatamogExecutor } from "datamog-engine";
import { parse } from "datamog-parser";

const ENGINES: [name: string, make: () => Promise<Backend>][] = [
  ["native", createNative],
  ["seminaive", createSeminaive],
  ["sqlite", createSqlite],
];

/** Canonical text for a row set, so a comparison is order-insensitive: results
 *  are sets and no backend promises an order. */
function canon(rows: Record<string, unknown>[]): string {
  return JSON.stringify(
    rows
      .map((r) =>
        Object.keys(r)
          .sort()
          .map((k) => [k, r[k]]),
      )
      .map((pairs) => JSON.stringify(pairs))
      .sort(),
  );
}

async function resultsOn(source: string, make: () => Promise<Backend>): Promise<string[]> {
  const backend = await make();
  try {
    const results = await new DatamogExecutor(backend).execute(source);
    return results.map((r) => canon(r.rows));
  } finally {
    await backend.close();
  }
}

/**
 * Assert two programs answer identically, on every engine. Also asserts the
 * engines agree, which is where a translator bug shows up rather than an
 * equivalence bug.
 */
async function equivalent(left: string, right: string): Promise<void> {
  const seen: string[] = [];
  for (const [name, make] of ENGINES) {
    const a = await resultsOn(left, make);
    const b = await resultsOn(right, make);
    expect(a, `${name}: the two programs disagree`).toEqual(b);
    seen.push(a.join("|"));
  }
  // Every engine saw the same answer for the left program.
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i], `${ENGINES[i]![0]} disagrees with ${ENGINES[0]![0]}`).toEqual(seen[0]!);
  }
}

/**
 * Whether a program is accepted *statically*, and the message when it is not.
 *
 * Runs the analysis rather than the program on purpose. Executing conflates two
 * different answers: a body the analyzer accepts can still crash an interpreter at
 * runtime, and an early version of this helper reported that crash as a rejection,
 * so a case it was written to catch passed for the wrong reason.
 */
function acceptance(source: string): "ok" | string {
  try {
    inferTypes(analyze(parse(source)));
    return "ok";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const NULLABLE = `
  p(1, null).
  p(2, 7).
  p(3, null).
  q(null).
  q(7).
  q(9).
`;

/** Two relations sharing a null, for the join cases. */
const JOINABLE = "q(null).\nq(7).\ns(null).\ns(7).\n";

describe("atom matching is the one equality", () => {
  // spec §1: an atom holds when every argument is defined and the tuple is in the
  // relation, using the same null-aware equality as an explicit `=`. So a repeated
  // variable across two atoms means exactly the spelled-out join, null-to-null
  // included.
  test("a repeated variable equals a spelled-out equality", async () => {
    await equivalent(
      `${NULLABLE}\noutput predicate r(X) :- q(X), s(X).\ns(null).\ns(7).`,
      `${NULLABLE}\noutput predicate r(X) :- q(X), s(Y), X = Y.\ns(null).\ns(7).`,
    );
  });

  // The shape a wrong strictness bit takes. A guard's *presence* must not change
  // which tuples join, and here it did: `to_json` was registered strict, so a
  // non-null result was read as proving the argument non-null, which lowered the
  // join to a plain `=` and dropped the null-to-null match on every SQL backend
  // while the interpreters kept it. Two guards selecting the same rows must
  // therefore select the same rows, and every engine must agree.
  test("a value-parameter guard does not change which tuples join", async () => {
    await equivalent(
      `${JOINABLE}output predicate r(X) :- q(X), s(X), to_json(X) = "null".`,
      `${JOINABLE}output predicate r(X) :- q(X), s(X), X = null.`,
    );
  });

  test("and the same for has_key", async () => {
    await equivalent(
      `${JOINABLE}output predicate r(X) :- q(X), s(X), has_key(X, "k") = false, X = null.`,
      `${JOINABLE}output predicate r(X) :- q(X), s(X), X = null.`,
    );
  });

  test("the same holds through a value column", async () => {
    await equivalent(
      `d(parse_json("null")).\nd(parse_json("7")).\ne(parse_json("null")).
       output predicate r(J) :- d(J), e(J).`,
      `d(parse_json("null")).\nd(parse_json("7")).\ne(parse_json("null")).
       output predicate r(J) :- d(J), e(K), J = K.`,
    );
  });
});

describe("count", () => {
  // spec §2.7: `count(e)` counts every row where `e` has a value, a null included,
  // and a variable always has one. So `count(X)` is `count(*)` for any variable,
  // which the spec calls out as making the shorter spelling always the better one.
  test("count of a variable equals count of star, nulls included", async () => {
    await equivalent(
      `${NULLABLE}\noutput predicate r(count(X)) :- q(X).`,
      `${NULLABLE}\noutput predicate r(count(*)) :- q(X).`,
    );
  });

  test("and inside a group", async () => {
    await equivalent(
      `${NULLABLE}\noutput predicate r(A, count(B)) :- p(A, B).`,
      `${NULLABLE}\noutput predicate r(A, count(*)) :- p(A, B).`,
    );
  });
});

describe("the null guard, both spellings", () => {
  // spec §4.2: `X <> null` and `not (X = null)` are interchangeable, the divergence
  // between `<>` and `not (=)` needing a compound partial operand rather than a
  // variable. Both must also narrow the variable identically, which the second case
  // checks by doing arithmetic that a nullable operand would reject.
  test("inequality against null equals a negated equality", async () => {
    await equivalent(
      `${NULLABLE}\noutput predicate r(X) :- q(X), X <> null.`,
      `${NULLABLE}\noutput predicate r(X) :- q(X), not (X = null).`,
    );
  });

  test("both narrow, so arithmetic is accepted after either", async () => {
    await equivalent(
      `${NULLABLE}\noutput predicate r(Y) :- q(X), X <> null, Y = X + 1.`,
      `${NULLABLE}\noutput predicate r(Y) :- q(X), not (X = null), Y = X + 1.`,
    );
  });

  test("the guard is symmetric", async () => {
    await equivalent(
      `${NULLABLE}\noutput predicate r(X) :- q(X), null <> X.`,
      `${NULLABLE}\noutput predicate r(X) :- q(X), X <> null.`,
    );
  });
});

describe("definedness has two spellings", () => {
  // spec §4.3 and §11.6: `not (e = e)` holds exactly where `e` has no value, and
  // `not defined(e)` is the readable spelling of the same test.
  const DIVISORS = "s(0).\ns(1).\ns(2).\n";

  test("a negated defined equals a negated self-equality", async () => {
    await equivalent(
      `${DIVISORS}output predicate r(V) :- s(V), not defined(10 / V).`,
      `${DIVISORS}output predicate r(V) :- s(V), not (10 / V = 10 / V).`,
    );
  });

  test("and the positive direction agrees too", async () => {
    await equivalent(
      `${DIVISORS}output predicate r(V) :- s(V), defined(10 / V).`,
      `${DIVISORS}output predicate r(V) :- s(V), 10 / V = 10 / V.`,
    );
  });
});

describe("inequality is a negated equality where no operand is partial", () => {
  // spec §4.2 prices the divergence as needing an operand that can have no value.
  // The contrapositive is a property: wherever both operands are total, the two
  // spellings must agree, `null` included.
  test("over variables, including nulls", async () => {
    await equivalent(
      `${NULLABLE}\noutput predicate r(X, Y) :- q(X), q(Y), X <> Y.`,
      `${NULLABLE}\noutput predicate r(X, Y) :- q(X), q(Y), not (X = Y).`,
    );
  });

  test("and they diverge exactly where an operand is partial", async () => {
    // The one case the spec says must differ. Asserted rather than left implicit,
    // so a change that accidentally made them agree would be caught too.
    const [ne, notEq] = await Promise.all([
      resultsOn("s(0).\ns(1).\noutput predicate r(V) :- s(V), V <> 10 / V.", createNative),
      resultsOn("s(0).\ns(1).\noutput predicate r(V) :- s(V), not (V = 10 / V).", createNative),
    ]);
    expect(ne).not.toEqual(notEq);
  });
});

describe("a body means the same in a query and a constraint", () => {
  // The analyzer keeps constraints out of `queries` so positional result alignment
  // holds, and that had the side effect of exempting them from every type check:
  // `!- q(A), s(B), A > B.` was accepted where the identical body written `?-` is a
  // static error. Acceptance is the property, so it cannot regress silently again.
  const bodies: [name: string, decls: string, body: string][] = [
    ["comparing integer to string", 'q(1).\ns("x").', "q(A), s(B), A > B"],
    ["a non-boolean filter", "q(1).", "q(A), A"],
    ["an unbound variable", "q(1).", "q(A), not s(B)"],
    ["a well-typed body", "q(1).\ns(2).", "q(A), s(B), A < B"],
  ];

  for (const [name, decls, body] of bodies) {
    test(name, () => {
      const asQuery = acceptance(`${decls}\n?- ${body}.`);
      const asConstraint = acceptance(`${decls}\n!- ${body}.`);
      // Compare acceptance, not the message: a constraint reports its own span.
      expect(asConstraint === "ok", `?- says ${asQuery}, !- says ${asConstraint}`).toBe(
        asQuery === "ok",
      );
    });
  }
});

describe("a rule and its inlined body agree", () => {
  // Not a spec sentence but a consequence of one: a non-recursive predicate is the
  // union of its rules, so naming a body and inlining it must answer the same.
  // Exercises the definedness guards on both sides of the rule boundary.
  test("through a partial expression", async () => {
    await equivalent(
      "s(0).\ns(1).\ns(2).\nq(V, 10 / V) :- s(V).\noutput predicate r(V, W) :- q(V, W).",
      "s(0).\ns(1).\ns(2).\noutput predicate r(V, W) :- s(V), W = 10 / V.",
    );
  });

  test("through a nullable column", async () => {
    await equivalent(
      `${NULLABLE}\nmid(A, B) :- p(A, B).\noutput predicate r(A, B) :- mid(A, B), B <> null.`,
      `${NULLABLE}\noutput predicate r(A, B) :- p(A, B), B <> null.`,
    );
  });
});

describe("a proof term is a value, so the value rules apply to it", () => {
  // Proof terms lower onto the implicit `value` proof column, which is §9.2's one row
  // where the static type does not decide what a NULL means. So the ADT feature
  // inherits every question this branch changed, and nothing had made it the subject.
  // These are the answers, checked across engines.
  const PAIR = "num(1). num(2).\npair() :: Two :- num(A), num(B), A < B.\n";
  const BOXED = "f(null).\nf(7).\nbox() :: Wrap :- f(X).\n";

  test("a null existential witness survives as the null value", async () => {
    // Reaching the arg through the accessor and comparing it to `null` must agree
    // with asking `type_of`, on every engine.
    await equivalent(
      `${BOXED}output predicate r(P) :- P : box, P["args"][0] = null.`,
      `${BOXED}output predicate r(P) :- P : box, type_of(P["args"][0]) = "null".`,
    );
  });

  test("an accessor past the end withholds its row", async () => {
    await equivalent(
      `${PAIR}output predicate r(P) :- P : pair, not defined(P["args"][9]).`,
      `${PAIR}output predicate r(P) :- P : pair.`,
    );
  });

  test("a missing key withholds its row", async () => {
    await equivalent(
      `${PAIR}output predicate r(V) :- P : pair, V = P["nope"].`,
      `${PAIR}output predicate r(V) :- P : pair, V = P["args"][9].`,
    );
  });

  test("count over proofs equals count of star", async () => {
    await equivalent(
      `${PAIR}output predicate r(count(P)) :- P : pair.`,
      `${PAIR}output predicate r(count(*)) :- P : pair.`,
    );
  });

  // Known open, and `test.failing` so a fix forces this entry's removal, matching how
  // the example suite records its Postgres gaps.
  //
  // A proof term must equal the canonical JSON it *is*: `jsonStringify` documents its
  // output as identical across every backend and safe as a dedup key. It is not, for a
  // `float`-typed argument. SQLite and sql.js spell an integral float `1.0` where
  // `canonicalizeJson`, the interpreters and Postgres give `1`, so the proof matches
  // its own written-down form on three engines and not on the other two. Integer and
  // string arguments agree; only `float` diverges.
  //
  // Same root cause as the open item in postgres-alignment.md, which has no SQL-level
  // fix: SQLite's printf cannot express shortest-round-trip, so closing it needs a
  // registered SQL function. Recorded here because this is where it stops being
  // cosmetic: it breaks matching in the ADT feature.
  const FLOATARG = "f(1.0).\nbox() :: Wrap :- f(X).\n";
  test.failing("a float-argument proof equals its canonical spelling", async () => {
    await equivalent(
      `${FLOATARG}output predicate r(P) :- P : box, P = parse_json("{\\"args\\":[1],\\"$proof\\":\\"box::Wrap\\"}").`,
      `${FLOATARG}output predicate r(P) :- P : box.`,
    );
  });
});

describe("the conditional expression", () => {
  // spec §2.6. `a if c else b` is strict in its condition, like `!`, the
  // connectives past their absorbing value, and the four orderings: a condition
  // that is a null or has no value leaves the whole conditional with no value.
  // Its branches are lazy, so only the taken one has to have one.
  const N = "n(-5).\nn(0).\nn(3).\n";

  test("it selects the branch the condition names", async () => {
    await equivalent(
      `${N}output predicate r(V, "neg" if V < 0 else "ok") :- n(V).`,
      `${N}output predicate r(V, "neg") :- n(V), V < 0.\noutput predicate r(V, "ok") :- n(V), not (V < 0).`,
    );
  });

  test("it is right-associative, so it chains", async () => {
    await equivalent(
      `${N}output predicate r(V, "neg" if V < 0 else ("zero" if V = 0 else "pos")) :- n(V).`,
      `${N}output predicate r(V, "neg") :- n(V), V < 0.\noutput predicate r(V, "zero") :- n(V), V = 0.\noutput predicate r(V, "pos") :- n(V), V > 0.`,
    );
  });

  test("the branch not taken need not have a value", async () => {
    // Lazy on every engine: SQL's `CASE` short-circuits and the interpreters
    // evaluate one branch, so `0 / 0` in the dead branch withholds nothing.
    await equivalent(
      `${N}output predicate r(V, 7 if V > 0 else 0 / 0) :- n(V).`,
      `${N}output predicate r(V, 7) :- n(V), V > 0.`,
    );
  });

  test("a condition with no value withholds the row", async () => {
    await equivalent(
      `${N}output predicate r(V) :- n(V), 1 = (1 if (V / 0) > 0 else 1).`,
      `${N}output predicate r(V) :- n(V), false.`,
    );
  });

  test("a null condition withholds the row, as an ordering would", async () => {
    // The condition is the one position a null may reach: the branches are
    // non-nullable (Position 3), so the *result* is never a null and a NULL from
    // a conditional is always an absence. That is what lets the two agree.
    const NB = "b(1, true).\nb(2, null).\n";
    await equivalent(
      `${NB}output predicate r(K, 7 if F else 8) :- b(K, F).`,
      `${NB}output predicate r(K, 7) :- b(K, F), F = true.\noutput predicate r(K, 8) :- b(K, F), F = false.`,
    );
  });

  test("a primitive branch lifts where the branches join to `value`", async () => {
    await equivalent(
      `${N}output predicate r(V, [1] if V > 0 else 2) :- n(V).`,
      `${N}output predicate r(V, [1]) :- n(V), V > 0.\noutput predicate r(V, parse_json("2")) :- n(V), not (V > 0).`,
    );
  });

  test("a nullable branch is rejected, a nullable condition is not", () => {
    // The asymmetry keeps a conditional's NULL single-valued: a branch could
    // supply the `null` value where the condition can only ever supply an
    // absence, and one SQL NULL cannot mean both.
    const P = "input predicate p(k: integer, v: integer?, f: boolean?).\n";
    expect(acceptance(`${P}?- p(K, V, F), X = V if K > 0 else 0.`)).toContain(
      "a conditional branch needs a value",
    );
    expect(acceptance(`${P}?- p(K, V, F), X = 1 if F else 0.`)).toBe("ok");
  });

  test("the condition must be a boolean and the branches must have a join", () => {
    expect(acceptance("?- X = 1 if 5 else 0.")).toContain(
      "Conditional requires a boolean condition, got 'integer'",
    );
    expect(acceptance('?- X = 1 if true else "a".')).toContain(
      "Conditional branches have incompatible types 'integer' and 'string'",
    );
  });
});
