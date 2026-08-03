import type {
  BodyElement,
  Equality,
  ExtDecl,
  HeadTerm,
  Literal,
  PrimitiveType,
  Program,
  Query,
  Rule,
} from "./ast.ts";
import { asCoreRule } from "./ast.ts";
import { BUILTINS, resolveCall } from "./builtins.ts";
import { type NegationCycle, buildNegationCycle } from "./negation-cycle.ts";

export const AGGREGATE_NAMES: ReadonlySet<string> = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "concat",
  "list",
]);

/**
 * Specification for a built-in body atom — predicates that look like
 * ordinary positive atoms but are evaluated as iteration primitives,
 * binding their non-source positions for each (key/index, value)
 * produced by walking the source `value`.
 *
 * `sourceArg` is the position whose value drives the iteration; its
 * variables must already be safe (bound elsewhere in the rule body)
 * before this atom can fire — same safety contract as range atoms.
 * `boundArgs` are positions whose vars become safe via this atom.
 */
export interface BuiltinBodyAtomSpec {
  readonly sourceArg: number;
  readonly sourceType: PrimitiveType;
  readonly boundArgs: ReadonlyArray<{ index: number; type: PrimitiveType }>;
  readonly arity: number;
  /** What the iteration produces — used by the translator to pick a dialect form. */
  readonly kind: "object" | "array";
}

/**
 * Registry of body-atom built-ins. These names are reserved (cannot
 * be declared as extensional or defined as IDB), are not required to
 * have a predicate declaration when used in body positions, and don't
 * contribute to the dependency graph (they're stateless — driven
 * entirely by the source argument).
 */
export const BUILTIN_BODY_ATOMS: ReadonlyMap<string, BuiltinBodyAtomSpec> = new Map([
  [
    "object_entry",
    {
      sourceArg: 0,
      sourceType: "value",
      boundArgs: [
        { index: 1, type: "string" },
        { index: 2, type: "value" },
      ],
      arity: 3,
      kind: "object",
    } satisfies BuiltinBodyAtomSpec,
  ],
  [
    "array_element",
    {
      sourceArg: 0,
      sourceType: "value",
      boundArgs: [
        { index: 1, type: "integer" },
        { index: 2, type: "value" },
      ],
      arity: 3,
      kind: "array",
    } satisfies BuiltinBodyAtomSpec,
  ],
]);

/** Convenience: is `name` a built-in body atom (object_entry / array_element / ...). */
export function isBuiltinBodyAtom(name: string): boolean {
  return BUILTIN_BODY_ATOMS.has(name);
}

function reservedOperationKind(name: string): "function" | "body atom" | "aggregate" | undefined {
  if (AGGREGATE_NAMES.has(name)) return "aggregate";
  if (BUILTIN_BODY_ATOMS.has(name)) return "body atom";
  if (BUILTINS.has(name)) return "function";
  return undefined;
}

// Parser post-processing rewrites every `_` variable to an internal-only
// `$anonN` name. Source-level variables cannot contain `$`, so user-typed
// variables such as `_0`, `_X`, or `_foo` are still ordinary variables that
// must be checked for safety and bound normally.
const ANON_VAR_RE = /^\$anon\d+$/;
export function isAnonymousVar(name: string): boolean {
  return ANON_VAR_RE.test(name);
}

// Every synthetic variable the post-processor introduces starts with `$`,
// which source variables cannot contain: `$anonN` don't-cares, plus the
// `$patN` / `$subN` temporaries from the proof-term desugar. These are
// internal plumbing and must never appear as a query output column.
export function isSyntheticVar(name: string): boolean {
  return name.startsWith("$");
}

/**
 * Allowed built-in functions are defined in `./builtins.ts` as a
 * registry of overload sets. `analyze` only validates name + arity here
 * (since types are still being inferred); the type checker resolves
 * each call to a specific overload and validates argument types.
 */

export class AnalyzerError extends Error {
  /** Byte offset of the error in the source (undefined if position unavailable). */
  offset?: number;
  /** Byte end-offset of the error in the source. */
  end?: number;
  /**
   * For non-stratified-negation errors: the dependency cycle the
   * negation creates, projected to predicate-level nodes. The
   * playground uses this to offer a "Show cycle" affordance on the
   * error squiggly, mirroring the finiteness-warning case.
   */
  cycle?: NegationCycle;
  /** Source file the error is in. Undefined for file-less input (a REPL
   *  chunk, stdin, an in-memory editor buffer). Stamped by `analyze` /
   *  `inferTypes` from the program's `sourceFile`; a merged multi-file
   *  program can set it per statement. */
  file?: string;

  constructor(message: string, offset?: number, end?: number, cycle?: NegationCycle) {
    super(message);
    this.name = "AnalyzerError";
    this.offset = offset;
    this.end = end;
    this.cycle = cycle;
  }
}

/** Extract byte-offset range from a Langium AST node's CST node. */
function nodePos(node: { $cstNode?: { offset: number; end: number } }):
  | [number, number]
  | undefined {
  return node.$cstNode ? [node.$cstNode.offset, node.$cstNode.end] : undefined;
}

