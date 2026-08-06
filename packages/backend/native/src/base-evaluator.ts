// Shared scaffolding for in-memory Datalog evaluators. Both the naive and
// semi-naive evaluators extend `BaseDatalogEvaluator` and only override
// `computeAll` (the fixed-point driver). Everything else — relation
// storage, EDB ingestion, query projection, aggregate reduction, dedup,
// trace event emission — lives here so the two implementations can't
// drift in result semantics or trace output.

import type { HeadAtom, Query, Rule, TypedProgram } from "datamog-core";
import {
  containsAggregate,
  hasGroupingColumns,
  literalBindings,
  queryProjection,
  rebuildVarTypes,
} from "datamog-core";
import type { QueryResult } from "datamog-engine";
import {
  type Relation,
  type RulePlan,
  addRow,
  clearRelation,
  enumerate,
  evalAggregate,
  makeRelation,
  planRule,
  rowKey,
} from "./planner.ts";
import type { TraceCallback, TraceTuple } from "./trace.ts";
import { type Substitution, type Value, evalTerm } from "./values.ts";

/**
 * Why a stratum's fixed-point loop stopped before converging. Recorded on
 * `capInfo` when the optional iteration cap is hit. See
 * `doc/design/finiteness-checking.md`.
 */
export interface IterationCapInfo {
  /** Index of the stratum that hit the cap. */
  stratum: number;
  /** Number of fixed-point passes run before stopping. */
  iteration: number;
  /** Recursive predicates in the capped stratum (the ones still growing). */
  predicates: string[];
}

/** Per-call knobs for a subclass's fixed-point driver. */
export interface FixpointOptions {
  /**
   * Iteration number the first pass reports in its trace events. A parity
   * stratum runs several fixed points back to back, and the iteration counter
   * stays monotone across them so a trace consumer sees one increasing
   * sequence per stratum rather than a counter that restarts each round.
   */
  startIteration: number;
  /** Maximum passes this call may run. Undefined means run to convergence. */
  budget?: number;
}

