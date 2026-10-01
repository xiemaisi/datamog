/** Initial unary positive mutual family. Tags identify source predicates. */
import type { HeadTerm } from "../packages/core/src/ast.ts";
import { isFloatLiteral } from "../packages/core/src/ast.ts";
import type { TypedProgram } from "../packages/core/src/types.ts";
import type { VerificationNode } from "../packages/core/src/verification-manifest.ts";
import { invariantContract } from "./lean-invariant.ts";

export interface MutualClaim {
  kind: "mutual-invariant";
  id: string;
  predicates: string[];
}
export function exportMutual(typed: TypedProgram, claim: MutualClaim) {
  const { id, predicates } = claim;
  if (
    !/^[A-Za-z][A-Za-z0-9_]*$/.test(id) ||
    predicates.length < 2 ||
    new Set(predicates).size !== predicates.length
  )
    throw new Error("Mutual invariant requires a name and distinct predicates");
  if (typed.maximalPredicates.size || typed.constraints.some((c) => !c.synthetic))
    throw new Error("Unsupported mutual parity or explicit constraints");
  const family = `${id}Family`;
  const contracts = predicates.map((p) => invariantContract(typed, p).contract);
  const inputs = new Map<string, number>();
  const edges = new Map<string, string[]>();
  const unary = (p: string) => {
    const columns = typed.columnTypes.get(p);
    const nullable = typed.nullness.publishedNullness.get(p);
    if (columns?.length !== 1 || columns[0] !== "integer" || nullable?.length !== 1 || nullable[0])
      throw new Error("Mutual fragment requires unary non-null integer predicates");
  };
  for (const p of predicates) {
    unary(p);
    const calls: string[] = [];
    for (const rule of typed.rules.get(p)!)
      for (const atom of rule.body) {
        if ((atom.$type === "Filter" && !atom.negated) || atom.$type === "Equality") continue;
        if (atom.$type !== "Literal" || atom.negated) throw new Error("Unsupported mutual body");
        unary(atom.predicate);
        if (predicates.includes(atom.predicate)) calls.push(atom.predicate);
        else {
          if (!typed.extDecls.has(atom.predicate))
            throw new Error("Missing mutual member or unsupported derived dependency");
          if (!inputs.has(atom.predicate)) inputs.set(atom.predicate, inputs.size);
        }
      }
    edges.set(p, calls);
  }
  for (const p of predicates) {
    const reached = new Set<string>();
    const visit = (q: string) => {
      if (reached.has(q)) return;
      reached.add(q);
      edges.get(q)!.forEach(visit);
    };
    visit(p);
    if (reached.size !== predicates.length)
      throw new Error("Selection must be one strongly connected component");
  }
  const params = [...inputs.values()].map((i) => `(input${i} : Datamog.SafeInt → Prop)`).join(" ");
  const applied = `${family}${[...inputs.values()].map((i) => ` input${i}`).join("")}`;
  const constructors: string[] = [];
  for (const [tag, p] of predicates.entries())
    for (const [ri, rule] of typed.rules.get(p)!.entries()) {
      const vars = new Map<string, string>();
      for (const atom of rule.body)
        if (atom.$type === "Literal") {
          if (atom.args.length !== 1 || atom.args[0]!.$type !== "Variable")
            throw new Error("Mutual atoms require one variable");
          const name = atom.args[0]!.name;
          if (!vars.has(name)) vars.set(name, `v${vars.size}`);
        }
      const head = rule.head.args[0];
      let output: string;
      const computed: string[] = [];
      const defined: string[] = [];
      if (head?.$type === "Variable" && vars.has(head.name)) output = vars.get(head.name)!;
      else if (
        head?.$type === "BinaryExpr" &&
        head.op === "+" &&
        head.left.$type === "Variable" &&
        vars.has(head.left.name) &&
        head.right.$type === "NumberLiteral" &&
        !isFloatLiteral(head.right) &&
        Number.isSafeInteger(head.right.value)
      ) {
        output = "w0";
        computed.push(output);
        defined.push(
          `(${output}.val = ${vars.get(head.left.name)}.val + (${head.right.value} : Int))`,
        );
      } else
        throw new Error(
          "Mutual heads require a bound variable or variable plus safe integer literal",
        );
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
          const value = vars.get((atom.args[0] as { name: string }).name)!;
          const index = predicates.indexOf(atom.predicate);
          return index >= 0
            ? `(${applied} ${index} ${value})`
            : `(input${inputs.get(atom.predicate)} ${value})`;
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
        `  | rule${tag}_${ri} ${[...vars.values(), ...computed].map((v) => `(${v} : Datamog.SafeInt)`).join(" ")} : ${[...premises, ...defined, `${applied} ${tag} ${output}`].join(" → ")}`,
      );
    }
  const relation = `inductive ${family} ${params} : Nat → Datamog.SafeInt → Prop where\n${constructors.join("\n")}\n`;
  const goals = contracts.map(
    (contract, tag) => `(∀ (x0 : Datamog.SafeInt), ${applied} ${tag} x0 → (${contract}))`,
  );
  const statement = `def ${id} : Prop :=\n  ${params ? `∀ ${params},\n  ` : ""}${goals.join(" ∧ ")}\n`;
  const nodes: VerificationNode[] = [
    {
      id: family,
      kind: "definition",
      statement: { predicates, inputs: [...inputs], source: relation },
      assumptions: [],
      dependencies: ["IntegerSemantics"],
    },
    {
      id,
      kind: "goal",
      theorem: `Datamog.Checked.${id}`,
      statement: { claim, source: statement },
      assumptions: [],
      dependencies: [family],
    },
  ];
  return {
    source: `${relation}\n${statement}`,
    nodes,
    checker: `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}\n`,
  };
}
