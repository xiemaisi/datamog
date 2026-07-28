import { isExtDecl, isRule } from "datamog-parser";
import { AnalyzerError, queryProjection } from "./analyzer.ts";
import { asCoreRule } from "./ast.ts";
import type { Binding, ExtDecl, PrimitiveType, Program, Query, Rule, Statement } from "./ast.ts";
import { expandModule } from "./expand.ts";
import { type TypedProgram, columnTypesCompatible } from "./types.ts";

/** A module a `ModuleResolver` handed back: its raw (pre-post-process) AST and
 *  the file it was read from (for resolving that module's own relative paths). */
export interface ResolvedModule {
  program: Program;
  file?: string;
}

/**
 * Resolves a module reference (the string after `from`) to its parsed module,
 * relative to the importing file. It **must return a fresh parse each call**:
 * `elaborate` mutates the returned AST in place, so importing one module twice
 * needs two independent copies. The file I/O and `parseRaw` live in the caller
 * (Bun CLI / VS Code), keeping `elaborate` itself free of filesystem access.
 */
export type ModuleResolver = (ref: string, importerFile: string | undefined) => ResolvedModule;

/** A data-file input binding, flattened out for the executor's loader setup. */
export interface DataSource {
  /** The merged-program predicate this data loads into. */
  predicate: string;
  /** The source string (a path/URL; the parser already stripped the quotes). */
  source: string;
  /** A loader format forced with `as <format>`, when the extension does not say. */
  format?: string;
  /** The file the source is resolved relative to (`undefined` for stdin). */
  baseFile?: string;
}

/**
 * A type contract at a module boundary: the merged-program `predicate` must,
 * once types are inferred, have column types compatible with `expected`. Both
 * the actual-vs-input and output-vs-declaration boundaries reduce to this — the
 * declared types they check against are dropped during elaboration, so ordinary
 * inference cannot see them. Checked by `checkModuleBoundaries` after inference.
 */
export interface BoundaryConstraint {
  predicate: string;
  expected: PrimitiveType[];
  /** Human-readable description of the boundary, for the error message. */
  note: string;
  /** Source position (offset, end) of the binding. */
  pos: [number, number] | [];
  /** File the position refers to (the importer's file). */
  file?: string;
}

export interface ElaborationResult {
  /** The merged program, still raw: the caller post-processes then analyzes it. */
  program: Program;
  /** Data-file bindings, for the caller to wire loaders to explicit sources. */
  dataSources: DataSource[];
  /** Boundary type contracts, for `checkModuleBoundaries` after inference. */
  boundaries: BoundaryConstraint[];
}

function nodePos(node: { $cstNode?: { offset: number; end: number } }): [number, number] | [] {
  return node.$cstNode ? [node.$cstNode.offset, node.$cstNode.end] : [];
}

/** Shared state threaded through the recursive instantiation. */
interface Context {
  resolve: ModuleResolver;
  out: Statement[];
  dataSources: DataSource[];
  boundaries: BoundaryConstraint[];
  /** Monotonic counter for per-instance prefixes, unique across the whole run. */
  counter: { n: number };
}

/**
 * Elaborate a program's `:=` source bindings into one flat program plus a list
 * of data sources, driving `expandModule` for each module instantiation.
 *
 * Handles the entry's bindings and, recursively, any module a referenced module
 * imports in turn, selecting a named `output predicate` or the module's unnamed
 * `?-` default output. The *instantiation* graph (module A wiring an input to an
 * instance of B) must be acyclic; a cycle is rejected. (Recursion *within* a
 * module is fine: that is an ordinary least fixed point over the merged program.)
 *
 * Also collects the boundary type contracts (see `BoundaryConstraint`) for the
 * caller to check with `checkModuleBoundaries` once types are inferred.
 */
