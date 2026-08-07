// Refinement annotations: `p(X, Y, _: Y > X)`.
//
// A `_` head position may carry a proposition over the other positions instead
// of a type. The witness is erased, so the position is not a column: it is
// removed here and the predicate keeps the arity it reads as having.
//
// This slice *checks* a contract rather than proving it. A predicate's contract
// is the disjunction over its rules (a rule that annotates nothing contributes
// `True`, so one unannotated sibling makes the contract vacuous), and checking
// it against the derived tuples is exactly an integrity constraint. So the
// whole feature lowers to one synthesised `!-` per contracted predicate and no
// stage after parsing needs to know refinements exist.
//
// Extraction runs before `substituteHeadNames`, which is what keeps the link
// from a name to its position: afterwards `I + 1 as K` has lost `K`.
//
// See doc/design/refinement-annotations.md, phases 0, 1 and 3.

import type { AstNode } from "langium";
import type { Expression, HeadAtom, Program, Query, Rule, Variable } from "./generated/ast.js";
import { isRule, isVariable } from "./generated/ast.js";
import type { ParseError } from "./parse-error.js";

/** One `_: φ` as written, kept separate so a violation names the right one. */
export interface Refinement {
  formula: Expression;
  /** Source text of the proposition, for the violation message. */
  text: string;
}

declare module "./generated/ast.js" {
  interface Query {
    /**
     * Machine-generated rather than written. Diagnostics skip these: a warning
     * about a statement the user cannot edit is noise, and the contract check
     * below trips several by construction, negating an ordering over a column
     * that integer arithmetic makes nullable.
     */
    synthetic?: boolean;
  }

  interface HeadAtom {
    /** Propositions this rule's head claims, in its own position names. */
    refinements?: Refinement[];
    /** Position index to the name a refinement may call it by. */
    positionNames?: (string | undefined)[];
  }
}

type Fail = (message: string, node: { $cstNode?: AstNode["$cstNode"] }) => ParseError;

function isAstNodeValue(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "$type" in value;
}

/** Deep-copy a node, renaming any variable the map covers. */
function cloneRenaming(node: AstNode, rename: ReadonlyMap<string, string>): AstNode {
  const copy: Record<string, unknown> = { $type: node.$type, $cstNode: node.$cstNode };
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    if (Array.isArray(value)) {
      copy[key] = value.map((c: unknown) => (isAstNodeValue(c) ? cloneRenaming(c, rename) : c));
    } else if (isAstNodeValue(value)) {
      copy[key] = cloneRenaming(value, rename);
    } else {
      copy[key] = value;
    }
  }
  if (node.$type === "Variable") {
    const renamed = rename.get(copy.name as string);
    if (renamed !== undefined) copy.name = renamed;
  }
  return copy as unknown as AstNode;
}

/** Every variable name mentioned at or below `node`. */
function variableNames(node: AstNode, into: Set<string>): void {
  if (isVariable(node as never)) into.add((node as unknown as Variable).name);
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isAstNodeValue(child)) variableNames(child, into);
    }
  }
}

/**
 * Pull the refinements off `head`, dropping their positions, and record the
 * name each surviving position answers to. Called from `liftHeadAnnotations`
 * with the wrappers already unwrapped, so `annotations` carries what they held.
 */
export function extractRefinements(
  head: HeadAtom,
  annotations: { refinement?: Expression; name?: string; wasDontCare: boolean }[],
  fail: Fail,
): void {
  const refinements: Refinement[] = [];
  const keep: number[] = [];
  for (let i = 0; i < head.args.length; i++) {
    const annotation = annotations[i];
    if (annotation?.refinement === undefined) {
      keep.push(i);
      continue;
    }
    if (!annotation.wasDontCare) {
      throw fail(
        "A refinement must sit on a `_` position: its witness is erased, so the position is not a column",
        annotation.refinement,
      );
    }
    refinements.push({
      formula: annotation.refinement,
      text: annotation.refinement.$cstNode?.text ?? "the refinement",
    });
  }
  if (refinements.length === 0) return;

  // Position names, over the arguments that survive. A bare variable names its
  // own position; anything else needs an `as` name (head-arguments.md §2).
  const positionNames: (string | undefined)[] = keep.map((i) => {
    const annotation = annotations[i];
    if (annotation?.name !== undefined) return annotation.name;
    const arg = head.args[i]!;
    return isVariable(arg) && arg.name !== "_" ? arg.name : undefined;
  });

  const nameable = new Set(positionNames.filter((n): n is string => n !== undefined));
  for (const refinement of refinements) {
    const mentioned = new Set<string>();
    variableNames(refinement.formula as unknown as AstNode, mentioned);
    for (const name of mentioned) {
      if (nameable.has(name)) continue;
      throw fail(
        `A refinement may only mention a head position; '${name}' is not one. Give the position an \`as\` name if it is computed.`,
        refinement.formula,
      );
    }
  }

  const kept = keep.map((i) => head.args[i]!);
  head.args.length = 0;
  for (const arg of kept) head.args.push(arg);
  kept.forEach((arg, i) => {
    (arg as { $containerIndex?: number }).$containerIndex = i;
  });
  head.refinements = refinements;
  head.positionNames = positionNames;
}

