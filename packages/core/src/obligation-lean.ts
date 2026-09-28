/** Optional Lean source export. No Lean executable or filesystem dependency. */
import { isFloatLiteral } from "./ast.ts";
import type { LogicalExpression } from "./obligation-ir.ts";
import type { LogicalObligation } from "./obligations.ts";
import type { TypedProgram } from "./types.ts";
import { type VerificationNode, canonicalVerificationJson } from "./verification-manifest.ts";

function identifier(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    throw new Error(`Invalid Lean declaration name: ${name}`);
  return name;
}

/** Export a local abstract goal as a Prop, retaining every premise of the IR. */
export function exportLeanObligation(goal: LogicalObligation, name: string): string {
  identifier(name);
  const statement = goal.statement;
  if (!statement) throw new Error(`Unsupported Lean goal: ${goal.unsupportedReason}`);
  if (statement.profile !== "datamog-integer-v1") throw new Error("Unsupported Lean profile");
  const names = new Map(
    statement.variables.map((v, i) => [v.name, { name: `v${i}`, sort: v.sort }]),
  );
  if (names.size !== statement.variables.length) throw new Error("Duplicate logical variable");
  const expr = (e: LogicalExpression): string => {
    switch (e.kind) {
      case "integer":
        if (!/^-?(0|[1-9][0-9]*)$/.test(e.value)) throw new Error("Invalid integer literal");
        return `(${e.value} : Int)`;
      case "boolean":
        return e.value ? "True" : "False";
      case "variable": {
        const variable = names.get(e.name);
        if (!variable || variable.sort !== e.sort)
          throw new Error(`Unbound or mistyped variable: ${e.name}`);
        return variable.name;
      }
      case "negate":
        return `(-${expr(e.operand)})`;
      case "not":
        return `(¬ ${expr(e.operand)})`;
      case "junction":
        return e.operands.length === 0
          ? e.op === "and"
            ? "True"
            : "False"
          : `(${e.operands.map(expr).join(e.op === "and" ? " ∧ " : " ∨ ")})`;
      case "boolean-equality":
        return `(${expr(e.left)} ↔ ${expr(e.right)})`;
      case "comparison":
        return `(${expr(e.left)} ${e.op} ${expr(e.right)})`;
      case "arithmetic":
        return e.op === "trunc-div"
          ? `(Datamog.truncDiv ${expr(e.left)} ${expr(e.right)})`
          : `(${expr(e.left)} ${e.op} ${expr(e.right)})`;
    }
  };
  const binders = statement.variables
    .map((v, i) => `(v${i} : ${v.sort === "integer" ? "Int" : "Prop"})`)
    .join(" ");
  const body = [...statement.domains, ...statement.hypotheses, statement.conclusion]
    .map(expr)
    .join(" →\n  ");
  // Source names never enter Lean syntax; this also avoids keyword/name capture.
  return `def ${name} : Prop :=\n  ${binders ? `∀ ${binders},\n  ` : ""}${body}\n`;
}

/**
 * Spike fragment: one positive (possibly self-recursive) relation, over non-null
 * integers, with variable-only body atoms, simple integer order guards, and
 * variable or variable-plus-integer heads. Other computed terms, derived calls, mutual recursion, negation,
 * constraints and aggregates are rejected explicitly.
 * Inputs are arbitrary relations over SafeInt; finite derivations form the LFP.
 */
export function exportLeanRelation(typed: TypedProgram, predicate: string, name: string): string {
  return buildLeanRelation(typed, predicate, name).source;
}