export interface AnalyzedProgram {
  extDecls: Map<string, ExtDecl>;
  rules: Map<string, Rule[]>;
  /** Arity of each predicate (EDB and IDB). */
  arities: Map<string, number>;
  queries: Query[];
  /** Integrity constraints (`!-` statements and `error predicate` rules), as
   *  queries whose result must be empty. Kept apart from `queries` so every
   *  consumer that walks results positionally stays aligned, and so a
   *  constraint is never printed as an output. Validated exactly like a query
   *  (arity, safety, function calls); a non-empty result is a violation whose
   *  rows are the counterexamples. */
  constraints: Query[];
  dependencies: Map<string, Set<string>>;
  /** Negative dependencies: predicate p negatively depends on q if some rule for p has `not q(...)` in its body. */
  negativeDependencies: Map<string, Set<string>>;
  recursivePredicates: Set<string>;
  /** Predicates that are non-linearly recursive (some rule has >1 body atom from the same SCC). */
  nonLinearPredicates: Set<string>;
  /** Predicates whose name carries the `^` sigil: the anti-monotone side of a
   *  parity-stratified recursion, evaluated from ⊤ downwards by the
   *  alternating fixed point. See spec §4.3. */
  maximalPredicates: Set<string>;
  /** Predicates grouped into strata (SCCs) in dependency order. */
  sortedStrata: string[][];
  /** Source file the program was parsed from, threaded through so downstream
   *  errors (type inference, translation) can name it. Undefined for file-less
   *  input (a REPL chunk, stdin, an in-memory buffer). */
  sourceFile?: string;
}

/** Collect all variable names from an expression tree. */
function collectVars(term: HeadTerm, into: Set<string>) {
  switch (term.$type) {
    case "Variable":
      into.add(term.name);
      break;
    case "BinaryExpr":
      collectVars(term.left, into);
      collectVars(term.right, into);
      break;
    case "UnaryExpr":
      collectVars(term.operand, into);
      break;
    case "FunctionCall":
      for (const arg of term.args) collectVars(arg, into);
      break;
    case "AggregateCall":
      collectVars(term.arg, into);
      break;
    case "Subscript":
      collectVars(term.object, into);
      collectVars(term.index, into);
      break;
    case "Slice":
      collectVars(term.object, into);
      if (term.start) collectVars(term.start, into);
      if (term.end) collectVars(term.end, into);
      break;
    case "ArrayLiteral":
      for (const e of term.elements) collectVars(e, into);
      break;
    case "ObjectLiteral":
      for (const entry of term.entries) collectVars(entry.value, into);
      break;
  }
}

export function analyze(program: Program, file?: string): AnalyzedProgram {
  try {
    return analyzeImpl(program, file);
  } catch (e) {
    if (e instanceof AnalyzerError) e.file ??= file;
    throw e;
  }
}

