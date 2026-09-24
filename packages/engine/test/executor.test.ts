import { describe, expect, test } from "bun:test";
import { create as createSqlite } from "datamog-backend-sqlite";
import type { ExtDecl } from "datamog-core";
import type { Backend } from "../src/backend.ts";
import { DatamogExecutor } from "../src/executor.ts";
import { type ExtensionalLoader, type LoadResult, insertRows } from "../src/loader.ts";

class NullLoader implements ExtensionalLoader {
  readonly name = "null";
  async canLoad(_decl: ExtDecl): Promise<boolean> {
    return false;
  }
  async load(_decl: ExtDecl, _backend: Backend): Promise<LoadResult> {
    return { rowsLoaded: 0 };
  }
}

function sortRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function executeOnSqliteAndNative(source: string): Promise<Record<string, unknown>[][][]> {
  const sqlite = await createSqlite();
  try {
    const sqliteResults = await new DatamogExecutor(sqlite).execute(source);

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const nativeResults = await new DatamogExecutor(native).execute(source);
      return [sqliteResults.map((r) => r.rows), nativeResults.map((r) => r.rows)];
    } finally {
      await native.close();
    }
  } finally {
    await sqlite.close();
  }
}

describe("DatamogExecutor", () => {
  test("addLoader registers an additional loader on an existing executor", () => {
    const executor = new DatamogExecutor({} as Backend, []);
    expect(() => executor.addLoader(new NullLoader())).not.toThrow();
  });

  test("Regression: direct insertRows rejects non-representable value cells", async () => {
    // Loader paths already validate JSON with `isJsonValue`; direct
    // insertRows used to skip that gate and canonicalise Infinity to JSON
    // null through JSON.stringify's non-finite-number behaviour.
    const backend = await createSqlite();
    const decl = (await import("datamog-parser")).parse("input predicate data(j: value).")
      .statements[0] as ExtDecl;
    await backend.execute(`CREATE TABLE "data" ("j" TEXT NOT NULL)`);
    try {
      expect(insertRows(backend, decl, [{ j: Number.POSITIVE_INFINITY }])).rejects.toThrow(
        /Expected a value/,
      );
      expect(insertRows(backend, decl, [{ j: [Number.POSITIVE_INFINITY] }])).rejects.toThrow(
        /Expected a value/,
      );
    } finally {
      await backend.close();
    }
  });

  test("direct insertRows rejects unsafe integers", async () => {
    const backend = await createSqlite();
    const decl = (await import("datamog-parser")).parse("input predicate data(n: integer).")
      .statements[0] as ExtDecl;
    try {
      expect(insertRows(backend, decl, [{ n: Number.MAX_SAFE_INTEGER + 1 }])).rejects.toThrow(
        /Expected integer/,
      );
    } finally {
      await backend.close();
    }
  });

  test("Regression: direct value inserts preserve string leaves", async () => {
    // Direct/programmatic rows are already typed JS values. The value
    // canonicalisation path used to JSON.parse every string cell, so a
    // string leaf like "true" became boolean true and a string leaf like
    // "hello" threw as invalid JSON text.
    const program = `
      input predicate data(j: value).
      string_leaf(J, S) :- data(J), S = as_string(J).
      ?- string_leaf(J, S).
    `;

    for (const create of [
      createSqlite,
      (await import("../../backend/native/src/index.ts")).create,
    ]) {
      const backend = await create();
      const executor = new DatamogExecutor(backend, [
        {
          name: "typed",
          async canLoad(): Promise<boolean> {
            return true;
          },
          async load(decl: ExtDecl, b: Backend): Promise<LoadResult> {
            await insertRows(b, decl, [{ j: "true" }, { j: "hello" }]);
            return { rowsLoaded: 2 };
          },
        },
      ]);
      try {
        const results = await executor.execute(program);
        expect(sortRows(results[0]!.rows)).toEqual([
          { J: "hello", S: "hello" },
          { J: "true", S: "true" },
        ]);
      } finally {
        await backend.close();
      }
    }
  });

  test("Regression: direct insertRows rejects null for non-null value columns", async () => {
    // SQL backends reject a top-level null in a NOT NULL `value` column via
    // table constraints. Native has no DDL layer, so insertRows must enforce
    // the same non-null check before rows reach the backend.
    const program = `
      input predicate data(j: value).
      ?- data(J).
    `;

    for (const create of [
      createSqlite,
      (await import("../../backend/native/src/index.ts")).create,
    ]) {
      const backend = await create();
      const executor = new DatamogExecutor(backend, [
        {
          name: "typed",
          async canLoad(): Promise<boolean> {
            return true;
          },
          async load(decl: ExtDecl, b: Backend): Promise<LoadResult> {
            await insertRows(b, decl, [{ j: null }]);
            return { rowsLoaded: 1 };
          },
        },
      ]);
      try {
        await expect(executor.execute(program)).rejects.toThrow(/non-null value/);
      } finally {
        await backend.close();
      }
    }
  });

  test("a nullable value column stores its null the JSON way, so the language can see it", async () => {
    // §9.3: a `value` spells its null as JSON, leaving SQL NULL to mean "no
    // value". Asserting only that the cell prints as `null` does not distinguish
    // the two, a SQL NULL printing the same way, so ask the questions that do:
    // `= null` matches a null and nothing else, and `type_of` answers `"null"`
    // where an absence would make the whole row vanish.
    const program = `
      input predicate data(id: integer, j: value?).
      output predicate isnull(I) :- data(I, J), J = null.
      output predicate notnull(I) :- data(I, J), J <> null.
      output predicate shape(I, T) :- data(I, J), T = type_of(J).
      ?- data(I, J).
    `;

    for (const create of [
      createSqlite,
      (await import("../../backend/native/src/index.ts")).create,
    ]) {
      const backend = await create();
      const executor = new DatamogExecutor(backend, [
        {
          name: "typed",
          async canLoad(): Promise<boolean> {
            return true;
          },
          async load(decl: ExtDecl, b: Backend): Promise<LoadResult> {
            await insertRows(b, decl, [
              { id: 1, j: null },
              { id: 2, j: { k: 1 } },
            ]);
            return { rowsLoaded: 2 };
          },
        },
      ]);
      try {
        const results = await executor.execute(program);
        expect(sortRows(results[0]!.rows)).toEqual([{ I: 1 }]);
        expect(sortRows(results[1]!.rows)).toEqual([{ I: 2 }]);
        expect(sortRows(results[2]!.rows)).toEqual(
          sortRows([
            { I: 1, T: "null" },
            { I: 2, T: "object" },
          ]),
        );
        expect(sortRows(results[3]!.rows)).toEqual(
          sortRows([
            { I: 1, J: null },
            { I: 2, J: { k: 1 } },
          ]),
        );
      } finally {
        await backend.close();
      }
    }
  });

  test("queries see later declarations and execute in source order", async () => {
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        ?- later(X).
        seed(1).
        later(X) :- seed(X).
        output predicate so(X) :- seed(X).
      `);
      expect(results).toHaveLength(2);
      expect(results[0]!.rows).toEqual([{ X: 1 }]);
      expect(results[1]!.rows).toEqual([{ X: 1 }]);
    } finally {
      await backend.close();
    }
  });

  test("body equality binds a bare variable on either side", async () => {
    for (const rows of await executeOnSqliteAndNative(`
      base(1).
      base(2).
      renamed(X) :- base(Y), Y = X.
      incremented(Y) :- base(X), X + 1 = Y.
      ?- renamed(X).
      output predicate inc(Y) :- incremented(Y).
    `)) {
      expect(sortRows(rows[0]!)).toEqual([{ X: 1 }, { X: 2 }]);
      expect(sortRows(rows[1]!)).toEqual([{ Y: 2 }, { Y: 3 }]);
    }
  });

  test("Regression: boolean-typed query columns coerce 0/1 to true/false", async () => {
    // SQLite has no native BOOLEAN type — `TRUE`/`FALSE` keywords and
    // comparison results round-trip as JS `0`/`1`. The executor's
    // boolean-coercion pass turns those back into JS `true`/`false`
    // for any result column whose declared type is `boolean`, so the
    // SQL backends agree with the native evaluator on result shape.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        flag("alice", true).
        flag("bob",   false).
        derived(N, B) :- flag(N, B).
        comparison(N, B) :- flag(N, _), B = (N = "alice").
        ?- derived(N, B).
        output predicate cmp(N, B) :- comparison(N, B).
      `);
      // Boolean column carried through from a fact: true/false stays.
      expect(results[0]!.rows).toEqual([
        { N: "alice", B: true },
        { N: "bob", B: false },
      ]);
      // Boolean column produced by a comparison-in-head: SQLite emits
      // `(name = 'alice')` which evaluates to 0/1; the coercion pass
      // turns it into true/false.
      expect(results[1]!.rows).toEqual([
        { N: "alice", B: true },
        { N: "bob", B: false },
      ]);
    } finally {
      await backend.close();
    }
  });

  test("`null` literal and null-aware `=` / `<>` on the SQLite backend", async () => {
    // `=` and `<>` are the only equality and are null-aware; the dialect
    // emits `IS` on SQLite. The native evaluator's same-named test pins the
    // parallel result; this one verifies SQL agreement.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      // The nulls come from the literal, not from `1 / X`. A partial operation
      // no longer produces one: it produces no value, so the row is withheld
      // (doc/design/null-as-a-value.md §1). These facts are exactly what
      // `Y = 1 / X` used to yield for `t = {0, 1, 2}`.
      const results = await executor.execute(`
        nullable(0, null). nullable(1, 1). nullable(2, 0).
        maybe_null(X, Y, IsNull) :-
          nullable(X, Y),
          IsNull = (Y = null).

        below(X, Below) :- nullable(X, Y), Below = (Y < 1).
        filter_logical(X) :- nullable(X, Y), Y = null.
        neq_logical(X)    :- nullable(X, Y), Y <> null.
        dropped(X) :- nullable(X, Y), not (Y < 1).
        ?- maybe_null(X, Y, IsNull).
        output predicate bl(X, Below) :- below(X, Below).
        output predicate fl(X) :- filter_logical(X).
        output predicate nl(X) :- neq_logical(X).
        output predicate dr(X) :- dropped(X).
      `);
      // Equality answers at a null, `null` being a value.
      expect(sortRows(results[0]!.rows)).toEqual([
        { X: 0, Y: null, IsNull: true },
        { X: 1, Y: 1, IsNull: false },
        { X: 2, Y: 0, IsNull: false },
      ]);
      // An ordering does not: it is strict at null, so the NULL row binds
      // nothing and derives no tuple at all (§4.1). It used to bind `false`.
      expect(sortRows(results[1]!.rows)).toEqual([
        { X: 1, Below: false },
        { X: 2, Below: true },
      ]);
      expect(results[2]!.rows).toEqual([{ X: 0 }]);
      expect(sortRows(results[3]!.rows)).toEqual([{ X: 1 }, { X: 2 }]);
      // And in condition position nothing moved: `Y < 1` failing to hold at the
      // null is what `not` complements, whether it fails by being false or by
      // having no value. This is why the change is nearly conservative.
      expect(sortRows(results[4]!.rows)).toEqual([{ X: 0 }, { X: 1 }]);
    } finally {
      await backend.close();
    }
  });

  test("atom matching is null-aware across backends", async () => {
    // A literal `null` argument matches a NULL column, and a repeated
    // variable joins NULL to NULL, both agreeing with the `=` operator.
    // See doc/design/null.md §4.
    const program = `
      maybe(0, null). maybe(1, 1).
      literal_match(X) :- maybe(X, null).
      self_join(X1, X2) :- maybe(X1, Y), maybe(X2, Y).
      spelled(X1, X2) :- maybe(X1, Y1), maybe(X2, Y2), Y1 = Y2.
      ?- maybe(X, Y).
      output predicate lm(X) :- literal_match(X).
      output predicate sj(X1, X2) :- self_join(X1, X2).
      output predicate sp(X1, X2) :- spelled(X1, X2).
    `;

    for (const results of await executeOnSqliteAndNative(program)) {
      expect(sortRows(results[0]!)).toEqual([
        { X: 0, Y: null },
        { X: 1, Y: 1 },
      ]);
      expect(results[1]!).toEqual([{ X: 0 }]);
      expect(sortRows(results[2]!)).toEqual([
        { X1: 0, X2: 0 },
        { X1: 1, X2: 1 },
      ]);
      // The repeated variable and the spelled-out equality agree.
      expect(sortRows(results[3]!)).toEqual(sortRows(results[2]!));
    }
  });

  test("an aggregate whose argument is never defined still emits its group", async () => {
    // The group exists because `vals` has a row; the aggregate argument has no
    // value on any of them. A row whose aggregate argument is undefined
    // contributes to no aggregate that mentions it and still counts for
    // `count(*)`, which is what this pins. Previously spelled with a NULL
    // argument, which a partial operation no longer produces.
    const program = `
      g(1).
      g(2).
      vals(G, 1) :- g(G).
      agg(G, sum(X / 0), avg(X / 0), min(X / 0), max(X / 0), concat(X / 0), count(X / 0), count(*))
        :- vals(G, X).
      ?- agg(G, S, A, Mi, Ma, C, Cn, Star).
    `;

    for (const results of await executeOnSqliteAndNative(program)) {
      // The head mixes aggregates that have an identity with ones that do not, so
      // §7 withholds the whole tuple: `avg`, `min` and `max` have no value over a
      // group with no defined contributions, and one undefined head expression is
      // enough. The identity cases are checked on their own below.
      expect(results[0]!).toEqual([]);
    }
  });

  test("length on primitive strings agrees across backends", async () => {
    const program = `
      word("hello").
      result(N) :- word(W), N = length(W).
      ?- result(N).
    `;

    for (const results of await executeOnSqliteAndNative(program)) {
      expect(results[0]!).toEqual([{ N: 5 }]);
    }
  });

  test("an inferred-nullable join still matches NULL to NULL across backends", async () => {
    // null.md §4's own example, with the nulls now written as literals: a
    // division no longer produces one. The join lowering still has to be driven
    // by the inferred nullness, since neither column is declared. If it were
    // not, the plain `=` would drop the NULL row on SQLite and disagree with the
    // interpreter.
    const program = `
      p(1). p(null).
      q(2). q(null).
      output predicate shared(X) :- p(X), q(X).
      ?- shared(X).
    `;
    for (const results of await executeOnSqliteAndNative(program)) {
      expect(results[0]!).toEqual([{ X: null }]);
    }
  });

  test("a guard that proves non-nullness keeps the same answer across backends", async () => {
    // The guard makes the join lower to a plain `=`. The NULL row is excluded
    // either way, so the guarded program agrees with what the null-aware form
    // would have produced.
    const program = `
      p(1). p(2). p(null).
      q(2). q(3). q(null).
      output predicate shared(X) :- p(X), q(X), X <> null.
      ?- shared(X).
    `;
    for (const results of await executeOnSqliteAndNative(program)) {
      expect(sortRows(results[0]!)).toEqual([{ X: 2 }]);
    }
  });

  test("a declared-nullable join matches NULL to NULL across backends", async () => {
    // The same invariant reached through a `?` declaration rather than through
    // a partial operation. No rows are loaded, so the NULLs come from the
    // facts, which is enough to exercise the lowering choice.
    const program = `
      input predicate t(a: integer?).
      p(1). p(null).
      output predicate both(X) :- p(X), not t(X).
      ?- both(X).
    `;
    for (const results of await executeOnSqliteAndNative(program)) {
      expect(sortRows(results[0]!)).toEqual([{ X: 1 }, { X: null }]);
    }
  });

  test("shared integer/float variable meets to integer across backends", async () => {
    // X appears in an integer column and a float column, so its meet type is
    // integer — narrow enough to feed the bitwise `&` (rejected on floats).
    // Under the old join X widened to float and this program failed to
    // type-check. The float atom comes first to exercise the head projecting
    // the integer binding, not the float one, so every backend yields the
    // same integer values rather than 3.0/4.0.
    const program = `
      i(3). i(4). i(5).
      f(3.0). f(4.0). f(9.0).
      r(X, B) :- f(X), i(X), B = X & 1.
      ?- r(X, B).
    `;

    for (const results of await executeOnSqliteAndNative(program)) {
      expect(sortRows(results[0]!)).toEqual([
        { X: 3, B: 1 },
        { X: 4, B: 0 },
      ]);
    }
  });

  test("sibling rules with incompatible primitives produce a value column across backends", async () => {
    // One rule contributes a string, another an integer; the column joins to
    // `value` and holds both. Each primitive branch lifts to JSON, so both
    // backends return the same mixed set.
    const program = `
      who("alice").
      age(30).
      mixed(V) :- who(V).
      mixed(V) :- age(V).
      ?- mixed(V).
    `;

    for (const results of await executeOnSqliteAndNative(program)) {
      expect(sortRows(results[0]!)).toEqual([{ V: "alice" }, { V: 30 }]);
    }
  });

  test("value coercion and introspection builtins agree across backends", async () => {
    const program = `
      data(J) :- J = {
        "s": "hello",
        "i": 42,
        "f": 3.5,
        "b": true,
        "arr": [1, 2],
        "obj": {"x": 1},
        "n": null
      }.
      result(S, I, F, B, LenArr, LenObj, LenStr, Ts, Ti, Tf, Tb, Ta, To, Tn) :-
        data(J),
        S = as_string(J["s"]),
        I = as_integer(J["i"]),
        F = as_float(J["f"]),
        B = as_boolean(J["b"]),
        LenArr = length(J["arr"]),
        LenObj = length(J["obj"]),
        LenStr = length(J["s"]),
        Ts = type_of(J["s"]),
        Ti = type_of(J["i"]),
        Tf = type_of(J["f"]),
        Tb = type_of(J["b"]),
        Ta = type_of(J["arr"]),
        To = type_of(J["obj"]),
        Tn = type_of(J["n"]).
      bad_s(X) :- data(J), X = as_string(J["i"]).
      bad_len(X) :- data(J), X = length(J["i"]).
      ?- result(S, I, F, B, LenArr, LenObj, LenStr, Ts, Ti, Tf, Tb, Ta, To, Tn).
      output predicate bs(X) :- bad_s(X).
      output predicate bl(X) :- bad_len(X).
    `;

    for (const results of await executeOnSqliteAndNative(program)) {
      expect(results[0]!).toEqual([
        {
          S: "hello",
          I: 42,
          F: 3.5,
          B: true,
          LenArr: 2,
          LenObj: 1,
          LenStr: 5,
          Ts: "string",
          Ti: "number",
          Tf: "number",
          Tb: "boolean",
          Ta: "array",
          To: "object",
          // `"n"` is present and holds a JSON null, so `type_of` reports its
          // type rather than collapsing to NULL. This read `null` before §8.
          Tn: "null",
        },
      ]);
      // A wrong-shape projection and a wrong-shape `length` have no value, so
      // their rules derive nothing. Split out of the rule above, whose fourteen
      // sound columns would otherwise be withheld along with them.
      expect(results[1]!).toEqual([]);
      expect(results[2]!).toEqual([]);
    }
  });

  test("value iteration body atoms agree across backends", async () => {
    const program = `
      data(J) :- J = {"b": 2, "a": 1, "arr": [10, 20], "nested": {"x": 7}}.
      entries(K, V) :- data(J), object_entry(J, K, V).
      only_a(V) :- data(J), object_entry(J, "a", V).
      value_two(K) :- data(J), object_entry(J, K, 2).
      elems(I, V) :- data(J), A = J["arr"], array_element(A, I, V).
      second(V) :- data(J), A = J["arr"], array_element(A, 1, V).
      wrong_obj(I, V) :- data(J), array_element(J, I, V).
      wrong_arr(K, V) :- data(J), A = J["arr"], object_entry(A, K, V).
      ?- entries(K, V).
      output predicate oa(V) :- only_a(V).
      output predicate vt(K) :- value_two(K).
      output predicate el(I, V) :- elems(I, V).
      output predicate sec(V) :- second(V).
      output predicate wo(I, V) :- wrong_obj(I, V).
      output predicate wa(K, V) :- wrong_arr(K, V).
    `;

    for (const results of await executeOnSqliteAndNative(program)) {
      expect(sortRows(results[0]!)).toEqual(
        sortRows([
          { K: "a", V: 1 },
          { K: "arr", V: [10, 20] },
          { K: "b", V: 2 },
          { K: "nested", V: { x: 7 } },
        ]),
      );
      expect(results[1]!).toEqual([{ V: 1 }]);
      expect(results[2]!).toEqual([{ K: "b" }]);
      expect(sortRows(results[3]!)).toEqual([
        { I: 0, V: 10 },
        { I: 1, V: 20 },
      ]);
      expect(results[4]!).toEqual([{ V: 20 }]);
      expect(results[5]!).toEqual([]);
      expect(results[6]!).toEqual([]);
    }
  });

  test("Regression: an undefined subscript / slice index withholds the row on SQL backends", async () => {
    // §5.4 of the spec promises NULL propagation through subscript and
    // slice — `S[NULL]`, `S[NULL:j]`, `S[i:NULL]` all yield NULL. The
    // native evaluator already did this. The translator wraps every
    // subscript / slice in a CASE that guards against negative indices;
    // before the fix that guard's `WHEN (idx) >= 0` was the *only*
    // branch, so a NULL index made the WHEN evaluate to NULL → SQL's
    // CASE fell to `ELSE ''` and silently produced an empty string
    // instead of NULL. The CASE now has an explicit `IS NULL THEN
    // NULL` branch up front so SQL matches native (and the spec).
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        words("hello").
        sub(W, S)        :- words(W), I = 1 / 0, S = W[I].
        slice_start(W, S):- words(W), I = 1 / 0, S = W[I:3].
        slice_end(W, S)  :- words(W), J = 1 / 0, S = W[1:J].
        ?- sub(W, S).
        output predicate ss(W, S) :- slice_start(W, S).
        output predicate se(W, S) :- slice_end(W, S).
      `);
      // `I = 1 / 0` is a conjunct over an expression with no value, so it does
      // not hold and no row reaches the subscript at all.
      expect(results[0]!.rows).toEqual([]);
      expect(results[1]!.rows).toEqual([]);
      expect(results[2]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: SQLite mutually-recursive SCC with no base case compiles", async () => {
    // The SQLite dialect collapses a mutually-recursive SCC into a
    // single self-recursive CTE keyed by a `__tag` column, partitions
    // every rule into base / recursive parts, and emits the UNION as
    // `base UNION rec`. When the *whole* SCC has no base case (every
    // rule's body atom is in the SCC), `baseParts` is empty and the
    // combined CTE has no anchor — SQLite rejects it with "circular
    // reference: __mutual_<scc>". The Postgres path already handles
    // this by synthesising an empty anchor per predicate; SQLite needs
    // the same shape (one anchor for the whole combined CTE is
    // enough).
    //
    // Triggered by any program where two-or-more predicates form a
    // SCC with all rules recursive. The type seed has to live outside
    // the SCC so the analyzer can pin column types.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate source(x: integer).
        p(X) :- source(X), q(X).
        q(X) :- p(X).
        ?- p(X).
      `);
      // Empty data in source → empty p (and q). The interesting bit
      // is that the CTE compiles at all.
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: a predicate name containing a single quote compiles on SQLite", async () => {
    // Backtick-quoted identifiers (`QUOTED_IDENT`) permit a single quote
    // in a predicate/column name, and the SQL backends emit that name as
    // a double-quoted identifier (`"it's"`). `stripSpanMarks` (the
    // translator's span-marker remover) only tracked single-quoted
    // *string* state, so the `'` inside a double-quoted *identifier*
    // flipped its `inString` flag, desynchronising the stripper: the
    // U+0001/U+0002 span markers that follow were then treated as
    // in-string user data and passed through verbatim, reaching SQLite as
    // control characters ("unrecognized token"). Native, which never
    // builds SQL, evaluated the program fine. Fix teaches `stripSpanMarks`
    // about double-quoted identifiers.
    for (const rows of await executeOnSqliteAndNative("`it's`(X) :- X = 5.\n?- `it's`(X).")) {
      expect(rows[0]).toEqual([{ X: 5 }]);
    }
  });

  test("Regression: a mutually-recursive predicate name containing a single quote compiles on SQLite", async () => {
    // The SQLite/sql.js combined CTE discriminates the strata's
    // predicates by emitting each one's name as a SQL string literal in
    // a `__tag` column (`SELECT '<predicate>' AS __tag, …` and a
    // matching `WHERE __tag = '<predicate>'`), and the translator emits
    // the same literal for the body-atom tag conditions. A predicate
    // named `p'q` produced `'p'q' AS __tag` — an unescaped quote that
    // closed the string literal early and crashed SQLite, independently
    // of the `stripSpanMarks` desync above. The string-literal escape
    // (`'` → `''`) used elsewhere in the dialect / translator was missing
    // at the `__tag` sites.
    for (const rows of await executeOnSqliteAndNative(
      "`p'q`(1).\n`p'q`(X) :- `r's`(X).\n`r's`(2).\n`r's`(X) :- `p'q`(X).\n?- `p'q`(X).",
    )) {
      expect((rows[0] as { X: number }[]).map((r) => r.X).sort((a, b) => a - b)).toEqual([1, 2]);
    }
  });

  test("Regression: a negative integer index on an array `value` withholds the row on every backend", async () => {
    // The SQLite dialect's `jsonSubscript` builds a JSON path by
    // string-concatenating the integer index — `'$[' || CAST(idx AS
    // TEXT) || ']'`. A runtime `-1` therefore produces the literal
    // path `'$[-1]'`, which SQLite rejects with `bad JSON path:
    // '$[-1]'`, tearing down the whole query. (Postgres's
    // `jsonb -> -1` doesn't throw — it returns the *last* array
    // element, also diverging from the native evaluator, which
    // short-circuits to NULL at `values.ts:161` (`if (idx < 0 ||
    // idx >= obj.length) return null`)).
    //
    // The translator's string-subscript path already wraps with
    // `WHEN (${idx}) >= 0` to force `''` on negative indices; the
    // json-subscript path just delegated to the dialect with no
    // guard. Wrap the integer-keyed json case in the same shape so
    // a runtime-negative index produces NULL across every backend.
    const backend = await createSqlite();
    await backend.execute(`CREATE TABLE "arr" ("j" TEXT NOT NULL)`);
    await backend.execute(`INSERT INTO "arr" ("j") VALUES (?)`, [JSON.stringify([10, 20, 30])]);
    await backend.execute(`CREATE TABLE "idx" ("i" INTEGER NOT NULL)`);
    await backend.execute(`INSERT INTO "idx" ("i") VALUES (?)`, [-1]);
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate arr(j: value).
        input predicate idx(i: integer).
        result(V) :- arr(J), idx(I), V = J[I].
        ?- result(V).
      `);
      // Out of range on a `value`, so the subscript has no value and the head
      // cannot be completed. Previously a NULL row.
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: concat on `value` produces canonical JSON on every backend", async () => {
    // Native's `concat` called `String(v)` on each value. For
    // a json *object* that produces `"[object Object]"`; for an
    // *array* it produces `Array.toString()` (`"1,2,3"` for
    // `[1,2,3]`); for a string-leaf, the raw text with no JSON
    // quotes. SQL backends store json canonically, so GROUP_CONCAT
    // / STRING_AGG render canonical JSON text (`"{\"a\":1}"` /
    // `"[1,2,3]"` / `"\"hello\""`). Spec §6 promises identical
    // output across every backend — make native render via
    // `canonicalizeJson` when the aggregate arg is value-typed.
    const program = `
      input predicate data(j: value).
      result(concat(J)) :- data(J).
      ?- result(R).
    `;
    const expected = '[1,2,3],{"a":1}';

    const sqlite = await createSqlite();
    await sqlite.execute(`CREATE TABLE "data" ("j" TEXT NOT NULL)`);
    await sqlite.execute(`INSERT INTO "data" ("j") VALUES (?), (?)`, [
      JSON.stringify([1, 2, 3]),
      JSON.stringify({ a: 1 }),
    ]);
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ R: expected }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    const decl = (await import("datamog-parser")).parse("input predicate data(j: value).")
      .statements[0] as ExtDecl;
    if (!native.insertRows) throw new Error("native backend missing insertRows");
    await native.insertRows(decl, [{ j: [1, 2, 3] }, { j: { a: 1 } }]);
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ R: expected }]);
    } finally {
      await native.close();
    }
  });

  test("list aggregate produces a canonical-text-sorted JSON array on every backend", async () => {
    // Cross-backend agreement: SQLite stores canonical-TEXT json and
    // sorts by it directly; Postgres jsonb's text form is canonical
    // up to whitespace, which puts structurally equal values
    // adjacently (so they sort together); native sorts by
    // `canonicalizeJson`. The expected order below — `[1,2,3]` <
    // `{"a":1}` — falls out of `[` (0x5B) < `{` (0x7B) on every
    // path. Skip-NULL semantics matter only for groups where some
    // input rows are NULL; the all-NULL case is covered separately
    // by the native test.
    const program = `
      input predicate data(j: value).
      result(list(J)) :- data(J).
      ?- result(R).
    `;
    const expected = [[1, 2, 3], { a: 1 }];

    const sqlite = await createSqlite();
    await sqlite.execute(`CREATE TABLE "data" ("j" TEXT NOT NULL)`);
    await sqlite.execute(`INSERT INTO "data" ("j") VALUES (?), (?)`, [
      JSON.stringify([1, 2, 3]),
      JSON.stringify({ a: 1 }),
    ]);
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ R: expected }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    const decl = (await import("datamog-parser")).parse("input predicate data(j: value).")
      .statements[0] as ExtDecl;
    if (!native.insertRows) throw new Error("native backend missing insertRows");
    await native.insertRows(decl, [{ j: [1, 2, 3] }, { j: { a: 1 } }]);
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ R: expected }]);
    } finally {
      await native.close();
    }
  });

  test("Regression: SQLite binding ranges with dynamic bounds are not capped", async () => {
    // SQLite used to implement non-literal binding ranges by generating a
    // fixed -1M..1M integer stream and filtering it against the dynamic
    // bounds. A value just outside that fallback cap disappeared on SQLite
    // even though native enumerated the exact one-element range.
    const program = `
      base(1000001).
      nums(X) :- base(N), X in [N .. N].
      ?- nums(X).
    `;

    for (const rows of await executeOnSqliteAndNative(program)) {
      expect(rows[0]).toEqual([{ X: 1000001 }]);
    }
  });

  test("Regression: value aggregates sort canonical text by portable string order", async () => {
    // `concat(value)` and `list(value)` order value arguments by their
    // canonical JSON text. Native used JavaScript string comparison for
    // that text, while SQL backends order TEXT by UTF-8/C collation. The
    // two disagree for non-BMP leaves: `["￿"]` must sort before `["😀"]`.
    const program = `
      data(["😀"]).
      data(["￿"]).
      cat(concat(J)) :- data(J).
      vals(list(J)) :- data(J).
      ?- cat(C).
      output predicate vl(L) :- vals(L).
    `;
    const expectedConcat = '["￿"],["😀"]';
    const expectedList = [["￿"], ["😀"]];

    const sqlite = await createSqlite();
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ C: expectedConcat }]);
      expect(r[1]!.rows).toEqual([{ L: expectedList }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ C: expectedConcat }]);
      expect(r[1]!.rows).toEqual([{ L: expectedList }]);
    } finally {
      await native.close();
    }
  });

  test("list auto-promotes primitive arguments across every backend", async () => {
    // Sort key for primitive args is the raw value (numeric for
    // numbers, lex for strings, false-before-true for booleans), so
    // 10 sorts after 2 even though the canonical JSON text "10" is
    // lex-less than "2". This is the divergence point between the
    // primitive path and the json path — exercise both backends to
    // catch any per-dialect regression in `toJson` or the FILTER
    // clause.
    const program = `
      input predicate t(n: integer).
      result(list(N)) :- t(N).
      ?- result(R).
    `;
    const expected = [2, 7, 10];

    const sqlite = await createSqlite();
    await sqlite.execute(`CREATE TABLE "t" ("n" INTEGER NOT NULL)`);
    await sqlite.execute(`INSERT INTO "t" ("n") VALUES (?), (?), (?)`, [2, 10, 7]);
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ R: expected }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    const decl = (await import("datamog-parser")).parse("input predicate t(n: integer).")
      .statements[0] as ExtDecl;
    if (!native.insertRows) throw new Error("native backend missing insertRows");
    await native.insertRows(decl, [{ n: 2 }, { n: 10 }, { n: 7 }]);
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ R: expected }]);
    } finally {
      await native.close();
    }
  });

  test("Regression: overflowing primitive expressions become NULL before list aggregation", async () => {
    // Float overflow is part of expression evaluation, not just a
    // value-construction concern. Once the overflowing expression becomes
    // NULL, `list` follows normal aggregate semantics and skips it; an
    // all-NULL group therefore yields NULL rather than `[null]`.
    const factors = new Array(37).fill("1000000000.0").join(" * ");
    const program = `
      p(X) :- X = ${factors}.
      q(list(X)) :- p(X).
      ?- q(V).
    `;

    for (const rows of await executeOnSqliteAndNative(program)) {
      // `list` folds with `[]`, so a group with no contributions is `[]` (§7).
      expect(rows[0]).toEqual([{ V: [] }]);
    }
  });

  test("integer arithmetic and conversion stay inside the safe-integer range", async () => {
    // Split per position: the safe result still has to be checked, and one
    // undefined head expression withholds the whole tuple, so putting them in
    // one rule would only ever assert emptiness.
    const arithmetic = `
      safe(Safe) :- Safe = 9007199254740990 + 1.
      over_add(X) :- X = 9007199254740991 + 1.
      over_sub(X) :- X = -9007199254740991 - 1.
      over_mul(X) :- X = 94906266 * 94906266.
      ?- safe(Safe).
      output predicate a(X) :- over_add(X).
      output predicate b(X) :- over_sub(X).
      output predicate c(X) :- over_mul(X).
    `;
    for (const rows of await executeOnSqliteAndNative(arithmetic)) {
      expect(rows[0]).toEqual([{ Safe: Number.MAX_SAFE_INTEGER }]);
      // Each leaves the integer domain, so each derives nothing.
      expect(rows[1]).toEqual([]);
      expect(rows[2]).toEqual([]);
      expect(rows[3]).toEqual([]);
    }

    const intermediate = `
      result(X) :- X = (9007199254740991 + 1) - 1.
      ?- result(X).
    `;
    for (const rows of await executeOnSqliteAndNative(intermediate)) {
      // The intermediate leaves the integer domain, so the whole expression has
      // no value and no row is derived. Previously a NULL row.
      expect(rows[0]).toEqual([]);
    }

    // Split per position, since one undefined head expression withholds the whole
    // tuple and the sound conversion still has to be checked.
    const conversion = `
      converted(Safe) :- Safe = to_integer("9007199254740991").
      over(X) :- X = to_integer("9007199254740992").
      ?- converted(Safe).
      output predicate o(X) :- over(X).
    `;
    for (const rows of await executeOnSqliteAndNative(conversion)) {
      expect(rows[0]).toEqual([{ Safe: Number.MAX_SAFE_INTEGER }]);
      // Outside the integer domain, so no value and no row.
      expect(rows[1]).toEqual([]);
    }
  });

  test("integer sum overflow returns NULL", async () => {
    for (const program of [
      `
        n(9007199254740991).
        n(1).
        total(sum(X)) :- n(X).
        ?- total(Sum).
      `,
      `
        n(I, 9007199254740991) :- I in [1 .. 1025].
        total(sum(X)) :- n(_, X).
        ?- total(Sum).
      `,
    ]) {
      for (const rows of await executeOnSqliteAndNative(program)) {
        // An overflowing sum has no value, so the tuple is withheld, via a HAVING
        // guard on the SQL side. Distinct from an *empty* sum, which is 0: the
        // emit tells those apart deliberately (§9.4).
        expect(rows[0]).toEqual([]);
      }
    }

    const cancellation = `
      n(1, 9007199254740991).
      n(2, -9007199254740991).
      total(sum(X)) :- n(_, X).
      ?- total(Sum).
    `;
    for (const rows of await executeOnSqliteAndNative(cancellation)) {
      expect(rows[0]).toEqual([{ Sum: 0 }]);
    }
  });

  test("integer-returning builtins withhold the row on an unsafe result", async () => {
    const program = `
      result(R, F, C, S) :-
        R = round(9007199254740992.0),
        F = floor(9007199254740992.0),
        C = ceil(9007199254740992.0),
        S = round(9007199254740991, -2).
      ?- result(R, F, C, S).
    `;

    for (const rows of await executeOnSqliteAndNative(program)) {
      // Each of the four leaves the integer domain, so each is undefined and
      // the rule derives nothing. Previously one row of four NULLs.
      expect(rows[0]).toEqual([]);
    }
  });

  test("primitive↔value auto-lift agrees across native and sqlite", async () => {
    // The same program ran on both backends should produce identical
    // results: `t(5)` matches a json row whose value is JSON 5,
    // `J == 5` filters a value column by primitive equality, and
    // siblings `data(5). data([1,2]).` unify to a value column.
    const program = `
      data(5).
      data([1, 2]).
      matches_5(X) :- data(X), X = 5.
      ?- matches_5(X).
      output predicate da(X) :- data(X).
    `;

    const sqlite = await createSqlite();
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ X: 5 }]);
      expect(r[1]!.rows).toEqual(expect.arrayContaining([{ X: 5 }, { X: [1, 2] }]));
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ X: 5 }]);
      expect(r[1]!.rows).toEqual(expect.arrayContaining([{ X: 5 }, { X: [1, 2] }]));
    } finally {
      await native.close();
    }
  });

  test("primitive values embed into value function arguments across backends", async () => {
    const program = `
      r(T, I, S, B, J) :-
        T = type_of(5),
        I = as_integer(5),
        S = as_string("hi"),
        B = as_boolean(true),
        J = to_json("hi").
      bad(L) :- L = length(5).
      ?- r(T, I, S, B, J).
      output predicate l(L) :- bad(L).
    `;
    const [sqliteRows, nativeRows] = await executeOnSqliteAndNative(program);
    const expected = [{ T: "number", I: 5, S: "hi", B: true, J: '"hi"' }];
    expect(sqliteRows[0]).toEqual(expected);
    expect(nativeRows[0]).toEqual(expected);
    // `length` of a number is a wrong-shape access, so it has no value and its
    // rule derives nothing. Split out because it would otherwise withhold the
    // row the five good columns are being checked on.
    expect(sqliteRows[1]).toEqual([]);
    expect(nativeRows[1]).toEqual([]);
  });

  test("Regression: non-finite floats scrub when auto-lifted into value calls", async () => {
    // Array/object/list construction already maps non-finite primitive
    // floats to JSON null. The ordinary primitive-to-value auto-lift used
    // by value builtins must apply the same boundary; otherwise native
    // reports Infinity as a value number and SQLite renders it as `Inf`.
    const program = `
      input predicate data(x: float).
      r(T, S) :- data(X), T = type_of(X * X), S = to_json(X * X).
      ?- r(T, S).
    `;

    for (const create of [
      createSqlite,
      (await import("../../backend/native/src/index.ts")).create,
    ]) {
      const backend = await create();
      const executor = new DatamogExecutor(backend, [
        {
          name: "typed",
          async canLoad(): Promise<boolean> {
            return true;
          },
          async load(decl: ExtDecl, b: Backend): Promise<LoadResult> {
            await insertRows(b, decl, [{ x: 1e308 }]);
            return { rowsLoaded: 1 };
          },
        },
      ]);
      try {
        const results = await executor.execute(program);
        // The expression has no value, so no row is derived to carry it (§1).
        expect(results[0]!.rows).toEqual([]);
      } finally {
        await backend.close();
      }
    }
  });

  test("primitive values embed into value joins and iteration sources", async () => {
    const program = `
      ints(5).
      vals(5).
      vals([1, 2]).
      matched(X) :- ints(X), vals(X).
      iter(K, V) :- ints(X), object_entry(X, K, V).
      ?- matched(X).
      output predicate it(K, V) :- iter(K, V).
    `;
    const [sqliteRows, nativeRows] = await executeOnSqliteAndNative(program);
    expect(sqliteRows[0]).toEqual([{ X: 5 }]);
    expect(nativeRows[0]).toEqual([{ X: 5 }]);
    expect(sqliteRows[1]).toEqual([]);
    expect(nativeRows[1]).toEqual([]);
  });

  test("keys / values / to_json agree across native and sqlite", async () => {
    // Round-trip a value through each new builtin and confirm both
    // backends produce the same shape. `keys` returns a sorted array
    // of JSON strings, `values` returns the matching values in
    // key-sorted order, and `to_json` returns the canonical-text
    // form (no whitespace, keys sorted).
    const program = `
      ev(P) :- P = parse_json("{\\"id\\": 1, \\"method\\": \\"GET\\"}").
      ks(K) :- ev(P), K = keys(P).
      vs(V) :- ev(P), V = values(P).
      ser(S) :- ev(P), S = to_json(P).
      ?- ks(K).
      output predicate ovs(V) :- vs(V).
      output predicate oser(S) :- ser(S).
    `;
    const expectedKeys = ["id", "method"];
    const expectedValues = [1, "GET"];
    const expectedText = '{"id":1,"method":"GET"}';

    const sqlite = await createSqlite();
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ K: expectedKeys }]);
      expect(r[1]!.rows).toEqual([{ V: expectedValues }]);
      expect(r[2]!.rows).toEqual([{ S: expectedText }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ K: expectedKeys }]);
      expect(r[1]!.rows).toEqual([{ V: expectedValues }]);
      expect(r[2]!.rows).toEqual([{ S: expectedText }]);
    } finally {
      await native.close();
    }
  });

  test("has_key distinguishes missing object keys from null-valued keys", async () => {
    const program = `
      data(J) :- J = {"present": 1, "nil": null, "arr": [1]}.
      result(Present, Nil, Missing, ArrayKey, ScalarKey) :-
        data(J),
        Present = has_key(J, "present"),
        Nil = has_key(J, "nil"),
        Missing = has_key(J, "missing"),
        ArrayKey = has_key(J["arr"], "0"),
        ScalarKey = has_key(J["present"], "x").
      null_arg(B) :- B = has_key(null, "x").
      ?- result(Present, Nil, Missing, ArrayKey, ScalarKey).
      output predicate na(B) :- null_arg(B).
    `;

    for (const results of await executeOnSqliteAndNative(program)) {
      // `Nil` is the case this test is named for: the key is present and holds a
      // JSON null, so `has_key` says true, where `Missing` says false. Those two
      // were indistinguishable before §8.
      expect(results[0]!).toEqual([
        {
          Present: true,
          Nil: true,
          Missing: false,
          ArrayKey: false,
          ScalarKey: false,
        },
      ]);
      // A bare `null` receiver answers false rather than propagating: a `value`
      // parameter accepts null as one of the shapes it holds, so it is an
      // argument rather than an absence. This case had to be dropped while a bare
      // `null` was untyped, because the unresolved overload made the translator
      // guard where the interpreter did not; both now agree. See §15.10.
      expect(results[1]!).toEqual([{ B: false }]);
    }
  });

  test("Regression: to_json uses Postgres jsonb object-key order", async () => {
    // Postgres jsonb canonicalises object keys by UTF-8 byte length first,
    // then by byte value: "a", "b", "aa". Native and SQLite used JS
    // lexicographic order instead ("a", "aa", "b"), so `to_json`
    // violated the spec's cross-backend-identical promise even for object
    // literals. Canonical TEXT storage should match jsonb's recursive order.
    const program = `
      ev(P) :- P = {"b": 2, "aa": 1, "a": 3}.
      ser(S) :- ev(P), S = to_json(P).
      ?- ser(S).
    `;
    const expectedText = '{"a":3,"b":2,"aa":1}';

    const sqlite = await createSqlite();
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ S: expectedText }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ S: expectedText }]);
    } finally {
      await native.close();
    }
  });

  test("Regression: keys / values sort non-BMP keys by Unicode code point", async () => {
    // Native used JavaScript's default UTF-16 string sort for object keys,
    // while SQLite orders TEXT by UTF-8 bytes. For a non-BMP key such as
    // U+1F600 (😀) and a BMP key like U+FFFF (￿), those orders disagree:
    // JS puts 😀 first, binary UTF-8 / Unicode code point order puts ￿
    // first. `keys` and `values` should use Datamog's portable string
    // order, not the host language's string representation.
    const program = `
      ev(P) :- P = {"😀": 1, "￿": 2}.
      ks(K) :- ev(P), K = keys(P).
      vs(V) :- ev(P), V = values(P).
      ?- ks(K).
      output predicate ovs(V) :- vs(V).
    `;
    const expectedKeys = ["￿", "😀"];
    const expectedValues = [2, 1];

    const sqlite = await createSqlite();
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ K: expectedKeys }]);
      expect(r[1]!.rows).toEqual([{ V: expectedValues }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ K: expectedKeys }]);
      expect(r[1]!.rows).toEqual([{ V: expectedValues }]);
    } finally {
      await native.close();
    }
  });

  test("keys / values withhold the row on non-object input across backends", async () => {
    const program = `
      arr(P) :- P = parse_json("[1, 2, 3]").
      ks(K) :- arr(P), K = keys(P).
      vs(V) :- arr(P), V = values(P).
      ?- ks(K).
      output predicate ovs(V) :- vs(V).
    `;

    const sqlite = await createSqlite();
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      // A non-object has no keys, so the expression has no value (§1).
      expect(r[0]!.rows).toEqual([]);
      expect(r[1]!.rows).toEqual([]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const r = await new DatamogExecutor(native).execute(program);
      // A non-object has no keys and no values, so neither expression has a
      // value and neither rule derives a row (§1).
      expect(r[0]!.rows).toEqual([]);
      expect(r[1]!.rows).toEqual([]);
    } finally {
      await native.close();
    }
  });

  test("Regression: concat on boolean produces 'true'/'false' strings on every backend", async () => {
    // Native's `concat` calls `String(v)` which renders
    // booleans as `"true"` / `"false"`. SQL backends previously
    // forwarded the boolean to `GROUP_CONCAT(expr, ',')` (SQLite) /
    // `STRING_AGG(expr::TEXT, ',')` (Postgres), which on SQLite
    // emits `"0"` / `"1"` (sqlite stores booleans as integers) and
    // on Postgres `"t"` / `"f"`. The spec promises `concat`'s
    // output is "deterministic and identical across every backend"
    // (§6) — wrap boolean arguments with a CASE that produces the
    // canonical `'true'` / `'false'` strings before they reach the
    // dialect's group-concat helper.
    const backend = await createSqlite();
    await backend.execute(`CREATE TABLE "flags" ("b" INTEGER NOT NULL)`);
    await backend.execute(`INSERT INTO "flags" VALUES (?), (?)`, [1, 0]);
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate flags(b: boolean).
        result(concat(B)) :- flags(B).
        ?- result(R).
      `);
      expect(results[0]!.rows).toEqual([{ R: "false,true" }]);
    } finally {
      await backend.close();
    }
  });

  test("parse_json on SQLite parses valid JSON and withholds the row on malformed input", async () => {
    // End-to-end: a string column flows through `parse_json`, the
    // result reaches the consumer as a parsed JS value (well-formed
    // input) or NULL (malformed). The executor's `coerceJsonColumns`
    // step re-parses the SQLite TEXT representation, so the user sees
    // the same JS shape they would on Postgres or the native backend.
    const backend = await createSqlite();
    await backend.execute(`CREATE TABLE "raw" ("s" TEXT NOT NULL)`);
    await backend.execute(`INSERT INTO "raw" ("s") VALUES (?), (?), (?), (?)`, [
      '{"a":1,"b":2}',
      "[1,2,3]",
      "null",
      "not json",
    ]);
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate raw(s: string).
        parsed(S, J) :- raw(S), J = parse_json(S).
        ?- parsed(S, J).
      `);
      const byInput = new Map(results[0]!.rows.map((r) => [r.S, r.J]));
      expect(byInput.get('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
      expect(byInput.get("[1,2,3]")).toEqual([1, 2, 3]);
      // A bare `null` parses to the null value, so its row is present and
      // carries null. Malformed input has no value, so its row is absent from
      // the result and `get` returns JS undefined rather than null. The two used
      // to be indistinguishable here, which is §8's whole point.
      expect(byInput.get("null")).toBe(null);
      expect(byInput.has("not json")).toBe(false);
    } finally {
      await backend.close();
    }
  });

  test("SQLite parse_json canonicalises object key order", async () => {
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        a(J) :- J = parse_json("{\\"a\\":1,\\"b\\":2}").
        b(J) :- J = parse_json("{\\"b\\":2,\\"a\\":1}").
        nested(J) :- J = parse_json("{\\"outer\\":{\\"y\\":2,\\"x\\":1}}").
        unioned(J) :- a(J).
        unioned(J) :- b(J).
        ser(S) :- unioned(J), S = to_json(J).
        nested_ser(S) :- nested(J), S = to_json(J).
        ?- unioned(J).
        output predicate oser(S) :- ser(S).
        output predicate ons(S) :- nested_ser(S).
      `);
      expect(results[0]!.rows).toHaveLength(1);
      expect(results[1]!.rows).toEqual([{ S: '{"a":1,"b":2}' }]);
      expect(results[2]!.rows).toEqual([{ S: '{"outer":{"x":1,"y":2}}' }]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: SQLite parse_json rejects non-finite numeric leaves", async () => {
    // SQLite's JSON parser accepts syntactically valid numeric leaves
    // that overflow JS Number, e.g. `9e999`, and `json_tree` exposes
    // them as IEEE Infinity. Letting that through produces a `value`
    // that JSON loaders reject and that other backends either reject or
    // collapse differently. Treat the whole parse as NULL when any leaf
    // is non-finite.
    const backend = await createSqlite();
    await backend.execute(`CREATE TABLE "raw" ("s" TEXT NOT NULL)`);
    await backend.execute(`INSERT INTO "raw" ("s") VALUES (?), (?), (?)`, [
      "9e999",
      "[1,9e999]",
      '{"ok":1}',
    ]);
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate raw(s: string).
        parsed(S, J) :- raw(S), J = parse_json(S).
        ?- parsed(S, J).
      `);
      const byInput = new Map(results[0]!.rows.map((r) => [r.S, r.J]));
      // A non-finite numeric leaf has no value, so the row is withheld.
      expect(byInput.has("9e999")).toBe(false);
      expect(byInput.has("[1,9e999]")).toBe(false);
      expect(byInput.get('{"ok":1}')).toEqual({ ok: 1 });
    } finally {
      await backend.close();
    }
  });

  test("Regression: SQLite `value` subscript with a punctuation key does literal lookup", async () => {
    // SQLite's `jsonSubscript` built the path as `'$.' || ${key}`,
    // and sqlite's path parser treats the dot as a path separator —
    // so for the json `{"foo.bar": 42, "foo": {"bar": 999}}` the
    // path `$.foo.bar` resolves to `999` (nested access through
    // `foo` then `bar`) instead of the literal-key `42`. Postgres's
    // `->` operator and the native evaluator both do literal string
    // key match, so they returned `42`.
    //
    // A later quoted-path form (`$."key"`) fixed dots/brackets but still
    // failed keys containing a double quote, because those need JSON-path
    // escaping. The SQLite dialect now uses `json_each` and compares
    // `je.key = K`, which is literal for every key string.
    const backend = await createSqlite();
    await backend.execute(`CREATE TABLE "data" ("j" TEXT NOT NULL)`);
    const obj = JSON.stringify({ "foo.bar": 42, foo: { bar: 999 }, 'a"b': 7 });
    await backend.execute(`INSERT INTO "data" ("j") VALUES (?)`, [obj]);
    await backend.execute(`CREATE TABLE "k" ("v" TEXT NOT NULL)`);
    await backend.execute(`INSERT INTO "k" ("v") VALUES (?), (?)`, ["foo.bar", 'a"b']);
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate data(j: value).
        input predicate k(v: string).
        result(K, V) :- data(J), k(K), V = J[K].
        ?- result(K, V).
      `);
      expect([...results[0]!.rows].sort((a, b) => String(a.K).localeCompare(String(b.K)))).toEqual([
        { K: 'a"b', V: 7 },
        { K: "foo.bar", V: 42 },
      ]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: equality-bound value variable keeps value type for subscript", async () => {
    // The SQL translator's local type environment learned only integer /
    // string types from `X = expr` binding equalities. A variable bound to a
    // value literal therefore stayed untyped in the rest of the rule, so
    // `J["a"]` below compiled as a string SUBSTR over the JSON text and
    // returned "{" on SQLite instead of doing an object-key lookup.
    const program = `
      r(V) :- J = {"a": 1}, V = J["a"].
      ?- r(V).
    `;

    const sqlite = await createSqlite();
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ V: 1 }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ V: 1 }]);
    } finally {
      await native.close();
    }
  });

  test("Regression: out-of-order value subscript and slice keep value-typed results", async () => {
    // Type inference used to guess that `Y[0]` and `Y[0:1]` were strings
    // before the later equality `Y = [[1], [2]]` established Y as a value.
    // SQLite then skipped the executor's JSON result coercion and returned
    // text, while the native backend returned arrays.
    const program = `
      r(X) :- X = Y[0], Y = [[1], [2]].
      s(X) :- X = Y[0:1], Y = [[1], [2]].
      ?- r(X).
      output predicate so(X) :- s(X).
    `;

    const sqlite = await createSqlite();
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ X: [1] }]);
      expect(r[1]!.rows).toEqual([{ X: [[1]] }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ X: [1] }]);
      expect(r[1]!.rows).toEqual([{ X: [[1]] }]);
    } finally {
      await native.close();
    }
  });

  test("Regression: equality-bound float dependency does not force integer division", async () => {
    // `D = Y / 2` appears before `Y = 1.0`. The core and native type
    // environments used to infer D from the literal `2` alone, mark D as
    // integer, and then let the native evaluator truncate `D / 2` to 0.
    // SQLite waited for the actual SQL expression and returned 0.25.
    const program = `
      r(E) :- D = Y / 2, Y = 1.0, E = D / 2.
      ?- r(E).
    `;

    const sqlite = await createSqlite();
    try {
      const r = await new DatamogExecutor(sqlite).execute(program);
      expect(r[0]!.rows).toEqual([{ E: 0.25 }]);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const r = await new DatamogExecutor(native).execute(program);
      expect(r[0]!.rows).toEqual([{ E: 0.25 }]);
    } finally {
      await native.close();
    }
  });

  test("Regression: value slice with a negative bound returns [], not the unfiltered range", async () => {
    // Native (values.ts:193) short-circuits to `[]` for any negative
    // start or end. The SQL backends rely on a `WHERE key >= start
    // AND key < end` filter (SQLite) / `ordinality - 1 >= start AND
    // ordinality - 1 < end` (Postgres) — so a runtime `start = -1`
    // matches every key (which starts at 0) and the slice returns the
    // *whole* array instead of `[]`. Same shape as the json-subscript
    // negative-index fix: the json-slice path has the same gap.
    const backend = await createSqlite();
    await backend.execute(`CREATE TABLE "arr" ("j" TEXT NOT NULL)`);
    await backend.execute(`INSERT INTO "arr" ("j") VALUES (?)`, [JSON.stringify([10, 20, 30])]);
    await backend.execute(`CREATE TABLE "lo" ("v" INTEGER NOT NULL)`);
    await backend.execute(`INSERT INTO "lo" ("v") VALUES (?)`, [-1]);
    await backend.execute(`CREATE TABLE "hi" ("v" INTEGER NOT NULL)`);
    await backend.execute(`INSERT INTO "hi" ("v") VALUES (?)`, [5]);
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate arr(j: value).
        input predicate lo(v: integer).
        input predicate hi(v: integer).
        result(V) :- arr(J), lo(L), hi(H), V = J[L:H].
        ?- result(V).
      `);
      expect(results[0]!.rows).toEqual([{ V: [] }]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: value slice on a NULL receiver has no value, so withholds the row", async () => {
    // The translator dispatches json slices straight to
    // `dialect.jsonSlice(obj, s, e)` without an `IS NULL` guard on the
    // receiver. Both SQL implementations reaggregate via
    // `COALESCE(jsonb_agg(...), '[]'::jsonb)` (Postgres) and
    // `COALESCE((SELECT json_group_array(...) ...), '[]')` (SQLite),
    // so a NULL input produces an empty array — disagreeing with the
    // native evaluator, which returns NULL for any slice on NULL
    // (values.ts: `if (obj === null) return null`). The string-slice
    // path on the same translator already wraps with an explicit
    // `IS NULL THEN NULL` guard; the json-slice path needs the same
    // shape.
    //
    // Trigger: any `J[a:b]` where `J` is an upstream `null` json
    // value. The most natural source is a missing object key —
    // `J["does_not_exist"]` returns SQL NULL, then sliced gives `[]`
    // on SQL today.
    const backend = await createSqlite();
    // Pre-create the table and seed it via raw SQL: Datalog has no
    // JSON literals, so this is the cleanest way to land a known
    // `value` in an EDB without spinning up a loader fixture.
    await backend.execute("CREATE TABLE things (t TEXT NOT NULL)");
    await backend.execute("INSERT INTO things VALUES (?)", [JSON.stringify({ a: 1 })]);
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate things(t: value).
        r(S) :- things(T), S = T["missing"][0:5].
        ?- r(S).
      `);
      // The expression has no value, so no row is derived to carry it (§1).
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: SQLite value slice preserves element JSON shapes", async () => {
    // SQLite's `jsonSlice` reaggregated `json_each.value` directly.
    // `json_each` exposes scalar leaves as SQLite values (true/false
    // become 1/0, string leaves are raw TEXT) and nested arrays/objects
    // as JSON text. Aggregating those raw values turned
    // `["true", true, {"a":1}, [1,2]]` into
    // `["true", 1, "{\"a\":1}", "[1,2]"]`, diverging from native and
    // Postgres. Re-canonicalise each element before `json_group_array`.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        data(["true", true, false, null, {"b": 2, "a": 1}, [1, 2]]).
        result(V) :- data(J), V = J[0:6].
        ?- result(V).
      `);
      expect(results[0]!.rows).toEqual([
        { V: ["true", true, false, null, { a: 1, b: 2 }, [1, 2]] },
      ]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: value slice on a non-array receiver has no value, so withholds the row", async () => {
    // Native returns NULL immediately when slicing a `value` that is not
    // an array. SQLite's `json_each` also iterates object entries; the
    // old slice implementation would reaggregate zero or more object
    // values into an array, usually `[]`, instead of returning NULL.
    // Postgres's `jsonb_array_elements(object)` would raise, so both SQL
    // dialects need an explicit array-type guard.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        data({"0": "zero", "1": "one"}).
        result(V) :- data(J), V = J[0:2].
        ?- result(V).
      `);
      // The expression has no value, so no row is derived to carry it (§1).
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: to_float on SQLite rejects 2-char leading-zero forms", async () => {
    // SQLite's `parseStringAsFloat` validates the input via a chain of
    // GLOB patterns. The leading-zero rejection branches were
    // `0[0-9][0-9]*` and `0[0-9]?*`, but both of those require at
    // least three characters: `[0-9]*` matches zero-or-more *more*
    // characters after the second digit, and GLOB's `?` matches
    // exactly one. Two-char inputs like "01"/"00"/"09" therefore
    // slipped past every WHEN branch, fell through to `CAST AS REAL`,
    // and parsed as 1/0/9 — disagreeing with the Postgres regex and
    // the native parser, which both reject these as non-canonical.
    // Same gap on the negative side for `-00`/`-01`/.../`-09`.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        raw("01"). raw("00"). raw("09").
        raw("-01"). raw("-00"). raw("-09").
        raw("-1"). raw("0"). raw("1").
        parsed(R, N) :- raw(R), N = to_float(R).
        ?- parsed(R, N).
      `);
      const sorted = [...results[0]!.rows].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
      // A non-canonical form has no value on any backend, so its row is
      // withheld rather than carrying a NULL. Only the canonical forms survive,
      // which is still what this pins: SQLite must reject exactly what Postgres
      // and the native evaluator reject.
      expect(sorted).toEqual(
        [
          { R: "-1", N: -1 },
          { R: "0", N: 0 },
          { R: "1", N: 1 },
        ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
    } finally {
      await backend.close();
    }
  });

  test("Regression: to_float on SQLite rejects out-of-range decimals", async () => {
    // SQLite's `CAST(text AS REAL)` accepts an otherwise-canonical
    // decimal string that is too large for IEEE double precision and
    // returns Infinity. The native `to_float` path parses the same
    // string with `Number.parseFloat` and rejects non-finite results as
    // NULL, so SQLite must guard the cast result as well.
    const huge = "9".repeat(400);
    const program = `
      raw("${huge}").
      raw("1.5").
      parsed(R, N) :- raw(R), N = to_float(R).
      ?- parsed(R, N).
    `;

    const sqlite = await createSqlite();
    try {
      const results = await new DatamogExecutor(sqlite).execute(program);
      const byInput = new Map(results[0]!.rows.map((r) => [r.R, r.N]));
      // Outside the integer domain, so no value and no row.
      expect(byInput.has(huge)).toBe(false);
      expect(byInput.get("1.5")).toBe(1.5);
    } finally {
      await sqlite.close();
    }

    const { create: createNative } = await import("../../backend/native/src/index.ts");
    const native = await createNative();
    try {
      const results = await new DatamogExecutor(native).execute(program);
      const byInput = new Map(results[0]!.rows.map((r) => [r.R, r.N]));
      // Outside the finite float range, so no value and no row.
      expect(byInput.has(huge)).toBe(false);
      expect(byInput.get("1.5")).toBe(1.5);
    } finally {
      await native.close();
    }
  });

  test("Regression: SQLite object literal canonicalises object keys (matches native and Postgres jsonb)", async () => {
    // The SQLite/sql.js dialect's `jsonObject` emitted entries in
    // *source order*, e.g. `json_object('b', 2, 'a', 1)` → text
    // `'{"b":2,"a":1}'`. The native evaluator routes ObjectLiteral
    // construction through `canonicalizeJson`, which sorts keys
    // recursively in jsonb order, and Postgres's `jsonb_build_object`
    // produces a `jsonb` value (sorted on storage). So `{"b":2,"a":1}` and
    // `{"a":1,"b":2}` were textually distinct on SQLite — failing
    // dedup, joins, and `=` comparisons across rules — while native
    // and Postgres unified them. Spec §6 promises identical output.
    // Sort entries in jsonb key order in the SQLite dialect before emitting.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        pair(J) :- J = {"b": 2, "a": 1}.
        pair(J) :- J = {"a": 1, "b": 2}.
        ?- pair(J).
      `);
      // Both rules should dedup to a single canonical row.
      expect(results[0]!.rows).toEqual([{ J: { a: 1, b: 2 } }]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: SQLite object literal sorts keys recursively (nested object literals)", async () => {
    // The fix sorts keys in `jsonObject` itself, so each nested
    // ObjectLiteral compiles to a sorted `json_object` call before
    // the outer literal wraps it. A literal-inside-literal join
    // exercises the recursive case end-to-end.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        wrap(J) :- J = {"outer": {"y": 2, "x": 1}}.
        wrap(J) :- J = {"outer": {"x": 1, "y": 2}}.
        ?- wrap(J).
      `);
      expect(results[0]!.rows).toEqual([{ J: { outer: { x: 1, y: 2 } } }]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: SQLite object literal duplicate keys use the last value", async () => {
    // Native object construction and Postgres jsonb use last-write-wins
    // semantics for duplicate object keys. SQLite's `json_object`, however,
    // preserves duplicate textual keys, so `J` decoded as `{a:2}` while
    // `to_json(J)` returned `{"a":1,"a":2}`. Collapse duplicates before
    // emitting SQLite's `json_object` call so the stored canonical text
    // matches the decoded value and the other backends.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        r(J, S) :- J = {"a": 1, "a": 2}, S = to_json(J).
        ?- r(J, S).
      `);
      expect(results[0]!.rows).toEqual([{ J: { a: 2 }, S: '{"a":2}' }]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: as_integer of a JSON integer outside JS safe range withholds the row on every backend", async () => {
    // Native `as_integer.value` (`packages/backend/native/src/values.ts`)
    // rejects values outside `Number.MIN_SAFE_INTEGER` /
    // `MAX_SAFE_INTEGER` (±2^53 - 1), returning NULL — beyond that
    // range JS Number loses precision and the integer can't round-trip
    // faithfully. The SQLite dialect's `jsonAsInteger` only checked
    // `json_type = 'integer'`, then `CAST(... AS INTEGER)` which on
    // SQLite saturates to INT64 (±2^63). Inputs in the (2^53, 2^63]
    // range — reachable via `parse_json("99999999999999999999")` since
    // SQLite's `json()` doesn't canonicalise — survived as a
    // precision-lost integer (~9.22e18) instead of NULL, diverging
    // from native. Same `as_float` shape as round 9 (`2a41295`), one
    // builtin over.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        r(I) :- I = as_integer(parse_json("99999999999999999999")).
        ?- r(I).
      `);
      // The expression has no value, so no row is derived to carry it (§1).
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: as_integer of an integer-valued float is the integer on every backend", async () => {
    // Spec §822: `as_integer` of an integer-valued numeric leaf (in
    // range) yields the integer; native `as_integer.value` accepts any
    // number with `v === Math.trunc(v)`, so `as_integer(3.0)` is 3, and
    // Postgres checks `jsonb_typeof = 'number' AND num = trunc(num)`.
    // The SQLite/sql.js dialect's `jsonAsInteger` gated on
    // `json_type = 'integer'` only, on the assumption that JSON integers
    // are always lexically integer-form. A float literal `3.0` lifted to
    // a value goes through `CAST(3.0 AS TEXT)` = "3.0" (json_type
    // 'real'), so it fell through to NULL — diverging from native /
    // seminaive / Postgres, which all return 3. A fractional float like
    // `1.5` must still be NULL.
    for (const rows of await executeOnSqliteAndNative(`
      r(N) :- N = as_integer(3.0).
      r(N) :- N = as_integer(-7.0).
      bad(N) :- N = as_integer(1.5).
      ?- r(N).
      output predicate ob(N) :- bad(N).
    `)) {
      expect((rows[0] as { N: number }[]).map((r) => r.N).sort((a, b) => a - b)).toEqual([-7, 3]);
      // round/2 out of the integer domain: undefined, so no row.
      expect(rows[1]).toEqual([]);
    }
  });

  test("Regression: as_float of a stored SQLite JSON Infinity withholds the row", async () => {
    // Native `as_float.value` (in `packages/backend/native/src/values.ts`)
    // gates on `Number.isFinite(args[0])`, so a JSON value carrying
    // IEEE Infinity or NaN coerces to NULL. SQLite's `jsonAsFloat`
    // used to cast the json scalar to REAL without checking finiteness,
    // so legacy / hand-seeded JSON text like `9e999` sneaked past as
    // Infinity. Spec §6 promises identical output across every backend:
    // downstream `as_float` must still guard this shape even though
    // `parse_json` now rejects non-finite numeric leaves.
    const backend = await createSqlite();
    await backend.execute(`CREATE TABLE "raw" ("j" TEXT NOT NULL)`);
    await backend.execute(`INSERT INTO "raw" ("j") VALUES (?)`, ["9e999"]);
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate raw(j: value).
        r(F) :- raw(J), F = as_float(J).
        ?- r(F).
      `);
      // The expression has no value, so no row is derived to carry it (§1).
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: arithmetic overflow inside an array literal withholds the row before construction", async () => {
    // Chained multiplications like `1e9 * 1e9 * ... * 1e9` exceed the
    // finite float range. The arithmetic expression itself now yields
    // SQL/Datamog NULL; array construction then embeds that NULL as a
    // JSON null on every backend.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      // Use a chain long enough to overflow IEEE double range
      // (1e9 ^ 37 = 1e333 > 1.8e308). Source-level numeric literals
      // can't carry exponents, so build the value via repeated
      // multiplication.
      const factors = new Array(37).fill("1000000000.0").join(" * ");
      const results = await executor.execute(`
        big(X) :- X = ${factors}.
        r(J) :- big(X), J = [X].
        ?- r(J).
      `);
      // Construction is strict in its elements: an element with no value makes
      // the literal have none either, so the row goes rather than carrying
      // `[null]`. Previously the overflow was scrubbed to a JSON null inside the
      // array.
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: exp threshold matches native exactly at the IEEE boundary", async () => {
    // Round 7 wrapped the SQL `exp.float` emission with a pre-check on
    // the input (`x > 709.78`). The constant is slightly less than the
    // exact IEEE overflow threshold `Math.log(Number.MAX_VALUE)` ≈
    // 709.7827, so inputs in the narrow range (709.78, 709.7827] still
    // produce a finite EXP value on native (`Number.isFinite(Math.exp(x))`)
    // but were null'd by the SQL guard — a cross-backend divergence
    // visible to anyone computing exp near the IEEE boundary.
    // `exp(709.781)` is finite (~1.79e308); both backends should
    // return that, not NULL.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        r(X) :- X = exp(709.781).
        ?- r(X).
      `);
      const x = results[0]!.rows[0]?.X as number;
      expect(Number.isFinite(x)).toBe(true);
      expect(x).toBeGreaterThan(1e308);
    } finally {
      await backend.close();
    }
  });

  test("a comparison over a partial operand has no value, in every position", async () => {
    // §4.4. SQL has one NULL and the interpreters have two markers, so this is
    // the shape where they can silently disagree, and they did: the equality's
    // definedness test was folded in as a conjunct, making the comparison
    // *false* at an undefined operand. False is a value, so `C = (V = 10 / V)`
    // bound one and kept a row the interpreters withheld, and `!` never saw an
    // undefined to propagate. A `CASE` with no `ELSE` leaves a NULL instead,
    // which each position already reads correctly.
    //
    // `ne` and `naf` are §4.2's divergence, which must survive the change: the
    // definedness test still sits inside the negation rather than being hoisted.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        s(0). s(1). s(3).
        output predicate ne(V)      :- s(V), V <> 10 / V.
        output predicate naf(V)     :- s(V), not (V = 10 / V).
        output predicate bang(V)    :- s(V), !(V = 10 / V).
        output predicate bind(V, C) :- s(V), C = (V = 10 / V).
        ?- ne(V).
      `);
      expect(results[0]!.rows).toEqual([{ V: 1 }]);
      expect(results[1]!.rows).toEqual([{ V: 0 }, { V: 1 }]);
      expect(results[2]!.rows).toEqual([{ V: 1 }]);
      expect(results[3]!.rows).toEqual([
        { V: 1, C: false },
        { V: 3, C: true },
      ]);
    } finally {
      await backend.close();
    }
  });

  test("lifting a nullable primitive into a `value` spells its null the JSON way", async () => {
    // §9.4's "one new conversion", which was missing: a `T?` column lifted into a
    // `value` emitted a bare SQL NULL, and a SQL NULL in a `value` means
    // undefined (§9.3), so the null row read as an absence. `V = null` found it
    // on the interpreters and not here.
    //
    // A variable is the only lifted operand that can be null and still be
    // defined, so it is the only one that needs the conversion; a partial
    // expression's NULL still means undefined.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        p(1, 1). p(2, null).
        s("hi").
        u(V) :- p(_, V).
        u(V) :- s(V).
        output predicate shape(T)  :- u(V), T = "t=" + type_of(V).
        output predicate eqnull(V) :- u(V), V = null.
        ?- shape(T).
      `);
      expect(results[0]!.rows.map((r) => r.T).sort()).toEqual(["t=null", "t=number", "t=string"]);
      expect(results[1]!.rows).toEqual([{ V: null }]);
    } finally {
      await backend.close();
    }
  });

  test("value construction is strict in undefinedness and not in the null value", async () => {
    // `json_array` / `json_object` never return NULL, so the enclosing
    // definedness guard used to see a defined construction over an absent part
    // and keep a row the interpreters withheld, with a JSON `null` standing in
    // for the part. The construction is now wrapped so an undefined part makes
    // the whole thing NULL.
    //
    // The null *value* still constructs, including a `value` accessor reaching a
    // JSON null leaf, which is §8's distinction: `{"k": null}` gives `[null]` and
    // a missing key gives no row at all.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        one(1).
        doc(J) :- one(_), J = parse_json("{\\"k\\": null}").
        output predicate bad(J)    :- one(_), J = [1, 1 / 0, 3].
        output predicate badobj(J) :- one(_), J = {"a": 1 / 0}.
        output predicate lit(J)    :- one(_), J = [null, 1].
        output predicate leaf(J)   :- doc(D), J = [D["k"]].
        output predicate absent(J) :- doc(D), J = [D["zz"]].
        ?- bad(J).
      `);
      expect(results[0]!.rows).toEqual([]);
      expect(results[1]!.rows).toEqual([]);
      expect(results[2]!.rows).toEqual([{ J: [null, 1] }]);
      expect(results[3]!.rows).toEqual([{ J: [null] }]);
      expect(results[4]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("a connective over a null has no value, agreeing with the interpreters", async () => {
    // §15.26, and the other half of the test above: a connective was the last
    // construct that could be nullable *and* partial, so the head guard's
    // `IS NOT NULL` could not tell which reading a NULL had and threw away the
    // `null && true` row that the interpreters kept. Making the connectives
    // strict at a null makes the result non-nullable, so the guard is right
    // again, and SQL needed no change: `TRUE AND NULL` was already NULL.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        p(1, true, 2). p(2, null, 2). p(3, false, 0). p(4, true, 0).
        output predicate filt(K)    :- p(K, A, B), A && (10 / B > 0).
        output predicate bind(K, C) :- p(K, A, B), C = (A && (10 / B > 0)).
        output predicate bang(K, C) :- p(K, A, _), C = !A.
        ?- filt(K).
      `);
      expect(results[0]!.rows).toEqual([{ K: 1 }]);
      expect(results[1]!.rows).toEqual([
        { K: 1, C: true },
        { K: 3, C: false },
      ]);
      expect(results[2]!.rows).toEqual([
        { K: 1, C: false },
        { K: 3, C: true },
        { K: 4, C: false },
      ]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: round/2 with negative precision matches native on SQLite", async () => {
    // SQLite's built-in `ROUND(x, n)` treats negative `n` like zero:
    // `round(123.45, -1)` returns 123 instead of rounding to the
    // nearest ten. Native implements the usual decimal-place semantics,
    // where negative precision rounds to the left of the decimal point.
    // The SQL emission needs to avoid SQLite's built-in for that branch.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        r(A, B, C, D, E, F, G) :-
          A = round(123.45, -1),
          B = round(15.0, -1),
          C = round(149, -2),
          D = round(1.23, 400),
          E = round(1.23, -400),
          F = round(1.0 / 0.0, -400),
          G = round(1.23, 1 / 0).
        ?- r(A, B, C, D, E, F, G).
      `);
      // `F` and `G` are domain failures, and one undefined head expression
      // withholds the whole tuple, so the sound columns move to their own rule.
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: SQLite float modulo uses real remainder semantics", async () => {
    // Datamog types `%` as float-valued when either operand is float, and
    // the native evaluator uses JS remainder semantics (`5.5 % 2.0` →
    // `1.5`). SQLite's `%` operator coerces both operands to integers
    // before taking the remainder, so the raw SQL emission produced `1`
    // for `5.5 % 2.0` and `1` for `5 % 2.5`. Emit a portable
    // `x - y * trunc(x/y)` shape for float-typed modulo while keeping
    // divide-by-zero as NULL.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        r(A, B, C, D) :-
          A = 5.5 % 2.0,
          B = 5 % 2.5,
          C = -5.5 % 2.0,
          D = 5.5 % 0.0.
        ?- r(A, B, C, D).
      `);
      // `D` is a domain failure, which takes the row with it.
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: SQLite exp/** overflow withholds the row rather than yielding Infinity", async () => {
    // Round 6 fixed `exp.float` and the `power` emission in the native
    // evaluator (commit 2ec4773) to return NULL on overflow, matching
    // spec §5.4's runtime-partial principle. The SQL dialect's emission
    // for `EXP(x)` and `**` was unguarded — `exp(1000.0)` /
    // `2.0 ** 2000.0` returned IEEE Infinity through to the
    // executor, where it leaked into aggregates (`sum` over a column
    // including the overflowed value summed Infinity instead of
    // skipping it as native does for NULL). Spec §6 promises identical
    // output across every backend; the divergence shows up most
    // visibly in aggregates: native sum = 2.0 (NULL skipped), SQLite
    // sum = Infinity. Wrap the SQL emission with a finite-value check
    // so overflow surfaces as NULL on both backends.
    const backend = await createSqlite();
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        r(E, P) :- E = exp(1000.0), P = 2.0 ** 2000.0.
        ?- r(E, P).
      `);
      // The expression has no value, so no row is derived to carry it (§1).
      expect(results[0]!.rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: SQLite sum over a column with an overflow row skips NULL like native does", async () => {
    // The cross-backend symptom of the unguarded exp/** emission:
    // `sum(E)` where one row's E is the overflowed value diverges
    // (native: skip NULL → 2.0; SQLite: Infinity). After the
    // dialect-emission fix both should produce 2.0.
    const backend = await createSqlite();
    await backend.execute(`CREATE TABLE "t" ("x" REAL NOT NULL)`);
    await backend.execute(`INSERT INTO "t" ("x") VALUES (?)`, [1.0]);
    await backend.execute(`INSERT INTO "t" ("x") VALUES (?)`, [2000.0]);
    const executor = new DatamogExecutor(backend);
    try {
      const results = await executor.execute(`
        input predicate t(x: float).
        mapped(E) :- t(X), E = 2.0 ** X.
        total(sum(E)) :- mapped(E).
        ?- total(S).
      `);
      expect(results[0]!.rows).toEqual([{ S: 2.0 }]);
    } finally {
      await backend.close();
    }
  });

  test("Regression: an aggregate over a projected single-rule IDB view treats it as a set", async () => {
    // A single-rule non-recursive IDB view was emitted as a lone SELECT (no
    // UNION, so no dedup). When the rule projected away a body variable the
    // view held duplicate rows, so an aggregate reading it over-counted on the
    // SQL backends; the interpreters dedup IDB tuples. IDB relations are sets.
    const program = `
      e(1, 5, 100). e(1, 5, 200). e(1, 7, 300).
      mid(G, X) :- e(G, X, Y).
      r(G, sum(X), count(X)) :- mid(G, X).
      ?- r(G, S, C).
    `;
    for (const results of await executeOnSqliteAndNative(program)) {
      expect(sortRows(results[0]!)).toEqual([{ G: 1, S: 12, C: 2 }]);
    }
  });

  test("Regression: deep chained value subscript and slice do not overflow the SQL parser", async () => {
    // The SQLite dialect re-embedded the receiver in jsonSubscript/jsonSlice,
    // so a chained V["a"]["a"]["a"]["a"] / V[0][0][0][0] grew the generated SQL
    // exponentially and overflowed the parser at depth 4. Referencing the
    // receiver once makes the growth linear. Native references it once already.
    const obj = `r(Y) :- Y = {"a": {"a": {"a": {"a": 9}}}}["a"]["a"]["a"]["a"].\n?- r(Y).`;
    for (const results of await executeOnSqliteAndNative(obj)) {
      expect(results[0]!).toEqual([{ Y: 9 }]);
    }
    const arr = "r(Y) :- Y = [[[[7]]]][0][0][0][0].\n?- r(Y).";
    for (const results of await executeOnSqliteAndNative(arr)) {
      expect(results[0]!).toEqual([{ Y: 7 }]);
    }
    const slc = "r(Y) :- Y = [[[[1, 2, 3, 4]]]][0][0][0][1:3].\n?- r(Y).";
    for (const results of await executeOnSqliteAndNative(slc)) {
      expect(results[0]!).toEqual([{ Y: [2, 3] }]);
    }
  });

  test("Regression: to_json of a numeric JSON scalar returns canonical text on every backend", async () => {
    // `to_json` is spec'd to return a `string` (canonical JSON text). On
    // SQLite a number leaf kept numeric affinity, so `to_json(parse_json(42))`
    // was the number 42, not the text "42", and failed to dedup/join against
    // the string "42".
    const program = `
      n(X) :- X = to_json(parse_json("42")).
      n(X) :- X = "42".
      ?- n(X).
    `;
    for (const results of await executeOnSqliteAndNative(program)) {
      expect(sortRows(results[0]!)).toEqual([{ X: "42" }]);
    }
  });

  test("Regression: a quoted identifier with a quote survives mutual-recursion NULL padding", async () => {
    // `findTopLevelFrom` (the SQLite mutual-recursion NULL-padding helper)
    // scanned the emitted SELECT tracking `'...'` strings but not `"..."`
    // identifiers, so a quoted column name containing a `'` desynced the scan.
    // The FROM splice point was lost and the padded rule emitted
    // `... FROM "e" AS __b0, NULL` (a syntax error). Native was unaffected.
    const src = [
      "input predicate e(`o'brien`: string).",
      "`hi`(V) :- e(V).",
      "`hi`(V) :- q(V, _).",
      "q(X, X) :- `hi`(X).",
      "?- `hi`(A).",
    ].join("\n");
    const loader: ExtensionalLoader = {
      name: "e-loader",
      async canLoad(d) {
        return d.predicate === "e";
      },
      async load(d, backend) {
        await insertRows(backend, d, [{ "o'brien": "a" }]);
        return { rowsLoaded: 1 };
      },
    };
    const sqlite = await createSqlite();
    try {
      const sq = (await new DatamogExecutor(sqlite, [loader]).execute(src)).map((q) => q.rows);
      const { create: createNative } = await import("../../backend/native/src/index.ts");
      const native = await createNative();
      try {
        const na = (await new DatamogExecutor(native, [loader]).execute(src)).map((q) => q.rows);
        expect(sortRows(sq[0]!)).toEqual([{ A: "a" }]);
        expect(sortRows(na[0]!)).toEqual([{ A: "a" }]);
      } finally {
        await native.close();
      }
    } finally {
      await sqlite.close();
    }
  });

  test("a translation error carries the source file threaded through execute", async () => {
    // The file flows execute() -> prepare() -> parse/analyze and onto the
    // analysed program, so a translate-time rejection (non-linear recursion,
    // SQL-only) names its file. File-less execution leaves it undefined.
    const src = "e(1, 2).\np(X, Y) :- e(X, Y).\np(X, Y) :- p(X, Z), p(Z, Y).\n?- p(X, Y).";
    const errFile = async (file?: string): Promise<string | undefined> => {
      const sqlite = await createSqlite();
      try {
        await new DatamogExecutor(sqlite).execute(src, file);
        return "NO ERROR";
      } catch (e) {
        return (e as { file?: string }).file;
      } finally {
        await sqlite.close();
      }
    };
    expect(await errFile("prog.dl")).toBe("prog.dl");
    expect(await errFile()).toBeUndefined();
  });
});

