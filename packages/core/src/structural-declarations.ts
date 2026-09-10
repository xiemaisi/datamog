/** Structural input-column declarations and validation of their JSON values. */
import { AnalyzerError } from "./analyzer.ts";
import type { ColumnDecl, Rule } from "./ast.ts";
import {
  NEVER,
  type SemanticType,
  fromPrimitiveType,
  isSemanticSubtype,
  normalizeType,
  scalarType,
  unionType,
} from "./semantic-type.ts";

type Shape = NonNullable<ColumnDecl["shape"]>;
type TypeValue = Extract<Shape, { $type: "ArrayType" }>["element"];

function valueType(value: TypeValue): SemanticType {
  const type = value.shape ? shapeType(value.shape) : fromPrimitiveType(value.type!);
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
  column: Pick<ColumnDecl, "type" | "shape" | "nullable">,
): SemanticType {
  const type = column.shape ? shapeType(column.shape) : fromPrimitiveType(column.type ?? "string");
  return column.nullable ? unionType(type, scalarType("null")) : type;
}

/** First structural mismatch, with a JSON path. Input must already be valid JSON. */
function mismatch(type: SemanticType, value: unknown, path: string): string | undefined {
  switch (type.kind) {
    case "value":
      return undefined;
    case "never":
      return `${path}: no value is permitted`;
    case "scalar": {
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
    }
    case "union": {
      const errors = type.members.map((member) => mismatch(member, value, path));
      if (errors.some((error) => error === undefined)) return undefined;
      // Nullable structures should report the useful structural path, rather
      // than obscure it with the failed null alternative.
      const nonNull = type.members.filter(
        (member) => member.kind !== "scalar" || member.name !== "null",
      );
      return nonNull.length === 1 ? mismatch(nonNull[0]!, value, path) : errors.join(" or ");
    }
    case "array":
    case "tuple": {
      if (!Array.isArray(value)) return `${path}: expected array`;
      if (type.kind === "tuple" && value.length !== type.elements.length)
        return `${path}: wrong tuple length`;
      for (const [i, item] of value.entries()) {
        const error = mismatch(
          type.kind === "array" ? type.element : type.elements[i]!,
          item,
          `${path}[${i}]`,
        );
        if (error) return error;
      }
      return undefined;
    }
    case "record": {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return `${path}: expected object`;
      const object = value as Record<string, unknown>;
      const fields = new Map(type.fields.map((field) => [field.name, field]));
      for (const field of type.fields) {
        if (!field.optional && !Object.hasOwn(object, field.name))
          return `${path}[${JSON.stringify(field.name)}]: required field is missing`;
      }
      for (const key of Object.keys(object)) {
        const field = fields.get(key);
        const memberPath = `${path}[${JSON.stringify(key)}]`;
        if (!field && type.additional.kind === "never") return `${memberPath}: unexpected field`;
        const error = mismatch(field?.type ?? type.additional, object[key], memberPath);
        if (error) return error;
      }
      return undefined;
    }
    case "proof":
      return `${path}: JSON does not establish proof membership`;
  }
}

/** Validate before insertion, so no backend can silently drop invalid input rows. */
export function validateStructuralColumn(
  value: unknown,
  column: ColumnDecl,
  context: string,
): void {
  if (!column.shape) return;
  const error = mismatch(declaredColumnType(column), value, "$");
  if (error) throw new Error(`${context}, column '${column.name}': ${error}`);
}

/** Check each rule against its published-context contribution, before annotation widening. */
export function validateStructuralHeadAnnotations(
  contributions: ReadonlyMap<Rule, readonly SemanticType[]>,
): void {
  for (const [rule, types] of contributions) {
    for (const [i, annotation] of (rule.head.argTypes ?? []).entries()) {
      if (!annotation?.shape) continue;
      const declared = declaredColumnType(annotation);
      if (!isSemanticSubtype(types[i]!, declared)) {
        const cst = rule.head.args[i]?.$cstNode ?? rule.head.$cstNode;
        throw new AnalyzerError(
          `Predicate '${rule.head.predicate}' column ${i + 1} does not satisfy its structural annotation`,
          cst?.offset,
          cst?.end,
        );
      }
    }
  }
}