export interface EvaluatorOptions {
  trace?: TraceCallback;
  /**
   * Maximum fixed-point passes per stratum. Undefined means unlimited (run to
   * the least fixed point). When a stratum reaches the cap without converging,
   * evaluation stops and `capInfo` is set; the partial (prefix) relations are
   * kept.
   */
  maxIterations?: number;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export abstract class BaseDatalogEvaluator {
  readonly relations = new Map<string, Relation>();
  protected trace?: TraceCallback;
  /** Tracks which EDBs have already emitted an `edb-loaded` event. */
  private loadedEmitted = new Set<string>();
  protected analyzed: TypedProgram;
  protected maxIterations?: number;
  /**
   * Set by a subclass's fixed-point driver when a stratum hits the iteration
   * cap without converging. Undefined means every stratum reached its fixed
   * point.
   */
  capInfo?: IterationCapInfo;

  constructor(analyzed: TypedProgram, opts?: EvaluatorOptions) {
    this.analyzed = analyzed;
    this.trace = opts?.trace;
    this.maxIterations = opts?.maxIterations;
    for (const pred of analyzed.extDecls.keys()) {
      this.relations.set(pred, makeRelation());
    }
    for (const pred of analyzed.rules.keys()) {
      this.relations.set(pred, makeRelation());
    }
  }

  /**
   * Recursive predicates of a stratum, for reporting which relations were
   * still growing when the cap was hit. Falls back to the whole stratum if
   * none are marked recursive (should not happen when a loop is capped).
   */
  protected cappedPredicates(stratum: string[]): string[] {
    const recursive = stratum.filter((p) => this.analyzed.recursivePredicates.has(p));
    return recursive.length > 0 ? recursive : [...stratum];
  }

  /** Append EDB rows (called by the backend's `insertRows` path). */
  appendEdb(predicate: string, rows: Record<string, unknown>[]): void {
    const decl = this.analyzed.extDecls.get(predicate);
    if (!decl) throw new Error(`Unknown extensional predicate '${predicate}'`);
    const rel = this.relations.get(predicate)!;
    const appended: Value[][] = [];
    for (const row of rows) {
      const tuple: Value[] = decl.columns.map((c) => row[c.name] as Value);
      if (addRow(rel, tuple)) appended.push(tuple);
    }
    if (this.trace && !this.loadedEmitted.has(predicate)) {
      this.loadedEmitted.add(predicate);
      this.trace({
        kind: "edb-loaded",
        predicate,
        tuples: appended.map((t) => ({ values: t })),
      });
    }
  }

  /**
   * Run this evaluator's fixed point over `stratum`, treating every relation
   * outside it as frozen input. Returns the number of passes run. The two
   * evaluators differ only here.
   */
  protected abstract runFixpoint(
    stratum: string[],
    stratumIdx: number,
    opts: FixpointOptions,
  ): number;

  /** Compute every IDB stratum in dependency order. */
  computeAll(): void {
    for (let s = 0; s < this.analyzed.sortedStrata.length; s++) {
      const stratum = this.analyzed.sortedStrata[s]!;
      const maximal = stratum.filter((p) => this.analyzed.maximalPredicates.has(p));
      const minimal = stratum.filter((p) => !this.analyzed.maximalPredicates.has(p));
      this.trace?.({
        kind: "stratum-start",
        stratum: s,
        predicates: [...stratum],
        recursive: stratum.some((p) => this.analyzed.recursivePredicates.has(p)),
        parity: maximal.length > 0 && minimal.length > 0,
      });
      // A stratum needs the alternating driver only when both polarities are
      // present. One polarity on its own has nothing to alternate against, so
      // the sigil is inert and the ordinary fixed point gives the same answer
      // without paying for a round it cannot use. See
      // `doc/design/parity-stratification.md` §11.
      const passes =
        maximal.length > 0 && minimal.length > 0
          ? this.runParityStratum(minimal, maximal, s)
          : this.runFixpoint(stratum, s, { startIteration: 0, budget: this.maxIterations });
      this.trace?.({ kind: "stratum-end", stratum: s, iterations: passes });
    }
  }

  /**
   * Alternating fixed point for a parity-stratified stratum. Minimal
   * predicates rise from ∅, maximal ones start at ⊤ and are rebuilt from ∅
   * each round, so they fall. Iterate until the maximal relations stop
   * changing; the minimal side is then already at its fixed point for that
   * value. See `doc/design/parity-stratification.md` §4.
   */
  private runParityStratum(minimal: string[], maximal: string[], stratumIdx: number): number {
    // Round 0 reads every maximal predicate as ⊤, which the polarity check
    // guarantees is only ever observed by a negated atom (§4.1).
    for (const p of maximal) this.relations.get(p)!.isTop = true;

    let passes = 0;
    let round = 0;
    let previous: Set<string> | null = null;
    for (;;) {
      this.trace?.({ kind: "round-start", stratum: stratumIdx, round });

      // Minimal side: keeps the tuples it already has. Sound because the
      // maximal side only shrinks, so nothing derivable under the previous
      // round's value stops being derivable under this one.
      passes += this.runFixpoint(minimal, stratumIdx, {
        startIteration: passes,
        budget: this.remainingBudget(passes),
      });
      // Compare the stratum index rather than testing `capInfo` for presence:
      // an earlier stratum may have capped already, and that is not a reason to
      // abandon this one.
      if (this.capInfo?.stratum === stratumIdx) {
        this.reportParityCap(minimal, maximal);
        break;
      }

      // Maximal side: rebuilt from ∅ against the minimal side just computed.
      // Facts survive this, being rules with an empty body.
      for (const p of maximal) {
        const rel = this.relations.get(p)!;
        const removed = rel.tuples.length;
        clearRelation(rel);
        this.trace?.({
          kind: "relation-cleared",
          stratum: stratumIdx,
          round,
          predicate: p,
          removed,
        });
      }
      passes += this.runFixpoint(maximal, stratumIdx, {
        startIteration: passes,
        budget: this.remainingBudget(passes),
      });
      if (this.capInfo?.stratum === stratumIdx) {
        this.reportParityCap(minimal, maximal);
        break;
      }

      const current = this.snapshot(maximal);
      this.trace?.({ kind: "round-end", stratum: stratumIdx, round });
      if (previous && setsEqual(previous, current)) break;
      previous = current;
      round++;
    }

    return passes;
  }

  /**
   * Widen a cap report to the whole parity stratum. `runFixpoint` only sees
   * the phase it was handed, but running out mid-alternation leaves both sides
   * incomplete, so both are worth naming.
   */
  private reportParityCap(minimal: string[], maximal: string[]): void {
    if (!this.capInfo) return;
    this.capInfo.predicates = this.cappedPredicates([...minimal, ...maximal]);
  }

  /** Passes left in this stratum's budget, or undefined when uncapped. */
  private remainingBudget(spent: number): number | undefined {
    if (this.maxIterations === undefined) return undefined;
    return Math.max(0, this.maxIterations - spent);
  }

  /** Row keys of every tuple in `predicates`, for round-to-round comparison. */
  private snapshot(predicates: string[]): Set<string> {
    const keys = new Set<string>();
    for (const p of predicates) {
      for (const k of this.relations.get(p)!.keys) keys.add(`${p}\x00${k}`);
    }
    return keys;
  }

  /**
   * Run a top-level query and project its result rows. Queries are
   * conjunctive bodies (literals, equalities, range atoms, filters)
   * with an implicit projection: every distinct named variable
   * mentioned positively in the body appears as one output column, in
   * first-mention source order. Ground queries — no projected
   * variables — produce a single empty row if any binding satisfies
   * the body, or no rows at all.
   */
  runQuery(query: Query): QueryResult {
    const projection = queryProjection(query);

    // Synthesize a Rule from the query body so the existing planner
    // can produce an execution plan. The head args are the projected
    // variables (or any placeholder for a ground query — `enumerate`
    // doesn't read the head, only the body's steps). Container
    // pointers don't match Langium's expected types, but the planner
    // only walks $cstNode and the body shape; cast through unknown.
    const syntheticHead = {
      $type: "HeadAtom",
      predicate: "__query__",
      args: projection.slice(),
    } as unknown as HeadAtom;
    const syntheticRule = {
      $type: "Rule",
      head: syntheticHead,
      body: query.body,
      $cstNode: query.$cstNode,
    } as unknown as Rule;

    const plan: RulePlan = planRule(syntheticRule, this.analyzed);
    // Seed variable types from the query body so binding-time
    // coercions agree with what the translator emits.
    plan.env.vars = rebuildVarTypes(query.body, this.analyzed.columnTypes);

    const seen = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    for (const sub of enumerate(plan.steps, 0, new Map(), plan.env, this.relations)) {
      const out: Record<string, unknown> = {};
      for (const v of projection) {
        if (v.$type !== "Variable") continue;
        out[v.name] = sub.get(v.name) ?? null;
      }
      // Dedup. For a ground query (projection is empty), every
      // satisfying binding produces the same `{}` row, so the seen
      // set collapses them to a single emission.
      const k = JSON.stringify(out);
      if (!seen.has(k)) {
        seen.add(k);
        rows.push(out);
      }
    }

    return {
      sql: "",
      source: query.$cstNode?.text,
      rows,
    };
  }

  protected isAggregateRule(rule: Rule): boolean {
    return rule.head.args.some(containsAggregate);
  }

  /** Enumerate body bindings and project the head, no aggregation. */
  protected enumerateRule(rule: Rule, plan: RulePlan): Value[][] {
    const out: Value[][] = [];
    for (const sub of enumerate(plan.steps, 0, new Map(), plan.env, this.relations)) {
      out.push(rule.head.args.map((arg) => evalTerm(arg, sub, plan.env)));
    }
    return out;
  }

  /**
   * Group body bindings by the non-aggregate head positions, then reduce
   * each group's aggregate columns.
   */
  protected evaluateAggregateHead(rule: Rule, plan: RulePlan): Value[][] {
    const groups = new Map<string, { key: Value[]; subs: Substitution[] }>();
    for (const sub of enumerate(plan.steps, 0, new Map(), plan.env, this.relations)) {
      const key: Value[] = [];
      for (const arg of rule.head.args) {
        if (!containsAggregate(arg)) {
          key.push(evalTerm(arg, sub, plan.env));
        }
      }
      const k = rowKey(key);
      const g = groups.get(k);
      if (g) {
        g.subs.push(sub);
      } else {
        groups.set(k, { key, subs: [sub] });
      }
    }

    // SQL emits one row from a `SELECT agg(...) FROM empty` (no GROUP BY) —
    // count is 0, sum/min/max/avg are NULL. Mirror that here so an aggregate
    // rule with no grouping columns whose body produces nothing still yields
    // a single tuple of default aggregate values, matching every SQL backend.
    //
    // What counts as a grouping column is `hasGroupingColumns`, shared with the
    // translator and the nullness analysis, so a rule like
    // `total("hello", count(*))` is ungrouped and emits its default row.
    if (groups.size === 0 && !hasGroupingColumns(rule)) {
      const env = plan.env;
      // A literal-bound grouping variable still has a value, and it comes from
      // the body's equality rather than from any row, so seed it: with no rows
      // there is no substitution to read `G` out of in
      // `total(G, count(*)) :- p(_), G = "hello".`
      const sub: Substitution = new Map();
      for (const [name, expr] of literalBindings(rule)) {
        sub.set(name, evalTerm(expr, new Map(), env));
      }
      const tuple = rule.head.args.map((arg) =>
        containsAggregate(arg)
          ? evalTerm(arg, sub, env, (agg) => evalAggregate(agg, [], env))
          : evalTerm(arg, sub, env),
      );
      return [tuple];
    }

    const results: Value[][] = [];
    for (const { key, subs } of groups.values()) {
      const tuple: Value[] = [];
      let keyIdx = 0;
      for (const arg of rule.head.args) {
        if (containsAggregate(arg)) {
          // Ordinary variables inside an aggregate expression are grouping
          // variables (the analyzer enforces it), so they hold one value
          // across the group and `subs[0]` speaks for all of them.
          tuple.push(
            evalTerm(arg, subs[0] ?? new Map(), plan.env, (agg) =>
              evalAggregate(agg, subs, plan.env),
            ),
          );
        } else {
          tuple.push(key[keyIdx++]!);
        }
      }
      results.push(tuple);
    }
    return results;
  }

  /**
   * Run every produced tuple through dedup against the live relation and
   * any pending adds from earlier rules in the same iteration. Returns the
   * derived count (pre-dedup) and the tuples that survived dedup.
   */
  protected applyAdds(
    liveRel: Relation,
    pendRel: Relation,
    produced: Iterable<Value[]>,
  ): { derived: number; added: Value[][] } {
    const added: Value[][] = [];
    let derived = 0;
    for (const tuple of produced) {
      derived++;
      const key = rowKey(tuple);
      if (liveRel.keys.has(key) || pendRel.keys.has(key)) continue;
      addRow(pendRel, tuple);
      added.push(tuple);
    }
    return { derived, added };
  }

  protected emitRuleApplied(args: {
    stratum: number;
    iteration: number;
    predicate: string;
    rule: Rule;
    ruleIndex: number;
    derived: number;
    added: Value[][];
  }): void {
    if (!this.trace) return;
    const tuples: TraceTuple[] = args.added.map((t) => ({ values: t }));
    const ruleCst = args.rule.$cstNode;
    const headCst = args.rule.head.$cstNode;
    this.trace({
      kind: "rule-applied",
      stratum: args.stratum,
      iteration: args.iteration,
      predicate: args.predicate,
      ruleIndex: args.ruleIndex,
      ruleSpan: ruleCst ? { offset: ruleCst.offset, end: ruleCst.end } : undefined,
      headSpan: headCst ? { offset: headCst.offset, end: headCst.end } : undefined,
      derived: args.derived,
      added: tuples,
    });
  }
}
