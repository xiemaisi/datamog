import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { create as createNative } from "datamog-backend-native";
import { create as createSeminaive } from "datamog-backend-seminaive";
import { create as createSqlite } from "datamog-backend-sqlite";
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

// Examples that use non-linear recursion can't run on the SQL backends.
// They carry a `native-only` marker file; the sqlite backend is skipped for
// them and the seminaive backend is the canonical source for expected.json.
function isNativeOnly(name: string): boolean {
  return existsSync(join(EXAMPLES_DIR, name, "native-only"));
}

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

  const backend = await createBackend();
  const executor = new DatamogExecutor(backend, [
    new CsvLoader({ directory: dir }),
    new JsonLoader({ directory: dir }),
    new JsonlLoader({ directory: dir }),
    new MermaidLoader({ directory: dir }),
  ]);

  try {
    const results = await executor.executeAnalyzed(program);
    return results.map((r) => r.rows);
  } finally {
    await backend.close();
  }
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

    // Non-linear-recursion examples are rejected by sqlite; seminaive seeds
    // their expected.json instead (see the seminaive block below).
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
        // For native-only examples (non-linear recursion, no SQL backend),
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