function analyzeImpl(program: Program, file: string | undefined): AnalyzedProgram {
  const extDecls = new Map<string, ExtDecl>();
  const rules = new Map<string, Rule[]>();
  const arities = new Map<string, number>();
  // Constraints accumulate here alongside real queries so the validation passes
  // below (arity, safety, function calls) cover both; the two are split apart
  // in the returned program.
  const queries: Query[] = [];
  // Which marker each output / error predicate was emitted under, so a
  // predicate with several marked rules yields one result rather than one per
  // rule, and so rules that disagree about the marker are rejected instead of
  // silently taking whichever came first.
  const emittedOutputs = new Map<string, "output" | "error">();
  // Predicates whose name carries the `^` sigil, i.e. the anti-monotone side
  // of a parity-stratified recursion. Collected from rule heads; every other
  // occurrence is then checked to agree (`checkPolaritySpelling`).
  const maximalPredicates = new Set<string>();

  // Classify statements
  for (const stmt of program.statements) {
    switch (stmt.$type) {
      case "ExtDecl": {
        // A source binding (`:= "file"` / `:= out from "mod.dl"`) is elaborated
        // away by the module resolver before analysis. That resolver is not
        // wired up yet, so a binding still present here would be silently
        // ignored and the input loaded from convention instead. Reject it.
        if (stmt.binding) {
          const pos = nodePos(stmt);
          throw new AnalyzerError(
            "input predicate source bindings (':=') are not yet supported",
            ...(pos ?? []),
          );
        }
        if (extDecls.has(stmt.predicate)) {
          const pos = nodePos(stmt);
          throw new AnalyzerError(
            `Predicate '${stmt.predicate}' is declared as an input predicate multiple times`,
            ...(pos ?? []),
          );
        }
        // Reject duplicate column names: SQL backends error at CREATE TABLE
        // ("duplicate column name"), but the native backend silently loads
        // CSV by-key — duplicate keys in JS objects retain only the last
        // value, so every "x" in `p(x: string, x: string)` ends up holding the
        // same data. Catch it at analyse time so the failure is uniform
        // across backends and points at the source location.
        const seenCols = new Set<string>();
        for (const col of stmt.columns) {
          if (seenCols.has(col.name)) {
            const pos = nodePos(col);
            throw new AnalyzerError(
              `Predicate '${stmt.predicate}' has duplicate column name '${col.name}'`,
              ...(pos ?? []),
            );
          }
          seenCols.add(col.name);
        }
        extDecls.set(stmt.predicate, stmt);
        arities.set(stmt.predicate, stmt.columns.length);
        break;
      }
      case "Rule": {
        if (stmt.head.maximal) {
          if (stmt.error) {
            const pos = nodePos(stmt.head);
            throw new AnalyzerError(
              `'error predicate ${stmt.head.predicate}^' is not allowed: an integrity constraint cannot be maximal`,
              ...(pos ?? []),
            );
          }
          maximalPredicates.add(stmt.head.predicate);
        }
        const existing = rules.get(stmt.head.predicate);
        if (existing) {
          const expectedArity = arities.get(stmt.head.predicate)!;
          if (stmt.head.args.length !== expectedArity) {
            const pos = nodePos(stmt.head);
            // Match the body-atom arity error's wording so the same
            // mismatch reads the same way regardless of where it appears.
            throw new AnalyzerError(
              `Predicate '${stmt.head.predicate}' has arity ${expectedArity} but is defined with ${stmt.head.args.length} arguments`,
              ...(pos ?? []),
            );
          }
          existing.push(asCoreRule(stmt));
        } else {
          rules.set(stmt.head.predicate, [asCoreRule(stmt)]);
          arities.set(stmt.head.predicate, stmt.head.args.length);
        }
        // An `output predicate` rule additionally exposes its predicate as a
        // printed result, and an `error predicate` rule as an integrity
        // constraint: synthesise an implicit `?- pred(V1, …, Vn)` query and push
        // it at this source position so it interleaves with real `?-` queries in
        // order. One query per marked predicate, not per rule.
        const marker = stmt.error ? "error" : stmt.output ? "output" : undefined;
        const previousMarker = emittedOutputs.get(stmt.head.predicate);
        if (marker && previousMarker && previousMarker !== marker) {
          const pos = nodePos(stmt.head);
          throw new AnalyzerError(
            `Predicate '${stmt.head.predicate}' is marked '${previousMarker} predicate' by one rule and '${marker} predicate' by another; all its rules must agree`,
            ...(pos ?? []),
          );
        }
        if (marker && !previousMarker) {
          emittedOutputs.set(stmt.head.predicate, marker);
          const usedNames = new Set<string>();
          // A proof-carrying rule's head ends with an injected proof term
          // (an object literal). Read it into a synthetic `$`-name so
          // `queryProjection` hides it, exactly as a hand-written `?- p(...)`
          // query hides the proof (spec §8.3), rather than leaking it as a
          // `colN` output column.
          const proofColumn = stmt.ruleName !== undefined ? stmt.head.args.length - 1 : -1;
          const projVars = stmt.head.args.map((arg, i) => {
            // Name each output column after the head's variable, or an
            // aggregate's function (`avg`, `count`, ...); fall back to a
            // positional name for any other computed head argument.
            const a = arg as { $type: string; name?: string; func?: string };
            let name =
              i === proofColumn
                ? "$proof"
                : a.$type === "Variable" && a.name
                  ? a.name
                  : a.$type === "AggregateCall" && a.func
                    ? a.func
                    : `col${i + 1}`;
            while (usedNames.has(name)) name = `${name}_`;
            usedNames.add(name);
            return { $type: "Variable", name };
          });
          queries.push({
            $type: "Query",
            // A maximal predicate is labelled with its sigil, the way the
            // source always spells it (spec §4.3). The bare name stays the
            // identity: module export selection matches `head.predicate`.
            outputName: stmt.head.maximal ? `${stmt.head.predicate}^` : stmt.head.predicate,
            isOutput: !stmt.error,
            isError: stmt.error,
            body: [
              {
                $type: "Literal",
                predicate: stmt.head.predicate,
                maximal: stmt.head.maximal,
                negated: false,
                parens: true,
                args: projVars,
              },
            ],
            $cstNode: stmt.head.$cstNode,
          } as unknown as Query);
        }
        break;
      }
      case "Query": {
        // A `?-` query is the module's default output. A `!-` constraint is not
        // an output at all, so it must not claim the default slot.
        const q = stmt as Query;
        if (!q.isError) q.outputName = "default";
        queries.push(q);
        break;
      }
    }
  }

  // At most one default output per file. A `?-` query and an
  // `output predicate default` both define it, and there can be only one.
  const defaults = queries.filter((q) => q.outputName === "default");
  if (defaults.length > 1) {
    const pos = nodePos(defaults[1]!);
    throw new AnalyzerError(
      "A file has at most one default output (a `?-` query, or `output predicate default`); it is defined more than once here",
      ...(pos ?? []),
    );
  }

  // Check no predicate is both EDB and IDB
  for (const predicate of rules.keys()) {
    if (extDecls.has(predicate)) {
      const pos = nodePos(rules.get(predicate)![0]!.head);
      throw new AnalyzerError(
        `Predicate '${predicate}' is both an input predicate and defined by rules`,
        ...(pos ?? []),
      );
    }
  }

  // A predicate name may not collide with a built-in operation name (function,
  // body atom, or aggregate): written `f(...)` a predicate would be
  // indistinguishable from invoking the built-in, giving one source token two
  // meanings. Extensional columns and variables are exempt, since neither uses
  // the `name(...)` call form. Backtick-quoting the head predicate opts out.
  for (const predicate of [...extDecls.keys(), ...rules.keys()]) {
    const kind = reservedOperationKind(predicate);
    if (kind) {
      const extDecl = extDecls.get(predicate);
      const ruleWithUnquotedHead = rules
        .get(predicate)
        ?.find((rule) => !(rule.head as { predicateQuoted?: boolean }).predicateQuoted);
      const decl =
        extDecl && !(extDecl as { predicateQuoted?: boolean }).predicateQuoted
          ? extDecl
          : ruleWithUnquotedHead;
      if (!decl) continue;
      const pos = decl ? nodePos(decl) : undefined;
      throw new AnalyzerError(
        `Predicate name '${predicate}' conflicts with built-in ${kind} '${predicate}'`,
        ...(pos ?? []),
      );
    }
  }

  // A constructor name (a rule's `:: Ctor` annotation) may not collide with a
  // built-in operation name either, so a constructor term `Ctor(...)` in an
  // expression stays unambiguous with a built-in call.
  for (const predRules of rules.values()) {
    for (const rule of predRules) {
      if (rule.ruleName === undefined) continue;
      const kind = reservedOperationKind(rule.ruleName);
      if (kind) {
        const pos = nodePos(rule.head);
        throw new AnalyzerError(
          `Constructor name '${rule.ruleName}' conflicts with built-in ${kind} '${rule.ruleName}'`,
          ...(pos ?? []),
        );
      }
    }
  }

  // Check arity of literals in rule bodies and queries
  function checkLiteral(literal: Literal) {
    const builtin = BUILTIN_BODY_ATOMS.get(literal.predicate);
    if (builtin !== undefined) {
      if (literal.args.length !== builtin.arity) {
        const pos = nodePos(literal);
        throw new AnalyzerError(
          `Built-in '${literal.predicate}' has arity ${builtin.arity} but is used with ${literal.args.length} arguments`,
          ...(pos ?? []),
        );
      }
      return;
    }
    const expected = arities.get(literal.predicate);
    const pos = nodePos(literal);
    if (expected === undefined) {
      throw new AnalyzerError(`Predicate '${literal.predicate}' is not defined`, ...(pos ?? []));
    }
    if (literal.args.length !== expected) {
      throw new AnalyzerError(
        `Predicate '${literal.predicate}' has arity ${expected} but is used with ${literal.args.length} arguments`,
        ...(pos ?? []),
      );
    }
  }

  for (const predicateRules of rules.values()) {
    for (const rule of predicateRules) {
      for (const elem of rule.body) {
        if (elem.$type === "Literal") {
          checkLiteral(elem);
          // Negated built-in body atoms have no defined meaning — they're
          // iteration primitives, not relations. `not object_entry(O, K, V)`
          // would translate to "no row matches", but there's no relation
          // to negate over. Reject up front.
          if (elem.negated && BUILTIN_BODY_ATOMS.has(elem.predicate)) {
            const pos = nodePos(elem);
            throw new AnalyzerError(
              `Built-in '${elem.predicate}' cannot be negated`,
              ...(pos ?? []),
            );
          }
        }
      }
    }
  }

  // Query bodies share the rule-body shape: literals (positive or
  // negated), equalities, range atoms, filters. Apply the same arity /
  // negated-built-in checks the rule loop above does. Safety (including
  // the no-unbound-projection-variable rule) is enforced by the shared
  // checkSafety pass below.
  for (const query of queries) {
    for (const elem of query.body) {
      if (elem.$type === "Literal") {
        checkLiteral(elem);
        if (elem.negated && BUILTIN_BODY_ATOMS.has(elem.predicate)) {
          const pos = nodePos(elem);
          throw new AnalyzerError(`Built-in '${elem.predicate}' cannot be negated`, ...(pos ?? []));
        }
      }
    }
  }

  // Safety check
  for (const predicateRules of rules.values()) {
    for (const rule of predicateRules) {
      checkSafety(rule.body, rule.head.args, `head of rule for '${rule.head.predicate}'`);
    }
  }
  for (const query of queries) {
    // Project the query body's named variables, in first-mention order,
    // as synthetic head args and run the same safety pass rule bodies
    // use. The synthetic Variable nodes carry the CST position of the
    // first appearance so an unsafe projection points at the right token.
    const projection = queryProjection(query);
    checkSafety(query.body, projection, "query projection");
  }

  // Validate aggregate rules
  for (const [predicate, predicateRules] of rules) {
    const hasAggregate = predicateRules.some((r) => r.head.args.some((a) => containsAggregate(a)));
    if (!hasAggregate) continue;

    for (const rule of predicateRules) {
      // All rules must be aggregate rules
      const ruleHasAgg = rule.head.args.some((a) => containsAggregate(a));
      if (!ruleHasAgg) {
        const pos = nodePos(rule.head);
        throw new AnalyzerError(
          `Predicate '${predicate}' has both aggregate and non-aggregate rules`,
          ...(pos ?? []),
        );
      }
      // A fact (empty body) can't have an aggregate in the head: there's
      // no tuple stream to aggregate over. Flag it here so the user sees
      // an AnalyzerError with a source position rather than a cryptic
      // "Unexpected term type: AggregateCall" from deep inside the
      // translator's fact path.
      if (rule.body.length === 0) {
        const pos = nodePos(rule.head);
        throw new AnalyzerError(
          `Fact for '${predicate}' cannot contain an aggregate — aggregates require a non-empty rule body`,
          ...(pos ?? []),
        );
      }
      for (const arg of rule.head.args) {
        if (arg.$type === "AggregateCall") {
          // No nested aggregates
          if (containsAggregate(arg.arg)) {
            const pos = nodePos(arg);
            throw new AnalyzerError(
              `Nested aggregate in head of rule for '${predicate}'`,
              ...(pos ?? []),
            );
          }
        } else if (containsAggregate(arg)) {
          // A top-level FunctionCall whose name matches an aggregate but
          // whose arity isn't 1 survives post-processing as a FunctionCall
          // (the rewrite-to-AggregateCall only fires for the single-argument
          // form). Surface that as an arity error rather than the generic
          // "aggregate must be a top-level head argument" message — that
          // misleading text suggests the aggregate is nested when it's
          // actually right where the user put it.
          if (
            arg.$type === "FunctionCall" &&
            AGGREGATE_NAMES.has(arg.name) &&
            arg.args.length !== 1
          ) {
            const pos = nodePos(arg);
            throw new AnalyzerError(
              `Aggregate '${arg.name}' takes exactly 1 argument, but got ${arg.args.length}`,
              ...(pos ?? []),
            );
          }
          // Aggregate must be top-level, not embedded in an expression
          const pos = nodePos(arg);
          throw new AnalyzerError(
            `Aggregate must be a top-level head argument in rule for '${predicate}'`,
            ...(pos ?? []),
          );
        }
      }
    }

    // All rules must agree on which positions are aggregate vs grouping
    // *and* on which aggregate function applies — otherwise the SQL
    // emission UNIONs a `count` value from one branch with a `sum`
    // value from the other under the same column name, producing a
    // semantically nonsensical result.
    const firstRule = predicateRules[0]!;
    const aggSlots = firstRule.head.args.map((a) =>
      a.$type === "AggregateCall"
        ? { isAgg: true as const, func: a.func }
        : { isAgg: false as const },
    );
    for (let r = 1; r < predicateRules.length; r++) {
      const rule = predicateRules[r]!;
      for (let i = 0; i < rule.head.args.length; i++) {
        const arg = rule.head.args[i]!;
        const slot = aggSlots[i]!;
        const isAgg = arg.$type === "AggregateCall";
        if (isAgg !== slot.isAgg) {
          const pos = nodePos(rule.head);
          throw new AnalyzerError(
            `Rules for '${predicate}' disagree on which head positions are aggregates`,
            ...(pos ?? []),
          );
        }
        if (isAgg && slot.isAgg && arg.func !== slot.func) {
          const pos = nodePos(rule.head);
          throw new AnalyzerError(
            `Rules for '${predicate}' disagree on the aggregate function at position ${i + 1}: '${slot.func}' vs '${arg.func}'`,
            ...(pos ?? []),
          );
        }
      }
    }
  }

  // Every occurrence of a predicate must spell the `^` sigil the same way. The
  // sigil is not part of the name (spec §4.3): the definition claims the
  // polarity and every call site repeats the claim, so that a reader can tell
  // at the call site whether a negation inside a cycle is deliberate.
  const checkPolaritySpelling = (
    predicate: string,
    spelled: boolean,
    node: { $cstNode?: { offset: number; end: number } },
  ) => {
    const declared = maximalPredicates.has(predicate);
    if (spelled === declared) return;
    const pos = nodePos(node);
    throw new AnalyzerError(
      declared
        ? `'${predicate}' is a maximal predicate; write '${predicate}^' here`
        : `'${predicate}' is not a maximal predicate, so it cannot be written '${predicate}^' here`,
      ...(pos ?? []),
    );
  };
  for (const predicateRules of rules.values()) {
    for (const rule of predicateRules) {
      checkPolaritySpelling(rule.head.predicate, !!rule.head.maximal, rule.head);
      for (const elem of rule.body) {
        if (elem.$type === "Literal") checkPolaritySpelling(elem.predicate, !!elem.maximal, elem);
      }
    }
  }
  for (const query of queries) {
    for (const elem of query.body) {
      if (elem.$type === "Literal") checkPolaritySpelling(elem.predicate, !!elem.maximal, elem);
    }
  }

  // Build dependency graph (IDB predicates only), tracking positive and negative deps
  const dependencies = new Map<string, Set<string>>();
  const negativeDependencies = new Map<string, Set<string>>();
  for (const [predicate, predicateRules] of rules) {
    const deps = new Set<string>();
    const negDeps = new Set<string>();
    for (const rule of predicateRules) {
      for (const elem of rule.body) {
        if (elem.$type === "Literal") {
          // Built-in body atoms (object_entry / array_element) are
          // stateless iteration primitives — they're not predicates and
          // don't participate in the SCC dependency graph.
          if (BUILTIN_BODY_ATOMS.has(elem.predicate)) continue;
          deps.add(elem.predicate);
          if (elem.negated) {
            negDeps.add(elem.predicate);
          }
        }
      }
    }
    dependencies.set(predicate, deps);
    negativeDependencies.set(predicate, negDeps);
  }

  // Find SCCs using Tarjan's algorithm
  const sccs = tarjanSCC(rules, dependencies);

  // Detect recursion: an SCC is recursive if it has >1 member or a self-loop
  const recursivePredicates = new Set<string>();
  for (const scc of sccs) {
    if (scc.length > 1) {
      for (const pred of scc) {
        recursivePredicates.add(pred);
      }
    } else {
      const pred = scc[0]!;
      const deps = dependencies.get(pred);
      if (deps?.has(pred)) {
        recursivePredicates.add(pred);
      }
    }
  }

  // Detect non-linear recursion: a rule is non-linear if its body has >1 atom
  // referring to predicates in the same SCC. All predicates in such an SCC are
  // marked non-linear because they share the same recursive evaluation.
  const nonLinearPredicates = new Set<string>();
  for (const scc of sccs) {
    const sccSet = new Set(scc);
    if (!scc.some((p) => recursivePredicates.has(p))) continue;
    let isNonLinear = false;
    for (const pred of scc) {
      const predRules = rules.get(pred);
      if (!predRules) continue;
      for (const rule of predRules) {
        let sccAtomCount = 0;
        for (const elem of rule.body) {
          if (elem.$type === "Literal" && !elem.negated && sccSet.has(elem.predicate)) {
            sccAtomCount++;
          }
        }
        if (sccAtomCount > 1) {
          isNonLinear = true;
          break;
        }
      }
      if (isNonLinear) break;
    }
    if (isNonLinear) {
      for (const pred of scc) {
        nonLinearPredicates.add(pred);
      }
    }
  }

  // Aggregate predicates cannot be recursive
  for (const pred of recursivePredicates) {
    const predRules = rules.get(pred);
    const aggRule = predRules?.find((r) => r.head.args.some((a) => a.$type === "AggregateCall"));
    if (aggRule) {
      const pos = nodePos(aggRule.head);
      throw new AnalyzerError(`Aggregate predicate '${pred}' cannot be recursive`, ...(pos ?? []));
    }
  }

  const sccOf = new Map<string, Set<string>>();
  for (const scc of sccs) {
    const sccSet = new Set(scc);
    for (const pred of scc) {
      sccOf.set(pred, sccSet);
    }
  }

  // Polarity check (spec §4.3), which subsumes the older "no negation inside
  // an SCC" rule. Within one SCC a positive call must join predicates of the
  // same polarity and a negated call must join opposite ones, so a cycle
  // crosses an even number of negations and the alternating fixed point has
  // somewhere to start. With no `^` anywhere the second clause can never hold
  // and this degenerates to plain stratified negation.
  for (const [predicate, predicateRules] of rules) {
    const myScc = sccOf.get(predicate);
    if (!myScc) continue;
    const headMaximal = maximalPredicates.has(predicate);
    for (const rule of predicateRules) {
      for (const elem of rule.body) {
        if (elem.$type !== "Literal") continue;
        if (BUILTIN_BODY_ATOMS.has(elem.predicate)) continue;
        if (!myScc.has(elem.predicate)) continue;
        const bodyMaximal = maximalPredicates.has(elem.predicate);
        if (elem.negated === (headMaximal !== bodyMaximal)) continue;
        const pos = nodePos(elem);
        // Project the failing SCC into a predicate-level dependency
        // cycle and stash it on the error. The playground reads this
        // to offer a "Show cycle" action on the error squiggly.
        const cycle = buildNegationCycle([...myScc], rules, dependencies, negativeDependencies);
        const message = elem.negated
          ? `Negation of '${elem.predicate}' in rules for '${predicate}' is not stratifiable (they are mutually recursive). Recursion through negation needs the two sides to have opposite polarity: mark exactly one of them maximal with '^'`
          : `'${predicate}' and '${elem.predicate}' are mutually recursive but have opposite polarity ('${bodyMaximal ? elem.predicate : predicate}' is maximal), so this call must be negated`;
        throw new AnalyzerError(message, pos?.[0], pos?.[1], cycle);
      }
    }
  }

  // Validate function calls in all rules
  for (const predicateRules of rules.values()) {
    for (const rule of predicateRules) {
      for (const arg of rule.head.args) {
        checkFunctionCalls(arg);
      }
      for (const elem of rule.body) {
        switch (elem.$type) {
          case "Literal":
            for (const arg of elem.args) checkFunctionCalls(arg);
            break;
          case "Equality":
            checkFunctionCalls(elem.left);
            checkFunctionCalls(elem.expr);
            break;
          case "Filter":
            checkFunctionCalls(elem.expr);
            break;
          case "RangeAtom":
            checkFunctionCalls(elem.expr);
            checkFunctionCalls(elem.low);
            checkFunctionCalls(elem.high);
            break;
        }
      }
    }
  }

  // Validate function calls in queries too
  for (const query of queries) {
    for (const elem of query.body) {
      switch (elem.$type) {
        case "Literal":
          for (const arg of elem.args) checkFunctionCalls(arg);
          break;
        case "Equality":
          checkFunctionCalls(elem.left);
          checkFunctionCalls(elem.expr);
          break;
        case "Filter":
          checkFunctionCalls(elem.expr);
          break;
        case "RangeAtom":
          checkFunctionCalls(elem.expr);
          checkFunctionCalls(elem.low);
          checkFunctionCalls(elem.high);
          break;
      }
    }
  }

  // Tarjan's outputs SCCs with dependencies before dependents
  const sortedStrata = sccs;

  return {
    extDecls,
    rules,
    arities,
    queries: queries.filter((q) => !q.isError),
    constraints: queries.filter((q) => q.isError),
    dependencies,
    negativeDependencies,
    sortedStrata,
    recursivePredicates,
    nonLinearPredicates,
    maximalPredicates,
    sourceFile: file,
  };
}

