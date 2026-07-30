import { isExtDecl, isFunctionCall, isLiteral, isRule } from "datamog-parser";
import type { Program, Statement } from "./ast.ts";

export interface ExpandOptions {
  /**
   * Per-instance prefix for the module's private and output predicates and its
   * proof constructors, e.g. `"road_reach$"`. Two instantiations of the same
   * module must use different prefixes so their names (and constructors) do not
   * collide in the merged program.
   */
  prefix: string;
  /**
   * Actuals for the module's inputs: a map from an `input predicate` name to
   * the predicate in the importer's scope it is wired to. Inputs absent from
   * this map keep their declaration and become EDBs of the merged program; one
   * carrying a `:=` data binding is freshened with `prefix` as well, since its
   * data belongs to this instance alone.
   */
  inputs: Record<string, string>;
  /**
   * The importer's selected output. `export` names one of the module's output
   * predicates (or private predicates, though only outputs are meaningful to
   * import); it is renamed to `as` (the importer's local name for the instance)
   * instead of being freshened with `prefix`, so the importer's existing
   * references resolve without an alias rule. Every other predicate is still
   * prefix-freshened. Constructors are not renamed; renaming the head predicate
   * re-qualifies them (`<as>::<Ctor>`), a writable name the importer can match.
   */
  exportAs?: { export: string; as: string };
}

/** Yield a node and every descendant AST node (children found by walking
 *  non-`$` properties; `$type`/`$container`/`$cstNode` etc. are skipped). */
function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (!node || typeof node !== "object" || !("$type" in node)) return;
  const n = node as Record<string, unknown>;
  yield n;
  for (const key of Object.keys(n)) {
    if (key.startsWith("$")) continue;
    const value = n[key];
    if (Array.isArray(value)) {
      for (const el of value) yield* walk(el);
    } else {
      yield* walk(value);
    }
  }
}

/**
 * Expand one instantiation of a module, in place, and return the statements to
 * merge into the importer's program. Runs on a **raw** (pre-post-process) AST
 * (see `parseRaw`), so proof terms are still `:: Ctor` / `Ctor(...)` rather than
 * lowered onto `value`.
 *
 * Per the functor design (`doc/design/imports-as-functors.md`):
 *
 * - **Substitute** each wired input predicate with the actual name the importer
 *   supplied, everywhere it is referenced; free inputs keep their name.
 * - **Freshen** every private and output predicate name with `prefix` so two
 *   instances do not collide. Proof **constructors** are not renamed: a
 *   constructor is scoped to its predicate (`opt::Some`), so renaming the head
 *   predicate re-qualifies it for free (`dist::Some`). Bare constructor *terms*
 *   are qualified here with their owning predicate's new name so they stay
 *   unambiguous once several instances merge.
 * - **Drop** the declarations of wired inputs (they are supplied from outside);
 *   keep free-input declarations as EDBs. A kept declaration that carries a `:=`
 *   data binding is freshened too: its data is this instance's own, so two
 *   instances must not share (or redeclare) the one predicate, and the name must
 *   not collide with the importer's.
 *
 * The caller passes a fresh raw parse per instantiation, so mutating in place is
 * safe. The importer binds its chosen name to the instance's selected output
 * (`${prefix}${outputName}`); that wiring is the resolver's job, not this pass.
 */
export function expandModule(
  module: Program,
  { prefix, inputs, exportAs }: ExpandOptions,
): Statement[] {
  const localNames = new Set<string>();
  const ctorNames = new Set<string>();
  // Constructor tag -> the module predicate that declares it, so a bare
  // constructor term can be qualified with that predicate's renamed name.
  const ctorOwner = new Map<string, string>();
  // Data-bound inputs the importer did not override: their declarations survive
  // into the merged program, so they are freshened like private predicates.
  const boundInputs = new Set<string>();
  for (const stmt of module.statements) {
    if (isRule(stmt)) {
      localNames.add(stmt.head.predicate);
      if (stmt.ruleName !== undefined) {
        ctorNames.add(stmt.ruleName);
        if (!ctorOwner.has(stmt.ruleName)) ctorOwner.set(stmt.ruleName, stmt.head.predicate);
      }
    } else if (isExtDecl(stmt) && stmt.binding && !Object.hasOwn(inputs, stmt.predicate)) {
      boundInputs.add(stmt.predicate);
      localNames.add(stmt.predicate);
    }
  }

  const renamePredicate = (name: string): string => {
    if (Object.hasOwn(inputs, name)) return inputs[name]!;
    if (exportAs && name === exportAs.export) return exportAs.as;
    if (localNames.has(name)) return `${prefix}${name}`;
    return name; // free input or built-in body atom
  };

  for (const stmt of module.statements) {
    for (const node of walk(stmt)) {
      if (isRule(node)) {
        // The constructor tag (`ruleName`) is left as-is; renaming the head
        // predicate re-qualifies the constructor (`opt::Some` -> `dist::Some`)
        // when post-processing derives the `$proof` name from the head.
        node.head.predicate = renamePredicate(node.head.predicate);
      } else if (isLiteral(node)) {
        node.predicate = renamePredicate(node.predicate);
      } else if (isExtDecl(node) && boundInputs.has(node.predicate)) {
        // Freshen the surviving declaration itself (its references go through
        // `renamePredicate` via `localNames`).
        node.predicate = `${prefix}${node.predicate}`;
      } else if (isFunctionCall(node) && ctorNames.has(node.name)) {
        // A constructor term `Ctor(...)` (a match). Qualify it with its owning
        // predicate's new name so it stays unambiguous once several instances
        // merge (an already-qualified term just has its qualifier renamed).
        const owner = node.qualifier ?? ctorOwner.get(node.name);
        if (owner !== undefined) node.qualifier = renamePredicate(owner);
      }
    }
  }

  // Wired inputs are supplied by the importer, so drop their declarations;
  // free inputs stay as EDB declarations with their names unchanged.
  return module.statements.filter((s) => !(isExtDecl(s) && Object.hasOwn(inputs, s.predicate)));
}
