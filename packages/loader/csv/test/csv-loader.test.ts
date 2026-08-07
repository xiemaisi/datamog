import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtDecl } from "datamog-core";
import { parse } from "datamog-parser";
import { CsvLoader } from "../src/csv-loader.ts";
import { csvRowsFromKeyed } from "../src/parse-content.ts";

function getExtDecl(source: string): ExtDecl {
  const program = parse(source);
  return program.statements[0] as ExtDecl;
}

describe("CsvLoader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "datamog-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("canLoad returns true when file exists", async () => {
    await Bun.write(join(tempDir, "parent.csv"), "name,child\nalice,bob\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(await loader.canLoad(decl)).toBe(true);
  });

  test("canLoad returns false when file does not exist", async () => {
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(await loader.canLoad(decl)).toBe(false);
  });

  test("parseCsv parses simple CSV", async () => {
    await Bun.write(join(tempDir, "parent.csv"), "name,child\nalice,bob\ncarol,dave\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([
      { name: "alice", child: "bob" },
      { name: "carol", child: "dave" },
    ]);
  });

  test("Regression: headered CSV maps columns by header name, not by position", async () => {
    // Headered CSV is the named-column mode. The loader used to discard the
    // header and coerce rows positionally, so a valid reordered export silently
    // swapped `name` and `child`.
    await Bun.write(join(tempDir, "parent.csv"), "child,name\nbob,alice\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ name: "alice", child: "bob" }]);
  });

  test("headered CSV ignores extra columns", async () => {
    await Bun.write(join(tempDir, "parent.csv"), "child,unused,name\nbob,ignored,alice\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ name: "alice", child: "bob" }]);
  });

  test("headered CSV rejects a missing declared column", async () => {
    await Bun.write(join(tempDir, "parent.csv"), "name\nalice\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/missing field 'child'/);
  });

  test("Regression: csvRowsFromKeyed flags a column named like an Object.prototype member as missing", () => {
    // The presence check was `col.name in records[0]`, which walks the
    // prototype chain. csv-parse (`columns: true`) and the manual
    // `out: Record<string,string> = {}` records built by the gsheet and
    // vscode disk loaders are all backed by `Object.prototype`, so a
    // declared column named `toString` / `valueOf` / `constructor`
    // matched the inherited member even when the record lacked the key.
    // The missing-field error was bypassed and the column was silently
    // dropped from the output row (its value was the inherited function,
    // which `JSON.stringify` omits) — wrong data with no diagnostic. The
    // gsheet and vscode disk loaders don't pre-guard headers with
    // `includes`, so they relied on this shared primitive being correct.
    const decl = getExtDecl("input predicate t(toString: string, x: integer).");
    expect(() => csvRowsFromKeyed([{ x: "1" }], decl, { source: "t.csv" })).toThrow(
      /missing field 'toString'/,
    );
  });

  test("Regression: headered CSV rejects duplicate columns", async () => {
    // Headered CSV is name-keyed. A duplicate header used to pass the
    // presence check and then silently let the later duplicate overwrite the
    // earlier cell for that name.
    await Bun.write(join(tempDir, "parent.csv"), "name,name,child\nalice,eve,bob\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/duplicate field 'name'/);
  });

  test("parseCsv handles quoted fields with commas", async () => {
    await Bun.write(join(tempDir, "data.csv"), 'a,b\n"hello, world",42\n');
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate data(a: string, b: integer).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ a: "hello, world", b: 42 }]);
  });

  test("parseCsv handles quoted fields with escaped quotes", async () => {
    await Bun.write(join(tempDir, "data.csv"), 'a\n"say ""hi"""\n');
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate data(a: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ a: 'say "hi"' }]);
  });

  test("coerces types based on ext declaration", async () => {
    await Bun.write(join(tempDir, "t.csv"), "a,b,c,d\nhello,42,3.14,true\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(a: string, b: integer, c: float, d: boolean).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ a: "hello", b: 42, c: 3.14, d: true }]);
  });

  test("nullable columns accept empty CSV cells as null", async () => {
    await Bun.write(join(tempDir, "t.csv"), "name,score,active\nalice,,\nbob,7,true\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(name: string, score: integer?, active: boolean?).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([
      { name: "alice", score: null, active: null },
      { name: "bob", score: 7, active: true },
    ]);
  });

  test("boolean coercion accepts various values", async () => {
    await Bun.write(join(tempDir, "t.csv"), "x\ntrue\nfalse\n1\n0\nyes\nno\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(x: boolean).");
    const rows = await loader.readRows(decl);
    expect(rows.map((r) => r.x)).toEqual([true, false, true, false, true, false]);
  });

  test("boolean coercion tolerates surrounding whitespace", async () => {
    // The integer/float cases trim; boolean used to reject any whitespace,
    // which was inconsistent and rejected whitespace-padded CSV fields.
    await Bun.write(join(tempDir, "t.csv"), "x\n true\n\tyes\n false \n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(x: boolean).");
    const rows = await loader.readRows(decl);
    expect(rows.map((r) => r.x)).toEqual([true, true, false]);
  });

  test("CSV without header row", async () => {
    await Bun.write(join(tempDir, "parent.csv"), "alice,bob\ncarol,dave\n");
    const loader = new CsvLoader({ directory: tempDir, hasHeader: false });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([
      { name: "alice", child: "bob" },
      { name: "carol", child: "dave" },
    ]);
  });

  test("custom delimiter", async () => {
    await Bun.write(join(tempDir, "parent.csv"), "name\tchild\nalice\tbob\n");
    const loader = new CsvLoader({ directory: tempDir, delimiter: "\t" });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ name: "alice", child: "bob" }]);
  });

  test("skips empty trailing lines", async () => {
    await Bun.write(join(tempDir, "parent.csv"), "name,child\nalice,bob\n\n\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toHaveLength(1);
  });

  test("rejects rows with wrong number of fields", async () => {
    await Bun.write(join(tempDir, "parent.csv"), "name,child\nalice\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/expected 2 fields but got 1/);
  });

  test("rejects invalid integer value", async () => {
    await Bun.write(join(tempDir, "t.csv"), "val\nhello\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/Invalid integer/);
  });

  test("error line number reflects the source file, not the post-skip index", async () => {
    // Regression: csv-parse skips empty lines internally, but the
    // loader numbered records by their post-skip index. So a parse
    // error on source line 5 (after two blank lines and a header)
    // was reported as `line 3`. The fix uses csv-parse's `info: true`
    // option so each record carries its source line number directly.
    //
    // File layout:
    //   line 1: val          (header)
    //   line 2: 1
    //   line 3: (blank)
    //   line 4: (blank)
    //   line 5: bad
    await Bun.write(join(tempDir, "t.csv"), "val\n1\n\n\nbad\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/line 5/);
  });

  test("rejects invalid float value", async () => {
    await Bun.write(join(tempDir, "t.csv"), "val\nabc\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: float).");
    expect(loader.readRows(decl)).rejects.toThrow(/Invalid float/);
  });

  test("rejects json cells that contain non-finite numbers", async () => {
    // Regression: `coerceValue` for `"value"` columns called
    // `JSON.parse(value)` and returned the parsed value with no
    // post-validation, so a CSV cell like `[1e500]` produced an
    // `[Infinity]` array. `JSON.stringify(Infinity)` renders as
    // `null`, so the canonicalised representation handed to SQL
    // backends collapsed to `[null]` — silent data loss diverging
    // from the native backend, which retained `Infinity`. The
    // sibling `checkValue` path (used for JSONL) already rejects
    // non-finite numbers via the `isJsonValue` walker; align
    // `coerceValue` with the same gate.
    await Bun.write(join(tempDir, "t.csv"), 'val\n"[1e500]"\n');
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: value).");
    expect(loader.readRows(decl)).rejects.toThrow(/Invalid JSON/);
  });

  test("rejects integers that exceed JS's safe-integer window", async () => {
    // Regression: `Number.isInteger` returns true after `Number(...)`
    // silently rounds `"9007199254740993"` (2^53 + 1) down to
    // 9007199254740992, so `coerceValue` accepted the input and the
    // loader stored a value that no longer matches what the user
    // wrote. The native `as_integer.value` builtin already gates on
    // `Number.MAX_SAFE_INTEGER` (values.ts:381); the loader-side
    // validation should match.
    await Bun.write(join(tempDir, "t.csv"), "val\n9007199254740993\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/Invalid integer/);
  });

  test("rejects non-canonical numeric cells", async () => {
    // CSV and Google Sheets use the same canonical spellings as the source
    // language and conversion builtins.
    const loader = new CsvLoader({ directory: tempDir });

    const intDecl = getExtDecl("input predicate i(val: integer).");
    for (const value of ["01", "-0"]) {
      await Bun.write(join(tempDir, "i.csv"), `val\n${value}\n`);
      expect(loader.readRows(intDecl)).rejects.toThrow(/Invalid integer/);
    }

    const floatDecl = getExtDecl("input predicate f(val: float).");
    for (const value of ["01.5", "-0", "1e3"]) {
      await Bun.write(join(tempDir, "f.csv"), `val\n${value}\n`);
      expect(loader.readRows(floatDecl)).rejects.toThrow(/Invalid float/);
    }
  });

  test("accepts integers across the safe-integer range", async () => {
    await Bun.write(join(tempDir, "i.csv"), "val\n1000000000\n9007199254740991\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate i(val: integer).");
    expect(await loader.readRows(decl)).toEqual([
      { val: 1_000_000_000 },
      { val: Number.MAX_SAFE_INTEGER },
    ]);
  });

  test("rejects '3.5' as an integer instead of silently truncating", async () => {
    await Bun.write(join(tempDir, "t.csv"), "val\n3.5\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/Invalid integer/);
  });

  test("rejects '3abc' as an integer instead of silently truncating", async () => {
    await Bun.write(join(tempDir, "t.csv"), "val\n3abc\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/Invalid integer/);
  });

  test("rejects '3abc' as a float instead of silently truncating", async () => {
    await Bun.write(join(tempDir, "t.csv"), "val\n3abc\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: float).");
    expect(loader.readRows(decl)).rejects.toThrow(/Invalid float/);
  });

  test("rejects unrecognised boolean value instead of silently coercing to false", async () => {
    await Bun.write(join(tempDir, "t.csv"), "x\nmaybe\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(x: boolean).");
    expect(loader.readRows(decl)).rejects.toThrow(/Invalid boolean/);
  });

  test("preserves trailing empty field after a trailing delimiter", async () => {
    await Bun.write(join(tempDir, "t.csv"), "a,b,c\nx,y,\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(a: string, b: string, c: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ a: "x", b: "y", c: "" }]);
  });

  test("load calls sql with correct inserts", async () => {
    await Bun.write(join(tempDir, "parent.csv"), "name,child\nalice,bob\n");
    const loader = new CsvLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");

    const insertedQueries: { query: string; params: unknown[] }[] = [];
    const mockBackend = {
      dialect: "sqlite" as const,
      async execute(query: string, params?: unknown[]) {
        insertedQueries.push({ query, params: params ?? [] });
        return [];
      },
      close() {},
    };

    const result = await loader.load(decl, mockBackend);
    expect(result.rowsLoaded).toBe(1);
    expect(insertedQueries).toHaveLength(1);
    expect(insertedQueries[0]?.query).toContain("INSERT INTO");
    expect(insertedQueries[0]?.params).toEqual(["alice", "bob"]);
  });
});
