import { containsNominalType } from "datamog-parser";
import { AnalyzerError } from "./analyzer.ts";
import type { ColumnDecl, ExtDecl, Rule } from "./ast.ts";
/** Structural input-column declarations and validation of their JSON values. */
import { semanticContractMismatch } from "./semantic-diagnostics.ts";
import {
  NEVER,
  type SemanticType,
  fromPrimitiveType,
  normalizeType,
  scalarType,
  unionType,
} from "./semantic-type.ts";

type Shape = NonNullable<ColumnDecl["shape"]>;
type TypeValue = Extract<Shape, { $type: "ArrayType" }>["element"];

function valueType(value: TypeValue): SemanticType {
  const type: SemanticType = value.nominal
    ? { kind: "proof", id: { predicate: value.nominal.predicate } }
    : value.shape
      ? shapeType(value.shape)
      : fromPrimitiveType(value.type!);
  return value.nullable ? unionType(type, scalarType("null")) : type;
}

function shapeType(shape: Shape): SemanticType {
  if (shape.$type === "ArrayType") return { kind: "array", element: valueType(shape.element) };
  const seen = new Set<string>();
  const fields = shape.fields.map((field) => {
    if (seen.has(field.name)) {
      throw new AnalyzerError(
        `Duplicate structural field '${field.name}'`,
        field.$cstNode?.offset,
        field.$cstNode?.end,
      );
    }
    seen.add(field.name);
    return { name: field.name, optional: field.optional, type: valueType(field.value) };
  });
  return normalizeType({ kind: "record", fields, additional: NEVER });
}

/** Column storage stays primitive; the schema is a separate semantic contract. */
export function declaredColumnType(
  column: Pick<ColumnDecl, "type" | "shape" | "nullable" | "nominal">,
): SemanticType {
  const type: SemanticType = column.nominal
    ? { kind: "proof", id: { predicate: column.nominal.predicate } }
    : column.shape
      ? shapeType(column.shape)
      : fromPrimitiveType(column.type ?? "string");
  return column.nullable ? unionType(type, scalarType("null")) : type;
}

type StructuralMatcher = (value: unknown, path: string) => string | undefined;

/** Prepare shape dispatch and field indexes once, independently of input values. */
function compileMatcher(type: SemanticType): StructuralMatcher {
  switch (type.kind) {
    case "value":
      return () => undefined;
    case "never":
      return (_value, path) => `${path}: no value is permitted`;
    case "scalar":
      return (value, path) => {
        const matches =
          type.name === "null"
            ? value === null
            : type.name === "integer"
              ? typeof value === "number" && Number.isSafeInteger(value)
              : type.name === "float"
                ? typeof value === "number" && Number.isFinite(value)
                : type.name === "string"
                  ? typeof value === "string"
                  : typeof value === "boolean";
        return matches ? undefined : `${path}: expected ${type.name}`;
      };
    case "union": {
      const members = type.members.map(compileMatcher);
      const nonNull = type.members.flatMap((member, i) =>
        member.kind === "scalar" && member.name === "null" ? [] : [i],
      );
      return (value, path) => {
        const errors: string[] = [];
        for (const member of members) {
          const error = member(value, path);
          if (error === undefined) return undefined;
          errors.push(error);
        }
        // Nullable structures keep the useful path without checking them twice.
        return nonNull.length === 1 ? errors[nonNull[0]!] : errors.join(" or ");
      };
    }
    case "array": {
      const element = compileMatcher(type.element);
      return (value, path) => {
        if (!Array.isArray(value)) return `${path}: expected array`;
        for (const [i, item] of value.entries()) {
          const error = element(item, `${path}[${i}]`);
          if (error) return error;
        }
        return undefined;
      };
    }
    case "tuple": {
      const elements = type.elements.map(compileMatcher);
      return (value, path) => {
        if (!Array.isArray(value)) return `${path}: expected array`;
        if (value.length !== elements.length) return `${path}: wrong tuple length`;
        for (const [i, item] of value.entries()) {
          const error = elements[i]!(item, `${path}[${i}]`);
          if (error) return error;
        }
        return undefined;
      };
    }
    case "record": {
      const fields = new Map(type.fields.map((field) => [field.name, compileMatcher(field.type)]));
      const required = type.fields.filter((field) => !field.optional).map((field) => field.name);
      const additional =
        type.additional.kind === "never" ? undefined : compileMatcher(type.additional);
      return (value, path) => {
        if (value === null || typeof value !== "object" || Array.isArray(value))
          return `${path}: expected object`;
        const object = value as Record<string, unknown>;
        for (const name of required) {
          if (!Object.hasOwn(object, name))
            return `${path}[${JSON.stringify(name)}]: required field is missing`;
        }
        for (const key of Object.keys(object)) {
          const member = fields.get(key) ?? additional;
          const memberPath = `${path}[${JSON.stringify(key)}]`;
          if (!member) return `${memberPath}: unexpected field`;
          const error = member(object[key], memberPath);
          if (error) return error;
        }
        return undefined;
      };
    }
    case "proof":
      return (_value, path) => `${path}: JSON does not establish proof membership`;
  }
}

/** A prepared column contract. Values must already be valid JSON. */
export type StructuralColumnValidator = (value: unknown, context: string) => void;

/**
 * Snapshot a declaration for repeated validation within an insertion batch.
 * No global cache: edited declarations must be checked anew on the next batch.
 * Primitive columns remain the responsibility of primitive validation.
 */
export function compileStructuralColumnValidator(column: ColumnDecl): StructuralColumnValidator {
  if (containsNominalType(column))
    throw new Error(
      `Column '${column.name}': external JSON cannot establish nominal proof membership`,
    );
  if (!column.shape) return () => {};
  const match = compileMatcher(declaredColumnType(column));
  const name = column.name;
  return (value, context) => {
    const error = match(value, "$");
    if (error) throw new Error(`${context}, column '${name}': ${error}`);
  };
}

/** Validate before insertion, so no backend can silently drop invalid input rows. */
export function validateStructuralColumn(
  value: unknown,
  column: ColumnDecl,
  context: string,
): void {
  compileStructuralColumnValidator(column)(value, context);
}

/** Check each rule against its published-context contribution, before annotation widening. */
export function validateStructuralHeadAnnotations(
  contributions: ReadonlyMap<Rule, readonly SemanticType[]>,
): void {
  for (const [rule, types] of contributions) {
    for (const [i, annotation] of (rule.head.argTypes ?? []).entries()) {
      if (!annotation?.shape && !annotation?.nominal) continue;
      const declared = declaredColumnType(annotation);
      const mismatch = semanticContractMismatch(types[i]!, declared);
      if (mismatch) {
        const cst = rule.head.args[i]?.$cstNode ?? rule.head.$cstNode;
        throw new AnalyzerError(
          `Predicate '${rule.head.predicate}' column ${i + 1} does not satisfy its ${annotation.nominal ? "nominal" : "structural"} annotation: ${mismatch}`,
          cst?.offset,
          cst?.end,
        );
      }
    }
  }
}

/** Reject before looking at rows, including empty batches and nested nominal types. */
export function rejectNominalInput(decl: Pick<ExtDecl, "predicate" | "columns">): void {
  for (const column of decl.columns)
    if (containsNominalType(column))
      throw new Error(
        `Predicate '${decl.predicate}', column '${column.name}': external JSON cannot establish nominal proof membership`,
      );
}
