import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtDecl } from "datamog-core";
import { parse } from "datamog-parser";
import { JsonlLoader } from "../src/jsonl-loader.ts";
import { parseJsonlContent } from "../src/parse-content.ts";

function getExtDecl(source: string): ExtDecl {
  const program = parse(source);
  return program.statements[0] as ExtDecl;
}

describe("JsonlLoader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "datamog-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("canLoad returns true when file exists", async () => {
    await Bun.write(join(tempDir, "parent.jsonl"), '{"name":"alice","child":"bob"}\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(await loader.canLoad(decl)).toBe(true);
  });

  test("canLoad returns false when file does not exist", async () => {
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(await loader.canLoad(decl)).toBe(false);
  });

  test("reads rows from JSONL", async () => {
    await Bun.write(
      join(tempDir, "parent.jsonl"),
      '{"name":"alice","child":"bob"}\n{"name":"carol","child":"dave"}\n',
    );
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([
      { name: "alice", child: "bob" },
      { name: "carol", child: "dave" },
    ]);
  });

  test("single value column consumes each JSON line as the column value", async () => {
    await Bun.write(join(tempDir, "event.jsonl"), '{"a":1}\n[1,2]\n"text"\n42\ntrue\nnull\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate event(payload: value).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([
      { payload: { a: 1 } },
      { payload: [1, 2] },
      { payload: "text" },
      { payload: 42 },
      { payload: true },
      { payload: null },
    ]);
  });

  test("validates native JSON types", async () => {
    await Bun.write(join(tempDir, "t.jsonl"), '{"a":"hello","b":42,"c":3.14,"d":true}\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(a: string, b: integer, c: float, d: boolean).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ a: "hello", b: 42, c: 3.14, d: true }]);
  });

  test("nullable columns accept JSON null values", async () => {
    await Bun.write(
      join(tempDir, "t.jsonl"),
      '{"name":"alice","score":null}\n{"name":"bob","score":7}\n',
    );
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(name: string, score: integer?).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([
      { name: "alice", score: null },
      { name: "bob", score: 7 },
    ]);
  });

  test("skips empty lines", async () => {
    await Bun.write(join(tempDir, "parent.jsonl"), '{"name":"alice","child":"bob"}\n\n\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toHaveLength(1);
  });

  test("rejects rows with missing fields", async () => {
    await Bun.write(join(tempDir, "parent.jsonl"), '{"name":"alice"}\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/missing field 'child'/);
  });

  test("Regression: a column named like an Object.prototype member is still 'missing'", () => {
    // The presence check was `col.name in parsed`, which walks the
    // prototype chain. `JSON.parse` produces objects backed by
    // `Object.prototype`, so a declared column named `toString` /
    // `valueOf` / `constructor` matched the inherited member even when
    // the data object lacked the key. Instead of a clean "missing field"
    // error the loader then read the inherited function and reported a
    // confusing "got function" type error (and a `__proto__` column would
    // silently bind the prototype object). It must report the field as
    // missing.
    const decl = getExtDecl("input predicate t(toString: value, x: integer).");
    expect(() => parseJsonlContent('{"x": 1}', decl, { source: "t.jsonl" })).toThrow(
      /missing field 'toString'/,
    );
  });

  test("rejects wrong type in JSONL", async () => {
    await Bun.write(join(tempDir, "t.jsonl"), '{"val":"hello"}\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/Expected integer/);
  });

  test("accepts the full safe-integer range", () => {
    const decl = getExtDecl("input predicate t(n: integer).");
    expect(parseJsonlContent('{"n": 3000000000}', decl, { source: "t.jsonl" })).toEqual([
      { n: 3_000_000_000 },
    ]);
    expect(parseJsonlContent('{"n": 9007199254740991}', decl, { source: "t.jsonl" })).toEqual([
      { n: Number.MAX_SAFE_INTEGER },
    ]);
  });

  test("error line number reflects the source file, not the post-filter index", async () => {
    // Regression: blank lines were stripped before line numbering, so
    // a parse/type error on source line 4 was reported as `line 2` if
    // there were two blank lines before it. The fix is to track the
    // 1-based source line number alongside each non-blank line so the
    // error message points at the actual offending line.
    //
    // File layout:
    //   line 1: {"val":1}
    //   line 2: (blank)
    //   line 3: (blank)
    //   line 4: {"val":"bad"}
    await Bun.write(join(tempDir, "t.jsonl"), '{"val":1}\n\n\n{"val":"bad"}\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/line 4/);
  });

  test("Regression: strips a UTF-8 BOM from the start of JSONL content", async () => {
    // Content pasted from Excel / Windows tools often begins with a
    // UTF-8 BOM (U+FEFF). `Bun.file(...).text()` strips it
    // transparently for the file-on-disk loader, but the playground
    // and any caller that hands JSONL text in directly hit
    // `parseJsonlContent` with the BOM intact — and `JSON.parse`
    // rejects U+FEFF as an unexpected token, so the very first line
    // surfaces as a confusing `Unrecognized token '﻿'` error. Strip
    // the BOM in `parseJsonlContent` so the in-memory path matches
    // the file-on-disk path.
    const rows = parseJsonlContent(
      '﻿{"val":1}\n{"val":2}\n',
      getExtDecl("input predicate t(val: integer)."),
    );
    expect(rows).toEqual([{ val: 1 }, { val: 2 }]);
  });

  test("rejects non-finite floats (Infinity / NaN)", async () => {
    // Regression: `checkValue` for `"float"` columns accepted any
    // `typeof === "number"` value, including `Infinity` and `NaN`.
    // `JSON.parse('1e500')` silently returns `Infinity`, so a JSONL
    // file with an out-of-range exponent flowed an `Infinity`
    // straight into the predicate's `float` column and poisoned
    // every downstream arithmetic. The native `as_float.value` builtin
    // already gates on `Number.isFinite` (values.ts:387); the
    // loader-side validation should match.
    await Bun.write(join(tempDir, "t.jsonl"), '{"val":1e500}\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: float).");
    expect(loader.readRows(decl)).rejects.toThrow(/Expected float/);
  });

  test("rejects integers that exceed JS's safe-integer window", async () => {
    // Regression: by the time `checkValue` saw the parsed JSON value,
    // `JSON.parse` had already rounded `9007199254740993` (2^53 + 1)
    // down to 9007199254740992 — `Number.isInteger` then happily
    // accepted the rounded value and the precision loss never
    // surfaced to the user. The native `as_integer.value` builtin
    // already gates on `Number.MAX_SAFE_INTEGER` (values.ts:381);
    // mirror that here so loader-side validation agrees.
    await Bun.write(join(tempDir, "t.jsonl"), '{"val":9007199254740993}\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/Expected integer/);
  });

  test("rejects stringified number in JSONL", async () => {
    await Bun.write(join(tempDir, "t.jsonl"), '{"val":"42"}\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/Expected integer/);
  });

  test("ignores extra keys in JSON objects", async () => {
    await Bun.write(
      join(tempDir, "parent.jsonl"),
      '{"name":"alice","child":"bob","extra":"ignored","score":99}\n',
    );
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ name: "alice", child: "bob" }]);
  });

  test("reads flat array rows from JSONL", async () => {
    await Bun.write(join(tempDir, "parent.jsonl"), '["alice","bob"]\n["carol","dave"]\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([
      { name: "alice", child: "bob" },
      { name: "carol", child: "dave" },
    ]);
  });

  test("validates types in flat array rows", async () => {
    await Bun.write(join(tempDir, "t.jsonl"), '["hello",42,3.14,true]\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(a: string, b: integer, c: float, d: boolean).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([{ a: "hello", b: 42, c: 3.14, d: true }]);
  });

  test("rejects flat array with wrong arity", async () => {
    await Bun.write(join(tempDir, "parent.jsonl"), '["alice"]\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/expected 2 fields but got 1/);
  });

  test("rejects flat array with excess values", async () => {
    await Bun.write(join(tempDir, "parent.jsonl"), '["alice","bob","extra"]\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/expected 2 fields but got 3/);
  });

  test("rejects wrong type in flat array", async () => {
    await Bun.write(join(tempDir, "t.jsonl"), '["hello"]\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/Expected integer/);
  });

  test("supports mixed object and array rows", async () => {
    await Bun.write(
      join(tempDir, "parent.jsonl"),
      '{"name":"alice","child":"bob"}\n["carol","dave"]\n',
    );
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate parent(name: string, child: string).");
    const rows = await loader.readRows(decl);
    expect(rows).toEqual([
      { name: "alice", child: "bob" },
      { name: "carol", child: "dave" },
    ]);
  });

  test("rejects non-object non-array JSON line", async () => {
    await Bun.write(join(tempDir, "t.jsonl"), "42\n");
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(val: integer).");
    expect(loader.readRows(decl)).rejects.toThrow(/expected object or array/);
  });

  test("Regression: malformed JSON on a line carries the file and line number", async () => {
    // The bare `JSON.parse(line)` at parse-content.ts:45 used to
    // surface a context-free `SyntaxError: JSON Parse error: …`,
    // leaving the user to grep for the offending line themselves.
    // The wrapper now re-throws with the same `<source> line N: …`
    // shape every other error in the file uses (missing field,
    // wrong arity, etc.) so a sloppy line surfaces actionable
    // context.
    await Bun.write(join(tempDir, "t.jsonl"), '{"name":"alice"}\n{bad json}\n{"name":"carol"}\n');
    const loader = new JsonlLoader({ directory: tempDir });
    const decl = getExtDecl("input predicate t(name: string).");
    expect(loader.readRows(decl)).rejects.toThrow(/t\.jsonl line 2/);
  });

  test("load calls backend with correct inserts", async () => {
    await Bun.write(join(tempDir, "parent.jsonl"), '{"name":"alice","child":"bob"}\n');
    const loader = new JsonlLoader({ directory: tempDir });
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
