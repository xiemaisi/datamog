import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtDecl } from "datamog-core";
import type { Backend } from "datamog-engine";
import { parse } from "datamog-parser";
import { parquetWriteBuffer } from "hyparquet-writer";
import { DiskLoader } from "../src/disk-loader.ts";

function getExtDecl(source: string): ExtDecl {
  return parse(source).statements[0] as ExtDecl;
}

/** A no-SQL backend that just captures the rows `insertRows` would write. */
function captureBackend(): Backend & { rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  return {
    sqlDialect: null,
    rows,
    async insertRows(_decl, r) {
      rows.push(...r);
    },
    async execute() {
      return [];
    },
    close() {},
  } as Backend & { rows: Record<string, unknown>[] };
}

describe("DiskLoader", () => {
  let dir: string;

  test("Regression: a CSV row with more fields than the header is rejected", async () => {
    // The vscode disk loader built each keyed record with a loop capped at
    // `i < record.length && i < header.length`, so a row with MORE fields
    // than the header silently dropped the extras and was accepted —
    // diverging from the canonical Bun `CsvLoader` and the playground
    // loader, which both throw "expected N fields but got M". A malformed
    // sibling `.csv` (a stray trailing comma / extra column) therefore
    // produced silently-wrong data only in the editor.
    dir = await mkdtemp(join(tmpdir(), "datamog-disk-"));
    try {
      await writeFile(join(dir, "t.csv"), "a,b\n1,2,3\n");
      const loader = new DiskLoader(dir);
      const decl = getExtDecl("input predicate t(a: integer, b: integer).");
      expect(loader.load(decl, captureBackend())).rejects.toThrow(/expected 2 fields but got 3/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("Regression: a header-only CSV missing a declared column is rejected", async () => {
    // The disk loader relied on `csvRowsFromKeyed`'s first-record guard to
    // report a missing declared column, but that guard is skipped when there
    // are no data records. So a header-only CSV whose header lacked a declared
    // column returned [] silently, where the CLI and playground loaders (which
    // pre-check `header.includes(col.name)`) throw "missing field".
    dir = await mkdtemp(join(tmpdir(), "datamog-disk-"));
    try {
      await writeFile(join(dir, "t.csv"), "a,b\n");
      const loader = new DiskLoader(dir);
      const decl = getExtDecl("input predicate t(a: integer, b: integer, c: integer).");
      expect(loader.load(decl, captureBackend())).rejects.toThrow(/missing field 'c'/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("loads a sibling .parquet file", async () => {
    // The binary branch reads with `readFile` and hands hyparquet the
    // `Buffer`'s slice of its pooled allocation; getting that wrong reads
    // someone else's bytes rather than failing loudly.
    dir = await mkdtemp(join(tmpdir(), "datamog-disk-"));
    try {
      await writeFile(
        join(dir, "t.parquet"),
        new Uint8Array(
          parquetWriteBuffer({
            columnData: [
              { name: "a", data: [1n, 2n], type: "INT64" },
              { name: "b", data: ["x", "y"], type: "STRING" },
            ],
          }),
        ),
      );
      const loader = new DiskLoader(dir);
      const decl = getExtDecl("input predicate t(a: integer, b: string).");
      const backend = captureBackend();
      expect(await loader.load(decl, backend)).toEqual({ rowsLoaded: 2 });
      expect(backend.rows).toEqual([
        { a: 1, b: "x" },
        { a: 2, b: "y" },
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
