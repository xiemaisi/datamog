import { describe, expect, test } from "bun:test";
import { create as createSqlite } from "datamog-backend-sqlite";
import type { Backend, QueryResult } from "../src/backend.ts";
import { ConstraintViolationError } from "../src/constraints.ts";
import { DatamogExecutor } from "../src/executor.ts";

// Constraints must behave identically on the SQL translator and both
// interpreters, so every case runs on all three backends. The interpreters are
// imported by path: engine does not depend on them (they depend on it).
async function backends(): Promise<{ name: string; backend: Backend }[]> {
  const { create: createNative } = await import("../../backend/native/src/index.ts");
  const { create: createSeminaive } = await import("../../backend/seminaive/src/index.ts");
  return [
    { name: "sqlite", backend: await createSqlite() },
    { name: "native", backend: await createNative() },
    { name: "seminaive", backend: await createSeminaive() },
  ];
}

/** Run `source` on every backend, returning either its results or its violation. */
async function runAll(
  source: string,
): Promise<{ name: string; results?: QueryResult[]; error?: ConstraintViolationError }[]> {
  const out: { name: string; results?: QueryResult[]; error?: ConstraintViolationError }[] = [];
  for (const { name, backend } of await backends()) {
    try {
      out.push({ name, results: await new DatamogExecutor(backend).execute(source) });
    } catch (e) {
      if (!(e instanceof ConstraintViolationError)) throw e;
      out.push({ name, error: e });
    } finally {
      await backend.close?.();
    }
  }
  return out;
}

function sortRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe("integrity constraints", () => {
  test("a violated `error predicate` aborts with the counterexamples", async () => {
    for (const { name, error } of await runAll(`
      ord(1, "alice").
      ord(2, "nobody").
      cust("alice").
      error predicate orphan(I, C) :- ord(I, C), not cust(C).
      ?- ord(I, C).
    `)) {
      expect(error, name).toBeDefined();
      expect(error!.violations, name).toHaveLength(1);
      expect(error!.violations[0]!.predicate, name).toBe("orphan");
      expect(sortRows(error!.violations[0]!.rows), name).toEqual([{ I: 2, C: "nobody" }]);
      expect(error!.message, name).toContain("Constraint 'orphan' is violated by 1 row");
    }
  });

  test("a violated `!-` reports its source text and its projected witnesses", async () => {
    for (const { name, error } of await runAll(`
      ord(1, "alice").
      ord(2, "nobody").
      cust("alice").
      !- ord(I, C), not cust(C).
    `)) {
      expect(error, name).toBeDefined();
      expect(error!.violations[0]!.predicate, name).toBeUndefined();
      expect(error!.violations[0]!.source, name).toBe("!- ord(I, C), not cust(C).");
      expect(sortRows(error!.violations[0]!.rows), name).toEqual([{ I: 2, C: "nobody" }]);
    }
  });

  test("a satisfied constraint leaves query results untouched", async () => {
    for (const { name, results, error } of await runAll(`
      ord(1, "alice").
      cust("alice").
      !- ord(I, C), not cust(C).
      ?- ord(I, C).
    `)) {
      expect(error, name).toBeUndefined();
      expect(results, name).toHaveLength(1);
      expect(results![0]!.rows, name).toEqual([{ I: 1, C: "alice" }]);
    }
  });

  test("no query runs when a constraint is violated", async () => {
    // The `?-` here would return a row, so an empty/absent result list proves
    // the queries were never executed rather than executed and discarded.
    for (const { name, results, error } of await runAll(`
      ord(1, "nobody").
      !- ord(I, C), not cust(C).
      cust("alice").
      ?- ord(I, C).
    `)) {
      expect(error, name).toBeDefined();
      expect(results, name).toBeUndefined();
    }
  });

  test("a ground constraint violates with a witness-free row", async () => {
    for (const { name, error } of await runAll(`
      ord(1, "alice").
      !- ord(1, "alice").
    `)) {
      expect(error, name).toBeDefined();
      expect(error!.violations[0]!.rows, name).toEqual([{}]);
      expect(error!.message, name).toContain("()");
    }
  });

  test("every violated constraint is reported, not just the first", async () => {
    for (const { name, error } of await runAll(`
      ord(1, "nobody").
      cust("alice").
      !- ord(I, C), not cust(C).
      error predicate unknown_cust(C) :- ord(_, C), not cust(C).
    `)) {
      expect(error!.violations, name).toHaveLength(2);
      expect(
        error!.violations.map((v) => v.predicate),
        name,
      ).toEqual([undefined, "unknown_cust"]);
    }
  });

  test("a recursive constraint is checked at its fixed point", async () => {
    for (const { name, error } of await runAll(`
      edge(1, 2).
      edge(2, 3).
      edge(3, 1).
      path(X, Y) :- edge(X, Y).
      path(X, Y) :- path(X, Z), edge(Z, Y).
      error predicate cycle(X) :- path(X, X).
    `)) {
      expect(error, name).toBeDefined();
      expect(sortRows(error!.violations[0]!.rows), name).toEqual([{ X: 1 }, { X: 2 }, { X: 3 }]);
    }
  });

  test("a constraint predicate is usable as an ordinary predicate", async () => {
    // `error predicate` defines its predicate like any rule; other rules may
    // read it. Nothing is violated here, so the query still runs.
    for (const { name, results, error } of await runAll(`
      ord(1, "alice").
      cust("alice").
      error predicate orphan(C) :- ord(_, C), not cust(C).
      counted(N) :- N = 0, not orphan(_).
      ?- counted(N).
    `)) {
      expect(error, name).toBeUndefined();
      expect(results![0]!.rows, name).toEqual([{ N: 0 }]);
    }
  });

  test("`error` is still usable as an ordinary identifier", async () => {
    for (const { name, results, error } of await runAll(`
      input predicate error(error: string).
      ?- error(X).
    `)) {
      expect(error, name).toBeUndefined();
      expect(results![0]!.rows, name).toEqual([]);
    }
  });

  test("rules disagreeing about the marker are rejected", async () => {
    expect(
      new DatamogExecutor(await createSqlite()).execute(`
        a(1).
        output predicate p(X) :- a(X).
        error predicate p(X) :- a(X).
      `),
    ).rejects.toThrow(/marked 'output predicate' by one rule and 'error predicate' by another/);
  });

  test("a `!-` constraint does not claim the file's default output", async () => {
    // Both a `?-` and a `!-` in one file: only the `?-` is the default output,
    // so this must not trip the one-default-output rule.
    for (const { name, error, results } of await runAll(`
      ord(1, "alice").
      !- ord(I, "nobody").
      ?- ord(I, C).
    `)) {
      expect(error, name).toBeUndefined();
      expect(results, name).toHaveLength(1);
    }
  });
});
