// Shared planning + enumeration machinery used by the native (naive) and
// semi-naive evaluators. Both walk the same Step plan; they differ only in
// how the main iteration loop drives the enumeration (e.g. whether an atom
// step reads from a "delta" relation instead of the main one).

import type {
  AggregateCall,
  BodyElement,
  Equality,
  Expression,
  Filter,
  HeadTerm,
  Literal,
  PrimitiveType,
  Rule,
  TypedProgram,
  Variable,
} from "datamog-core";
import {
  BUILTIN_BODY_ATOMS,
  assertNever,
  allVarsBound as coreAllVarsBound,
  chooseEqualityBinding as coreChooseEqualityBinding,
  equalityBindingCandidates,
  inferTermType,
  isAnonymousVar,
} from "datamog-core";
import { type JsonValue, canonicalizeJson } from "datamog-engine";
import {
  type Substitution,
  type TypeEnv,
  type Value,
  evalTerm,
  logicalEq,
  scrubNonFiniteForJson,
} from "./values.ts";

/** An in-memory relation: ordered tuples plus a dedup key set. */
export interface Relation {
  tuples: Value[][];
  keys: Set<string>;
  /**
   * The relation stands for ⊤ (holds of every tuple), which is the starting
   * value of a maximal predicate in round 0 of a parity stratum. ⊤ is never
   * enumerated: the polarity check guarantees the only atoms that can observe
   * it are negated, and those simply fail. A positive atom step meeting a
   * `isTop` relation is an internal error. See
   * `doc/design/parity-stratification.md` §4.1.
   */
  isTop?: boolean;
}

export function makeRelation(): Relation {
  return { tuples: [], keys: new Set() };
}

/** Empty a relation in place, dropping the ⊤ marker with it. */
export function clearRelation(rel: Relation): void {
  rel.tuples.length = 0;
  rel.keys.clear();
  rel.isTop = false;
}

export function rowKey(row: Value[]): string {
  // Canonicalise every cell to its JSON text before keying the tuple.
  // This sorts object keys for structural dedup and keeps JSON string
  // leaves distinct from compounds whose canonical text happens to match
  // their contents (`"[1]"` vs `[1]`, `"{}"` vs `{}`).
  return JSON.stringify(row.map((v) => canonicalizeJson(v as JsonValue)));
}

export function addRow(rel: Relation, row: Value[]): boolean {
  const k = rowKey(row);
  if (rel.keys.has(k)) return false;
  rel.keys.add(k);
  rel.tuples.push(row);
  return true;
}

