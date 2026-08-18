import {
  type AggregateCall,
  BITWISE_OPS,
  BUILTINS,
  BUILTIN_BODY_ATOMS,
  BUILTIN_KEYS,
  type BitwiseOp,
  type BodyElement,
  COMPARISON_OPS,
  EQUALITY_OPS,
  type Equality,
  type Expression,
  type Filter,
  type FunctionCall,
  type HeadAtom,
  type HeadTerm,
  type Literal,
  type NullnessContext,
  type NumberLiteral,
  ORDERING_OPS,
  type Overload,
  type PrimitiveType,
  type Query,
  type Rule,
  type TypedProgram,
  type Variable,
  containsAggregate,
  isGroupingArg,
  literalBindings,
} from "datamog-core";
import {
  AnalyzerError,
  assertNever,
  allVarsBound as coreAllVarsBound,
  chooseEqualityBinding as coreChooseEqualityBinding,
  inferTermType,
  mayBeNull,
  meetTypes,
  queryProjection,
  rebuildVarTypes,
} from "datamog-core";
import { type SqlDialect, colList, emptyAnchor, ident, sqlTypeFor } from "./dialect.ts";

export interface SqlSpan {
  /** Offset of the SQL fragment within the containing statement. */
  sqlStart: number;
  sqlEnd: number;
  /** Offset of the source AST node this fragment was generated from. */
  astStart: number;
  astEnd: number;
}

export interface TranslationResult {
  createTables: string[];
  createViews: string[];
  queries: string[];
  /** Predicate defined by each entry in `createViews` (same length / indexing). */
  viewPredicates: string[];
  /** Predicate queried by each entry in `queries` (same length / indexing). */
  queryPredicates: string[];
  /** For each `createViews[i]`, AST-to-SQL span mappings used for hover linking. */
  viewSpans: SqlSpan[][];
  /** For each `queries[i]`, AST-to-SQL span mappings used for hover linking. */
  querySpans: SqlSpan[][];
  /**
   * For each `queries[i]`, the declared `PrimitiveType` of every result-row
   * column. Keys match the `AS <alias>` names emitted in the SELECT
   * (or the underlying predicate's column names when the SELECT is a
   * `*`). Used by the executor to coerce backend-specific value
   * representations back to a uniform shape — most importantly,
   * SQLite's 0/1 booleans into JS true/false.
   */
  queryColumnTypes: Record<string, PrimitiveType>[];
  /**
   * One SELECT per integrity constraint (`analyzed.constraints`, same
   * length / indexing). Translated exactly like a query; the executor runs
   * these before any query and treats returned rows as counterexamples.
   */
  constraints: string[];
  /** For each `constraints[i]`, the result-row column types (see `queryColumnTypes`). */
  constraintColumnTypes: Record<string, PrimitiveType>[];
}

export function translate(analyzed: TypedProgram, dialect: SqlDialect): TranslationResult {
  try {
    return translateImpl(analyzed, dialect);
  } catch (e) {
    if (e instanceof AnalyzerError) e.file ??= analyzed.sourceFile;
    throw e;
  }
}

function translateImpl(analyzed: TypedProgram, dialect: SqlDialect): TranslationResult {
  const createTables = translateTables(analyzed, dialect);
  const viewResult = translateViews(analyzed, dialect);
  const queryResult = translateQueries(analyzed, dialect, analyzed.queries);
  const constraintResult = translateQueries(analyzed, dialect, analyzed.constraints);
  const viewStripped = viewResult.sql.map(stripSpanMarks);
  const queryStripped = queryResult.sql.map(stripSpanMarks);
  return {
    createTables,
    createViews: viewStripped.map((v) => v.sql),
    queries: queryStripped.map((q) => q.sql),
    viewPredicates: viewResult.predicates,
    queryPredicates: queryResult.predicates,
    viewSpans: viewStripped.map((v) => v.spans),
    querySpans: queryStripped.map((q) => q.spans),
    queryColumnTypes: queryResult.columnTypes,
    constraints: constraintResult.sql.map((s) => stripSpanMarks(s).sql),
    constraintColumnTypes: constraintResult.columnTypes,
  };
}

// --- Span markers ---
//
// To link a generated SQL fragment to the Datalog AST node that produced it,
// we wrap the fragment with control-character markers: `\u0001<start>,<end>\u0001`
// opens a span covering the given AST offset range, `\u0002` closes the
// innermost open span. Markers survive string concatenation unchanged, so
// dialect wrappers (createView, createRecursiveView, ...) don't need to know
// about them. After translation we strip markers from each statement and
// emit the resulting `SqlSpan[]` alongside the clean SQL.

const MARK_START = "\u0001";
const MARK_END = "\u0002";

function markSpan(
  node: { $cstNode?: { offset: number; end: number } } | undefined,
  sql: string,
): string {
  const cst = node?.$cstNode;
  if (!cst) return sql;
  return `${MARK_START}${cst.offset},${cst.end}${MARK_START}${sql}${MARK_END}`;
}

