import type { ColumnDecl } from "./ast.ts";
import { leanString } from "./record-schema-lean.ts";
import type { TypedProgram } from "./types.ts";
import type { VerificationNode } from "./verification-manifest.ts";

export type StructuralSchema =
  | { kind: "integer" }
  | { kind: "array"; nullable: boolean; element: StructuralSchema }
  | {
      kind: "record";
      fields: { name: string; optional: boolean; nullable: boolean; schema: StructuralSchema }[];
    };
type SchemaValue = Pick<ColumnDecl, "shape" | "type" | "nominal">;
export type StructuralSegment = { field: string } | { index: number };

/** Closed records and arrays with integer leaves. Nullability belongs to each child position. */
export function exportLeanStructuralSchema(
  typed: TypedProgram,
  descriptor: { id: string; predicate: string; column: number },
) {
  const { id, predicate, column } = descriptor;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || id === "value" || /^i\d+$/.test(id))
    throw new Error("Invalid or reserved Lean structural-schema identifier");
  const decl = typed.extDecls.get(predicate);
  if (!decl || !Number.isInteger(column) || column < 0 || column >= decl.columns.length)
    throw new Error("Structural schema export requires a valid input column");
  const selected = decl.columns[column]!;
  if (selected.nullable || !selected.shape)
    throw new Error("Structural schema export requires a non-null record or array root");
  function read(value: SchemaValue): StructuralSchema {
    if (value.nominal) throw new Error("Nominal structural schemas are unsupported");
    const shape = value.shape;
    if (!shape) {
      if (value.type !== "integer") throw new Error("Structural schema leaves must be integers");
      return { kind: "integer" };
    }
    if (shape.$type === "ArrayType")
      return { kind: "array", nullable: !!shape.element.nullable, element: read(shape.element) };
    const seen = new Set<string>();
    return {
      kind: "record",
      fields: shape.fields.map((field) => {
        if (seen.has(field.name)) throw new Error("Duplicate structural schema field");
        seen.add(field.name);
        return {
          name: field.name,
          optional: !!field.optional,
          nullable: !!field.value.nullable,
          schema: read(field.value),
        };
      }),
    };
  }
  const schema = read(selected);
  function encode(schema: StructuralSchema): string {
    switch (schema.kind) {
      case "integer":
        return "Datamog.Structural.Schema.integer";
      case "array":
        return `(Datamog.Structural.Schema.array ${schema.nullable} ${encode(schema.element)})`;
      case "record":
        return `(Datamog.Structural.Schema.record [${schema.fields.map((field) => `(${leanString(field.name)}, ${field.optional}, ${field.nullable}, ${encode(field.schema)})`).join(", ")}])`;
    }
  }
  const source = `def ${id} : Datamog.Structural.Schema :=\n  ${encode(schema)}\n`;
  const paths: { segments: StructuralSegment[]; nullable: boolean; indices: number }[] = [];
  function collect(
    schema: StructuralSchema,
    segments: StructuralSegment[],
    indices: number,
    nullable: boolean,
  ) {
    if (schema.kind === "integer") paths.push({ segments, indices, nullable });
    else if (!nullable) {
      if (schema.kind === "array")
        collect(schema.element, [...segments, { index: indices }], indices + 1, schema.nullable);
      else
        for (const field of schema.fields)
          if (!field.optional)
            collect(field.schema, [...segments, { field: field.name }], indices, field.nullable);
    }
  }
  collect(schema, [], 0, false);
  const goals = paths.map((path, index) => {
    const goalId = `${id}_path${index}`;
    const segments = `[${path.segments.map((segment) => ("field" in segment ? `.field ${leanString(segment.field)}` : `.index i${segment.index}`)).join(", ")}]`;
    const binders = Array.from({ length: path.indices }, (_, i) => `(i${i} : Nat)`).join(" ");
    const statement = `def ${goalId} : Prop :=
  ∀ (value : Datamog.Structural.Value) ${binders},
  Datamog.Structural.accepts ${id} value = true →
  Datamog.Structural.ArrayBounds value ${segments} →
  ∃ result, Datamog.Structural.lookupPath value ${segments} = some result ∧
    Datamog.Structural.leafMatches ${path.nullable} result = true
`;
    return { id: goalId, path, statement };
  });
  const nodes: VerificationNode[] = [
    {
      id,
      kind: "definition",
      statement: { profile: "datamog-structural-integer-v1", ...descriptor, schema, lean: source },
      assumptions: [],
      dependencies: ["StructuralSemantics"],
    },
    ...goals.map(
      (goal): VerificationNode => ({
        id: goal.id,
        kind: "goal",
        theorem: `Datamog.Checked.${goal.id}`,
        statement: {
          profile: "datamog-structural-integer-v1",
          path: goal.path,
          lean: goal.statement,
        },
        assumptions: [],
        dependencies: [id],
      }),
    ),
  ];
  const checker = goals
    .map(({ id }) => `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}`)
    .join("\n");
  return { schema, source, goals, nodes, checker };
}
