// Semi-naive bottom-up Datalog evaluator.
//
// Design notes:
//
// - Inherits relation storage, EDB ingestion, query projection, aggregate
//   reduction, dedup, and trace plumbing from `BaseDatalogEvaluator` in
//   `datamog-backend-native`. Only the fixed-point driver below differs
//   from the naive evaluator.
//
// - Per-stratum pipeline:
//     1. Priming pass (iteration 0): run every rule once with an empty
//        delta, exactly like naive. This seeds recursive predicates from
//        their base-case rules and computes non-recursive rules in full.
//        Non-recursive strata terminate here.
//     2. Delta loop (iterations 1..n): for every rule that has at least
//        one body atom referencing a same-stratum predicate, fire it once
//        per such position — with that position reading from δ_{k-1} and
//        all other atoms reading from the current `all`. The union of
//        tuples produced across positions (deduped against `all` and
//        other pending adds) becomes δ_k.
//     3. Terminate when δ_k is empty for every predicate in the stratum.
//
// - Trace events mirror the naive backend so the playground's step view
//   renders seminaive runs without any UI changes. A seminaive
//   `rule-applied` event rolls up all delta-position variants into one
//   summary per rule per iteration.
//
// - Aggregate predicates are guaranteed non-recursive by the analyzer, so
//   their rules are only ever executed in the priming pass.

import {
  BaseDatalogEvaluator,
  type FixpointOptions,
  type Relation,
  type RulePlan,
  type Step,
  type Value,
  addRow,
  enumerate,
  evalTerm,
  makeRelation,
  planRule,
} from "datamog-backend-native";
import type { Rule } from "datamog-core";

interface RuleInfo {
  rule: Rule;
  ruleIndex: number;
  plan: RulePlan;
  /** Step-plan indices of positive atoms whose predicate is in the stratum. */
  deltaPositions: number[];
  isAggregate: boolean;
}