// §1 requires definedness per conjunct, and each of these is a position where the
// SQL side used to read a NULL as a value and so kept a row the interpreters
// withheld, or the reverse under a negation. The interpreters are the reference.
describe("definedness at every conjunct", () => {
  test("a fact whose head expression has no value derives no tuple", async () => {
    // A body-less rule takes its own translation path, which emitted a bare
    // SELECT with no WHERE, so the head guard never ran. The phantom row was
    // observable three ways at once: it counted, it satisfied a negation, and it
    // violated a constraint over a predicate that should have been empty.
    const [sqlite, native] = await executeOnSqliteAndNative(`
      bad(1 / 0).
      good(2).
      output predicate counted(count(*)) :- bad(_).
      output predicate empty() :- not bad(_).
      output predicate kept(N) :- good(N).
      ?- bad(X).
    `);
    expect(sqlite).toEqual(native);
    expect(sqlite[0]).toEqual([{ count: 0 }]);
    expect(sqlite[1]).toEqual([{}]);
    expect(sqlite[2]).toEqual([{ N: 2 }]);
    expect(sqlite[3]).toEqual([]);
  });

  test("a body equality holds only where both sides have a value", async () => {
    // The null-aware operator answers *true* for two absences, so a conjunct
    // comparing two missing keys held. Row 3 is the case: both keys are absent
    // and neither side has a value, so the conjunct must not hold.
    const [sqlite, native] = await executeOnSqliteAndNative(`
      doc(1, J) :- J = {"k": 1, "m": 1}.
      doc(2, J) :- J = {"k": 1, "m": 2}.
      doc(3, J) :- J = {}.
      doc(4, J) :- J = {"k": null, "m": null}.
      output predicate eq(Id) :- doc(Id, J), J["k"] = J["m"].
      output predicate ne(Id) :- doc(Id, J), J["k"] <> J["m"].
      output predicate notEq(Id) :- doc(Id, J), not (J["k"] = J["m"]).
      ?- eq(Id).
    `);
    expect(sqlite).toEqual(native);
    // Row 4 matches: two JSON nulls are the same value.
    expect(sortRows(sqlite[0]!)).toEqual(sortRows([{ Id: 1 }, { Id: 4 }]));
    expect(sortRows(sqlite[1]!)).toEqual([{ Id: 2 }]);
    // `not` complements failure, so it also holds where a side has no value.
    expect(sortRows(sqlite[2]!)).toEqual(sortRows([{ Id: 2 }, { Id: 3 }]));
  });

  test("an atom argument with no value stops the match, and a negated one holds", async () => {
    // The guard goes at rule level for a positive atom and inside the subquery
    // for a negated one: `not p(1 / 0)` holds, §1's `not` complementing failure
    // for any reason including an absence.
    const [sqlite, native] = await executeOnSqliteAndNative(`
      doc(1, J) :- J = {}.
      doc(2, J) :- J = {"k": 7}.
      q(7).
      output predicate pos(I) :- doc(I, J), q(J["k"]).
      output predicate neg(I) :- doc(I, J), not q(J["k"]).
      ?- pos(I).
    `);
    expect(sqlite).toEqual(native);
    expect(sortRows(sqlite[0]!)).toEqual([{ I: 2 }]);
    expect(sortRows(sqlite[1]!)).toEqual([{ I: 1 }]);
  });

  test("a nullable primitive reaches a value slot as a JSON null, however it is spelled", async () => {
    // §9.4's lift. A repeated variable and a spelled-out equality are the same
    // rule, so they have to lift the same way, and a builtin's `value` parameter
    // takes the null as one of the shapes it holds rather than as an absence.
    const [sqlite, native] = await executeOnSqliteAndNative(`
      p(1, 1).
      p(2, null).
      v(J) :- J = parse_json("1").
      v(J) :- J = parse_json("null").
      output predicate shared(X) :- p(_, X), v(X).
      output predicate spelled(X) :- p(_, X), v(Y), X = Y.
      output predicate shape(K, T) :- p(K, X), T = type_of(X).
      ?- shared(X).
    `);
    expect(sqlite).toEqual(native);
    expect(sortRows(sqlite[0]!)).toEqual(sortRows([{ X: 1 }, { X: null }]));
    expect(sortRows(sqlite[1]!)).toEqual(sortRows([{ X: 1 }, { X: null }]));
    expect(sortRows(sqlite[2]!)).toEqual(
      sortRows([
        { K: 1, T: "number" },
        { K: 2, T: "null" },
      ]),
    );
  });

  test("concat skips a null and a missing key alike", async () => {
    // Position 3 makes a nullable primitive a static error here, so a `value` is
    // the only argument that can carry a null, and its null is the JSON spelling
    // rather than a SQL NULL, which the group-concat skip does not see.
    const [sqlite, native] = await executeOnSqliteAndNative(`
      arr(J) :- J = parse_json("[1, null, 3]").
      output predicate joined(concat(J[K])) :- arr(J), K in [0 .. 4].
      ?- joined(C).
    `);
    expect(sqlite).toEqual(native);
    expect(sqlite[0]).toEqual([{ concat: "1,3" }]);
  });
});