function buildLeanRelation(typed: TypedProgram, predicate: string, name: string) {
  identifier(name);
  const rules = typed.rules.get(predicate);
  if (!rules?.length) throw new Error("Lean relation has no defining rules");
  if (typed.constraints.length || typed.maximalPredicates.size)
    throw new Error("Unsupported Lean relation constraints or parity");
  const inputs = new Map<string, number>();
  const relationType = (p: string) => {
    const columns = typed.columnTypes.get(p);
    const nullable = typed.nullness.publishedNullness.get(p);
    if (!columns || !nullable || columns.some((c) => c !== "integer") || nullable.some(Boolean)) {
      throw new Error("Lean relation requires non-null integer columns");
    }
    return [...columns.map(() => "Datamog.SafeInt"), "Prop"].join(" → ");
  };
  for (const rule of rules) {
    if (rule.head.refinements?.length) throw new Error("Unsupported Lean relation refinement");
    for (const atom of rule.body) {
      if (atom.$type === "Filter" && !atom.negated) continue;
      if (atom.$type !== "Literal" || atom.negated)
        throw new Error("Unsupported Lean relation body");
      if (atom.predicate !== predicate) {
        if (!typed.extDecls.has(atom.predicate))
          throw new Error("Unsupported Lean derived dependency");
        if (!inputs.has(atom.predicate)) inputs.set(atom.predicate, inputs.size);
      }
    }
  }
  const params = [...inputs].map(([p, i]) => `(input${i} : ${relationType(p)})`).join(" ");
  const result = `${name}${[...inputs.values()].map((i) => ` input${i}`).join("")}`;
  const constructors = rules.map((rule, i) => {
    const variables = new Map<string, string>();
    const computed: string[] = [];
    const defined: string[] = [];
    const variable = (name: string) => {
      if (!variables.has(name)) variables.set(name, `v${variables.size}`);
      return variables.get(name)!;
    };
    const terms = (args: typeof rule.head.args, head = false) =>
      args
        .map((arg) => {
          if (arg.$type === "Variable") return variable(arg.name);
          if (
            head &&
            arg.$type === "BinaryExpr" &&
            arg.op === "+" &&
            arg.left.$type === "Variable" &&
            arg.right.$type === "NumberLiteral" &&
            !isFloatLiteral(arg.right) &&
            Number.isSafeInteger(arg.right.value)
          ) {
            const input = variable(arg.left.name);
            const output = `w${computed.length}`;
            computed.push(output);
            // A bounded output witness enforces head definedness. Coverage must
            // construct that witness; overflow has no constructor instance.
            defined.push(`(${output}.val = ${input}.val + (${arg.right.value} : Int))`);
            return output;
          }
          throw new Error("Unsupported Lean relation term");
        })
        .join(" ");
    const head = `${result} ${terms(rule.head.args, true)}`.trim();
    // Guard variables must be supplied by positive relation atoms. This keeps
    // comparisons total over SafeInt, with no null or undefined cases omitted.
    const bound = new Set(
      rule.body.flatMap((atom) =>
        atom.$type === "Literal" && !atom.negated
          ? atom.args.flatMap((arg) => (arg.$type === "Variable" ? [arg.name] : []))
          : [],
      ),
    );
    const guardTerm = (term: (typeof rule.head.args)[number]): string => {
      if (term.$type === "Variable" && bound.has(term.name)) return `${variable(term.name)}.val`;
      if (
        term.$type === "NumberLiteral" &&
        !isFloatLiteral(term) &&
        Number.isSafeInteger(term.value)
      )
        return `(${term.value} : Int)`;
      if (
        term.$type === "UnaryExpr" &&
        term.op === "-" &&
        term.operand.$type === "NumberLiteral" &&
        !isFloatLiteral(term.operand) &&
        Number.isSafeInteger(term.operand.value)
      )
        return `(${-term.operand.value} : Int)`;
      throw new Error("Unsupported Lean relation guard term");
    };
    const body = rule.body.map((atom) => {
      if (atom.$type === "Filter" && !atom.negated) {
        const expr = atom.expr;
        const operators: Record<string, string> = { "<": "<", "<=": "≤", ">": ">", ">=": "≥" };
        if (expr.$type !== "BinaryExpr" || !Object.hasOwn(operators, expr.op))
          throw new Error("Unsupported Lean relation guard");
        return `(${guardTerm(expr.left)} ${operators[expr.op]} ${guardTerm(expr.right)})`;
      }
      if (atom.$type !== "Literal") throw new Error("Unsupported Lean relation body");
      const callee = atom.predicate === predicate ? result : `input${inputs.get(atom.predicate)}`;
      return `(${callee} ${terms(atom.args)})`;
    });
    const binders = [...variables.values(), ...computed]
      .map((v) => `(${v} : Datamog.SafeInt)`)
      .join(" ");
    return `  | rule${i} ${binders} : ${[...body, ...defined, head].join(" → ")}`;
  });
  return {
    source: `inductive ${name} ${params} : ${relationType(predicate)} where\n${constructors.join("\n")}\n`,
    inputs: [...inputs].map(([predicate, index]) => ({
      predicate,
      name: `input${index}`,
      arity: typed.columnTypes.get(predicate)!.length,
    })),
    params,
    application: result,
    arity: typed.columnTypes.get(predicate)!.length,
  };
}

