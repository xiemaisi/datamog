import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { create as createNative } from "datamog-backend-native";
import { create as createPostgres } from "datamog-backend-postgres";
import { create as createSeminaive } from "datamog-backend-seminaive";
import { create as createSqlite } from "datamog-backend-sqlite";
import { create as createSqljs } from "datamog-backend-sqljs";
import { CsvLoader } from "datamog-csv";
import { type Backend, DatamogExecutor } from "datamog-engine";
import { createNodeModuleResolver } from "datamog-engine/module-resolver";
import { JsonLoader } from "datamog-json";
import { JsonlLoader } from "datamog-jsonl";
import { MermaidLoader } from "datamog-mermaid";

const EXAMPLES_DIR = join(dirname(import.meta.dir), "examples");

function getExamples(): string[] {
  return readdirSync(EXAMPLES_DIR).filter((name) => {
    const dir = join(EXAMPLES_DIR, name);
    return readdirSync(dir).some((f) => f.endsWith(".dl"));
  });
}

// Examples the SQL backends can't run: non-linear recursion, and
// parity-stratified recursion (which needs an alternating fixed point). They
// carry a `native-only` marker file; the sqlite backend is skipped for them and
// the seminaive backend is the canonical source for expected.json.
function isNativeOnly(name: string): boolean {
  return existsSync(join(EXAMPLES_DIR, name, "native-only"));
}

/**
 * Examples the Postgres backend cannot run, each with the server's complaint.
 * They are `test.failing` rather than skipped, so the gap is recorded and
 * whoever fixes the dialect is told to delete the entry.
 *
 * shannon-entropy is not a defect and will not be fixed:
 * its answer is right to 15 significant figures and differs from SQLite's in
 * the last bit, floating-point addition not being associative and `LN` not
 * being specified to the ulp. It is listed so that the divergence is recorded
 * rather than papered over with a tolerance on every other example's
 * comparison.
 */
const POSTGRES_KNOWN_FAILURES = new Map<string, string>([
  ["shannon-entropy", "last-bit float difference, not a defect"],
]);

/**
 * Examples the sql.js backend cannot run. sql.js ships a stock SQLite WASM
 * build without the math extension that `bun:sqlite` enables, so `LN` is
 * missing. The translator emits `LN` for `ln` and again inside the `**`
 * overflow guard (`EXP(exp * LN(base))`), so those two features are
 * unavailable on this backend; `SQRT`, `EXP`, `ABS`, and `ROUND` are all
 * present, which is why nothing else is affected.
 *
 * Worth knowing before anyone adds a base-10 log: sql.js does define `LOG`,
 * but as the natural logarithm, where SQLite's math extension defines it as
 * base 10. Nothing emits `LOG` today, so that difference is latent rather than
 * a wrong answer.
 */
const SQLJS_KNOWN_FAILURES = new Map<string, string>([
  ["shannon-entropy", "sql.js has no LN function"],
]);

/**
 * The program to run for an example. A directory holding a module example has
 * several `.dl` files -- the entry plus the modules it imports -- so the entry
 * is the one named after the directory. Single-program examples may still name
 * their file freely.
 */
function entryFile(dir: string, name: string): string {
  if (existsSync(join(dir, `${name}.dl`))) return `${name}.dl`;
  const dlFiles = readdirSync(dir).filter((f) => f.endsWith(".dl"));
  if (dlFiles.length === 1) return dlFiles[0]!;
  throw new Error(
    `Example '${name}' has ${dlFiles.length} .dl files and no ${name}.dl to pick as the entry`,
  );
}

async function runExample(
  name: string,
  createBackend: () => Promise<Backend>,
): Promise<Record<string, unknown>[][]> {
  const backend = await createBackend();
  try {
    return await runExampleOn(name, backend);
  } finally {
    await backend.close();
  }
}

/**
 * Run one example on a backend the caller owns. Split out because the Postgres
 * backend has to be shared across a whole block rather than created per test:
 * closing a Postgres connection is final, so one backend serves every example
 * and the schema is wiped between them.
 */
async function runExampleOn(name: string, backend: Backend): Promise<Record<string, unknown>[][]> {
  const dir = join(EXAMPLES_DIR, name);
  const file = join(dir, entryFile(dir, name));
  const source = await Bun.file(file).text();

  // Elaborate rather than plain-parse, so an example may import modules with
  // `:=`; the resolver reads them from disk relative to the entry file. For an
  // example without bindings this is the same pipeline `execute` would run.
  const { program, dataSources } = DatamogExecutor.prepareElaborated(
    source,
    createNodeModuleResolver(),
    file,
  );
  if (dataSources.length > 0) {
    // Data-file bindings need loaders built from the binding, which only the
    // CLI does. The directory loaders below key off the predicate name, so
    // they would quietly load the wrong file or none at all.
    throw new Error(`Example '${name}' uses a ':=' data-file binding, unsupported here`);
  }

  const executor = new DatamogExecutor(backend, [
    new CsvLoader({ directory: dir }),
    new JsonLoader({ directory: dir }),
    new JsonlLoader({ directory: dir }),
    new MermaidLoader({ directory: dir }),
  ]);

  const results = await executor.executeAnalyzed(program);
  return results.map((r) => r.rows);
}