function compareStrings(a: string, b: string): number {
  const acp = [...a];
  const bcp = [...b];
  const len = Math.min(acp.length, bcp.length);
  for (let i = 0; i < len; i++) {
    const av = acp[i]!.codePointAt(0)!;
    const bv = bcp[i]!.codePointAt(0)!;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return acp.length < bcp.length ? -1 : acp.length > bcp.length ? 1 : 0;
}

function comparePrimitive(a: Value, b: Value): number {
  if (typeof a === "string" && typeof b === "string") return compareStrings(a, b);
  return a! < b! ? -1 : a! > b! ? 1 : 0;
}

export type Step =
  | { kind: "atom"; atom: Literal }
  | { kind: "bindEq"; variable: string; expr: Expression }
  | { kind: "bindRange"; variable: string; low: Expression; high: Expression }
  | { kind: "filterEq"; left: Expression; right: Expression }
  | { kind: "filter"; expr: Expression; negated: boolean }
  | {
      kind: "filterRange";
      expr: Expression;
      low: Expression;
      high: Expression;
    }
  | { kind: "filterNot"; atom: Literal }
  /**
   * Iterate the entries of a `value` (object → key/value pairs;
   * array → index/value pairs). The two bound positions (`keyArg`,
   * `valueArg`) are atom-style arguments: a Variable binds the
   * corresponding emitted slot, a non-Variable becomes a constraint
   * that the emitted slot must match. The atom node is kept for
   * source-position context in error messages.
   */
  | {
      kind: "bindJsonIter";
      iterKind: "object" | "array";
      source: Expression;
      keyArg: Expression;
      valueArg: Expression;
      atom: Literal;
    };

export interface RulePlan {
  steps: Step[];
  env: TypeEnv;
}

/**
 * Turn a rule body into an ordered execution plan.
 *
 * Complex arguments of positive body atoms are first hoisted into fresh
 * `$hoist` variables plus filters: `gcd(A-B, B, N)` becomes
 * `gcd($hoist0, B, N)`, `$hoist0 == A-B`. That reduces every positive atom
 * to plain variable / constant positions and turns each computed argument
 * into a filter, so an atom argument may reference a variable bound anywhere
 * in the body (a later atom, an equality, or another position of the same
 * atom) — matching the SQL backends' simultaneous join. See `hoistAtomArgs`.
 *
 * The plan then lists positive atoms (source order), binding equalities /
 * ranges / json-iter atoms scheduled via a fixed-point-on-readiness loop,
 * and finally the residual filter steps (boolean filters — including the
 * hoisted ones — negations, non-binding equalities, filter ranges).
 */
export function planRule(rule: Rule, analyzed: TypedProgram): RulePlan {
  const steps: Step[] = [];
  const bound = new Set<string>();
  const body = hoistAtomArgs(rule.body);

  for (const elem of body) {
    if (elem.$type === "Literal" && !elem.negated && !BUILTIN_BODY_ATOMS.has(elem.predicate)) {
      steps.push({ kind: "atom", atom: elem });
      collectAtomVars(elem, bound);
    }
  }

  // Pending: everything except plain positive atoms — i.e., negated
  // atoms, equalities, ranges, filters (including the hoisted ones), and
  // built-in body atoms (which behave like binding ranges and need source
  // vars to be safe before they can fire).
  const pending: BodyElement[] = body.filter(
    (e) => e.$type !== "Literal" || e.negated || BUILTIN_BODY_ATOMS.has(e.predicate),
  );

  let progress = true;
  while (progress) {
    progress = false;
    for (let p = 0; p < pending.length; ) {
      const elem = pending[p]!;
      if (elem.$type === "Equality") {
        const binding = chooseEqualityBinding(elem, bound);
        if (binding) {
          steps.push({ kind: "bindEq", variable: binding.variable, expr: binding.expr });
          bound.add(binding.variable);
          pending.splice(p, 1);
          progress = true;
          continue;
        }
      } else if (elem.$type === "RangeAtom" && elem.expr.$type === "Variable") {
        const variable = elem.expr.name;
        if (
          !bound.has(variable) &&
          allVarsBound(elem.low, bound) &&
          allVarsBound(elem.high, bound)
        ) {
          steps.push({
            kind: "bindRange",
            variable,
            low: elem.low,
            high: elem.high,
          });
          bound.add(variable);
          pending.splice(p, 1);
          progress = true;
          continue;
        }
      } else if (
        elem.$type === "Literal" &&
        !elem.negated &&
        BUILTIN_BODY_ATOMS.has(elem.predicate)
      ) {
        const spec = BUILTIN_BODY_ATOMS.get(elem.predicate)!;
        const sourceTerm = elem.args[spec.sourceArg]!;
        if (allVarsBound(sourceTerm, bound)) {
          const keyArg = elem.args[spec.boundArgs[0]!.index]!;
          const valueArg = elem.args[spec.boundArgs[1]!.index]!;
          steps.push({
            kind: "bindJsonIter",
            iterKind: spec.kind,
            source: sourceTerm,
            keyArg,
            valueArg,
            atom: elem,
          });
          if (keyArg.$type === "Variable" && !isAnonymousVar(keyArg.name)) bound.add(keyArg.name);
          if (valueArg.$type === "Variable" && !isAnonymousVar(valueArg.name))
            bound.add(valueArg.name);
          pending.splice(p, 1);
          progress = true;
          continue;
        }
      }
      p++;
    }
  }

  for (const elem of pending) {
    switch (elem.$type) {
      case "Literal":
        if (!elem.negated && BUILTIN_BODY_ATOMS.has(elem.predicate)) {
          // Reaching here means the analyzer's safety check let through
          // a built-in body atom whose source argument's variables are
          // never bound. That's an analyzer bug — surface it loudly
          // rather than silently emitting a non-firing plan.
          throw new Error(
            `Built-in '${elem.predicate}' source argument has unbound variables (analyzer bug)`,
          );
        }
        // Only negated atoms remain — positive atoms were consumed above.
        steps.push({ kind: "filterNot", atom: elem });
        break;
      case "Equality":
        steps.push({ kind: "filterEq", left: elem.left, right: elem.expr });
        break;
      case "Filter":
        steps.push({ kind: "filter", expr: elem.expr, negated: elem.negated ?? false });
        break;
      case "RangeAtom":
        steps.push({
          kind: "filterRange",
          expr: elem.expr,
          low: elem.low,
          high: elem.high,
        });
        break;
      default:
        assertNever(elem, "body element");
    }
  }

  const env: TypeEnv = {
    vars: buildVarTypes(rule, analyzed),
    columns: analyzed.columnTypes,
    functionOverloads: analyzed.functionOverloads,
  };
  return { steps, env };
}

/**
 * Try to bind the variables of `atom` against a concrete `tuple`. Returns
 * the extended substitution on success, or null if the tuple doesn't match.
 * Constant atom arguments are checked directly; repeated variables must
 * take the same value in every position they appear.
 */
export function matchAtom(
  atom: Literal,
  tuple: Value[],
  sub: Substitution,
  env: TypeEnv,
): Substitution | null {
  const next = new Map(sub);
  for (let j = 0; j < atom.args.length; j++) {
    const arg = atom.args[j]!;
    const val = tuple[j] as Value;
    if (arg.$type === "Variable") {
      if (isAnonymousVar(arg.name)) continue;
      const prev = next.get(arg.name);
      if (prev === undefined) {
        next.set(arg.name, val);
      } else if (!logicalEq(prev, val)) {
        return null;
      }
    } else {
      // planRule hoists computed arguments of positive atoms into filters,
      // so a positive atom only reaches here with variable or
      // constant-literal args. A negated atom (never hoisted) may carry a
      // computed arg, but negation safety guarantees its variables are
      // already bound, so evaluating left to right is sufficient.
      const expected = evalTerm(arg, next, env);
      if (!logicalEq(expected, val)) return null;
    }
  }
  return next;
}

function collectAtomVars(atom: Literal, into: Set<string>): void {
  for (const arg of atom.args) {
    if (arg.$type === "Variable" && !isAnonymousVar(arg.name)) into.add(arg.name);
  }
}

/** A term that is safe to leave in an atom position as-is: a variable or a
 * constant literal. Everything else (arithmetic, function calls, subscripts,
 * array/object literals) is a computed argument that gets hoisted. */
function isSimpleArg(arg: Expression): boolean {
  switch (arg.$type) {
    case "Variable":
    case "StringLiteral":
    case "NumberLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
      return true;
    default:
      return false;
  }
}

/**
 * Rewrite each computed argument of a positive, non-built-in atom into a
 * fresh `$hoist` variable plus a filter constraining that variable to the
 * original expression. `p(X, Y+1)` becomes `p(X, $hoist0), $hoist0 == Y+1`.
 *
 * This leaves the rest of the body untouched and hands the scheduler a form
 * where atoms carry only variable / constant positions, so an atom no longer
 * imposes any ordering constraint of its own — the computed argument's
 * dependency becomes a filter that runs once its variables are bound.
 *
 * The constraint uses `=`, the language's only equality, so a hoisted
 * argument matches an atom position exactly as an unhoisted one would:
 * null-aware, `NULL = NULL` included. Negated atoms and built-in body atoms
 * are left as-is (their variables are bound before they run, so a computed
 * argument evaluates directly). Fresh variables need no entry in the type
 * environment: they appear only in an atom position (bound by matchAtom)
 * and as one side of the `=`, never inside an expression whose type is
 * inspected.
 */
function hoistAtomArgs(body: BodyElement[]): BodyElement[] {
  let counter = 0;
  const result: BodyElement[] = [];
  for (const elem of body) {
    if (
      elem.$type !== "Literal" ||
      elem.negated ||
      BUILTIN_BODY_ATOMS.has(elem.predicate) ||
      elem.args.every(isSimpleArg)
    ) {
      result.push(elem);
      continue;
    }
    const newArgs: Literal["args"] = [];
    const constraints: Filter[] = [];
    for (const arg of elem.args) {
      if (isSimpleArg(arg)) {
        newArgs.push(arg);
        continue;
      }
      const freshVar = { $type: "Variable", name: `$hoist${counter++}` } as unknown as Variable;
      newArgs.push(freshVar);
      constraints.push({
        $type: "Filter",
        negated: false,
        expr: { $type: "BinaryExpr", op: "=", left: freshVar, right: arg },
      } as unknown as Filter);
    }
    result.push({ ...elem, args: newArgs });
    result.push(...constraints);
  }
  return result;
}

/** `chooseEqualityBinding` against the variables the plan has bound so far. */
function chooseEqualityBinding(
  eq: Equality,
  bound: Set<string>,
): { variable: string; expr: Expression } | undefined {
  return coreChooseEqualityBinding(eq, (name) => bound.has(name));
}

/** `allVarsBound` against the variables the plan has bound so far. */
function allVarsBound(term: HeadTerm, bound: Set<string>): boolean {
  return coreAllVarsBound(term, (name) => bound.has(name));
}

/**
 * Build the variable → type map for a rule. Mirrors `rebuildVarTypes` in
 * core/src/types.ts so native-side type-dependent choices (integer vs float
 * division, string concat for `+`) match the SQL translation.
 */
export function buildVarTypes(rule: Rule, analyzed: TypedProgram): Map<string, PrimitiveType> {
  const varTypes = new Map<string, PrimitiveType>();
  const colsView: ReadonlyMap<
    string,
    ReadonlyArray<PrimitiveType | undefined>
  > = analyzed.columnTypes;

  for (const elem of rule.body) {
    if (elem.$type === "Literal" && !elem.negated) {
      const builtin = BUILTIN_BODY_ATOMS.get(elem.predicate);
      if (builtin !== undefined) {
        for (const { index, type } of builtin.boundArgs) {
          const arg = elem.args[index]!;
          if (arg.$type === "Variable") {
            mergeVarType(varTypes, arg.name, type);
          }
        }
        continue;
      }
      const predTypes = analyzed.columnTypes.get(elem.predicate);
      if (!predTypes) continue;
      for (let j = 0; j < elem.args.length; j++) {
        const arg = elem.args[j]!;
        if (arg.$type !== "Variable") continue;
        mergeVarType(varTypes, arg.name, predTypes[j]!);
      }
    }
  }

  let progress = true;
  while (progress) {
    progress = false;
    for (const elem of rule.body) {
      if (elem.$type === "Equality") {
        for (const binding of equalityBindingCandidates(elem)) {
          if (varTypes.has(binding.variable)) continue;
          if (!allVarsBound(binding.expr, new Set(varTypes.keys()))) continue;
          const t = inferTermType(binding.expr, varTypes, colsView);
          if (!t) continue;
          varTypes.set(binding.variable, t);
          progress = true;
        }
      } else if (elem.$type === "RangeAtom" && elem.expr.$type === "Variable") {
        if (varTypes.has(elem.expr.name)) continue;
        const lo = inferTermType(elem.low, varTypes, colsView);
        const hi = inferTermType(elem.high, varTypes, colsView);
        const t = lo && hi ? (lo === "float" || hi === "float" ? "float" : "integer") : (lo ?? hi);
        if (t) {
          varTypes.set(elem.expr.name, t);
          progress = true;
        }
      }
    }
  }

  return varTypes;
}

function mergeVarType(
  varTypes: Map<string, PrimitiveType>,
  name: string,
  next: PrimitiveType,
): void {
  const current = varTypes.get(name);
  if (current === undefined) {
    varTypes.set(name, next);
    return;
  }
  const joined = joinTypesWithValueLift(current, next);
  if (joined !== null) {
    varTypes.set(name, joined);
  }
}

function joinTypesWithValueLift(a: PrimitiveType, b: PrimitiveType): PrimitiveType | null {
  if (a === b) return a;
  if ((a === "float" && b === "integer") || (a === "integer" && b === "float")) return "float";
  if (a === "value" || b === "value") return "value";
  return null;
}

/** Apply an aggregate across the group of substitutions that share a key. */
export function evalAggregate(agg: AggregateCall, subs: Substitution[], env: TypeEnv): Value {
  // `count(*)` matches SQL's `COUNT(*)`: counts rows regardless of value.
  if (agg.func === "count" && agg.arg.$type === "Wildcard") {
    return subs.length;
  }
  const values: Value[] = subs.map((s) => evalTerm(agg.arg, s, env));
  switch (agg.func) {
    case "count":
      return values.filter((v) => v !== null).length;
    case "sum": {
      if (inferTermType(agg.arg, env.vars, env.columns) === "integer") {
        let positive = 0n;
        let negative = 0n;
        let hasAny = false;
        for (const v of values) {
          if (v === null) continue;
          const n = BigInt(v as number);
          if (n > 0n) positive += n;
          else negative -= n;
          hasAny = true;
        }
        if (!hasAny) return null;
        if (positive > 9007199254740991n || negative > 9007199254740991n) return null;
        return Number(positive - negative);
      }
      let total = 0;
      let hasAny = false;
      for (const v of values) {
        if (v === null) continue;
        total += v as number;
        hasAny = true;
      }
      return hasAny ? total : null;
    }
    case "avg": {
      let total = 0;
      let n = 0;
      for (const v of values) {
        if (v === null) continue;
        total += v as number;
        n++;
      }
      return n === 0 ? null : total / n;
    }
    case "min": {
      let best: Value = null;
      for (const v of values) {
        if (v === null) continue;
        if (best === null || comparePrimitive(v, best) < 0) best = v;
      }
      return best;
    }
    case "max": {
      let best: Value = null;
      for (const v of values) {
        if (v === null) continue;
        if (best === null || comparePrimitive(v, best) > 0) best = v;
      }
      return best;
    }
    case "concat": {
      // Sort to match the `ORDER BY` we emit on every SQL backend, so
      // the same program produces the same string everywhere. The
      // analyser guarantees all values in a group share a type, so a
      // primitive `<`/`>` comparator picks the natural order: numeric
      // for numbers, lex for strings, false-before-true for booleans.
      const nonNull = values.filter((v) => v !== null);
      if (nonNull.length === 0) return null;
      // For value args, render each value as canonical JSON text so
      // the per-element string matches what the SQL backends emit
      // (their GROUP_CONCAT / STRING_AGG cast already sees canonical
      // JSON via storage). `String(v)` would otherwise produce
      // `"[object Object]"` for objects and the comma-joined
      // `Array.toString()` form for arrays — diverging from SQL.
      const argType = inferTermType(agg.arg, env.vars, env.columns);
      if (argType === "value") {
        const rendered = nonNull.map((v) => canonicalizeJson(v as JsonValue));
        rendered.sort(compareStrings);
        return rendered.join(",");
      }
      const sorted = [...nonNull].sort(comparePrimitive);
      return sorted.map((v) => String(v)).join(",");
    }
    case "list": {
      // `list` collects values into a json array. Skip SQL NULLs and
      // return null on an all-null / empty group to match `concat`
      // and the SQL FILTER + NULLIF pair.
      //
      // Sort key depends on argument shape:
      //   - For value arguments (objects / arrays), sort by
      //     `canonicalizeJson` text in Datamog's portable string order.
      //     JS `<` on objects/arrays
      //     coerces to `"[object Object]"` / `Array.toString()`,
      //     which produces meaningless orderings.
      //   - For primitive arguments, sort by JS `<` so numeric
      //     columns get numeric order (matching SQLite's raw ORDER
      //     BY and Postgres's pre-cast ordering on `to_jsonb(int)`),
      //     strings get lex, booleans get false-before-true. Same
      //     convention as `concat`.
      const nonNull = values.filter((v) => v !== null);
      if (nonNull.length === 0) return null;
      const argType = inferTermType(agg.arg, env.vars, env.columns);
      let sorted: Value[];
      if (argType === "value") {
        const keyed = nonNull.map((v) => ({
          value: v,
          key: canonicalizeJson(v as JsonValue),
        }));
        keyed.sort((a, b) => compareStrings(a.key, b.key));
        sorted = keyed.map((k) => k.value);
      } else {
        sorted = [...nonNull].sort(comparePrimitive);
      }
      return sorted.map(scrubNonFiniteForJson);
    }
    default:
      throw new Error(`Unknown aggregate '${agg.func}'`);
  }
}

/**
 * Optional per-enumeration override that routes a single atom step through
 * a different set of relations. Semi-naive evaluation uses this to read one
 * body atom from a "delta" relation while others read from the main set.
 */
export interface DeltaOverride {
  stepIndex: number;
  relations: ReadonlyMap<string, Relation>;
}

/**
 * Enumerate substitutions satisfying the rule plan against a set of
 * relations. `deltaOverride`, if present, swaps the relation used at a
 * single atom step.
 */
export function* enumerate(
  steps: Step[],
  i: number,
  sub: Substitution,
  env: TypeEnv,
  relations: ReadonlyMap<string, Relation>,
  deltaOverride?: DeltaOverride,
): Generator<Substitution> {
  if (i === steps.length) {
    yield sub;
    return;
  }
  const step = steps[i]!;
  switch (step.kind) {
    case "atom": {
      const src =
        deltaOverride && deltaOverride.stepIndex === i ? deltaOverride.relations : relations;
      const rel = src.get(step.atom.predicate)!;
      if (rel.isTop) {
        // Unreachable: the polarity check rejects a positive atom on a maximal
        // predicate from the minimal side of its own SCC, and every other
        // reader sees a rebuilt (finite) relation. Assert rather than silently
        // enumerating the empty tuple list, which would look like a wrong
        // answer instead of a bug.
        throw new Error(`Internal error: positive atom on '${step.atom.predicate}' read it at ⊤`);
      }
      for (const tuple of rel.tuples) {
        const next = matchAtom(step.atom, tuple, sub, env);
        if (next !== null) yield* enumerate(steps, i + 1, next, env, relations, deltaOverride);
      }
      return;
    }
    case "bindEq": {
      const val = evalTerm(step.expr, sub, env);
      const next = new Map(sub);
      next.set(step.variable, val);
      yield* enumerate(steps, i + 1, next, env, relations, deltaOverride);
      return;
    }
    case "bindRange": {
      const lo = evalTerm(step.low, sub, env);
      const hi = evalTerm(step.high, sub, env);
      if (lo === null || hi === null) return;
      const loN = lo as number;
      const hiN = hi as number;
      if (!Number.isInteger(loN) || !Number.isInteger(hiN)) return;
      // Reject bounds outside JS's safe-integer window. Past 2^53, `v++`
      // silently rounds to the same value (e.g. 9_007_199_254_740_993 +
      // 1 === 9_007_199_254_740_993), so the loop never terminates and
      // the evaluator hangs.
      if (
        loN < Number.MIN_SAFE_INTEGER ||
        hiN > Number.MAX_SAFE_INTEGER ||
        hiN - loN > Number.MAX_SAFE_INTEGER
      ) {
        throw new Error(
          `Range bounds [${loN} .. ${hiN}] exceed JavaScript's safe-integer window (±${Number.MAX_SAFE_INTEGER})`,
        );
      }
      for (let v = loN; v <= hiN; v++) {
        const next = new Map(sub);
        next.set(step.variable, v);
        yield* enumerate(steps, i + 1, next, env, relations, deltaOverride);
      }
      return;
    }
    case "filterEq": {
      // Body-level Equality is null-aware: `null = null` matches,
      // `null = X` doesn't. Atom matching uses the same `logicalEq`, so a
      // repeated variable and a spelled-out `=` denote the same join.
      const l = evalTerm(step.left, sub, env);
      const r = evalTerm(step.right, sub, env);
      if (!logicalEq(l, r)) return;
      yield* enumerate(steps, i + 1, sub, env, relations, deltaOverride);
      return;
    }
    case "filter": {
      // The filter expression must evaluate to `true` for the row to
      // pass. Comparisons are total so they never yield NULL here, but a
      // NULL can still reach filter position through a nullable boolean
      // column or a null-propagating expression; the `=== true` check
      // drops that row, matching SQL's WHERE semantics.
      //
      // A negated filter is negation as failure: it holds whenever the operand
      // does *not*, so a NULL operand keeps the row rather than dropping it.
      // That is what distinguishes `not e` from `!e`, which propagates the NULL.
      // See doc/design/null-as-a-value.md §4.4.
      const v = evalTerm(step.expr, sub, env);
      if (step.negated ? v === true : v !== true) return;
      yield* enumerate(steps, i + 1, sub, env, relations, deltaOverride);
      return;
    }
    case "filterRange": {
      const v = evalTerm(step.expr, sub, env);
      const lo = evalTerm(step.low, sub, env);
      const hi = evalTerm(step.high, sub, env);
      if (v === null || lo === null || hi === null) return;
      if ((v as number) < (lo as number) || (v as number) > (hi as number)) return;
      yield* enumerate(steps, i + 1, sub, env, relations, deltaOverride);
      return;
    }
    case "filterNot": {
      // Negation always reads from the main relations — stratification
      // forbids negating a predicate in the current SCC, so there is no
      // delta for it. The one exception is a parity stratum, where a
      // negated atom may name a same-SCC predicate of the opposite
      // polarity; that relation is either ⊤ (round 0) or the previous
      // round's value, never a delta.
      const rel = relations.get(step.atom.predicate)!;
      // ⊤ holds of every tuple, so the negation fails.
      if (rel.isTop) return;
      let found = false;
      for (const tuple of rel.tuples) {
        if (matchAtom(step.atom, tuple, sub, env) !== null) {
          found = true;
          break;
        }
      }
      if (found) return;
      yield* enumerate(steps, i + 1, sub, env, relations, deltaOverride);
      return;
    }
    case "bindJsonIter": {
      const src = evalTerm(step.source, sub, env);
      // Iteration over a wrong-shape value (object_entry on an array,
      // array_element on an object, anything on null / scalar leaves)
      // yields zero rows — matching the SQL backends' `WHERE
      // json_type(src) = ...` guard.
      if (step.iterKind === "object") {
        if (src === null || typeof src !== "object" || Array.isArray(src)) return;
        for (const [k, v] of Object.entries(src)) {
          const next = bindJsonSlot(step.keyArg, k, sub, env);
          if (next === null) continue;
          const next2 = bindJsonSlot(step.valueArg, v as Value, next, env);
          if (next2 === null) continue;
          yield* enumerate(steps, i + 1, next2, env, relations, deltaOverride);
        }
      } else {
        if (!Array.isArray(src)) return;
        for (let idx = 0; idx < src.length; idx++) {
          const next = bindJsonSlot(step.keyArg, idx, sub, env);
          if (next === null) continue;
          const next2 = bindJsonSlot(step.valueArg, src[idx] as Value, next, env);
          if (next2 === null) continue;
          yield* enumerate(steps, i + 1, next2, env, relations, deltaOverride);
        }
      }
      return;
    }
  }
}

/**
 * Bind one bound-position argument of a built-in body atom against an
 * iteration-emitted value. Variable args become substitutions (after a
 * repeated-variable consistency check); literal/expression args are
 * compared via `logicalEq` and either pass through or kill the row.
 * Anonymous variables (parser-generated internal names for source-level `_`)
 * are accepted unconditionally
 * and not added to the substitution — matching positive-atom behaviour
 * in `matchAtom`.
 */
function bindJsonSlot(
  arg: Expression,
  value: Value,
  sub: Substitution,
  env: TypeEnv,
): Substitution | null {
  if (arg.$type === "Variable") {
    if (isAnonymousVar(arg.name)) return sub;
    const prev = sub.get(arg.name);
    if (prev === undefined) {
      const next = new Map(sub);
      next.set(arg.name, value);
      return next;
    }
    return logicalEq(prev, value) ? sub : null;
  }
  const expected = evalTerm(arg, sub, env);
  return logicalEq(expected, value) ? sub : null;
}
