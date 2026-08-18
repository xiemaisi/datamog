// A guard against the Postgres suites silently skipping themselves.
//
// Both of them are `describe.skipIf(!DATABASE_URL)`, which is right for a local
// `bun test` and dangerous in CI: a broken service container, a renamed env var or
// a typo'd connection string turns 90-odd tests into zero tests and the run still
// goes green. That has already happened once, for a whole branch.
//
// So a run that is *meant* to have Postgres says so, and this fails if it does not.
// Keyed on its own opt-in rather than on `CI`, because `ci.yml`'s Quality Gate
// legitimately runs `bun test` with no database and must stay green.
//
// Set `DATAMOG_REQUIRE_POSTGRES=1` in any environment where a skip is a bug.

import { describe, expect, test } from "bun:test";

const REQUIRED = process.env.DATAMOG_REQUIRE_POSTGRES;

describe.skipIf(!REQUIRED)("DATAMOG_REQUIRE_POSTGRES", () => {
  test("DATABASE_URL is set, so the Postgres suites are not skipping", () => {
    expect(
      process.env.DATABASE_URL,
      "DATAMOG_REQUIRE_POSTGRES is set but DATABASE_URL is not, so every Postgres-gated suite silently skipped. Check the service container and the connection string.",
    ).toBeTruthy();
  });

  test("the examples suite has a database, its own or the shared one", () => {
    // `examples.test.ts` prefers `DATAMOG_EXAMPLES_DATABASE_URL` and falls back to
    // `DATABASE_URL`, so either satisfies it. Both suites drop and recreate
    // `public`, so sharing one database only works while `bun test` runs files
    // serially — the separate variable is what makes that not a latent trap.
    const url = process.env.DATAMOG_EXAMPLES_DATABASE_URL ?? process.env.DATABASE_URL;
    expect(url, "neither DATAMOG_EXAMPLES_DATABASE_URL nor DATABASE_URL is set").toBeTruthy();
  });

  // Skipped rather than failed when the URL is simply absent: the first test
  // already says that plainly, and connecting to a default local socket on top of
  // it would bury the message under a driver stack trace.
  test.skipIf(!process.env.DATABASE_URL)("the connection actually works", async () => {
    // The variable being present is not the same as the server answering. A
    // health-checked service container makes this near-certain, but the whole
    // point of the guard is to not assume.
    const { SQL } = await import("bun");
    const sql = new SQL(process.env.DATABASE_URL!);
    try {
      const rows = await sql`SELECT 1 AS ok`;
      expect(rows[0]!.ok).toBe(1);
    } finally {
      await sql.close();
    }
  });
});
