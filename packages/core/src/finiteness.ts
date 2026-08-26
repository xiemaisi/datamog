// Finiteness analysis: flag predicate columns whose value flow lies on a
// dataflow cycle that goes through a value-producing operation. Such
// columns may grow unboundedly across recursive iterations (the classic
// `s(Y) :- s(X), Y = X + 1.` case), and the engine has no way to stop the
// loop on its own.
//
// The check is **conservative**: any cycle through arithmetic / string
// concat / a function call / a non-literal range bound flags. Many
// perfectly finite programs (Fibonacci with `I < 10`, etc.) fall under
// it. We surface the result as a warning, never as an error.
//
// Algorithm
// ---------
// One global graph for the whole program:
//   - `(predicate, columnIndex)` is a single node, shared across rules.
//   - `(ruleIndex, varName)` is a per-rule local node.
//
// Edges, walked once per rule:
//   - Body atom `p(t1, ..., tn)` (positive, non-negated):
//       * if `tj` is a Variable `V`: `(p, j) → (rule, V)`        (clean)
//       * if `tj` is a non-trivial expression `e`:
//           for each var `V` mentioned in `e`,
//             `(rule, V) → (p, j)`                                (PLUS)
//         (the body atom is *constraining* `(p, j)` to equal `e`; values
//         flowing into the variables determine which rows of `p` match.)
//   - Head atom `q(e1, ..., en)`:
//       * Variable `V` at position `j`: `(rule, V) → (q, j)`     (clean)
//       * Aggregate at `j`: each var in `arg` → `(q, j)`         (clean —
//         aggregation collapses, doesn't generate new domain elements.)
//       * Other expression: each var in `e` → `(q, j)`           (PLUS)
//   - Binding equality with a bare variable on either side:
//       * trivial `V = V'` (rename): `(rule, V') → (rule, V)`    (clean)
//         and, symmetrically, `(rule, V) → (rule, V')`            (clean)
//       * otherwise:                  vars-of-expr → `(rule, V)` (PLUS)
//   - Binding range `V in [lo .. hi]`, `V` fresh:
//       * if both bounds are NumberLiterals (possibly UnaryExpr-wrapped
//         negative literals): vars-of-bounds → `(rule, V)`       (clean)
//       * otherwise:                                              (PLUS)
//   - Filters / non-binding equalities / negated atoms: no edges
//     — they filter, they don't propagate values forward.
//
// We then run Tarjan's SCC. An SCC flags every predicate-column node it
// contains if any internal edge (or self-loop) carries the PLUS label.

import type { AnalyzedProgram } from "./analyzer.ts";
import { BUILTIN_BODY_ATOMS, equalityBindingCandidates, isAnonymousVar } from "./analyzer.ts";
import type { Expression, HeadTerm, Literal, Rule } from "./ast.ts";

export interface FinitenessDiagnostic {
  severity: "warning";
  code: "potentially-infinite-column";
  message: string;
  predicate: string;
  columnIndex: number;
  /** Byte offset of the rule head where this column is defined. */
  offset?: number;
  end?: number;
  /**
   * The flagged SCC, projected down to predicate-column nodes (rule
   * variables collapsed into edges). All diagnostics emitted from the
   * same SCC share the same `cycle` reference, so a UI that lets the
   * user open a single "show cycle" view doesn't duplicate work.
   */
  cycle?: FinitenessCycle;
}