/** Check whether a term contains any aggregate call. */
function containsAggregate(term: HeadTerm): boolean {
  switch (term.$type) {
    case "AggregateCall":
      return true;
    case "BinaryExpr":
      return containsAggregate(term.left) || containsAggregate(term.right);
    case "UnaryExpr":
      return containsAggregate(term.operand);
    case "FunctionCall":
      return AGGREGATE_NAMES.has(term.name) || term.args.some(containsAggregate);
    case "Subscript":
      return containsAggregate(term.object) || containsAggregate(term.index);
    case "Slice":
      return (
        containsAggregate(term.object) ||
        (term.start !== undefined && containsAggregate(term.start)) ||
        (term.end !== undefined && containsAggregate(term.end))
      );
    case "ArrayLiteral":
      return term.elements.some(containsAggregate);
    case "ObjectLiteral":
      return term.entries.some((entry) => containsAggregate(entry.value));
    default:
      return false;
  }
}

/** Validate that all function calls in an expression tree use allowed functions with correct arity. */
function checkFunctionCalls(term: HeadTerm): void {
  switch (term.$type) {
    case "FunctionCall": {
      // Run a name + arity check by resolving the call with all-undefined
      // argument types: `resolveCall` returns `unknown-name` /
      // `arity-mismatch` errors regardless of arg types, so this catches
      // both pre-typing failures. Type-dependent overload resolution
      // (no-match / ambiguous) happens later in `validateTypes`.
      const probe = resolveCall(
        term.name,
        term.args.map(() => undefined),
      );
      if (probe.error?.kind === "unknown-name") {
        const pos = nodePos(term);
        // Distinguish aggregate names from genuinely-unknown functions:
        // `concat(X)` in a body position parses as a FunctionCall
        // (post-processing only rewrites top-level head args), so the
        // user gets here. Saying "Unknown function" misleads — the name
        // is known, it's just only valid in head positions.
        if (AGGREGATE_NAMES.has(term.name)) {
          throw new AnalyzerError(
            `Aggregate '${term.name}' can only appear at the top level of a rule head, not in a body expression`,
            ...(pos ?? []),
          );
        }
        throw new AnalyzerError(`Unknown function '${term.name}'`, ...(pos ?? []));
      }
      if (probe.error?.kind === "arity-mismatch") {
        const pos = nodePos(term);
        const arityStr = probe.error.arities.join(" or ");
        throw new AnalyzerError(
          `Function '${term.name}' expects ${arityStr} argument(s) but got ${term.args.length}`,
          ...(pos ?? []),
        );
      }
      for (const arg of term.args) checkFunctionCalls(arg);
      break;
    }
    case "BinaryExpr":
      checkFunctionCalls(term.left);
      checkFunctionCalls(term.right);
      break;
    case "UnaryExpr":
      checkFunctionCalls(term.operand);
      break;
    case "AggregateCall":
      // count(*) is the one aggregate that takes the `*` wildcard; its arg is
      // not a value expression, so don't recurse into it. Every other
      // aggregate recurses, so `sum(*)` etc. hit the Wildcard case below.
      if (term.func === "count" && term.arg.$type === "Wildcard") break;
      checkFunctionCalls(term.arg);
      break;
    case "Wildcard":
      // Reached only for a `*` that is not the argument of count(*).
      throw new AnalyzerError(
        "'*' is only valid as the argument of count(*)",
        ...(nodePos(term) ?? []),
      );
    case "Subscript":
      checkFunctionCalls(term.object);
      checkFunctionCalls(term.index);
      break;
    case "Slice":
      checkFunctionCalls(term.object);
      if (term.start) checkFunctionCalls(term.start);
      if (term.end) checkFunctionCalls(term.end);
      break;
    case "ArrayLiteral":
      for (const e of term.elements) checkFunctionCalls(e);
      break;
    case "ObjectLiteral":
      for (const entry of term.entries) checkFunctionCalls(entry.value);
      break;
  }
}

