import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatamogServices } from "datamog-parser";
import type { Program } from "datamog-parser";
import type { AstNode } from "langium";
import { registerValidationChecks } from "../src/datamog-validator.ts";

interface CapturedDiagnostic {
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  node: AstNode;
}

const services = createDatamogServices();
const parser = services.Datamog.parser.LangiumParser;

function runValidator(source: string, filePath?: string): CapturedDiagnostic[] {
  // The validator runs against an AST that hasn't gone through
  // `postProcess` yet — that mirrors Langium's pipeline (parse →
  // validate, with post-process happening inside the validator).
  // The standalone `parse()` helper in `datamog-parser` calls
  // `postProcess` automatically, so use the Langium parser directly.
  const program = parser.parse<Program>(source).value;
  if (filePath) {
    // Fake the LangiumDocument the module path reads its text/URI from, so
    // `from "..."` imports resolve relative to `filePath`.
    (program as { $document?: unknown }).$document = {
      uri: { scheme: "file", fsPath: filePath },
      textDocument: { getText: () => source },
    };
  }
  const captured: CapturedDiagnostic[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: mock validation registry
  let validator: any;
  registerValidationChecks({
    register(checks: { Program: typeof validator }) {
      validator = checks.Program;
    },
  });
  validator(
    program,
    (severity: CapturedDiagnostic["severity"], message: string, info: { node: AstNode }) => {
      captured.push({ severity, message, node: info.node });
    },
  );
  return captured;
}

describe("datamog-validator", () => {
  test("Regression: post-process errors anchor on the offending node, not the whole program", () => {
    // The validator caught `postProcess`'s ParseError but passed
    // `{ node: program }` to `accept()`, anchoring the diagnostic on
    // the entire document. The empty-bracket-access error carries
    // `offset` / `end` (since the round-7 fix), so the validator
    // should locate the precise BracketAccess node — same shape as
    // the analyzer-error branch a few lines below.
    const source = "r(C) :- w(W), C = W[].";
    const diagnostics = runValidator(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("error");
    expect(diagnostics[0]!.message).toMatch(/Empty bracket access/);
    // The diagnostic should NOT anchor on the whole Program — that
    // would highlight the entire document.
    expect(diagnostics[0]!.node.$type).not.toBe("Program");
  });

  test("Regression: finiteness warnings are surfaced (parity with playground)", () => {
    // The playground's worker calls `findInfiniteRisks` after
    // `inferTypes` and surfaces results as severity:"warning"
    // diagnostics so the editor renders yellow squigglies on
    // infinite-risk predicates. The VS Code validator skipped this
    // step, so a user editing in VS Code never saw the warnings their
    // playground-using collaborators were seeing for the same source.
    const source = `
      input predicate p(x: integer).
      grow(X) :- p(X).
      grow(X + 1) :- grow(X).
      ?- grow(Y).
    `;
    const diagnostics = runValidator(source);
    const warnings = diagnostics.filter((d) => d.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
  });

  // The comment above claimed parity while only the finiteness family ran, so the
  // six nullness warnings and the two inert-declaration ones never reached the
  // editor. One case per remaining family, since the failure was per-family.
  test("Regression: a nullness warning is surfaced", () => {
    const source = `
      input predicate p(a: integer, ok: boolean?).
      q(X) :- p(X, B), B.
      ?- q(X).
    `;
    const warnings = runValidator(source).filter((d) => d.severity === "warning");
    expect(warnings.map((w) => w.message).join("\n")).toMatch(/its operand is null/);
  });

  test("Regression: an inert polarity sigil is surfaced", () => {
    const source = `
      p^(0).
      p^(X: integer) :- p^(X).
      ?- p^(X).
    `;
    const warnings = runValidator(source).filter((d) => d.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
  });

  // The same missing passes: an annotation left inside an `AnnotatedHeadTerm` is
  // never compared against what inference proved, so a wrong one was accepted.
  test("Regression: a head type annotation is checked", () => {
    const source = `
      input predicate p(a: string).
      q(X: integer) :- p(X).
      ?- q(Y).
    `;
    const errors = runValidator(source).filter((d) => d.severity === "error");
    expect(errors.map((e) => e.message).join("\n")).toMatch(/annotated 'integer'/);
  });

  test("Regression: an inert contract is surfaced", () => {
    // One unannotated sibling makes the disjunction vacuous, so the contract
    // claims nothing.
    const source = `
      q(1).
      p(A, _: A > 0) :- q(A).
      p(A) :- q(A).
      ?- p(A).
    `;
    const warnings = runValidator(source).filter((d) => d.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("a data-file binding validates cleanly (no 'not yet supported' error)", () => {
    // Before module wiring, any `:=` binding tripped the analyzer's
    // "not yet supported" rejection. A data-file binding needs no module
    // resolution, so it should elaborate and analyse without error.
    const source = 'input predicate p(a: integer) := "data/p.csv".\n?- p(X).';
    const diagnostics = runValidator(source);
    expect(diagnostics).toEqual([]);
  });

  test("a missing module surfaces as a diagnostic, not a crash", () => {
    const source =
      'input predicate q(a: integer, b: integer) := reach from "does-not-exist.dl"(edge = q).\n?- q(X, Y).';
    const diagnostics = runValidator(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("error");
    expect(diagnostics[0]!.message).toMatch(/cannot read module 'does-not-exist\.dl'/);
  });

  test("resolves a real import: clean when types agree, error when they don't", () => {
    const dir = mkdtempSync(join(tmpdir(), "datamog-val-"));
    try {
      writeFileSync(
        join(dir, "reach.dl"),
        "input predicate edge(src: integer, dst: integer).\noutput predicate reach(X, Y) :- edge(X, Y).\noutput predicate reach(X, Z) :- reach(X, Y), edge(Y, Z).\n",
      );
      const main = join(dir, "main.dl");

      const ok =
        'input predicate road(src: integer, dst: integer).\ninput predicate rr(a: integer, b: integer) := reach from "reach.dl"(edge = road).\n?- rr(X, Y).';
      expect(runValidator(ok, main)).toEqual([]);

      const bad =
        'input predicate road(src: integer, dst: integer).\ninput predicate rr(a: string, b: string) := reach from "reach.dl"(edge = road).\n?- rr(X, Y).';
      const diagnostics = runValidator(bad, main);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.message).toMatch(/column 1 has type 'integer' but 'string'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("type aliases are expanded before editor contract validation", () => {
  const errors = (source: string) => runValidator(source).filter((d) => d.severity === "error");
  expect(
    errors('type Person = {age: integer}. p({"age": 41}: Person). q(P["age"] + 1) :- p(P).'),
  ).toEqual([]);
  expect(errors('type Person = {age: integer}. p({"age": "bad"}: Person).')[0]?.message).toContain(
    "structural annotation",
  );
  expect(errors("input predicate p(x: Missing).")[0]?.message).toContain("Unknown type alias");
});
