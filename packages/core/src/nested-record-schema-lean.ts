import type { ColumnDecl } from "./ast.ts";
import { leanString } from "./record-schema-lean.ts";
import type { TypedProgram } from "./types.ts";
import type { VerificationNode } from "./verification-manifest.ts";

type RecordShape = Extract<NonNullable<ColumnDecl["shape"]>, { $type: "RecordType" }>;
export interface NestedSchemaField {
  name: string;
  optional: boolean;
  nullable: boolean;
  children: NestedSchemaField[] | null;
}

/** Closed nested records with integer leaves; no arrays or nominal membership. */
export function exportLeanNestedRecordSchema(
  typed: TypedProgram,
  descriptor: { id: string; predicate: string; column: number },
) {
  const { id, predicate, column } = descriptor;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || id === "value")
    throw new Error("Invalid or reserved Lean nested-schema identifier");
  const decl = typed.extDecls.get(predicate);
  if (!decl || !Number.isInteger(column) || column < 0 || column >= decl.columns.length)
    throw new Error("Nested schema export requires a valid input column");
  const selected = decl.columns[column]!;
  if (selected.nullable || selected.nominal || selected.shape?.$type !== "RecordType")
    throw new Error("Nested schema export requires a non-null record column");
  function read(shape: RecordShape): NestedSchemaField[] {
    const seen = new Set<string>();
    return shape.fields.map((field) => {
      if (seen.has(field.name)) throw new Error("Duplicate nested schema field");
      seen.add(field.name);
      const value = field.value;
      if (
        value.nominal ||
        (value.shape ? value.shape.$type !== "RecordType" : value.type !== "integer")
      )
        throw new Error("Nested schema export supports only records and integer leaves");
      return {
        name: field.name,
        optional: !!field.optional,
        nullable: !!value.nullable,
        children: value.shape ? read(value.shape as RecordShape) : null,
      };
    });
  }
  const fields = read(selected.shape);
  function encode(fields: NestedSchemaField[]): string {
    return `(Datamog.Nested.Schema.record [${fields.map((field) => `(${leanString(field.name)}, ${field.optional}, ${field.nullable}, ${field.children === null ? "Datamog.Nested.Schema.integer" : encode(field.children)})`).join(", ")}])`;
  }
  const source = `def ${id} : Datamog.Nested.Schema :=\n  ${encode(fields)}\n`;
  const paths: { keys: string[]; nullable: boolean }[] = [];
  function collect(fields: NestedSchemaField[], prefix: string[]) {
    for (const field of fields) {
      if (field.optional) continue;
      const keys = [...prefix, field.name];
      if (field.children === null) paths.push({ keys, nullable: field.nullable });
      else if (!field.nullable) collect(field.children, keys);
    }
  }
  collect(fields, []);
  const goals = paths.map((path, index) => {
    const goalId = `${id}_path${index}`;
    const keys = `[${path.keys.map(leanString).join(", ")}]`;
    const conclusion = path.nullable
      ? `∃ result, Datamog.Nested.lookupPath value ${keys} = some result`
      : `∃ n : Datamog.SafeInt, Datamog.Nested.lookupPath value ${keys} = some (.scalar (.integer n))`;
    return {
      id: goalId,
      path,
      statement: `def ${goalId} : Prop :=\n  ∀ value : Datamog.Nested.Value, Datamog.Nested.accepts ${id} value = true →\n  ${conclusion}\n`,
    };
  });
  const nodes: VerificationNode[] = [
    {
      id,
      kind: "definition",
      statement: {
        profile: "datamog-nested-record-v1",
        ...descriptor,
        fields,
        lean: source,
      },
      assumptions: [],
      dependencies: ["NestedRecords"],
    },
    ...goals.map(
      (goal): VerificationNode => ({
        id: goal.id,
        kind: "goal",
        theorem: `Datamog.Checked.${goal.id}`,
        statement: { profile: "datamog-nested-record-v1", path: goal.path, lean: goal.statement },
        assumptions: [],
        dependencies: [id],
      }),
    ),
  ];
  const checker = goals
    .map(({ id }) => `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}`)
    .join("\n");
  return { fields, source, goals, nodes, checker };
}
