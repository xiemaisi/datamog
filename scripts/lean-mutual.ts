/** Positive mutual family with canonical padding for mixed tuple arities. Tags identify source predicates. */
import type { HeadTerm } from "../packages/core/src/ast.ts";
import { isFloatLiteral } from "../packages/core/src/ast.ts";
import type { TypedProgram } from "../packages/core/src/types.ts";
import type { VerificationNode } from "../packages/core/src/verification-manifest.ts";
import { invariantContract } from "./lean-invariant.ts";

export interface MutualClaim {
  kind: "mutual-invariant";
  id: string;
  predicates: string[];
  polarity?: "prove" | "refute";
}
export interface ProgramInvariantClaim {
  kind: "program-invariant";
  id: string;
  predicates: string[];
  polarity?: "prove" | "refute";
}

/** Close over source definitions, never abstract a derived call as an input. */
export function exportProgramInvariant(typed: TypedProgram, claim: ProgramInvariantClaim) {
  const closure = [...claim.predicates];
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
  claim: MutualClaim | ProgramInvariantClaim,
  predicates: string[],
) {
  const { id } = claim;
  const program = claim.kind === "program-invariant";
  if (
    !/^[A-Za-z][A-Za-z0-9_]*$/.test(id) ||
    claim.predicates.length < (program ? 1 : 2) ||
    new Set(predicates).size !== predicates.length
  )
    throw new Error("Mutual invariant requires a name and distinct predicates");
  if (typed.maximalPredicates.size || typed.constraints.some((c) => !c.synthetic))
    throw new Error("Unsupported mutual parity or explicit constraints");
  const family = `${id}Family`;
  const contracts = claim.predicates.map((p) => invariantContract(typed, p).contract);
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
    const tag = predicates.indexOf(claim.predicates[selected]!);
    const columns = Array.from({ length: memberArities[tag]! }, (_, i) => `x${i}`);
    const binders = columns.map((c) => `(${c} : Datamog.SafeInt)`).join(" ");
    return `(${binders ? `∀ ${binders}, ` : ""}${applied} ${tag} ${padded(columns)} → (${contract}))`;
  });
  const statement = `def ${id} : Prop :=\n  ${params ? `∀ ${params},\n  ` : ""}${goals.join(" ∧ ")}\n`;
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
        selectedPredicates: claim.predicates,
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
      assumptions: [],
      dependencies: [family],
    },
  ];
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
