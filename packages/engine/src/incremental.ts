import {
  AnalyzerError,
  type PrimitiveType,
  type Program,
  type Statement,
  type TypedProgram,
  analyze,
  inferTypes,
} from "datamog-core";
import { parse, parseRaw, postProcess, typeAliasName } from "datamog-parser";
import type { Backend, QueryResult } from "./backend.ts";
import {
  type ConstraintViolation,
  ConstraintViolationError,
  projectConstraintRows,
  toViolation,
} from "./constraints.ts";
import type { ExtensionalLoader } from "./loader.ts";
import { coerceBooleanColumns, coerceJsonColumns, coerceNumericColumns } from "./result-coerce.ts";
import { translate } from "./translator.ts";

export interface DeclarationApplied {
  predicate: string;
  arity: number;
  /** Number of EDB rows the loader inserted. `undefined` for native backends
   *  (whose ingest path doesn't surface a count to this layer). */
  rowsLoaded: number | undefined;
}

export interface RuleApplied {
  predicate: string;
  arity: number;
}

export interface QueryResultWithTypes extends QueryResult {
  /** Declared `PrimitiveType` for each result-row column, keyed by column name.
   *  Empty when the translator skipped type inference (rare; some tests do). */
  columnTypes: Record<string, PrimitiveType>;
  /** Whether each of those columns can hold `null`, keyed the same way. The other
   *  half of the declared type: it decides whether a NULL there is the `null` value
   *  or an absence. Empty on the same paths `columnTypes` is. */
  columnNullable: Record<string, boolean>;
}

export interface IncrementalResult {
  /** EDB declarations applied (table created + data loaded) by this chunk. */
  declarations: DeclarationApplied[];
  /** IDB predicates whose view was created by this chunk. */
  rules: RuleApplied[];
  /** Results from queries appearing in this chunk. */
  queries: QueryResultWithTypes[];
}

/**
 * Per-chunk incremental driver for the REPL. State across chunks: the
 * accumulated AST, the set of EDB/IDB predicates already materialised in
 * the backend, and the set of queries already executed. Each
 * `addStatements` call re-runs analyse/type-infer/translate over the
 * full accumulated program, then applies only the deltas to the backend.
 *
 * v1 forbids redefinition: a chunk that re-declares an EDB predicate
 * already created, or adds a rule for a predicate whose view already
 * exists, is rejected. Users restart with `IncrementalSession.reset()`
 * (or, in the REPL, `:reset`).
 */
export class IncrementalSession {
  private statements: Statement[] = [];
  private appliedTables = new Set<string>();
  private appliedViews = new Set<string>();
  // Named outputs (`output predicate`) come from accumulated rules and are
  // re-synthesised on every re-analysis; this tracks which have already been
  // emitted so each prints once, not once per subsequent chunk.
  private appliedOutputs = new Set<string>();
  // `error predicate` names already checked. A constraint is checked once, when
  // it is declared: a session is built up a statement at a time, so a constraint
  // that held when written must not fail later because a subsequent chunk added
  // a row it forbids. `!-` statements need no tracking — they are queries, so
  // they are never accumulated and are only ever present in their own chunk.
  private appliedConstraints = new Set<string>();
  private lastTyped: TypedProgram | undefined;
  private loaders: ExtensionalLoader[];

  constructor(
    private backend: Backend,
    loaders: ExtensionalLoader[] = [],
  ) {
    this.loaders = [...loaders];
  }

  addLoader(loader: ExtensionalLoader): void {
    this.loaders.push(loader);
  }

  /** Read-only view of the accumulated typed program after the most
   *  recent successful chunk. `undefined` until at least one chunk has
   *  been added. */
  get typedProgram(): TypedProgram | undefined {
    return this.lastTyped;
  }

  /** Read-only view of the accumulated statements (in source order). */
  get accumulatedStatements(): readonly Statement[] {
    return this.statements;
  }

