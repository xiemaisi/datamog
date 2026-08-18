import { describe, expect, test } from "bun:test";
import { mermaidEscape, rowsToMermaid } from "../src/mermaid-output.ts";

describe("mermaidEscape", () => {
  test("safe identifiers pass through unchanged", () => {
    expect(mermaidEscape("alice")).toBe("alice");
    expect(mermaidEscape("alice_bob")).toBe("alice_bob");
    expect(mermaidEscape("a1.b-2_c")).toBe("a1.b-2_c");
  });

  test("strings with spaces or punctuation get a sanitised id + quoted label", () => {
    expect(mermaidEscape("hello world")).toBe('hello_world["hello world"]');
    expect(mermaidEscape("a/b")).toBe('a_b["a/b"]');
  });

  test("double quotes inside the label are escaped to Mermaid's #quot;", () => {
    // A literal `"` inside the bracketed label would terminate it
    // prematurely; Mermaid's HTML-entity escape keeps the label intact.
    expect(mermaidEscape('say "hi"')).toBe('say__hi_["say #quot;hi#quot;"]');
  });

  test("Regression: newlines inside node labels cannot split graph statements", () => {
    // Node labels are embedded in a single line as `id["label"]`.
    // A raw newline in the label splits the `graph TD` statement and
    // leaves the second half as malformed Mermaid.
    expect(mermaidEscape("line1\nline2")).toBe('line1_line2["line1 line2"]');
  });

  test("the empty string falls back to the 'n' id (safe-id replacement is empty)", () => {
    // Without a fallback the safe-id portion would be empty, producing
    // invalid mermaid like `[""] --> ...`. Non-empty all-special inputs
    // (e.g. `"!!"`) replace each char with `_` and don't hit the fallback.
    expect(mermaidEscape("")).toBe('n[""]');
    expect(mermaidEscape("!!")).toBe('__["!!"]');
  });

  test("identifiers must start with `\\w` — leading dot or hyphen triggers the escape", () => {
    // `[\w][\w.-]*` requires the first char to be alphanumeric/underscore;
    // `.foo` fails the regex and goes through the escape branch.
    expect(mermaidEscape(".foo")).toBe('_foo[".foo"]');
    expect(mermaidEscape("-bar")).toBe('_bar["-bar"]');
  });

  test("Regression: reserved keyword `end` can't be a bare node id", () => {
    // `end` is otherwise a perfectly safe id, but Mermaid's flowchart
    // lexer reserves it (it terminates a `subgraph`), so `b4 --> end`
    // is a parse error. Route it through the quoted-label path with a
    // `_`-suffixed id so the rendered node still reads `end`. Matched
    // case-insensitively, and `subgraph`/`graph`/`flowchart` likewise.
    expect(mermaidEscape("end")).toBe('end_["end"]');
    expect(mermaidEscape("END")).toBe('END_["END"]');
    expect(mermaidEscape("subgraph")).toBe('subgraph_["subgraph"]');
    // Non-reserved ids that merely contain a keyword are untouched.
    expect(mermaidEscape("ending")).toBe("ending");
    expect(mermaidEscape("end_node")).toBe("end_node");
  });
});

