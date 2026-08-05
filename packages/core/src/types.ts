import {
  AnalyzerError,
  BUILTIN_BODY_ATOMS,
  allVarsBound,
  equalityBindingCandidates,
} from "./analyzer.ts";
import type { AnalyzedProgram, BuiltinBodyAtomSpec } from "./analyzer.ts";
import type { BodyElement, FunctionCall, HeadTerm, PrimitiveType, RangeAtom } from "./ast.ts";
import { BITWISE_OPS, COMPARISON_OPS, EQUALITY_OPS, isFloatLiteral } from "./ast.ts";
import { type Overload, type ResolutionError, resolveCall } from "./builtins.ts";
import { type BodyOwner, type NullnessInfo, inferNullness } from "./nullness.ts";

export interface TypedProgram extends AnalyzedProgram {
  /** Column types for every predicate (EDB and IDB). Used by codegen. */
  columnTypes: Map<string, PrimitiveType[]>;
  /**
   * Published column types: `columnTypes` widened at each position by the head
   * annotations on it. This is the type a predicate advertises to its consumers
   * and across module boundaries — the assume-guarantee contract. Equal to
   * `columnTypes` for unannotated positions; codegen uses `columnTypes`, not
   * this.
   */
  publishedTypes: Map<string, PrimitiveType[]>;
  /**
   * Resolved overload for each `FunctionCall` AST node in the program.
   * Backends key their SQL-emit / native-impl tables on `Overload.key`,
   * so this map is the single hand-off from type inference to backend
   * dispatch — no name-based switches downstream.
   */
  functionOverloads: Map<FunctionCall, Overload>;
  /**
   * Which columns can hold SQL NULL, and which variables each body proves
   * cannot. A second component beside the base type rather than an element
   * within it, so `columnTypes` is unchanged by it. Codegen reads this to
   * choose between the null-aware and the plain equality; see
   * doc/design/nullness-tracking.md.
   */
  nullness: NullnessInfo;
}

/**
 * Infer column types for all predicates.
 *
 * EDB types are known from declarations. IDB types are inferred by tracing
 * rule head arguments back to their sources via variable bindings and
 * expression type rules. Uses a fixed-point iteration for recursive predicates.
 */
export function inferTypes(analyzed: AnalyzedProgram): TypedProgram {
  try {
    return inferTypesImpl(analyzed);
  } catch (e) {
    if (e instanceof AnalyzerError) e.file ??= analyzed.sourceFile;
    throw e;
  }
}

function inferTypesImpl(analyzed: AnalyzedProgram): TypedProgram {
  // Internal representation allows undefined for unknown positions
  const types = new Map<string, (PrimitiveType | undefined)[]>();

  // Seed EDB types from declarations
  for (const [predicate, decl] of analyzed.extDecls) {
    types.set(
      predicate,
      decl.columns.map((c) => c.type),
    );
  }

  // Initialize IDB types — seed from facts (empty body rules) where possible
  for (const [predicate, rules] of analyzed.rules) {
    const arity = analyzed.arities.get(predicate)!;
    const seedTypes: (PrimitiveType | undefined)[] = new Array(arity).fill(undefined);

    for (const rule of rules) {
      if (rule.body.length === 0) {
        for (const [i, arg] of rule.head.args.entries()) {
          if (arg.$type === "StringLiteral") {
            seedTypes[i] = unifyColumnType(seedTypes[i], "string");
          } else if (arg.$type === "NumberLiteral") {
            const t = isFloatLiteral(arg) || !Number.isInteger(arg.value) ? "float" : "integer";
            seedTypes[i] = unifyColumnType(seedTypes[i], t);
          } else if (arg.$type === "BooleanLiteral") {
            seedTypes[i] = unifyColumnType(seedTypes[i], "boolean");
          }
        }
      }
    }

    types.set(predicate, seedTypes);
  }

  // Fixed-point iteration: infer types from rules until stable
  let changed = true;
  while (changed) {
    changed = false;
    for (const stratum of analyzed.sortedStrata) {
      for (const predicate of stratum) {
        const rules = analyzed.rules.get(predicate);
        if (!rules) continue;

        const arity = analyzed.arities.get(predicate)!;
        const newTypes: (PrimitiveType | undefined)[] = new Array(arity).fill(undefined);

        for (const rule of rules) {
          const varTypes = rebuildVarTypes(rule.body, types);

          // Infer head argument types
          for (let i = 0; i < rule.head.args.length; i++) {
            const arg = rule.head.args[i]!;
            const argType = inferTermType(arg, varTypes, types);
            if (argType) {
              newTypes[i] = unifyColumnType(newTypes[i], argType);
            }
          }
        }

        // Merge new types with old, check for changes
        const oldTypes = types.get(predicate)!;
        for (let i = 0; i < arity; i++) {
          const merged = newTypes[i] ?? oldTypes[i];
          if (merged !== oldTypes[i]) {
            changed = true;
          }
          oldTypes[i] = merged;
        }
      }
    }
  }

  // Published types: what each predicate advertises to consumers (inferred,
  // widened by any head annotations). Validation and the guarantee check hold
  // consumers to these while a predicate's own body still sees its inferred
  // types. Codegen uses the inferred types, so `published` never reaches SQL.
  const published = computePublishedTypes(analyzed, types);

  // Validate types (ranges, operators, function args). Validation also
  // resolves each FunctionCall to a specific overload — populated into
  // this map during the walk and threaded back out via TypedProgram.
  const functionOverloads = new Map<FunctionCall, Overload>();
  validateTypes(analyzed, types, published, functionOverloads);

  // Nullness is a second component beside the base type, inferred by its own
  // fixed point once the types it reads are settled and the calls it reads are
  // resolved. Variable types per body are memoised: they no longer change here,
  // but `inferNullness` revisits each rule on every round of its outer loop.
  const varTypeCache = new Map<BodyOwner, Map<string, PrimitiveType>>();
  const nullness = inferNullness(analyzed, {
    overloads: functionOverloads,
    typeOf: (owner, expr) => {
      let vars = varTypeCache.get(owner);
      if (!vars) {
        vars = rebuildVarTypes(owner.body, types);
        varTypeCache.set(owner, vars);
      }
      return inferTermType(expr, vars, types);
    },
  });

  checkHeadAnnotations(analyzed, types, published, nullness);

  // Finalize: reject unconstrained column types. `publishedTypes` is
  // `columnTypes` widened by annotations (`published` ≥ inferred, so it is
  // defined wherever the inferred type is).
  const columnTypes = new Map<string, PrimitiveType[]>();
  const publishedTypes = new Map<string, PrimitiveType[]>();
  for (const [pred, predTypes] of types) {
    const finalTypes: PrimitiveType[] = [];
    const pubTypes: PrimitiveType[] = [];
    const pub = published.get(pred) ?? predTypes;
    for (let i = 0; i < predTypes.length; i++) {
      const t = predTypes[i];
      if (t === undefined) {
        // EDB column types are seeded from declarations and never
        // undefined here, so this only fires for IDBs. Pick the first
        // rule's head argument at position `i` as the offending
        // location — that's where the user would write the term whose
        // type would have constrained the column. Without a position,
        // the playground lint squiggly defaults to offset 0 and the
        // error message reads as if it's about the whole program.
        const headArg = analyzed.rules.get(pred)?.[0]?.head.args[i];
        const cst = headArg?.$cstNode;
        throw new AnalyzerError(
          `Cannot infer type of column ${i + 1} of predicate '${pred}'`,
          cst?.offset,
          cst?.end,
        );
      }
      finalTypes.push(t);
      pubTypes.push(pub[i] ?? t);
    }
    columnTypes.set(pred, finalTypes);
    publishedTypes.set(pred, pubTypes);
  }

  return { ...analyzed, columnTypes, publishedTypes, functionOverloads, nullness };
}

