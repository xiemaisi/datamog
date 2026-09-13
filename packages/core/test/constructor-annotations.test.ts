import { expect, test } from "bun:test";
import { parse, parseRaw, postProcess, proofConstruction } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { validateConstructorAnnotations } from "../src/constructor-annotations.ts";
import { checkModuleBoundaries, elaborate } from "../src/elaborate.ts";
import { inferSemanticColumns } from "../src/semantic-inference.ts";
import { ANY_VALUE, scalarType } from "../src/semantic-type.ts";
import { inferTypes } from "../src/types.ts";
const typed = (source: string) => inferTypes(analyze(parse(source)));

test("payload annotations preserve private types and publish each argument independently", () => {
  const p = typed('p() :: C(3: float, "label", {"n": 1}: {n: float}).');
  expect(p.proofTypes.payload({ predicate: "p" }, "C")?.slice(0, 2)).toEqual([
    scalarType("integer"),
    scalarType("string"),
  ]);
  expect(p.publishedProofTypes.payload({ predicate: "p" }, "C")?.slice(0, 2)).toEqual([
    scalarType("float"),
    scalarType("string"),
  ]);
  expect(p.publishedProofTypes.payload({ predicate: "p" }, "C")?.[2]).toMatchObject({
    kind: "record",
    fields: [{ name: "n", type: scalarType("float") }],
  });
});

test("payload contract errors name the constructor, position, path and source span", () => {
  const source = 'p() :: C("ok", {"n": "bad"}: {n: float}).';
  try {
    typed(source);
    throw new Error("expected rejection");
  } catch (error) {
    expect((error as Error).message).toContain("Constructor 'p::C' payload 2");
    expect((error as Error).message).toContain('$["n"]: expected float, inferred string');
    expect(error).toMatchObject({ offset: source.indexOf('{"n"') });
  }
  expect(() => typed("p() :: C({}: {n: integer}).")).toThrow("required field");
  expect(() => typed("p() :: C(3: string).")).toThrow("expected string");
});

test("nullable annotations check actual null values independently of value storage", () => {
  for (const type of ["integer?", "value?", "null"])
    expect(() => typed(`p() :: C(null: ${type}).`)).not.toThrow();
  for (const type of ["integer", "value"])
    expect(() => typed(`p() :: C(null: ${type}).`)).toThrow("payload 1");
  expect(() =>
    typed("input predicate input(n: integer?). p() :: C(N: integer) :- input(N)."),
  ).toThrow();
  expect(() =>
    typed("input predicate input(n: integer?). p() :: C(N: integer) :- input(N), N <> null."),
  ).not.toThrow();
});

test("published payloads remain opaque through forwarding and unannotated constructors", () => {
  const source =
    "p() :: C(3: value). forwarded(P) :- P:p. wrapped() :: W(X) :- forwarded(P), P=C(X).";
  const p = typed(source);
  expect(p.proofTypes.payload({ predicate: "wrapped" }, "W")).toEqual([scalarType("integer")]);
  expect(p.publishedProofTypes.payload({ predicate: "wrapped" }, "W")).toEqual([ANY_VALUE]);
  expect(() => typed(`${source} answer(X*2) :- P:wrapped, P=W(X).`)).toThrow("numeric operands");
  expect(() => typed(`${source} answer(as_integer(X)*2) :- P:wrapped, P=W(X).`)).not.toThrow();
});

test("recursive producers validate against inferred self payloads", () => {
  const p = typed("p(0) :: Base(1: value). p(I+1) :: Step(N+1: value) :- P:p(I), P=Base(N), I<1.");
  expect(p.proofTypes.payload({ predicate: "p" }, "Step")).toEqual([scalarType("integer")]);
  expect(p.publishedProofTypes.payload({ predicate: "p" }, "Step")).toEqual([ANY_VALUE]);
});

test("work exhaustion does not leave narrow payload contributions as annotation evidence", () => {
  const p = typed("p() :: C(1: integer).");
  const result = inferSemanticColumns(p, p.semanticColumnTypes, {
    maxRuleEvaluations: 0,
    inferredProofTypes: p.proofTypes,
  });
  expect(() => validateConstructorAnnotations(result.constructorContributions)).toThrow(
    "payload 1",
  );
});

test("reanalysis rechecks changed payload contracts and removes stale consumer extraction", () => {
  const program = analyze(parse("p() :: C(3: float). q(X/2) :- P:p, P=C(X)."));
  expect(inferTypes(program).columnTypes.get("q")).toEqual(["float"]);
  expect(inferTypes(program).columnTypes.get("q")).toEqual(["float"]);
  const term = program.rules.get("p")![0]!.head.args.at(-1)!;
  if (term.$type !== "ObjectLiteral") throw new Error("expected proof");
  proofConstruction(term)!.annotations![0]!.type = "value";
  expect(() => inferTypes(program)).toThrow("numeric operands");
});

test("module aliases and shared output renaming retain payload contracts", () => {
  const resolve = () => ({
    file: "m.dl",
    program: parseRaw('type Payload = {n: float}. output predicate p() :: C({"n": 3}: Payload).'),
  });
  const result = elaborate(
    parseRaw(
      'input predicate first(evidence: value) := p from "m.dl". input predicate second(evidence: value) := p from "m.dl". q(N/2) :- P:second, P=second::C(D), N=D["n"].',
    ),
    resolve,
    "entry.dl",
  );
  postProcess(result.program);
  const p = inferTypes(analyze(result.program));
  checkModuleBoundaries(p, result.boundaries);
  expect(p.columnTypes.get("q")).toEqual(["float"]);
  expect(p.publishedProofTypes.payload({ predicate: "first" }, "C")?.[0]).toMatchObject({
    kind: "record",
    fields: [{ name: "n", type: scalarType("float") }],
  });
});