/**
 * Check safety of a rule:
 * - A variable is "safe" if it appears in a positive (unnegated) body atom argument,
 *   or it is the bare-variable side of an equality whose other side's
 *   variables are all safe.
 * - Every variable in the head, in negated literals, in equality expressions,
 *   and in complex expressions in positive atom arguments must be safe after
 *   equality/range propagation reaches a fixed point.
 */
/**
 * Run the body+head safety check. Factored to take `body` and `headArgs`
 * separately so the same algorithm covers both rules (head = rule's
 * declared head args) and queries (head = synthetic Variable nodes for
 * the projection columns).
 */
function checkSafety(body: BodyElement[], headArgs: HeadTerm[], headContext: string) {
  // Phase 1: collect variables grounded by positive atoms
  const safeVars = new Set<string>();
  const equalities: { variable: string; exprVars: Set<string> }[] = [];

  for (const elem of body) {
    if (elem.$type === "Literal" && !elem.negated) {
      const builtin = BUILTIN_BODY_ATOMS.get(elem.predicate);
      if (builtin !== undefined) {
        // Built-in body atoms (object_entry / array_element) bind the
        // bound-arg Variable positions when the source arg's vars are
        // safe — exactly the same fixed-point structure as a binding
        // range or binding equality. Phase 2 below resolves it once
        // safety propagates.
        const sourceVars = new Set<string>();
        collectVars(elem.args[builtin.sourceArg]!, sourceVars);
        for (const { index } of builtin.boundArgs) {
          const arg = elem.args[index]!;
          if (arg.$type === "Variable") {
            equalities.push({ variable: arg.name, exprVars: sourceVars });
          }
        }
      } else {
        for (const arg of elem.args) {
          if (arg.$type === "Variable") {
            safeVars.add(arg.name);
          }
        }
      }
    } else if (elem.$type === "Equality") {
      // Equality binds a bare variable on either side when the other side
      // is safe. This keeps body equality symmetric: `X = Y + 1` and
      // `Y + 1 = X` have the same safety behaviour.
      for (const binding of equalityBindingCandidates(elem)) {
        const exprVars = new Set<string>();
        collectVars(binding.expr, exprVars);
        equalities.push({ variable: binding.variable, exprVars });
      }
    } else if (elem.$type === "RangeAtom") {
      // If expr is a variable, it may be bound by the range (like an equality)
      if (elem.expr.$type === "Variable") {
        const boundVars = new Set<string>();
        collectVars(elem.low, boundVars);
        collectVars(elem.high, boundVars);
        equalities.push({ variable: elem.expr.name, exprVars: boundVars });
      }
    }
  }

  // Phase 2: fixed-point — equality binds a bare variable once all vars on
  // the other side are safe.
  let changed = true;
  while (changed) {
    changed = false;
    for (const eq of equalities) {
      if (!safeVars.has(eq.variable)) {
        let allSafe = true;
        for (const v of eq.exprVars) {
          if (!safeVars.has(v)) {
            allSafe = false;
            break;
          }
        }
        if (allSafe) {
          safeVars.add(eq.variable);
          changed = true;
        }
      }
    }
  }

  function checkTermSafe(term: HeadTerm, context: string) {
    const vars = new Set<string>();
    collectVars(term, vars);
    for (const v of vars) {
      if (!safeVars.has(v)) {
        const pos = nodePos(term);
        // The parser rewrites every `_` to a fresh internal name, so
        // the "unsafe" variable here is actually the don't-care marker
        // the user wrote. Surfacing the synthetic name leaks an internal
        // detail and obscures the real diagnostic ("`_` doesn't make
        // sense in this position"). Emit a dedicated message instead.
        if (isAnonymousVar(v)) {
          throw new AnalyzerError(
            `The don't-care variable '_' can only appear where any value is acceptable: as an argument of a positive or negated atom. It is not allowed in ${context} (to count rows, write count(*))`,
            ...(pos ?? []),
          );
        }
        throw new AnalyzerError(`Unsafe variable '${v}' in ${context}`, ...(pos ?? []));
      }
    }
  }

  // Check head variables
  for (const arg of headArgs) {
    if (arg.$type === "AggregateCall") {
      // count(*) counts rows: the wildcard binds no variable, so there is
      // nothing to check for safety. Its legality is enforced by
      // checkWildcards.
      if (arg.arg.$type === "Wildcard") {
        continue;
      }
      checkTermSafe(arg.arg, `aggregate in ${headContext}`);
    } else {
      checkTermSafe(arg, headContext);
    }
  }

  // Check body elements left-to-right
  for (const elem of body) {
    switch (elem.$type) {
      case "Literal":
        if (elem.negated) {
          for (const arg of elem.args) {
            // Anonymous variables (`_`, renamed to internal `$anonN` names) in a
            // negated atom mean "any value" — they don't need to be bound.
            if (arg.$type === "Variable" && isAnonymousVar(arg.name)) continue;
            checkTermSafe(arg, `'not ${elem.predicate}(...)'`);
          }
        } else {
          const builtin = BUILTIN_BODY_ATOMS.get(elem.predicate);
          if (builtin !== undefined) {
            // Source-arg expression: every variable inside must already
            // be safe (bound by an earlier or later positive atom). This
            // is the precondition for the iteration to fire.
            checkTermSafe(
              elem.args[builtin.sourceArg]!,
              `source argument of '${elem.predicate}(...)'`,
            );
            // Non-Variable bound positions act as constraints — the
            // engine compares the iterator's emitted value against the
            // expression, so the expression's variables must be safe.
            // Variable bound positions are bound by this atom and need
            // no check.
            for (const { index } of builtin.boundArgs) {
              const arg = elem.args[index]!;
              if (arg.$type !== "Variable") {
                checkTermSafe(arg, `argument of '${elem.predicate}(...)'`);
              }
            }
          } else {
            for (const arg of elem.args) {
              if (arg.$type !== "Variable") {
                checkTermSafe(arg, `argument of '${elem.predicate}(...)'`);
              }
            }
          }
        }
        break;
      case "Equality":
        // Prefer diagnostics on the side that prevented a bare variable
        // from being bound, preserving the old "unsafe RHS" style for
        // `Y = X + Z` while still handling the symmetric `X + Z = Y`.
        if (elem.left.$type === "Variable" && !safeVars.has(elem.left.name)) {
          checkTermSafe(elem.expr, `equality '${elem.left.name} = ...'`);
        }
        if (elem.expr.$type === "Variable" && !safeVars.has(elem.expr.name)) {
          checkTermSafe(elem.left, `equality '... = ${elem.expr.name}'`);
        }
        checkTermSafe(elem.left, "left-hand side of equality");
        checkTermSafe(elem.expr, "right-hand side of equality");
        break;
      case "Filter":
        checkTermSafe(elem.expr, "filter expression");
        break;
      case "RangeAtom":
        checkTermSafe(elem.low, "range lower bound");
        checkTermSafe(elem.high, "range upper bound");
        if (elem.expr.$type !== "Variable") {
          checkTermSafe(elem.expr, "range expression");
        }
        break;
    }
  }
}