export interface FinitenessCycleNode {
  predicate: string;
  /** Zero-based column index. */
  columnIndex: number;
  /**
   * Default position-form display label (e.g. `s[1]`, one-based for
   * the user). Consumers with access to the source text can replace
   * this with a richer form, e.g. an elided rule head
   * `s(..., Y, ...)`.
   */
  label: string;
  /**
   * Every source span where this (predicate, columnIndex) is touched —
   * head argument positions in rules defining the predicate, and body
   * atom argument positions wherever the predicate is referenced
   * (positive, non-negated). The playground uses these to highlight
   * the in-source code that participates in the cycle when the
   * "Show cycle" modal is open.
   */
  spans: { offset: number; end: number }[];
  /**
   * Total number of arguments in the head of the *representative* rule
   * for this predicate (the first recursive rule, falling back to the
   * first rule). Lets a renderer know whether to add leading/trailing
   * ellipses around the column position when displaying an elided
   * head form.
   */
  headArity: number;
  /**
   * Source span of the column-th head argument in the representative
   * rule. Absent if the AST node has no CST position (e.g. a
   * synthesised argument).
   */
  headTermSpan?: { offset: number; end: number };
}

export interface FinitenessCycleEdge {
  /** Index into `FinitenessCycle.nodes`. */
  from: number;
  to: number;
  /**
   * True if any path in the original graph from `from` to `to` (going
   * through only rule-variable nodes) used a value-producing edge —
   * i.e. this is the kind of edge that grows the value across
   * iterations.
   */
  growing: boolean;
}

export interface FinitenessCycle {
  nodes: FinitenessCycleNode[];
  edges: FinitenessCycleEdge[];
}

interface Edge {
  from: string;
  to: string;
  plus: boolean;
}

/** Node id for a predicate column. */
const predNode = (predicate: string, col: number) => `pred:${predicate}:${col}`;
/** Node id for a per-rule variable. */
const varNode = (ruleIdx: number, name: string) => `var:${ruleIdx}:${name}`;

/**
 * True for a term that doesn't itself produce a new domain value:
 *   - a bare variable, or
 *   - a string/number/boolean literal.
 *
 * Used to decide whether an edge should be PLUS-labelled. A binary expr,
 * function call, subscript, etc. is *not* trivial.
 */
function isTrivialPassThrough(term: HeadTerm): boolean {
  return (
    term.$type === "Variable" ||
    term.$type === "StringLiteral" ||
    term.$type === "NumberLiteral" ||
    term.$type === "BooleanLiteral"
  );
}

/** True if `term` is a NumberLiteral or `-NumberLiteral`. */
function isNumberLiteralOrNegated(term: HeadTerm): boolean {
  if (term.$type === "NumberLiteral") return true;
  if (term.$type === "UnaryExpr" && term.op === "-" && term.operand.$type === "NumberLiteral") {
    return true;
  }
  return false;
}

/** Collect every Variable name referenced anywhere inside `term`. */
function collectVars(term: HeadTerm, into: Set<string>): void {
  switch (term.$type) {
    case "Variable":
      if (!isAnonymousVar(term.name)) into.add(term.name);
      return;
    case "StringLiteral":
    case "NumberLiteral":
    case "BooleanLiteral":
      return;
    case "UnaryExpr":
      collectVars(term.operand, into);
      return;
    case "BinaryExpr":
      collectVars(term.left, into);
      collectVars(term.right, into);
      return;
    case "Conditional":
      // All three, the condition included. Only the branches reach the value, so
      // this is an over-approximation, and this analysis's errors are meant to
      // fall that way. It costs no spurious warning on its own: a conditional
      // manufactures no value, so it contributes no PLUS edge for a cycle to
      // trip over.
      collectVars(term.consequent, into);
      collectVars(term.cond, into);
      collectVars(term.alternate, into);
      return;
    case "FunctionCall":
      for (const a of term.args) collectVars(a, into);
      return;
    case "AggregateCall":
      collectVars(term.arg, into);
      return;
    case "Subscript":
      collectVars(term.object, into);
      collectVars(term.index, into);
      return;
    case "Slice":
      collectVars(term.object, into);
      if (term.start) collectVars(term.start, into);
      if (term.end) collectVars(term.end, into);
      return;
    case "ArrayLiteral":
      for (const e of term.elements) collectVars(e, into);
      return;
    case "ObjectLiteral":
      for (const entry of term.entries) collectVars(entry.value, into);
      return;
    case "BracketAccess":
      // Should have been rewritten by post-processing; bail safely.
      return;
  }
}