export function elaborate(
  entry: Program,
  resolve: ModuleResolver,
  entryFile?: string,
): ElaborationResult {
  const ctx: Context = { resolve, out: [], dataSources: [], boundaries: [], counter: { n: 0 } };

  for (const stmt of entry.statements) {
    if (!isExtDecl(stmt) || !stmt.binding) {
      ctx.out.push(stmt);
      continue;
    }
    const binding = stmt.binding;
    if (!binding.isModule) {
      // Data file: keep the input as a free EDB, record its explicit source.
      recordDataSource(stmt, binding, entryFile, ctx.dataSources);
      ctx.out.push(stmt);
      continue;
    }
    // The entry's binding is user-facing: rename the module's selected output to
    // the input's declared name, relabel its columns to the declared columns,
    // and keep it exposed so it prints.
    const mod = resolve(binding.source, entryFile);
    const id = mod.file ?? binding.source;
    checkCycle(id, [entryFile], stmt);
    const exportName = prepareModule(mod.program, binding.export, stmt, true);
    collectBoundaries(ctx, mod.program, binding, stmt, entryFile, stmt.predicate, (a) => a);
    const inputs: Record<string, string> = {};
    for (const actual of binding.actuals) inputs[actual.param] = actual.arg;
    instantiate(
      mod.program,
      mod.file,
      `${stmt.predicate}$${ctx.counter.n++}$`,
      inputs,
      { export: exportName, as: stmt.predicate },
      stmt.columns.map((c) => c.name),
      [entryFile, id],
      ctx,
      binding.source,
    );
  }

  entry.statements = ctx.out;
  return { program: entry, dataSources: ctx.dataSources, boundaries: ctx.boundaries };
}

/**
 * Record the type contracts for one binding: each actual's merged predicate must
 * match the module input it is wired to, and the selected output's merged
 * predicate must match the importer's declared columns. `mergedActual` maps an
 * actual's name in the importer's scope to its merged-program name.
 */
function collectBoundaries(
  ctx: Context,
  module: Program,
  binding: Binding,
  importerDecl: ExtDecl,
  importerFile: string | undefined,
  aliasedOutput: string,
  mergedActual: (name: string) => string,
): void {
  const inputs = new Map<string, ExtDecl>();
  for (const s of module.statements) if (isExtDecl(s)) inputs.set(s.predicate, s);
  for (const actual of binding.actuals) {
    const inputDecl = inputs.get(actual.param);
    if (!inputDecl) continue;
    ctx.boundaries.push({
      predicate: mergedActual(actual.arg),
      // An unannotated column defaults to `string` (parseRaw already sets this).
      expected: inputDecl.columns.map((c) => c.type ?? "string"),
      note: `actual '${actual.arg}' wired to input '${actual.param}' of "${binding.source}"`,
      pos: nodePos(importerDecl),
      file: importerFile,
    });
  }
  ctx.boundaries.push({
    predicate: aliasedOutput,
    expected: importerDecl.columns.map((c) => c.type ?? "string"),
    note: `output of "${binding.source}" bound to '${importerDecl.predicate}'`,
    pos: nodePos(importerDecl),
    file: importerFile,
  });
}

/**
 * Check the boundary type contracts collected by `elaborate` against the merged
 * program's inferred column types. Run after `inferTypes`. Throws an
 * `AnalyzerError` (carrying the importer's file/position) on an arity or type
 * mismatch that ordinary inference could not see, because the declared types
 * were dropped when the binding was elaborated away.
 */
export function checkModuleBoundaries(typed: TypedProgram, boundaries: BoundaryConstraint[]): void {
  for (const b of boundaries) {
    // Compare against the published type (the predicate's advertised contract),
    // not its inferred type, so a predicate declared wider than it currently
    // produces is held to its declaration across the boundary — the same
    // assume-guarantee contract that applies within a program.
    const actual = typed.publishedTypes.get(b.predicate);
    // A missing predicate (e.g. an actual that names nothing) is left to the
    // analyzer's own reporting; there is no type to compare here.
    if (!actual) continue;
    if (actual.length !== b.expected.length) {
      throw boundaryError(
        `${b.note}: expected ${b.expected.length} column(s) but the wired predicate has ${actual.length}`,
        b,
      );
    }
    for (let i = 0; i < b.expected.length; i++) {
      if (!columnTypesCompatible(actual[i]!, b.expected[i]!)) {
        throw boundaryError(
          `${b.note}: column ${i + 1} has type '${actual[i]}' but '${b.expected[i]}' was declared`,
          b,
        );
      }
    }
  }
}

function boundaryError(message: string, b: BoundaryConstraint): AnalyzerError {
  const err = new AnalyzerError(message, ...b.pos);
  err.file = b.file;
  return err;
}

