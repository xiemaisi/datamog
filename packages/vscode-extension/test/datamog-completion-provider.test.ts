import { describe, expect, test } from "bun:test";
import {
  DatamogGeneratedModule,
  DatamogGeneratedSharedModule,
  DatamogLanguageMetaData,
} from "datamog-parser";
import { EmptyFileSystem, inject } from "langium";
import type { Module } from "langium";
import { DocumentState, URI } from "langium";
import {
  type LangiumServices,
  type PartialLangiumServices,
  createDefaultModule,
  createDefaultSharedModule,
} from "langium/lsp";
import { CompletionItemKind, type CompletionList } from "vscode-languageserver";
import { DatamogCompletionProvider } from "../src/datamog-completion-provider.ts";

// Build a Langium LSP-enabled Datamog service stack with our custom
// CompletionProvider injected. EmptyFileSystem skips the disk reads
// startLanguageServer would normally trigger.
function createServices() {
  const shared = inject(createDefaultSharedModule(EmptyFileSystem), DatamogGeneratedSharedModule);
  const DatamogModule: Module<LangiumServices, PartialLangiumServices> = {
    // Same production-mode override as the language server: silences
    // Chevrotain's by-design BodyElement ambiguity warnings during tests.
    LanguageMetaData: () => ({ ...DatamogLanguageMetaData, mode: "production" }),
    lsp: {
      CompletionProvider: (services) => new DatamogCompletionProvider(services),
    },
  };
  const Datamog = inject(createDefaultModule({ shared }), DatamogGeneratedModule, DatamogModule);
  shared.ServiceRegistry.register(Datamog);
  return { shared, Datamog };
}

async function getCompletions(source: string, cursorMarker = "|"): Promise<CompletionList> {
  const offset = source.indexOf(cursorMarker);
  if (offset < 0) throw new Error(`source must contain cursor marker "${cursorMarker}"`);
  const text = source.slice(0, offset) + source.slice(offset + cursorMarker.length);
  const services = createServices();
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = docs.createDocument(URI.parse("file:///test.dl"), text);
  // The completion provider only needs the document parsed — go up to
  // IndexedContent so scope/link aren't run (they'd require workspace
  // initialization that EmptyFileSystem doesn't provide).
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: false });
  // build() takes the doc all the way to Validated; sanity check that
  // parsing finished, since findFeaturesAt depends on the parse tree.
  if (doc.state < DocumentState.Parsed) throw new Error("document did not parse");
  const provider = services.Datamog.lsp.CompletionProvider!;
  const position = doc.textDocument.positionAt(offset);
  const result = await provider.getCompletion(doc, {
    textDocument: { uri: doc.textDocument.uri },
    position,
  });
  if (!result) throw new Error("no completion list returned");
  return result;
}

function labels(list: CompletionList): string[] {
  return list.items.map((i) => i.label);
}

describe("DatamogCompletionProvider", () => {
  test("proposes user predicate names inside a rule body", async () => {
    const source = "input predicate edge(s: string, d: string).\nreach(X, Y) :- |.\n";
    const items = await getCompletions(source);
    expect(labels(items)).toContain("edge");
    expect(labels(items)).toContain("reach");
    // Built-in body atoms ride alongside predicates at atom positions.
    expect(labels(items)).toContain("object_entry");
    expect(labels(items)).toContain("array_element");
  });

  test("proposes keywords (Langium default still active)", async () => {
    // At program start, the grammar expects `input` (for `input predicate`),
    // `?-`, or an Identifier (starting a rule). Confirm `input` is still
    // proposed — our override must not stomp on super.completionFor.
    const source = "|";
    const items = await getCompletions(source);
    expect(labels(items)).toContain("input");
  });

  test("proposes column type keywords inside an input predicate declaration", async () => {
    const source = "input predicate p(x: |";
    const items = await getCompletions(source);
    // These come from Langium's default keyword completion.
    for (const t of ["string", "integer", "float", "boolean", "value"]) {
      expect(labels(items)).toContain(t);
    }
  });

  test("tags predicate suggestions with arity-bearing detail", async () => {
    const source = "input predicate edge(s: string, d: string).\nq(X) :- |.";
    const items = await getCompletions(source);
    const edge = items.items.find((i) => i.label === "edge");
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe(CompletionItemKind.Struct);
    expect(edge?.detail).toBe("input(s, d)");
  });

  test("proposes in-scope variables alongside predicates in a rule body", async () => {
    // The grammar no longer distinguishes predicates from variables at
    // the terminal level — both go through `Identifier` — so completion
    // at a body-element start surfaces both groups. In-scope variables
    // come from the enclosing rule's existing atoms.
    const source = "input predicate edge(s: string, d: string).\nreach(X, Y) :- edge(X, Y), |.";
    const items = await getCompletions(source);
    expect(labels(items)).toContain("X");
    expect(labels(items)).toContain("Y");
    expect(labels(items)).toContain("edge");
  });
});

test("proposes type aliases in type positions", async () => {
  const result = await getCompletions("type Person = {name: string}. input predicate p(x: |).");
  const alias = result.items.find((item) => item.label === "Person");
  expect(alias?.detail).toBe("type alias");
});
