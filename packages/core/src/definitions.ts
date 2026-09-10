// Cursor-driven go-to-definition: "the user clicked at this offset — what
// name is that, and where is it defined?"
//
// Complements `references.ts`, which answers the opposite-shaped question
// ("give me every clickable predicate span in the file") because the
// playground needs the whole set up front to underline it. LSP wants one
// lookup per click, and a pull model would not scale to variables: every
// variable occurrence in every rule is a clickable span. Both go through
// `findPredicateDefinitions` for the predicate case so the two cannot
// disagree about where a predicate is defined.
//
// Works on a *raw* program (see `parseRawLenient`), not an analysed one, for
// two reasons. Post-processing lowers away the two shapes this file most
// needs to see — `Ctor(...)` constructor terms and `_` don't-cares. And
// navigation has to keep working in a file that does not analyse; a type
// error somewhere else in the buffer is exactly when jumping around is most
// useful.
//
// Every span is a byte offset pair into the source text. Turning those into
// LSP ranges (or CodeMirror positions) is the consumer's job, which is what
// keeps this file free of both Langium services and the filesystem.

import { propertySpan } from "datamog-parser";
import { AGGREGATE_NAMES, BUILTIN_BODY_ATOMS } from "./analyzer.ts";
import { asCoreRule } from "./ast.ts";
import type {
  Binding,
  ExtDecl,
  HeadTerm,
  Literal,
  Program,
  Query,
  Rule,
  Statement,
} from "./ast.ts";
import { BUILTINS } from "./builtins.ts";

export interface SourceSpan {
  offset: number;
  end: number;
}

/**
 * What to look for inside an imported module.
 *
 * `constructor` leaves `predicate` undefined when the importer took the
 * module's default output, since the importing file cannot know that
 * output's name without reading the module.
 */
export type ModuleSelector =
  | { what: "default" }
  | { what: "output"; name: string }
  | { what: "input"; name: string }
  | { what: "constructor"; tag: string; predicate?: string };

/**
 * Where the name under the cursor is defined.
 *
 * `local` targets are spans in the same document. The other two name another
 * file, which core cannot read: the consumer resolves `ref` relative to the
 * importing file and, for `module`, calls `findModuleTarget` on the result.
 */
export type Definition =
  | { kind: "local"; origin: SourceSpan; targets: SourceSpan[] }
  | { kind: "module"; origin: SourceSpan; ref: string; select: ModuleSelector }
  | { kind: "file"; origin: SourceSpan; ref: string };

/** Names that resolve to a built-in, so they have no definition to jump to. */
function isBuiltinCallee(name: string): boolean {
  return BUILTINS.has(name) || AGGREGATE_NAMES.has(name) || BUILTIN_BODY_ATOMS.has(name);
}

function contains(span: SourceSpan | undefined, offset: number): boolean {
  // Inclusive of `end` so the caret resting just past a name still resolves
  // it, which is where a double-click or a word-wise cursor move leaves you.
  // Names are always followed by a delimiter, never by another name, so this
  // cannot make two spans overlap.
  return span !== undefined && offset >= span.offset && offset <= span.end;
}

function nodeSpan(node: { $cstNode?: { offset: number; end: number } }): SourceSpan | undefined {
  const cst = node.$cstNode;
  return cst ? { offset: cst.offset, end: cst.end } : undefined;
}

// --- Definition sites -------------------------------------------------------

/**
 * Every place `name` is defined in this program: its `input predicate`
 * declaration and the head of every rule that derives it. A predicate can
 * have many rules, and LSP lets us return them all, so a click on a body atom
 * peeks the full set rather than guessing which rule the user meant.
 */
export function findPredicateDefinitions(program: Program, name: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const stmt of program.statements) {
    if (stmt.$type === "ExtDecl") {
      if (stmt.predicate !== name) continue;
      const span = propertySpan(stmt, "predicate");
      if (span) spans.push(span);
    } else if (stmt.$type === "Rule") {
      if (stmt.head.predicate !== name) continue;
      const span = propertySpan(stmt.head, "predicate");
      if (span) spans.push(span);
    }
  }
  return spans;
}

/**
 * Every rule head that builds the proof-term constructor `tag`. A bare
 * `Ctor(...)` matches the tag in any predicate; a qualified `p::Ctor(...)`
 * narrows to that predicate, which is what the qualifier is for when several
 * predicates share a tag.
 */