function stripSpanMarks(marked: string): { sql: string; spans: SqlSpan[] } {
  const spans: SqlSpan[] = [];
  const stack: { astStart: number; astEnd: number; sqlStart: number }[] = [];
  let out = "";
  let i = 0;
  // Track whether the cursor sits inside a SQL string literal (`'...'`,
  // with `''` for an embedded quote) or a double-quoted identifier
  // (`"..."`, with `""` for an embedded quote). User-supplied string
  // values and quoted identifiers (predicate / column names) can contain
  // arbitrary bytes, including the very U+0001 / U+0002 chars we use as
  // markers — without this guard, two stray U+0001s look like a span
  // header and the stripper eats the SQL between them. Markers inside a
  // string or identifier are always user data, so we pass them through
  // verbatim. The translator never emits a U+0001 outside a string /
  // identifier except as a real marker, so the outside branch is
  // unambiguous. Tracking identifiers matters because a quoted name with
  // a single quote — `"o'brien"` — would otherwise flip `inString` and
  // desync the stripper.
  let inString = false;
  let inIdent = false;
  while (i < marked.length) {
    const c = marked[i]!;
    if (c === "'" && !inIdent) {
      out += c;
      // `''` inside a string is a quoted single quote; consume both.
      if (inString && marked[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      inString = !inString;
      i++;
      continue;
    }
    if (c === '"' && !inString) {
      out += c;
      // `""` inside an identifier is a quoted double quote; consume both.
      if (inIdent && marked[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      inIdent = !inIdent;
      i++;
      continue;
    }
    if (inString || inIdent) {
      out += c;
      i++;
      continue;
    }
    if (c === MARK_START) {
      const close = marked.indexOf(MARK_START, i + 1);
      if (close === -1) break;
      const [aStr, bStr] = marked.slice(i + 1, close).split(",");
      const a = Number(aStr);
      const b = Number(bStr);
      stack.push({ astStart: a, astEnd: b, sqlStart: out.length });
      i = close + 1;
    } else if (c === MARK_END) {
      const frame = stack.pop();
      if (frame) {
        spans.push({
          sqlStart: frame.sqlStart,
          sqlEnd: out.length,
          astStart: frame.astStart,
          astEnd: frame.astEnd,
        });
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return { sql: out, spans };
}

// --- Tables ---

function translateTables(analyzed: TypedProgram, dialect: SqlDialect): string[] {
  const tables: string[] = [];
  for (const decl of analyzed.extDecls.values()) {
    const cols = decl.columns.map((c) => {
      const nullable = (c as { nullable?: boolean }).nullable;
      // An unannotated column defaults to `string` (parseRaw already sets this).
      return `  ${ident(c.name)} ${sqlTypeFor(dialect, c.type ?? "string")}${nullable ? "" : " NOT NULL"}`;
    });
    tables.push(`CREATE TABLE IF NOT EXISTS ${ident(decl.predicate)} (\n${cols.join(",\n")}\n);`);
  }
  return tables;
}

// --- Views ---

function translateViews(
  analyzed: TypedProgram,
  dialect: SqlDialect,
): { sql: string[]; predicates: string[] } {
  const sql: string[] = [];
  const predicates: string[] = [];
  for (const stratum of analyzed.sortedStrata) {
    const isRecursive = analyzed.recursivePredicates.has(stratum[0]!);

    // Parity-stratified recursion needs an alternating fixed point: an outer
    // loop that rebuilds a relation from empty between rounds. `WITH
    // RECURSIVE` computes one least fixed point of a monotone body and cannot
    // delete, so no SQL dialect can express it. A stratum with only one
    // polarity has nothing to alternate against (the sigil is inert), so it
    // compiles as usual. See doc/design/parity-stratification.md §7.
    const maximal = stratum.filter((p) => analyzed.maximalPredicates.has(p));
    if (maximal.length > 0 && maximal.length < stratum.length) {
      const predList = maximal.map((p) => `'${p}^'`).join(", ");
      const cst = analyzed.rules.get(maximal[0]!)?.[0]?.head.$cstNode;
      throw new AnalyzerError(
        `Parity-stratified recursion is not supported by ${dialect.name}: ${maximal.length > 1 ? "predicates" : "predicate"} ${predList} ${maximal.length > 1 ? "are" : "is"} maximal, which needs an alternating fixed point. Use --backend native or --backend seminaive`,
        cst?.offset,
        cst?.end,
      );
    }

    if (
      isRecursive &&
      !dialect.supportsNonLinearRecursion &&
      analyzed.nonLinearPredicates.has(stratum[0]!)
    ) {
      const preds = stratum.filter((p) => analyzed.nonLinearPredicates.has(p));
      const predList = preds.map((p) => `'${p}'`).join(", ");
      // Point the error at the first non-linear-recursive rule we can
      // find — the rule whose body has more than one atom referencing
      // a stratum predicate. Without this, the playground lint
      // squiggly defaults to byte 0.
      const stratumSet = new Set(stratum);
      let cst: { offset: number; end: number } | undefined;
      for (const p of preds) {
        const rule = analyzed.rules.get(p)?.find((r) => {
          let recBody = 0;
          for (const elem of r.body) {
            if (elem.$type === "Literal" && !elem.negated && stratumSet.has(elem.predicate)) {
              recBody++;
            }
          }
          return recBody > 1;
        });
        if (rule?.$cstNode) {
          cst = { offset: rule.$cstNode.offset, end: rule.$cstNode.end };
          break;
        }
      }
      throw new AnalyzerError(
        `Non-linear recursion is not supported by ${dialect.name}: ${stratum.length > 1 ? "predicates" : "predicate"} ${predList} ${preds.length > 1 ? "have" : "has"} rules with multiple recursive body atoms`,
        cst?.offset,
        cst?.end,
      );
    }

    if (!isRecursive) {
      const predicate = stratum[0]!;
      const rules = analyzed.rules.get(predicate)!;
      // `UNION` already dedups two or more rules, but a single rule is a lone
      // SELECT that does not: a rule projecting away a body variable would
      // leave the view a bag, so an aggregate reading it over-counts. Emit
      // `SELECT DISTINCT` for the single-rule case so every IDB view is a set.
      const distinct = rules.length === 1;
      const ruleQueries = rules.map((rule) =>
        translateRule(rule, analyzed, undefined, undefined, dialect, distinct),
      );
      const unionBody = ruleQueries.join("\n  UNION\n");
      sql.push(dialect.createView(predicate, unionBody));
      predicates.push(predicate);
    } else if (stratum.length === 1) {
      const predicate = stratum[0]!;
      const rules = analyzed.rules.get(predicate)!;
      const arity = analyzed.arities.get(predicate)!;
      // SQLite's WITH RECURSIVE requires non-recursive anchor terms to appear
      // before recursive terms in the UNION. Sort by whether the rule
      // references the predicate. Postgres is order-insensitive, so sorting
      // is safe for it too.
      const ordered = [...rules].sort((a, b) => {
        const aRec = isSelfRecursive(a, predicate) ? 1 : 0;
        const bRec = isSelfRecursive(b, predicate) ? 1 : 0;
        return aRec - bRec;
      });
      const recursive = ordered.filter((r) => isSelfRecursive(r, predicate));
      // Postgres allows one recursive term holding one reference to the CTE, so
      // two recursive rules cannot both name it. Hand them to the dialect to
      // fold into a single term, translated against a shared alias rather than
      // a FROM entry each. Dialects that accept the flat union skip this.
      const foldRecursive = dialect.singleRecursiveTerm !== undefined && recursive.length > 1;
      const ruleQueries = foldRecursive
        ? ordered
            .filter((r) => !isSelfRecursive(r, predicate))
            .map((rule) => translateRule(rule, analyzed, undefined, undefined, dialect))
        : ordered.map((rule) => translateRule(rule, analyzed, undefined, undefined, dialect));
      // Every rule for this predicate is self-recursive — its least
      // fixed point is the empty relation, but SQL engines reject a
      // `WITH RECURSIVE` CTE with no anchor branch ("circular
      // reference" on SQLite, similar on Postgres). Prepend a
      // typed empty anchor so the CTE compiles and evaluates to zero
      // rows.
      if (ordered.every((r) => isSelfRecursive(r, predicate))) {
        ruleQueries.unshift(emptyAnchor(arity, analyzed.columnTypes.get(predicate)!, dialect));
      }
      if (foldRecursive && dialect.singleRecursiveTerm) {
        const selfAlias = "__rec";
        const branches = recursive.map((rule) =>
          translateRule(rule, analyzed, undefined, undefined, dialect, false, {
            predicate,
            alias: selfAlias,
          }),
        );
        ruleQueries.push(dialect.singleRecursiveTerm(predicate, selfAlias, branches));
      }
      const unionBody = ruleQueries.join("\n  UNION\n");
      const colNames = colList(arity);
      sql.push(dialect.createRecursiveView(predicate, colNames, unionBody));
      predicates.push(predicate);
    } else {
      const ruleTranslator = (
        rule: Rule,
        renameMap?: Map<string, string>,
        tagMap?: Map<string, string>,
        selfRef?: { predicate: string; alias: string },
      ) => translateRule(rule, analyzed, renameMap, tagMap, dialect, false, selfRef);

      const mutualViews = dialect.createMutuallyRecursiveViews(
        stratum,
        analyzed.arities,
        analyzed.rules,
        analyzed,
        ruleTranslator,
      );
      // createMutuallyRecursiveViews returns one view per stratum predicate,
      // in stratum order.
      sql.push(...mutualViews);
      predicates.push(...stratum);
    }
  }
  return { sql, predicates };
}

/** Variable binding: either a column reference or an SQL expression (from equality). */
type Binding =
  | { kind: "col"; alias: string; col: string; type: PrimitiveType | undefined }
  | { kind: "expr"; sql: string; type: PrimitiveType | undefined };

/**
 * Translate a single rule to a SQL SELECT statement.
 * @param renameMap - Optional map from predicate name to table/CTE name (for SQLite mutual recursion)
 * @param tagMap - Optional map from predicate name to tag value (for SQLite combined CTE discrimination)
 * @param dialect - SQL dialect for dialect-specific expressions
 * @param distinct - Emit `SELECT DISTINCT`
 * @param selfRef - Bind this predicate's atom to an alias the caller supplies
 *   from an enclosing query, rather than giving it a `FROM` entry here. Used
 *   for the `LATERAL` recursive term (see `SqlDialect.singleRecursiveTerm`);
 *   linear recursion means there is at most one such atom per rule.
 */
function translateRule(
  rule: Rule,
  analyzed: TypedProgram,
  renameMap: Map<string, string> | undefined,
  tagMap: Map<string, string> | undefined,
  dialect: SqlDialect,
  distinct = false,
  selfRef?: { predicate: string; alias: string },
): string {
  if (rule.body.length === 0) {
    // A fact is a single constant row and cannot duplicate, so `distinct`
    // never matters here.
    return translateFact(rule, analyzed, dialect);
  }

  // Variables this body proves non-null, and enough context to ask the same
  // question of a whole expression. Both feed the choice between the plain and
  // the null-aware equality below. A body with no entry (a synthetic rule the
  // analysis never saw) reads as "nothing proven", which keeps the null-aware
  // form.
  const nonNullVars = analyzed.nullness.nonNullVars.get(rule.body) ?? new Set<string>();

  // Categorize body elements and register bindings. Positive atoms are
  // processed first so ranges and equalities can reference variables bound by
  // atoms appearing later in the rule body (safety is order-independent).
  const positiveAtoms: { atom: Literal; index: number }[] = [];
  const negatedAtoms: { atom: Literal }[] = [];
  const filters: Filter[] = [];
  // Equalities that cannot bind a bare variable from a ready expression
  // become null-aware constraints.
  const equalityConstraints: Equality[] = [];
  const bindingRanges: {
    alias: string;
    lowSql: string;
    highSql: string;
    node: BodyElement;
  }[] = [];
  const filterRanges: {
    exprSql: string;
    lowSql: string;
    highSql: string;
    node: BodyElement;
  }[] = [];
  // Built-in body atoms (object_entry / array_element). Like binding
  // ranges, they emit a FROM source and bind synthetic expressions to
  // their non-source argument variables; the source argument is an
  // arbitrary expression whose vars must already be safe — resolved
  // in the Pass 2 fixed-point.
  const builtinIters: {
    atom: Literal;
    fromSql: string;
    keySql: string;
    valueSql: string;
  }[] = [];

  // The atom the caller has already bound in an enclosing query: it still
  // supplies column references, but takes the caller's alias and contributes no
  // FROM entry here. Linear recursion guarantees at most one.
  const selfRefIndex = selfRef
    ? rule.body.findIndex(
        (e) => e.$type === "Literal" && !e.negated && e.predicate === selfRef.predicate,
      )
    : -1;
  const aliases = rule.body.map((_, i) =>
    selfRef && i === selfRefIndex ? selfRef.alias : `__b${i}`,
  );
  const bindings = new Map<string, Binding[]>();
  const varTypes = new Map<string, PrimitiveType>();
  const columnTypes = analyzed.columnTypes;
  const functionOverloads = analyzed.functionOverloads;
  let rangeCounter = 0;

  // Pass 1: register bindings from positive atoms (and collect negated atoms).
  for (let i = 0; i < rule.body.length; i++) {
    const elem = rule.body[i]!;
    if (elem.$type !== "Literal") continue;
    if (elem.negated) {
      negatedAtoms.push({ atom: elem });
      continue;
    }
    // Built-in body atoms are deferred to Pass 2 — they need the
    // source-argument expression's variables to all be bound before
    // they can fire, exactly like a binding range.
    if (BUILTIN_BODY_ATOMS.has(elem.predicate)) continue;
    const alias = aliases[i]!;
    const predTypes = columnTypes?.get(elem.predicate);
    for (let j = 0; j < elem.args.length; j++) {
      const term = elem.args[j]!;
      if (term.$type === "Variable") {
        const col = resolveColumnRef(elem.predicate, j, analyzed);
        const list = bindings.get(term.name) ?? [];
        const t = predTypes?.[j];
        list.push({ kind: "col", alias, col, type: t });
        bindings.set(term.name, list);
        // A variable in several atoms takes the meet of its column types
        // (mirrors `rebuildVarTypes`): it must be a valid value in each.
        if (t) {
          const met = meetTypes(varTypes.get(term.name), t);
          if (met) varTypes.set(term.name, met);
        }
      }
    }
    positiveAtoms.push({ atom: elem, index: i });
  }

  // Pass 2: ranges and equalities. Iterate to a fixed point so elements can
  // reference variables bound by later elements in source order (safety is
  // order-independent). As we bind a variable via equality or range, we also
  // propagate its type into varTypes so downstream ranges can decide whether
  // they qualify as integer binding ranges.
  const pending: number[] = [];
  for (let i = 0; i < rule.body.length; i++) {
    const elem = rule.body[i]!;
    if (elem.$type === "RangeAtom") {
      pending.push(i);
    } else if (elem.$type === "Equality") {
      // Equalities with a bare variable on either side may participate in
      // the fixed-point. Constraint-only forms are emitted later as `=`.
      if (elem.left.$type === "Variable" || elem.expr.$type === "Variable") {
        pending.push(i);
      } else {
        equalityConstraints.push(elem);
      }
    } else if (elem.$type === "Filter") {
      filters.push(elem);
    } else if (
      elem.$type === "Literal" &&
      !elem.negated &&
      BUILTIN_BODY_ATOMS.has(elem.predicate)
    ) {
      pending.push(i);
    }
  }

  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let p = 0; p < pending.length; ) {
      const elem = rule.body[pending[p]!]!;
      let processed = false;
      if (elem.$type === "Equality") {
        // Body equality is symmetric. Bind an unbound bare variable on
        // either side when the other side is ready; once both sides are
        // ready, emit a logical-equality constraint.
        const binding = chooseEqualityBinding(elem, bindings);
        if (binding) {
          const sql = termToSql(
            binding.expr,
            bindings,
            varTypes,
            columnTypes,
            functionOverloads,
            dialect,
          );
          const exprType = inferTermType(binding.expr, varTypes, columnTypes);
          const list = bindings.get(binding.variable) ?? [];
          list.push({ kind: "expr", sql, type: exprType });
          bindings.set(binding.variable, list);
          if (!varTypes.has(binding.variable)) {
            if (exprType) varTypes.set(binding.variable, exprType);
          }
          processed = true;
        } else if (allVarsBound(elem.left, bindings) && allVarsBound(elem.expr, bindings)) {
          equalityConstraints.push(elem);
          processed = true;
        }
      } else if (elem.$type === "Literal" && BUILTIN_BODY_ATOMS.has(elem.predicate)) {
        const spec = BUILTIN_BODY_ATOMS.get(elem.predicate)!;
        const sourceTerm = elem.args[spec.sourceArg]!;
        if (allVarsBound(sourceTerm, bindings)) {
          const alias = aliases[pending[p]!]!;
          const sourceSql = termToSql(
            sourceTerm,
            bindings,
            varTypes,
            columnTypes,
            functionOverloads,
            dialect,
          );
          const sourceType = inferTermType(sourceTerm, varTypes, columnTypes);
          const sourceValueSql = liftToJsonIfNeeded(
            sourceSql,
            sourceType,
            spec.sourceType,
            dialect,
          );
          const iter = dialect.jsonIterate(spec.kind, sourceValueSql, alias);
          // Bind the bound-arg Variables to the SQL expressions that
          // `dialect.jsonIterate` returns for the key and value
          // columns. The first bound position takes `keySql`, the
          // second `valueSql`. Each is registered as an `expr`
          // binding so the shared-variable join logic can compose
          // them with other appearances of the same variable.
          const slotSql = [iter.keySql, iter.valueSql];
          for (let k = 0; k < spec.boundArgs.length; k++) {
            const { index, type } = spec.boundArgs[k]!;
            const arg = elem.args[index]!;
            if (arg.$type === "Variable") {
              const list = bindings.get(arg.name) ?? [];
              list.push({ kind: "expr", sql: slotSql[k]!, type });
              bindings.set(arg.name, list);
              if (!varTypes.has(arg.name)) varTypes.set(arg.name, type);
            }
          }
          builtinIters.push({
            atom: elem,
            fromSql: iter.fromSql,
            keySql: iter.keySql,
            valueSql: iter.valueSql,
          });
          processed = true;
        }
      } else if (elem.$type === "RangeAtom") {
        const lowReady = allVarsBound(elem.low, bindings);
        const highReady = allVarsBound(elem.high, bindings);
        const freshVar =
          elem.expr.$type === "Variable" && !bindings.has(elem.expr.name) ? elem.expr : undefined;
        const exprReady = freshVar !== undefined || allVarsBound(elem.expr, bindings);
        if (lowReady && highReady && exprReady) {
          const lowSql = termToSql(
            elem.low,
            bindings,
            varTypes,
            columnTypes,
            functionOverloads,
            dialect,
          );
          const highSql = termToSql(
            elem.high,
            bindings,
            varTypes,
            columnTypes,
            functionOverloads,
            dialect,
          );
          if (
            freshVar !== undefined &&
            isIntegerTerm(elem.low, varTypes, columnTypes) &&
            isIntegerTerm(elem.high, varTypes, columnTypes)
          ) {
            const rangeAlias = `__range_${rangeCounter++}`;
            const list = bindings.get(freshVar.name) ?? [];
            list.push({ kind: "col", alias: rangeAlias, col: "value", type: "integer" });
            bindings.set(freshVar.name, list);
            if (!varTypes.has(freshVar.name)) {
              varTypes.set(freshVar.name, "integer");
            }
            bindingRanges.push({ alias: rangeAlias, lowSql, highSql, node: elem });
          } else {
            filterRanges.push({
              exprSql: termToSql(
                elem.expr,
                bindings,
                varTypes,
                columnTypes,
                functionOverloads,
                dialect,
              ),
              lowSql,
              highSql,
              node: elem,
            });
          }
          processed = true;
        }
      }
      if (processed) {
        pending.splice(p, 1);
        progress = true;
      } else {
        p++;
      }
    }
  }

  // Helper: resolve a binding to SQL
  function bindingToSql(b: Binding): string {
    return b.kind === "col" ? `${b.alias}.${ident(b.col)}` : b.sql;
  }

  // A variable shared across atoms takes the meet (narrowest) of its binding
  // types. The meet is the minimum of a compatible chain, so some binding
  // already has that exact type; make it `refs[0]` so every projection of the
  // variable (head, body expressions, join conditions all read `refs[0]`)
  // emits SQL of the variable's real type. Projecting a wider binding (e.g. a
  // `value` column for an `integer` variable) would need a downcast that
  // `liftToJsonIfNeeded` cannot express, producing a JSONB expression in a
  // primitive column and diverging across backends.
  for (const [name, refs] of bindings) {
    if (refs.length < 2) continue;
    const vt = varTypes.get(name);
    if (vt === undefined) continue;
    const idx = refs.findIndex((r) => r.type === vt);
    if (idx > 0) refs.unshift(refs.splice(idx, 1)[0]!);
  }

  // SELECT clause (with GROUP BY support for aggregate rules). `isGroupingArg`
  // is the shared definition of what groups; see `analyzer.ts`.
  const isAggregateRule = rule.head.args.some(containsAggregate);
  const literalBound = literalBindings(rule);
  const selectParts: string[] = [];
  const groupByExprs: string[] = [];

  for (let i = 0; i < rule.head.args.length; i++) {
    const term = rule.head.args[i]!;
    const targetCol = `col${i + 1}`;
    // If a sibling rule's head term contributed a `json` type at this
    // column position (via `unifyColumnType`'s primitive→json
    // promotion), this rule's primitive head term must be lifted so
    // every UNION branch produces matching SQL types.
    const headColType = columnTypes.get(rule.head.predicate)?.[i];
    if (containsAggregate(term)) {
      // No GROUP BY entry: an argument containing an aggregate is reduced
      // over the group rather than grouped by.
      const aggSql = termToSql(term, bindings, varTypes, columnTypes, functionOverloads, dialect);
      const expr = castIntegerForDialect(aggSql, headColType, dialect);
      selectParts.push(`${expr} AS ${targetCol}`);
    } else if (term.$type === "Variable") {
      const refs = bindings.get(term.name);
      if (!refs || refs.length === 0) {
        const cst = term.$cstNode;
        throw new AnalyzerError(
          `Unbound variable '${term.name}' in head of rule for '${rule.head.predicate}'`,
          cst?.offset,
          cst?.end,
        );
      }
      const first = refs[0]!;
      const rawExpr = bindingToSql(first);
      const varType = varTypes.get(term.name);
      const lifted = liftToJsonIfNeeded(rawExpr, varType, headColType, dialect);
      const expr = castIntegerForDialect(lifted, headColType, dialect);
      selectParts.push(`${expr} AS ${targetCol}`);
      if (isAggregateRule && isGroupingArg(term, literalBound)) {
        groupByExprs.push(expr);
      }
    } else {
      const rawExpr = termToSql(term, bindings, varTypes, columnTypes, functionOverloads, dialect);
      const termType = inferTermType(term, varTypes, columnTypes);
      const lifted = liftToJsonIfNeeded(rawExpr, termType, headColType, dialect);
      const expr = castIntegerForDialect(lifted, headColType, dialect);
      selectParts.push(`${expr} AS ${targetCol}`);
      if (isAggregateRule && isGroupingArg(term, literalBound)) {
        groupByExprs.push(expr);
      }
    }
  }

  // FROM clause: positive atoms + binding ranges. The self-reference, if the
  // caller took one, is already in scope and must not be named again.
  const fromParts = positiveAtoms
    .filter(({ index }) => index !== selfRefIndex)
    .map(({ atom, index }) =>
      markSpan(
        atom,
        `${ident(renameMap?.get(atom.predicate) ?? atom.predicate)} AS ${aliases[index]}`,
      ),
    );
  for (let r = 0; r < bindingRanges.length; r++) {
    const { alias, lowSql, highSql, node } = bindingRanges[r]!;
    fromParts.push(markSpan(node, dialect.rangeSource(alias, lowSql, highSql)));
  }
  for (const { atom, fromSql } of builtinIters) {
    fromParts.push(markSpan(atom, fromSql));
  }

  // WHERE conditions
  const conditions: string[] = [];

  // Nullness of an arbitrary expression under this body's refinements. Types
  // come from the same `varTypes` the SQL emission uses, so the two agree on
  // what an expression is.
  const nullCtx: NullnessContext = {
    overloads: functionOverloads,
    typeOf: (_owner, expr) => inferTermType(expr, varTypes, columnTypes),
  };
  const cannotBeNullHere = (term: HeadTerm): boolean =>
    !mayBeNull(term, nonNullVars, rule, nullCtx);

  // Join conditions from shared variables. A repeated variable means the
  // same equality the `=` operator does, so these are null-aware unless the
  // variable cannot be NULL, in which case the two forms agree and the plain
  // one keeps a hash join available. One non-null side is enough: a NULL on
  // the other side is false under both operators, `IS NOT DISTINCT FROM`
  // comparing it against a non-null value and a plain `=` yielding NULL for
  // the filter to drop. The refinement pass already sets a variable non-null
  // when any of its atom positions is a non-null column, so that condition is
  // exactly what `nonNullVars` answers. See doc/design/null.md §4 and §6, and
  // doc/design/nullness-tracking.md §1.
  for (const [name, refs] of bindings) {
    if (refs.length < 2) continue;
    const first = refs[0]!;
    const plainEq = nonNullVars.has(name);
    for (let i = 1; i < refs.length; i++) {
      const other = refs[i]!;
      conditions.push(
        sqlEqWithJsonLift(
          bindingToSql(first),
          first.type,
          bindingToSql(other),
          other.type,
          dialect,
          plainEq || isLiteralBinding(first) || isLiteralBinding(other),
        ),
      );
    }
  }

  // Range bound conditions (dialect-specific: empty for Postgres, present for SQLite)
  for (const { alias, lowSql, highSql, node } of bindingRanges) {
    for (const cond of dialect.rangeConditions(alias, lowSql, highSql)) {
      conditions.push(markSpan(node, cond));
    }
  }

  // Tag filter conditions for combined mutual-recursion CTE
  if (tagMap) {
    for (const { atom, index } of positiveAtoms) {
      const tag = tagMap.get(atom.predicate);
      if (tag) {
        conditions.push(`${aliases[index]}."__tag" = '${tag.replace(/'/g, "''")}'`);
      }
    }
  }

  // Non-variable argument conditions for positive atoms
  for (const { atom, index } of positiveAtoms) {
    const alias = aliases[index]!;
    for (let j = 0; j < atom.args.length; j++) {
      const term = atom.args[j]!;
      if (term.$type !== "Variable") {
        const col = resolveColumnRef(atom.predicate, j, analyzed);
        const expectedType = columnTypes.get(atom.predicate)?.[j];
        const termType = inferTermType(term, varTypes, columnTypes);
        const termSql = termToSql(
          term,
          bindings,
          varTypes,
          columnTypes,
          functionOverloads,
          dialect,
        );
        const lifted = liftToJsonIfNeeded(termSql, termType, expectedType, dialect);
        const colSql = `${alias}.${ident(col)}`;
        conditions.push(
          markSpan(
            atom,
            cannotBeNullHere(term) ? `${colSql} = ${lifted}` : dialect.logicalEq(colSql, lifted),
          ),
        );
      }
    }
  }

  // Non-Variable bound-position arguments on built-in body atoms become
  // equality constraints against the iteration's emitted key/value SQL.
  // Variable bound positions were already wired into `bindings` during
  // Pass 2, so they're handled by the shared-variable join logic above.
  for (const { atom, keySql, valueSql } of builtinIters) {
    const spec = BUILTIN_BODY_ATOMS.get(atom.predicate)!;
    const slotSql = [keySql, valueSql];
    for (let k = 0; k < spec.boundArgs.length; k++) {
      const { index, type: expectedType } = spec.boundArgs[k]!;
      const arg = atom.args[index]!;
      if (arg.$type === "Variable") continue;
      const termType = inferTermType(arg, varTypes, columnTypes);
      const termSql = termToSql(arg, bindings, varTypes, columnTypes, functionOverloads, dialect);
      const lifted = liftToJsonIfNeeded(termSql, termType, expectedType, dialect);
      const slot = slotSql[k]!;
      conditions.push(
        markSpan(
          atom,
          cannotBeNullHere(arg) ? `${slot} = ${lifted}` : dialect.logicalEq(slot, lifted),
        ),
      );
    }
  }

  // NOT EXISTS subqueries for negated atoms
  for (const { atom } of negatedAtoms) {
    const subConditions: string[] = [];
    for (let j = 0; j < atom.args.length; j++) {
      const term = atom.args[j]!;
      const col = resolveColumnRef(atom.predicate, j, analyzed);
      const expectedType = columnTypes.get(atom.predicate)?.[j];
      if (term.$type === "Variable") {
        const refs = bindings.get(term.name);
        if (refs && refs.length > 0) {
          const varType = varTypes.get(term.name);
          const lifted = liftToJsonIfNeeded(bindingToSql(refs[0]!), varType, expectedType, dialect);
          subConditions.push(
            isLiteralBinding(refs[0]!) || nonNullVars.has(term.name)
              ? `${ident(col)} = ${lifted}`
              : dialect.logicalEq(ident(col), lifted),
          );
        }
      } else {
        const termType = inferTermType(term, varTypes, columnTypes);
        const termSql = termToSql(
          term,
          bindings,
          varTypes,
          columnTypes,
          functionOverloads,
          dialect,
        );
        const lifted = liftToJsonIfNeeded(termSql, termType, expectedType, dialect);
        subConditions.push(
          cannotBeNullHere(term)
            ? `${ident(col)} = ${lifted}`
            : dialect.logicalEq(ident(col), lifted),
        );
      }
    }
    const tag = tagMap?.get(atom.predicate);
    if (tag) {
      subConditions.push(`"__tag" = '${tag.replace(/'/g, "''")}'`);
    }
    let subquery = `SELECT 1 FROM ${ident(renameMap?.get(atom.predicate) ?? atom.predicate)}`;
    if (subConditions.length > 0) {
      subquery += ` WHERE ${subConditions.join(" AND ")}`;
    }
    conditions.push(markSpan(atom, `NOT EXISTS (${subquery})`));
  }

  // Filter conditions: any boolean expression body element. The
  // expression's translation already handles comparisons, &&/||, and
  // mixed boolean-returning forms — we just emit it as a WHERE clause
  // condition. termToSql wraps the result in parens for arithmetic
  // ops, so explicit parens here are belt-and-braces for the few
  // shapes that aren't already wrapped (a single boolean variable, a
  // function call, etc.).
  for (const f of filters) {
    const sql = termToSql(f.expr, bindings, varTypes, columnTypes, functionOverloads, dialect);
    // A negated filter is negation as failure, not the `!` operator: it holds
    // whenever its operand does not, including when the operand is NULL. SQL's
    // `NOT` propagates NULL instead, so the operand is totalised first. See
    // doc/design/null-as-a-value.md §4.4.
    conditions.push(markSpan(f, f.negated ? `(NOT COALESCE(${sql}, FALSE))` : `(${sql})`));
  }

  // Non-binding equality constraints (`X + 1 = Y`) use logical equality —
  // null-aware on every dialect (`IS NOT DISTINCT FROM` / `IS`) so a body
  // `X = Y` matches when both sides are NULL, agreeing with the native
  // evaluator's `logicalEq`. When one side is `json` and the other a
  // primitive, lift the primitive so the dialect's null-aware operator
  // sees two compatible operands.
  //
  // A provably non-null side takes the plain `=` for the same reason the
  // shared-variable join does. Doing it here as well as there is what keeps a
  // repeated variable and a spelled-out equality emitting the same operator,
  // which is the invariant null.md §4 rests on.
  for (const eq of equalityConstraints) {
    let lhs = termToSql(eq.left, bindings, varTypes, columnTypes, functionOverloads, dialect);
    let rhs = termToSql(eq.expr, bindings, varTypes, columnTypes, functionOverloads, dialect);
    const leftType = inferTermType(eq.left, varTypes, columnTypes);
    const rightType = inferTermType(eq.expr, varTypes, columnTypes);
    if (leftType === "value" && rightType !== undefined && rightType !== "value") {
      rhs = primitiveToJsonSql(rhs, rightType, dialect);
    } else if (rightType === "value" && leftType !== undefined && leftType !== "value") {
      lhs = primitiveToJsonSql(lhs, leftType, dialect);
    }
    const plainEq = cannotBeNullHere(eq.left) || cannotBeNullHere(eq.expr);
    conditions.push(markSpan(eq, plainEq ? `(${lhs} = ${rhs})` : dialect.logicalEq(lhs, rhs)));
  }

  // Filter range conditions (non-binding ranges)
  for (const { exprSql, lowSql, highSql, node } of filterRanges) {
    conditions.push(markSpan(node, `${exprSql} BETWEEN ${lowSql} AND ${highSql}`));
  }

  // A nullary predicate has no columns, but SQL has no zero-column relation.
  // Represent it as a single constant marker column: a row present means the
  // proposition holds. `colList` / `emptyAnchor` use the same `col1` shape, and
  // queries read it via the ground-query probe or NOT EXISTS, never project it.
  const selectList = selectParts.length > 0 ? selectParts.join(", ") : "1 AS col1";
  const selectClause = markSpan(rule.head, `SELECT ${distinct ? "DISTINCT " : ""}${selectList}`);
  let sql = selectClause;
  if (fromParts.length > 0) {
    sql += ` FROM ${fromParts.join(", ")}`;
  }
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }
  if (groupByExprs.length > 0) {
    sql += ` GROUP BY ${groupByExprs.join(", ")}`;
  }
  // Wrap the whole rule so hovering anywhere in the rule source still has a
  // matching SQL span at the coarsest level.
  return markSpan(rule, sql);
}

function translateFact(rule: Rule, analyzed: TypedProgram, dialect: SqlDialect): string {
  const emptyBindings = new Map<string, Binding[]>();
  const emptyVarTypes = new Map<string, PrimitiveType>();
  const selectParts = rule.head.args.map((term, i) => {
    if (term.$type === "AggregateCall") {
      // The analyzer rejects aggregates in facts (empty rule bodies), so this
      // should never fire; surface it clearly if it ever does.
      throw new AnalyzerError(
        `Fact for '${rule.head.predicate}' cannot contain an aggregate`,
        term.$cstNode?.offset,
        term.$cstNode?.end,
      );
    }
    const rawSql = termToSql(
      term,
      emptyBindings,
      emptyVarTypes,
      analyzed.columnTypes,
      analyzed.functionOverloads,
      dialect,
    );
    const headColType = analyzed.columnTypes.get(rule.head.predicate)?.[i];
    const termType = inferTermType(term, emptyVarTypes, analyzed.columnTypes);
    const lifted = liftToJsonIfNeeded(rawSql, termType, headColType, dialect);
    return `${castIntegerForDialect(lifted, headColType, dialect)} AS col${i + 1}`;
  });
  // A nullary fact (empty head) becomes the constant marker column; see translateRule.
  const selectList = selectParts.length > 0 ? selectParts.join(", ") : "1 AS col1";
  const selectClause = markSpan(rule.head, `SELECT ${selectList}`);
  return markSpan(rule, selectClause);
}

// --- Queries ---

// Synthetic predicate name for the throwaway "rule" that translateRule
// builds for each query. Never inserted into `analyzed.rules`, never
// referenced by user predicates (the leading `__` already disqualifies
// it from being parsed as an IDENT). Used only as a placeholder for
// the rule shape translateRule expects.
const QUERY_PRED = "__query__";

/**
 * Translate a list of queries (the program's `?-`/output queries, or its
 * constraints — both are the same conjunctive shape). Each query is processed by
 * synthesising a `Rule` whose head args are the projected variables
 * (or a single literal `1` for ground queries) and whose body is the
 * query body, then wrapping the rule's SELECT with an outer SELECT
 * that exposes user-facing column names (or a single `__probe` column
 * for ground queries — the executor projects it away).
 */
function translateQueries(
  analyzed: TypedProgram,
  dialect: SqlDialect,
  queries: readonly Query[],
): { sql: string[]; predicates: string[]; columnTypes: Record<string, PrimitiveType>[] } {
  const sql: string[] = [];
  const predicates: string[] = [];
  const columnTypes: Record<string, PrimitiveType>[] = [];
  for (const query of queries) {
    const result = translateOneQuery(query, analyzed, dialect);
    sql.push(result.sql);
    predicates.push(result.predicate);
    columnTypes.push(result.columnTypes);
  }
  return { sql, predicates, columnTypes };
}

function translateOneQuery(
  query: Query,
  analyzed: TypedProgram,
  dialect: SqlDialect,
): { sql: string; predicate: string; columnTypes: Record<string, PrimitiveType> } {
  const projection = queryProjection(query);
  const isGround = projection.length === 0;

  // Build a synthetic Rule whose head args drive translateRule's
  // SELECT clause. For ground queries the head is a single literal
  // `1` (any column is fine — we just need *some* column so the rule
  // SELECT is valid SQL). For non-ground queries the head args are
  // the projection Variables themselves; translateRule emits them as
  // `<binding> AS col1, <binding> AS col2, …` which the outer SELECT
  // then re-aliases to the user-facing variable names.
  const headArgs: HeadTerm[] = isGround
    ? [{ $type: "NumberLiteral", value: 1, rawText: "1" } as NumberLiteral]
    : projection.slice();
  // The synthetic Rule isn't part of the real AST tree, so its
  // `$container` pointers don't match Langium's expected types
  // (HeadAtom.$container is normally a Rule). translateRule doesn't
  // walk these pointers; only $cstNode (used for span tracking) and
  // the head/body shape matter. Cast through `unknown` to bypass the
  // structural check on container types.
  const syntheticHead = {
    $type: "HeadAtom",
    predicate: QUERY_PRED,
    args: headArgs,
  } as unknown as HeadAtom;
  const syntheticRule = {
    $type: "Rule",
    head: syntheticHead,
    body: query.body,
    $cstNode: query.$cstNode,
  } as unknown as Rule;

  const innerSql = translateRule(syntheticRule, analyzed, undefined, undefined, dialect);

  // Compute the projected variable types for downstream coercion.
  // `rebuildVarTypes` does the same fixed-point over the body the
  // rule-side type inference does, so the result matches what
  // sibling rules with the same body would produce.
  const queryColTypes: Record<string, PrimitiveType> = {};
  if (!isGround) {
    const varTypes = rebuildVarTypes(query.body, analyzed.columnTypes);
    for (const v of projection) {
      if (v.$type === "Variable") {
        const t = varTypes.get(v.name);
        if (t) queryColTypes[v.name] = t;
      }
    }
  }

  // Wrap the synthetic rule's SELECT with an outer SELECT that
  // exposes user-facing column names (or strips to a probe column
  // for ground queries). `__q` is the obligatory derived-table
  // alias both dialects require.
  let outerSql: string;
  if (isGround) {
    outerSql = `SELECT DISTINCT 1 AS __probe FROM (${innerSql}) AS __q;`;
  } else {
    const aliases = projection
      .map((v, i) => `${ident(`col${i + 1}`)} AS ${ident((v as Variable).name)}`)
      .join(", ");
    outerSql = `SELECT DISTINCT ${aliases} FROM (${innerSql}) AS __q;`;
  }

  return {
    sql: markSpan(query, outerSql),
    predicate: QUERY_PRED,
    columnTypes: queryColTypes,
  };
}

// --- Helpers ---

function resolveColumnRef(predicate: string, argIndex: number, analyzed: TypedProgram): string {
  const extDecl = analyzed.extDecls.get(predicate);
  if (extDecl) {
    return extDecl.columns[argIndex]!.name;
  }
  return `col${argIndex + 1}`;
}

/**
 * Convert a Term AST node to a SQL expression string.
 * @param varTypes    - Variable type map for type-aware operator selection (+ vs ||)
 * @param columnTypes - Predicate column types (for inferTermType)
 * @param dialect     - Dialect for dialect-specific constructs (group-concat, range sources, etc.)
 */
function termToSql(
  term: HeadTerm,
  bindings: Map<string, Binding[]>,
  varTypes: Map<string, PrimitiveType>,
  columnTypes: ReadonlyMap<string, readonly PrimitiveType[]>,
  functionOverloads: ReadonlyMap<FunctionCall, Overload>,
  dialect: SqlDialect,
  guardResult = true,
): string {
  switch (term.$type) {
    case "StringLiteral":
      return `'${term.value.replace(/'/g, "''")}'`;
    case "NumberLiteral":
      // Preserve the original text so a float literal like `1.0` stays `1.0`
      // in SQL (emitting `1` would silently turn floating-point division into
      // integer division).
      return term.rawText ?? String(term.value);
    case "BooleanLiteral":
      // `TRUE`/`FALSE` is the portable spelling: Postgres has
      // a native BOOLEAN type, and SQLite ≥ 3.23 (which is what bun:sqlite
      // and sql.js ship) accepts the keywords too, evaluating them as 1/0.
      return term.value ? "TRUE" : "FALSE";
    case "NullLiteral":
      return "NULL";
    case "Variable": {
      const refs = bindings.get(term.name);
      if (!refs || refs.length === 0) {
        const cst = term.$cstNode;
        throw new AnalyzerError(`Unbound variable '${term.name}'`, cst?.offset, cst?.end);
      }
      const b = refs[0]!;
      return b.kind === "col" ? `${b.alias}.${ident(b.col)}` : b.sql;
    }
    case "BinaryExpr": {
      const isStringConcat =
        term.op === "+" &&
        (isStringType(term.left, varTypes, columnTypes) ||
          isStringType(term.right, varTypes, columnTypes));
      const isNumericArithmetic =
        !COMPARISON_OPS.has(term.op) && term.op !== "&&" && term.op !== "||" && !isStringConcat;
      let leftSql = termToSql(
        term.left,
        bindings,
        varTypes,
        columnTypes,
        functionOverloads,
        dialect,
        !isNumericArithmetic || inferTermType(term.left, varTypes, columnTypes) === "integer",
      );
      let rightSql = termToSql(
        term.right,
        bindings,
        varTypes,
        columnTypes,
        functionOverloads,
        dialect,
        !isNumericArithmetic || inferTermType(term.right, varTypes, columnTypes) === "integer",
      );
      // Logical and/or: map the source's `&&`/`||` to SQL's `AND`/`OR`.
      // Three-valued logic (NULL handling) is identical across every SQL
      // dialect and the native evaluator, so no extra wrapping is needed.
      if (term.op === "&&") return `(${leftSql} AND ${rightSql})`;
      if (term.op === "||") return `(${leftSql} OR ${rightSql})`;
      // For equality, lift the primitive side when the other is json so
      // SQL can compare across the type-tag boundary. Ordering ops are
      // rejected for json by the analyzer, so they don't need this.
      // Arithmetic ops fall through unchanged, the analyzer having already
      // gated them to numeric operands.
      if (EQUALITY_OPS.has(term.op)) {
        const leftType = inferTermType(term.left, varTypes, columnTypes);
        const rightType = inferTermType(term.right, varTypes, columnTypes);
        if (leftType === "value" && rightType !== undefined && rightType !== "value") {
          rightSql = primitiveToJsonSql(rightSql, rightType, dialect);
        } else if (rightType === "value" && leftType !== undefined && leftType !== "value") {
          leftSql = primitiveToJsonSql(leftSql, leftType, dialect);
        }
      }
      // Equality is null-aware, so it routes through the dialect-specific
      // emitter (Postgres `IS NOT DISTINCT FROM`, SQLite / sql.js `IS`).
      if (term.op === "=") return dialect.logicalEq(leftSql, rightSql);
      if (term.op === "<>") return dialect.logicalNeq(leftSql, rightSql);
      if (ORDERING_OPS.has(term.op)) {
        const leftType = inferTermType(term.left, varTypes, columnTypes);
        const rightType = inferTermType(term.right, varTypes, columnTypes);
        if (leftType === "string" || rightType === "string") {
          leftSql = dialect.stringOrder(leftSql);
          rightSql = dialect.stringOrder(rightSql);
        }
        return totalOrderingSql(term.op, leftSql, rightSql, term.left, term.right);
      }
      // Bitwise / shift ops: each dialect owns the emission (XOR / `>>>`
      // emulation, 32-bit wrapping). The analyzer has already gated the
      // operands to integers; NULL propagates natively.
      if (BITWISE_OPS.has(term.op)) {
        return dialect.bitwise(term.op as BitwiseOp, leftSql, rightSql);
      }
      // Exponentiation: float-valued, with the same domain guards the
      // `power` builtin had. The CASE returns NULL on overflow, so no
      // extra finite-result guard is needed.
      if (term.op === "**") {
        return powerSql(leftSql, rightSql);
      }
      let op: string = term.op;
      if (isStringConcat) {
        op = "||";
      }
      const resultType = inferTermType(term, varTypes, columnTypes);
      const guardNumericResult = (sql: string): string => {
        if (!guardResult) return sql;
        if (resultType === "float") return finiteFloatOrNullSql(sql);
        if (resultType === "integer") {
          return safeIntegerOrNullSql(sql, dialect, containsAggregate(term));
        }
        return sql;
      };
      // Division and modulo by zero: wrap the divisor with NULLIF so every
      // backend returns NULL. Postgres would otherwise raise `division by
      // zero`; SQLite already returns NULL. NULL ÷ anything and anything ÷
      // NULL both yield NULL. Float-valued arithmetic also gets a
      // finite-result guard so overflow becomes NULL instead of leaking
      // Infinity / NaN.
      if (op === "/" || op === "%") {
        const safeRhs = `NULLIF(${rightSql}, 0)`;
        if (
          op === "%" &&
          (!isIntegerTerm(term.left, varTypes, columnTypes) ||
            !isIntegerTerm(term.right, varTypes, columnTypes))
        ) {
          return guardNumericResult(floatModuloSql(leftSql, safeRhs));
        }
        if (
          op === "/" &&
          dialect.divideIntegers &&
          isIntegerTerm(term.left, varTypes, columnTypes) &&
          isIntegerTerm(term.right, varTypes, columnTypes)
        ) {
          return guardNumericResult(dialect.divideIntegers(leftSql, safeRhs));
        }
        return guardNumericResult(`(${leftSql} ${op} ${safeRhs})`);
      }
      const leftOperand = resultType === "integer" && op === "*" ? asDecimal(leftSql) : leftSql;
      const rightOperand = resultType === "integer" && op === "*" ? asDecimal(rightSql) : rightSql;
      return guardNumericResult(`(${leftOperand} ${op} ${rightOperand})`);
    }
    case "UnaryExpr": {
      const operandSql = termToSql(
        term.operand,
        bindings,
        varTypes,
        columnTypes,
        functionOverloads,
        dialect,
        term.op === "!",
      );
      if (term.op === "!") return `(NOT ${operandSql})`;
      const sql = `(-${operandSql})`;
      if (!guardResult) return sql;
      return inferTermType(term, varTypes, columnTypes) === "float"
        ? finiteFloatOrNullSql(sql)
        : sql;
    }
    case "FunctionCall":
      return translateCall(term, bindings, varTypes, columnTypes, functionOverloads, dialect);
    case "Subscript": {
      const obj = termToSql(
        term.object,
        bindings,
        varTypes,
        columnTypes,
        functionOverloads,
        dialect,
      );
      const idx = termToSql(
        term.index,
        bindings,
        varTypes,
        columnTypes,
        functionOverloads,
        dialect,
      );
      const objType = inferTermType(term.object, varTypes, columnTypes);
      if (objType === "value") {
        const idxType = inferTermType(term.index, varTypes, columnTypes);
        const inner = dialect.jsonSubscript(obj, idx, idxType === "string");
        // Object-keyed (string) subscript has no notion of "negative" —
        // pass through. For array-keyed (integer) subscript, the
        // SQLite dialect builds the JSON path by concatenating the
        // index (`'$[' || CAST(idx AS TEXT) || ']'`), so a runtime
        // `-1` produces the literal path `$[-1]`, which SQLite rejects
        // with `bad JSON path`. Postgres's `jsonb -> -1` doesn't throw
        // but returns the last array element, also diverging from the
        // native evaluator (which returns NULL at `values.ts:161` for
        // any negative array index). Wrap the integer-keyed case in
        // the same `< 0 → NULL` shape the string-subscript path uses
        // a few lines below so every backend agrees on NULL.
        if (idxType === "string") return inner;
        return `(CASE WHEN (${idx}) < 0 THEN NULL ELSE ${inner} END)`;
      }
      // Guard against negative indices: SQLite's SUBSTR counts from the
      // right when the start position is negative (so `S[-2]` on
      // "hello" returns "o"), while the native backend returns '' for any
      // negative index. Force every backend to '' so cross-backend results
      // agree. Out-of-range positive indices already produce '' on every
      // SQL dialect, so no additional guard is needed there.
      // The leading IS NULL branch keeps NULL propagating through to NULL
      // (per §5.4) — without it, `NULL >= 0` is NULL and SQL's CASE falls
      // through to ELSE '', diverging from the native evaluator.
      return `CASE WHEN (${obj}) IS NULL OR (${idx}) IS NULL THEN NULL WHEN (${idx}) >= 0 THEN SUBSTR(${obj}, ${castPositionForDialect(`(${idx}) + 1`, dialect)}, 1) ELSE '' END`;
    }
    case "Slice": {
      const obj = termToSql(
        term.object,
        bindings,
        varTypes,
        columnTypes,
        functionOverloads,
        dialect,
      );
      const objType = inferTermType(term.object, varTypes, columnTypes);
      if (objType === "value") {
        const s = term.start
          ? termToSql(term.start, bindings, varTypes, columnTypes, functionOverloads, dialect)
          : null;
        const e = term.end
          ? termToSql(term.end, bindings, varTypes, columnTypes, functionOverloads, dialect)
          : null;
        // Both dialect implementations build the result by feeding the
        // receiver into `jsonb_array_elements(...)` / `json_each(...)`
        // and reaggregating with `COALESCE(..., '[]')`; a NULL receiver
        // therefore unfolds into the empty array, disagreeing with the
        // native evaluator (which returns NULL on a NULL receiver per
        // §5.4 NULL propagation). Wrap the dispatch with an explicit
        // IS NULL guard so every backend agrees: NULL receiver → NULL.
        // Bound-NULLs are similarly defended — the dialects' WHERE
        // clauses use `>=`/`<` which would silently coerce a NULL bound
        // into "row excluded" and produce `[]`.
        const guards: string[] = [`(${obj}) IS NULL`];
        if (s !== null) guards.push(`(${s}) IS NULL`);
        if (e !== null) guards.push(`(${e}) IS NULL`);
        // Native (values.ts:193) short-circuits to `[]` for any
        // negative bound. The dialects' WHERE filters compare against
        // 0-based array keys, so a runtime `start = -1` matches every
        // key and returns the whole array — a cross-backend
        // divergence. Force `[]` on negative bounds via an empty
        // `jsonSlice(obj, 0, 0)` call so the dialect's empty-array
        // shape is reused (Postgres `'[]'::jsonb`, SQLite `'[]'`).
        const negChecks: string[] = [];
        if (s !== null) negChecks.push(`(${s}) < 0`);
        if (e !== null) negChecks.push(`(${e}) < 0`);
        const inner = dialect.jsonSlice(obj, s, e);
        if (negChecks.length === 0) {
          return `CASE WHEN ${guards.join(" OR ")} THEN NULL ELSE ${inner} END`;
        }
        const empty = dialect.jsonSlice(obj, "0", "0");
        return `CASE WHEN ${guards.join(" OR ")} THEN NULL WHEN ${negChecks.join(" OR ")} THEN ${empty} ELSE ${inner} END`;
      }
      // Python-style slices return '' when start >= end, when either bound
      // is negative, or when out-of-range bounds would make SUBSTR walk
      // backwards / error. SQLite reinterprets `SUBSTR(s, N, K)` for N <= 0
      // (taking K-(1-N) chars from position 1 rather than returning '');
      // Postgres raises on negative length; the native backend returns ''.
      // Guard each form explicitly so the cross-backend invariant holds.
      // Each CASE also has a leading IS NULL branch so NULL operands
      // propagate to NULL rather than falling through to ELSE ''.
      if (term.start && term.end) {
        const s = termToSql(
          term.start,
          bindings,
          varTypes,
          columnTypes,
          functionOverloads,
          dialect,
        );
        const e = termToSql(term.end, bindings, varTypes, columnTypes, functionOverloads, dialect);
        return `CASE WHEN (${obj}) IS NULL OR (${s}) IS NULL OR (${e}) IS NULL THEN NULL WHEN (${s}) >= 0 AND (${e}) > (${s}) THEN SUBSTR(${obj}, ${castPositionForDialect(`(${s}) + 1`, dialect)}, ${castPositionForDialect(`(${e}) - (${s})`, dialect)}) ELSE '' END`;
      }
      if (term.start) {
        const s = termToSql(
          term.start,
          bindings,
          varTypes,
          columnTypes,
          functionOverloads,
          dialect,
        );
        return `CASE WHEN (${obj}) IS NULL OR (${s}) IS NULL THEN NULL WHEN (${s}) >= 0 THEN SUBSTR(${obj}, ${castPositionForDialect(`(${s}) + 1`, dialect)}) ELSE '' END`;
      }
      if (term.end) {
        const e = termToSql(term.end, bindings, varTypes, columnTypes, functionOverloads, dialect);
        return `CASE WHEN (${obj}) IS NULL OR (${e}) IS NULL THEN NULL WHEN (${e}) > 0 THEN SUBSTR(${obj}, 1, ${castPositionForDialect(`(${e})`, dialect)}) ELSE '' END`;
      }
      return obj;
    }
    case "ArrayLiteral": {
      const elements = term.elements.map((elem) => ({
        sql: termToSql(elem, bindings, varTypes, columnTypes, functionOverloads, dialect),
        type: inferTermType(elem, varTypes, columnTypes),
      }));
      return dialect.jsonArray(elements);
    }
    case "ObjectLiteral": {
      const entries = term.entries.map((entry) => ({
        key: entry.key,
        valueSql: termToSql(
          entry.value,
          bindings,
          varTypes,
          columnTypes,
          functionOverloads,
          dialect,
        ),
        valueType: inferTermType(entry.value, varTypes, columnTypes),
      }));
      return dialect.jsonObject(entries);
    }
    case "BracketAccess":
      // Post-processing rewrites every BracketAccess into Subscript or Slice,
      // so this case is unreachable at runtime.
      throw new Error(`BracketAccess survived post-processing at ${term.$cstNode?.offset ?? "?"}`);
    case "Wildcard":
      // `count(*)` short-circuits in translateAggregate, so a Wildcard never
      // reaches expression codegen.
      throw new Error("'*' may only appear as the argument of count(*)");
    case "AggregateCall":
      // An aggregate may sit inside a head expression (`count(*) - 1`), so it
      // is an ordinary leaf here. SQL allows arithmetic over an aggregate in
      // a select list, so nothing else about the emitted query changes.
      return translateAggregate(term, bindings, varTypes, columnTypes, functionOverloads, dialect);
  }
  assertNever(term, "term type");
}

/** True if `rule`'s body contains a non-negated atom referring to `predicate`. */
function isSelfRecursive(rule: Rule, predicate: string): boolean {
  return rule.body.some(
    (elem) => elem.$type === "Literal" && !elem.negated && elem.predicate === predicate,
  );
}

/** True if a binding resolves to a pure SQL literal (number or quoted string). */
/**
 * True if a term can never evaluate to NULL, so a plain SQL `=` against it
 * agrees with the null-aware form. Syntactic and conservative: only the
 * literal cases.
 *
 * Used by `totalOrderingSql`, which runs inside `termToSql` and so has no
 * access to the enclosing body's refinements. The real analysis
 * (`mayBeNull`, see doc/design/nullness-tracking.md §4) is what the equality
 * sites use, where the body is in scope. Keeping the syntactic one here costs
 * nothing measurable: an ordering comparison is never a hash or merge join
 * key, so the wrapper it fails to remove is not on any plan's critical path.
 */
function cannotBeNull(term: Expression): boolean {
  switch (term.$type) {
    case "StringLiteral":
    case "NumberLiteral":
    case "BooleanLiteral":
      return true;
    case "UnaryExpr":
      return term.op === "-" && cannotBeNull(term.operand);
    default:
      return false;
  }
}

/**
 * Is this binding's SQL a literal, and so certainly not NULL? Used only to pick
 * the plain equality over the null-aware one. The grouping question is answered
 * by `isGroupingArg` against the AST instead, which is why this does not need to
 * recognise `TRUE` / `FALSE`: a boolean binding is non-null either way, and
 * whether it groups is no longer decided here.
 */
function isLiteralBinding(b: Binding): boolean {
  if (b.kind === "col") return false;
  // Accept the parenthesised `(-N)` / `(-N.M)` form that termToSql emits for
  // UnaryExpr(NumberLiteral), so a negative literal counts as a constant.
  return /^\s*(-?\d+(?:\.\d+)?|\(-\d+(?:\.\d+)?\)|'(?:[^']|'')*')\s*$/.test(b.sql);
}

/** `chooseEqualityBinding` against the variables bound to SQL so far. */
function chooseEqualityBinding(
  eq: Equality,
  bindings: Map<string, Binding[]>,
): { variable: string; expr: Expression } | undefined {
  return coreChooseEqualityBinding(eq, (name) => bindings.has(name));
}

/** Return true if every Variable reference in `term` has a binding. */
/** `allVarsBound` against the variables bound to SQL so far. */
function allVarsBound(term: HeadTerm, bindings: Map<string, Binding[]>): boolean {
  return coreAllVarsBound(term, (name) => bindings.has(name));
}

/** Check whether a term has integer type. */
function isIntegerTerm(
  term: Expression,
  varTypes: Map<string, PrimitiveType>,
  columnTypes: ReadonlyMap<string, readonly PrimitiveType[]>,
): boolean {
  return inferTermType(term, varTypes, columnTypes) === "integer";
}

/** Check whether a term has string type (for choosing || over +). */
function isStringType(
  term: Expression,
  varTypes: Map<string, PrimitiveType>,
  columnTypes: ReadonlyMap<string, readonly PrimitiveType[]>,
): boolean {
  return inferTermType(term, varTypes, columnTypes) === "string";
}

/**
 * Portable floating-point remainder. SQLite's `%` operator coerces operands
 * to integers before computing the remainder, while native uses JS's floating
 * remainder. Use `x - y * trunc(x/y)` for any modulo expression that has a
 * float-typed side; the caller has already wrapped `y` in `NULLIF(y, 0)`.
 */
function floatModuloSql(leftSql: string, rightSql: string): string {
  const quotient = `(${leftSql} / ${rightSql})`;
  const truncated = `(CASE WHEN ${quotient} < 0 THEN CEIL(${quotient}) ELSE FLOOR(${quotient}) END)`;
  return `(${leftSql} - ${rightSql} * ${truncated})`;
}

function asDecimal(sql: string): string {
  return `CAST(${sql} AS DECIMAL)`;
}

/**
 * Narrow an integer expression to the 32-bit type a *positional* argument
 * needs. Postgres stores `integer` as BIGINT, the domain being 2^53, but its
 * `SUBSTR` is defined only for int4 positions and a bare cast raises
 * "integer out of range" on a larger value, where SQLite and the interpreters
 * return `''`. Clamping first keeps them agreeing: a position past int4 is
 * past the end of any string, so clamping to the int4 bound gives the same
 * empty result. A dialect whose `integer` is already INTEGER needs nothing.
 */
function castPositionForDialect(sql: string, dialect: SqlDialect): string {
  if (sqlTypeFor(dialect, "integer") === "INTEGER") return sql;
  return `CAST(LEAST(GREATEST(${sql}, -2147483648), 2147483647) AS INTEGER)`;
}

function castIntegerForDialect(
  sql: string,
  type: PrimitiveType | undefined,
  dialect: SqlDialect,
): string {
  const storageType = sqlTypeFor(dialect, "integer");
  if (type !== "integer" || storageType === "INTEGER") return sql;
  if (sql.startsWith('(WITH __datamog_safe_integer("value")')) return sql;
  if (sql.startsWith("CAST(") && sql.endsWith(` AS ${storageType})`)) return sql;
  return `CAST(${sql} AS ${storageType})`;
}

function asciiFoldSql(sql: string, from: string, to: string): string {
  let out = sql;
  for (let i = 0; i < from.length; i++) {
    out = `REPLACE(${out}, '${from[i]}', '${to[i]}')`;
  }
  return out;
}

/**
 * Wrap `sql` with `dialect.toJson` when the expression is primitive
 * but the slot it's flowing into demands `json`. The type system
 * (`joinTypesWithJsonLift` in `core/types.ts`) accepts this mismatch
 * by promising the lift; this helper is the runtime side of that
 * promise.
 *
 * No-op when `expectedType` is anything other than `json`, when
 * `exprType` is already `json` (no double-wrap), or when
 * `expectedType` is undefined (the analyzer either resolved it or
 * already rejected the program).
 *
 * An expression with no static type is the `null` literal, whose value
 * is NULL whatever slot it lands in. It still needs the slot's type:
 * Postgres cannot resolve `#>>` and the other jsonb operators against
 * an untyped NULL and fails with "operator is not unique", where the
 * SQLite family, being dynamically typed, does not care. Casting is
 * enough, since a NULL of any type is still NULL.
 */
function liftToJsonIfNeeded(
  sql: string,
  exprType: PrimitiveType | undefined,
  expectedType: PrimitiveType | undefined,
  dialect: SqlDialect,
): string {
  if (expectedType !== "value") return sql;
  if (exprType === "value") return sql;
  if (exprType === undefined) return `CAST(${sql} AS ${sqlTypeFor(dialect, "value")})`;
  return primitiveToJsonSql(sql, exprType, dialect);
}

function primitiveToJsonSql(sql: string, exprType: PrimitiveType, dialect: SqlDialect): string {
  const liftedSql = exprType === "float" ? finiteFloatOrNullSql(sql) : sql;
  return dialect.toJson(liftedSql, exprType);
}

/**
 * An ordering comparison, made total. SQL's `<` and friends yield NULL when
 * either operand is NULL; Datamog treats null as an isolated point in the
 * order, so `<` / `>` are false whenever a side is null and `<=` / `>=` are
 * true only when both are. See doc/design/null.md §5.
 *
 * In a plain WHERE conjunct the wrapper is redundant, NULL and FALSE both
 * dropping the row, but it is needed under `not` and wherever the result is
 * bound to a variable. Emitting it unconditionally costs nothing measurable:
 * no backend creates an index, and an ordering predicate is never a hash or
 * merge join key.
 */
function totalOrderingSql(
  op: string,
  leftSql: string,
  rightSql: string,
  left: Expression,
  right: Expression,
): string {
  const cmp = `${leftSql} ${op} ${rightSql}`;
  // Neither side can be null, so SQL's own answer is already total.
  if (cannotBeNull(left) && cannotBeNull(right)) return `(${cmp})`;
  // `<=` and `>=` hold of two nulls, but only if both sides can be one.
  if ((op === "<=" || op === ">=") && !cannotBeNull(left) && !cannotBeNull(right)) {
    return `COALESCE(${cmp}, (${leftSql} IS NULL AND ${rightSql} IS NULL))`;
  }
  return `COALESCE(${cmp}, FALSE)`;
}

/**
 * Equality between two matching positions, with the json lift applied when
 * one side is a primitive and the other a `value`.
 *
 * `plainEq` opts out of the null-aware operator where one side cannot be
 * NULL. Both forms drop the row when the other side is NULL, one via NULL
 * and one via FALSE, so they are interchangeable in a WHERE conjunct, and
 * the plain form keeps the emitted SQL readable and hash-joinable.
 */
function sqlEqWithJsonLift(
  leftSql: string,
  leftType: PrimitiveType | undefined,
  rightSql: string,
  rightType: PrimitiveType | undefined,
  dialect: SqlDialect,
  plainEq = false,
): string {
  let lhs = leftSql;
  let rhs = rightSql;
  if (leftType === "value" && rightType !== undefined && rightType !== "value") {
    rhs = primitiveToJsonSql(rhs, rightType, dialect);
  } else if (rightType === "value" && leftType !== undefined && leftType !== "value") {
    lhs = primitiveToJsonSql(lhs, leftType, dialect);
  }
  return plainEq ? `${lhs} = ${rhs}` : dialect.logicalEq(lhs, rhs);
}

/** Translate an aggregate function call to SQL. */
function translateAggregate(
  agg: AggregateCall,
  bindings: Map<string, Binding[]>,
  varTypes: Map<string, PrimitiveType>,
  columnTypes: ReadonlyMap<string, readonly PrimitiveType[]>,
  functionOverloads: ReadonlyMap<FunctionCall, Overload>,
  dialect: SqlDialect,
): string {
  // count(*) → COUNT(*): counts rows, not values.
  if (agg.func === "count" && agg.arg.$type === "Wildcard") {
    return safeIntegerOrNullSql("COUNT(*)", dialect, true);
  }

  const argSql = termToSql(agg.arg, bindings, varTypes, columnTypes, functionOverloads, dialect);
  const argType = inferTermType(agg.arg, varTypes, columnTypes);
  const orderArgSql = argType === "string" ? dialect.stringOrder(argSql) : argSql;

  switch (agg.func) {
    case "count":
      return safeIntegerOrNullSql(`COUNT(${argSql})`, dialect, true);
    case "sum":
      return argType === "integer" ? dialect.integerSum(argSql) : `SUM(${argSql})`;
    case "avg":
      return `AVG(${argSql})`;
    case "min":
      return `MIN(${orderArgSql})`;
    case "max":
      return `MAX(${orderArgSql})`;
    case "concat": {
      // Native `concat` calls `String(v)` on each value, which
      // renders booleans as `"true"` / `"false"` (see
      // `packages/backend/native/src/planner.ts:411`). SQL backends
      // would otherwise emit a backend-specific cast — sqlite stores
      // booleans as integers and renders them as `"0"` / `"1"`,
      // postgres as `"t"` / `"f"` — diverging from native and from
      // each other. Wrap boolean args with a CASE that produces the
      // same `'true'` / `'false'` strings the native side does.
      //
      // Value-typed args have their own divergence: Postgres jsonb's
      // `::TEXT` serialiser inserts a space after `:` and `,`
      // outside strings (`{"a": 1}, {"b": 2}`), while SQLite
      // (canonical-TEXT storage) and native (`canonicalizeJson`)
      // produce no-whitespace canonical text. Route value args
      // through `jsonStringify` (the same regex-strip used by
      // `to_json`) before the aggregate, so every backend emits the
      // same per-element text. §6's "deterministic and identical
      // across every backend" promise holds for both wrappings.
      let wrapped: string;
      if (argType === "boolean") {
        wrapped = `(CASE WHEN ${argSql} THEN 'true' WHEN NOT (${argSql}) THEN 'false' END)`;
      } else if (argType === "value") {
        wrapped = dialect.stringOrder(dialect.jsonStringify(argSql));
      } else if (argType === "string") {
        wrapped = orderArgSql;
      } else {
        wrapped = argSql;
      }
      return dialect.concat(wrapped);
    }
    case "list": {
      // Primitive arguments are auto-lifted to JSON via `dialect.toJson`
      // (Postgres collapses to `to_jsonb`; SQLite per-type — strings via
      // `json_quote`, booleans via a `'true'`/`'false'` CASE, numbers
      // via `CAST(... AS TEXT)` so `1` and `1.0` survive as canonical
      // JSON numbers). Already-`json` values pass through unchanged so
      // we don't double-wrap. Undefined argType (e.g. an under-determined
      // expression) falls through unwrapped.
      //
      // The dialect receives both the lifted value and the raw arg —
      // the lifted form is the array element, and the raw arg drives
      // the NULL filter (so `json_quote(NULL) = 'null'` doesn't sneak
      // a JSON `null` into the array) and the ORDER BY (so primitive
      // columns sort by their natural SQL value rather than by the
      // lifted text).
      const argIsJson = argType === "value";
      const valueSql =
        argType === undefined || argIsJson ? argSql : primitiveToJsonSql(argSql, argType, dialect);
      return dialect.jsonAgg(valueSql, orderArgSql, argIsJson);
    }
    default:
      return `${agg.func.toUpperCase()}(${argSql})`;
  }
}

/**
 * Per-overload SQL emitters. Backends extend the language by adding
 * entries here, keyed by the registry's overload key. Generic-shaped
 * math built-ins (`ABS`, `ROUND`) emit a straight function call;
 * domain-error guards (`SQRT`, `LN`, `POWER`) wrap the inputs in a CASE
 * so every backend returns NULL on out-of-domain values; JSON built-ins
 * forward to per-dialect hooks since each engine has its own shape
 * (`json_extract`, `jsonb_typeof`, `STRING_AGG` casts, etc.).
 */
type SqlEmit = (sqlArgs: string[], dialect: SqlDialect) => string;

const MAX_FLOAT_SQL = "1.7976931348623157e308";
const LOG_MAX_FLOAT_SQL = `LN(${MAX_FLOAT_SQL})`;
const MAX_SAFE_INTEGER_SQL = "9007199254740991";

function finiteFloatOrNullSql(floatSql: string): string {
  return `(CASE WHEN ABS(${floatSql}) > ${MAX_FLOAT_SQL} OR ${floatSql} <> ${floatSql} THEN NULL ELSE ${floatSql} END)`;
}

function safeIntegerOrNullSql(integerSql: string, dialect: SqlDialect, aggregate = false): string {
  const type = sqlTypeFor(dialect, "integer");
  if (aggregate) {
    return `CAST((CASE WHEN ${integerSql} BETWEEN -${MAX_SAFE_INTEGER_SQL} AND ${MAX_SAFE_INTEGER_SQL} THEN ${integerSql} ELSE NULL END) AS ${type})`;
  }
  return `(WITH __datamog_safe_integer("value") AS (SELECT ${integerSql})
    SELECT CAST((CASE WHEN "value" BETWEEN -${MAX_SAFE_INTEGER_SQL} AND ${MAX_SAFE_INTEGER_SQL} THEN "value" ELSE NULL END) AS ${type})
    FROM __datamog_safe_integer)`;
}

/**
 * SQL for the `**` (exponentiation) operator. Three out-of-domain cases
 * return NULL rather than raising (Postgres) or yielding a non-finite
 * value:
 *   - base < 0 and exp is non-integer → imaginary result
 *   - base = 0 and exp < 0 → division by zero inside POWER
 *   - result overflows IEEE float range → +Infinity
 * `exp - FLOOR(exp) <> 0` is the portable non-integrality test; the
 * overflow branch checks `exp * ln(abs base) > ln(MAX_FLOAT)` so Postgres
 * can decide the branch before evaluating an overflowing POWER call.
 */
function powerSql(baseSql: string, expSql: string): string {
  return `(CASE
      WHEN (${baseSql}) < 0 AND (${expSql}) - FLOOR(${expSql}) <> 0 THEN NULL
      WHEN (${baseSql}) = 0 AND (${expSql}) < 0 THEN NULL
      WHEN ((${expSql}) * LN(NULLIF(ABS(${baseSql}), 0))) > ${LOG_MAX_FLOAT_SQL} THEN NULL
      ELSE POWER(${baseSql}, ${expSql})
    END)`;
}

const SQL_EMIT: ReadonlyMap<string, SqlEmit> = new Map<string, SqlEmit>([
  // String functions
  [
    "upper.string",
    (a) => asciiFoldSql(a[0]!, "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
  ],
  [
    "lower.string",
    (a) => asciiFoldSql(a[0]!, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"),
  ],
  ["trim.string", (a) => `TRIM(${a[0]})`],
  ["replace.string_string_string", (a) => `REPLACE(${a[0]}, ${a[1]}, ${a[2]})`],

  // Math (straight emission)
  ["abs.integer", (a) => `ABS(${a[0]})`],
  ["abs.float", (a) => `ABS(${a[0]})`],
  ["round.float", (a) => `ROUND(${a[0]})`],
  ["round.integer_integer", (a, d) => d.roundToScale(a[0]!, a[1]!, "integer")],
  ["round.float_integer", (a, d) => d.roundToScale(a[0]!, a[1]!, "float")],
  ["floor.float", (a) => `FLOOR(${a[0]})`],
  ["ceil.float", (a) => `CEIL(${a[0]})`],
  // `exp(x)` overflows to +Infinity for x > log(Number.MAX_VALUE).
  // Postgres raises on EXP overflow instead of returning Infinity, so
  // guard on the input before calling EXP. Use LN(MAX_FLOAT) in SQL
  // rather than a rounded decimal threshold; `exp(709.781)` remains
  // finite, matching native at the IEEE boundary.
  [
    "exp.float",
    (a) => `(CASE WHEN (${a[0]}) > ${LOG_MAX_FLOAT_SQL} THEN NULL ELSE EXP(${a[0]}) END)`,
  ],

  // Math with domain-error guards: Postgres raises `Out of Range` for
  // these cases; SQLite returns NULL. Wrap the inputs in CASE so every
  // backend yields NULL. `fn(NULL)` is NULL across all dialects, so
  // replacing the out-of-domain input with NULL propagates correctly.
  ["sqrt.float", (a) => `SQRT(CASE WHEN (${a[0]}) < 0 THEN NULL ELSE ${a[0]} END)`],
  ["ln.float", (a) => `LN(CASE WHEN (${a[0]}) <= 0 THEN NULL ELSE ${a[0]} END)`],

  // JSON: dialect-dispatched (each engine uses different primitives)
  ["as_string.value", (a, d) => d.jsonAsString(a[0]!)],
  ["as_integer.value", (a, d) => d.jsonAsInteger(a[0]!)],
  ["as_float.value", (a, d) => d.jsonAsFloat(a[0]!)],
  ["as_boolean.value", (a, d) => d.jsonAsBoolean(a[0]!)],
  ["length.value", (a, d) => d.jsonLength(a[0]!)],
  ["length.string", (a) => `LENGTH(${a[0]})`],
  ["type_of.value", (a, d) => d.jsonTypeOf(a[0]!)],
  ["has_key.value_string", (a, d) => d.jsonHasKey(a[0]!, a[1]!)],
  ["keys.value", (a, d) => d.jsonKeys(a[0]!)],
  ["values.value", (a, d) => d.jsonValues(a[0]!)],
  ["to_json.value", (a, d) => d.jsonStringify(a[0]!)],

  // Primitive conversions. CAST AS TEXT works portably for numbers; for
  // booleans we route through CASE because SQLite has no native boolean
  // type and would render `TRUE`/`FALSE` as `'1'`/`'0'`. The CASE form
  // keeps NULL → NULL by leaving both branches unmet for NULL inputs.
  // Note: integer-valued reals format slightly differently across
  // backends — Postgres `CAST(1.0::float8 AS TEXT)` returns `'1'` and
  // matches the native `String(1.0)`, while SQLite returns `'1.0'`.
  // Documented as a v1 cross-backend variance.
  ["to_string.integer", (a) => `CAST(${a[0]} AS TEXT)`],
  ["to_string.float", (a) => `CAST(${a[0]} AS TEXT)`],
  [
    "to_string.boolean",
    (a) => `(CASE WHEN ${a[0]} THEN 'true' WHEN NOT (${a[0]}) THEN 'false' END)`,
  ],
  ["to_integer.string", (a, d) => d.parseStringAsInteger(a[0]!)],
  ["to_float.string", (a, d) => d.parseStringAsFloat(a[0]!)],
  [
    "to_boolean.string",
    // Strict: only the literal canonical strings `'true'` and
    // `'false'` accepted. Anything else (including case variants) is
    // NULL. NULL input falls through to the implicit ELSE NULL.
    (a) => `(CASE ${a[0]} WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE ELSE NULL END)`,
  ],

  // Parse a string as JSON; NULL on malformed input. Dispatched to
  // each dialect — Postgres uses `pg_input_is_valid` + `::jsonb`,
  // SQLite uses `json_valid` + `json()`.
  ["parse_json.string", (a, d) => d.parseJson(a[0]!)],
]);

const INTEGER_RESULT_GUARDS = new Set([
  "round.float",
  "round.integer_integer",
  "floor.float",
  "ceil.float",
]);

// Module-load coverage check: every overload key in the core registry
// must have a SQL emitter, and every emitter must correspond to a
// registered overload. Mismatches fail loudly at startup rather than
// surfacing as a missing-emit error on a user's first call.
for (const key of BUILTIN_KEYS) {
  if (!SQL_EMIT.has(key)) throw new Error(`SQL emit not registered for built-in '${key}'`);
}
for (const key of SQL_EMIT.keys()) {
  if (!BUILTIN_KEYS.has(key)) throw new Error(`SQL emit registered for unknown built-in '${key}'`);
}

/**
 * Translate a built-in function call to SQL by looking up the resolved
 * overload from the typed program and dispatching through the emit
 * table.
 *
 * Most calls are pre-resolved during type inference. The fallback path
 * triggers only when an argument is an explicit `null` literal (no
 * static type) and overloads disagree on result type — both
 * (integer/float) overloads of `abs`, `round`, etc. emit the same SQL,
 * so any arity-matching overload yields semantically-equivalent SQL.
 */
function translateCall(
  call: FunctionCall,
  bindings: Map<string, Binding[]>,
  varTypes: Map<string, PrimitiveType>,
  columnTypes: ReadonlyMap<string, readonly PrimitiveType[]>,
  functionOverloads: ReadonlyMap<FunctionCall, Overload>,
  dialect: SqlDialect,
): string {
  let overload = functionOverloads.get(call);
  if (!overload) {
    const builtin = BUILTINS.get(call.name);
    overload = builtin?.overloads.find((o) => o.params.length === call.args.length);
    if (!overload) {
      throw new Error(
        `Internal error: no overload available for '${call.name}' at translation time`,
      );
    }
  }
  const sqlArgs = call.args.map((a, i) => {
    const rawSql = termToSql(a, bindings, varTypes, columnTypes, functionOverloads, dialect);
    const argType = inferTermType(a, varTypes, columnTypes);
    return liftToJsonIfNeeded(rawSql, argType, overload.params[i], dialect);
  });
  const emit = SQL_EMIT.get(overload.key);
  if (!emit) {
    throw new Error(`Internal error: SQL emit missing for built-in '${overload.key}'`);
  }
  const result = emit(sqlArgs, dialect);
  return INTEGER_RESULT_GUARDS.has(overload.key)
    ? safeIntegerOrNullSql(result, dialect, containsAggregate(call))
    : result;
}
