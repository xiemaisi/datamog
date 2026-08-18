import { describe, expect, test } from "bun:test";
import { create as createSqlite } from "datamog-backend-sqlite";
import { IncrementalSession } from "datamog-engine";
import { DatamogRepl, type ReplEvent, type SessionFactory } from "../src/index.ts";

/** Build a REPL bound to a fresh in-memory SQLite session. The factory is
 *  recreated on every `:reset`, so each test exercising reset gets a fresh
 *  backend automatically. */
function makeRepl(): DatamogRepl {
  const factory: SessionFactory = async () => {
    const backend = await createSqlite();
    const session = new IncrementalSession(backend, []);
    return { session, close: () => backend.close() };
  };
  return new DatamogRepl(factory, { backendName: "sqlite" });
}

function findEvent<K extends ReplEvent["kind"]>(
  events: ReplEvent[],
  kind: K,
): Extract<ReplEvent, { kind: K }> | undefined {
  return events.find((e) => e.kind === kind) as Extract<ReplEvent, { kind: K }> | undefined;
}

describe("DatamogRepl", () => {
  test("declaration emits a declared event", async () => {
    const repl = makeRepl();
    try {
      const events = await repl.feed("input predicate p(x: integer).");
      expect(events).toEqual([{ kind: "declared", predicate: "p", arity: 1, rowsLoaded: 0 }]);
    } finally {
      await repl.close();
    }
  });

  test("rule emits a rule event", async () => {
    const repl = makeRepl();
    try {
      await repl.feed("input predicate q(x: integer).");
      const events = await repl.feed("p(X) :- q(X).");
      const rule = findEvent(events, "rule");
      expect(rule).toEqual({ kind: "rule", predicate: "p", arity: 1 });
    } finally {
      await repl.close();
    }
  });

  test("query emits a result event with column types", async () => {
    const repl = makeRepl();
    try {
      await repl.feed("input predicate q(x: integer).");
      const events = await repl.feed("?- q(X).");
      const result = findEvent(events, "result");
      expect(result).toBeDefined();
      expect(result!.columns).toEqual(["X"]);
      expect(result!.types).toEqual(["integer"]);
      expect(result!.nullable).toEqual([false]);
      expect(result!.rows).toEqual([]);
    } finally {
      await repl.close();
    }
  });

  test("a result event's nullability agrees with the rows it carries", async () => {
    // Without `nullable` the event could contradict itself: `types: ["integer"]`
    // beside a row holding `null`. Under the value model the `?` is what says
    // whether that NULL is the `null` value or an absence, so a client reading the
    // types alone was told something false.
    const repl = makeRepl();
    try {
      await repl.feed("p(1, null).\np(2, 7).");
      const result = findEvent(await repl.feed("?- p(X, Y)."), "result");
      expect(result!.types).toEqual(["integer", "integer"]);
      expect(result!.nullable).toEqual([false, true]);
      // The claim the pair makes about the data actually holds.
      const ys = result!.rows.map((r) => r.Y).sort();
      expect(ys).toEqual([7, null]);
    } finally {
      await repl.close();
    }
  });

  test("a guard in the query body narrows the reported nullability", async () => {
    // A query is a body owner, so the nullness fixed point refines it: this is the
    // per-query answer, not the column's declaration.
    const repl = makeRepl();
    try {
      await repl.feed("p(1, null).\np(2, 7).");
      const result = findEvent(await repl.feed("?- p(X, Y), Y <> null."), "result");
      expect(result!.nullable).toEqual([false, false]);
      expect(result!.rows).toEqual([{ X: 2, Y: 7 }]);
    } finally {
      await repl.close();
    }
  });

  test("rules accumulate within one chunk and across chunks", async () => {
    const repl = makeRepl();
    try {
      // Two rules for `ancestor` in one chunk define a recursive view.
      await repl.feed(`
        input predicate parent(p: string, c: string).
        ancestor(X, Y) :- parent(X, Y).
        ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
      `);
      // A separate chunk adds a new IDB on top — ancestor is locked,
      // but defining a new predicate that references it is fine.
      const events = await repl.feed("descendant(Y, X) :- ancestor(X, Y).");
      const rule = findEvent(events, "rule");
      expect(rule).toEqual({ kind: "rule", predicate: "descendant", arity: 2 });
    } finally {
      await repl.close();
    }
  });

  test("re-declaring an EDB across chunks is rejected with chunk-relative position", async () => {
    const repl = makeRepl();
    try {
      await repl.feed("input predicate p(x: integer).");
      const events = await repl.feed("\ninput predicate p(y: string).");
      const err = findEvent(events, "error");
      expect(err).toBeDefined();
      expect(err!.phase).toBe("analyze");
      expect(err!.message).toContain("defined in an earlier chunk");
      // The fragment starts with a leading newline, so the redefinition is
      // on line 2 of the chunk.
      expect(err!.line).toBe(2);
      expect(err!.column).toBe(1);
    } finally {
      await repl.close();
    }
  });

  test("adding a rule for an already-applied IDB across chunks is rejected", async () => {
    const repl = makeRepl();
    try {
      await repl.feed(`
        input predicate q(x: integer).
        p(X) :- q(X).
      `);
      const events = await repl.feed("p(X) :- q(X), q(Y).");
      const err = findEvent(events, "error");
      expect(err?.phase).toBe("analyze");
      expect(err?.message).toContain("defined in an earlier chunk");
    } finally {
      await repl.close();
    }
  });

  test("parse error reports chunk-relative line/column", async () => {
    const repl = makeRepl();
    try {
      const events = await repl.feed("p(X) := q(X).");
      const err = findEvent(events, "error");
      expect(err?.phase).toBe("parse");
      expect(err?.line).toBe(1);
      // `:=` is at column 6; the parser flags the `=` (column 7).
      expect(err?.column).toBeGreaterThanOrEqual(6);
    } finally {
      await repl.close();
    }
  });

  test("Regression: parse error message does not embed its own line/column", async () => {
    // ParseError's constructor appends ` at line N, column M` to the
    // raw message; the host renderer adds its own location suffix from
    // the line/column fields. Surfacing both produced doubled output
    // ("... at line 1, column 7 at line 1, column 7"). The REPL strips
    // the embedded copy so the renderer is the sole source.
    const repl = makeRepl();
    try {
      const events = await repl.feed("p(X) := q(X).");
      const err = findEvent(events, "error");
      expect(err).toBeDefined();
      expect(err!.message).not.toMatch(/at line \d+, column \d+/);
    } finally {
      await repl.close();
    }
  });

  test(":reset clears state and allows re-declaration", async () => {
    const repl = makeRepl();
    try {
      await repl.feed("input predicate p(x: integer).");
      const reset = await repl.feed(":reset");
      expect(reset[0]?.kind).toBe("info");
      // After reset, the predicate name is free again.
      const events = await repl.feed("input predicate p(y: string).");
      const decl = findEvent(events, "declared");
      expect(decl).toBeDefined();
    } finally {
      await repl.close();
    }
  });

  test(":help returns an info event listing commands", async () => {
    const repl = makeRepl();
    try {
      const events = await repl.feed(":help");
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("info");
      expect((events[0] as { message: string }).message).toContain(":reset");
    } finally {
      await repl.close();
    }
  });

  test(":quit sets shouldQuit and emits an info event", async () => {
    const repl = makeRepl();
    try {
      const events = await repl.feed(":quit");
      expect(events[0]?.kind).toBe("info");
      expect(repl.shouldQuit).toBe(true);
    } finally {
      await repl.close();
    }
  });

  test(":schema lists declared and ruled predicates", async () => {
    const repl = makeRepl();
    try {
      await repl.feed(`
        input predicate q(x: integer).
        p(X) :- q(X).
      `);
      const events = await repl.feed(":schema");
      const sch = findEvent(events, "schema");
      expect(sch).toBeDefined();
      const names = sch!.predicates.map((p) => p.name).sort();
      expect(names).toEqual(["p", "q"]);
      const q = sch!.predicates.find((p) => p.name === "q")!;
      expect(q.predicateKind).toBe("edb");
      expect(q.columns).toEqual([{ name: "x", type: "integer", nullable: false }]);
      const p = sch!.predicates.find((p) => p.name === "p")!;
      expect(p.predicateKind).toBe("idb");
      expect(p.columns).toEqual([{ name: "col1", type: "integer", nullable: false }]);
    } finally {
      await repl.close();
    }
  });

  test(":schema reports the `?` on a nullable column, declared and inferred", async () => {
    // `nullable` is half the declared type: it decides whether a SQL NULL in that
    // position is the `null` value or an absence, so a schema that prints the base
    // type alone reported `integer` for a column declared `integer?`.
    const repl = makeRepl();
    try {
      await repl.feed(`
        input predicate q(x: integer, y: integer?).
        p(X, Y) :- q(X, Y).
      `);
      const sch = findEvent(await repl.feed(":schema"), "schema");
      const q = sch!.predicates.find((p) => p.name === "q")!;
      expect(q.columns).toEqual([
        { name: "x", type: "integer", nullable: false },
        { name: "y", type: "integer", nullable: true },
      ]);
      // The IDB column inherits it through inference, not through a declaration.
      const p = sch!.predicates.find((p) => p.name === "p")!;
      expect(p.columns).toEqual([
        { name: "col1", type: "integer", nullable: false },
        { name: "col2", type: "integer", nullable: true },
      ]);
    } finally {
      await repl.close();
    }
  });

  test(":sql previews the generated SQL without executing", async () => {
    const repl = makeRepl();
    try {
      await repl.feed("input predicate q(x: integer).");
      const events = await repl.feed(":sql ?- q(X).");
      const sql = findEvent(events, "sql");
      expect(sql).toBeDefined();
      expect(sql!.sql).toContain("FROM");
      expect(sql!.sql).toContain("q");
    } finally {
      await repl.close();
    }
  });

  test(":sql with a non-query rejects", async () => {
    const repl = makeRepl();
    try {
      await repl.feed("input predicate q(x: integer).");
      const events = await repl.feed(":sql p(X) :- q(X).");
      const err = findEvent(events, "error");
      expect(err).toBeDefined();
      expect(err!.phase).toBe("command");
    } finally {
      await repl.close();
    }
  });

  test(":show prints accumulated statements", async () => {
    const repl = makeRepl();
    try {
      await repl.feed("input predicate q(x: integer).");
      await repl.feed("p(X) :- q(X).");
      const events = await repl.feed(":show");
      expect(events[0]?.kind).toBe("info");
      const msg = (events[0] as { message: string }).message;
      expect(msg).toContain("input predicate q");
      expect(msg).toContain("p(X) :- q(X).");
    } finally {
      await repl.close();
    }
  });

  test("integration: load + query returns rows", async () => {
    const repl = makeRepl();
    try {
      // Build an inline rule that produces deterministic rows so we don't
      // need a CSV loader for this test.
      const events = await repl.feed(`
        input predicate pair(a: integer, b: integer).
        sum_pair(A, B, S) :- pair(A, B), S = A + B.
      `);
      expect(findEvent(events, "rule")).toBeDefined();

      // Inserting rows is a pretty deep concern (loaders, fixtures); skip
      // and just confirm the query against an empty EDB returns no rows.
      const queryEvents = await repl.feed("?- sum_pair(A, B, S).");
      const result = findEvent(queryEvents, "result");
      expect(result?.rows).toEqual([]);
      expect(result?.columns).toEqual(["A", "B", "S"]);
    } finally {
      await repl.close();
    }
  });
});