  /**
   * Parse and apply a chunk of source. The chunk may contain any number
   * of declarations, rules, and queries. On success the session's
   * accumulated state grows; on failure (parse, analyse, redefinition)
   * the state is left untouched and the error propagates.
   */
  async addStatements(source: string): Promise<IncrementalResult> {
    const fragment = parseRaw(
      source,
      undefined,
      this.statements.filter((s) => s.$type === "TypeAlias"),
      this.statements,
    );

    this.checkRedefinition(fragment.statements);
    postProcess(fragment, this.statements);

    // Build a synthetic Program for re-analysis. The analyzer reads only
    // `program.statements`; downstream stages key off the resulting maps,
    // so we don't need to fix up `$container` references on the merged
    // node. Copy the fragment's other AST-node fields to satisfy the
    // type, but the analyser never inspects them.
    const merged: Program = {
      ...fragment,
      statements: [...this.statements, ...fragment.statements],
    } as Program;

    const analyzed = inferTypes(analyze(merged));

    // Narrow the program to the constraints this chunk introduces, so both apply
    // paths (which check whatever `analyzed.constraints` holds) check each one
    // exactly once, at its declaration.
    const freshConstraints = analyzed.constraints.filter(
      (c) => c.outputName === undefined || !this.appliedConstraints.has(c.outputName),
    );
    analyzed.constraints = freshConstraints;

    // Run the apply phase first — only commit the merged AST if it
    // succeeds. Backend state (tables, views, loaded rows) can still be
    // partially mutated by a mid-apply failure; the user is expected to
    // `:reset` to recover cleanly. But the AST rollback at least lets the
    // next chunk re-introduce the failing declaration without tripping
    // the analyzer's "declared multiple times" check.
    const result = this.backend.evaluateProgram
      ? await this.applyNative(analyzed, fragment.statements)
      : await this.applySql(analyzed);

    // Reached only when no constraint was violated, so marking them checked here
    // (rather than when filtering above) lets a rejected chunk be re-entered.
    for (const c of freshConstraints) {
      if (c.outputName !== undefined) this.appliedConstraints.add(c.outputName);
    }

    // A `?-` query is a one-shot question, not part of the program being
    // built, so it is not accumulated. Keeping only declarations and rules
    // lets a session ask many queries in turn without them piling up and
    // tripping the one-default-output rule.
    this.statements = merged.statements.filter((s) => s.$type !== "Query");
    this.lastTyped = analyzed;
    return result;
  }

  /**
   * Translate (without committing) what the SQL for a single query
   * would look like in the current session's context. Used by the
   * REPL's `:sql` command.
   *
   * Throws if `source` parses to anything other than a single `?-` query
   * statement, or if the backend has no SQL dialect.
   */
  peekSql(source: string): string {
    if (!this.backend.sqlDialect) {
      throw new Error("Cannot preview SQL: backend has no SQL dialect");
    }
    const fragment = parse(
      source,
      undefined,
      this.statements.filter((s) => s.$type === "TypeAlias"),
      this.statements,
    );
    if (fragment.statements.length !== 1 || fragment.statements[0]!.$type !== "Query") {
      throw new Error(":sql expects a single query of the form '?- atom.'");
    }
    const merged: Program = {
      ...fragment,
      statements: [...this.statements, ...fragment.statements],
    } as Program;
    const analyzed = inferTypes(analyze(merged));
    const translation = translate(analyzed, this.backend.sqlDialect);
    return translation.queries[translation.queries.length - 1] ?? "";
  }

  private checkRedefinition(stmts: Statement[]): void {
    // Within a single chunk, multiple rules for one new predicate are fine
    // (and standard Datalog). The redefinition check fires only when a
    // statement names a predicate defined in a *previous* chunk. That set is
    // the committed AST (`this.statements`), not the backend-applied sets:
    // the AST is rolled back when a chunk throws mid-apply, so a predicate
    // declared before a failing statement can still be re-introduced later
    // rather than wedging the session (the applied sets are not rolled back).
    const defined = new Set<string>();
    for (const stmt of this.statements) {
      if (stmt.$type === "ExtDecl") defined.add(stmt.predicate);
      else if (stmt.$type === "Rule") defined.add(stmt.head.predicate);
    }
    for (const stmt of stmts) {
      if (stmt.$type === "ExtDecl") {
        const name = typeAliasName(stmt.predicate);
        if (defined.has(name)) throw redefinitionError(name, stmt);
      } else if (stmt.$type === "Rule") {
        const name = typeAliasName(stmt.head.predicate);
        if (defined.has(name)) throw redefinitionError(name, stmt);
      }
    }
  }