function findConstructorDefinitions(
  program: Program,
  tag: string,
  qualifier: string | undefined,
): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const stmt of program.statements) {
    if (stmt.$type !== "Rule" || stmt.ruleName !== tag) continue;
    if (qualifier !== undefined && stmt.head.predicate !== qualifier) continue;
    const span = propertySpan(stmt, "ruleName");
    if (span) spans.push(span);
  }
  return spans;
}

/** The module binding on `name`'s declaration, if it has one. */
function moduleBindingFor(program: Program, name: string): Binding | undefined {
  for (const stmt of program.statements) {
    if (stmt.$type !== "ExtDecl" || stmt.predicate !== name) continue;
    return stmt.binding?.isModule ? stmt.binding : undefined;
  }
  return undefined;
}

/**
 * The declaration an importing file's `:=` binding selects, resolved inside
 * the imported module's own program.
 */
export function findModuleTarget(program: Program, select: ModuleSelector): SourceSpan | undefined {
  if (select.what === "input") {
    for (const stmt of program.statements) {
      if (stmt.$type === "ExtDecl" && stmt.predicate === select.name) {
        return propertySpan(stmt, "predicate");
      }
    }
    return undefined;
  }
  if (select.what === "output") {
    for (const stmt of program.statements) {
      if (stmt.$type === "Rule" && stmt.output && stmt.head.predicate === select.name) {
        return propertySpan(stmt.head, "predicate");
      }
    }
    return undefined;
  }
  if (select.what === "constructor") {
    for (const stmt of program.statements) {
      if (stmt.$type !== "Rule" || stmt.ruleName !== select.tag) continue;
      if (select.predicate !== undefined && stmt.head.predicate !== select.predicate) continue;
      return propertySpan(stmt, "ruleName");
    }
    return undefined;
  }
  // The default export is the module's `?-` query. It has no name of its own,
  // so point at the query itself.
  for (const stmt of program.statements) {
    if (stmt.$type === "Query" && !stmt.isError) return nodeSpan(stmt);
  }
  return undefined;
}

// --- Variable binding sites -------------------------------------------------

/**
 * A call that names a proof-term constructor rather than a built-in. A
 * qualified name is always a constructor; a bare one is unless a built-in
 * claims it.
 */
function isConstructorTerm(expr: HeadTerm | undefined): boolean {
  if (expr?.$type !== "FunctionCall") return false;
  return expr.qualifier !== undefined || !isBuiltinCallee(expr.name);
}

/**
 * Binding occurrences of `name` inside a position that *matches* rather than
 * computes. A bare variable there takes its value from the match; a
 * constructor term destructures, so its arguments match in turn and recursion
 * is right. Anything else — arithmetic, a built-in call — consumes a value it
 * does not supply, so nothing inside it binds (`p(X + 1)` is a use of X).
 */
function collectBindings(expr: HeadTerm | undefined, name: string, into: SourceSpan[]): void {
  if (!expr) return;
  if (expr.$type === "Variable") {
    if (expr.name !== name) return;
    const span = nodeSpan(expr);
    if (span) into.push(span);
    return;
  }
  if (expr.$type === "FunctionCall" && isConstructorTerm(expr)) {
    for (const arg of expr.args) collectBindings(arg, name, into);
  }
}

/**
 * Where a variable acquires its value within one rule or query: an argument
 * position of a positive body atom, a proof capture, the bound side of an
 * equality, the subject of a range atom, or a constructor pattern anywhere
 * one of those can appear. A variable with no result here is one the safety
 * check would reject as unsafe.
 *
 * Comparisons and negated atoms are omitted deliberately: they constrain a
 * variable rather than bind it, so jumping there would land on a use. Head
 * arguments are omitted for the same reason, with one exception — a
 * constructor term in a head is a match against proofs that already exist,
 * not a way to build one, so it does bind what it destructures.
 */
function findVariableBindings(scope: Rule | Query, name: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const bindIn = (expr: HeadTerm | undefined) => collectBindings(expr, name, spans);
  const matchIn = (expr: HeadTerm | undefined) => {
    if (isConstructorTerm(expr)) collectBindings(expr, name, spans);
  };

  if (scope.$type === "Rule") for (const arg of scope.head.args) matchIn(arg);
  for (const elem of scope.body) {
    if (elem.$type === "Literal") {
      if (elem.negated) continue;
      if (elem.proofVar === name) {
        const span = propertySpan(elem, "proofVar");
        if (span) spans.push(span);
      }
      for (const arg of elem.args) bindIn(arg);
    } else if (elem.$type === "Equality") {
      bindIn(elem.left);
      // `P = pred::Some(V)` matches the proof P against a pattern, binding V.
      // A non-constructor right-hand side computes, so it binds nothing.
      matchIn(elem.expr);
    } else if (elem.$type === "RangeAtom") {
      bindIn(elem.expr);
    }
  }
  return spans;
}

