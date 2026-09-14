import { type NominalReference, typeAliasName, visitNominalReferences } from "datamog-parser";
import { isExtDecl, isFunctionCall, isLiteral, isRule } from "datamog-parser";
import { AnalyzerError, queryProjection } from "./analyzer.ts";
import { asCoreRule } from "./ast.ts";
import type { Binding, ExtDecl, PrimitiveType, Program, Query, Rule, Statement } from "./ast.ts";
import { expandModule } from "./expand.ts";
import { semanticContractMismatch } from "./semantic-diagnostics.ts";
import type { SemanticType } from "./semantic-type.ts";
import { declaredColumnType } from "./structural-declarations.ts";
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
 * A type-and-polarity contract at a module boundary: the merged-program
 * `predicate` must, once types are inferred, have the declared polarity and
 * column types compatible with `expected`. Both
 * the actual-vs-input and output-vs-declaration boundaries reduce to this — the
 * declarations they check against are dropped during elaboration, so ordinary
 * analysis cannot see their contracts. Checked by `checkModuleBoundaries` after
 * inference.
 */
export interface BoundaryConstraint {
  predicate: string;
  expected: PrimitiveType[];
  /** Retained structural contracts from declarations erased by elaboration. */
  expectedShapes?: (SemanticType | undefined)[];
  /** Type-name checks survive declarations removed during wiring. */
  nominalReferences?: NominalReference[];
  /** Whether the declaration on the other side of the boundary carries `^`. */
  expectedMaximal: boolean;
  /**
   * Per column, whether the declaration permits a NULL there (`integer?`).
   * Same direction as `expected`: the wired predicate may be narrower than the
   * declaration but never wider, so a nullable relation cannot be wired into a
   * column declared without `?`.
   */
  expectedNullable: boolean[];
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
  /**
   * Instance cache, keyed by `instanceKey`. Two bindings of the same module with
   * the same wiring denote the same relations, so they share one expansion and
   * each import site binds its own name to the output it selected.
   */
  instances: Map<string, Instance>;
  /**
   * Declared name -> the predicate it actually denotes, for a site whose selected
   * output was renamed for an earlier site (see `bindLocalName`). Applied to the
   * whole merged program once every binding is resolved.
   */
  nameAliases: Map<string, string>;
}

/** One expansion of a module, shared by every binding that agrees on the wiring. */
interface Instance {
  /** Prefix its private and output predicate names were freshened with. */
  prefix: string;
  /** Outputs renamed out of the prefix scheme: export name -> merged predicate. */
  renamed: Map<string, string>;
  resolveName: (name: string) => string;
}

/**
 * Identify an instance by what determines its meaning: the module it came from
 * and the predicates its inputs are wired to. Inputs left on a `:=` default are
 * absent from `wiring` and need no representation — how a default resolves is a
 * function of the module (already in the key), so equal keys have equal
 * defaults. Actual order is not significant, hence the sort.
 */