  private async applySql(analyzed: TypedProgram): Promise<IncrementalResult> {
    const dialect = this.backend.sqlDialect;
    if (!dialect) {
      throw new Error(
        "Backend has no sqlDialect and no evaluateProgram — cannot run incremental session",
      );
    }
    const translation = translate(analyzed, dialect);

    const declarations: DeclarationApplied[] = [];
    // `analyzed.extDecls` and `translation.createTables` share insertion
    // order (translateTables iterates the same Map). Walk them in lockstep
    // and apply only the predicates we haven't materialised yet.
    let tableIdx = 0;
    for (const [pred, decl] of analyzed.extDecls) {
      const tableSql = translation.createTables[tableIdx++]!;
      if (this.appliedTables.has(pred)) continue;
      await this.backend.execute(tableSql);
      let rowsLoaded = 0;
      for (const loader of this.loaders) {
        if (await loader.canLoad(decl)) {
          const result = await loader.load(decl, this.backend);
          rowsLoaded = result.rowsLoaded;
          break;
        }
      }
      this.appliedTables.add(pred);
      declarations.push({ predicate: pred, arity: decl.columns.length, rowsLoaded });
    }

    const rules: RuleApplied[] = [];
    for (let i = 0; i < translation.createViews.length; i++) {
      const pred = translation.viewPredicates[i]!;
      if (this.appliedViews.has(pred)) continue;
      await this.backend.execute(translation.createViews[i]!);
      this.appliedViews.add(pred);
      rules.push({ predicate: pred, arity: analyzed.arities.get(pred) ?? 0 });
    }

    // Check this chunk's constraints before running its queries, so a violated
    // chunk produces no results. `analyzed.constraints` has already been narrowed
    // to the fresh ones by `addStatements`.
    const violations: ConstraintViolation[] = [];
    for (let i = 0; i < translation.constraints.length; i++) {
      const rawRows = await this.backend.execute(translation.constraints[i]!);
      if (rawRows.length === 0) continue;
      const colTypes = translation.constraintColumnTypes[i] ?? {};
      violations.push(
        toViolation(analyzed.constraints[i]!, projectConstraintRows(rawRows, colTypes)),
      );
    }
    if (violations.length > 0) {
      throw new ConstraintViolationError(violations, analyzed.sourceFile);
    }

    const queries: QueryResultWithTypes[] = [];
    for (let i = 0; i < analyzed.queries.length; i++) {
      const q = analyzed.queries[i]!;
      const name = q.outputName;
      // An `output predicate` emits once, keyed by name: it comes from a
      // persistent rule the analyzer re-synthesises every chunk. A `?-` query
      // (including one named "default") is transient and always runs.
      if (q.isOutput && name) {
        if (this.appliedOutputs.has(name)) continue;
        this.appliedOutputs.add(name);
      }
      const querySql = translation.queries[i]!;
      const rawRows = await this.backend.execute(querySql);
      const colTypes = translation.queryColumnTypes[i] ?? {};
      // All three, in the same order as `executor.ts` and `constraints.ts`.
      // Dropping the numeric one left Postgres `BIGINT`/`NUMERIC` columns as the
      // strings `Bun.sql` returns, so a REPL result contradicted the `types` it
      // was reported with and `datamog-magic`'s DataFrame got an object dtype.
      const boolCoerced = coerceBooleanColumns(rawRows, colTypes);
      const numCoerced = coerceNumericColumns(boolCoerced, colTypes);
      const rows = coerceJsonColumns(numCoerced, colTypes);
      queries.push({
        sql: querySql,
        source: q.$cstNode?.text,
        label: name,
        rows,
        columnTypes: colTypes,
        columnNullable: translation.queryColumnNullable[i] ?? {},
      });
    }

    return { declarations, rules, queries };
  }

  private async applyNative(
    analyzed: TypedProgram,
    fragmentStmts: Statement[],
  ): Promise<IncrementalResult> {
    if (!this.backend.evaluateProgram) {
      throw new Error("Native backend missing evaluateProgram");
    }
    // Native backends consume the whole TypedProgram at once. Re-running
    // is safe because the native EDB ingest path dedups by row (the
    // evaluator stores rows in a Set), so loaders firing again for an
    // already-loaded predicate is idempotent.
    const allResults = await this.backend.evaluateProgram(analyzed, this.loaders);

    const declarations: DeclarationApplied[] = [];
    for (const stmt of fragmentStmts) {
      if (stmt.$type !== "ExtDecl") continue;
      if (this.appliedTables.has(stmt.predicate)) continue;
      this.appliedTables.add(stmt.predicate);
      declarations.push({
        predicate: stmt.predicate,
        arity: stmt.columns.length,
        rowsLoaded: undefined,
      });
    }

    const rules: RuleApplied[] = [];
    for (const stmt of fragmentStmts) {
      if (stmt.$type !== "Rule") continue;
      const pred = stmt.head.predicate;
      if (this.appliedViews.has(pred)) continue;
      this.appliedViews.add(pred);
      rules.push({ predicate: pred, arity: analyzed.arities.get(pred) ?? 0 });
    }

    const queries: QueryResultWithTypes[] = [];
    for (let i = 0; i < analyzed.queries.length; i++) {
      const q = analyzed.queries[i]!;
      const name = q.outputName;
      if (q.isOutput && name) {
        if (this.appliedOutputs.has(name)) continue;
        this.appliedOutputs.add(name);
      }
      const r = allResults[i];
      // Native backends don't surface a per-query column-type map at this
      // layer — the translator does, but we don't run it for native. Emit
      // empty maps; consumers infer from row values. `r.label` already
      // carries the output name (set by evaluateProgram).
      if (r) queries.push({ ...r, columnTypes: {}, columnNullable: {} });
    }

    return { declarations, rules, queries };
  }
}

function redefinitionError(
  predicate: string,
  node: { $cstNode?: { offset: number; end: number } },
) {
  const cst = node.$cstNode;
  return new AnalyzerError(
    `Predicate '${predicate}' was defined in an earlier chunk and cannot be extended; use :reset to start over`,
    cst?.offset,
    cst?.end,
  );
}
