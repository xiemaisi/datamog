import { describe, expect, test } from "bun:test";
import {
  ANY_VALUE,
  NEVER,
  ProofTypeRegistry,
  type SemanticType,
  fromPrimitiveType,
  normalizeType,
  projectType,
  sameSemanticType,
  scalarType,
  semanticStorageType,
  unionType,
} from "../src/semantic-type.ts";

const integer = scalarType("integer");
const string = scalarType("string");
const float = scalarType("float");
const nullableInteger = unionType(integer, scalarType("null"));
const person: SemanticType = {
  kind: "record",
  fields: [
    { name: "age", type: nullableInteger, optional: false },
    { name: "name", type: string, optional: true },
  ],
  additional: NEVER,
};

describe("semantic type foundation", () => {
  test("primitive bridge preserves null and separates empty from universal", () => {
    for (const name of ["integer", "float", "string", "boolean", "null", "value"] as const) {
      expect(semanticStorageType(fromPrimitiveType(name))).toBe(name);
    }
    expect(semanticStorageType(NEVER)).toBeUndefined();
    expect(sameSemanticType(NEVER, ANY_VALUE)).toBe(false);
    expect(sameSemanticType(nullableInteger, integer)).toBe(false);
  });

  test("union identities, commutativity, associativity and idempotence", () => {
    const types = [NEVER, ANY_VALUE, integer, float, string, nullableInteger, person];
    for (const a of types) {
      expect(sameSemanticType(unionType(a, NEVER), a)).toBe(true);
      expect(sameSemanticType(unionType(a, a), a)).toBe(true);
      expect(unionType(a, ANY_VALUE)).toEqual(ANY_VALUE);
      for (const b of types) {
        expect(sameSemanticType(unionType(a, b), unionType(b, a))).toBe(true);
        for (const c of types) {
          expect(
            sameSemanticType(unionType(unionType(a, b), c), unionType(a, unionType(b, c))),
          ).toBe(true);
        }
      }
    }
    expect(unionType(integer, float)).toEqual(float);
  });

  test("record ordering is immaterial and impossible required fields are empty", () => {
    if (person.kind !== "record") throw new Error("expected record");
    expect(sameSemanticType(person, { ...person, fields: [...person.fields].reverse() })).toBe(
      true,
    );
    expect(
      normalizeType({ ...person, fields: [{ name: "x", type: NEVER, optional: false }] }),
    ).toEqual(NEVER);
    expect(() =>
      normalizeType({ ...person, fields: [person.fields[0]!, person.fields[0]!] }),
    ).toThrow("Duplicate semantic field");
  });

  test("required nullable fields and optional fields have independent presence", () => {
    expect(projectType(person, "age")).toEqual({ type: nullableInteger, mayBeAbsent: false });
    expect(projectType(person, "name")).toEqual({ type: string, mayBeAbsent: true });
    expect(projectType(person, "unknown")).toEqual({ type: NEVER, mayBeAbsent: true });
    expect(projectType({ kind: "record", fields: [], additional: integer }, "x")).toEqual({
      type: integer,
      mayBeAbsent: true,
    });
  });

  test("tuples, arrays and union projections retain successful types and absence", () => {
    const tuple: SemanticType = { kind: "tuple", elements: [integer, string] };
    expect(projectType(tuple, 0)).toEqual({ type: integer, mayBeAbsent: false });
    for (const index of [-1, 2, 0.5, "0"]) {
      expect(projectType(tuple, index)).toEqual({ type: NEVER, mayBeAbsent: true });
    }
    expect(projectType({ kind: "array", element: integer }, 0)).toEqual({
      type: integer,
      mayBeAbsent: true,
    });
    expect(projectType(unionType(person, scalarType("null")), "age")).toEqual({
      type: nullableInteger,
      mayBeAbsent: true,
    });
    expect(semanticStorageType(tuple)).toBe("value");
    expect(semanticStorageType(person)).toBe("value");
  });

  test("empty arrays are inhabited even when their element type is empty", () => {
    expect(normalizeType({ kind: "array", element: NEVER }).kind).toBe("array");
    expect(normalizeType({ kind: "tuple", elements: [] }).kind).toBe("tuple");
    expect(normalizeType({ kind: "tuple", elements: [NEVER] })).toEqual(NEVER);
  });

  test("recursive proof signatures stay nominal and support typed payload lookup", () => {
    const id = { predicate: "instance1::list" };
    const proof: SemanticType = { kind: "proof", id };
    const other: SemanticType = { kind: "proof", id: { predicate: "instance2::list" } };
    const registry = new ProofTypeRegistry();
    registry.define(id, [
      { name: "Nil", payload: [] },
      { name: "Cons", payload: [integer, proof] },
    ]);
    expect(registry.payload(id, "Cons")).toEqual([integer, proof]);
    expect(registry.payload(id, "Nil")).toEqual([]);
    expect(registry.payload(id, "Missing")).toBeUndefined();
    expect(registry.payload(other.id, "Cons")).toBeUndefined();
    expect(sameSemanticType(proof, other)).toBe(false);
    expect(sameSemanticType(proof, { kind: "proof", id: { ...id } })).toBe(true);
    expect(semanticStorageType(proof)).toBe("value");
    expect(projectType(proof, "$proof")).toEqual({ type: NEVER, mayBeAbsent: true });
    expect(() => registry.define(id, [])).toThrow("already defined");
    expect(() =>
      registry.define(other.id, [
        { name: "X", payload: [] },
        { name: "X", payload: [] },
      ]),
    ).toThrow("Duplicate constructor");
    registry.define(other.id, [{ name: "X", payload: [proof] }]);
  });
});

