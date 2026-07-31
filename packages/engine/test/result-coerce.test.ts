import { describe, expect, test } from "bun:test";
import { coerceNumericColumns } from "../src/result-coerce.ts";

// The Postgres backend is the only one that returns numbers as strings, so
// without DATABASE_URL nothing else exercises the conversion: on every other
// backend it is a no-op. These tests stand in for that.
describe("coerceNumericColumns", () => {
  test("converts string values at integer and float columns", () => {
    const rows = [{ n: "4", x: "2.5" }];
    expect(coerceNumericColumns(rows, { n: "integer", x: "float" })).toEqual([{ n: 4, x: 2.5 }]);
  });

  test("leaves values that are already numbers alone", () => {
    const rows = [{ n: 4 }];
    expect(coerceNumericColumns(rows, { n: "integer" })).toEqual([{ n: 4 }]);
  });

  test("ignores columns of other declared types", () => {
    const rows = [{ s: "4", b: "true", v: "[1,2]" }];
    expect(coerceNumericColumns(rows, { s: "string", b: "boolean", v: "value" })).toEqual([
      { s: "4", b: "true", v: "[1,2]" },
    ]);
  });

  test("leaves NULL as null rather than converting to 0", () => {
    const rows = [{ n: null }];
    expect(coerceNumericColumns(rows, { n: "integer" })).toEqual([{ n: null }]);
  });

  test("leaves an unparseable or empty string alone rather than yielding NaN", () => {
    const rows = [{ n: "" }, { n: "   " }, { n: "not a number" }, { n: "Infinity" }];
    expect(coerceNumericColumns(rows, { n: "integer" })).toEqual([
      { n: "" },
      { n: "   " },
      { n: "not a number" },
      { n: "Infinity" },
    ]);
  });

  test("returns the rows untouched when no column is numeric", () => {
    const rows = [{ s: "4" }];
    expect(coerceNumericColumns(rows, { s: "string" })).toBe(rows);
  });

  test("converts a negative value and one beyond the safe integer range", () => {
    const rows = [{ n: "-3" }, { n: "9007199254740993" }];
    // The large one rounds: one result shape across backends costs exactness
    // above Number.MAX_SAFE_INTEGER, which is documented on the function.
    expect(coerceNumericColumns(rows, { n: "integer" })).toEqual([
      { n: -3 },
      { n: 9007199254740992 },
    ]);
  });
});