/** Datalog is set-valued, so tuple ordering inside a result set isn't stable. */
function sortResults(results: Record<string, unknown>[][]): Record<string, unknown>[][] {
  return results.map((rows) =>
    [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

describe("examples (sqlite backend)", () => {
  for (const name of getExamples()) {
    const expectedPath = join(EXAMPLES_DIR, name, "expected.json");

    // `native-only` examples are rejected by sqlite; seminaive seeds their
    // expected.json instead (see the seminaive block below).
    const sqliteTest = isNativeOnly(name) ? test.skip : test;
    sqliteTest(name, async () => {
      const actual = await runExample(name, createSqlite);

      const expectedFile = Bun.file(expectedPath);
      if (!(await expectedFile.exists())) {
        await Bun.write(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
        console.log(`Generated ${expectedPath}`);
        return;
      }

      const expected = (await expectedFile.json()) as Record<string, unknown>[][];
      expect(actual).toEqual(expected);
    });
  }
});

// sql.js is the same SQLite engine compiled to WASM, and shares
// `SqliteSqlDialect` with the `sqlite` backend, so it should agree with
// expected.json throughout. It is the playground's SQL backend, and until now
// nothing in `bun test` executed a program on it at all.
describe("examples (sqljs backend)", () => {
  for (const name of getExamples()) {
    const expectedPath = join(EXAMPLES_DIR, name, "expected.json");

    // `native-only` examples are rejected by every SQL backend.
    const knownFailure = SQLJS_KNOWN_FAILURES.get(name);
    const sqljsTest = isNativeOnly(name) ? test.skip : knownFailure ? test.failing : test;
    sqljsTest(knownFailure ? `${name} (${knownFailure})` : name, async () => {
      const expectedFile = Bun.file(expectedPath);
      // sqlite seeds expected.json; skip until it has. A `test.failing` entry
      // must not take this branch: returning without throwing counts as an
      // unexpected pass.
      if (!(await expectedFile.exists())) return;

      const actual = await runExample(name, createSqljs);
      const expected = (await expectedFile.json()) as Record<string, unknown>[][];
      expect(sortResults(actual)).toEqual(sortResults(expected));
    });
  }
});

describe("examples (native backend)", () => {
  for (const name of getExamples()) {
    const expectedPath = join(EXAMPLES_DIR, name, "expected.json");

    test(name, async () => {
      const expectedFile = Bun.file(expectedPath);
      if (!(await expectedFile.exists())) {
        // sqlite is the canonical source for expected.json; if it wasn't
        // generated yet, the sqlite-backend test above will create it and
        // the native test just skips on this run.
        return;
      }

      const actual = await runExample(name, createNative);
      const expected = (await expectedFile.json()) as Record<string, unknown>[][];
      // Compare set-wise: each backend is free to enumerate tuples in any
      // order. Only the SQL backends happen to match expected.json row
      // order because that's how they were generated.
      expect(sortResults(actual)).toEqual(sortResults(expected));
    });
  }
});

describe("examples (seminaive backend)", () => {
  for (const name of getExamples()) {
    const expectedPath = join(EXAMPLES_DIR, name, "expected.json");

    test(name, async () => {
      const expectedFile = Bun.file(expectedPath);
      if (!(await expectedFile.exists())) {
        // For native-only examples (no SQL backend can run them),
        // seminaive is the canonical source for expected.json. For every
        // other example the sqlite block above seeds it; skip here.
        if (isNativeOnly(name)) {
          const actual = await runExample(name, createSeminaive);
          await Bun.write(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
          console.log(`Generated ${expectedPath}`);
        }
        return;
      }

      const actual = await runExample(name, createSeminaive);
      const expected = (await expectedFile.json()) as Record<string, unknown>[][];
      expect(sortResults(actual)).toEqual(sortResults(expected));
    });
  }
});

// Gated on DATABASE_URL because this needs a live Postgres server; the
// devcontainer brings one up via docker-compose. Unlike the other blocks the
// backend is shared and the schema is wiped between examples: Postgres keeps
// tables and views across runs, so `edge` from one example would otherwise
// collide with `edge` from the next. The final wipe leaves the database clean,
// as `backend/postgres/test` does.
describe.skipIf(!process.env.DATABASE_URL)("examples (postgres backend)", () => {
  let backend: Backend;
  // A dedicated connection, not the global `Bun.sql`: `backend/postgres/test`
  // takes the global and closes it, and a closed one cannot be reopened, so
  // sharing it would break whichever suite `bun test` happens to run second.
  let sql: typeof Bun.sql;

  async function resetSchema(): Promise<void> {
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
  }

  beforeAll(async () => {
    sql = new Bun.SQL(process.env.DATABASE_URL);
    backend = await createPostgres(sql);
  });

  afterAll(async () => {
    await resetSchema();
    await backend.close();
  });

  beforeEach(async () => {
    await resetSchema();
  });

  for (const name of getExamples()) {
    const expectedPath = join(EXAMPLES_DIR, name, "expected.json");

    // `native-only` examples are rejected by every SQL backend, Postgres included.
    if (isNativeOnly(name)) {
      test.skip(name, () => {});
      continue;
    }

    const knownFailure = POSTGRES_KNOWN_FAILURES.get(name);
    const runner = knownFailure ? test.failing : test;
    runner(knownFailure ? `${name} (${knownFailure})` : name, async () => {
      const expectedFile = Bun.file(expectedPath);
      // sqlite seeds expected.json. A `test.failing` entry must not take this
      // branch, since returning without throwing counts as an unexpected pass.
      if (!(await expectedFile.exists())) return;

      const actual = await runExampleOn(name, backend);
      const expected = (await expectedFile.json()) as Record<string, unknown>[][];
      expect(sortResults(actual)).toEqual(sortResults(expected));
    });
  }
});