function mkVariable(name: string, cst: AstNode["$cstNode"]): Expression {
  return { $type: "Variable", name, $cstNode: cst } as unknown as Expression;
}

function joinWith(op: "&&" | "||", parts: Expression[], cst: AstNode["$cstNode"]): Expression {
  return parts.reduce((left, right) => {
    const node = { $type: "BinaryExpr", op, left, right, $cstNode: cst } as unknown as Expression;
    (left as { $container?: AstNode }).$container = node as unknown as AstNode;
    (right as { $container?: AstNode }).$container = node as unknown as AstNode;
    return node;
  });
}

/**
 * Append one `!- p(V1, .., Vn), !(Φ_p).` per contracted predicate.
 *
 * Only predicates whose every rule is annotated get one: otherwise `Φ_p` is
 * `True` and the check is vacuous, which §2.2's warning reports rather than
 * this silently emitting a constraint that can never fire.
 */
export function synthesiseContractChecks(program: Program): void {
  const rulesByPredicate = new Map<string, Rule[]>();
  for (const stmt of program.statements) {
    if (!isRule(stmt)) continue;
    const list = rulesByPredicate.get(stmt.head.predicate) ?? [];
    list.push(stmt);
    rulesByPredicate.set(stmt.head.predicate, list);
  }

  for (const [predicate, rules] of rulesByPredicate) {
    if (!rules.every((r) => (r.head.refinements?.length ?? 0) > 0)) continue;
    const arity = rules[0]!.head.args.length;
    if (rules.some((r) => r.head.args.length !== arity)) continue; // an arity error, reported later
    const columns = Array.from({ length: arity }, (_, i) => `Col${i + 1}`);

    /** That rule's refinements, renamed from its position names to `columns`. */
    const renamed = (rule: Rule): Expression[] => {
      const rename = new Map<string, string>();
      rule.head.positionNames?.forEach((name, i) => {
        if (name !== undefined) rename.set(name, columns[i]!);
      });
      return rule.head.refinements!.map(
        (r) => cloneRenaming(r.formula as unknown as AstNode, rename) as unknown as Expression,
      );
    };

    // One check per refinement when the predicate has a single rule, so a
    // violation names the annotation that failed: the contract is then a
    // conjunction, and `!- p(..), !(a && b).` is exactly `!- p(..), !a.` plus
    // `!- p(..), !b.` With several rules the contract is a disjunction, which
    // does not split, so they share one check and it names the first claim.
    const checks: { formula: Expression; cst: AstNode["$cstNode"] }[] =
      rules.length === 1
        ? renamed(rules[0]!).map((formula, i) => ({
            formula,
            cst: rules[0]!.head.refinements![i]!.formula.$cstNode,
          }))
        : [
            {
              formula: joinWith(
                "||",
                rules.map((rule) => joinWith("&&", renamed(rule), undefined)),
                undefined,
              ),
              cst: rules[0]!.head.refinements![0]!.formula.$cstNode,
            },
          ];

    for (const { formula, cst } of checks) {
      program.statements.push(contractCheck(program, predicate, columns, formula, cst));
    }
  }
}

/** `!- p(Col1, .., Coln), !(formula).` */
function contractCheck(
  program: Program,
  predicate: string,
  columns: string[],
  formula: Expression,
  cst: AstNode["$cstNode"],
): Query {
  const atom = {
    $type: "Literal",
    predicate,
    args: columns.map((c) => mkVariable(c, cst)),
    maximal: false,
    negated: false,
    parens: false,
    $cstNode: cst,
  } as unknown as Query["body"][number];
  (atom as unknown as { args: Expression[] }).args.forEach((arg, i) => {
    const a = arg as { $container?: AstNode; $containerIndex?: number };
    a.$container = atom as unknown as AstNode;
    a.$containerIndex = i;
  });

  const negated = {
    $type: "UnaryExpr",
    op: "!",
    operand: formula,
    $cstNode: cst,
  } as unknown as Expression;
  (formula as { $container?: AstNode }).$container = negated as unknown as AstNode;
  const filter = {
    $type: "Filter",
    expr: negated,
    negated: false,
    $cstNode: cst,
  } as unknown as Query["body"][number];
  (negated as { $container?: AstNode }).$container = filter as unknown as AstNode;

  const check = {
    $type: "Query",
    isError: true,
    synthetic: true,
    body: [atom, filter],
    $container: program,
    $cstNode: cst,
  } as unknown as Query;
  for (const element of check.body) {
    (element as { $container?: AstNode }).$container = check as unknown as AstNode;
  }
  return check;
}