function isNumericType(t: PrimitiveType | undefined): boolean {
  return t === "integer" || t === "float";
}

/**
 * Build a per-position type list for a built-in body atom (used by
 * `rebuildVarTypes` to seed Variable types from positional arg types).
 * The source position carries no type for the variable being read — its
 * type comes from wherever else the variable appears — so we leave it
 * undefined; the bound positions get their declared types.
 */
function buildBuiltinTypeList(spec: BuiltinBodyAtomSpec): (PrimitiveType | undefined)[] {
  const out: (PrimitiveType | undefined)[] = new Array(spec.arity).fill(undefined);
  for (const { index, type } of spec.boundArgs) out[index] = type;
  return out;
}

/**
 * Same as `buildBuiltinTypeList`, but additionally pins the source
 * position to its required type. Used in `validateTypes` to check
 * that the source argument is `json`-typed; `rebuildVarTypes` does
 * not use this form because typing the source variable from the
 * built-in atom would create a redundant constraint that gets
 * checked properly here anyway.
 */
function buildBuiltinSourceAndBoundTypes(spec: BuiltinBodyAtomSpec): (PrimitiveType | undefined)[] {
  const out = buildBuiltinTypeList(spec);
  out[spec.sourceArg] = spec.sourceType;
  return out;
}

/** Rebuild the variable type environment for a rule. */
/**
 * Build a per-variable type map for a body. Shared between rules
 * (whose `body` is the rule body) and queries (whose `body` is the
 * query body). Exported so the translator can attach types to the
 * projected variables of a query.
 */
