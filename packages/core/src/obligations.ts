// Proof obligations for refinement contracts, as SMT-LIB 2.
//
// Phase 2 of doc/design/refinement-annotations.md. The script is the
// deliverable: nothing here runs a solver, and no phase may assume a
// particular one, so the obligation set's public form is text every solver
// reads.
//
// Two things the encoding must not delegate to the solver:
//
//   - SMT-LIB's `div`/`mod` are Euclidean, with a non-negative remainder,
//     where Datamog truncates toward zero and takes the dividend's sign
//     (spec §5.3). Both are written out.
//   - `integer` is `[-(2^53 - 1), 2^53 - 1]` and arithmetic leaving it has no
//     value, so every arithmetic term carries a domain condition.
//
// Each term carries three things, and the second and third are separate
// questions rather than one: a value, whether it is the `null` value, and
// whether it has a value at all. `=` is null-aware and the orderings are strict
// at null, so the comparisons are written out rather than mapped straight onto
// SMT-LIB's.
//
// Where definedness enters decides everything. A *computed head term* having no
// value means the rule derives no tuple, so its definedness is a **hypothesis**
// and the contract makes no claim there. A *free variable* is confined to the
// integer domain by a **constraint**, an SMT `Int` left free being falsified with
// a value no tuple can hold. And a *refinement* holds only where it has a value,
// so its definedness is part of the **goal**. Where the nullness analysis proves
// a variable non-null its companion Bool is dropped, without which every contract
// over an integer column fails for a reason the program excludes.

import type { AnalyzedProgram } from "./analyzer.ts";
import { containsAggregate } from "./analyzer.ts";
import type { HeadTerm, Literal, PrimitiveType, Rule } from "./ast.ts";
import type { TypedProgram } from "./types.ts";
import { inferTermType, rebuildVarTypes } from "./types.ts";

const MAX_SAFE = "9007199254740991";

/**
 * A term as a value, the condition under which it is NULL, and the condition
 * under which it has a value at all.
 *
 * The two conditions are different questions and the encoder needs both, exactly
 * as the rest of the language does (null-as-a-value.md §1). `isNull` says the
 * term denotes the `null` **value**; `def` says it denotes anything. Leaving the
 * integer domain and dividing by zero move `def`, not `isNull`.
 *
 * `def` is only ever *asserted*, never assumed to be false, so it has to be
 * implied by the thing being asserted and never stronger than it. Where the exact
 * condition is awkward to state the safe answer is `DEFINED`, which claims
 * nothing: a missing hypothesis weakens a goal, an over-strong one would prove
 * something false.
 */
interface Term {
  v: string;
  isNull: string;
  def: string;
}

const NOT_NULL = "false";
const DEFINED = "true";

function or(...conditions: string[]): string {
  const live = conditions.filter((c) => c !== NOT_NULL);
  if (live.length === 0) return NOT_NULL;
  return live.length === 1 ? live[0]! : `(or ${live.join(" ")})`;
}

function and(...conditions: string[]): string {
  const live = conditions.filter((c) => c !== DEFINED);
  if (live.length === 0) return DEFINED;
  return live.length === 1 ? live[0]! : `(and ${live.join(" ")})`;
}

function nonNull(t: Term): string {
  return t.isNull === NOT_NULL ? "true" : `(not ${t.isNull})`;
}

/** Within the integer domain, so an arithmetic result has a value. */
function inDomain(value: string): string {
  return `(and (<= (- ${MAX_SAFE}) ${value}) (<= ${value} ${MAX_SAFE}))`;
}

/** An SMT-LIB integer literal, which `div` and `*` need to stay linear. */
function isNumeral(v: string): boolean {
  return /^\d+$/.test(v) || /^\(- \d+\)$/.test(v);
}

/**
 * `abs`, folded on a literal. `(abs 2)` is not a numeral, so dividing by it
 * puts the term outside QF_LIA even though the divisor is a constant, and z3
 * rejects the script rather than answering.
 */
function abs(v: string): string {
  if (/^\d+$/.test(v)) return v;
  const negated = v.match(/^\(- (\d+)\)$/);
  return negated ? negated[1]! : `(abs ${v})`;
}

