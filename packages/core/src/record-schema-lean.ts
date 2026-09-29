import type { TypedProgram } from "./types.ts";
import type { VerificationNode } from "./verification-manifest.ts";

/** Encode Unicode scalar values as data, never as Lean source escapes. */
export function leanString(value: string): string {
  const codes = Array.from(value, (char) => char.codePointAt(0)!);
  if (codes.some((code) => code >= 0xd800 && code <= 0xdfff))
    throw new Error("Lean strings cannot represent unpaired UTF-16 surrogates");
  return `(String.ofList [${codes.map((code) => `Char.ofNat ${code}`).join(", ")}])`;
}

/** Internal export of an elaborated input column; only flat integer records. */
export function exportLeanRecordSchema(
  typed: TypedProgram,
  descriptor: { id: string; predicate: string; column: number },
) {
  const { id, predicate, column } = descriptor;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || id === "fields")
    throw new Error("Invalid or reserved Lean schema identifier");
  const decl = typed.extDecls.get(predicate);
  if (!decl || !Number.isInteger(column) || column < 0 || column >= decl.columns.length)
    throw new Error("Schema export requires a valid input column");
  const selected = decl.columns[column]!;
  if (selected.nullable || selected.nominal || selected.shape?.$type !== "RecordType")
    throw new Error("Schema export requires a non-null flat record");
  const seen = new Set<string>();
  const fields = selected.shape.fields.map((field) => {
    if (seen.has(field.name)) throw new Error("Duplicate schema field");
    seen.add(field.name);
    if (field.value.shape || field.value.nominal || field.value.type !== "integer")
      throw new Error("Schema export supports only integer fields");
    return { name: field.name, optional: !!field.optional, nullable: !!field.value.nullable };
  });
  const source = `def ${id} : List Datamog.IntegerField :=\n  [${fields.map((field) => `⟨${leanString(field.name)}, ${field.optional}, ${field.nullable}⟩`).join(", ")}]\n`;
  const goals = fields.flatMap((field, index) => {
    if (field.optional) return [];
    const goalId = `${id}_field${index}`;
    const witness = field.nullable ? "∃ value," : "∃ n : Datamog.SafeInt,";
    const value = field.nullable ? "value" : "(Datamog.Value.integer n)";
    return [
      {
        id: goalId,
        statement: `def ${goalId} : Prop :=\n  ∀ fields : Datamog.FlatRecord, Datamog.integerRecordMatches ${id} fields = true →\n  ${witness} Datamog.lookupField fields ${leanString(field.name)} = some ${value}\n`,
      },
    ];
  });
  const nodes: VerificationNode[] = [
    {
      id,
      kind: "definition",
      statement: { profile: "datamog-flat-record-v1", ...descriptor, fields, lean: source },
      assumptions: [],
      dependencies: ["RecordLookup"],
    },
    ...goals.map(
      (goal): VerificationNode => ({
        id: goal.id,
        kind: "goal",
        theorem: `Datamog.Checked.${goal.id}`,
        statement: { profile: "datamog-flat-record-v1", lean: goal.statement },
        assumptions: [],
        dependencies: [id],
      }),
    ),
  ];
  const checker = goals
    .map(
      (goal) => `theorem ${goal.id} : Generated.${goal.id} := Proofs.${goal.id}\n#audit ${goal.id}`,
    )
    .join("\n");
  return { source, fields, goals, checker, nodes };
}