function buildEdges(analyzed: AnalyzedProgram): Edge[] {
  const edges: Edge[] = [];
  const push = (from: string, to: string, plus: boolean) => {
    edges.push({ from, to, plus });
  };

  let ruleIdx = 0;
  for (const [predicate, predRules] of analyzed.rules) {
    for (const rule of predRules) {
      const ri = ruleIdx++;
      processRule(rule, ri, predicate, push);
    }
  }
  return edges;
}

function processRule(
  rule: Rule,
  ri: number,
  headPredicate: string,
  push: (from: string, to: string, plus: boolean) => void,
): void {
  // --- Body: each positive atom feeds variables (or is constrained by exprs).
  for (const elem of rule.body) {
    if (elem.$type === "Literal" && !elem.negated) {
      const builtin = BUILTIN_BODY_ATOMS.get(elem.predicate);
      if (builtin) {
        // A value-iteration builtin (object_entry/array_element) binds its
        // output positions from the source value, so flow must run
        // source -> outputs. Extraction yields a strictly smaller sub-value,
        // so the edge is not PLUS (a pure-extraction cycle stays unflagged);
        // a recursion that re-wraps the output picks up its PLUS edge from
        // the wrapping equality/head. Modelling it as a plain predicate
        // instead severs the flow and hides genuine infinite recursion.
        const sources = new Set<string>();
        collectVars(elem.args[builtin.sourceArg]!, sources);
        for (const { index } of builtin.boundArgs) {
          const out = elem.args[index];
          if (out?.$type === "Variable" && !isAnonymousVar(out.name)) {
            for (const s of sources) push(varNode(ri, s), varNode(ri, out.name), false);
          }
        }
      } else {
        processBodyAtom(elem, ri, push);
      }
    } else if (elem.$type === "Equality") {
      for (const binding of equalityBindingCandidates(elem)) {
        const v = binding.variable;
        if (isAnonymousVar(v)) continue;
        const target = varNode(ri, v);
        const sources = new Set<string>();
        collectVars(binding.expr, sources);
        for (const s of sources) {
          push(varNode(ri, s), target, !isTrivialPassThrough(binding.expr));
        }
      }
    } else if (elem.$type === "RangeAtom" && elem.expr.$type === "Variable") {
      // Binding range: V in [lo..hi].
      // Literal-bounded ranges are finite by construction. Non-literal
      // (variable-bounded) ranges can grow unboundedly if the bound
      // depends on a recursive predicate, so mark PLUS.
      const v = elem.expr.name;
      if (isAnonymousVar(v)) continue;
      const target = varNode(ri, v);
      const literalBounds =
        isNumberLiteralOrNegated(elem.low) && isNumberLiteralOrNegated(elem.high);
      const sources = new Set<string>();
      collectVars(elem.low, sources);
      collectVars(elem.high, sources);
      for (const s of sources) push(varNode(ri, s), target, !literalBounds);
    }
    // Other body elements (negated atoms, boolean filters, non-binding
    // equalities, filter ranges) are filters: they don't carry values
    // forward, so they contribute no edges.
  }

  // --- Head: variables / aggregates / expressions feed predicate columns.
  for (let j = 0; j < rule.head.args.length; j++) {
    const arg = rule.head.args[j]!;
    const target = predNode(headPredicate, j);

    if (arg.$type === "Variable") {
      if (isAnonymousVar(arg.name)) continue;
      push(varNode(ri, arg.name), target, false);
      continue;
    }
    if (arg.$type === "AggregateCall") {
      // Aggregates collapse a stream of rows to one value per group; the
      // result lives in the same domain (count → integer, min/max →
      // arg's domain, group_concat → string). No new values are
      // manufactured iteration-over-iteration, so don't mark PLUS.
      const sources = new Set<string>();
      collectVars(arg.arg, sources);
      for (const s of sources) push(varNode(ri, s), target, false);
      continue;
    }
    if (
      arg.$type === "StringLiteral" ||
      arg.$type === "NumberLiteral" ||
      arg.$type === "BooleanLiteral"
    ) {
      // Constant in the head; no source vars, no edges.
      continue;
    }
    // Any other expression — BinaryExpr, FunctionCall, Subscript, Slice,
    // UnaryExpr — is a value-producing operation.
    const sources = new Set<string>();
    collectVars(arg, sources);
    for (const s of sources) push(varNode(ri, s), target, true);
  }
}