function instanceKey(moduleId: string, wiring: Record<string, string>): string {
  const pairs = Object.entries(wiring)
    .map(([param, arg]) => `${param}=${arg}`)
    .sort();
  return `${moduleId}\x00${pairs.join(",")}`;
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
  const ctx: Context = {
    resolve,
    out: [],
    dataSources: [],
    boundaries: [],
    counter: { n: 0 },
    instances: new Map(),
    nameAliases: new Map(),
  };

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
    const mod = resolve(binding.source, entryFile);
    const id = mod.file ?? binding.source;
    checkCycle(id, [entryFile], stmt);
    const selected = prepareModule(mod.program, binding.export, stmt, true);
    const actualBoundaries = collectActualBoundaries(
      ctx,
      mod.program,
      binding,
      stmt,
      entryFile,
      (a) => a,
    );
    const wiring: Record<string, string> = {};
    for (const actual of binding.actuals) wiring[actual.param] = actual.arg;
    const columns = stmt.columns.map((c) => c.name);
    const instance = instantiate(
      mod.program,
      mod.file,
      stmt.predicate,
      wiring,
      // A proof-carrying output is renamed to this site's name (see `renamed`);
      // if the instance already exists the rename happens after the fact.
      selected.proofCarrying ? { export: selected.name, as: stmt.predicate, columns } : undefined,
      [entryFile, id],
      ctx,
      binding.source,
    );
    remapBoundaryShapes(actualBoundaries, instance.resolveName);
    const output = bindLocalName(ctx, instance, selected, stmt, columns);
    ctx.boundaries.push(outputBoundary(binding, stmt, entryFile, output));
  }

  // Name-level aliases resolve last, so a reference anywhere in the entry — a
  // body atom, a proof capture, or a constructor qualifier — reaches the shared
  // predicate no matter which binding it was written against.
  for (const stmt of ctx.out) applyNameAliases(stmt, ctx.nameAliases);
  for (const boundary of ctx.boundaries) {
    boundary.predicate = ctx.nameAliases.get(boundary.predicate) ?? boundary.predicate;
    for (const ref of boundary.nominalReferences ?? [])
      ref.predicate = typeAliasName(ctx.nameAliases.get(ref.predicate) ?? ref.predicate);
    boundary.expectedShapes = boundary.expectedShapes?.map(
      (shape) =>
        shape && mapProofNames(shape, (name) => typeAliasName(ctx.nameAliases.get(name) ?? name)),
    );
  }
  entry.statements = ctx.out;
  checkElaboratedPolarities(entry, ctx.boundaries);
  return { program: entry, dataSources: ctx.dataSources, boundaries: ctx.boundaries };
}

/**
 * Bind one import site's declared name to the output it selected, and return the
 * merged predicate its declared columns and polarity are a contract for.
 *
 * A plain output is bound by an **alias rule**, so each site keeps its own column
 * names. A proof-carrying one cannot be: its constructors are qualified by the
 * predicate they land on (`ord::Lt`), and proof-carrying-ness does not propagate
 * through a pass-through rule — an alias would drop the implicit proof column.
 * So the output is **renamed** to a site's name, and any further site selecting it
 * binds its own name to that one at the name level (`nameAliases`), which is how
 * nested imports have always worked. Equal wiring therefore yields equal
 * constructors, at the cost of the later site's column labels.
 */
function bindLocalName(
  ctx: Context,
  instance: Instance,
  selected: SelectedOutput,
  decl: ExtDecl,
  columns: string[],
): string {
  if (!selected.proofCarrying) {
    const output = `${instance.prefix}${selected.name}`;
    ctx.out.push(aliasRule(decl, output, selected.arity, selected.maximal));
    return output;
  }
  const canonical = instance.renamed.get(selected.name);
  if (canonical !== undefined) {
    if (canonical !== decl.predicate) ctx.nameAliases.set(decl.predicate, canonical);
    return canonical;
  }
  // First site to select this output, on an instance expanded for another one:
  // rename it now, everywhere it is already referenced, and expose it so it
  // prints under this site's name.
  const freshened = `${instance.prefix}${selected.name}`;
  ctx.nameAliases.set(freshened, decl.predicate);
  for (const stmt of ctx.out) renamePredicate(stmt, freshened, decl.predicate);
  relabelOutputColumns(ctx.out, decl.predicate, columns);
  for (const stmt of ctx.out) {
    if (isRule(stmt) && stmt.head.predicate === decl.predicate) stmt.output = true;
  }
  instance.renamed.set(selected.name, decl.predicate);
  return decl.predicate;
}

/**
 * The rule that binds an importer's declared name to the output it selected from
 * a (possibly shared) instance: `local(a, b) :- <instance>$<export>(a, b).`
 * Its head variables are the declared column names, so the instance's result
 * columns come out named after the interface rather than the module's head vars.
 * The head carries the receiving declaration's polarity and the body carries the
 * selected output's polarity; the boundary check then requires them to agree.
 */