/** Internal relation law descriptor. Columns are zero-based positional indices.
 * Unselected non-key columns vary independently in the two tuples.
 * Empty keys mean global uniqueness; outputs must be nonempty and disjoint.
 */
export interface UniquenessClaim {
  id: string;
  predicate: string;
  relationName: string;
  keyColumns: readonly number[];
  outputColumns: readonly number[];
}

/** Generate statements and fixed-project checker/manifest registrations together.
 * Produces no proof. A refutation registers the negation as its own goal.
 * Names live in Datamog.Generated / Proofs / Checked, as in the optional project.
 */
export function exportLeanUniqueness(
  typed: TypedProgram,
  claim: UniquenessClaim,
  polarity: "prove" | "refute" = "prove",
) {
  identifier(claim.id);
  identifier(claim.relationName);
  if (claim.id === claim.relationName || /^(input[0-9]+|[vw][0-9]+)$/.test(claim.relationName))
    throw new Error("Conflicting Lean uniqueness declaration name");
  if (polarity !== "prove" && polarity !== "refute") throw new Error("Invalid proof polarity");
  const relation = buildLeanRelation(typed, claim.predicate, claim.relationName);
  const validate = (columns: readonly number[]) => {
    if (
      new Set(columns).size !== columns.length ||
      columns.some((column) => !Number.isInteger(column) || column < 0 || column >= relation.arity)
    )
      throw new Error("Invalid uniqueness column selection");
    return [...columns].sort((a, b) => a - b);
  };
  const keys = validate(claim.keyColumns);
  const outputs = validate(claim.outputColumns);
  if (!outputs.length || outputs.some((column) => keys.includes(column)))
    throw new Error("Uniqueness outputs must be nonempty and disjoint from keys");
  const left = Array.from({ length: relation.arity }, (_, i) => `v${i}`);
  const right = left.map((v, i) => (keys.includes(i) ? v : `w${i}`));
  const variables = [...new Set([...left, ...right])];
  const binders = variables.map((v) => `(${v} : Datamog.SafeInt)`).join(" ");
  const conclusion = outputs.map((i) => `${left[i]} = ${right[i]}`).join(" ∧ ");
  const statement = `def ${claim.id} : Prop :=\n  ∀ ${[relation.params, binders].filter(Boolean).join(" ")},\n  ${relation.application} ${left.join(" ")} → ${relation.application} ${right.join(" ")} → ${conclusion}\n`;
  return registerLeanClaim(
    { ...claim, keyColumns: keys, outputColumns: outputs },
    relation,
    statement,
    polarity,
  );
}

function registerLeanClaim<T extends { id: string; relationName: string; predicate: string }>(
  claim: T,
  relation: ReturnType<typeof buildLeanRelation>,
  statement: string,
  polarity: "prove" | "refute",
) {
  const proofName = polarity === "prove" ? claim.id : `${claim.id}_refuted`;
  if (proofName === claim.relationName) throw new Error("Conflicting Lean proof name");
  const expected = `${polarity === "refute" ? "¬ " : ""}Generated.${claim.id}`;
  const nodes: VerificationNode[] = [
    {
      id: claim.relationName,
      kind: "definition",
      statement: { predicate: claim.predicate, inputs: relation.inputs, lean: relation.source },
      assumptions: [],
      dependencies: [],
    },
    {
      id: claim.id,
      kind: polarity === "prove" ? "goal" : "definition",
      ...(polarity === "prove" ? { theorem: `Datamog.Checked.${proofName}` } : {}),
      statement: { claim, lean: statement },
      assumptions: [],
      dependencies: [claim.relationName],
    },
  ];
  if (polarity === "refute")
    nodes.push({
      id: proofName,
      kind: "goal",
      theorem: `Datamog.Checked.${proofName}`,
      statement: `¬ Datamog.Generated.${claim.id}`,
      assumptions: [],
      dependencies: [claim.id],
    });
  return {
    relation: relation.source,
    statement,
    checker: `theorem ${proofName} : ${expected} := Proofs.${proofName}\n#audit ${proofName}\n`,
    nodes,
  };
}

/** Internal coverage law. Each output position maps to an input column or to
 * an independent existential witness (null). Bounds restrict input tuples;
 * they never assume computed-head definedness or a law about the whole input.
 */
export interface CoverageClaim {
  id: string;
  predicate: string;
  relationName: string;
  inputPredicate: string;
  outputToInput: readonly (number | null)[];
  bounds: readonly {
    column: number;
    op: "<" | "<=" | ">" | ">=";
    value: number;
  }[];
}

