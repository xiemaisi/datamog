import {
  AnalyzerError,
  type DataSource,
  type ModuleResolver,
  type TypedProgram,
  analyze,
  checkModuleBoundaries,
  elaborate,
  inferTypes,
} from "datamog-core";
import { ParseError, parse, parseRaw, postProcess } from "datamog-parser";
import type { Backend, QueryResult } from "./backend.ts";
import {
  type ConstraintViolation,
  ConstraintViolationError,
  projectConstraintRows,
  toViolation,
} from "./constraints.ts";
import { type ExtensionalLoader, loadExtensionalData } from "./loader.ts";
import { coerceBooleanColumns, coerceJsonColumns } from "./result-coerce.ts";
import { translate } from "./translator.ts";

export type { QueryResult } from "./backend.ts";

export class DatamogExecutor {
  private loaders: ExtensionalLoader[] = [];

  constructor(
    private backend: Backend,
    loaders: ExtensionalLoader[] = [],
  ) {
    this.loaders = [...loaders];
  }

  addLoader(loader: ExtensionalLoader): void {
    this.loaders.push(loader);
  }

  /**
   * Parse + analyse + type-infer a Datalog source. Exposed so callers
   * who need access to the analysed program (e.g. the playground worker
   * for schema/strata/rule-source extraction) can avoid a second
   * round-trip through the parser.
   */
  static prepare(source: string, file?: string): TypedProgram {
    return inferTypes(analyze(parse(source, file), file));
  }

  /**
   * Like {@link prepare}, but first elaborates the program's `:=` source
   * bindings (module imports and data-file bindings) into one merged program,
   * resolving `from` imports via `resolve`. Returns the analysed program plus
   * the data-file bindings for the caller to wire loaders to (see
   * `DataSource`). Boundary types are checked. `resolve` is injected so the
   * engine itself stays free of filesystem access; a Node/Bun resolver lives on
   * the `datamog-engine/module-resolver` subpath.
   */
  static prepareElaborated(
    source: string,
    resolve: ModuleResolver,
    file?: string,
  ): { program: TypedProgram; dataSources: DataSource[] } {
    const raw = parseRaw(source, file);
    let elaborated: ReturnType<typeof elaborate>;
    try {
      elaborated = elaborate(raw, resolve, file);
    } catch (e) {
      if (e instanceof AnalyzerError) e.file ??= file;
      throw e;
    }
    try {
      postProcess(elaborated.program);
    } catch (e) {
      if (e instanceof ParseError) e.file ??= file;
      throw e;
    }
    const program = inferTypes(analyze(elaborated.program, file));
    checkModuleBoundaries(program, elaborated.boundaries);
    return { program, dataSources: elaborated.dataSources };
  }

  async execute(source: string, file?: string): Promise<QueryResult[]> {
    return this.executeAnalyzed(DatamogExecutor.prepare(source, file));
  }

  /**
   * Run an already-analysed program. Useful when the caller has a
   * `TypedProgram` from `DatamogExecutor.prepare(source)` and wants to
   * skip the parse + analyse pair inside `execute(source)`.
   */
  async executeAnalyzed(analyzed: TypedProgram): Promise<QueryResult[]> {
    // Native-evaluation backends short-circuit the SQL pipeline.
    if (this.backend.evaluateProgram) {
      return this.backend.evaluateProgram(analyzed, this.loaders);
    }

    if (!this.backend.sqlDialect) {
      throw new Error(
        "Backend has no sqlDialect and no evaluateProgram — cannot execute the program",
      );
    }
    const translation = translate(analyzed, this.backend.sqlDialect);

    // 1. Create tables
    for (const stmt of translation.createTables) {
      await this.backend.execute(stmt);
    }

    // 2. Load extensional data
    await loadExtensionalData(analyzed, this.loaders, this.backend);

    // 3. Create views
    for (const stmt of translation.createViews) {
      await this.backend.execute(stmt);
    }

    // 4. Check integrity constraints, before any query runs: a violated program
    // produces no results at all.
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

    // 5. Execute queries
    const results: QueryResult[] = [];
    const queries = analyzed.queries;
    const settledResults = await Promise.allSettled(
      translation.queries.map(async (querySql, i) => {
        const rawRows = await this.backend.execute(querySql);
        const colTypes = translation.queryColumnTypes[i] ?? {};
        const boolCoerced = coerceBooleanColumns(rawRows, colTypes);
        const coerced = coerceJsonColumns(boolCoerced, colTypes);
        // Project each row to only the columns we want to expose.
        // For ground queries (colTypes is empty) this strips the
        // SQL-level `__probe` column and leaves `{}` per matching
        // row — exactly the "yes" signal the CLI / playground use.
        const projectionKeys = Object.keys(colTypes);
        const rows = coerced.map((row) => {
          const out: Record<string, unknown> = {};
          for (const key of projectionKeys) {
            out[key] = row[key];
          }
          return out;
        });
        const source = queries[i]?.$cstNode?.text;
        return { sql: querySql, source, label: queries[i]?.outputName, rows };
      }),
    );

    for (const result of settledResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        throw result.reason;
      }
    }

    return results;
  }
}