describe("proof registry reference validation", () => {
  const missing: SemanticType = { kind: "proof", id: { predicate: "missing" } };

  test("forward and mutually recursive references resolve after registration", () => {
    const registry = new ProofTypeRegistry();
    const left = { predicate: "left" };
    const right = { predicate: "right" };
    registry.define(left, [{ name: "Next", payload: [{ kind: "proof", id: right }] }]);
    expect(() => registry.validateReferences()).toThrow("right");
    registry.define(right, [{ name: "Next", payload: [{ kind: "proof", id: left }] }]);
    expect(() => registry.validateReferences()).not.toThrow();
    expect(() => registry.validateReferences()).not.toThrow();
  });

  test("empty registries, nullary constructors and self references are valid", () => {
    const registry = new ProofTypeRegistry();
    expect(() => registry.validateReferences()).not.toThrow();
    const id = { predicate: "list" };
    registry.define(id, [
      { name: "Nil", payload: [] },
      { name: "Cons", payload: [integer, { kind: "proof", id }] },
    ]);
    expect(() => registry.validateReferences()).not.toThrow();
  });

  test("checks references inside every structural type component", () => {
    const cases: SemanticType[] = [
      missing,
      { kind: "array", element: missing },
      { kind: "tuple", elements: [integer, missing] },
      unionType(string, missing),
      {
        kind: "record",
        fields: [{ name: "child", type: missing, optional: true }],
        additional: NEVER,
      },
      { kind: "record", fields: [], additional: missing },
      {
        kind: "array",
        element: { kind: "tuple", elements: [unionType(string, missing)] },
      },
    ];
    for (const type of cases) {
      const registry = new ProofTypeRegistry();
      registry.define({ predicate: "owner" }, [{ name: "Wrap", payload: [integer, type] }]);
      expect(() => registry.validateReferences()).toThrow(
        "Unknown proof type 'missing' in 'owner::Wrap' payload 2",
      );
    }
  });

  test("module identities must resolve exactly, even when source names match", () => {
    const registry = new ProofTypeRegistry();
    registry.define({ predicate: "$1$list" }, [{ name: "Nil", payload: [] }]);
    registry.define({ predicate: "result" }, [
      { name: "Wrap", payload: [{ kind: "proof", id: { predicate: "$2$list" } }] },
    ]);
    expect(() => registry.validateReferences()).toThrow("Unknown proof type '$2$list'");
    registry.define({ predicate: "$2$list" }, [{ name: "Nil", payload: [] }]);
    expect(() => registry.validateReferences()).not.toThrow();
  });
});
