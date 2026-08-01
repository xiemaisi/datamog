// Naive bottom-up Datalog evaluator.
//
// Design notes for readers coming from the SQL side:
//
// - Each predicate is stored as an in-memory `Relation` (see ./planner.ts):
//   an insertion-ordered tuple list plus a Set of canonical keys for O(1)
//   dedup.
//
// - The evaluator walks strata in topological order. Inside each stratum we
//   run a naive fixed-point: re-evaluate every rule, collect new tuples, and
//   loop until a full pass produces nothing new. See the sibling
//   semi-naive evaluator (`datamog-backend-seminaive`) for the more
//   efficient delta-based variant.
//
// - Strata are processed bottom-up and stratification forbids negation
//   inside an SCC, so a negated body atom always references a predicate that
//   has already reached its fixed point.
//
// - Rule evaluation shares its planner, atom-matcher, aggregate reducer and
//   enumerate generator with the semi-naive backend via `./planner.ts`,
//   and shares EDB ingestion / query projection / dedup / trace plumbing
//   via `BaseDatalogEvaluator` in `./base-evaluator.ts`.

import { BaseDatalogEvaluator, type FixpointOptions } from "./base-evaluator.ts";
import { type Relation, addRow, makeRelation, planRule } from "./planner.ts";
import type { Value } from "./values.ts";

export type { Relation } from "./planner.ts";

export class NaiveEvaluator extends BaseDatalogEvaluator {
  protected runFixpoint(stratum: string[], stratumIdx: number, opts: FixpointOptions): number {
    // Pure naive fixed-point: each iteration computes I_{k+1} = I_k ∪ T(I_k)
    // where T applies every rule to I_k. We implement that by buffering all
    // tuples produced in one pass into a per-predicate "pending" relation —
    // rules within the same iteration don't observe each other's adds, they
    // all read from the iteration-start snapshot. At the end of the pass we
    // flush pending into the live relations.
    let passes = 0;
    let changed = true;
    while (changed) {
      const iteration = opts.startIteration + passes;
      if (opts.budget !== undefined && passes >= opts.budget) {
        this.capInfo = {
          stratum: stratumIdx,
          iteration,
          predicates: this.cappedPredicates(stratum),
        };
        break;
      }
      this.trace?.({ kind: "iteration-start", stratum: stratumIdx, iteration });
      changed = false;
      const pending = new Map<string, Relation>();
      for (const p of stratum) pending.set(p, makeRelation());
      let iterationAdded = 0;

      for (const predicate of stratum) {
        const rules = this.analyzed.rules.get(predicate);
        if (!rules) continue;
        const liveRel = this.relations.get(predicate)!;
        const pendRel = pending.get(predicate)!;
        for (let ri = 0; ri < rules.length; ri++) {
          const rule = rules[ri]!;
          const plan = planRule(rule, this.analyzed);
          const produced: Value[][] = this.isAggregateRule(rule)
            ? this.evaluateAggregateHead(rule, plan)
            : this.enumerateRule(rule, plan);
          const { derived, added } = this.applyAdds(liveRel, pendRel, produced);
          iterationAdded += added.length;
          this.emitRuleApplied({
            stratum: stratumIdx,
            iteration,
            predicate,
            rule,
            ruleIndex: ri,
            derived,
            added,
          });
        }
      }

      // Flush all pending tuples into the live relations. Until now, the
      // live relations still held the iteration-start state.
      for (const predicate of stratum) {
        const liveRel = this.relations.get(predicate)!;
        for (const t of pending.get(predicate)!.tuples) {
          if (addRow(liveRel, t)) changed = true;
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

    return passes;
  }
}