function processBodyAtom(
  atom: Literal,
  ri: number,
  push: (from: string, to: string, plus: boolean) => void,
): void {
  for (let j = 0; j < atom.args.length; j++) {
    const arg = atom.args[j]!;
    const colNode = predNode(atom.predicate, j);

    if (arg.$type === "Variable") {
      if (isAnonymousVar(arg.name)) continue;
      // Body atom binds the variable from the column's value.
      push(colNode, varNode(ri, arg.name), false);
      continue;
    }
    if (
      arg.$type === "StringLiteral" ||
      arg.$type === "NumberLiteral" ||
      arg.$type === "BooleanLiteral"
    ) {
      // Constant filter: no edges.
      continue;
    }
    // Non-trivial body argument like `p(X + 1, Y)`: the variables in the
    // expression flow *into* the column constraint. Treat as PLUS so a
    // recursive cycle through this position will flag.
    const sources = new Set<string>();
    collectVars(arg as Expression, sources);
    for (const s of sources) push(varNode(ri, s), colNode, true);
  }
}

/**
 * Collect every source span where this (predicate, column) pair is
 * touched: the head argument at `columnIndex` of every rule defining
 * `predicate`, plus the body atom argument at `columnIndex` of every
 * positive (non-negated) atom referencing `predicate` anywhere in the
 * program. Used by the playground to highlight the in-code positions
 * that participate in a cycle when the "Show cycle" modal is open.
 */
function collectNodeSpans(
  analyzed: AnalyzedProgram,
  predicate: string,
  columnIndex: number,
): { offset: number; end: number }[] {
  const spans: { offset: number; end: number }[] = [];
  for (const [_pred, rules] of analyzed.rules) {
    for (const rule of rules) {
      // Head positions for rules defining this predicate.
      if (rule.head.predicate === predicate) {
        const cst = rule.head.args[columnIndex]?.$cstNode;
        if (cst) spans.push({ offset: cst.offset, end: cst.end });
      }
      // Body atom positions for any rule referencing this predicate.
      for (const elem of rule.body) {
        if (elem.$type !== "Literal" || elem.negated) continue;
        if (elem.predicate !== predicate) continue;
        const cst = elem.args[columnIndex]?.$cstNode;
        if (cst) spans.push({ offset: cst.offset, end: cst.end });
      }
    }
  }
  // Stable order: by offset.
  spans.sort((a, b) => a.offset - b.offset);
  return spans;
}

/**
 * The "representative" rule for a flagged predicate: the first rule
 * whose body recurses into the same SCC (the rule that *does* the
 * looping), falling back to the first rule overall if none does. The
 * recursive rule is the more interesting one for diagnostics — base
 * cases like `s(0).` carry no value-producing structure to point at.
 */
function representativeRule(
  predicate: string,
  analyzed: AnalyzedProgram,
  sccOf: Map<string, Set<string>>,
): Rule | undefined {
  const predRules = analyzed.rules.get(predicate) ?? [];
  const sccSet = sccOf.get(predicate);
  const recursive = predRules.find((r) =>
    sccSet
      ? r.body.some(
          (elem) => elem.$type === "Literal" && !elem.negated && sccSet.has(elem.predicate),
        )
      : false,
  );
  return recursive ?? predRules[0];
}

