/** Positive mutual family with canonical padding for mixed tuple arities. Tags identify source predicates. */
import type { HeadTerm } from "../packages/core/src/ast.ts";
import { isFloatLiteral } from "../packages/core/src/ast.ts";
import type { CoverageClaim } from "../packages/core/src/obligation-lean.ts";
import type { TypedProgram } from "../packages/core/src/types.ts";
import type { VerificationNode } from "../packages/core/src/verification-manifest.ts";
import { invariantContract } from "./lean-invariant.ts";

export interface MutualClaim {
  kind: "mutual-invariant";
  id: string;
  predicates: string[];
  polarity?: "prove" | "refute";
}
export interface InputLaw {
  id: string;
  predicate: string;
  column: number;
  op: "<" | "<=" | ">" | ">=" | "=";
  value: number;
}
export interface ProgramInvariantClaim {
  kind: "program-invariant";
  inputLaws?: InputLaw[];
  id: string;
  predicates: string[];
  polarity?: "prove" | "refute";
}

export interface ProgramUniquenessClaim {
  kind: "program-uniqueness";
  inputLaws?: InputLaw[];
  id: string;
  predicate: string;
  keyColumns: number[];
  outputColumns: number[];
  polarity?: "prove" | "refute";
}
export interface ProgramCoverageClaim extends Omit<CoverageClaim, "relationName"> {
  kind: "program-coverage";
  inputLaws?: InputLaw[];
  polarity?: "prove" | "refute";
}
export interface ProgramEquivalenceClaim {
  kind: "program-equivalence";
  inputLaws?: InputLaw[];
  id: string;
  predicates: [string, string];
  polarity?: "prove" | "refute";
}
export interface ProgramEmptinessClaim {
  kind: "program-emptiness";
  inputLaws?: InputLaw[];
  id: string;
  predicate: string;
  polarity?: "prove" | "refute";
}
type ProgramClaim =
  | ProgramInvariantClaim
  | ProgramUniquenessClaim
  | ProgramCoverageClaim
  | ProgramEquivalenceClaim
  | ProgramEmptinessClaim;
const roots = (claim: MutualClaim | ProgramClaim) =>
  "predicate" in claim ? [claim.predicate] : claim.predicates;

/** Close over source definitions, never abstract a derived call as an input. */
export function exportProgramClaim(typed: TypedProgram, claim: ProgramClaim) {
  const closure = [...roots(claim)];
  const seen = new Set(closure);
  for (let i = 0; i < closure.length; i++) {
    const rules = typed.rules.get(closure[i]!);
    if (!rules?.length) throw new Error(`No defining rules for ${closure[i]}`);
    for (const rule of rules)
      for (const atom of rule.body) {
        if (atom.$type !== "Literal" || atom.negated || typed.extDecls.has(atom.predicate))
          continue;
        if (!seen.has(atom.predicate)) {
          seen.add(atom.predicate);
          closure.push(atom.predicate);
        }
      }
  }
  return exportFamily(typed, claim, closure);
}

export function exportMutual(typed: TypedProgram, claim: MutualClaim) {
  return exportFamily(typed, claim, claim.predicates);
}