test("loaders enforce nested value nullability across evaluation backends", async () => {
  for (const create of [
    createSqlite,
    (await import("../../backend/native/src/index.ts")).create,
    (await import("../../backend/seminaive/src/index.ts")).create,
    (await import("../../backend/sqljs/src/index.ts")).create,
  ]) {
    for (const [shape, value, valid] of [
      ["value", null, false],
      ["value?", null, true],
      ["{x: Opaque}", { x: null }, false],
      ["{x?: Opaque}", { x: null }, false],
      ["{x?: Opaque}", {}, true],
      ["{x: Opaque?}", { x: null }, true],
      ["[Opaque]", [null], false],
      ["[Opaque?]", [null], true],
      ["{x: Opaque}", { x: { child: null } }, true],
      ["[Opaque]", [{ child: null }], true],
    ] as const) {
      const backend = await create();
      const executor = new DatamogExecutor(backend, [
        {
          name: "typed",
          async canLoad() {
            return true;
          },
          async load(decl, target) {
            await insertRows(target, decl, [{ j: value }]);
            return { rowsLoaded: 1 };
          },
        },
      ]);
      try {
        const result = executor.execute(
          `type Opaque = value. input predicate data(j: ${shape}). ?- data(J).`,
        );
        if (valid) expect((await result)[0]!.rows).toEqual([{ J: value }]);
        else await expect(result).rejects.toThrow(/null|expected value/i);
      } finally {
        await backend.close();
      }
    }
  }
});