/** Truncating division, where SMT-LIB's `div` floors toward negative infinity. */
function truncDiv(a: string, b: string): string {
  const magnitude = `(div ${abs(a)} ${abs(b)})`;
  // A literal divisor fixes the quotient's sign to the dividend's, or its
  // opposite when the literal is negative, so the test needs no multiplication
  // and the term stays linear.
  const positive = isNumeral(b)
    ? b.startsWith("(- ")
      ? `(< ${a} 0)`
      : `(>= ${a} 0)`
    : `(>= (* ${a} ${b}) 0)`;
  return `(ite ${positive} ${magnitude} (- ${magnitude}))`;
}

export interface ObligationContext {
  types: TypedProgram;
  /** Variable name to its SMT declaration, accumulated per obligation. */
  declared: Map<string, PrimitiveType>;
  /**
   * Variables the rule body proves non-null, so their `$null` companion is
   * `false` rather than a free Bool. Without this a solver is free to falsify
   * an ordering by making a column null that never can be, and every contract
   * over an integer column fails for a reason the program excludes.
   */
  nonNull: ReadonlySet<string>;
  /**
   * Whether a term with two non-literal factors was emitted. QF_LIA rejects
   * such a script outright rather than answering `unknown`, so the logic has
   * to widen to match what the program actually needs.
   */
  nonlinear: boolean;
}

/**
 * Translate a Datamog expression. Returns undefined for anything outside
 * §4.1's fragment, which the caller reports rather than emitting a goal that
 * quietly means something else.
 */
function toSmt(
  expr: HeadTerm,
  ctx: ObligationContext,
  vars: Map<string, PrimitiveType>,
  subst?: Substitution,
): Term {
  switch (expr.$type) {
    case "NumberLiteral":
      // Every declared sort is `Int`, so a non-integral literal would make the
      // goal ill-typed in QF_LIA. Report it rather than emit it. The value is
      // what decides, not `isFloatLiteral`: a refinement formula never reaches
      // the walker that attaches `rawText`.
      if (!Number.isInteger(expr.value)) throw new UnsupportedTerm("a non-integer literal");
      return { v: String(expr.value), isNull: NOT_NULL, def: DEFINED };
    case "BooleanLiteral":
      return { v: expr.value ? "true" : "false", isNull: NOT_NULL, def: DEFINED };
    case "NullLiteral":
      // Defined: `null` is a value, and writing it down is not a partial
      // operation. Only `isNull` moves.
      return { v: "0", isNull: "true", def: DEFINED };
    case "Variable": {
      // Tier 1 is QF_LIA, so `integer` is the only sort that can be declared
      // faithfully. Anything else — a `float`, a `string`, a `value` — would
      // be declared `Int` and could then be discharged for the wrong reason,
      // which is the one direction that must not happen. An unresolved type
      // takes the same route.
      // Under a substitution the formula is another predicate's, written in
      // that predicate's position names, so a name resolves to the actual
      // argument rather than to anything in scope here.
      if (subst) return subst(expr.name);
      const type = vars.get(expr.name);
      if (type !== "integer") {
        throw new UnsupportedTerm(type ? `a ${type} variable` : "an untyped variable");
      }
      ctx.declared.set(expr.name, type);
      return {
        v: expr.name,
        isNull: ctx.nonNull.has(expr.name) ? NOT_NULL : `${expr.name}$null`,
        // A variable is bound to a value, null included, so it is always defined.
        def: DEFINED,
      };
    }
    case "UnaryExpr": {
      const operand = toSmt(expr.operand, ctx, vars, subst);
      if (expr.op === "!") return { v: `(not ${operand.v})`, isNull: NOT_NULL, def: operand.def };
      const value = `(- ${operand.v})`;
      return {
        v: value,
        isNull: operand.isNull,
        def: and(operand.def, inDomain(value)),
      };
    }
    case "BinaryExpr": {
      const l = toSmt(expr.left, ctx, vars, subst);
      const r = toSmt(expr.right, ctx, vars, subst);
      return binary(expr.op, l, r, ctx);
    }
    default:
      throw new UnsupportedTerm(expr.$type);
  }
}

export class UnsupportedTerm extends Error {
  constructor(readonly term: string) {
    super(`outside tier 1: ${term}`);
  }
}