function exportFamily(
  typed: TypedProgram,
  claim: MutualClaim | ProgramClaim,
  predicates: string[],
) {
  const { id } = claim;
  const program = claim.kind !== "mutual-invariant";
  const selectedPredicates = roots(claim);
  if (
    !/^[A-Za-z][A-Za-z0-9_]*$/.test(id) ||
    selectedPredicates.length < (program ? 1 : 2) ||
    new Set(predicates).size !== predicates.length
  )
    throw new Error("Mutual invariant requires a name and distinct predicates");
  // Program laws concern derivations before runtime checks. Constraints never
  // restrict their inputs or supply constructor premises.
  if (typed.maximalPredicates.size || (!program && typed.constraints.some((c) => !c.synthetic)))
    throw new Error("Unsupported mutual parity or explicit constraints");
  const family = `${id}Family`;
  const contracts =
    claim.kind !== "mutual-invariant" && claim.kind !== "program-invariant"
      ? []
      : selectedPredicates.map((p) => invariantContract(typed, p).contract);
  const inputs = new Map<string, number>();
  const edges = new Map<string, string[]>();
  const arityOf = (p: string) => typed.columnTypes.get(p)!.length;
  const memberArities = predicates.map(arityOf);
  const width = Math.max(...memberArities);
  const relationType = (arity: number) =>
    [...Array.from({ length: arity }, () => "Datamog.SafeInt"), "Prop"].join(" → ");
  const zero = "(⟨0, by decide⟩ : Datamog.SafeInt)";
  const padded = (args: string[]) =>
    [...args, ...Array.from({ length: width - args.length }, () => zero)].join(" ");
  const checkColumns = (p: string) => {
    const columns = typed.columnTypes.get(p);
    const nullable = typed.nullness.publishedNullness.get(p);
    if (
      !columns ||
      columns.some((c) => c !== "integer") ||
      nullable?.length !== columns.length ||
      nullable.some(Boolean)
    )
      throw new Error("Mutual fragment requires non-null integer columns");
  };
  for (const p of predicates) {
    checkColumns(p);
    const calls: string[] = [];
    for (const rule of typed.rules.get(p)!)
      for (const atom of rule.body) {
        if ((atom.$type === "Filter" && !atom.negated) || atom.$type === "Equality") continue;
        if (atom.$type !== "Literal" || atom.negated) throw new Error("Unsupported mutual body");
        checkColumns(atom.predicate);
        if (predicates.includes(atom.predicate)) calls.push(atom.predicate);
        else {
          if (!typed.extDecls.has(atom.predicate))
            throw new Error("Missing mutual member or unsupported derived dependency");
          if (!inputs.has(atom.predicate)) inputs.set(atom.predicate, inputs.size);
        }
      }
    edges.set(p, calls);
  }
  const reachable = new Map<string, Set<string>>();
  for (const p of predicates) {
    const reached = new Set<string>();
    const visit = (q: string) => {
      if (reached.has(q)) return;
      reached.add(q);
      edges.get(q)!.forEach(visit);
    };
    visit(p);
    reachable.set(p, reached);
    if (!program && reached.size !== predicates.length)
      throw new Error("Selection must be one strongly connected component");
  }
  const components: string[][] = [];
  const assigned = new Set<string>();
  for (const p of predicates) {
    if (assigned.has(p)) continue;
    const component = predicates.filter(
      (q) => reachable.get(p)!.has(q) && reachable.get(q)!.has(p),
    );
    for (const q of component) assigned.add(q);
    components.push(component);
  }
  const params = [...inputs].map(([p, i]) => `(input${i} : ${relationType(arityOf(p))})`).join(" ");
  const applied = `${family}${[...inputs.values()].map((i) => ` input${i}`).join("")}`;
  const constructors: string[] = [];
  for (const [tag, p] of predicates.entries())
    for (const [ri, rule] of typed.rules.get(p)!.entries()) {
      const vars = new Map<string, string>();
      for (const atom of rule.body)
        if (atom.$type === "Literal") {
          if (atom.args.length !== arityOf(atom.predicate))
            throw new Error("Mutual atom arity mismatch");
          for (const arg of atom.args) {
            if (arg.$type !== "Variable") throw new Error("Mutual atoms require variables");
            if (!vars.has(arg.name)) vars.set(arg.name, `v${vars.size}`);
          }
        }
      const computed: string[] = [];
      const defined: string[] = [];
      if (rule.head.args.length !== arityOf(p)) throw new Error("Mutual head arity mismatch");
      const output = rule.head.args.map((head) => {
        if (head.$type === "Variable" && vars.has(head.name)) return vars.get(head.name)!;
        if (
          head.$type === "BinaryExpr" &&
          (head.op === "+" || head.op === "-") &&
          head.left.$type === "Variable" &&
          vars.has(head.left.name) &&
          head.right.$type === "NumberLiteral" &&
          !isFloatLiteral(head.right) &&
          Number.isSafeInteger(head.right.value)
        ) {
          const witness = `w${computed.length}`;
          computed.push(witness);
          defined.push(
            `(${witness}.val = ${vars.get(head.left.name)}.val ${head.op} (${head.right.value} : Int))`,
          );
          return witness;
        }
        throw new Error(
          "Mutual heads require a bound variable or variable plus/minus safe integer literal",
        );
      });
      const term = (e: HeadTerm): string => {
        if (e.$type === "Variable" && vars.has(e.name)) return `${vars.get(e.name)}.val`;
        if (e.$type === "NumberLiteral" && !isFloatLiteral(e) && Number.isSafeInteger(e.value))
          return `(${e.value} : Int)`;
        if (
          e.$type === "UnaryExpr" &&
          e.op === "-" &&
          e.operand.$type === "NumberLiteral" &&
          !isFloatLiteral(e.operand) &&
          Number.isSafeInteger(e.operand.value)
        )
          return `(${-e.operand.value} : Int)`;
        throw new Error("Unsupported mutual guard term");
      };
      const ops: Record<string, string> = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "=": "=" };
      const premises = rule.body.map((atom) => {
        if (atom.$type === "Literal") {
          const values = atom.args.map((arg) => vars.get((arg as { name: string }).name)!);
          const index = predicates.indexOf(atom.predicate);
          return index >= 0
            ? `(${applied} ${index} ${padded(values)})`
            : `(input${inputs.get(atom.predicate)} ${values.join(" ")})`;
        }
        if (atom.$type === "Equality") return `(${term(atom.left)} = ${term(atom.expr)})`;
        if (
          atom.$type !== "Filter" ||
          atom.expr.$type !== "BinaryExpr" ||
          !Object.hasOwn(ops, atom.expr.op)
        )
          throw new Error("Unsupported mutual guard");
        return `(${term(atom.expr.left)} ${ops[atom.expr.op]} ${term(atom.expr.right)})`;
      });
      constructors.push(
        `  | rule${tag}_${ri} ${[...vars.values(), ...computed].map((v) => `(${v} : Datamog.SafeInt)`).join(" ")} : ${[...premises, ...defined, `${applied} ${tag} ${padded(output)}`].join(" → ")}`,
      );
    }
  const relation = `inductive ${family} ${params} : Nat → ${relationType(width)} where\n${constructors.join("\n")}\n`;
  const goals = contracts.map((contract, selected) => {
    const tag = predicates.indexOf(selectedPredicates[selected]!);
    const columns = Array.from({ length: memberArities[tag]! }, (_, i) => `x${i}`);
    const binders = columns.map((c) => `(${c} : Datamog.SafeInt)`).join(" ");
    return `(${binders ? `∀ ${binders}, ` : ""}${applied} ${tag} ${padded(columns)} → (${contract}))`;
  });
  if (claim.kind === "program-uniqueness") {
    const arity = arityOf(claim.predicate);
    const columns = [...claim.keyColumns, ...claim.outputColumns];
    if (
      !claim.outputColumns.length ||
      new Set(columns).size !== columns.length ||
      columns.some((c) => !Number.isInteger(c) || c < 0 || c >= arity)
    )
      throw new Error("Uniqueness requires distinct valid key/output columns and nonempty outputs");
    const left = Array.from({ length: arity }, (_, i) => `x${i}`);
    const right = left.map((x, i) => (claim.keyColumns.includes(i) ? x : `y${i}`));
    const binders = [...new Set([...left, ...right])]
      .map((x) => `(${x} : Datamog.SafeInt)`)
      .join(" ");
    const equalities = claim.outputColumns.map((i) => `${left[i]} = ${right[i]}`).join(" ∧ ");
    goals.push(
      `(∀ ${binders}, ${applied} 0 ${padded(left)} → ${applied} 0 ${padded(right)} → (${equalities}))`,
    );
  }
  if (claim.kind === "program-coverage") {
    const inputIndex = inputs.get(claim.inputPredicate);
    if (inputIndex === undefined)
      throw new Error("Coverage requires an input dependency of the exported program");
    const inputArity = arityOf(claim.inputPredicate);
    const validColumn = (c: number) => Number.isInteger(c) && c >= 0 && c < inputArity;
    if (
      claim.outputToInput.length !== arityOf(claim.predicate) ||
      claim.outputToInput.some((c) => c !== null && !validColumn(c))
    )
      throw new Error("Invalid coverage output mapping");
    const operators = { "<": "<", "<=": "≤", ">": ">", ">=": "≥" };
    for (const bound of claim.bounds)
      if (
        !validColumn(bound.column) ||
        !Object.hasOwn(operators, bound.op) ||
        !Number.isSafeInteger(bound.value)
      )
        throw new Error("Invalid coverage input bound");
    const variables = Array.from({ length: inputArity }, (_, i) => `x${i}`);
    const witnesses: string[] = [];
    const outputs = claim.outputToInput.map((column, i) => {
      if (column !== null) return variables[column]!;
      const witness = `w${i}`;
      witnesses.push(witness);
      return witness;
    });
    const binders = (names: string[]) => names.map((v) => `(${v} : Datamog.SafeInt)`).join(" ");
    const premises = [
      `input${inputIndex} ${variables.join(" ")}`,
      ...claim.bounds.map(
        (b) => `${variables[b.column]}.val ${operators[b.op]} (${b.value} : Int)`,
      ),
    ];
    goals.push(
      `(∀ ${binders(variables)}, ${premises.join(" → ")} → ${witnesses.length ? `∃ ${binders(witnesses)}, ` : ""}${applied} 0 ${padded(outputs)})`,
    );
  }
  if (claim.kind === "program-equivalence") {
    if (claim.predicates.length !== 2 || memberArities[0] !== memberArities[1])
      throw new Error("Equivalence requires two distinct derived predicates of equal arity");
    const columns = Array.from({ length: memberArities[0]! }, (_, i) => `x${i}`);
    const binders = columns.map((v) => `(${v} : Datamog.SafeInt)`).join(" ");
    goals.push(
      `(${columns.length ? `∀ ${binders}, ` : ""}${applied} 0 ${padded(columns)} ↔ ${applied} 1 ${padded(columns)})`,
    );
  }
  if (claim.kind === "program-emptiness") {
    const columns = Array.from({ length: memberArities[0]! }, (_, i) => `x${i}`);
    const binders = columns.map((v) => `(${v} : Datamog.SafeInt)`).join(" ");
    goals.push(
      `(${columns.length ? `∀ ${binders}, ` : ""}${applied} 0 ${padded(columns)} → False)`,
    );
  }
  const laws = "inputLaws" in claim ? (claim.inputLaws ?? []) : [];
  if (laws.length && claim.polarity === "refute")
    throw new Error("Input laws currently support proofs only");
  if (new Set(laws.map((law) => law.id)).size !== laws.length)
    throw new Error("Input law names must be distinct");
  const lawFormulas = laws.map((law) => {
    const index = inputs.get(law.predicate);
    const ops = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "=": "=" };
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(law.id) ||
      index === undefined ||
      !Number.isSafeInteger(law.column) ||
      law.column < 0 ||
      law.column >= arityOf(law.predicate) ||
      !Object.hasOwn(ops, law.op) ||
      !Number.isSafeInteger(law.value)
    )
      throw new Error(
        "Input law requires a reachable input predicate, valid column and safe integer bound",
      );
    const vars = Array.from({ length: arityOf(law.predicate) }, (_, i) => `lawx${i}`);
    return `∀ ${vars.map((v) => `(${v} : Datamog.SafeInt)`).join(" ")}, input${index} ${vars.join(" ")} → lawx${law.column}.val ${ops[law.op]} (${law.value} : Int)`;
  });
  const statement = `def ${id} : Prop :=\n  ${params ? `∀ ${params},\n  ` : ""}${lawFormulas.map((formula) => `(${formula}) → `).join("")}${goals.join(" ∧ ")}\n`;
  const refute = claim.polarity === "refute";
  const proofName = refute ? `${id}_refuted` : id;
  const expected = `${refute ? "¬ " : ""}Generated.${id}`;
  const nodes: VerificationNode[] = [
    {
      id: family,
      kind: "definition",
      statement: {
        predicates,
        memberArities,
        selectedPredicates,
        components,
        derivedDependencies: [...edges].map(([predicate, dependencies]) => ({
          predicate,
          dependencies,
        })),
        width,
        padding: "bounded-zero",
        inputs: [...inputs].map(([predicate, index]) => ({
          predicate,
          index,
          arity: arityOf(predicate),
        })),
        source: relation,
      },
      assumptions: [],
      dependencies: [
        "IntegerSemantics",
        ...(program ? predicates.map((_, tag) => `${id}Rules${tag}`) : []),
      ],
    },
    {
      id,
      kind: refute ? "definition" : "goal",
      ...(refute ? {} : { theorem: `Datamog.Checked.${id}` }),
      statement: { claim, source: statement },
      assumptions: laws.map((law, i) => `${law.id}: ${lawFormulas[i]}`),
      dependencies: [family, ...laws.map((_, i) => `${id}InputLaw${i}`)],
    },
  ];
  laws.forEach((law, i) =>
    nodes.push({
      id: `${id}InputLaw${i}`,
      kind: "definition",
      statement: { law, formula: lawFormulas[i] },
      assumptions: [],
      dependencies: [],
    }),
  );
  if (program)
    predicates.forEach((predicate, tag) =>
      nodes.push({
        id: `${id}Rules${tag}`,
        kind: "definition",
        statement: {
          predicate,
          tag,
          arity: memberArities[tag],
          constructors: constructors.filter((line) => line.startsWith(`  | rule${tag}_`)),
        },
        assumptions: [],
        dependencies: [...new Set(edges.get(predicate)!)].map(
          (dependency) => `${id}Rules${predicates.indexOf(dependency)}`,
        ),
      }),
    );
  if (refute)
    nodes.push({
      id: proofName,
      kind: "goal",
      theorem: `Datamog.Checked.${proofName}`,
      statement: { negationOf: id, expected },
      assumptions: [],
      dependencies: [id],
    });
  return {
    source: `${relation}\n${statement}`,
    nodes,
    checker: `theorem ${proofName} : ${expected} := Proofs.${proofName}\n#audit ${proofName}\n`,
  };
}