// --- Cursor resolution ------------------------------------------------------

/**
 * The definition of whatever name sits at `offset`, or undefined when the
 * cursor is not on a navigable name (whitespace, a keyword, a literal, a
 * built-in, or a name that is already its own definition).
 */
export function findDefinition(program: Program, offset: number): Definition | undefined {
  for (const stmt of program.statements) {
    if (!contains(nodeSpan(stmt), offset)) continue;
    return inStatement(program, stmt, offset);
  }
  return undefined;
}

function inStatement(program: Program, stmt: Statement, offset: number): Definition | undefined {
  if (stmt.$type === "ExtDecl") return inExtDecl(program, stmt, offset);
  // `AnnotatedHeadTerm` is what separates the raw head shape from the core
  // one, and `liftHeadAnnotations` has already stripped it (it runs inside
  // every parse entry point, post-processing or not), so the assertion holds
  // even though nothing here has been post-processed.
  if (stmt.$type === "Rule") return inRule(program, asCoreRule(stmt), offset);
  return stmt.$type === "Query" ? inScopeBody(program, stmt, offset) : undefined;
}

/**
 * An `input predicate` declaration. The predicate name is its own definition,
 * so clicking it only goes somewhere when a `:=` binding gives it one: for a
 * module binding that is the selected output inside the imported file.
 */
function inExtDecl(program: Program, decl: ExtDecl, offset: number): Definition | undefined {
  const nameSpan = propertySpan(decl, "predicate");
  if (contains(nameSpan, offset)) {
    if (!decl.binding || !nameSpan) return undefined;
    return bindingTarget(decl.binding, nameSpan);
  }
  if (decl.binding) return inBinding(program, decl.binding, offset);
  return undefined;
}

/** The module output (or data file) a binding points at. */
function bindingTarget(binding: Binding, origin: SourceSpan): Definition | undefined {
  if (!binding.source) return undefined;
  if (!binding.isModule) return { kind: "file", origin, ref: binding.source };
  return {
    kind: "module",
    origin,
    ref: binding.source,
    select: binding.export ? { what: "output", name: binding.export } : { what: "default" },
  };
}

function inBinding(program: Program, binding: Binding, offset: number): Definition | undefined {
  const sourceSpan = propertySpan(binding, "source");
  const exportSpan = propertySpan(binding, "export");
  if (contains(sourceSpan, offset) && sourceSpan) return bindingTarget(binding, sourceSpan);
  if (contains(exportSpan, offset) && exportSpan) return bindingTarget(binding, exportSpan);

  // `from "m.dl"(moduleInput = local)`: the parameter names an input of the
  // imported module, the argument a predicate in this file.
  for (const actual of binding.actuals) {
    const paramSpan = propertySpan(actual, "param");
    if (contains(paramSpan, offset) && paramSpan && binding.source) {
      return {
        kind: "module",
        origin: paramSpan,
        ref: binding.source,
        select: { what: "input", name: actual.param },
      };
    }
    const argSpan = propertySpan(actual, "arg");
    if (contains(argSpan, offset) && argSpan) {
      return {
        kind: "local",
        origin: argSpan,
        targets: findPredicateDefinitions(program, actual.arg),
      };
    }
  }
  return undefined;
}

function inRule(program: Program, rule: Rule, offset: number): Definition | undefined {
  // The head predicate is a definition site. Clicking it is still useful when
  // the predicate has other rules or a declaration, so offer those and drop
  // the one under the cursor.
  const headSpan = propertySpan(rule.head, "predicate");
  if (contains(headSpan, offset) && headSpan) {
    const targets = findPredicateDefinitions(program, rule.head.predicate).filter(
      (t) => t.offset !== headSpan.offset,
    );
    return { kind: "local", origin: headSpan, targets };
  }
  // The `:: Ctor` marker declares the constructor rather than referring to it.
  if (contains(propertySpan(rule, "ruleName"), offset)) return undefined;

  for (const arg of rule.head.args) {
    const found = inExpression(program, rule, arg, offset);
    if (found) return found;
  }
  for (const arg of rule.ctorArgs) {
    const found = inExpression(program, rule, arg, offset);
    if (found) return found;
  }
  return inScopeBody(program, rule, offset);
}