/**
 * Compute the projection columns of a query: every distinct
 * non-anonymous Variable that appears in the body, in source-order of
 * first mention. Returns the first-occurrence Variable AST nodes so
 * downstream stages (safety, translation) can keep their CST positions
 * for diagnostics.
 */
export function queryProjection(query: Query): HeadTerm[] {
  const projection: HeadTerm[] = [];
  const seen = new Set<string>();
  function visit(term: HeadTerm): void {
    switch (term.$type) {
      case "Variable":
        if (!isSyntheticVar(term.name) && !seen.has(term.name)) {
          seen.add(term.name);
          projection.push(term);
        }
        return;
      case "BinaryExpr":
        visit(term.left);
        visit(term.right);
        return;
      case "UnaryExpr":
        visit(term.operand);
        return;
      case "FunctionCall":
        for (const a of term.args) visit(a);
        return;
      case "AggregateCall":
        // Queries don't have aggregates (no head), but the type union
        // still allows them; recurse into the wrapped expression.
        visit(term.arg);
        return;
      case "Subscript":
        visit(term.object);
        visit(term.index);
        return;
      case "Slice":
        visit(term.object);
        if (term.start) visit(term.start);
        if (term.end) visit(term.end);
        return;
      case "ArrayLiteral":
        for (const e of term.elements) visit(e);
        return;
      case "ObjectLiteral":
        for (const entry of term.entries) visit(entry.value);
        return;
    }
  }
  for (const elem of query.body) {
    switch (elem.$type) {
      case "Literal":
        for (const arg of elem.args) visit(arg);
        break;
      case "Equality":
        visit(elem.left);
        visit(elem.expr);
        break;
      case "Filter":
        visit(elem.expr);
        break;
      case "RangeAtom":
        visit(elem.expr);
        visit(elem.low);
        visit(elem.high);
        break;
    }
  }
  return projection;
}

