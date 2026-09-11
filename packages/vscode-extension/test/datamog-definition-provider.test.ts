import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatamogGeneratedModule,
  DatamogGeneratedSharedModule,
  DatamogLanguageMetaData,
} from "datamog-parser";
import { EmptyFileSystem, inject } from "langium";
import type { LangiumDocument, Module } from "langium";
import { URI } from "langium";
import {
  type LangiumServices,
  type PartialLangiumServices,
  createDefaultModule,
  createDefaultSharedModule,
} from "langium/lsp";
import type { LocationLink } from "vscode-languageserver";
import { DatamogDefinitionProvider } from "../src/datamog-definition-provider.ts";

// The provider re-parses the document text itself, so the service stack only
// has to hand it a LangiumDocument with a real URI and TextDocument.
function makeDocument(text: string, uri: string): LangiumDocument {
  const shared = inject(createDefaultSharedModule(EmptyFileSystem), DatamogGeneratedSharedModule);
  const DatamogModule: Module<LangiumServices, PartialLangiumServices> = {
    LanguageMetaData: () => ({ ...DatamogLanguageMetaData, mode: "production" }),
  };
  const Datamog = inject(createDefaultModule({ shared }), DatamogGeneratedModule, DatamogModule);
  shared.ServiceRegistry.register(Datamog);
  return shared.workspace.LangiumDocuments.createDocument(URI.parse(uri), text);
}

const provider = new DatamogDefinitionProvider();

/** Definition links for the cursor at the start of `needle`'s nth occurrence. */
function linksAt(
  text: string,
  needle: string,
  opts: { nth?: number; uri?: string } = {},
): LocationLink[] {
  const { nth = 0, uri = "file:///test.dl" } = opts;
  let offset = -1;
  for (let i = 0; i <= nth; i++) offset = text.indexOf(needle, offset + 1);
  if (offset < 0) throw new Error(`no occurrence ${nth} of ${needle}`);
  const doc = makeDocument(text, uri);
  return provider.getDefinition(doc, {
    textDocument: { uri: doc.textDocument.uri },
    position: doc.textDocument.positionAt(offset),
  }) as LocationLink[];
}

describe("same-document navigation", () => {
  const source = [
    "input predicate edge(s: string, d: string).",
    "reach(X, Y) :- edge(X, Y).",
    "reach(X, Y) :- edge(X, Z), reach(Z, Y).",
  ].join("\n");

  test("a body atom links to its declaration", () => {
    const links = linksAt(source, "edge", { nth: 1 });
    expect(links).toHaveLength(1);
    expect(links[0]?.targetUri).toBe("file:///test.dl");
    expect(links[0]?.targetSelectionRange).toEqual({
      start: { line: 0, character: 16 },
      end: { line: 0, character: 20 },
    });
  });

  test("the origin range covers just the clicked name", () => {
    const links = linksAt(source, "edge", { nth: 1 });
    expect(links[0]?.originSelectionRange).toEqual({
      start: { line: 1, character: 15 },
      end: { line: 1, character: 19 },
    });
  });

  test("a predicate with two rules yields two links", () => {
    const links = linksAt(source, "reach(Z, Y)");
    expect(links.map((l) => l.targetSelectionRange.start.line)).toEqual([1, 2]);
  });

  test("a variable links to its binding occurrence", () => {
    const links = linksAt(source, "X, Y) :- edge");
    expect(links).toHaveLength(1);
    expect(links[0]?.targetSelectionRange).toEqual({
      start: { line: 1, character: 20 },
      end: { line: 1, character: 21 },
    });
  });

  test("clicking whitespace returns nothing", () => {
    expect(
      provider.getDefinition(makeDocument(source, "file:///test.dl"), {
        textDocument: { uri: "file:///test.dl" },
        position: { line: 1, character: 11 },
      }),
    ).toBeUndefined();
  });

  test("a constructor term links to the rule that builds it", () => {
    const ctor = ["num_list(0) :: Nil.", "list_sum(Nil(), 0)."].join("\n");
    const links = linksAt(ctor, "Nil()");
    expect(links).toHaveLength(1);
    expect(links[0]?.targetSelectionRange.start).toEqual({ line: 0, character: 15 });
  });
});