export class SemiNaiveEvaluator extends BaseDatalogEvaluator {
  protected runFixpoint(stratum: string[], stratumIdx: number, opts: FixpointOptions): number {
    const stratumSet = new Set(stratum);
    const recursive = stratum.some((p) => this.analyzed.recursivePredicates.has(p));

    // Plan every rule once, and for each plan pre-compute the step indices
    // where the delta substitution is a candidate (positive atoms whose
    // predicate is in this stratum).
    const rulesByPredicate = new Map<string, RuleInfo[]>();
    for (const predicate of stratum) {
      const rules = this.analyzed.rules.get(predicate) ?? [];
      const infos: RuleInfo[] = rules.map((rule, ruleIndex) => {
        const plan = planRule(rule, this.analyzed);
        const deltaPositions: number[] = [];
        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i]!;
          if (step.kind === "atom" && stratumSet.has(step.atom.predicate)) {
            deltaPositions.push(i);
          }
        }
        return { rule, ruleIndex, plan, deltaPositions, isAggregate: this.isAggregateRule(rule) };
      });
      rulesByPredicate.set(predicate, infos);
    }

    // --- Priming (pass 0): run every rule naively against `all`. ---
    let passes = 0;
    let iteration = opts.startIteration;
    let delta = new Map<string, Relation>();
    for (const p of stratum) delta.set(p, makeRelation());

    if (opts.budget === 0) {
      this.capInfo = {
        stratum: stratumIdx,
        iteration,
        predicates: this.cappedPredicates(stratum),
      };
      return 0;
    }

    {
      this.trace?.({ kind: "iteration-start", stratum: stratumIdx, iteration });
      const pending = new Map<string, Relation>();
      for (const p of stratum) pending.set(p, makeRelation());
      let iterationAdded = 0;

      for (const predicate of stratum) {
        const infos = rulesByPredicate.get(predicate)!;
        const liveRel = this.relations.get(predicate)!;
        const pendRel = pending.get(predicate)!;
        for (const info of infos) {
          const produced = info.isAggregate
            ? this.evaluateAggregateHead(info.rule, info.plan)
            : this.enumerateRule(info.rule, info.plan);
          const { derived, added } = this.applyAdds(liveRel, pendRel, produced);
          iterationAdded += added.length;
          this.emitRuleApplied({
            stratum: stratumIdx,
            iteration,
            predicate,
            rule: info.rule,
            ruleIndex: info.ruleIndex,
            derived,
            added,
          });
        }
      }

      // Flush: move pending → live and record delta for the next iteration.
      for (const p of stratum) {
        const liveRel = this.relations.get(p)!;
        const deltaRel = delta.get(p)!;
        for (const tuple of pending.get(p)!.tuples) {
          if (addRow(liveRel, tuple)) addRow(deltaRel, tuple);
        }
      }

      this.trace?.({
        kind: "iteration-end",
        stratum: stratumIdx,
        iteration,
        added: iterationAdded,
      });
      passes++;
    }

    // --- Delta loop: only rules with at least one stratum-body-atom fire. ---
    if (recursive) {
      while (this.anyNonEmpty(delta)) {
        // The priming pass above already ran, so `passes` counts it. Cap the
        // total passes at the caller's budget, keeping the partial (prefix)
        // relations.
        if (opts.budget !== undefined && passes >= opts.budget) {
          this.capInfo = {
            stratum: stratumIdx,
            iteration: iteration + 1,
            predicates: this.cappedPredicates(stratum),
          };
          break;
        }
        iteration++;
        this.trace?.({ kind: "iteration-start", stratum: stratumIdx, iteration });

        const pending = new Map<string, Relation>();
        for (const p of stratum) pending.set(p, makeRelation());
        let iterationAdded = 0;

        for (const predicate of stratum) {
          const infos = rulesByPredicate.get(predicate)!;
          const liveRel = this.relations.get(predicate)!;
          const pendRel = pending.get(predicate)!;
          for (const info of infos) {
            // Aggregate rules are non-recursive by construction, so they
            // have no delta positions and were fully evaluated during
            // priming. Skip them outright (also keeps the invariant that
            // `enumerate` never sees an aggregate rule with a delta).
            if (info.isAggregate || info.deltaPositions.length === 0) continue;

            const produced = this.enumerateRuleWithDelta(
              info.rule,
              info.plan,
              info.deltaPositions,
              delta,
            );
            const { derived, added } = this.applyAdds(liveRel, pendRel, produced);
            iterationAdded += added.length;
            this.emitRuleApplied({
              stratum: stratumIdx,
              iteration,
              predicate,
              rule: info.rule,
              ruleIndex: info.ruleIndex,
              derived,
              added,
            });
          }
        }

        // Build the next delta from this iteration's fresh adds.
        const nextDelta = new Map<string, Relation>();
        for (const p of stratum) nextDelta.set(p, makeRelation());
        for (const p of stratum) {
          const liveRel = this.relations.get(p)!;
          const nextRel = nextDelta.get(p)!;
          for (const tuple of pending.get(p)!.tuples) {
            if (addRow(liveRel, tuple)) addRow(nextRel, tuple);
          }
        }

        this.trace?.({
          kind: "iteration-end",
          stratum: stratumIdx,
          iteration,
          added: iterationAdded,
        });

        delta = nextDelta;
        passes++;
      }
    }

    return passes;
  }

  private anyNonEmpty(delta: Map<string, Relation>): boolean {
    for (const rel of delta.values()) if (rel.tuples.length > 0) return true;
    return false;
  }

  /**
   * Fire `rule` once per entry in `deltaPositions`. In variant k, the atom
   * at plan.steps[deltaPositions[k]] reads from `delta`; every other atom
   * reads from `this.relations`. The union of head tuples produced across
   * all variants is returned (duplicate tuples are allowed — the caller
   * dedups against liveRel/pendRel).
   */
  private enumerateRuleWithDelta(
    rule: Rule,
    plan: RulePlan,
    deltaPositions: number[],
    delta: ReadonlyMap<string, Relation>,
  ): Value[][] {
    const out: Value[][] = [];
    for (const pos of deltaPositions) {
      for (const sub of enumerate(plan.steps, 0, new Map(), plan.env, this.relations, {
        stepIndex: pos,
        relations: delta,
      })) {
        const tuple = rule.head.args.map((arg) => evalTerm(arg, sub, plan.env));
        // Same rule as the naive driver's projection: a head expression with no
        // value derives no tuple. Stated here too because the delta driver
        // projects its own rows rather than going through `enumerateRule`.
        if (tuple.some((v) => v === undefined)) continue;
        out.push(tuple as Value[]);
      }
    }
    return out;
  }
}

// Re-export a stub so downstream callers needing the shared Step type from
// this package don't have to round-trip through datamog-backend-native.
export type { Step };
