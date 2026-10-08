import type { TypedProgram } from "./types.ts";
import type { VerificationNode } from "./verification-manifest.ts";

/** Nested integer-array schemas, with a nullability flag at every dimension. */
export function exportLeanNestedArraySchema(
  typed: TypedProgram,
  descriptor: { id: string; predicate: string; column: number },
) {
  const { id, predicate, column } = descriptor;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || ["value", "path"].includes(id))
    throw new Error("Invalid or reserved Lean array-schema identifier");
  const decl = typed.extDecls.get(predicate);
  if (!decl || !Number.isInteger(column) || column < 0 || column >= decl.columns.length)
    throw new Error("Array schema export requires a valid input column");
  const selected = decl.columns[column]!;
  if (selected.nullable || selected.nominal || selected.shape?.$type !== "ArrayType")
    throw new Error("Array schema export requires a non-null array column");
  const flags: boolean[] = [];
  let element = selected.shape.element;
  while (true) {
    if (element.nominal) throw new Error("Nominal array elements are unsupported");
    flags.push(!!element.nullable);
    if (!element.shape) {
      if (element.type !== "integer") throw new Error("Nested array leaves must be integers");
      break;
    }
    if (element.shape.$type !== "ArrayType")
      throw new Error("Nested arrays cannot contain records");
    element = element.shape.element;
  }
  const source = `def ${id} : List Bool := [${flags.join(", ")}]\n`;
  const goalId = `${id}_lookup`;
  const statement = `def ${goalId} : Prop :=
  ∀ (value : Datamog.NestedArrays.Value) (path : List Nat),
  Datamog.NestedArrays.accepts ${id} false value = true →
  Datamog.NestedArrays.Bounds value path → path.length = ${flags.length} →
  ∃ result, Datamog.NestedArrays.lookupPath value path = some result ∧
    Datamog.NestedArrays.accepts [] ${flags.at(-1)} result = true
`;
  const nodes: VerificationNode[] = [
    {
      id,
      kind: "definition",
      statement: { profile: "datamog-nested-array-v1", ...descriptor, flags, lean: source },
      assumptions: [],
      dependencies: ["NestedArraySemantics"],
    },
    {
      id: goalId,
      kind: "goal",
      theorem: `Datamog.Checked.${goalId}`,
      statement: { profile: "datamog-nested-array-v1", lean: statement },
      assumptions: [],
      dependencies: [id],
    },
  ];
  const checker = `theorem ${goalId} : Generated.${goalId} := Proofs.${goalId}\n#audit ${goalId}`;
  return { source, flags, statement, checker, nodes };
}
