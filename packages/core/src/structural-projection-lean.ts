import { type Expression, type HeadTerm, isFloatLiteral } from "./ast.ts";
import { leanString } from "./record-schema-lean.ts";
import { type StructuralSchema, exportLeanStructuralSchema } from "./structural-schema-lean.ts";
import type { TypedProgram } from "./types.ts";
import type { VerificationNode } from "./verification-manifest.ts";

/** Projected output columns from one input atom: a structural column plus integer indices.
 * Coverage defaults to true; false requests only output soundness for partial paths.
 */
export function exportLeanStructuralProjection(
  typed: TypedProgram,
  descriptor: { id: string; predicate: string; coverage?: boolean },
) {
  const { id, predicate } = descriptor;
  if (
    !/^[A-Za-z][A-Za-z0-9_]*$/.test(id) ||
    ["input", "value", "result"].includes(id) ||
    /^(i|result)\d+$/.test(id)
  )
    throw new Error("Invalid or reserved Lean projection identifier");
  const rules = typed.rules.get(predicate);
  if (!rules || rules.length !== 1 || typed.extDecls.has(predicate))
    throw new Error("Structural projection requires exactly one derived rule");
  if (typed.constraints.length || typed.maximalPredicates.size)
    throw new Error("Structural projection does not support constraints or parity");
  const rule = rules[0]!;
  if (!rule.head.args.length || rule.head.refinements?.length || rule.head.argTypes?.some(Boolean))
    throw new Error("Structural projection requires unannotated projected outputs");
  const atoms = rule.body.filter((element) => element.$type === "Literal");
  const body = atoms[0];
  if (
    atoms.length !== 1 ||
    body?.$type !== "Literal" ||
    body.negated ||
    body.maximal ||
    body.proofVar ||
    !body.args.length ||
    body.args.some((arg) => arg.$type !== "Variable")
  )
    throw new Error(
      "Structural projection requires one positive input atom with variable arguments",
    );
  const input = typed.extDecls.get(body.predicate);
  if (!input || input.columns.length !== body.args.length || typed.rules.has(body.predicate))
    throw new Error("Structural projection requires an extensional input");
  const variables = body.args.map((arg) => {
    if (arg.$type !== "Variable") throw new Error("Expected input variable");
    return arg.name;
  });
  if (new Set(variables).size !== variables.length)
    throw new Error("Structural projection requires distinct input variables");
  const readPath = (arg: HeadTerm) => {
    const path: (string | number | { column: number })[] = [];
    let term = arg as Expression;
    while (term.$type === "Subscript") {
      if (term.index.$type === "StringLiteral") path.unshift(term.index.value);
      else if (
        term.index.$type === "NumberLiteral" &&
        Number.isSafeInteger(term.index.value) &&
        term.index.value >= 0
      )
        path.unshift(term.index.value);
      else if (term.index.$type === "Variable" && variables.includes(term.index.name))
        path.unshift({ column: variables.indexOf(term.index.name) });
      else
        throw new Error(
          "Structural projection supports literal keys/indices and input integer index variables",
        );
      term = term.object;
    }
    if (term.$type !== "Variable" || !variables.includes(term.name))
      throw new Error("Structural projection head must look up the input variable");
    return { path, rootColumn: variables.indexOf(term.name) };
  };
  const paths = rule.head.args.map(readPath);
  const firstLookup = paths.find(({ path }) => path.length);
  if (!firstLookup) throw new Error("Structural projection requires at least one lookup output");
  const rootColumn = firstLookup.rootColumn;
  if (paths.some((projection) => projection.path.length && projection.rootColumn !== rootColumn))
    throw new Error("Structural projections must share one structural input column");
  const indexColumns = input.columns.flatMap((column, index) => {
    if (index === rootColumn) return [];
    if (column.type !== "integer" || column.nullable || column.shape || column.nominal)
      throw new Error("Structural projection additional input columns must be non-null integers");
    return [index];
  });
  const filterTerm = (term: Expression): string => {
    if (term.$type === "Variable") {
      const column = variables.indexOf(term.name);
      if (indexColumns.includes(column)) return `i${column}.val`;
    }
    if (term.$type === "NumberLiteral" && !isFloatLiteral(term) && Number.isSafeInteger(term.value))
      return `(${term.value} : Int)`;
    if (
      term.$type === "UnaryExpr" &&
      term.op === "-" &&
      term.operand.$type === "NumberLiteral" &&
      !isFloatLiteral(term.operand) &&
      Number.isSafeInteger(term.operand.value)
    )
      return `(${-term.operand.value} : Int)`;
    throw new Error(
      "Structural projection filters require bound non-null integer inputs or safe integer literals",
    );
  };
  if (
    paths.some(({ path }) =>
      path.some((part) => typeof part === "object" && !indexColumns.includes(part.column)),
    )
  )
    throw new Error("Structural projection indices must use integer input columns");
  const schema = exportLeanStructuralSchema(typed, {
    id: `${id}Schema`,
    predicate: body.predicate,
    column: rootColumn,
  });
  const coverage = descriptor.coverage ?? true;
  const projections = paths.map(({ path, rootColumn: column }) => {
    if (!path.length) {
      if (!indexColumns.includes(column))
        throw new Error("Only non-null integer input columns can be carried to outputs");
      return { kind: "input" as const, column, path, nullable: false, leanPath: null };
    }
    // Soundness follows any declared integer path. Coverage needs every field
    // and container along every output path to guarantee presence.
    let selected: StructuralSchema = schema.schema;
    let nullable = false;
    let guaranteed = true;
    for (const part of path) {
      if (nullable) guaranteed = false;
      if (typeof part === "string" && selected.kind === "record") {
        const field = selected.fields.find((field) => field.name === part);
        if (!field) throw new Error("Structural projection field is not declared");
        guaranteed &&= !field.optional;
        nullable = field.nullable;
        selected = field.schema;
      } else if (typeof part !== "string" && selected.kind === "array") {
        nullable = selected.nullable;
        selected = selected.element;
      } else throw new Error("Structural projection path does not match its schema");
    }
    if (selected.kind !== "integer")
      throw new Error("Structural projection requires an integer leaf path");
    if (coverage && !guaranteed)
      throw new Error(
        "Structural projection coverage requires a guaranteed integer leaf path for every output",
      );
    const leanPath = `[${path.map((part) => (typeof part === "string" ? `.field ${leanString(part)}` : `.index ${typeof part === "number" ? part : `i${part.column}.val.toNat`}`)).join(", ")}]`;
    return { kind: "lookup" as const, path, nullable, leanPath };
  });
  const lookupFilters: { output: number; operator: string; literal: string }[] = [];
  const lookupOrder: { kind: "literal" | "pair"; index: number }[] = [];
  const lookupPairs: { left: number; right: number; operator: string }[] = [];
  const lookupOutput = (term: Expression): number | undefined => {
    const operand =
      term.$type === "FunctionCall" ? (term.args[0] as Expression | undefined) : undefined;
    if (
      term.$type !== "FunctionCall" ||
      !["as_integer", "as_integer.value"].includes(term.name) ||
      term.args.length !== 1 ||
      operand?.$type !== "Subscript"
    )
      return undefined;
    const selected = readPath(operand);
    const output = paths.findIndex((path) => JSON.stringify(path) === JSON.stringify(selected));
    if (output < 0 || projections[output]!.nullable)
      throw new Error("Lookup comparison requires a projected non-null integer leaf");
    return output;
  };
  const comparison = (left: Expression, operator: string, right: Expression): string | null => {
    const output = lookupOutput(left);
    if (output === undefined) return `(${filterTerm(left)} ${operator} ${filterTerm(right)})`;
    const rightOutput = lookupOutput(right);
    if (rightOutput !== undefined) {
      lookupOrder.push({ kind: "pair", index: lookupPairs.length });
      lookupPairs.push({ left: output, right: rightOutput, operator });
      return null;
    }
    if (right.$type !== "NumberLiteral" && right.$type !== "UnaryExpr")
      throw new Error(
        "Lookup comparison requires an integer literal or projected integer lookup on the right",
      );
    lookupOrder.push({ kind: "literal", index: lookupFilters.length });
    lookupFilters.push({ output, operator, literal: filterTerm(right) });
    return null;
  };
  const filters = rule.body
    .filter((element) => element !== body)
    .map((element) => {
      if (element.$type === "Equality") return comparison(element.left, "=", element.expr);
      if (element.$type === "Filter" && !element.negated && element.expr.$type === "BinaryExpr") {
        const operators: Record<string, string> = {
          "<": "<",
          "<=": "≤",
          ">": ">",
          ">=": "≥",
          "=": "=",
          "<>": "≠",
          "!=": "≠",
        };
        const expr = element.expr;
        if (Object.hasOwn(operators, expr.op))
          return comparison(expr.left, operators[expr.op]!, expr.right);
      }
      throw new Error("Structural projection supports only positive integer comparison filters");
    })
    .filter((filter): filter is string => filter !== null);
  // SafeInt quantifies the full admitted integer domain. Only used indices get
  // sign guards; converting a negative Int to Nat without these would select 0.
  const names = input.columns.map((_, column) => (column === rootColumn ? "value" : `i${column}`));
  const types = input.columns.map((_, column) =>
    column === rootColumn ? "Datamog.Structural.Value" : "Datamog.SafeInt",
  );
  const inputType = [...types, "Prop"].join(" → ");
  const inputArgs = names.join(" ");
  const binders = names.map((name, column) => `(${name} : ${types[column]})`).join(" ");
  const usedIndices = indexColumns.filter((column) =>
    projections.some(({ path }) =>
      path.some((part) => typeof part === "object" && part.column === column),
    ),
  );
  const guards =
    filters.map((filter) => `${filter} → `).join("") +
    usedIndices.map((column) => `0 ≤ i${column}.val → `).join("");
  const results = projections.map((_, index) =>
    projections.length === 1 ? "result" : `result${index}`,
  );
  // Group by the selected output, preserving first occurrence and comparison
  // order. Different outputs need independent integer witnesses.
  const valueProperties = [...new Set(lookupFilters.map((filter) => filter.output))].map(
    (output) =>
      `(∃ (n : Datamog.SafeInt), ${results[output]} = Datamog.Structural.Value.scalar (.integer n) ∧ ${lookupFilters
        .filter((filter) => filter.output === output)
        .map((filter) => `n.val ${filter.operator} ${filter.literal}`)
        .join(" ∧ ")})`,
  );
  valueProperties.push(
    ...lookupPairs.map(
      ({ left, right, operator }) =>
        `(∃ (n m : Datamog.SafeInt), ${results[left]} = Datamog.Structural.Value.scalar (.integer n) ∧ ${results[right]} = Datamog.Structural.Value.scalar (.integer m) ∧ n.val ${operator} m.val)`,
    ),
  );
  const valueProperty =
    valueProperties.length > 1 ? `(${valueProperties.join(" ∧ ")})` : (valueProperties[0] ?? null);
  // This universal premise says what a successful integer lookup must satisfy;
  // it does not assert that a lookup succeeds. Schema membership and bounds
  // supply existence in the coverage proof.
  const lookupCondition = lookupOrder
    .map(({ kind, index }) => {
      if (kind === "literal") {
        const filter = lookupFilters[index]!;
        return `(∀ (n : Datamog.SafeInt), Datamog.Structural.lookupPath value ${projections[filter.output]!.leanPath} = some (Datamog.Structural.Value.scalar (.integer n)) → n.val ${filter.operator} ${filter.literal}) → `;
      }
      const { left, right, operator } = lookupPairs[index]!;
      return `(∀ (n m : Datamog.SafeInt), Datamog.Structural.lookupPath value ${projections[left]!.leanPath} = some (Datamog.Structural.Value.scalar (.integer n)) → Datamog.Structural.lookupPath value ${projections[right]!.leanPath} = some (Datamog.Structural.Value.scalar (.integer m)) → n.val ${operator} m.val) → `;
    })
    .join("");
  const resultArgs = results.join(" ");
  const outputType = [...projections.map(() => "Datamog.Structural.Value"), "Prop"].join(" → ");
  const lookups = projections
    .map((projection, index) =>
      projection.kind === "input"
        ? `${results[index]} = Datamog.Structural.Value.scalar (.integer i${projection.column}) → `
        : `Datamog.Structural.lookupPath value ${projection.leanPath} = some ${results[index]} → `,
    )
    .join("");
  const bounds = projections
    .filter((projection) => projection.kind === "lookup")
    .map(({ leanPath }) => `Datamog.Structural.ArrayBounds value ${leanPath} →`)
    .join("\n  ");
  const typeMatches = projections
    .map(
      ({ nullable }, index) =>
        `Datamog.Structural.leafMatches ${nullable} ${results[index]} = true`,
    )
    .join(" ∧ ");
  const matches = valueProperty ? `${typeMatches} ∧ ${valueProperty}` : typeMatches;
  const carriedEqualities = projections.flatMap((projection, index) =>
    projection.kind === "input"
      ? [`${results[index]} = Datamog.Structural.Value.scalar (.integer i${projection.column})`]
      : [],
  );
  const coverageMatches = [matches, ...carriedEqualities].join(" ∧ ");
  const relation = `inductive ${id} (input : ${inputType}) : ${outputType} where
  | rule {${inputArgs} ${resultArgs}} : input ${inputArgs} → ${guards}${lookups}${valueProperty ? `${valueProperty} → ` : ""}${id} input ${resultArgs}
`;
  const goalId = `${id}_coverage`;
  const statement = `def ${goalId} : Prop :=
  ∀ (input : ${inputType}) ${binders},
  input ${inputArgs} → Datamog.Structural.accepts ${id}Schema value = true →
  ${guards}${lookupCondition}${bounds}
  ∃ ${resultArgs}, ${id} input ${resultArgs} ∧ ${coverageMatches}
`;
  const soundnessId = `${id}_soundness`;
  const soundness = `def ${soundnessId} : Prop :=
  ∀ (input : ${inputType}),
  (∀ ${inputArgs}, input ${inputArgs} → Datamog.Structural.accepts ${id}Schema value = true) →
  ∀ ${resultArgs}, ${id} input ${resultArgs} → ${matches}
`;
  const goals = [
    ...(coverage ? [{ id: goalId, statement }] : []),
    { id: soundnessId, statement: soundness },
  ];
  const nodes: VerificationNode[] = [
    schema.nodes[0]!,
    {
      id,
      kind: "definition",
      statement: {
        profile: "datamog-structural-integer-v1",
        ...descriptor,
        inputPredicate: body.predicate,
        rootColumn,
        indexColumns,
        usedIndices,
        filters,
        lookupFilters,
        lookupPairs,
        lookupOrder,
        projections,
        lean: relation,
      },
      assumptions: [],
      dependencies: [`${id}Schema`],
    },
    ...goals.map(
      (goal): VerificationNode => ({
        id: goal.id,
        kind: "goal",
        theorem: `Datamog.Checked.${goal.id}`,
        statement: { profile: "datamog-structural-integer-v1", lean: goal.statement },
        assumptions: [],
        dependencies: [id],
      }),
    ),
  ];
  const checker = goals
    .map(({ id }) => `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}`)
    .join("\n");
  return {
    source: schema.source + relation + goals.map((goal) => goal.statement).join("\n"),
    projections,
    rootColumn,
    indexColumns,
    nodes,
    checker,
  };
}