function binary(op: string, l: Term, r: Term, ctx: ObligationContext): Term {
  // Connectives over comparisons stay two-valued (§4.1 excludes a bare
  // boolean term, so neither side can be NULL here). Their definedness is left
  // unstated: `&&` is non-strict in undefinedness (`false && e` is false), so
  // "the conjunction has a value" does not give "both sides do", and asserting
  // the stronger reading would be asserting something false.
  if (op === "&&") return { v: `(and ${l.v} ${r.v})`, isNull: NOT_NULL, def: DEFINED };
  if (op === "||") return { v: `(or ${l.v} ${r.v})`, isNull: NOT_NULL, def: DEFINED };

  // No comparison ever yields a null. They part on what happens at one instead.
  // An ordering is **strict** at null as well as at undefined, `null` having no
  // place in an order (§4.1), so its definedness carries both conditions and its
  // value is the bare SMT-LIB comparison. Equality is total over values, so it
  // answers at a null and is defined wherever its operands are.
  const both = `(and ${nonNull(l)} ${nonNull(r)})`;
  const bothNull = `(and ${l.isNull} ${r.isNull})`;
  const bothDef = and(l.def, r.def);
  switch (op) {
    case "<":
    case ">":
    case "<=":
    case ">=":
      return {
        v: `(${op} ${l.v} ${r.v})`,
        isNull: NOT_NULL,
        def: and(bothDef, both),
      };
    case "=":
      return {
        v: `(or ${bothNull} (and ${both} (= ${l.v} ${r.v})))`,
        isNull: NOT_NULL,
        def: bothDef,
      };
    case "<>":
    case "!=":
      return {
        v: `(not (or ${bothNull} (and ${both} (= ${l.v} ${r.v}))))`,
        isNull: NOT_NULL,
        def: bothDef,
      };
  }

  // Arithmetic propagates NULL and originates none. Leaving the integer domain
  // and dividing by zero leave the term with no value, which is `def`'s business
  // rather than `isNull`'s: modelling them as nulls is what used to falsify
  // `fibonacci`'s `Curr <= Next` with an overflow no derived tuple can contain
  // (§10, §15.19).
  const propagated = or(l.isNull, r.isNull);
  if (op === "+" || op === "-" || op === "*") {
    if (op === "*" && !isNumeral(l.v) && !isNumeral(r.v)) ctx.nonlinear = true;
    const value = `(${op} ${l.v} ${r.v})`;
    return { v: value, isNull: propagated, def: and(bothDef, inDomain(value)) };
  }
  if (op === "/" || op === "%") {
    if (!isNumeral(r.v)) ctx.nonlinear = true;
    const nonZero = `(not (= ${r.v} 0))`;
    const q = truncDiv(l.v, r.v);
    const value = op === "/" ? q : `(- ${l.v} (* ${r.v} ${q}))`;
    return { v: value, isNull: propagated, def: and(bothDef, nonZero) };
  }
  throw new UnsupportedTerm(`operator ${op}`);
}

/**
 * Resolves a position name of the predicate whose formula is being translated
 * to the term the caller passed there. A function rather than a map so an
 * argument the formula never mentions is never translated: a contract over a
 * predicate's integer columns is usable even when a sibling column is a
 * string, which no goal in QF_LIA could mention.
 */
type Substitution = (name: string) => Term;

/**
 * The contract of a positive body atom's predicate, about that atom's actual
 * arguments (§5: a consumer may assume what a producer promised).
 *
 * Sound at a self-referential atom too, where it is the inductive hypothesis.
 * The induction is on the derivation: a tuple of `q` comes from some rule of
 * `q` applied to tuples derived earlier, which the hypothesis covers, and
 * every rule of `q` gets its own obligation, so the step is discharged for all
 * of them together or for none.
 *
 * Undefined when the predicate has no contract to offer, which includes the
 * vacuous case of an unannotated sibling rule.
 */
function contractHypothesis(
  atom: Literal,
  typed: TypedProgram,
  ctx: ObligationContext,
  vars: Map<string, PrimitiveType>,
): string | undefined {
  const rules = typed.rules.get(atom.predicate);
  if (!rules?.length) return undefined;
  if (!rules.every((r) => (r.head.refinements?.length ?? 0) > 0)) return undefined;

  const disjuncts = rules.map((rule) => {
    const names = rule.head.positionNames ?? [];
    const resolved = new Map<string, Term>();
    const subst: Substitution = (name) => {
      const cached = resolved.get(name);
      if (cached) return cached;
      const index = names.indexOf(name);
      const actual = index < 0 ? undefined : atom.args[index];
      // A contract mentioning a position the atom does not supply cannot be
      // stated here. Dropping the hypothesis only weakens the goal.
      if (actual === undefined) throw new UnsupportedTerm(`no actual for '${name}'`);
      const term = toSmt(actual as HeadTerm, ctx, vars);
      resolved.set(name, term);
      return term;
    };
    const conjuncts = rule.head.refinements!.map(
      (r) => toSmt(r.formula as HeadTerm, ctx, vars, subst).v,
    );
    return conjuncts.length === 1 ? conjuncts[0]! : `(and ${conjuncts.join(" ")})`;
  });
  return disjuncts.length === 1 ? disjuncts[0]! : `(or ${disjuncts.join(" ")})`;
}

