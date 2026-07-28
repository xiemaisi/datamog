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
// `output`, `error`, `predicate`, `from`, and `as` are *contextual* keywords:
// they lead the `input predicate` / `output predicate` / `error predicate`
// declaration and `:=` binding forms but are otherwise ordinary identifiers (the
// grammar's `Identifier` rule accepts them), so a program may still name a
// predicate/column/variable after them. The rest (`not`, `in`, `true`, `false`,
// `null`) are fully reserved. Both sets are highlighted; this list is not used
// to reject identifiers.
export const RESERVED_KEYWORDS = [
  "input",
  "output",
  "error",
  "predicate",
  "from",
  "as",
  "not",
  "in",
  "true",
  "false",
  "null",
] as const;

/** Built-in primitive types declarable on input-predicate columns. */
export const BUILTIN_TYPE_NAMES = ["string", "integer", "float", "boolean", "value"] as const;
