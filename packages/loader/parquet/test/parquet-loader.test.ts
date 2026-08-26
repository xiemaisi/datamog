import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtDecl } from "datamog-core";
import { parse } from "datamog-parser";
import type { ColumnSource, SchemaElement } from "hyparquet-writer";
import { parquetWriteBuffer } from "hyparquet-writer";
import { ParquetLoader } from "../src/parquet-loader.ts";

function getExtDecl(source: string): ExtDecl {
  const program = parse(source);
  return program.statements[0] as ExtDecl;
}

describe("ParquetLoader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "datamog-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  /** Write `<predicate>.parquet` into the temp dir. Snappy-compressed, the
   *  writer's default and what pyarrow / DuckDB / Spark emit by default. */
  async function writeParquet(
    predicate: string,
    columnData: ColumnSource[],
    schema?: SchemaElement[],
  ): Promise<void> {
    await Bun.write(
      join(tempDir, `${predicate}.parquet`),
      parquetWriteBuffer({ columnData, schema }),
    );
  }

  test("canLoad returns true when file exists", async () => {
    await writeParquet("parent", [
      { name: "name", data: ["alice"], type: "STRING" },
      { name: "child", data: ["bob"], type: "STRING" },
    ]);
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(await loader.canLoad(decl)).toBe(true);
  });

  test("canLoad returns false when file does not exist", async () => {
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(await loader.canLoad(decl)).toBe(false);
  });

  test("reads rows with each primitive type", async () => {
    await writeParquet("t", [
      { name: "a", data: ["hello", "world"], type: "STRING" },
      { name: "b", data: [42n, -7n], type: "INT64" },
      { name: "c", data: [1, 2], type: "INT32" },
      { name: "d", data: [3.14, 2.5], type: "DOUBLE" },
      { name: "e", data: [true, false], type: "BOOLEAN" },
    ]);
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl(
      "input predicate t(a: string, b: integer, c: integer, d: float, e: boolean).",
    );
    expect(await loader.readRows(decl)).toEqual([
      { a: "hello", b: 42, c: 1, d: 3.14, e: true },
      { a: "world", b: -7, c: 2, d: 2.5, e: false },
    ]);
  });

  test("decodes only the declared columns", async () => {
    await writeParquet("t", [
      { name: "keep", data: ["x"], type: "STRING" },
      { name: "ignored", data: [1n], type: "INT64" },
    ]);
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(keep: string).");
    expect(await loader.readRows(decl)).toEqual([{ keep: "x" }]);
  });

  test("rejects a declared column the file lacks, naming the file", async () => {
    await writeParquet("t", [{ name: "a", data: ["x"], type: "STRING" }]);
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(a: string, missing: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/t\.parquet.*column not found: missing/);
  });

  test("nullable columns accept a null, non-nullable ones reject it", async () => {
    await writeParquet("t", [
      { name: "name", data: ["alice", "bob"], type: "STRING" },
      { name: "score", data: [7n, null], type: "INT64", nullable: true },
    ]);
    const loader = new ParquetLoader({ directory: tempDir });
    expect(
      await loader.readRows(getExtDecl("input predicate t(name: string, score: integer?).")),
    ).toEqual([
      { name: "alice", score: 7 },
      { name: "bob", score: null },
    ]);
    expect(
      loader.readRows(getExtDecl("input predicate t(name: string, score: integer).")),
    ).rejects.toThrow(/row 2, column 'score'/);
  });

  test("rejects an INT64 outside the safe integer range", async () => {
    await writeParquet("t", [{ name: "n", data: [2n ** 60n], type: "INT64" }]);
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(n: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(
      /Integer 1152921504606846976 is outside the safe integer range/,
    );
  });

  test("loads a timestamp as its ISO 8601 text", async () => {
    await writeParquet("t", [{ name: "at", data: [1700000000000n], type: "TIMESTAMP" }]);
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(at: string).");
    expect(await loader.readRows(decl)).toEqual([{ at: "2023-11-14T22:13:20.000Z" }]);
  });

  test("loads a nested list into a value column, converting its int64s", async () => {
    await writeParquet(
      "t",
      [{ name: "xs", data: [[1n, 2n], [3n]] }],
      [
        { name: "root", num_children: 1 },
        { name: "xs", repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
        { name: "list", repetition_type: "REPEATED", num_children: 1 },
        { name: "element", repetition_type: "OPTIONAL", type: "INT64" },
      ],
    );
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(xs: value).");
    expect(await loader.readRows(decl)).toEqual([{ xs: [1, 2] }, { xs: [3] }]);
  });

  test("rejects raw binary column data", async () => {
    await writeParquet(
      "t",
      [{ name: "b", data: [new Uint8Array([1, 2, 3])] }],
      [
        { name: "root", num_children: 1 },
        { name: "b", repetition_type: "OPTIONAL", type: "FIXED_LEN_BYTE_ARRAY", type_length: 3 },
      ],
    );
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(b: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/Unsupported binary column data/);
  });

  test("reports a file that is not Parquet, naming it", async () => {
    await Bun.write(join(tempDir, "t.parquet"), "not parquet at all");
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(a: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/t\.parquet.*PAR1/);
  });

  test("reads an empty file as no rows", async () => {
    await writeParquet("t", [{ name: "a", data: [], type: "STRING" }]);
    const loader = new ParquetLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(a: string).");
    expect(await loader.readRows(decl)).toEqual([]);
  });
});
