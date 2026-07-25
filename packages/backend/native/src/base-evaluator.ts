// Shared scaffolding for in-memory Datalog evaluators. Both the naive and
// semi-naive evaluators extend `BaseDatalogEvaluator` and only override
// `computeAll` (the fixed-point driver). Everything else — relation
// storage, EDB ingestion, query projection, aggregate reduction, dedup,
// trace event emission — lives here so the two implementations can't
// drift in result semantics or trace output.

import type { HeadAtom, Query, Rule, TypedProgram } from "datamog-core";
import { queryProjection, rebuildVarTypes } from "datamog-core";
import type { QueryResult } from "datamog-engine";
import {
  type Relation,
  type RulePlan,
  addRow,
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

  /** Compute every IDB stratum in dependency order. */
  abstract computeAll(): void;

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
    return rule.head.args.some((a) => a.$type === "AggregateCall");
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
        if (arg.$type !== "AggregateCall") {
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
    // The translator omits literal head args (NumberLiteral/StringLiteral)
    // from GROUP BY because they don't vary per group; mirror that exclusion
    // here so a rule like `total("hello", count(*))` is still treated as
    // ungrouped and emits its default row on empty input.
    const hasGroupingColumns = rule.head.args.some(
      (arg) =>
        arg.$type !== "AggregateCall" &&
        arg.$type !== "NumberLiteral" &&
        arg.$type !== "StringLiteral" &&
        arg.$type !== "BooleanLiteral",
    );
    if (groups.size === 0 && !hasGroupingColumns) {
      const env = plan.env;
      const tuple = rule.head.args.map((arg) =>
        arg.$type === "AggregateCall" ? evalAggregate(arg, [], env) : evalTerm(arg, new Map(), env),
      );
      return [tuple];
    }

    const results: Value[][] = [];
    for (const { key, subs } of groups.values()) {
      const tuple: Value[] = [];
      let keyIdx = 0;
      for (const arg of rule.head.args) {
        if (arg.$type === "AggregateCall") {
          tuple.push(evalAggregate(arg, subs, plan.env));
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