function aliasRule(
  decl: ExtDecl,
  target: string,
  arity: number,
  targetMaximal: boolean,
): Statement {
  const names: string[] = [];
  for (let i = 0; i < arity; i++) {
    // Fall back to a `$`-name when the declaration is shorter than the output
    // (an arity mismatch, reported by `checkModuleBoundaries`) or would repeat a
    // variable, which in a head would silently join the two columns.
    const declared = decl.columns[i]?.name;
    names.push(declared !== undefined && !names.includes(declared) ? declared : `$a${i}`);
  }
  const vars = (): unknown[] => names.map((name) => ({ $type: "Variable", name }));
  return {
    $type: "Rule",
    output: true,
    head: {
      $type: "HeadAtom",
      predicate: decl.predicate,
      maximal: decl.maximal,
      args: vars(),
    },
    body: [
      {
        $type: "Literal",
        predicate: target,
        maximal: targetMaximal,
        args: vars(),
        negated: false,
      },
    ],
  } as unknown as Statement;
}

/**
 * Record the type contract for each actual of one binding: the predicate wired
 * in must match the column types of the module input it is wired to.
 * `mergedActual` maps an actual's name in the importer's scope to its
 * merged-program name.
 */
function collectActualBoundaries(
  ctx: Context,
  module: Program,
  binding: Binding,
  importerDecl: ExtDecl,
  importerFile: string | undefined,
  mergedActual: (name: string) => string,
): BoundaryConstraint[] {
  const collected: BoundaryConstraint[] = [];
  const inputs = new Map<string, ExtDecl>();
  for (const s of module.statements) if (isExtDecl(s)) inputs.set(s.predicate, s);
  for (const actual of binding.actuals) {
    const inputDecl = inputs.get(actual.param);
    if (!inputDecl) continue;
    collected.push({
      predicate: mergedActual(actual.arg),
      // An unannotated column defaults to `string` (parseRaw already sets this).
      expected: inputDecl.columns.map((c) => c.type ?? "string"),
      nominalReferences: nominalReferences(inputDecl.columns),
      expectedShapes: inputDecl.columns.map((c) =>
        c.shape || c.nominal ? declaredColumnType(c) : undefined,
      ),
      expectedMaximal: inputDecl.maximal === true,
      expectedNullable: inputDecl.columns.map((c) => c.nullable === true),
      note: `actual '${actual.arg}' wired to input '${actual.param}' of "${binding.source}"`,
      pos: nodePos(importerDecl),
      file: importerFile,
    });
  }
  ctx.boundaries.push(...collected);
  return collected;
}

/**
 * The other half of a boundary: the instance output the importing declaration's
 * columns are a contract for. Checked against the output's own published type,
 * so a shared instance is held to every importer's declaration.
 */
function outputBoundary(
  binding: Binding,
  importerDecl: ExtDecl,
  importerFile: string | undefined,
  output: string,
): BoundaryConstraint {
  return {
    predicate: output,
    expected: importerDecl.columns.map((c) => c.type ?? "string"),
    nominalReferences: nominalReferences(importerDecl.columns),
    expectedShapes: importerDecl.columns.map((c) =>
      c.shape || c.nominal ? declaredColumnType(c) : undefined,
    ),
    expectedMaximal: importerDecl.maximal === true,
    expectedNullable: importerDecl.columns.map((c) => c.nullable === true),
    note: `output of "${binding.source}" bound to '${importerDecl.predicate}'`,
    pos: nodePos(importerDecl),
    file: importerFile,
  };
}

/**
 * Check polarity contracts while the merged raw program is still available, so
 * a mismatched actual is reported at its binding before ordinary analysis sees
 * a substituted call with the wrong sigil. Undefined predicates remain the
 * analyzer's responsibility.
 */
function checkElaboratedPolarities(program: Program, boundaries: BoundaryConstraint[]): void {
  const known = new Set<string>();
  const maximal = new Set<string>();
  for (const stmt of program.statements) {
    if (isExtDecl(stmt)) {
      known.add(stmt.predicate);
      if (stmt.maximal) maximal.add(stmt.predicate);
    } else if (isRule(stmt)) {
      known.add(stmt.head.predicate);
      if (stmt.head.maximal) maximal.add(stmt.head.predicate);
    }
  }
  for (const boundary of boundaries) {
    if (!known.has(boundary.predicate)) continue;
    checkBoundaryPolarity(maximal.has(boundary.predicate), boundary);
  }
}