describe("rowsToMermaid", () => {
  test("empty rows emit a bare graph TD so renderers don't choke", () => {
    expect(rowsToMermaid([])).toBe("graph TD\n");
  });

  test("two-column rows render as plain edges", () => {
    expect(
      rowsToMermaid([
        { src: "a", dst: "b" },
        { src: "b", dst: "c" },
      ]),
    ).toBe("graph TD\n    a --> b\n    b --> c");
  });

  test("three-column rows render the third column as an inline label", () => {
    expect(
      rowsToMermaid([
        { from: "a", to: "b", weight: "10" },
        { from: "b", to: "c", weight: "20" },
      ]),
    ).toBe("graph TD\n    a -- 10 --> b\n    b -- 20 --> c");
  });

  test("pipe characters in labels are stripped (Mermaid reserves `|`)", () => {
    // `--|x|y|-->` would terminate the pipe-form label; collapse to
    // spaces so the label stays inline-form (`-- label -->`) and survives.
    expect(rowsToMermaid([{ src: "a", dst: "b", label: "x|y" }])).toBe(
      "graph TD\n    a -- x y --> b",
    );
  });

  test("Regression: edge-label separators cannot become extra graph syntax", () => {
    // Inline Mermaid edge labels sit between the leading `--` and the
    // closing arrow. If query data contains its own arrow or semicolon,
    // emitting it verbatim can close the label early and turn the
    // remainder into another edge or statement.
    expect(rowsToMermaid([{ src: "a", dst: "b", label: "x --> y; z --- q" }])).toBe(
      "graph TD\n    a -- x   y  z   q --> b",
    );
  });

  test("a null cell renders as `null`, distinct from the empty string", () => {
    // The old reading was "projected as NULL, e.g. a JSON `as_*` that matched
    // nothing", rendered `""` so the user could notice the broken edge. That
    // scenario cannot arise: a failed `as_*` has no value, so the row is withheld
    // and never reaches output. A `null` in a cell is now the `null` *value*, and
    // rendering it as `""` collapsed it onto the empty string — both sanitised to
    // the fallback id `n`, so these two rows drew one node and the graph asserted
    // an edge that does not exist.
    expect(rowsToMermaid([{ src: "a", dst: null }])).toBe("graph TD\n    a --> null");
    expect(rowsToMermaid([{ src: "a", dst: "" }])).toBe('graph TD\n    a --> n[""]');
    expect(
      rowsToMermaid([
        { src: "x", dst: null },
        { src: "y", dst: "" },
      ]),
    ).toBe('graph TD\n    x --> null\n    y --> n[""]');
  });

  test("Regression: value-typed columns render as JSON text, not '[object Object]'", () => {
    // The function used `String(row[k] ?? "")` to extract source /
    // target / label cells. For value-typed columns the row carries a
    // parsed JS object — `String({a: 1})` produces the literal
    // `"[object Object]"`, collapsing every distinct `value` to
    // the same node id and rendering a meaningless graph. Same
    // shape as the CLI CSV-output fix in commit 06f116a: stringify
    // compound values as JSON before handing them to `mermaidEscape`.
    expect(
      rowsToMermaid([
        { src: { id: 1 }, dst: { id: 2 } },
        { src: [1, 2], dst: { x: "y" } },
      ]),
    ).toBe(
      "graph TD\n" +
        '    __id__1_["{#quot;id#quot;:1}"] --> __id__2_["{#quot;id#quot;:2}"]\n' +
        '    _1_2_["[1,2]"] --> __x___y__["{#quot;x#quot;:#quot;y#quot;}"]',
    );
  });

  test("special chars in source/target are escaped via mermaidEscape", () => {
    expect(rowsToMermaid([{ src: "alice doe", dst: "bob" }])).toBe(
      'graph TD\n    alice_doe["alice doe"] --> bob',
    );
  });

  test("Regression: BigInt cells in source/target/label survive without crashing", () => {
    // The Postgres backend (via `Bun.sql`) preserves BIGINT columns as
    // JS `BigInt` rather than coercing to lossy `Number`. The rendering
    // path used bare `JSON.stringify(value)` which throws outright on
    // BigInt — `JSON.stringify cannot serialize BigInt` — so a query
    // whose graph nodes carry BIGINT identifiers would tear down the
    // whole `--output-format mermaid` flow. Same shape as
    // `formatCellAsString` in the CLI, which already routes through
    // `bigintSafeReplacer` (see `cli/src/output.ts`).
    expect(
      rowsToMermaid([{ src: { id: 9007199254740990n }, dst: { id: 9007199254740993n } }]),
    ).toBe(
      "graph TD\n" +
        '    __id__9007199254740990_["{#quot;id#quot;:9007199254740990}"]' +
        ' --> __id___9007199254740993__["{#quot;id#quot;:#quot;9007199254740993#quot;}"]',
    );
  });

  test("an empty third-column value falls back to a plain `-->` arrow", () => {
    // The label-presence check is a JS truthy test; an empty string is
    // falsy and produces the unlabelled arrow.
    expect(rowsToMermaid([{ src: "a", dst: "b", label: "" }])).toBe("graph TD\n    a --> b");
  });

  test("Regression: newline in an edge label can't break the line-based graph TD syntax", () => {
    // `graph TD` is line-based: each edge sits on its own line. A
    // label produced from query data that happens to contain `\n`
    // (e.g. a CSV row whose label column embeds a newline, or a
    // multi-line description from a json field) used to be inlined
    // verbatim into `-- ${label} -->`, splitting the edge over two
    // lines and turning the second half into a malformed graph
    // statement. Collapsing CR/LF to spaces alongside the existing
    // pipe-strip keeps the edge on one line.
    const out = rowsToMermaid([{ src: "a", dst: "b", label: "line1\nline2" }]);
    // The whole edge must sit on a single rendered line.
    expect(out.split("\n")).toEqual(["graph TD", "    a -- line1 line2 --> b"]);
    // CR also handled — Windows-style line endings show up in the wild.
    const out2 = rowsToMermaid([{ src: "a", dst: "b", label: "x\r\ny" }]);
    expect(out2.split("\n")).toEqual(["graph TD", "    a -- x  y --> b"]);
  });
});