/**
 * The (variable, other-side) pairs by which a body equality can ground a
 * variable: one per side that is a bare variable.
 *
 * A bare `null` literal on the other side is not one of them. `null` is
 * polymorphic, so `X = null` says nothing about what `X` holds and cannot
 * determine its column's type; treating it as a binding produces a column
 * no rule constrains, reported far from the cause. Say the type to bind:
 * `X = null + 0` grounds `X` as an integer NULL, `X = null + ""` as a
 * string one. Where `X` is already grounded, `X = null` is unaffected and
 * remains an `IS NULL` filter.
 *
 * This is a syntactic approximation of "the other side has no type", which
 * is the rule `doc/design/typing-and-safety-constraints.md` states. Safety
 * runs before type inference, so it cannot ask for the type. The
 * approximation grounds strictly more variables than the typed rule would,
 * so it never admits an unsafe program; the gap surfaces as a
 * cannot-infer-type error rather than an unbound-variable one.
 */
function equalityBindingCandidates(eq: Equality): { variable: string; expr: HeadTerm }[] {
  const candidates: { variable: string; expr: HeadTerm }[] = [];
  if (eq.left.$type === "Variable" && eq.expr.$type !== "NullLiteral") {
    candidates.push({ variable: eq.left.name, expr: eq.expr });
  }
  if (eq.expr.$type === "Variable" && eq.left.$type !== "NullLiteral") {
    candidates.push({ variable: eq.expr.name, expr: eq.left });
  }
  return candidates;
}

function tarjanSCC(rules: Map<string, Rule[]>, dependencies: Map<string, Set<string>>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongconnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const deps = dependencies.get(v) ?? new Set();
    for (const w of deps) {
      // Only consider IDB predicates (those that have rules)
      if (!rules.has(w)) continue;

      if (!indices.has(w)) {
        strongconnect(w);
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
  }

  for (const v of rules.keys()) {
    if (!indices.has(v)) {
      strongconnect(v);
    }
  }

  return sccs;
}