function inScopeBody(
  program: Program,
  scope: Rule | Query,
  offset: number,
): Definition | undefined {
  for (const elem of scope.body) {
    if (!contains(nodeSpan(elem), offset)) continue;
    if (elem.$type === "Literal") return inLiteral(program, scope, elem, offset);
    if (elem.$type === "Equality") {
      return (
        inExpression(program, scope, elem.left, offset) ??
        inExpression(program, scope, elem.expr, offset)
      );
    }
    if (elem.$type === "RangeAtom") {
      return (
        inExpression(program, scope, elem.expr, offset) ??
        inExpression(program, scope, elem.low, offset) ??
        inExpression(program, scope, elem.high, offset)
      );
    }
    return inExpression(program, scope, elem.expr, offset);
  }
  return undefined;
}

function inLiteral(
  program: Program,
  scope: Rule | Query,
  literal: Literal,
  offset: number,
): Definition | undefined {
  const predSpan = propertySpan(literal, "predicate");
  if (contains(predSpan, offset) && predSpan) {
    // `object_entry` / `array_element` are built into the analyzer, not declared.
    if (isBuiltinCallee(literal.predicate)) return undefined;
    return {
      kind: "local",
      origin: predSpan,
      targets: findPredicateDefinitions(program, literal.predicate),
    };
  }
  // `V : p(...)` binds V here, so the capture is a definition, not a use.
  if (contains(propertySpan(literal, "proofVar"), offset)) return undefined;
  for (const arg of literal.args) {
    const found = inExpression(program, scope, arg, offset);
    if (found) return found;
  }
  return undefined;
}

function inExpression(
  program: Program,
  scope: Rule | Query,
  expr: HeadTerm | undefined,
  offset: number,
): Definition | undefined {
  if (!expr || !contains(nodeSpan(expr), offset)) return undefined;
  switch (expr.$type) {
    case "Variable": {
      const span = nodeSpan(expr);
      // `_` is a fresh anonymous variable at every occurrence, so it never
      // refers back to anything.
      if (!span || expr.name === "_") return undefined;
      return { kind: "local", origin: span, targets: findVariableBindings(scope, expr.name) };
    }
    case "FunctionCall": {
      const qualifierSpan = propertySpan(expr, "qualifier");
      if (contains(qualifierSpan, offset) && qualifierSpan && expr.qualifier) {
        return {
          kind: "local",
          origin: qualifierSpan,
          targets: findPredicateDefinitions(program, expr.qualifier),
        };
      }
      const nameSpan = propertySpan(expr, "name");
      if (contains(nameSpan, offset) && nameSpan) {
        // Unqualified built-ins win over a same-named constructor: `length(X)`
        // is the built-in even if some rule happens to be tagged `:: length`.
        if (!expr.qualifier && isBuiltinCallee(expr.name)) return undefined;
        const targets = findConstructorDefinitions(program, expr.name, expr.qualifier);
        // A qualified tag with no local rule is an imported module's
        // constructor: elaboration renames the module's proof-carrying output
        // to the importer's name, so `local::Tag` here is `export::Tag` there.
        if (targets.length === 0 && expr.qualifier) {
          const binding = moduleBindingFor(program, expr.qualifier);
          if (binding?.source) {
            return {
              kind: "module",
              origin: nameSpan,
              ref: binding.source,
              select: { what: "constructor", tag: expr.name, predicate: binding.export },
            };
          }
        }
        return { kind: "local", origin: nameSpan, targets };
      }
      for (const arg of expr.args) {
        const found = inExpression(program, scope, arg, offset);
        if (found) return found;
      }
      return undefined;
    }
    case "BinaryExpr":
      return (
        inExpression(program, scope, expr.left, offset) ??
        inExpression(program, scope, expr.right, offset)
      );
    case "Conditional":
      return (
        inExpression(program, scope, expr.cond, offset) ??
        inExpression(program, scope, expr.consequent, offset) ??
        inExpression(program, scope, expr.alternate, offset)
      );
    case "UnaryExpr":
      return inExpression(program, scope, expr.operand, offset);
    case "AggregateCall":
      return inExpression(program, scope, expr.arg, offset);
    case "Subscript":
      return (
        inExpression(program, scope, expr.object, offset) ??
        inExpression(program, scope, expr.index, offset)
      );
    case "Slice":
    case "BracketAccess":
      return (
        inExpression(program, scope, expr.object, offset) ??
        inExpression(program, scope, expr.start, offset) ??
        inExpression(program, scope, expr.end, offset)
      );
    case "ArrayLiteral": {
      for (const e of expr.elements) {
        const found = inExpression(program, scope, e, offset);
        if (found) return found;
      }
      return undefined;
    }
    case "ObjectLiteral": {
      for (const entry of expr.entries) {
        const found = inExpression(program, scope, entry.value, offset);
        if (found) return found;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
