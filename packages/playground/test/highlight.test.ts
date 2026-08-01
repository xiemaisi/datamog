import { describe, expect, test } from "bun:test";
import { StringStream } from "@codemirror/language";
import { datamogToken } from "../src/lib/highlight.ts";

function tokensFor(input: string): { text: string; tag: string | null }[] {
  // Drive `datamogToken` exactly as CodeMirror's StreamLanguage would
  // at runtime — share a single StringStream, repeatedly advance it,
  // and record what the tokenizer returned for each consumed slice.
  const stream = new StringStream(input, 2, 4);
  const out: { text: string; tag: string | null }[] = [];
  while (!stream.eol()) {
    const start = stream.pos;
    const tag = datamogToken(stream);
    if (stream.pos === start) {
      // Tokenizer didn't advance — guard against infinite loop in tests.
      stream.pos++;
    }
    out.push({ text: input.slice(start, stream.pos), tag });
  }
  return out;
}

describe("playground highlight", () => {
  test("Regression: object-literal braces tokenise as punctuation, not as 'anything else'", () => {
    // The ObjectLiteral feature added `{` and `}` to the grammar
    // (commit 30c0d00), but the highlighter's punctuation regex
    // only covered `()`, `[]`, `.,:`. The braces fell through to
    // the "anything else" tail (`stream.next(); return null`),
    // which means CodeMirror's bracket-matching plugin couldn't
    // pair them and the user-visible styling was inconsistent
    // with the parens / brackets the user sees right next to them.
    const tokens = tokensFor('r(J) :- J = {"a": 1, "b": [1, 2]}.');
    const punctTexts = tokens.filter((t) => t.tag === "punctuation").map((t) => t.text);
    expect(punctTexts).toContain("{");
    expect(punctTexts).toContain("}");
    expect(punctTexts).toContain("[");
    expect(punctTexts).toContain("]");
    expect(punctTexts).toContain("(");
    expect(punctTexts).toContain(")");
  });

  test("# starts a line comment (not %)", () => {
    const tokens = tokensFor("# this is a comment");
    expect(tokens).toEqual([{ text: "# this is a comment", tag: "lineComment" }]);
  });

  test("% inside a rule body tokenises as operator (modulo)", () => {
    const tokens = tokensFor("X % 2");
    const operatorTexts = tokens.filter((t) => t.tag === "operator").map((t) => t.text);
    expect(operatorTexts).toContain("%");
  });

  test("Regression: logical and comparison operators tokenise as whole operators", () => {
    const tokens = tokensFor("!A && B || C == D <> E != F <= G >= H");
    const operatorTexts = tokens.filter((t) => t.tag === "operator").map((t) => t.text);
    expect(operatorTexts).toEqual(["!", "&&", "||", "==", "<>", "!=", "<=", ">="]);
  });
});

describe("playground highlight — maximal sigil", () => {
  test("a `^` before an argument list belongs to the predicate name", () => {
    const tokens = tokensFor("bad^(E)");
    expect(tokens[0]).toEqual({ text: "bad^", tag: "name" });
    expect(tokens[1]).toEqual({ text: "(", tag: "punctuation" });
  });

  test("a `^` between expressions is still the XOR operator", () => {
    const tokens = tokensFor("X = a ^ b");
    expect(tokens.find((t) => t.text === "^")).toEqual({ text: "^", tag: "operator" });
    // And the operand before it stays an ordinary name.
    expect(tokens.find((t) => t.text === "a")).toEqual({ text: "a", tag: "name" });
  });
});
