import { describe, expect, test } from "bun:test";
import { formatCell } from "../src/lib/format-cell.ts";

describe("formatCell", () => {
  test("Regression: value columns render as JSON text, not '[object Object]'", () => {
    // The playground's `ResultsPanel` (`results-panel.tsx`) and the
    // step-debugger's `formatValue` (`step-panel.tsx`) used a bare
    // `String(val)` to render result-row cells. For a value-typed
    // column the row carries a parsed JS object, and
    // `String({port: 8080})` produces the literal string
    // `"[object Object]"` — collapsing every distinct `value` to
    // the same display and making the table useless. Same shape as
    // the CLI CSV / Mermaid fixes (commits 06f116a, 0aa672a):
    // stringify compound values as JSON.
    expect(formatCell({ port: 8080 })).toBe('{"port":8080}');
    expect(formatCell([1, 2, 3])).toBe("[1,2,3]");
  });

  test("Regression: BigInt cells survive without crashing", () => {
    // The Postgres backend via `Bun.sql` keeps BIGINT columns as JS
    // `BigInt`. `JSON.stringify` throws `cannot serialize BigInt`
    // outright, so a query whose result row contains a BIGINT cell
    // would tear down the playground render. The CLI's
    // `formatCellAsString` already handles this via
    // `bigintSafeReplacer` (`cli/src/output.ts`); the playground
    // helper had drifted.
    expect(formatCell({ id: 9007199254740990n })).toBe('{"id":9007199254740990}');
    expect(formatCell({ id: 9007199254740993n })).toBe('{"id":"9007199254740993"}');
    expect(formatCell([9007199254740990n, "x"])).toBe('[9007199254740990,"x"]');
  });

  test("proof-term cells render in constructor form", () => {
    // A named rule produces `{"$proof": Ctor, "args": [...]}` value
    // cells; the table should show `Ctor(...)` like the CLI, not raw
    // JSON. Ordinary value data keeps its JSON rendering (above).
    expect(formatCell({ $proof: "Nil", args: [] })).toBe("Nil()");
    expect(
      formatCell({
        $proof: "Cons",
        args: [1, { $proof: "Cons", args: [2, { $proof: "Nil", args: [] }] }],
      }),
    ).toBe("Cons(1, Cons(2, Nil()))");
  });

  test("primitives pass through unchanged", () => {
    expect(formatCell("hello")).toBe("hello");
    expect(formatCell(42)).toBe("42");
    expect(formatCell(true)).toBe("true");
    expect(formatCell(undefined)).toBe("");
  });

  test("a null renders as `null`, distinct from the empty string", () => {
    // `null` is an ordinary value with a name, and this is the surface where
    // telling it from `""` matters most: the CLI's table shows `null` via
    // `console.table`, so a blank here made the playground and the walkthrough
    // disagree about the same program.
    expect(formatCell(null)).toBe("null");
    expect(formatCell("")).toBe("");
  });
});