export function exportLeanCoverage(
  typed: TypedProgram,
  claim: CoverageClaim,
  polarity: "prove" | "refute" = "prove",
) {
  identifier(claim.id);
  identifier(claim.relationName);
  if (claim.id === claim.relationName || /^(input[0-9]+|[vw][0-9]+)$/.test(claim.relationName))
    throw new Error("Conflicting Lean coverage declaration name");
  if (polarity !== "prove" && polarity !== "refute") throw new Error("Invalid proof polarity");
  const relation = buildLeanRelation(typed, claim.predicate, claim.relationName);
  const input = relation.inputs.find((input) => input.predicate === claim.inputPredicate);
  if (!input) throw new Error("Coverage requires an input dependency of the exported relation");
  const validColumn = (column: number) =>
    Number.isInteger(column) && column >= 0 && column < input.arity;
  if (
    claim.outputToInput.length !== relation.arity ||
    Array.from(claim.outputToInput).some((column) => column !== null && !validColumn(column))
  )
    throw new Error("Invalid coverage output mapping");
  for (const bound of claim.bounds) {
    if (
      !validColumn(bound.column) ||
      !["<", "<=", ">", ">="].includes(bound.op) ||
      !Number.isSafeInteger(bound.value)
    )
      throw new Error("Invalid coverage input bound");
  }
  const variables = Array.from({ length: input.arity }, (_, i) => `v${i}`);
  const witnesses: string[] = [];
  const outputs = Array.from(claim.outputToInput, (column, i) => {
    if (column !== null) return variables[column]!;
    const witness = `w${i}`;
    witnesses.push(witness);
    return witness;
  });
  const binders = (names: string[]) => names.map((v) => `(${v} : Datamog.SafeInt)`).join(" ");
  const operators = { "<": "<", "<=": "≤", ">": ">", ">=": "≥" };
  const premises = [
    [input.name, ...variables].join(" "),
    ...claim.bounds.map((b) => `${variables[b.column]}.val ${operators[b.op]} (${b.value} : Int)`),
  ];
  const conclusion = [relation.application, ...outputs].join(" ");
  const exists = witnesses.length ? `∃ ${binders(witnesses)}, ` : "";
  const statement = `def ${claim.id} : Prop :=\n  ∀ ${[relation.params, binders(variables)].filter(Boolean).join(" ")},\n  ${premises.join(" → ")} → ${exists}${conclusion}\n`;
  return registerLeanClaim(claim, relation, statement, polarity);
}

/** Assemble trusted exporter results, not imported proof artifacts. Shared relation
 * definitions must match in source, predicate identity, and input parameter wiring.
 * Claim IDs (including refutations) remain unique even when their text agrees.
 */
export function assembleLeanClaims(bundles: readonly ReturnType<typeof exportLeanUniqueness>[]) {
  if (!bundles.length) throw new Error("No Lean claims to assemble");
  const nodes = new Map<string, VerificationNode>();
  const relations = new Map<string, string>();
  const statements: string[] = [];
  const checkers: string[] = [];
  const theorems = new Set<string>();
  for (const bundle of bundles) {
    const definition = bundle.nodes[0];
    if (!definition || definition.kind !== "definition")
      throw new Error("Missing Lean relation definition");
    for (const node of bundle.nodes) {
      const previous = nodes.get(node.id);
      if (previous) {
        if (
          node === definition &&
          relations.has(node.id) &&
          relations.get(node.id) === bundle.relation &&
          canonicalVerificationJson(previous) === canonicalVerificationJson(node)
        )
          continue;
        throw new Error(`Conflicting or duplicate Lean registration: ${node.id}`);
      }
      if (node.theorem) {
        if (theorems.has(node.theorem))
          throw new Error(`Duplicate Lean checker theorem: ${node.theorem}`);
        theorems.add(node.theorem);
      }
      nodes.set(node.id, node);
    }
    relations.set(definition.id, bundle.relation);
    statements.push(bundle.statement);
    checkers.push(bundle.checker);
  }
  for (const node of nodes.values()) {
    for (const dependency of node.dependencies) {
      if (!nodes.has(dependency)) throw new Error(`Missing Lean claim dependency: ${dependency}`);
    }
  }
  return {
    relations: [...relations.values()].join("\n"),
    statements: statements.join("\n"),
    checker: checkers.join("\n"),
    nodes: [...nodes.values()],
  };
}