/**
 * Project a flagged SCC onto its predicate-column nodes only.
 *
 * Rule-variable intermediates (`var:r:V`) are collapsed: an edge in the
 * projection means "values flow from pred-column u to pred-column v
 * along some path through var-nodes inside this SCC". The edge is
 * `growing: true` if any path between the two carries a PLUS-labelled
 * edge — that's the signal the UI uses to colour the value-producing
 * step distinctly.
 *
 * BFS state is `(node, plus_seen)`; we dedupe on that pair so cycles
 * among var-nodes terminate, while still exploring both clean and
 * plus-tainted paths if both exist.
 */
function projectCycle(
  scc: string[],
  adj: Map<string, Edge[]>,
  analyzed: AnalyzedProgram,
  sccOf: Map<string, Set<string>>,
): FinitenessCycle {
  const sccSet = new Set(scc);
  const predNodes = scc.filter((n) => n.startsWith("pred:"));

  const nodeIndex = new Map<string, number>();
  const nodes: FinitenessCycleNode[] = predNodes.map((n, i) => {
    const rest = n.slice("pred:".length);
    const lastColon = rest.lastIndexOf(":");
    const predicate = rest.slice(0, lastColon);
    const columnIndex = Number(rest.slice(lastColon + 1));
    nodeIndex.set(n, i);
    const rule = representativeRule(predicate, analyzed, sccOf);
    const argCst = rule?.head.args[columnIndex]?.$cstNode;
    return {
      predicate,
      columnIndex,
      label: `${predicate}[${columnIndex + 1}]`,
      spans: collectNodeSpans(analyzed, predicate, columnIndex),
      headArity: rule?.head.args.length ?? 0,
      headTermSpan: argCst ? { offset: argCst.offset, end: argCst.end } : undefined,
    };
  });

  const edgeMap = new Map<string, FinitenessCycleEdge>();
  const edgeKey = (from: number, to: number) => `${from}->${to}`;

  for (const u of predNodes) {
    const fromIdx = nodeIndex.get(u)!;
    const visited = new Set<string>();
    type Frame = { node: string; plus: boolean };
    const queue: Frame[] = [];
    const enqueue = (node: string, plus: boolean) => {
      const key = `${node}|${plus ? 1 : 0}`;
      if (visited.has(key)) return;
      visited.add(key);
      queue.push({ node, plus });
    };
    for (const e of adj.get(u) ?? []) {
      if (sccSet.has(e.to)) enqueue(e.to, e.plus);
    }
    while (queue.length) {
      const frame = queue.shift()!;
      if (frame.node.startsWith("pred:")) {
        const toIdx = nodeIndex.get(frame.node)!;
        const key = edgeKey(fromIdx, toIdx);
        const existing = edgeMap.get(key);
        if (!existing) {
          edgeMap.set(key, { from: fromIdx, to: toIdx, growing: frame.plus });
        } else if (frame.plus && !existing.growing) {
          existing.growing = true;
        }
        continue;
      }
      for (const e of adj.get(frame.node) ?? []) {
        if (sccSet.has(e.to)) enqueue(e.to, frame.plus || e.plus);
      }
    }
  }

  return { nodes, edges: [...edgeMap.values()] };
}

/**
 * Find SCCs that contain at least one PLUS-labelled internal edge, and
 * report every predicate-column node inside such SCCs.
 */
