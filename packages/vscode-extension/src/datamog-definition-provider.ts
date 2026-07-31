// Go-to-definition (Ctrl/Cmd+click, F12) for Datamog.
//
// Langium's DefaultDefinitionProvider resolves grammar cross-references, and
// the Datamog grammar has none: `predicate=Identifier` is a plain string, not
// `[Predicate:IDENT]`, because a Datalog name means whatever the surrounding
// position says it means. So navigation is computed from the AST instead, the
// same reason DatamogCompletionProvider replaces the default completion.
//
// The lookup itself lives in `datamog-core`, which knows nothing about LSP or
// the filesystem. This file supplies the two things core cannot: converting
// byte offsets to LSP ranges, and reading an imported module off disk.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Definition, type SourceSpan, findDefinition, findModuleTarget } from "datamog-core";
import { parseRawLenient } from "datamog-parser";
import { URI } from "langium";
import type { LangiumDocument } from "langium";
import type { DefinitionProvider } from "langium/lsp";
import type { DefinitionParams } from "vscode-languageserver";
import { LocationLink, Range } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

export class DatamogDefinitionProvider implements DefinitionProvider {
  getDefinition(document: LangiumDocument, params: DefinitionParams): LocationLink[] | undefined {
    const text = document.textDocument.getText();
    // Re-parse rather than reuse `document.parseResult`: the validator
    // post-processes that AST in place, which desugars away the constructor
    // terms and `_` placeholders navigation needs to see. Lenient so a
    // half-typed buffer still navigates.
    const def = findDefinition(
      parseRawLenient(text),
      document.textDocument.offsetAt(params.position),
    );
    if (!def) return undefined;

    const origin = spanToRange(document.textDocument, def.origin);
    switch (def.kind) {
      case "local":
        return def.targets.map((t) =>
          link(document.uri.toString(), spanToRange(document.textDocument, t), origin),
        );
      case "file":
        return this.linkToFile(document, def, origin);
      case "module":
        return this.linkIntoModule(document, def, origin);
    }
  }

  /** A `:= "data.csv"` binding: open the file, no position within it. */
  private linkToFile(
    document: LangiumDocument,
    def: Extract<Definition, { kind: "file" }>,
    origin: Range,
  ): LocationLink[] | undefined {
    const path = resolveRef(document, def.ref);
    if (!path) return undefined;
    const start = Range.create(0, 0, 0, 0);
    return [link(URI.file(path).toString(), start, origin)];
  }

  /**
   * A `:= [export] from "mod.dl"` binding: open the module at the declaration
   * it selects. Falls back to the top of the file when the selected export is
   * missing, since landing in the right file still beats doing nothing.
   */
  private linkIntoModule(
    document: LangiumDocument,
    def: Extract<Definition, { kind: "module" }>,
    origin: Range,
  ): LocationLink[] | undefined {
    const path = resolveRef(document, def.ref);
    if (!path) return undefined;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      // An unresolvable import is already an error diagnostic from the
      // validator; navigation just declines rather than reporting it twice.
      return undefined;
    }
    const uri = URI.file(path).toString();
    const span = findModuleTarget(parseRawLenient(text), def.select);
    if (!span) return [link(uri, Range.create(0, 0, 0, 0), origin)];
    const moduleDoc = TextDocument.create(uri, "datamog", 0, text);
    return [link(uri, spanToRange(moduleDoc, span), origin)];
  }
}

/** Resolve a module/data reference relative to the importing file. */
function resolveRef(document: LangiumDocument, ref: string): string | undefined {
  // Untitled and in-memory documents have no directory to resolve against.
  if (document.uri.scheme !== "file") return undefined;
  return resolve(dirname(document.uri.fsPath), ref);
}

function spanToRange(doc: TextDocument, span: SourceSpan): Range {
  return Range.create(doc.positionAt(span.offset), doc.positionAt(span.end));
}

function link(targetUri: string, target: Range, origin: Range): LocationLink {
  // `targetSelectionRange` is what gets highlighted on arrival;
  // `targetRange` is the enclosing region VS Code peeks. Both are the name
  // itself here, which keeps the peek view tight.
  return LocationLink.create(targetUri, target, target, origin);
}