/**
 * Expand one module instance into `ctx.out`. `inputSubst` maps this module's
 * inputs (those wired by the caller) to their merged-program names. Before
 * expanding, resolve this module's own module-bound inputs by recursively
 * instantiating each and feeding its output into the corresponding input.
 * `exportAs`/`relabelColumns` are set only for a user-facing (entry-level)
 * instance; a nested instance freshens its selected output the normal way.
 */
function instantiate(
  module: Program,
  file: string | undefined,
  prefix: string,
  inputSubst: Record<string, string>,
  exportAs: { export: string; as: string } | undefined,
  relabelColumns: string[] | undefined,
  stack: (string | undefined)[],
  ctx: Context,
  sourceRef: string,
): void {
  const localNames = new Set<string>();
  for (const s of module.statements) if (isRule(s)) localNames.add(s.head.predicate);
  // How a name in this module's scope reads in the merged program (mirrors
  // expandModule's own renaming), used to resolve a nested import's actuals.
  const renameName = (name: string): string =>
    Object.hasOwn(inputSubst, name)
      ? inputSubst[name]!
      : localNames.has(name)
        ? `${prefix}${name}`
        : name;

  for (const s of module.statements) {
    if (!isExtDecl(s) || !s.binding?.isModule) continue;
    const binding = s.binding;
    const child = ctx.resolve(binding.source, file);
    const id = child.file ?? binding.source;
    checkCycle(id, stack, s);
    // A nested instance's output feeds a parent input, so it is not exposed.
    const childExport = prepareModule(child.program, binding.export, s, false);
    const childPrefix = `${s.predicate}$${ctx.counter.n++}$`;
    collectBoundaries(
      ctx,
      child.program,
      binding,
      s,
      file,
      `${childPrefix}${childExport}`,
      renameName,
    );
    const childInputs: Record<string, string> = {};
    for (const actual of binding.actuals) childInputs[actual.param] = renameName(actual.arg);
    instantiate(
      child.program,
      child.file,
      childPrefix,
      childInputs,
      undefined,
      undefined,
      [...stack, id],
      ctx,
      binding.source,
    );
    // The nested instance's (prefix-freshened) selected output feeds this input.
    inputSubst[s.predicate] = `${childPrefix}${childExport}`;
  }

  // Every module input must be supplied — wired by an actual (now in
  // `inputSubst`) or bound with `:=` (a data or module binding). A free input
  // that is neither is an error: a module never auto-loads its inputs; supplying
  // them is the importer's job (wire it) or the module's (`:= "file"`).
  for (const s of module.statements) {
    if (isExtDecl(s) && !s.binding && !Object.hasOwn(inputSubst, s.predicate)) {
      throw new AnalyzerError(
        `module '${sourceRef}' input '${s.predicate}' is not supplied; wire it with an actual (${s.predicate} = ...) or bind it with ':='`,
      );
    }
  }

  const expanded = expandModule(module, { prefix, inputs: inputSubst, exportAs });
  if (exportAs && relabelColumns) relabelOutputColumns(expanded, exportAs.as, relabelColumns);
  // A kept data-bound / free input carrying a data binding: record and clear it,
  // relative to this module's own file.
  for (const s of expanded) {
    if (isExtDecl(s) && s.binding) recordDataSource(s, s.binding, file, ctx.dataSources);
  }
  ctx.out.push(...expanded);
}

const DEFAULT_OUTPUT = "$default";

/**
 * Prepare a freshly-resolved module for expansion: choose the selected output
 * (synthesising a `$default` output rule from the module's `?-` query when no
 * export was named), drop the module's `?-` queries so its default does not leak
 * into the merged program, and expose only the selected output (the module's
 * other outputs stay as plain IDB rules, still usable as dependencies).
 * `exposeSelected` keeps the selected output's marker so it prints; a nested
 * instance passes `false` (its output feeds a parent input, not a result).
 * Returns the selected output's name.
 */
function prepareModule(
  module: Program,
  requestedExport: string | undefined,
  decl: ExtDecl,
  exposeSelected: boolean,
): string {
  const exportName = requestedExport ?? synthesizeDefaultOutput(module, decl);
  // Drop the module's `?-` queries so its default output does not leak into the
  // merged program, but keep its `!-` constraints: a module's integrity
  // constraints hold wherever it is instantiated. `error predicate` rules need
  // no special handling here — the loop below only clears `output` markers.
  module.statements = module.statements.filter((s) => s.$type !== "Query" || (s as Query).isError);
  let found = false;
  for (const s of module.statements) {
    if (!isRule(s) || !s.output) continue;
    if (s.head.predicate === exportName) {
      found = true;
      if (!exposeSelected) s.output = false;
    } else {
      s.output = false;
    }
  }
  if (!found) {
    throw new AnalyzerError(
      `module '${decl.binding?.source}' has no output named '${exportName}'`,
      ...nodePos(decl),
    );
  }
  return exportName;
}

