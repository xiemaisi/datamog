import type { TypedProgram } from "./types.ts";
import type { VerificationNode } from "./verification-manifest.ts";

/** Integer-array input schemas, with independently nullable elements. */
export function exportLeanArraySchema(
  typed: TypedProgram,
  descriptor: { id: string; predicate: string; column: number },
) {
  const { id, predicate, column } = descriptor;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || ["values", "index"].includes(id))
    throw new Error("Invalid or reserved Lean array-schema identifier");
  const decl = typed.extDecls.get(predicate);
  if (!decl || !Number.isInteger(column) || column < 0 || column >= decl.columns.length)
    throw new Error("Array schema export requires a valid input column");
  const selected = decl.columns[column]!;
  if (selected.nullable || selected.nominal || selected.shape?.$type !== "ArrayType")
    throw new Error("Array schema export requires a non-null array column");
  const element = selected.shape.element;
  if (element.nominal || element.shape || element.type !== "integer")
    throw new Error("Array schema export supports only integer elements");
  const nullable = !!element.nullable;
  const source = `def ${id} : Bool := ${nullable}\n`;
  const goalId = `${id}_lookup`;
  const conclusion = nullable
    ? "∃ value, Datamog.Arrays.lookupIndex values (Int.ofNat index) = some value"
    : "∃ n : Datamog.SafeInt, Datamog.Arrays.lookupIndex values (Int.ofNat index) = some (.integer n)";
  const statement = `def ${goalId} : Prop :=\n  ∀ (values : List Datamog.Value) (index : Nat),\n  Datamog.Arrays.accepts ${id} values = true → index < values.length →\n  ${conclusion}\n`;
  const nodes: VerificationNode[] = [
    {
      id,
      kind: "definition",
      statement: { profile: "datamog-integer-array-v1", ...descriptor, nullable, lean: source },
      assumptions: [],
      dependencies: ["ArraySemantics"],
    },
    {
      id: goalId,
      kind: "goal",
      theorem: `Datamog.Checked.${goalId}`,
      statement: { profile: "datamog-integer-array-v1", lean: statement },
      assumptions: [],
      dependencies: [id],
    },
  ];
  const checker = `theorem ${goalId} : Generated.${goalId} := Proofs.${goalId}\n#audit ${goalId}`;
  return { source, nullable, statement, checker, nodes };
}
