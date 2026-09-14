import { expect, test } from "bun:test";
import { parse, parseRaw, postProcess } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { checkModuleBoundaries, elaborate } from "../src/elaborate.ts";
import { inferTypes } from "../src/types.ts";
const typed = (source: string) => inferTypes(analyze(parse(source)));
const proof = (predicate: string) => ({ kind: "proof", id: { predicate } });
function modules(source: string, files: Record<string, string>) {
  const result = elaborate(
    parseRaw(source),
    (file) => ({ file, program: parseRaw(files[file]!) }),
    "entry",
  );
  postProcess(result.program);
  const program = inferTypes(analyze(result.program));
  checkModuleBoundaries(program, result.boundaries);
  return program;
}

test("bare proof names work in recursive payloads, heads and nested aliases", () => {
  const p = typed(
    "type N = nat. type Nodes = [N?]. nat(0) :: Z. nat(I+1) :: S(P:nat) :- P:nat(I), I<2. out(P:N, [P,null]:Nodes) :- P:nat(_).",
  );
  expect(p.publishedProofTypes.payload({ predicate: "nat" }, "S")).toEqual([proof("nat")]);
  expect(p.publishedSemanticColumnTypes.get("out")?.[0]).toEqual(proof("nat"));
  expect(() => typed("type A = [A].")).toThrow("Recursive type alias");
  expect(() => typed("type A = missing.")).toThrow("Unknown type alias");
});

test("nominal declarations reject other identities, structural forgeries and ordinary predicates", () => {
  expect(() => typed("p() :: C. q() :: C. bad(P:p) :- P:q.")).toThrow("expected proof of 'p'");
  expect(() => typed('p() :: C. bad({"$proof":"p::C","args":[]}:p).')).toThrow(
    "expected proof of 'p'",
  );
  expect(() => typed("p(1). type Invalid = p.")).toThrow(
    "does not identify a proof-carrying predicate",
  );
  expect(() => typed("type p = integer. p() :: C. bad(1:p).")).toThrow("Ambiguous type name");
  expect(() => typed("type p = integer. p(1). out(1:p).")).not.toThrow();
});

test("quoted nominal names and nullable proof contracts preserve exact identity", () => {
  const p = typed("type N = `node-kind`. `node-kind`() :: C. out(P:N, null:N?) :- P:`node-kind`.");
  expect(p.publishedSemanticColumnTypes.get("out")?.[0]).toEqual(proof("node-kind"));
  expect(() => typed("p() :: C. out(null:p).")).toThrow();
});

test("all external nominal declarations are rejected, including unused optional nested fields", () => {
  for (const shape of ["p", "[p]", "{maybe?: p}", "[p?]?"])
    expect(() => typed(`p() :: C. input predicate external(x: ${shape}).`)).toThrow(
      "external JSON",
    );
});

test("shared output bindings map bare receiving names and aliases to one identity", () => {
  const p = modules(
    'input predicate first(e:first) := p from "m". type Second = second. input predicate second(e:Second) := p from "m". out(P:first) :- P:second.',
    { m: "output predicate p() :: C." },
  );
  expect(p.publishedSemanticColumnTypes.get("out")).toEqual([proof("first")]);
});

test("different input wiring creates distinct nominal instances", () => {
  const source =
    'a(1). b(2). input predicate left(n:integer,e:left) := p from "m"(input=a). input predicate right(n:integer,e:right) := p from "m"(input=b). out(P:left) :- P:right(_).';
  expect(() =>
    modules(source, {
      m: "input predicate input(n:integer). output predicate p(N) :: C :- input(N).",
    }),
  ).toThrow("expected proof of 'left'");
});

test("input contracts substitute actual proof producers without renaming them twice", () => {
  const source = 'p() :: C. input predicate result(e:p) := out from "m"(items=p).';
  const p = modules(source, {
    m: "input predicate items(e:items). p(1). output predicate out(P:items) :- P:items.",
  });
  expect(p.publishedSemanticColumnTypes.get("result")).toEqual([proof("p")]);
  expect(() =>
    modules(
      'p() :: C. forward(P) :- P:p. input predicate result(e:value) := out from "m"(items=forward).',
      { m: "input predicate items(e:items). output predicate out(P) :- P:items." },
    ),
  ).toThrow();
});

test("repeated instances check each receiving contract and imported alias ambiguity", () => {
  expect(() =>
    modules(
      'p() :: C. q() :: Q. input predicate first(e:first) := out from "m"(items=p). input predicate second(e:q) := out from "m"(items=p).',
      { m: "input predicate items(e:items). output predicate out() :: Wrap(P:items) :- P:items." },
    ),
  ).toThrow("expected proof of 'q'");
  expect(() =>
    modules('p() :: C. input predicate result(e:value) := out from "m"(items=p).', {
      m: "type items = value. input predicate items(e:items). output predicate out(P) :- P:items.",
    }),
  ).toThrow("Ambiguous type name");
});

test("nested defaults and later selected proof outputs preserve nominal references", () => {
  const p = modules(
    'input predicate first(e:first) := a from "parent". input predicate second(e:second) := b from "parent". out(P:second) :- P:second.',
    {
      parent:
        'input predicate supplied(e:supplied) := p from "child". output predicate a() :: A(P:supplied) :- P:supplied. output predicate b() :: B(P:supplied) :- P:supplied.',
      child: "output predicate p() :: C.",
    },
  );
  expect(p.publishedSemanticColumnTypes.get("out")).toEqual([proof("second")]);
  expect(p.publishedProofTypes.payload({ predicate: "second" }, "B")?.[0]?.kind).toBe("proof");
});

test("nested imports can wire their parent's renamed proof output", () => {
  const p = modules('input predicate selected(e:selected) := p from "parent".', {
    parent: 'output predicate p() :: C. input predicate used(e:p) := out from "child"(items=p).',
    child:
      "input predicate items(e:items). output predicate out(P:items) :- P:items, P=items::C().",
  });
  expect(p.publishedProofTypes.payload({ predicate: "selected" }, "C")).toEqual([]);
});

test("opaque published payloads cannot recover nominal precision", () => {
  expect(() =>
    typed(
      "p() :: P. wrapper() :: W(P:value) :- P:p. bad(X:p) :- W:wrapper, W=wrapper::W(X), X <> null.",
    ),
  ).toThrow("expected proof of 'p'");
});

test("unused aliases cannot collide with wired proof producers", () => {
  expect(() =>
    modules('p() :: C. input predicate result(e:value) := out from "m"(items=p).', {
      m: "type items = value. input predicate items(e:value). output predicate out(P) :- P:items.",
    }),
  ).toThrow("Ambiguous type name");
});

test("nullable nominal heads report the proof type rather than its storage carrier", () => {
  expect(() => typed("nat() :: Z. bad(null:nat).")).toThrow("annotated proof of 'nat'");
  expect(() => typed("nat() :: Z. bad(null:nat).")).toThrow("add '?' to this annotation");
  expect(() => typed("nat() :: Z. bad(null:[nat]).")).toThrow("[proof of 'nat']");
});

test("private module proof mismatches name the source, binding and instance", () => {
  try {
    modules('input predicate result(e:value) := out from "producer.dl".', {
      "producer.dl": "p() :: C. q() :: Q. output predicate out(P:p) :- P:q.",
    });
    throw new Error("expected a mismatch");
  } catch (error) {
    const message = (error as Error).message;
    expect(message).toContain('p (module "producer.dl", binding "result", instance 0)');
    expect(message).toContain('q (module "producer.dl", binding "result", instance 0)');
    expect(message).not.toContain("result$0$");
  }
});
