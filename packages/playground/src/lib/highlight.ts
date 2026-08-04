import { LanguageSupport, StreamLanguage, type StringStream } from "@codemirror/language";
import { BUILTIN_TYPE_NAMES, RESERVED_KEYWORDS } from "datamog-core";

const keywords = new Set<string>(RESERVED_KEYWORDS);
const types = new Set<string>(BUILTIN_TYPE_NAMES);

/**
 * Pure tokenizer extracted so unit tests can drive it with a fresh
 * `StringStream` — keeps the highlighter testable without spinning up
 * a full CodeMirror EditorState.
 */
export function datamogToken(stream: StringStream): string | null {
  // Comments
  if (stream.match("#")) {
    stream.skipToEnd();
    return "lineComment";
  }

  // Whitespace
  if (stream.eatSpace()) return null;

  // Strings
  if (stream.match('"')) {
    while (!stream.eol()) {
      const ch = stream.next();
      if (ch === "\\") stream.next();
      else if (ch === '"') break;
    }
    return "string";
  }

  // Numbers
  if (stream.match(/^[0-9]+(\.[0-9]+)?/)) return "number";

  // Two-char operators
  if (stream.match("?-") || stream.match(":-")) return "punctuation";
  // Bit shifts: try the 3-char `>>>` before the 2-char `>>`, and both
  // before the single-char `<` / `>` below.
  if (stream.match(">>>") || stream.match("<<") || stream.match(">>")) return "operator";
  if (
    stream.match("<=") ||
    stream.match(">=") ||
    stream.match("<>") ||
    stream.match("&&") ||
    stream.match("||") ||
    stream.match("..")
  )
    return "operator";

  // Single-char operators (bitwise `&` / `|` / `^` included; `&&` / `||`
  // are matched above, so a lone `&` / `|` lands here).
  if (stream.match(/^[!+\-*/%<>=&|^]/)) return "operator";

  // Variables (uppercase or underscore start)
  if (stream.match(/^[A-Z_][a-zA-Z0-9_]*/)) return "variableName";

  // Identifiers (lowercase start) — may be keywords, types, or predicate names
  const ident = stream.match(/^[a-z][a-zA-Z0-9_]*/);
  if (ident && Array.isArray(ident)) {
    const word = ident[0]!;
    if (keywords.has(word)) return "keyword";
    if (types.has(word)) return "typeName";
    // A `^` immediately before an argument list is the maximal sigil, not
    // bitwise XOR, and the parser reads it the same way. Consume it with the
    // name so the whole `bad^` highlights as one predicate; a `^` anywhere
    // else is matched as an operator above. StreamLanguage emits one tag per
    // call, so the sigil cannot carry a scope of its own here (the VS Code
    // TextMate grammar does give it one, via a capture).
    stream.match(/^\^(?=\()/);
    return "name";
  }

  // Punctuation. Includes `{` and `}` so the object-literal delimiters
  // get the same styling as `(`, `)`, `[`, `]` — without this, ObjectLiteral
  // braces fall through to "anything else" and CodeMirror's bracket-matching
  // plugin can't pair them.
  if (stream.match(/^[(){}.,\[\]:]/)) return "punctuation";

  // Anything else
  stream.next();
  return null;
}

const datamogStreamParser = StreamLanguage.define({ token: datamogToken });

export function datamogLanguage(): LanguageSupport {
  return new LanguageSupport(datamogStreamParser);
}