/** The hypotheses a rule body contributes (§3.3). */
function hypotheses(
  rule: Rule,
  ctx: ObligationContext,
  vars: Map<string, PrimitiveType>,
): string[] {
  // A set, because two head arguments over the same expression contribute the
  // same definedness hypothesis. Duplicates cost a solver nothing but make the
  // `--obligations` output harder to read.
  const out = new Set<string>();
  // Hypotheses are best effort: one outside the fragment is dropped rather
  // than failing the obligation, since omitting a hypothesis only weakens the
  // goal. A goal outside the fragment is a different matter and is reported.
  const attempt = (build: () => string | undefined) => {
    try {
      const built = build();
      if (built !== undefined) out.add(built);
    } catch (e) {
      if (!(e instanceof UnsupportedTerm)) throw e;
    }
  };
  for (const element of rule.body) {
    if (element.$type === "Literal") {
      // A negated atom says the tuple is absent, which promises nothing about
      // the values, so only a positive one contributes.
      if (!element.negated) attempt(() => contractHypothesis(element, ctx.types, ctx, vars));
    } else if (element.$type === "Filter") {
      // A conjunct holds only where it has a value, so its definedness joins it.
      attempt(() => {
        const t = toSmt(element.expr as HeadTerm, ctx, vars);
        return and(t.def, t.v);
      });
    } else if (element.$type === "Equality") {
      // The grammar calls the right-hand side `expr`.
      attempt(() => {
        const eq = binary(
          "=",
          toSmt(element.left as HeadTerm, ctx, vars),
          toSmt(element.expr as HeadTerm, ctx, vars),
          ctx,
        );
        return and(eq.def, eq.v);
      });
    }
    // A range atom bounds its variable and could contribute those bounds; it
    // does not yet. Omitting a hypothesis only weakens a goal.
  }

  // A derived tuple witnesses its own definedness: a head expression with no
  // value derives nothing, so every tuple the contract quantifies over is one
  // where each head expression has a value (§10). This is what retires the
  // overflow counterexample, and it has to be a hypothesis rather than a
  // side-condition on the goal, because the goal is about the tuple.
  for (const arg of rule.head.args) {
    if (containsAggregate(arg)) continue;
    attempt(() => {
      const def = toSmt(arg as HeadTerm, ctx, vars).def;
      return def === DEFINED ? undefined : def;
    });
  }

  // A named head position contributes its definition (§3.3's last row). `as`
  // rewrites nothing, so without this nothing connects `K` to `I + 1` and a
  // goal mentioning `K` would have no hypothesis at all.
  rule.head.positionNames?.forEach((name, i) => {
    const arg = rule.head.args[i];
    if (name === undefined || arg === undefined) return;
    if (arg.$type === "Variable" && arg.name === name) return; // `X = X`
    // Only an `integer` name can be declared faithfully in QF_LIA; for
    // anything else the goal mentioning it is already being dropped.
    if (vars.get(name) !== "integer") return;
    ctx.declared.set(name, "integer");
    // Just the equality: the expression's definedness is asserted by the
    // head-argument pass above, which sees this same argument.
    attempt(
      () =>
        binary(
          "=",
          { v: name, isNull: ctx.nonNull.has(name) ? NOT_NULL : `${name}$null`, def: DEFINED },
          toSmt(arg, ctx, vars),
          ctx,
        ).v,
    );
  });
  return [...out];
}

/** One obligation: a named goal with its hypotheses. */
export interface Obligation {
  predicate: string;
  /** 1-based, matching the order the rules are written in. */
  rule: number;
  claim: string;
  script: string;
  /** Constants the block declares, for asking a solver what falsified it. */
  declared: string[];
  /**
   * The logic this block needs, or null if it was not emitted. Per obligation
   * rather than per script so a solver can be handed one block at a time.
   */
  logic: "QF_LIA" | "QF_NIA" | null;
}