export function findInfiniteRisks(analyzed: AnalyzedProgram): FinitenessDiagnostic[] {
  const edges = buildEdges(analyzed);

  // Build adjacency list.
  const adj = new Map<string, Edge[]>();
  const allNodes = new Set<string>();
  for (const e of edges) {
    allNodes.add(e.from);
    allNodes.add(e.to);
    let list = adj.get(e.from);
    if (!list) {
      list = [];
      adj.set(e.from, list);
    }
    list.push(e);
  }

  // Tarjan's SCC.
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let nextIndex = 0;
  const sccs: string[][] = [];

  const visit = (v: string): void => {
    indices.set(v, nextIndex);
    lowlinks.set(v, nextIndex);
    nextIndex++;
    stack.push(v);
    onStack.add(v);

    for (const e of adj.get(v) ?? []) {
      const w = e.to;
      if (!indices.has(w)) {
        visit(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  };

  for (const v of allNodes) {
    if (!indices.has(v)) visit(v);
  }

  // Resolve each predicate's SCC up front so the per-rule recursion
  // check (in `representativeRule`, used both during cycle projection
  // and diagnostic emission) is a Set lookup rather than a linear scan.
  const sccOf = new Map<string, Set<string>>();
  for (const stratum of analyzed.sortedStrata) {
    const set = new Set(stratum);
    for (const p of stratum) sccOf.set(p, set);
  }

  // For each SCC, determine if it contains a PLUS edge between members.
  // A trivial SCC (one node, no self-loop) is irrelevant — it has no cycle.
  // Also project the offending SCC down to predicate-column nodes once
  // (the projection is what we hand to the UI for visualisation).
  const flagged = new Set<string>();
  const cycleByNode = new Map<string, FinitenessCycle>();
  for (const scc of sccs) {
    const members = new Set(scc);
    let hasPlus = false;
    let hasCycle = scc.length > 1;
    outer: for (const v of scc) {
      for (const e of adj.get(v) ?? []) {
        if (!members.has(e.to)) continue;
        if (e.from === e.to) hasCycle = true;
        if (e.plus) {
          hasPlus = true;
          if (hasCycle) break outer;
        }
      }
    }
    if (hasCycle && hasPlus) {
      const projection = projectCycle(scc, adj, analyzed, sccOf);
      for (const v of scc) {
        flagged.add(v);
        if (v.startsWith("pred:")) cycleByNode.set(v, projection);
      }
    }
  }

  // Translate flagged predicate-column nodes into diagnostics.
  //
  // Span attachment: point the warning at the *specific head argument*
  // of the *first recursive rule* — the column whose value loops back
  // around the cycle. Two reasons:
  //   1. Highlighting the whole rule head is too coarse: a rule like
  //      `fib_step(I + 1, Curr, Prev + Curr) :- ...` has three flagged
  //      columns, and underlining the entire head three times tells
  //      the reader nothing about *which* argument is the problem.
  //      Underlining the position itself (`I + 1` for col1,
  //      `Prev + Curr` for col3) does.
  //   2. The first rule for a predicate is often the base case
  //      (e.g. `fib_step(1, 0, 1).`); the value-producing edge lives
  //      in a *recursive* rule, where the column references the
  //      predicate in the body. Skip non-recursive rules so the
  //      warning lands on the rule that actually does the recursion.
  const diagnostics: FinitenessDiagnostic[] = [];
  for (const node of flagged) {
    if (!node.startsWith("pred:")) continue;
    const rest = node.slice("pred:".length);
    const lastColon = rest.lastIndexOf(":");
    const predicate = rest.slice(0, lastColon);
    const columnIndex = Number(rest.slice(lastColon + 1));

    const predRules = analyzed.rules.get(predicate) ?? [];
    const repRule = representativeRule(predicate, analyzed, sccOf);
    // Span priority:
    //   1. the head argument at columnIndex on the representative rule
    //   2. that rule's head (fallback if the argument has no CST node)
    //   3. the first rule's head (defensive — should be redundant with
    //      the representative-rule fallback)
    const argCst = repRule?.head.args[columnIndex]?.$cstNode;
    const headCst = repRule?.head.$cstNode ?? predRules[0]?.head.$cstNode;
    const cst = argCst ?? headCst;

    diagnostics.push({
      severity: "warning",
      code: "potentially-infinite-column",
      message: `Column ${columnIndex + 1} of predicate '${predicate}' is on a value-producing recursion cycle and may grow without bound`,
      predicate,
      columnIndex,
      offset: cst?.offset,
      end: cst?.end,
      cycle: cycleByNode.get(node),
    });
  }

  // Stable order: by predicate name then column.
  diagnostics.sort((a, b) => {
    if (a.predicate !== b.predicate) return a.predicate < b.predicate ? -1 : 1;
    return a.columnIndex - b.columnIndex;
  });

  return diagnostics;
}