export function rebuildVarTypes(
  body: BodyElement[],
  types: Map<string, (PrimitiveType | undefined)[]>,
): Map<string, PrimitiveType> {
  const varTypes = new Map<string, PrimitiveType>();

  // Atom-derived types don't depend on other body elements, so seed them first
  // in a single pass. Equalities and ranges can reference variables bound by
  // atoms appearing anywhere in the body, so defer them to the fixed-point
  // loop below (mirroring the safety check and translator Pass 2, which also
  // iterate until nothing new is learned).
  //
  // When a variable appears in several atoms it takes their MEET (greatest
  // lower bound): it has to be a valid value in every column it occupies, so
  // `integer`/`float` narrow to `integer`, a primitive shared with a `value`
  // column narrows to the primitive, same-type is a no-op, and two
  // incompatible primitives (no common lower bound) throw. First-wins would
  // silently pick one type and hide the conflict; the join (least upper
  // bound) would over-widen — `r(X) :- p(X), q(X)` with `p: integer`,
  // `q: value` would call X a `value` when it is really an integer, then
  // spuriously reject a later `X & 1`.
  for (const elem of body) {
    if (elem.$type === "Literal" && !elem.negated) {
      const builtin = BUILTIN_BODY_ATOMS.get(elem.predicate);
      const predTypes = builtin
        ? // Synthesise a per-position type list for built-in body
          // atoms: bound positions get their declared types, the source
          // position is whatever shape the iteration accepts.
          buildBuiltinTypeList(builtin)
        : types.get(elem.predicate);
      if (!predTypes) continue;
      for (let j = 0; j < elem.args.length; j++) {
        const arg = elem.args[j]!;
        if (arg.$type !== "Variable") continue;
        const colType = predTypes[j];
        if (!colType) continue;
        const existing = varTypes.get(arg.name);
        const joined = meetTypes(existing, colType);
        if (joined === null) {
          const cst = arg.$cstNode;
          throw new AnalyzerError(
            `Variable '${arg.name}' has conflicting types '${existing}' and '${colType}'`,
            cst?.offset,
            cst?.end,
          );
        }
        varTypes.set(arg.name, joined);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const elem of body) {
      if (elem.$type === "Equality") {
        for (const binding of equalityBindingCandidates(elem)) {
          if (varTypes.has(binding.variable)) continue;
          if (!allVarsTyped(binding.expr, varTypes)) continue;
          const exprType = inferTermType(binding.expr, varTypes, types);
          if (!exprType) continue;
          varTypes.set(binding.variable, exprType);
          changed = true;
        }
      } else if (elem.$type === "RangeAtom") {
        if (elem.expr.$type !== "Variable" || varTypes.has(elem.expr.name)) continue;
        const lowType = inferTermType(elem.low, varTypes, types);
        const highType = inferTermType(elem.high, varTypes, types);
        // A range types its variable only once *both* bounds are typed —
        // the same condition the binding-equality path applies via
        // `allVarsTyped`. One typed bound does not determine the variable's
        // type, and accepting it lets `X in [1 .. N]` with an untyped `N`
        // through the analyzer as `integer`, which the translator cannot
        // then build a series for. Leaving the variable untyped is what
        // surfaces the real problem (the untyped bound).
        if (!lowType || !highType) continue;
        const rangeType = joinTypes(lowType, highType);
        if (rangeType) {
          varTypes.set(elem.expr.name, rangeType);
          changed = true;
        }
      }
    }
  }
  return varTypes;
}

/** `allVarsBound` against the variables typed so far. */
function allVarsTyped(term: HeadTerm, varTypes: Map<string, PrimitiveType>): boolean {
  return allVarsBound(term, (name) => varTypes.has(name));
}

/** Validate types across all expressions in a rule (ranges, operators, function args). */
function validateTypes(
  analyzed: AnalyzedProgram,
  inferred: Map<string, (PrimitiveType | undefined)[]>,
  published: Map<string, (PrimitiveType | undefined)[]>,
  functionOverloads: Map<FunctionCall, Overload>,
): void {
  for (const [pred, predicateRules] of analyzed.rules) {
    // Consumers (references to other predicates) see published types; this
    // predicate's own recursive references see its inferred types.
    const types = contextForPredicate(pred, inferred, published);
    for (const rule of predicateRules) {
      const varTypes = rebuildVarTypes(rule.body, types);

      // Validate head expressions
      for (const arg of rule.head.args) {
        validateExpr(arg, varTypes, types, functionOverloads);
      }

      // Validate body expressions
      for (const elem of rule.body) {
        switch (elem.$type) {
          case "Literal": {
            const builtin = BUILTIN_BODY_ATOMS.get(elem.predicate);
            const expectedTypes: (PrimitiveType | undefined)[] = builtin
              ? buildBuiltinSourceAndBoundTypes(builtin)
              : (types.get(elem.predicate) ?? []);
            for (let j = 0; j < elem.args.length; j++) {
              const arg = elem.args[j]!;
              validateExpr(arg, varTypes, types, functionOverloads);
              // Each arg must unify with the predicate's declared column type
              // — otherwise `t("hello")` against `input predicate t(x: integer)`
              // passes silently and only surfaces as a database error at
              // runtime (if it surfaces at all; SQLite would coerce).
              const expected = expectedTypes[j];
              if (!expected) continue;
              const actual = inferTermType(arg, varTypes, types);
              // Built-in body atoms (`object_entry` / `array_element`)
              // have strict key/index slots, but their `value`-typed slots
              // behave like every other value slot: primitive expressions
              // embed automatically as JSON leaves. That includes the source
              // argument; iterating a primitive leaf simply produces zero
              // rows at runtime.
              const join =
                builtin !== undefined && expected !== "value" ? joinTypes : joinTypesWithJsonLift;
              if (actual && join(actual, expected) === null) {
                const cst = arg.$cstNode;
                throw new AnalyzerError(
                  `Argument ${j + 1} of '${elem.predicate}(...)' has type '${actual}' but ${
                    builtin ? "the position requires" : "column is declared as"
                  } '${expected}'`,
                  cst?.offset,
                  cst?.end,
                );
              }
            }
            break;
          }
          case "Equality":
            validateExpr(elem.left, varTypes, types, functionOverloads);
            validateExpr(elem.expr, varTypes, types, functionOverloads);
            checkComparableTypes(
              inferTermType(elem.left, varTypes, types),
              inferTermType(elem.expr, varTypes, types),
              elem,
              "equality",
            );
            break;
          case "Filter": {
            validateExpr(elem.expr, varTypes, types, functionOverloads);
            const t = inferTermType(elem.expr, varTypes, types);
            if (t && t !== "boolean") {
              const cst = elem.expr.$cstNode ?? elem.$cstNode;
              throw new AnalyzerError(
                `Filter expression must be boolean, got '${t}'`,
                cst?.offset,
                cst?.end,
              );
            }
            break;
          }
          case "RangeAtom":
            validateExpr(elem.expr, varTypes, types, functionOverloads);
            validateExpr(elem.low, varTypes, types, functionOverloads);
            validateExpr(elem.high, varTypes, types, functionOverloads);
            checkRangeExprTypes(elem, rule.body, varTypes, types);
            break;
        }
      }
    }
  }

  // Query bodies follow the same body-element type rules as rule
  // bodies: each positive/negated literal's args must be
  // type-compatible with the predicate's declared columns; equality
  // and filter expressions get a full type-check; range bounds must
  // be numeric. We reuse the per-body-element validation by walking
  // the query body here. Variable types are computed per query via
  // a small fixed-point over the body's atoms and bindings, mirroring
  // the rule-body inference above. Queries are pure consumers, so every
  // referenced predicate shows its published type.
  const types = published;
  for (const query of analyzed.queries) {
    const varTypes = rebuildVarTypes(query.body, types);
    for (const elem of query.body) {
      switch (elem.$type) {
        case "Literal": {
          const predTypes = types.get(elem.predicate);
          for (let j = 0; j < elem.args.length; j++) {
            const arg = elem.args[j]!;
            validateExpr(arg, varTypes, types, functionOverloads);
            if (!predTypes) continue;
            const expected = predTypes[j];
            if (!expected) continue;
            const actual = inferTermType(arg, varTypes, types);
            if (actual && joinTypesWithJsonLift(actual, expected) === null) {
              const cst = arg.$cstNode;
              throw new AnalyzerError(
                `Argument ${j + 1} of '${elem.predicate}(...)' has type '${actual}' but column is declared as '${expected}'`,
                cst?.offset,
                cst?.end,
              );
            }
          }
          break;
        }
        case "Equality":
          validateExpr(elem.left, varTypes, types, functionOverloads);
          validateExpr(elem.expr, varTypes, types, functionOverloads);
          // Mirror the rule-body `Equality` case: the operands must be
          // type-compatible. Without this the query body silently
          // accepted conflicts the equivalent rule rejects.
          checkComparableTypes(
            inferTermType(elem.left, varTypes, types),
            inferTermType(elem.expr, varTypes, types),
            elem,
            "equality",
          );
          break;
        case "Filter": {
          validateExpr(elem.expr, varTypes, types, functionOverloads);
          const t = inferTermType(elem.expr, varTypes, types);
          // Mirror the rule-body `Filter` case exactly: only `boolean`
          // is permitted. The extra `value` exemption here let a bare
          // value-typed filter through in a query but not in a rule.
          if (t && t !== "boolean") {
            const cst = elem.expr.$cstNode;
            throw new AnalyzerError(
              `Filter expression must be boolean, got '${t}'`,
              cst?.offset,
              cst?.end,
            );
          }
          break;
        }
        case "RangeAtom": {
          validateExpr(elem.expr, varTypes, types, functionOverloads);
          validateExpr(elem.low, varTypes, types, functionOverloads);
          validateExpr(elem.high, varTypes, types, functionOverloads);
          // Mirror the rule-body `RangeAtom` case: the ad-hoc bound check
          // here skipped the expr-type and integer-binding-range rules, so a
          // `?-` accepted a float binding range / non-numeric range that the
          // equivalent rule rejects, then the backends diverged at runtime.
          checkRangeExprTypes(elem, query.body, varTypes, types);
          break;
        }
      }
    }
  }
}

/**
 * Reject negative integer literals (`W[-1]`, `W[1:-1]`) as subscript or
 * slice bounds. The spec flags negative and out-of-range indices as
 * backend-defined, so catching the statically-obvious cases gives the
 * user an error at analyse time instead of a silently backend-specific
 * result. Variable-valued indices pass through — we can't prove them
 * non-negative without running the query.
 */
function rejectNegativeLiteralIndex(term: HeadTerm, context: string): void {
  if (term.$type === "UnaryExpr" && term.op === "-" && term.operand.$type === "NumberLiteral") {
    const cst = term.$cstNode;
    throw new AnalyzerError(
      `Negative ${context} is not supported; indices must be non-negative`,
      cst?.offset,
      cst?.end,
    );
  }
}

/**
 * Reject comparisons / non-binding equalities between values whose types
 * can't be unified (e.g. `X > "5"` where X is integer). Skip the check
 * when either side is of unknown type — other passes will surface that
 * as a "cannot infer type" error if it matters.
 */
function checkComparableTypes(
  leftType: PrimitiveType | undefined,
  rightType: PrimitiveType | undefined,
  node: { $cstNode?: { offset: number; end: number } },
  context: string,
): void {
  if (!leftType || !rightType) return;
  if (joinTypesWithJsonLift(leftType, rightType) === null) {
    const cst = node.$cstNode;
    throw new AnalyzerError(
      `Cannot compare '${leftType}' and '${rightType}' in ${context}`,
      cst?.offset,
      cst?.end,
    );
  }
}

/** Recursively validate expression types. */
function validateExpr(
  term: HeadTerm,
  varTypes: Map<string, PrimitiveType>,
  types: Map<string, (PrimitiveType | undefined)[]>,
  functionOverloads: Map<FunctionCall, Overload>,
): void {
  switch (term.$type) {
    case "UnaryExpr": {
      const opType = inferTermType(term.operand, varTypes, types);
      if (term.op === "!") {
        if (opType && opType !== "boolean") {
          const cst = term.$cstNode;
          throw new AnalyzerError(
            `Logical '!' requires a boolean operand, got '${opType}'`,
            cst?.offset,
            cst?.end,
          );
        }
      } else if (opType && !isNumericType(opType)) {
        const cst = term.$cstNode;
        throw new AnalyzerError(
          `Unary minus requires a numeric operand, got '${opType}'`,
          cst?.offset,
          cst?.end,
        );
      }
      validateExpr(term.operand, varTypes, types, functionOverloads);
      break;
    }
    case "Subscript": {
      const objType = inferTermType(term.object, varTypes, types);
      if (objType && objType !== "string" && objType !== "value") {
        const cst = term.$cstNode;
        throw new AnalyzerError(
          `Subscript requires a string or value operand, got '${objType}'`,
          cst?.offset,
          cst?.end,
        );
      }
      rejectNegativeLiteralIndex(term.index, "subscript index");
      // String subscripts: "Indices are zero-based integers." JSON subscripts:
      // integer for array index, string for object key. Reject other types
      // statically rather than letting them reach SUBSTR / json_extract.
      const idxType = inferTermType(term.index, varTypes, types);
      if (idxType) {
        if (objType === "value") {
          if (idxType !== "integer" && idxType !== "string") {
            const cst = term.index.$cstNode;
            throw new AnalyzerError(
              `JSON subscript index must have integer or string type, got '${idxType}'`,
              cst?.offset,
              cst?.end,
            );
          }
        } else if (idxType !== "integer") {
          const cst = term.index.$cstNode;
          throw new AnalyzerError(
            `Subscript index must have integer type, got '${idxType}'`,
            cst?.offset,
            cst?.end,
          );
        }
      }
      validateExpr(term.object, varTypes, types, functionOverloads);
      validateExpr(term.index, varTypes, types, functionOverloads);
      break;
    }
    case "Slice": {
      const objType = inferTermType(term.object, varTypes, types);
      if (objType && objType !== "string" && objType !== "value") {
        const cst = term.$cstNode;
        throw new AnalyzerError(
          `Slice requires a string or value operand, got '${objType}'`,
          cst?.offset,
          cst?.end,
        );
      }
      if (term.start) rejectNegativeLiteralIndex(term.start, "slice start");
      if (term.end) rejectNegativeLiteralIndex(term.end, "slice end");
      // Slice bounds must be integers regardless of receiver type (string or
      // json array — both are zero-based integer-indexed).
      if (term.start) {
        const startType = inferTermType(term.start, varTypes, types);
        if (startType && startType !== "integer") {
          const cst = term.start.$cstNode;
          throw new AnalyzerError(
            `Slice start must have integer type, got '${startType}'`,
            cst?.offset,
            cst?.end,
          );
        }
      }
      if (term.end) {
        const endType = inferTermType(term.end, varTypes, types);
        if (endType && endType !== "integer") {
          const cst = term.end.$cstNode;
          throw new AnalyzerError(
            `Slice end must have integer type, got '${endType}'`,
            cst?.offset,
            cst?.end,
          );
        }
      }
      validateExpr(term.object, varTypes, types, functionOverloads);
      if (term.start) validateExpr(term.start, varTypes, types, functionOverloads);
      if (term.end) validateExpr(term.end, varTypes, types, functionOverloads);
      break;
    }
    case "FunctionCall": {
      resolveAndRecordCall(term, varTypes, types, functionOverloads);
      for (const arg of term.args) validateExpr(arg, varTypes, types, functionOverloads);
      break;
    }
    case "BinaryExpr": {
      validateBinaryExprTypes(term, varTypes, types);
      validateExpr(term.left, varTypes, types, functionOverloads);
      validateExpr(term.right, varTypes, types, functionOverloads);
      break;
    }
    case "AggregateCall":
      validateAggregateArgType(term, varTypes, types);
      validateExpr(term.arg, varTypes, types, functionOverloads);
      break;
    case "ArrayLiteral":
      // Each element is auto-lifted to JSON at translation time, so any
      // primitive type is fine. Recurse so nested expressions still get
      // type-checked. The `null` literal is allowed (becomes JSON null).
      for (const e of term.elements) validateExpr(e, varTypes, types, functionOverloads);
      break;
    case "ObjectLiteral":
      // Same lift policy as ArrayLiteral; keys are STRING tokens by the
      // grammar, so no key-type check is needed here.
      for (const entry of term.entries) {
        validateExpr(entry.value, varTypes, types, functionOverloads);
      }
      break;
  }
}

/**
 * Check that a BinaryExpr's operands have compatible types for the
 * operator. Arithmetic operators (`-`, `*`, `/`, `%`) require both
 * sides numeric. `+` is overloaded: numeric-numeric does addition,
 * string-anything does concatenation — anything else is nonsense.
 */
function validateBinaryExprTypes(
  term: { op: string; left: HeadTerm; right: HeadTerm; $cstNode?: { offset: number; end: number } },
  varTypes: Map<string, PrimitiveType>,
  types: Map<string, (PrimitiveType | undefined)[]>,
): void {
  const leftType = inferTermType(term.left, varTypes, types);
  const rightType = inferTermType(term.right, varTypes, types);
  const cst = term.$cstNode;
  const complain = (context: string, badType: PrimitiveType) => {
    throw new AnalyzerError(
      `Operator '${term.op}' ${context}; got '${badType}'`,
      cst?.offset,
      cst?.end,
    );
  };
  if (term.op === "+") {
    // Concatenation is valid when at least one side is string, and addition
    // when both are numeric. Anything else (boolean, mixed boolean/string,
    // ...) has no defined meaning. `string + json` and `string + boolean`
    // specifically have no defined cross-backend behaviour: SQLite stores
    // booleans as 0/1 INTEGER and emits `value`s as canonical TEXT, so
    // `||` concat shows `'1'` for booleans and the JSON text for objects;
    // the native evaluator's `${l}${r}` template produces `'true'`/`'false'`
    // for booleans, `[object Object]` for objects, and comma-joined
    // elements for arrays. Reject json and boolean alongside the existing
    // post-string-anything check so the user gets a position-bearing
    // error instead of cross-backend divergence.
    if (leftType === "string" || rightType === "string") {
      const other = leftType === "string" ? rightType : leftType;
      if (other === "value" || other === "boolean") {
        complain("requires numeric or string operands", other);
      }
      return;
    }
    if (leftType && !isNumericType(leftType))
      complain("requires numeric or string operands", leftType);
    if (rightType && !isNumericType(rightType))
      complain("requires numeric or string operands", rightType);
    return;
  }
  if (term.op === "&&" || term.op === "||") {
    // Logical and/or: both operands must be boolean. Three-valued
    // logic (NULL handling) is enforced at runtime by SQL natively
    // and by the native evaluator's value layer.
    if (leftType && leftType !== "boolean") complain("requires boolean operands", leftType);
    if (rightType && rightType !== "boolean") complain("requires boolean operands", rightType);
    return;
  }
  if (COMPARISON_OPS.has(term.op)) {
    // Comparison expressions: operands must be type-compatible.
    // Equality (`=`, `<>`) accepts booleans (set equality is well-defined);
    // ordering ops do not (Datalog has no order on booleans, SQL backends
    // would silently coerce to 0/1).
    checkComparableTypes(leftType, rightType, term, "comparison");
    if (!EQUALITY_OPS.has(term.op) && (leftType === "boolean" || rightType === "boolean")) {
      throw new AnalyzerError(
        `Operator '${term.op}' does not order booleans`,
        cst?.offset,
        cst?.end,
      );
    }
    // Ordering on json is rejected because cross-backend ordering
    // semantics disagree (Postgres jsonb has a defined order;
    // SQLite/sql.js do not). Equality is allowed: structural on Postgres
    // jsonb, textual-after-canonicalisation on the SQLite-family backends.
    if (!EQUALITY_OPS.has(term.op) && (leftType === "value" || rightType === "value")) {
      throw new AnalyzerError(
        `Operator '${term.op}' is not defined on value — values have no cross-backend ordering`,
        cst?.offset,
        cst?.end,
      );
    }
    return;
  }
  if (BITWISE_OPS.has(term.op)) {
    // Bitwise / shift ops are defined only on integers (32-bit signed,
    // Java/JS semantics). Floats, strings, booleans, and values have no
    // bitwise meaning. A NULL operand (undefined type) is allowed and
    // propagates to NULL at runtime.
    if (leftType && leftType !== "integer") complain("requires integer operands", leftType);
    if (rightType && rightType !== "integer") complain("requires integer operands", rightType);
    return;
  }
  if (leftType && !isNumericType(leftType)) complain("requires numeric operands", leftType);
  if (rightType && !isNumericType(rightType)) complain("requires numeric operands", rightType);
}

/**
 * Check that an aggregate's argument type is sensible for the function.
 * `sum`/`avg` require numeric; `concat` accepts anything (coerced
 * to string); `count` accepts anything; `min`/`max` accept any orderable
 * type.
 */
function validateAggregateArgType(
  agg: { func: string; arg: HeadTerm; $cstNode?: { offset: number; end: number } },
  varTypes: Map<string, PrimitiveType>,
  types: Map<string, (PrimitiveType | undefined)[]>,
): void {
  const argType = inferTermType(agg.arg, varTypes, types);
  if (!argType) return;
  const cst = agg.$cstNode;
  if ((agg.func === "sum" || agg.func === "avg") && !isNumericType(argType)) {
    throw new AnalyzerError(
      `Aggregate '${agg.func}' requires a numeric argument, got '${argType}'`,
      cst?.offset,
      cst?.end,
    );
  }
  // `min` / `max` accept any *orderable* type — integer, float, or
  // string. Booleans and `value`s aren't orderable in the spec
  // sense: the native evaluator's `compareOp` throws on them
  // (`values.ts:557`), and SQL backends each use a different ordering
  // (Postgres jsonb has a "natural" ordering, SQLite stores TEXT and
  // compares lexicographically), so accepting them would produce
  // cross-backend disagreement.
  if (
    (agg.func === "min" || agg.func === "max") &&
    argType !== "integer" &&
    argType !== "float" &&
    argType !== "string"
  ) {
    throw new AnalyzerError(
      `Aggregate '${agg.func}' requires an orderable (integer / float / string) argument, got '${argType}'`,
      cst?.offset,
      cst?.end,
    );
  }
  // `list` collects values into a JSON array. Primitive arguments are
  // auto-lifted to JSON (`integer` / `float` → JSON number, `string` →
  // JSON string, `boolean` → JSON `true` / `false`); already-`json`
  // values pass through. The translator wraps with `dialect.toJson`
  // for the SQL backends, and the native evaluator treats JS
  // primitives as valid `JsonValue`s directly.
}

/**
 * Resolve a `FunctionCall` against the overload registry, validate
 * argument types as a side-effect of the resolution, and record the
 * chosen overload on the program-level map for backend dispatch.
 *
 * No-match and ambiguous outcomes throw a position-bearing
 * `AnalyzerError`. Unknown-name and arity-mismatch are already caught
 * earlier in `analyze` (`checkFunctionCalls`), so we don't repeat those
 * messages here. If args are still under-determined at validation time
 * — the only realistic case is a `null` literal in arg position — we
 * leave the overload unrecorded and let NULL propagate at runtime;
 * the type system has already accepted a
 * non-undefined result type via `agreedResultType`.
 */
function resolveAndRecordCall(
  term: FunctionCall,
  varTypes: Map<string, PrimitiveType>,
  types: Map<string, (PrimitiveType | undefined)[]>,
  functionOverloads: Map<FunctionCall, Overload>,
): void {
  const argTypes = term.args.map((a) => inferTermType(a, varTypes, types));
  const r = resolveCall(term.name, argTypes);
  if (r.error) raiseResolutionError(term, r.error);
  if (r.overload) functionOverloads.set(term, r.overload);
}

function raiseResolutionError(term: FunctionCall, err: ResolutionError): never {
  const cst = term.$cstNode;
  if (err.kind === "no-match") {
    // Find the first argument whose type isn't accepted by any
    // arity-matching overload. The "accepted set" for position i is
    // the union of params[i] across overloads, expanded by integer
    // when float is permitted (integer → float promotion).
    for (let i = 0; i < err.argTypes.length; i++) {
      const a = err.argTypes[i];
      if (!a) continue;
      const accepted = new Set<PrimitiveType>();
      for (const o of err.overloads) {
        const p = o.params[i]!;
        accepted.add(p);
        if (p === "float") accepted.add("integer");
      }
      if (accepted.has(a)) continue;
      const acceptedList = [...accepted].sort().join(" or ");
      throw new AnalyzerError(
        `Function '${term.name}' expects argument ${i + 1} to have type ${acceptedList}; got '${a}'`,
        cst?.offset,
        cst?.end,
      );
    }
    // Fallback when no single argument is the unique culprit (e.g. a
    // multi-arg combination not covered by any overload). Show the
    // candidate list so the user can spot which overload they meant.
    const argList = err.argTypes.map((t) => t ?? "?").join(", ");
    const overloadList = err.overloads
      .map((o) => `${term.name}(${o.params.join(", ")})`)
      .join(", ");
    throw new AnalyzerError(
      `Function '${term.name}' has no overload matching argument types (${argList}); known overloads: ${overloadList}`,
      cst?.offset,
      cst?.end,
    );
  }
  if (err.kind === "ambiguous") {
    const argList = err.argTypes.map((t) => t ?? "?").join(", ");
    const candidateList = err.candidates
      .map((o) => `${term.name}(${o.params.join(", ")})`)
      .join(", ");
    throw new AnalyzerError(
      `Function '${term.name}' call with argument types (${argList}) is ambiguous between: ${candidateList}`,
      cst?.offset,
      cst?.end,
    );
  }
  // unknown-name and arity-mismatch are caught by the analyzer's
  // pre-typing pass; reaching here would be a bug.
  throw new AnalyzerError(
    `Internal error: unexpected resolution error '${err.kind}' for function '${term.name}'`,
    cst?.offset,
    cst?.end,
  );
}

function checkRangeExprTypes(
  range: RangeAtom,
  body: readonly BodyElement[],
  varTypes: Map<string, PrimitiveType>,
  types: Map<string, (PrimitiveType | undefined)[]>,
): void {
  const lowType = inferTermType(range.low, varTypes, types);
  const highType = inferTermType(range.high, varTypes, types);
  const exprType = inferTermType(range.expr, varTypes, types);

  if (lowType && !isNumericType(lowType)) {
    const cst = range.low.$cstNode;
    throw new AnalyzerError(
      `Range lower bound has non-numeric type '${lowType}'`,
      cst?.offset,
      cst?.end,
    );
  }
  if (highType && !isNumericType(highType)) {
    const cst = range.high.$cstNode;
    throw new AnalyzerError(
      `Range upper bound has non-numeric type '${highType}'`,
      cst?.offset,
      cst?.end,
    );
  }
  if (exprType && !isNumericType(exprType)) {
    const cst = range.expr.$cstNode;
    throw new AnalyzerError(
      `Range expression has non-numeric type '${exprType}'`,
      cst?.offset,
      cst?.end,
    );
  }
  // Per the spec, binding ranges enumerate integers. When the LHS is a
  // bare variable *and* nothing else in the rule body binds it, this
  // range is the variable's only source — the translator can only
  // synthesise an integer series, so float-typed bounds would surface
  // downstream as an "Unbound variable" crash. Reject that here with a
  // position-bearing error. Filter ranges (LHS already bound elsewhere,
  // or LHS a complex expression) are still allowed to have float bounds.
  if (range.expr.$type === "Variable" && !isBoundElsewhere(range, range.expr.name, body)) {
    if (lowType && lowType !== "integer") {
      const cst = range.low.$cstNode;
      throw new AnalyzerError(
        `Binding range '${range.expr.name} in [...]' requires integer bounds; got '${lowType}' for the lower bound`,
        cst?.offset,
        cst?.end,
      );
    }
    if (highType && highType !== "integer") {
      const cst = range.high.$cstNode;
      throw new AnalyzerError(
        `Binding range '${range.expr.name} in [...]' requires integer bounds; got '${highType}' for the upper bound`,
        cst?.offset,
        cst?.end,
      );
    }
  }
}

/**
 * True if `name` is bound by something other than `self` in `rule`'s body: a
 * positive atom's Variable arg, a binding side of an equality, or an *earlier*
 * RangeAtom. Used to decide whether a range is the sole binding site for its
 * expr variable (a binding range, which the translator can only synthesise
 * over integers) or an additional constraint on a variable already bound
 * elsewhere (a filter range, where float bounds are fine).
 *
 * Two subtleties, both of which produced a backend divergence when got wrong,
 * because a range wrongly judged a filter keeps float bounds and then has
 * nothing to enumerate:
 *
 * - The equality side defers to `equalityBindingCandidates`, so `X = X` does
 *   not count. A side can only ground the variable if the *other* side does
 *   not mention it.
 * - Only ranges *before* `self` count. Two ranges over one variable would
 *   otherwise each defer to the other and neither would be the binder. Source
 *   order makes the first one the binder, which is the order the translator
 *   and the planner bind them in anyway.
 */
function isBoundElsewhere(self: RangeAtom, name: string, body: readonly BodyElement[]): boolean {
  let beforeSelf = true;
  for (const elem of body) {
    if (elem === self) {
      beforeSelf = false;
      continue;
    }
    if (elem.$type === "Literal" && !elem.negated) {
      for (const arg of elem.args) {
        if (arg.$type === "Variable" && arg.name === name) return true;
      }
    } else if (elem.$type === "Equality") {
      if (equalityBindingCandidates(elem).some((c) => c.variable === name)) return true;
    } else if (elem.$type === "RangeAtom" && elem.expr.$type === "Variable") {
      if (beforeSelf && elem.expr.name === name) return true;
    }
  }
  return false;
}

/** Infer the type of a term expression given variable types and predicate column types. */
export function inferTermType(
  term: HeadTerm,
  varTypes: Map<string, PrimitiveType>,
  types: ReadonlyMap<string, ReadonlyArray<PrimitiveType | undefined>>,
): PrimitiveType | undefined {
  switch (term.$type) {
    case "StringLiteral":
      return "string";
    case "NumberLiteral":
      return isFloatLiteral(term) || !Number.isInteger(term.value) ? "float" : "integer";
    case "BooleanLiteral":
      return "boolean";
    case "NullLiteral":
      // Polymorphic: null doesn't anchor a type. Treated by downstream
      // checks the same way as a variable whose type couldn't yet be
      // inferred — it composes with anything via `=`/`<>`, propagates
      // through arithmetic and other comparisons, and (per §5.4) makes
      // its expression NULL at runtime.
      return undefined;
    case "Variable":
      return varTypes.get(term.name);
    case "BinaryExpr": {
      if (term.op === "&&" || term.op === "||") return "boolean";
      if (COMPARISON_OPS.has(term.op)) return "boolean";
      // Bitwise / shift ops always yield an integer (32-bit signed),
      // regardless of whether an operand is an unresolved null.
      if (BITWISE_OPS.has(term.op)) return "integer";
      // Exponentiation is always float (like the `power` builtin it
      // replaces), even for integer operands: `2 ** 3` is `8.0`.
      if (term.op === "**") return "float";
      const leftType = inferTermType(term.left, varTypes, types);
      const rightType = inferTermType(term.right, varTypes, types);
      if (term.op === "+" && (leftType === "string" || rightType === "string")) {
        return "string";
      }
      return numericResultType(leftType, rightType, term.op);
    }
    case "UnaryExpr":
      if (term.op === "!") return "boolean";
      return inferTermType(term.operand, varTypes, types);
    case "FunctionCall":
      return inferCallType(term.name, term.args, varTypes, types);
    case "AggregateCall":
      return inferAggregateType(term.func, term.arg, varTypes, types);
    case "Subscript": {
      const objType = inferTermType(term.object, varTypes, types);
      if (!objType) return undefined;
      return objType === "value" ? "value" : "string";
    }
    case "Slice": {
      const objType = inferTermType(term.object, varTypes, types);
      if (!objType) return undefined;
      return objType === "value" ? "value" : "string";
    }
    case "ArrayLiteral":
    case "ObjectLiteral":
      return "value";
  }
}

/**
 * Return type of a built-in function call. Defers to the overload
 * registry: `resolveCall` returns a `resultType` whenever every viable
 * overload agrees on it (so single-overload built-ins resolve eagerly,
 * and multi-overload sets converge once arg types narrow).
 */
function inferCallType(
  name: string,
  args: HeadTerm[],
  varTypes: Map<string, PrimitiveType>,
  types: ReadonlyMap<string, ReadonlyArray<PrimitiveType | undefined>>,
): PrimitiveType | undefined {
  const argTypes = args.map((a) => inferTermType(a, varTypes, types));
  return resolveCall(name, argTypes).resultType;
}

/** Return type of an aggregate function call. */
function inferAggregateType(
  func: string,
  arg: HeadTerm,
  varTypes: Map<string, PrimitiveType>,
  types: ReadonlyMap<string, ReadonlyArray<PrimitiveType | undefined>>,
): PrimitiveType | undefined {
  switch (func) {
    case "count":
      return "integer";
    case "sum": {
      const argType = inferTermType(arg, varTypes, types);
      return argType === "float" ? "float" : "integer";
    }
    case "avg":
      return "float";
    case "min":
    case "max":
      return inferTermType(arg, varTypes, types);
    case "concat":
      return "string";
    case "list":
      return "value";
    default:
      return undefined;
  }
}

/** Determine the result type of an arithmetic operation. */
function numericResultType(
  left: PrimitiveType | undefined,
  right: PrimitiveType | undefined,
  op: string,
): PrimitiveType | undefined {
  if (op === "/" || op === "%") {
    if (left === "float" || right === "float") return "float";
    if (left === "integer" && right === "integer") return "integer";
    return left ?? right;
  }
  if (left === "float" || right === "float") return "float";
  if (left === "integer" || right === "integer") return "integer";
  return left ?? right;
}

/**
 * Join two types across multiple rules: widen `integer`/`float` to `float`,
 * leave same-type joins unchanged, and return `null` on any other pair
 * (e.g. `integer` and `string`, or `boolean` and `float`). Callers that work
 * across rule heads turn a `null` into an `AnalyzerError`; callers inside
 * range-bound inference pass it through as "unknown" and let the separate
 * range-bound validation report the mismatch with its own location.
 */
function joinTypes(a: PrimitiveType | undefined, b: PrimitiveType): PrimitiveType | null {
  if (!a) return b;
  if (a === b) return a;
  if ((a === "float" && b === "integer") || (a === "integer" && b === "float")) return "float";
  return null;
}

/**
 * Like `joinTypes`, but additionally accepts a primitive ↔ value
 * pair by lifting the primitive side to `value`. Used at every site
 * where an expression appears in a position that demands a specific
 * type (atom args, equalities, comparisons, function args, iteration
 * sources, IDB column unification): a `string` / `integer` / `float` /
 * `boolean` can stand in for a `value` slot, and the translator emits
 * the appropriate `dialect.toJson` lift at SQL-generation time.
 *
 * `joinTypes` itself is left strict so arithmetic and range-bound
 * type rules don't silently accept nonsense like `5 + value`.
 */
function joinTypesWithJsonLift(
  a: PrimitiveType | undefined,
  b: PrimitiveType,
): PrimitiveType | null {
  const direct = joinTypes(a, b);
  if (direct !== null) return direct;
  if (a === "value" && b !== "value") return "value";
  if (b === "value" && a !== undefined && a !== "value") return "value";
  return null;
}

/**
 * Meet (greatest lower bound) of two column types: the type of a variable
 * that has to be a valid value in *both* positions it occupies. `undefined`
 * means "no constraint yet" and is the identity. `integer`/`float` narrow to
 * `integer`; a primitive shared with `value` narrows to the primitive;
 * same-type is a no-op; two incompatible primitives (e.g. `integer`/`string`)
 * have no common lower bound and return `null` (⊥), which callers turn into a
 * conflicting-types error. This is the opposite direction to `joinTypes*`
 * (least upper bound), which is used where a column collects values from
 * several producing rules.
 */
export function meetTypes(a: PrimitiveType | undefined, b: PrimitiveType): PrimitiveType | null {
  if (!a) return b;
  if (a === b) return a;
  if ((a === "float" && b === "integer") || (a === "integer" && b === "float")) return "integer";
  if (a === "value") return b;
  if (b === "value") return a;
  return null;
}

/**
 * Whether an inferred column type satisfies a declared one at a module boundary
 * or head annotation. This is a directional subtype check: `declared` must equal
 * or widen `inferred`, i.e. widening `inferred` towards `declared` lands exactly
 * on `declared`. So `integer` fits a declared `value` or `float`, but a `value`
 * column does *not* satisfy a declared `integer` (that would let a declaration
 * promise more than the program proves). Widening follows `joinTypesWithJsonLift`
 * (integer/float interchange and the primitive/value lift).
 */
export function columnTypesCompatible(inferred: PrimitiveType, declared: PrimitiveType): boolean {
  return joinTypesWithJsonLift(inferred, declared) === declared;
}

/**
 * Published column types: what each predicate advertises to *consumers*. Starts
 * from the inferred types and widens each position by any head annotations on it
 * (the join of the inferred type and every rule's declared type there).
 * Consumers are checked against these; a predicate's own body sees its inferred
 * types (see `contextForPredicate`). Codegen uses the inferred types, so this
 * never reaches SQL — it only documents intended generality to callers.
 */
function computePublishedTypes(
  analyzed: AnalyzedProgram,
  inferred: Map<string, (PrimitiveType | undefined)[]>,
): Map<string, (PrimitiveType | undefined)[]> {
  const published = new Map<string, (PrimitiveType | undefined)[]>();
  for (const [pred, cols] of inferred) published.set(pred, [...cols]);
  for (const [pred, rules] of analyzed.rules) {
    const cols = published.get(pred);
    if (!cols) continue;
    for (const rule of rules) {
      const argTypes = rule.head.argTypes;
      if (argTypes === undefined) continue;
      for (let i = 0; i < argTypes.length; i++) {
        const declared = argTypes[i]?.type as PrimitiveType | undefined;
        if (declared !== undefined) cols[i] = unifyColumnType(cols[i], declared);
      }
    }
  }
  return published;
}

/**
 * The type environment for validating and guarantee-checking the rules of
 * `pred`: references to *other* predicates resolve to published types (their
 * advertised contract), while `pred`'s own recursive references resolve to its
 * inferred types (reality). Using the published type for a predicate's own body
 * would let a deliberately-wide declaration reject the very body that produced
 * it — a `value`-declared recursive predicate could not do arithmetic on itself.
 */
function contextForPredicate(
  pred: string,
  inferred: Map<string, (PrimitiveType | undefined)[]>,
  published: Map<string, (PrimitiveType | undefined)[]>,
): Map<string, (PrimitiveType | undefined)[]> {
  const ctx = new Map(published);
  const inf = inferred.get(pred);
  if (inf) ctx.set(pred, inf);
  return ctx;
}

/**
 * Validate optional head type annotations against inference.
 *
 * Annotations are per rule and per argument: a rule may annotate any subset of
 * its head arguments, and sibling rules of the same predicate may annotate
 * differently or omit annotations entirely. Each annotated position is checked
 * against that rule's own inferred contribution — the declared type must equal
 * or widen it (annotate `value` to document looseness; a type narrower than the
 * rule produces is rejected). The contribution is computed under the same
 * assume-guarantee context as validation (callees contribute their published
 * type, `pred`'s own references their inferred type). Checked only; annotations
 * do not drive codegen.
 *
 * The `?` half is checked the same way and in the same direction: a `?` on a
 * provably non-null position is allowed and documents looseness, while omitting
 * it where the rule can produce a NULL is rejected. Nullness is per rule too,
 * so the contribution read here is the rule's own, not the joined column.
 */
function checkHeadAnnotations(
  analyzed: AnalyzedProgram,
  inferred: Map<string, (PrimitiveType | undefined)[]>,
  published: Map<string, (PrimitiveType | undefined)[]>,
  nullness: NullnessInfo,
): void {
  for (const [pred, rules] of analyzed.rules) {
    const types = contextForPredicate(pred, inferred, published);
    for (const rule of rules) {
      const argTypes = rule.head.argTypes;
      if (argTypes === undefined) continue;
      const varTypes = rebuildVarTypes(rule.body, types);
      const argNullness = nullness.headArgNullness.get(rule);
      for (let i = 0; i < rule.head.args.length; i++) {
        const annotation = argTypes[i];
        if (annotation === undefined) continue; // this position is unannotated in this rule
        const declared = annotation.type as PrimitiveType;
        const cst = rule.head.args[i]!.$cstNode ?? rule.head.$cstNode;
        const inferredType = inferTermType(rule.head.args[i]!, varTypes, types);
        // An unconstrained type is reported by the finalize step; skip the type
        // half here but still check the nullness half, which does not need it.
        if (inferredType !== undefined && !columnTypesCompatible(inferredType, declared)) {
          throw new AnalyzerError(
            `Predicate '${pred}' column ${i + 1} is annotated '${declared}' but inferred as '${inferredType}'`,
            cst?.offset,
            cst?.end,
          );
        }
        if (argNullness?.[i] === true && !annotation.nullable) {
          throw new AnalyzerError(
            `Predicate '${pred}' column ${i + 1} is annotated '${declared}' but this rule can produce NULL; annotate '${declared}?'`,
            cst?.offset,
            cst?.end,
          );
        }
      }
    }
  }
}

/**
 * Widen `current` with `next` where several rule heads (or facts) stack onto
 * the same IDB column: the total least-upper-bound join. Unlike the within-rule
 * meet, this never fails. Two incompatible primitives (e.g. `string` and
 * `integer`) widen to `value`, their true least upper bound, since a column fed
 * a string by one rule and an integer by another holds both as JSON; the
 * primitive branches lift via the translator's `to_jsonb`/`json_quote`.
 * `integer`/`float` still widen to `float`, not `value`.
 */
function unifyColumnType(current: PrimitiveType | undefined, next: PrimitiveType): PrimitiveType {
  return joinTypesWithJsonLift(current, next) ?? "value";
}
