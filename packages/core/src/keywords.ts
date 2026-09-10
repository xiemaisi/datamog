// Single source of truth for the lexical surface of Datamog. The Langium
// grammar (`packages/parser/src/datamog.langium`) is authoritative; these
// arrays mirror it so the editor highlighters and any other consumers
// don't drift independently.
//
// Update both this file and the grammar together when adding a new
// keyword or type — the editor highlighter (CodeMirror StreamLanguage in
// the playground, TextMate grammar in the VS Code extension) consumes
// these lists.

// Lexical keywords, for editor highlighting and keyword completion. `input`,
// `output`, `error`, `predicate`, `from`, `as`, and `type` are *contextual* keywords:
// they lead the `input predicate` / `output predicate` / `error predicate`
// declaration and `:=` binding forms but are otherwise ordinary identifiers (the
// grammar's `Identifier` rule accepts them), so a program may still name a
// predicate/column/variable after them. The rest (`not`, `in`, `true`, `false`,
// `null`) are fully reserved. Both sets are highlighted; this list is not used
// to reject identifiers. The conditional `c ? a : b` needs no keyword, so it
// adds nothing here.
export const RESERVED_KEYWORDS = [
  "input",
  "output",
  "error",
  "predicate",
  "from",
  "as",
  "type",
  "not",
  "in",
  "true",
  "false",
  "null",
] as const;

/**
 * Built-in primitive types declarable on input-predicate columns.
 *
 * The grammar also accepts `null` here, since it is a type like any other and the
 * generated union has to contain it, but it is deliberately not offered: a
 * `null`-declared column can hold nothing but a null, and only with a `?` at that,
 * so suggesting it would be suggesting a mistake. `null` is highlighted anyway,
 * being a reserved keyword above.
 */
export const BUILTIN_TYPE_NAMES = ["string", "integer", "float", "boolean", "value"] as const;