/** Convert the module's single `?-` default output into a named `$default`
 *  output rule, so default-output selection reuses the named-export path. */
function synthesizeDefaultOutput(module: Program, decl: ExtDecl): string {
  // Constraints are `!-` statements, not candidate default outputs.
  const queries = module.statements.filter((s) => s.$type === "Query" && !(s as Query).isError);
  if (queries.length !== 1) {
    const how = queries.length === 0 ? "no" : "more than one";
    throw new AnalyzerError(
      `module '${decl.binding?.source}' has ${how} default output (a \`?-\` query); name an output with \`export from\``,
      ...nodePos(decl),
    );
  }
  const q = queries[0] as Query;
  const args = queryProjection(q).map((t) => ({
    $type: "Variable",
    name: (t as { name: string }).name,
  }));
  const rule = q as unknown as Record<string, unknown>;
  rule.$type = "Rule";
  rule.head = { $type: "HeadAtom", predicate: DEFAULT_OUTPUT, args };
  rule.output = true;
  return DEFAULT_OUTPUT;
}

function checkCycle(id: string, stack: (string | undefined)[], decl: ExtDecl): void {
  if (stack.includes(id)) {
    const path = [...stack, id].filter((s): s is string => s !== undefined).join(" -> ");
    throw new AnalyzerError(`module import cycle: ${path}`, ...nodePos(decl));
  }
}

/** Call `fn` for every `Variable` node reachable from `node`. */
function eachVar(node: unknown, fn: (v: { name: string }) => void): void {
  if (!node || typeof node !== "object" || !("$type" in node)) return;
  const n = node as Record<string, unknown>;
  if (n.$type === "Variable" && typeof n.name === "string") fn(n as { name: string });
  for (const key of Object.keys(n)) {
    if (key.startsWith("$")) continue;
    const v = n[key];
    if (Array.isArray(v)) for (const el of v) eachVar(el, fn);
    else eachVar(v, fn);
  }
}

/** Rename the head-position variables of each rule of `outputPred` to the
 *  importer's declared column names (positionally), so the synthesised output
 *  query names its columns after the interface, not the module's head vars. */
function relabelOutputColumns(
  statements: Statement[],
  outputPred: string,
  columnNames: string[],
): void {
  for (const stmt of statements) {
    if (isRule(stmt) && stmt.head.predicate === outputPred)
      relabelRuleHead(asCoreRule(stmt), columnNames);
  }
}

function relabelRuleHead(rule: Rule, columnNames: string[]): void {
  const args = rule.head.args;
  if (args.length !== columnNames.length) return; // arity mismatch: leave it (checked later)
  const rename = new Map<string, string>(); // module head var -> declared column name
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as { $type: string; name?: string };
    if (arg.$type !== "Variable" || arg.name === undefined) continue;
    if (rename.has(arg.name) && rename.get(arg.name) !== columnNames[i]) return; // repeated head var
    rename.set(arg.name, columnNames[i]!);
  }
  const sources = new Set(rename.keys());
  const targets = new Set(rename.values());
  // Move any internal (body) variable that already bears a target name aside to
  // a `$`-name first (users cannot write `$`), so the rename cannot capture it.
  const clash = new Map<string, string>();
  eachVar(rule, (v) => {
    if (targets.has(v.name) && !sources.has(v.name)) clash.set(v.name, `$c$${v.name}`);
  });
  eachVar(rule, (v) => {
    const next = rename.get(v.name) ?? clash.get(v.name);
    if (next !== undefined) v.name = next;
  });
}

/** Record a data-file binding and clear it from the declaration, so the merged
 *  program has no bindings left for the analyzer to reject. */
function recordDataSource(
  decl: ExtDecl,
  binding: Binding,
  baseFile: string | undefined,
  dataSources: DataSource[],
): void {
  dataSources.push({
    predicate: decl.predicate,
    source: binding.source,
    format: binding.format,
    baseFile,
  });
  decl.binding = undefined;
}