/**
 * Generate one SMT-LIB block per refinement. A rule whose head contains an
 * aggregate is skipped with a note: its contract needs §4.1's derived facts
 * and the empty-group goal of §3.1, which this pass does not yet emit.
 */
export function generateObligations(typed: TypedProgram): Obligation[] {
  const out: Obligation[] = [];
  for (const [predicate, rules] of typed.rules) {
    if (!rules.every((r) => (r.head.refinements?.length ?? 0) > 0)) continue;
    for (const [index, rule] of rules.entries()) {
      const vars = rebuildVarTypes(rule.body, typed.columnTypes);
      const nonNull = typed.nullness.nonNullVars.get(rule.body) ?? new Set<string>();
      // An `as` name is head-scoped, so the body knows nothing about it. Its
      // type is that of the expression it names, which the head does know.
      rule.head.positionNames?.forEach((name, i) => {
        const arg = rule.head.args[i];
        if (name === undefined || arg === undefined || vars.has(name)) return;
        const type = inferTermType(arg, vars, typed.columnTypes);
        if (type) vars.set(name, type);
      });
      for (const refinement of rule.head.refinements!) {
        const ctx: ObligationContext = {
          types: typed,
          declared: new Map(),
          nonNull,
          nonlinear: false,
        };
        let block: string;
        let emitted = true;
        try {
          if (rule.head.args.some(containsAggregate)) {
            throw new UnsupportedTerm("an aggregate in the head");
          }
          const formula = toSmt(refinement.formula as HeadTerm, ctx, vars);
          // A refinement *holds* of a tuple only where it has a value and that
          // value is true, which is the same rule a body conjunct follows. It
          // matters for an ordering, which is strict at null (§4.1): a contract
          // `_: Y > X` is violated by a tuple whose `Y` is null, the ordering
          // having no answer there, so the null case has to be inside the goal
          // rather than assumed away.
          const goal = and(formula.def, formula.v);
          const asserts = hypotheses(rule, ctx, vars);
          // Every variable ranges over an `integer` column, so it is inside
          // the domain: a solver given an unbounded `Int` otherwise falsifies
          // an overflow guard with a value no tuple can hold.
          const declarations = [...ctx.declared]
            .map(([name]) =>
              [
                `(declare-const ${name} Int)`,
                ctx.nonNull.has(name) ? "" : `(declare-const ${name}$null Bool)`,
                `(assert ${inDomain(name)})`,
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n");
          block = [
            `; ${predicate} rule ${index + 1}: ${refinement.text}`,
            "(push 1)",
            declarations,
            ...asserts.map((a) => `(assert ${a})`),
            `(assert (not ${goal}))`,
            "(check-sat) ; unsat discharges the obligation",
            "(pop 1)",
          ]
            .filter((line) => line !== "")
            .join("\n");
        } catch (e) {
          if (!(e instanceof UnsupportedTerm)) throw e;
          emitted = false;
          block = `; ${predicate} rule ${index + 1}: ${refinement.text}\n; not emitted, ${e.message}`;
        }
        out.push({
          predicate,
          rule: index + 1,
          claim: refinement.text,
          script: block,
          declared: [...ctx.declared.keys()].flatMap((n) =>
            ctx.nonNull.has(n) ? [n] : [n, `${n}$null`],
          ),
          logic: emitted ? (ctx.nonlinear ? "QF_NIA" : "QF_LIA") : null,
        });
      }
    }
  }
  return out;
}

/** The obligations of `typed` as one SMT-LIB 2 script. */
export function obligationScript(typed: TypedProgram & AnalyzedProgram): string {
  const obligations = generateObligations(typed);
  if (obligations.length === 0) return "; no refinement contracts to discharge\n";
  // The widest logic any block needs. QF_LIA rejects a nonlinear script
  // outright, so declaring it when the program divides by a variable would
  // lose every block in the file, not just that one.
  const logic = obligations.some((o) => o.logic === "QF_NIA") ? "QF_NIA" : "QF_LIA";
  return [
    "; Datamog refinement obligations.",
    "; Each block is unsat exactly when its contract holds for that rule.",
    `(set-logic ${logic})`,
    "",
    ...obligations.map((o) => o.script),
    "",
  ].join("\n");
}
