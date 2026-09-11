import { expect, test } from "bun:test";
import { parse, parseRaw, postProcess, proofConstruction } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { elaborate } from "../src/elaborate.ts";
import { ANY_VALUE, scalarType } from "../src/semantic-type.ts";
import { inferTypes } from "../src/types.ts";

const infer = (source: string) => inferTypes(analyze(parse(source)));
const proof = (predicate: string) => ({ kind: "proof", id: { predicate } });

test("proof construction is nominal while ordinary JSON remains structural", () => {
  const typed = infer(
    'colour() :: Red. colour() :: Blue. result(C) :- C : colour(). json({"x": 1}).',
  );
  expect(typed.semanticColumnTypes.get("colour")).toEqual([proof("colour")]);
  expect(typed.semanticColumnTypes.get("result")).toEqual([proof("colour")]);
  expect(typed.semanticColumnTypes.get("json")![0]!.kind).toBe("record");
  expect(typed.proofTypes.payload({ predicate: "colour" }, "Red")).toEqual([]);
  expect(typed.columnTypes.get("colour")).toEqual(["value"]);
});

test("constructor matches recover scalar and recursive proof payload types", () => {
  const typed = infer(`
    num(7).
    xs(0) :: Nil.
    xs(N + 1) :: Cons :- num(H), xs(N), N < 3.
    head(H, T) :- Cons(H, T) = P, P : xs.
  `);
  expect(typed.proofTypes.payload({ predicate: "xs" }, "Cons")).toEqual([
    scalarType("integer"),
    proof("xs"),
  ]);
  expect(typed.semanticColumnTypes.get("head")).toEqual([scalarType("integer"), proof("xs")]);
});

test("nested constructor matches follow nominal payload references", () => {
  const typed = infer(`
    num(7).
    xs(0) :: Nil.
    xs(N + 1) :: Cons :- num(H), xs(N), N < 3.
    second(H) :- Cons(_, Cons(H, _)) = P, P : xs.
  `);
  expect(typed.semanticColumnTypes.get("second")).toEqual([scalarType("integer")]);
});

test("same-named constructors retain distinct predicate identities", () => {
  const typed = infer("left() :: Empty. right() :: Empty. l(P) :- P : left. r(P) :- P : right.");
  expect(typed.semanticColumnTypes.get("l")).toEqual([proof("left")]);
  expect(typed.semanticColumnTypes.get("r")).toEqual([proof("right")]);
});

test("ordinary JSON access on a proof stays conservative", () => {
  const typed = infer('colour() :: Red. tag(P["$proof"]) :- P : colour.');
  expect(typed.semanticColumnTypes.get("tag")).toEqual([ANY_VALUE]);
});

test("metadata is attached by lowering, never reconstructed from JSON keys", () => {
  const program = parse("colour() :: Red.");
  const typed = inferTypes(analyze(program));
  const term = typed.rules.get("colour")![0]!.head.args[0]!;
  if (term.$type !== "ObjectLiteral") throw new Error("Expected lowered object");
  expect(proofConstruction(term)?.predicate).toBe("colour");
  expect(proofConstruction({ ...term })).toBeUndefined();
});

test("module instantiations retain distinct proof identities and payload signatures", () => {
  const entry = parseRaw(`
    n(1). colour("red").
    input predicate ints(o: value) := opt from "adt.dl"(elem = n).
    input predicate colours(o: value) := opt from "adt.dl"(elem = colour).
  `);
  const { program } = elaborate(
    entry,
    () => ({
      program: parseRaw(
        "input predicate elem(v: value). output predicate opt() :: Some :- elem(V).",
      ),
      file: "adt.dl",
    }),
    "main.dl",
  );
  postProcess(program);
  const typed = inferTypes(analyze(program));
  expect(typed.semanticColumnTypes.get("ints")).toEqual([proof("ints")]);
  expect(typed.semanticColumnTypes.get("colours")).toEqual([proof("colours")]);
  expect(typed.proofTypes.payload({ predicate: "ints" }, "Some")).toEqual([scalarType("integer")]);
  expect(typed.proofTypes.payload({ predicate: "colours" }, "Some")).toEqual([
    scalarType("string"),
  ]);
});

test("inferred and published registries preserve mutually recursive signatures", () => {
  const typed = infer(`
    left(0) :: Base.
    left(N + 1) :: FromRight :- right(N), N < 2.
    right(N) :: FromLeft :- left(N).
  `);
  for (const registry of [typed.proofTypes, typed.publishedProofTypes]) {
    expect(() => registry.validateReferences()).not.toThrow();
    expect(registry.payload({ predicate: "left" }, "FromRight")).toEqual([proof("right")]);
    expect(registry.payload({ predicate: "right" }, "FromLeft")).toEqual([proof("left")]);
  }
});
