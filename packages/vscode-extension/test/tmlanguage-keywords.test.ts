// The TextMate grammar hard-codes its keyword alternations, so it does not
// pick up `core/src/keywords.ts` the way the playground highlighter does. That
// drift is silent: a keyword added to the lexical surface simply stops being
// coloured in VS Code, with nothing failing. `as` and `from` sat unhighlighted
// for exactly that reason. These tests are the tripwire.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TYPE_NAMES, RESERVED_KEYWORDS } from "datamog-core";

interface TmGrammar {
  repository: Record<string, { match?: string }>;
}

const grammar = JSON.parse(
  readFileSync(join(import.meta.dir, "../syntaxes/datamog.tmLanguage.json"), "utf8"),
) as TmGrammar;

/** The words a `\b(a|b|c)\b`-shaped rule matches. */
function alternatives(rule: string): string[] {
  const match = grammar.repository[rule]?.match;
  if (match === undefined) throw new Error(`No '${rule}' rule in the TextMate grammar`);
  const group = /\\b\(([^)]*)\)\\b/.exec(match);
  if (group === null) throw new Error(`'${rule}' is not a keyword alternation: ${match}`);
  return group[1]!.split("|");
}

describe("TextMate grammar keyword coverage", () => {
  test("every reserved keyword is highlighted", () => {
    const highlighted = new Set([...alternatives("declaration"), ...alternatives("keyword")]);
    const missing = RESERVED_KEYWORDS.filter((k) => !highlighted.has(k));
    expect(missing).toEqual([]);
  });

  test("every built-in type name is highlighted", () => {
    const highlighted = new Set(alternatives("type"));
    const missing = BUILTIN_TYPE_NAMES.filter((t) => !highlighted.has(t));
    expect(missing).toEqual([]);
  });

  test("no alternation lists a word that is no longer a keyword", () => {
    // Catches the other direction: a keyword removed from the language but
    // left behind here, which would colour an ordinary identifier.
    const known = new Set<string>([...RESERVED_KEYWORDS, ...BUILTIN_TYPE_NAMES]);
    const listed = [
      ...alternatives("declaration"),
      ...alternatives("keyword"),
      ...alternatives("type"),
    ];
    expect(listed.filter((w) => !known.has(w))).toEqual([]);
  });
});