describe("cross-file navigation", () => {
  // A real directory: the provider resolves imports off disk, relative to the
  // importing document's own path.
  const dir = mkdtempSync(join(tmpdir(), "datamog-def-"));
  const modulePath = join(dir, "path.dl");
  const moduleText = [
    "input predicate edge(a: string, b: string).",
    "output predicate shortest(X, Y) :- edge(X, Y).",
  ].join("\n");
  writeFileSync(modulePath, moduleText);

  const importer = [
    'input predicate dist(a: string, b: string) := shortest from "path.dl"(edge = link).',
    "input predicate link(a: string, b: string).",
  ].join("\n");
  const importerUri = URI.file(join(dir, "main.dl")).toString();

  test("the module path opens the selected output in the module", () => {
    const links = linksAt(importer, '"path.dl"', { uri: importerUri });
    expect(links).toHaveLength(1);
    expect(links[0]?.targetUri).toBe(URI.file(modulePath).toString());
    // `shortest` starts after `output predicate ` on line 1.
    expect(links[0]?.targetSelectionRange).toEqual({
      start: { line: 1, character: 17 },
      end: { line: 1, character: 25 },
    });
  });

  test("the bound predicate name navigates into the module too", () => {
    const links = linksAt(importer, "dist", { uri: importerUri });
    expect(links[0]?.targetUri).toBe(URI.file(modulePath).toString());
    expect(links[0]?.targetSelectionRange.start.line).toBe(1);
  });

  test("an actual's parameter opens the module's input declaration", () => {
    const links = linksAt(importer, "edge =", { uri: importerUri });
    expect(links[0]?.targetUri).toBe(URI.file(modulePath).toString());
    expect(links[0]?.targetSelectionRange).toEqual({
      start: { line: 0, character: 16 },
      end: { line: 0, character: 20 },
    });
  });

  test("an actual's argument stays in the importing file", () => {
    const links = linksAt(importer, "link)", { uri: importerUri });
    expect(links[0]?.targetUri).toBe(importerUri);
    expect(links[0]?.targetSelectionRange.start.line).toBe(1);
  });

  test("a data-file binding opens the file at its start", () => {
    const csvPath = join(dir, "edges.csv");
    writeFileSync(csvPath, "a,b\n");
    const src = 'input predicate e(a: string, b: string) := "edges.csv".';
    const links = linksAt(src, '"edges.csv"', { uri: importerUri });
    expect(links[0]?.targetUri).toBe(URI.file(csvPath).toString());
    expect(links[0]?.targetSelectionRange.start).toEqual({ line: 0, character: 0 });
  });

  test("a missing module declines rather than throwing", () => {
    const src = 'input predicate d(a: string) := from "nope.dl".';
    expect(linksAt(src, '"nope.dl"', { uri: importerUri })).toBeUndefined();
  });

  test("an unknown export lands at the top of the module", () => {
    const src = 'input predicate d(a: string) := missing from "path.dl".';
    const links = linksAt(src, '"path.dl"', { uri: importerUri });
    expect(links[0]?.targetUri).toBe(URI.file(modulePath).toString());
    expect(links[0]?.targetSelectionRange.start).toEqual({ line: 0, character: 0 });
  });

  test("a constructor from an imported module opens the module's rule", () => {
    const adtPath = join(dir, "option.dl");
    writeFileSync(
      adtPath,
      ["input predicate elem(v: value).", "output predicate opt() :: Some :- elem(V)."].join("\n"),
    );
    const src = [
      'input predicate int_opt(o: value) := opt from "option.dl"(elem = n).',
      "q(V) :- P : int_opt, P = int_opt::Some(V).",
    ].join("\n");
    const links = linksAt(src, "Some(V)", { uri: importerUri });
    expect(links[0]?.targetUri).toBe(URI.file(adtPath).toString());
    expect(links[0]?.targetSelectionRange).toEqual({
      start: { line: 1, character: 26 },
      end: { line: 1, character: 30 },
    });
  });

  test("an unsaved document cannot resolve relative imports", () => {
    const src = 'input predicate d(a: string) := from "path.dl".';
    expect(linksAt(src, '"path.dl"', { uri: "untitled:Untitled-1.dl" })).toBeUndefined();
  });
});

test("alias references link to their declaration after head annotations are lifted", () => {
  const links = linksAt("type Age = integer.\nq(1: Age).", "Age", { nth: 1 });
  expect(links).toHaveLength(1);
  expect(links[0]?.targetSelectionRange).toEqual({
    start: { line: 0, character: 5 },
    end: { line: 0, character: 8 },
  });
  expect(links[0]?.originSelectionRange).toEqual({
    start: { line: 1, character: 5 },
    end: { line: 1, character: 8 },
  });
});