function checkBoundaryPolarity(actualMaximal: boolean, boundary: BoundaryConstraint): void {
  if (actualMaximal === boundary.expectedMaximal) return;
  throw boundaryError(
    `${boundary.note}: expected ${boundary.expectedMaximal ? "maximal (^)" : "minimal"} polarity but the wired predicate is ${actualMaximal ? "maximal" : "minimal"}`,
    boundary,
  );
}

/**
 * Check the boundary type and polarity contracts collected by `elaborate`
 * against the merged program's inferred column types. Run after `inferTypes`.
 * Throws an `AnalyzerError` (carrying the importer's file/position) on a
 * polarity, arity, or type mismatch that ordinary inference could not see,
 * because the declarations were dropped when the binding was elaborated away.
 */
export function checkModuleBoundaries(typed: TypedProgram, boundaries: BoundaryConstraint[]): void {
  for (const b of boundaries) {
    for (const ref of b.nominalReferences ?? []) {
      const isProof = typed.rules.get(ref.predicate)?.some((rule) => rule.ruleName !== undefined);
      if (ref.aliasName && isProof)
        throw boundaryError(
          `Ambiguous type name '${ref.aliasName}': both a type alias and a proof-carrying predicate`,
          b,
        );
      if (!ref.aliasName && !isProof)
        throw boundaryError(
          `Type name '${ref.predicate}' does not identify a proof-carrying predicate`,
          b,
        );
    }

    // Compare against the published type (the predicate's advertised contract),
    // not its inferred type, so a predicate declared wider than it currently
    // produces is held to its declaration across the boundary — the same
    // assume-guarantee contract that applies within a program.
    const actual = typed.publishedTypes.get(b.predicate);
    // A missing predicate (e.g. an actual that names nothing) is left to the
    // analyzer's own reporting; there is no type to compare here.
    if (!actual) continue;
    checkBoundaryPolarity(typed.maximalPredicates.has(b.predicate), b);
    if (actual.length !== b.expected.length) {
      throw boundaryError(
        `${b.note}: expected ${b.expected.length} column(s) but the wired predicate has ${actual.length}`,
        b,
      );
    }
    // Nullness rides the same contract: the published bit, so a `?` annotation
    // on the wired predicate is honoured across the boundary even where its
    // body currently produces no NULL.
    const actualNullable = typed.nullness.publishedNullness.get(b.predicate);
    for (let i = 0; i < b.expected.length; i++) {
      const shape = b.expectedShapes?.[i];
      const semantic = typed.publishedSemanticColumnTypes.get(b.predicate)?.[i];
      const mismatch = shape && semantic && semanticContractMismatch(semantic, shape);
      if (mismatch) {
        throw boundaryError(
          `${b.note}: column ${i + 1} does not satisfy its structural declaration: ${mismatch}`,
          b,
        );
      }
      if (!columnTypesCompatible(actual[i]!, b.expected[i]!)) {
        throw boundaryError(
          `${b.note}: column ${i + 1} has type '${actual[i]}' but '${b.expected[i]}' was declared`,
          b,
        );
      }
      if (actualNullable?.[i] === true && b.expectedNullable[i] !== true) {
        throw boundaryError(
          `${b.note}: column ${i + 1} can hold NULL but '${b.expected[i]}' was declared without '?'`,
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
 * Expand one module instance into `ctx.out` and return it. `wiring` maps this
 * module's inputs (those the caller wired) to their merged-program names; inputs
 * the caller left alone resolve to their own `:=` default, by recursively
 * instantiating it and feeding its output in.
 *
 * Instances are **shared**: an identical (module, wiring) pair returns the earlier
 * expansion instead of expanding again, so two bindings of one module against one
 * set of relations cost one copy of its rules. `exportAs` renames the selected
 * output instead of leaving it freshened, which a proof-carrying output needs;
 * that does not prevent sharing, since a later site can bind its own name to the
 * renamed one (`bindLocalName`).
 */
function instantiate(
  module: Program,
  file: string | undefined,
  nameHint: string,
  wiring: Record<string, string>,
  exportAs: { export: string; as: string; columns: string[] } | undefined,
  stack: (string | undefined)[],
  ctx: Context,
  sourceRef: string,
): Instance {
  const key = instanceKey(file ?? sourceRef, wiring);
  const shared = ctx.instances.get(key);
  if (shared !== undefined) return shared;

  const prefix = `${nameHint}$${ctx.counter.n++}$`;
  const inputSubst = { ...wiring };
  const localNames = new Set<string>();
  for (const s of module.statements) {
    if (isRule(s)) localNames.add(s.head.predicate);
    // A data-bound input is freshened by `expandModule` too, so a nested import
    // wired to one must resolve to the freshened name.
    else if (isExtDecl(s) && s.binding && !s.binding.isModule) localNames.add(s.predicate);
  }
  // How a name in this module's scope reads in the merged program (mirrors
  // expandModule's own renaming), used to resolve a nested import's actuals.
  const renameName = (name: string): string =>
    Object.hasOwn(inputSubst, name)
      ? inputSubst[name]!
      : exportAs && name === exportAs.export
        ? exportAs.as
        : localNames.has(name)
          ? `${prefix}${name}`
          : name;

  const nestedOutputBoundaries: BoundaryConstraint[] = [];
  for (const s of module.statements) {
    if (!isExtDecl(s) || !s.binding?.isModule) continue;
    // A `:=` binding on an input is a *default*: an actual the importer wired
    // for it wins, and the default instance is then not built at all. (A
    // data-file default is overridden the same way, by `expandModule` dropping
    // the wired declaration so its source is never recorded.)
    if (Object.hasOwn(inputSubst, s.predicate)) continue;
    const binding = s.binding;
    const child = ctx.resolve(binding.source, file);
    const id = child.file ?? binding.source;
    checkCycle(id, stack, s);
    const childExport = prepareModule(child.program, binding.export, s, false);
    const actualBoundaries = collectActualBoundaries(
      ctx,
      child.program,
      binding,
      s,
      file,
      renameName,
    );
    const childWiring: Record<string, string> = {};
    for (const actual of binding.actuals) childWiring[actual.param] = renameName(actual.arg);
    // A nested instance's output feeds a parent input, so it is not renamed: the
    // parent's rules are substituted to point at its name in the merged program.
    const childInstance = instantiate(
      child.program,
      child.file,
      s.predicate,
      childWiring,
      undefined,
      [...stack, id],
      ctx,
      binding.source,
    );
    remapBoundaryShapes(actualBoundaries, childInstance.resolveName);
    const childOutput = outputName(childInstance, childExport.name);
    const boundary = outputBoundary(binding, s, file, childOutput);
    ctx.boundaries.push(boundary);
    nestedOutputBoundaries.push(boundary);
    inputSubst[s.predicate] = childOutput;
  }

  // Every module input must be supplied — wired by an actual (now in
  // `inputSubst`) or bound with `:=` (a data or module binding). A free input
  // that is neither is an error: a module never auto-loads its inputs; supplying
  // them is the importer's job (wire it) or the module's (`:= "file"`).
  const declaredInputs = new Set<string>();
  for (const s of module.statements) {
    if (!isExtDecl(s)) continue;
    declaredInputs.add(s.predicate);
    if (!s.binding && !Object.hasOwn(inputSubst, s.predicate)) {
      throw new AnalyzerError(
        `module '${sourceRef}' input '${s.predicate}' is not supplied; wire it with an actual (${s.predicate} = ...) or bind it with ':='`,
      );
    }
  }
  // An actual naming something that is not an input of this module is a typo.
  // Ignoring it would substitute nothing, and for a `:=`-bound input it would
  // silently leave the default in place of the override the importer asked for.
  for (const name of Object.keys(inputSubst)) {
    if (!declaredInputs.has(name)) {
      throw new AnalyzerError(`module '${sourceRef}' has no input '${name}' to wire`);
    }
  }

  const rename = exportAs && { export: exportAs.export, as: exportAs.as };
  const expanded = expandModule(module, { prefix, inputs: inputSubst, exportAs: rename });
  // A renamed (not aliased) output has no alias rule to name its columns, so its
  // head variables are relabelled to the importer's declared column names.
  if (exportAs) relabelOutputColumns(expanded, exportAs.as, exportAs.columns);
  // A kept data-bound / free input carrying a data binding: record and clear it,
  // relative to this module's own file.
  for (const s of expanded) {
    if (isExtDecl(s) && s.binding) recordDataSource(s, s.binding, file, ctx.dataSources);
  }
  ctx.out.push(...expanded);
  const instance: Instance = {
    prefix,
    renamed: new Map(),
    resolveName: (name) =>
      inputSubst[name] ??
      instance.renamed.get(name) ??
      (localNames.has(name) ? `${prefix}${name}` : name),
  };
  if (exportAs) instance.renamed.set(exportAs.export, exportAs.as);
  remapBoundaryShapes(nestedOutputBoundaries, instance.resolveName);
  // Registered after expanding, so an instance under construction is invisible:
  // a wiring cycle stays a cycle to be rejected rather than resolving to itself.
  ctx.instances.set(key, instance);
  return instance;
}

/** Where one of an instance's outputs lives in the merged program: renamed for a
 *  site that needed a writable name for its constructors, else prefix-freshened. */
function outputName(instance: Instance, exportName: string): string {
  return instance.renamed.get(exportName) ?? `${instance.prefix}${exportName}`;
}

const DEFAULT_OUTPUT = "$default";

/** The output one import site selected from a module. */
interface SelectedOutput {
  name: string;
  /** Head arity, for building the alias rule that projects it. */
  arity: number;
  /** Whether its rules carry a constructor, i.e. it is a proof-carrying ADT. */
  proofCarrying: boolean;
  /** Whether the selected output predicate carries the parity `^` sigil. */
  maximal: boolean;
}

/**
 * Prepare a freshly-resolved module for expansion and describe the output this
 * site selected. Names the module's `?-` default (as `$default`) whether or not
 * this site asked for it, since a shared instance must carry every output any
 * site might bind to, then drops the remaining `?-` queries so a default cannot
 * leak into the merged program.
 *
 * `output` markers are cleared, because what prints is the importer's alias rule
 * rather than the instance's internals. The exception is a proof-carrying output
 * at an entry-level site (`expose`), which is renamed to the importer's name
 * instead of aliased, and so has to keep the marker to print at all.
 */
function prepareModule(
  module: Program,
  requestedExport: string | undefined,
  decl: ExtDecl,
  expose: boolean,
): SelectedOutput {
  const defaultName = nameDefaultOutput(module, decl, requestedExport === undefined);
  const exportName = requestedExport ?? defaultName;
  // Drop the module's `?-` queries but keep its `!-` constraints: a module's
  // integrity constraints hold wherever it is instantiated. `error predicate`
  // rules need no handling here — the loop below only clears `output` markers.
  module.statements = module.statements.filter((s) => s.$type !== "Query" || (s as Query).isError);
  const selected: SelectedOutput = {
    name: exportName,
    arity: 0,
    proofCarrying: false,
    maximal: false,
  };
  let found = false;
  const selectedRules: Rule[] = [];
  for (const s of module.statements) {
    if (!isRule(s)) continue;
    if (s.head.predicate === exportName && (s.output || exportName === DEFAULT_OUTPUT)) {
      found = true;
      selected.arity = s.head.args.length;
      selected.maximal = s.head.maximal === true;
      if (s.ruleName !== undefined) selected.proofCarrying = true;
      selectedRules.push(asCoreRule(s));
    }
    s.output = false;
  }
  // A renamed output carries no alias rule, so it keeps its marker or nothing
  // would print it.
  if (expose && selected.proofCarrying) for (const r of selectedRules) r.output = true;
  if (!found) {
    throw new AnalyzerError(
      `module '${decl.binding?.source}' has no output named '${exportName}'`,
      ...nodePos(decl),
    );
  }
  return selected;
}

/** Convert the module's single `?-` query into a named `$default` output rule, so
 *  default-output selection reuses the named-export path. `required` is set when
 *  this site actually asked for the default, and only then is the absence (or
 *  ambiguity) of a `?-` query an error. */
function nameDefaultOutput(module: Program, decl: ExtDecl, required: boolean): string {
  // Constraints are `!-` statements, not candidate default outputs.
  const queries = module.statements.filter((s) => s.$type === "Query" && !(s as Query).isError);
  if (queries.length !== 1) {
    if (!required) return DEFAULT_OUTPUT;
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

/** Call `fn` for every node reachable from `node` (itself included). */
function eachNode(node: unknown, fn: (n: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object" || !("$type" in node)) return;
  const n = node as Record<string, unknown>;
  fn(n);
  for (const key of Object.keys(n)) {
    if (key.startsWith("$")) continue;
    const v = n[key];
    if (Array.isArray(v)) for (const el of v) eachNode(el, fn);
    else eachNode(v, fn);
  }
}

/**
 * Rewrite every reference to predicate `from` into `to`, throughout `stmt`: rule
 * heads, body atoms (a proof capture is an ordinary `Literal`, so it is covered),
 * and the qualifier of a constructor term, whose tag is qualified by the predicate
 * that declares it.
 */
function renamePredicate(stmt: Statement, from: string, to: string): void {
  visitNominalReferences(stmt, (ref) => {
    if (ref.predicate === from) ref.predicate = to;
  });
  eachNode(stmt, (n) => {
    if (isRule(n) && n.head.predicate === from) n.head.predicate = to;
    else if (isLiteral(n) && n.predicate === from) n.predicate = to;
    else if (isFunctionCall(n) && n.qualifier === from) n.qualifier = to;
  });
}

/** Apply every name-level alias (see `bindLocalName`) to one statement. */
function applyNameAliases(stmt: Statement, aliases: Map<string, string>): void {
  if (aliases.size === 0) return;
  visitNominalReferences(stmt, (ref) => {
    ref.predicate = aliases.get(ref.predicate) ?? ref.predicate;
  });
  eachNode(stmt, (n) => {
    if (isLiteral(n)) {
      const to = aliases.get(n.predicate);
      if (to !== undefined) n.predicate = to;
    } else if (isFunctionCall(n) && n.qualifier !== undefined) {
      const to = aliases.get(n.qualifier);
      if (to !== undefined) n.qualifier = to;
    }
  });
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
  // A proof-carrying rule's head carries only its value columns here; the proof
  // column is appended later by post-processing, so the declaration (which must
  // include it) is one longer. Anything else is an arity mismatch, reported by
  // `checkModuleBoundaries`; leave those heads alone.
  const declared =
    rule.ruleName !== undefined && columnNames.length === args.length + 1
      ? columnNames.slice(0, args.length)
      : columnNames;
  if (args.length !== declared.length) return;
  const rename = new Map<string, string>(); // module head var -> declared column name
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as { $type: string; name?: string };
    if (arg.$type !== "Variable" || arg.name === undefined) continue;
    if (rename.has(arg.name) && rename.get(arg.name) !== declared[i]) return; // repeated head var
    rename.set(arg.name, declared[i]!);
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

function mapProofNames(type: SemanticType, rename: (name: string) => string): SemanticType {
  switch (type.kind) {
    case "proof":
      return { kind: "proof", id: { predicate: rename(type.id.predicate) } };
    case "array":
      return { ...type, element: mapProofNames(type.element, rename) };
    case "tuple":
      return { ...type, elements: type.elements.map((t) => mapProofNames(t, rename)) };
    case "union":
      return { ...type, members: type.members.map((t) => mapProofNames(t, rename)) };
    case "record":
      return {
        ...type,
        fields: type.fields.map((f) => ({ ...f, type: mapProofNames(f.type, rename) })),
        additional: mapProofNames(type.additional, rename),
      };
    default:
      return type;
  }
}

function remapBoundaryShapes(
  boundaries: BoundaryConstraint[],
  rename: (name: string) => string,
): void {
  for (const boundary of boundaries) {
    boundary.expectedShapes = boundary.expectedShapes?.map(
      (shape) => shape && mapProofNames(shape, rename),
    );
    for (const ref of boundary.nominalReferences ?? []) ref.predicate = rename(ref.predicate);
  }
}

function nominalReferences(value: unknown): NominalReference[] {
  const references: NominalReference[] = [];
  visitNominalReferences(value, (ref) => references.push({ ...ref }));
  return references;
}
