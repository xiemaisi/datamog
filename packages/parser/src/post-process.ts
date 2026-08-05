import { type AstNode, AstUtils } from "langium";
import type {
  AggregateCall,
  ArrayLiteral,
  BodyElement,
  BracketAccess,
  Equality,
  Expression,
  FunctionCall,
  NumberLiteral,
  ObjectEntry,
  ObjectLiteral,
  Program,
  Slice,
  StringLiteral,
  Subscript,
  UnaryExpr,
  Variable,
} from "./generated/ast.js";
import {
  isAnnotatedHeadTerm,
  isBinaryExpr,
  isBracketAccess,
  isColumnDecl,
  isExtDecl,
  isFilter,
  isFunctionCall,
  isHeadAtom,
  isLiteral,
  isNumberLiteral,
  isQuery,
  isRule,
  isVariable,
} from "./generated/ast.js";
import { ParseError } from "./parse-error.js";

// Post-processing attaches the original source text of numeric literals on
// `rawText` so the translator can distinguish `1` from `1.0`. Declaration
// merging makes the field a first-class part of the generated interface so
// callers don't have to cast.
declare module "./generated/ast.js" {
  interface Literal {
    predicateQuoted?: boolean;
  }

  interface ColumnDecl {
    nameQuoted?: boolean;
  }

  interface ExtDecl {
    predicateQuoted?: boolean;
  }

  interface HeadAtom {
    predicateQuoted?: boolean;
  }

  interface NumberLiteral {
    rawText?: string;
  }
}

// Intermediate shape of a BracketAccess node while the post-processor rewrites
// it in place into a Subscript or Slice: `$type` becomes the wider runtime
// union, `index` is filled in for Subscripts, and `sliceColon`/`start` are
// cleared.
type MutableBracketAccess = Omit<BracketAccess, "$type" | "sliceColon"> & {
  $type: BracketAccess["$type"] | Subscript["$type"] | Slice["$type"];
  index?: Subscript["index"];
  sliceColon?: boolean;
};

const AGGREGATE_NAMES = new Set(["count", "sum", "avg", "min", "max", "concat", "list"]);

function isQuotedIdentifier(value: string): boolean {
  return value.length >= 2 && value.startsWith("`") && value.endsWith("`");
}

function decodeQuotedIdentifier(value: string, node?: { $cstNode?: AstNode["$cstNode"] }): string {
  if (!isQuotedIdentifier(value)) return value;
  const decoded = value.slice(1, -1).replace(/\\([\s\S])/g, "$1");
  // `$` opens the reserved internal namespace: the parser mints `$anonN`
  // don't-cares and `$sub`/`$pat` proof-term temporaries, and the analyzer's
  // `isSyntheticVar` treats any `$`-prefixed name as internal plumbing. A
  // quoted source identifier that decodes into it would collide with those
  // (dropped from proof witnesses, hidden from query output, mistaken for a
  // don't-care), so reject it rather than silently mangle it.
  if (decoded.startsWith("$")) {
    throw parseErrorAtNode(
      `Identifier '${decoded}' may not start with '$' (reserved for internal names)`,
      node ?? {},
    );
  }
  return decoded;
}

function parseErrorAtNode(message: string, node: { $cstNode?: AstNode["$cstNode"] }): ParseError {
  const cst = node.$cstNode;
  const line = cst ? cst.range.start.line + 1 : 1;
  const col = cst ? cst.range.start.character + 1 : 1;
  const err = new ParseError(message, line, col, cst?.offset);
  if (cst?.end !== undefined) err.end = cst.end;
  return err;
}

type Cst = AstNode["$cstNode"];

function setContainer(node: AstNode, container: AstNode, property: string, index?: number): void {
  const n = node as { $container: AstNode; $containerProperty?: string; $containerIndex?: number };
  n.$container = container;
  n.$containerProperty = property;
  n.$containerIndex = index;
}

function mkVar(name: string, cst: Cst): Variable {
  return { $type: "Variable", name, $cstNode: cst } as unknown as Variable;
}

/**
 * Build a proof-term value: the tagged object `{ "$proof": ctor, "args": [...] }`.
 * A reserved `$proof` key keeps proof terms from colliding with plain JSON data.
 */
function buildProofTerm(ctor: string, args: Expression[], cst: Cst): ObjectLiteral {
  const nameLit = {
    $type: "StringLiteral",
    value: ctor,
    $cstNode: cst,
  } as unknown as StringLiteral;
  const nameEntry = {
    $type: "ObjectEntry",
    key: "$proof",
    value: nameLit,
    $cstNode: cst,
  } as unknown as ObjectEntry;
  setContainer(nameLit, nameEntry, "value");

  const argsArr = {
    $type: "ArrayLiteral",
    elements: args,
    $cstNode: cst,
  } as unknown as ArrayLiteral;
  args.forEach((e, i) => setContainer(e, argsArr, "elements", i));
  const argsEntry = {
    $type: "ObjectEntry",
    key: "args",
    value: argsArr,
    $cstNode: cst,
  } as unknown as ObjectEntry;
  setContainer(argsArr, argsEntry, "value");

  const obj = {
    $type: "ObjectLiteral",
    entries: [nameEntry, argsEntry],
    $cstNode: cst,
  } as unknown as ObjectLiteral;
  setContainer(nameEntry, obj, "entries", 0);
  setContainer(argsEntry, obj, "entries", 1);
  return obj;
}

// Node factories for the destructuring desugar (Section below). Each wires up
// the `$container` links of its children, matching how the parser would.

function mkStringLiteral(value: string, cst: Cst): StringLiteral {
  return { $type: "StringLiteral", value, $cstNode: cst } as unknown as StringLiteral;
}

function mkNumberLiteral(value: number, cst: Cst): NumberLiteral {
  return {
    $type: "NumberLiteral",
    value,
    rawText: String(value),
    $cstNode: cst,
  } as unknown as NumberLiteral;
}

// Returns `Expression` (not `Subscript`): the grammar only ever produces
// `BracketAccess`, so the parser's `Expression` union omits the
// post-process-synthesised `Subscript`; core widens it back in.
function mkSubscript(object: Expression, index: Expression, cst: Cst): Expression {
  const node = { $type: "Subscript", object, index, $cstNode: cst } as unknown as Subscript;
  setContainer(object, node, "object");
  setContainer(index, node, "index");
  return node as unknown as Expression;
}

function mkFunctionCall(name: string, args: Expression[], cst: Cst): FunctionCall {
  const node = { $type: "FunctionCall", name, args, $cstNode: cst } as unknown as FunctionCall;
  args.forEach((a, i) => setContainer(a, node, "args", i));
  return node;
}

function mkEquality(left: Expression, expr: Expression, cst: Cst): Equality {
  const node = { $type: "Equality", left, expr, $cstNode: cst } as unknown as Equality;
  setContainer(left, node, "left");
  setContainer(expr, node, "expr");
  return node;
}

// Replace `oldNode` with `newNode` at its position in the tree, using the
// container links (single-valued or array-valued container property).
function replaceNode(oldNode: AstNode, newNode: AstNode): void {
  const c = oldNode as {
    $container?: AstNode;
    $containerProperty?: string;
    $containerIndex?: number;
  };
  if (c.$container === undefined || c.$containerProperty === undefined) return;
  const container = c.$container as unknown as Record<string, unknown>;
  if (c.$containerIndex !== undefined) {
    (container[c.$containerProperty] as AstNode[])[c.$containerIndex] = newNode;
  } else {
    container[c.$containerProperty] = newNode;
  }
  setContainer(newNode, c.$container, c.$containerProperty, c.$containerIndex);
}

/**
 * Post-parse transforms applied to the Langium AST:
 * 1. Desugar don't-care variables: rename every `_` to a unique internal name.
 * 2. Preserve the source text of numeric literals on a `rawText` property so the
 *    translator can distinguish `1` (integer) from `1.0` (float) — information
 *    that is otherwise lost when the lexer coerces NUMBER to a JS `number`.
 * 3. Recognise aggregate calls in rule heads: the grammar parses head args
 *    as plain `Expression` (to avoid an ambiguity between AggregateCall and
 *    FunctionCall — both start with IDENT '('), and this pass rewrites
 *    single-argument FunctionCall nodes whose name is an aggregate into
 *    AggregateCall nodes.
 * 4. Split BracketAccess nodes into Subscript or Slice based on whether a
 *    colon was seen inside the brackets. The grammar parses `W[...]` as a
 *    unified BracketAccess to avoid a Subscript-vs-Slice LL(k) ambiguity
 *    that surfaced for `W[0:-1]` and `W[:-1]`.
 * 5. Desugar negated filters: a body literal `not <expr>` whose atom is a
 *    built-in (a comparison like `not X = Y`) parses as a Filter with
 *    `negated` set. Rewrite it into an ordinary Filter over `!(<expr>)` so
 *    the analyzer, translator, and evaluators see only the logical-not path
 *    they already implement. (Negated predicate calls keep their own
 *    `Literal.negated` flag — they are negation-as-failure, not `!`.)
 */
/**
 * One head type annotation, as lifted onto `HeadAtom.argTypes`: the declared
 * type and whether it carried a `?`. The two travel together rather than in
 * parallel arrays, which would be free to drift out of step at the same
 * argument position.
 */
export interface HeadAnnotation {
  type: string;
  nullable: boolean;
}

/**
 * Lift optional head-term type annotations onto the head. The grammar wraps an
 * annotated head term `h(x: integer)` in an
 * AnnotatedHeadTerm{expr, type, nullable}; this replaces each wrapper with its
 * inner expression and records the declared type and nullness in a parallel
 * `argTypes` array on the head (undefined for unannotated positions). The array
 * is attached only when a rule annotates at least one argument; the
 * per-predicate all-or-nothing rule is enforced later, during type inference.
 *
 * Runs in `parseRaw`, before elaboration and post-processing, so no later stage
 * ever sees an AnnotatedHeadTerm node.
 */
export function liftHeadAnnotations(program: Program): void {
  for (const stmt of program.statements) {
    if (!isRule(stmt)) continue;
    const args = stmt.head.args;
    let annotated = false;
    const argTypes: (HeadAnnotation | undefined)[] = new Array(args.length).fill(undefined);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (!isAnnotatedHeadTerm(arg)) continue;
      annotated = true;
      argTypes[i] = { type: arg.type, nullable: arg.nullable === true };
      const inner = arg.expr;
      (inner as { $container: AstNode }).$container = stmt.head;
      (inner as { $containerProperty?: string }).$containerProperty = "args";
      (inner as { $containerIndex?: number }).$containerIndex = i;
      (args as unknown as Expression[])[i] = inner;
    }
    if (annotated) {
      (stmt.head as { argTypes?: (HeadAnnotation | undefined)[] }).argTypes = argTypes;
    }
  }
}

/**
 * Fill in the default type for unannotated input-predicate columns. A column
 * declared without `: type` defaults to `string`, so its cells load verbatim.
 * Runs in `parseRaw`, so every later stage sees a concrete column type.
 */
export function defaultColumnTypes(program: Program): void {
  for (const stmt of program.statements) {
    if (!isExtDecl(stmt)) continue;
    for (const col of stmt.columns) {
      if (col.type === undefined) col.type = "string";
    }
  }
}

/**
 * Rewrite operator aliases to their canonical spelling. `!=` is an accepted
 * spelling of `<>`, offered because most programmers reach for it first.
 * Runs in `parseRaw`, so nothing past parsing has to know about the alias:
 * there is one inequality operator, spelled two ways.
 */
export function normalizeOperatorAliases(program: Program): void {
  for (const node of streamAll(program)) {
    if (isBinaryExpr(node) && node.op === "!=") node.op = "<>";
  }
}

export function postProcess(program: Program): void {
  for (const node of streamAll(program)) {
    if (isExtDecl(node)) {
      node.predicateQuoted = isQuotedIdentifier(node.predicate);
      node.predicate = decodeQuotedIdentifier(node.predicate, node);
    } else if (isHeadAtom(node)) {
      node.predicateQuoted = isQuotedIdentifier(node.predicate);
      node.predicate = decodeQuotedIdentifier(node.predicate, node);
    } else if (isLiteral(node)) {
      node.predicateQuoted = isQuotedIdentifier(node.predicate);
      node.predicate = decodeQuotedIdentifier(node.predicate, node);
    } else if (isColumnDecl(node)) {
      node.nameQuoted = isQuotedIdentifier(node.name);
      node.name = decodeQuotedIdentifier(node.name, node);
    } else if (isVariable(node)) {
      // Strip backticks so `Foo` and Foo are indistinguishable downstream
      // (analyzer, translator, evaluators). Reserved keywords are matched
      // as their own token kind by the lexer, so the only way a variable
      // can carry a keyword-looking name is via the quoted form (`true`),
      // which the analyzer treats as an ordinary identifier — no
      // re-tokenisation downstream means no name collision.
      node.name = decodeQuotedIdentifier(node.name, node);
    }
  }

  // Collect every user-written variable name first, so renaming the
  // don't-care `_`s can avoid picking a name that already exists in the
  // program. The generated `$anonN` names are not valid source-level
  // variables, but the collision check keeps the transform robust if a
  // caller constructs ASTs directly.
  const usedNames = new Set<string>();
  for (const node of streamAll(program)) {
    if (isVariable(node) && node.name !== "_") {
      usedNames.add(node.name);
    }
  }

  let anonCounter = 0;
  const freshAnon = (): string => {
    let name = `$anon${anonCounter++}`;
    while (usedNames.has(name)) {
      name = `$anon${anonCounter++}`;
    }
    return name;
  };

  for (const node of streamAll(program)) {
    if (isVariable(node) && node.name === "_") {
      node.name = freshAnon();
    }
    if (isNumberLiteral(node)) {
      const text = node.$cstNode?.text;
      // A binary literal (`0b1010`) is tokenised as NUMBER, but the lexer's
      // numeric coercion doesn't understand the `0b` prefix. Compute its value
      // and normalise `rawText` to the decimal form, so every later stage
      // (types, translator, interpreters) sees an ordinary integer literal.
      if (text !== undefined && /^0[bB][01]+$/.test(text)) {
        (node as { value: number }).value = Number.parseInt(text.slice(2), 2);
        node.rawText = String(node.value);
      } else if (text !== undefined) {
        node.rawText = text;
      }
      const written = node.rawText ?? text ?? String(node.value);
      if (!Number.isFinite(node.value)) {
        throw parseErrorAtNode(
          `Numeric literal '${written}' is outside the finite number range`,
          node,
        );
      }
      if (!/[.eE]/.test(written) && !Number.isSafeInteger(node.value)) {
        throw parseErrorAtNode(
          `Integer literal '${written}' is outside the safe integer range`,
          node,
        );
      }
    }
    if (isBracketAccess(node)) {
      // Rewrite the node's $type in place. `sliceColon` means we saw a
      // `:`, so this is a Slice (possibly with omitted start or end).
      // Otherwise the `start` field is the Subscript's index. `$type`
      // is declared readonly on the generated interface; the
      // MutableBracketAccess alias relaxes it just for this rewrite.
      const bracket = node as MutableBracketAccess;
      if (bracket.sliceColon) {
        bracket.$type = "Slice";
      } else {
        // `W[]` is permitted by the grammar (both `start` and `sliceColon`
        // are optional), but a Subscript with no index can't be
        // translated. Reject it here with a `ParseError` carrying a
        // numeric `offset` / `end` so the playground squiggly lands at
        // the `[]` token — a bare `Error` would lose the position and
        // default to byte 0.
        if (!bracket.start) {
          throw parseErrorAtNode("Empty bracket access '[]' is not allowed", bracket);
        }
        bracket.$type = "Subscript";
        bracket.index = bracket.start;
        bracket.start = undefined;
      }
      bracket.sliceColon = undefined;
    }
  }

  // Desugar negated filters (`not X = Y`) into `!(...)` over the same
  // expression. Predicate-call literals are negated via `Literal.negated`
  // and are left untouched here.
  for (const stmt of program.statements) {
    const body = isRule(stmt) ? stmt.body : isQuery(stmt) ? stmt.body : undefined;
    if (!body) continue;
    for (const element of body) {
      if (!isFilter(element) || !element.negated) continue;
      const inner = element.expr;
      const negation: UnaryExpr = {
        $type: "UnaryExpr",
        $container: element,
        $containerProperty: "expr",
        $cstNode: element.$cstNode,
        op: "!",
        operand: inner,
      };
      (inner as { $container: AstNode }).$container = negation;
      (inner as { $containerProperty?: string }).$containerProperty = "operand";
      (inner as { $containerIndex?: number }).$containerIndex = undefined;
      element.expr = negation;
      element.negated = false;
    }
  }

  // Rewrite aggregate FunctionCalls in rule heads into AggregateCall nodes.
  for (const rule of program.statements) {
    if (!isRule(rule)) continue;
    for (let i = 0; i < rule.head.args.length; i++) {
      const arg = rule.head.args[i]!;
      if (isFunctionCall(arg) && AGGREGATE_NAMES.has(arg.name) && arg.args.length === 1) {
        const aggArg = arg.args[0]!;
        const aggregate: AggregateCall = {
          $type: "AggregateCall",
          $container: rule.head,
          $containerProperty: "args",
          $containerIndex: i,
          $cstNode: arg.$cstNode,
          func: arg.name,
          arg: aggArg,
        };
        (aggArg as { $container: AstNode }).$container = aggregate;
        // The grammar types head args as Expression[]; after this rewrite
        // the array can contain AggregateCall nodes. Downstream callers
        // (datamog-core) widen HeadAtom.args back to include them.
        (rule.head.args as unknown as (typeof aggregate | typeof arg)[])[i] = aggregate;
      }
    }
  }

  // 6. Proof-term desugar. A rule whose head carries `:: Ctor` is a named rule:
  //    its predicate becomes "proof-carrying" and gains an implicit trailing
  //    `value` column holding the derivation as a tagged object
  //    `{ "$proof": Ctor, "args": [...] }`. Constructor args are the values of
  //    the existential body variables (first-occurrence order) followed by the
  //    sub-proofs of the positive IDB body atoms (body order). A body or query
  //    capture `V : q(...)` binds q's proof column to `V`; an unbound
  //    reference to a proof-carrying predicate gets a fresh anonymous column so
  //    arities stay consistent.
  const proofCarrying = new Set<string>();
  for (const stmt of program.statements) {
    if (isRule(stmt) && stmt.ruleName !== undefined) {
      // Normalise the constructor name in place so every later stage (and the
      // analyzer) sees the decoded form.
      stmt.ruleName = decodeQuotedIdentifier(stmt.ruleName, stmt.head);
      proofCarrying.add(stmt.head.predicate);
    }
  }
  // Qualified constructor name (`pred::Ctor`) -> arity, filled in as each named
  // rule's constructor is built; consumed by the destructuring desugar to
  // validate pattern arity.
  const ctorArity = new Map<string, number>();

  // Sub-proof columns must be ordinary (non-anonymous) variables: the native
  // planner drops `$anonN` names as don't-care, which would null out a captured
  // sub-proof. Use a distinct `$subN` prefix that no source variable can spell.
  let proofVarCounter = 0;
  const freshProofVar = (): string => {
    let name = `$sub${proofVarCounter++}`;
    while (usedNames.has(name)) name = `$sub${proofVarCounter++}`;
    return name;
  };

  // Validate naming: every rule of a proof-carrying predicate must be named,
  // aggregates cannot be combined with proofs, and a constructor tag is unique
  // *within* its predicate.
  // Constructor tag -> the predicates that declare it, and predicate -> its
  // declared column count (before the proof column is appended). Constructors
  // are scoped per predicate: a tag may recur across predicates (`p::Cons`,
  // `q::Cons`) but not within one. The desugar resolves a bare tag to its unique
  // predicate (erroring if several share it) and a `p::Cons` term to `p`, then
  // synthesises the `scrut : Pred(_)` capture that range-restricts the match.
  const ctorTags = new Map<string, Set<string>>();
  const predArity = new Map<string, number>();
  for (const stmt of program.statements) {
    if (!isRule(stmt) || !proofCarrying.has(stmt.head.predicate)) continue;
    const pred = stmt.head.predicate;
    if (stmt.ruleName === undefined) {
      throw parseErrorAtNode(
        `Predicate '${pred}' mixes named and unnamed rules; either name every rule of a proof-carrying predicate or none`,
        stmt.head,
      );
    }
    if (stmt.head.args.some((a) => (a as { $type: string }).$type === "AggregateCall")) {
      throw parseErrorAtNode(`Proof-carrying predicate '${pred}' cannot use aggregates`, stmt.head);
    }
    const ctor = decodeQuotedIdentifier(stmt.ruleName, stmt.head);
    const preds = ctorTags.get(ctor) ?? new Set<string>();
    if (preds.has(pred)) {
      throw parseErrorAtNode(
        `Constructor '${ctor}' is used by more than one rule of '${pred}'`,
        stmt.head,
      );
    }
    preds.add(pred);
    ctorTags.set(ctor, preds);
    predArity.set(pred, stmt.head.args.length);
  }

  // Append the proof column to every reference to a proof-carrying predicate.
  // Returns the column variables of the positive references (the sub-proofs),
  // in body order. Also validates stray capture binders on non-proof atoms.
  const injectProofColumns = (body: BodyElement[], collectSubProofs: boolean): string[] => {
    const subProofs: string[] = [];
    for (const el of body) {
      if (!isLiteral(el)) continue;
      const pred = el.predicate;
      if (!proofCarrying.has(pred)) {
        if (el.proofVar !== undefined) {
          throw parseErrorAtNode(
            `Cannot capture a proof from '${pred}', which has no named rules`,
            el,
          );
        }
        continue;
      }
      if (el.proofVar !== undefined && el.negated) {
        throw parseErrorAtNode("Cannot mark a proof on a negated atom", el);
      }
      if (!el.parens) {
        // `V : p` shorthand for `V : p(_, ..., _)`: fill one don't-care per
        // declared column before the proof column is appended below. The
        // grammar only drops the parens after a proof capture, so this is
        // always a capture (proofVar set).
        const declared = predArity.get(pred) ?? 0;
        for (let i = 0; i < declared; i++) {
          const dc = mkVar(freshAnon(), el.$cstNode);
          setContainer(dc, el, "args", el.args.length);
          el.args.push(dc);
        }
      }
      // `_ : p(...)` suppresses the sub-proof (omit it from the constructor);
      // `V : p(...)` captures it into `V`; a bare `p(...)` includes it
      // anonymously. A sub-proof is included unless suppressed or negated.
      const suppressed = el.proofVar === "_";
      const included = collectSubProofs && !el.negated && !suppressed;
      let colName: string;
      if (el.proofVar !== undefined && !suppressed) {
        colName = decodeQuotedIdentifier(el.proofVar, el);
      } else if (included) {
        // An anonymous but included sub-proof must still bind, so it needs a
        // non-anonymous name (the native planner drops `$anonN` as don't-care).
        colName = freshProofVar();
      } else {
        // Suppressed, arity-only (query / non-named rule), or negated.
        colName = freshAnon();
      }
      const v = mkVar(colName, el.$cstNode);
      setContainer(v, el, "args", el.args.length);
      el.args.push(v);
      if (included) subProofs.push(colName);
    }
    return subProofs;
  };

  for (const stmt of program.statements) {
    if (isQuery(stmt)) {
      injectProofColumns(stmt.body, false);
      continue;
    }
    if (!isRule(stmt)) continue;
    if (stmt.ruleName === undefined) {
      // Not a named rule: still inject proof columns for any references to
      // proof-carrying predicates, but there is no constructor to build.
      injectProofColumns(stmt.body, false);
      continue;
    }
    // Named rule. Collect head vars and body value vars BEFORE injecting proof
    // columns, so the injected variables aren't mistaken for existential
    // witnesses. Existential values = body vars minus head vars minus captures.
    const headVars = new Set<string>();
    for (const n of streamAll(stmt.head)) if (isVariable(n)) headVars.add(n.name);
    const captureNames = new Set<string>();
    const bodyVars: string[] = [];
    const seenBodyVar = new Set<string>();
    for (const el of stmt.body) {
      if (isLiteral(el) && el.proofVar !== undefined) {
        captureNames.add(decodeQuotedIdentifier(el.proofVar, el));
      }
      for (const n of streamAll(el)) {
        if (isVariable(n) && !seenBodyVar.has(n.name)) {
          seenBodyVar.add(n.name);
          bodyVars.push(n.name);
        }
      }
    }
    const subProofs = injectProofColumns(stmt.body, true);
    const ctor = decodeQuotedIdentifier(stmt.ruleName, stmt.head);
    let argExprs: Expression[];
    if (stmt.ctorParens) {
      // Explicit constructor arguments `:: Ctor(a, b, ...)`: the proof term
      // carries exactly these expressions (typically captured sub-proofs and
      // chosen witnesses), so intermediate body variables stay out of it.
      argExprs = stmt.ctorArgs as Expression[];
    } else {
      // Bare `:: Ctor`: auto-derive the arguments as the existential witnesses
      // followed by the sub-proofs. Existential witnesses are the body's own
      // value variables; a don't-care `_` (desugared to a `$`-prefixed
      // synthetic name) carries no information, so it is excluded.
      const existentialVals = bodyVars.filter(
        (v) => !headVars.has(v) && !captureNames.has(v) && !v.startsWith("$"),
      );
      argExprs = [
        ...existentialVals.map((name) => mkVar(name, stmt.head.$cstNode)),
        ...subProofs.map((name) => mkVar(name, stmt.head.$cstNode)),
      ];
    }
    // The `$proof` tag is the qualified name `<predicate>::<Ctor>`, so a match
    // can tell two predicates' same-named constructors apart.
    const qualified = `${stmt.head.predicate}::${ctor}`;
    ctorArity.set(qualified, argExprs.length);
    const proofTerm = buildProofTerm(qualified, argExprs, stmt.head.$cstNode);
    setContainer(proofTerm, stmt.head, "args", stmt.head.args.length);
    (stmt.head.args as Expression[]).push(proofTerm);
  }

  // Constructor terms. A constructor `Ctor(p...)` is never a value builder:
  // it always matches a proof of its predicate. Proofs are built only by the
  // labelled rule that introduces the proof column (the `:: Ctor` head
  // annotation, above). Everywhere a constructor term appears -- on a side of
  // a body/query equality, or (read as an implicit equality) as a head or
  // body-atom argument -- it desugars to a capture of the predicate's proof
  // column plus a tag guard and one match per argument, all expressed with the
  // existing `value` accessors. A variable argument binds via `=`, a literal
  // argument becomes a guard, `_` binds a throwaway, and a nested constructor
  // recurses. Because the match includes the `scrut : Pred(_)` capture, the
  // scrutinee is range-restricted to the predicate's (finite) proofs -- so a
  // constructor in an output position relates to an existing proof rather than
  // inventing a new value. See spec section 8.4.
  if (ctorTags.size > 0) {
    let patVarCounter = 0;
    const freshPat = (): string => {
      let name = `$pat${patVarCounter++}`;
      while (usedNames.has(name)) name = `$pat${patVarCounter++}`;
      return name;
    };

    // Resolve a `FunctionCall` to the constructor it names (predicate + qualified
    // `pred::Ctor` name), or `undefined` if it is not a constructor term (an
    // ordinary function / aggregate call). A `p::Ctor` form names predicate `p`;
    // a bare `Ctor` resolves to the unique predicate declaring it, erroring when
    // several predicates share the tag.
    const resolveCtor = (
      e: Expression | undefined,
    ): { pred: string; qualified: string } | undefined => {
      if (e === undefined || e.$type !== "FunctionCall") return undefined;
      const fc = e as FunctionCall;
      const preds = ctorTags.get(fc.name);
      if (fc.qualifier !== undefined) {
        const pred = decodeQuotedIdentifier(fc.qualifier, fc);
        if (!preds?.has(pred)) {
          throw parseErrorAtNode(`Predicate '${pred}' has no constructor '${fc.name}'`, fc);
        }
        return { pred, qualified: `${pred}::${fc.name}` };
      }
      if (!preds || preds.size === 0) return undefined;
      if (preds.size > 1) {
        const options = [...preds].map((p) => `${p}::${fc.name}`).join(", ");
        throw parseErrorAtNode(
          `Constructor '${fc.name}' is ambiguous across predicates; qualify it (${options})`,
          fc,
        );
      }
      return { pred: [...preds][0]!, qualified: `${[...preds][0]}::${fc.name}` };
    };
    const isCtorTerm = (e: Expression | undefined): e is FunctionCall =>
      resolveCtor(e) !== undefined;

    // Synthesise `scrutVar : Pred(_)` as a fully-injected atom: one don't-care
    // per declared column, then `scrutVar` in the trailing proof-column slot.
    // Built directly in post-injection shape because injectProofColumns has
    // already run by now.
    const captureAtom = (pred: string, scrutVar: string, cst: Cst): BodyElement => {
      const declared = predArity.get(pred) ?? 0;
      const args: Expression[] = [];
      for (let i = 0; i < declared; i++) args.push(mkVar(freshAnon(), cst));
      args.push(mkVar(scrutVar, cst));
      const lit = {
        $type: "Literal",
        predicate: pred,
        negated: false,
        args,
        $cstNode: cst,
      } as unknown as BodyElement;
      args.forEach((a, i) => setContainer(a, lit as unknown as AstNode, "args", i));
      return lit;
    };

    // Emit the accessor matches for `scrutVar` against `pattern`: a tag guard
    // plus one element per argument. Nested constructor arguments recurse here
    // WITHOUT an added capture -- a component of a real proof is already a
    // proof of its component type, so only the outermost term (via matchTop)
    // needs the range restriction.
    const expandPattern = (
      scrutVar: string,
      pattern: FunctionCall,
      cst: Cst,
      out: BodyElement[],
    ): void => {
      const { qualified } = resolveCtor(pattern)!;
      const arity = ctorArity.get(qualified);
      if (arity !== undefined && pattern.args.length !== arity) {
        throw parseErrorAtNode(
          `Constructor pattern '${qualified}' has ${pattern.args.length} argument(s) but takes ${arity}`,
          pattern,
        );
      }
      // Tag guard: as_string(S["$proof"]) = "pred::Ctor".
      const tag = mkFunctionCall(
        "as_string",
        [mkSubscript(mkVar(scrutVar, cst), mkStringLiteral("$proof", cst), cst)],
        cst,
      );
      out.push(mkEquality(tag, mkStringLiteral(qualified, cst), cst));
      for (let i = 0; i < pattern.args.length; i++) {
        const p = pattern.args[i]!;
        // Accessor: S["args"][i].
        const accessor = mkSubscript(
          mkSubscript(mkVar(scrutVar, cst), mkStringLiteral("args", cst), cst),
          mkNumberLiteral(i, cst),
          cst,
        );
        if (isCtorTerm(p)) {
          const f = freshPat();
          out.push(mkEquality(mkVar(f, cst), accessor, cst));
          expandPattern(f, p, cst, out);
        } else {
          out.push(mkEquality(p, accessor, cst));
        }
      }
    };

    // Match a top-level constructor term: range-restrict the scrutinee to its
    // predicate's proofs, then destructure it.
    const matchTop = (
      scrutVar: string,
      pattern: FunctionCall,
      cst: Cst,
      out: BodyElement[],
    ): void => {
      out.push(captureAtom(resolveCtor(pattern)!.pred, scrutVar, cst));
      expandPattern(scrutVar, pattern, cst, out);
    };

    // Pass 1: a constructor term on a side of a body/query equality. The other
    // side is the scrutinee -- a plain variable is matched directly, anything
    // else is bound to a fresh scrutinee variable first.
    const rewriteBody = (body: BodyElement[]): BodyElement[] => {
      const out: BodyElement[] = [];
      for (const el of body) {
        if (el.$type === "Equality") {
          const leftPat = isCtorTerm(el.left);
          const rightPat = isCtorTerm(el.expr);
          if (leftPat && rightPat) {
            throw parseErrorAtNode("A constructor pattern cannot appear on both sides of '='", el);
          }
          if (leftPat || rightPat) {
            const pattern = (leftPat ? el.left : el.expr) as FunctionCall;
            const scrut = leftPat ? el.expr : el.left;
            let scrutVar: string;
            if (scrut.$type === "Variable") {
              scrutVar = scrut.name;
            } else {
              scrutVar = freshPat();
              out.push(mkEquality(mkVar(scrutVar, el.$cstNode), scrut, el.$cstNode));
            }
            matchTop(scrutVar, pattern, el.$cstNode, out);
            continue;
          }
        }
        out.push(el);
      }
      return out;
    };

    for (const stmt of program.statements) {
      if (isRule(stmt)) {
        const rewritten = rewriteBody(stmt.body);
        stmt.body.splice(0, stmt.body.length, ...rewritten);
        stmt.body.forEach((el, i) => setContainer(el, stmt, "body", i));
      } else if (isQuery(stmt)) {
        const rewritten = rewriteBody(stmt.body);
        stmt.body.splice(0, stmt.body.length, ...rewritten);
        stmt.body.forEach((el, i) => setContainer(el, stmt, "body", i));
      }
    }

    // Pass 2: every remaining constructor term (a head argument, a body-atom
    // argument, or one nested inside an ordinary expression) is read as an
    // implicit equality. Replace it with a fresh variable in place and match
    // that variable against the term in the enclosing rule/query body. Only
    // top-level terms (no constructor-term ancestor) are hoisted; their nested
    // constructor arguments are consumed by expandPattern.
    const enclosingBody = (node: AstNode): { host: AstNode; body: BodyElement[] } | undefined => {
      let cur: AstNode | undefined = node.$container;
      while (cur) {
        if (isRule(cur)) return { host: cur, body: cur.body };
        if (isQuery(cur)) return { host: cur, body: cur.body };
        cur = cur.$container;
      }
      return undefined;
    };
    const hasCtorAncestor = (node: AstNode): boolean => {
      let cur = node.$container;
      while (cur) {
        if (isFunctionCall(cur) && isCtorTerm(cur)) return true;
        cur = cur.$container;
      }
      return false;
    };
    // A constructor term is a match; matching hoists a proof capture into the
    // enclosing body. That capture range-restricts the proof variable, which
    // cannot happen inside a negation (`not X = Ctor(...)`, desugared to a `!`
    // UnaryExpr, or a negated atom). Hoisting it positively there silently
    // changes the meaning, so reject it, like a negated proof capture.
    const hasNegationAncestor = (node: AstNode): boolean => {
      let cur = node.$container;
      while (cur) {
        if (cur.$type === "UnaryExpr" && (cur as { op?: string }).op === "!") return true;
        if (isLiteral(cur) && cur.negated) return true;
        cur = cur.$container;
      }
      return false;
    };

    const topLevel: FunctionCall[] = [];
    for (const node of streamAll(program)) {
      if (isFunctionCall(node) && isCtorTerm(node) && !hasCtorAncestor(node)) {
        if (hasNegationAncestor(node)) {
          throw parseErrorAtNode(
            "A constructor pattern may not appear under negation; match it in a positive body element instead (e.g. capture the proof, then negate a guard on it)",
            node,
          );
        }
        topLevel.push(node);
      }
    }
    for (const call of topLevel) {
      const enc = enclosingBody(call);
      if (enc === undefined) continue;
      const f = freshPat();
      replaceNode(call, mkVar(f, call.$cstNode));
      const additions: BodyElement[] = [];
      matchTop(f, call, call.$cstNode, additions);
      const start = enc.body.length;
      for (let i = 0; i < additions.length; i++) {
        enc.body.push(additions[i]!);
        setContainer(additions[i]!, enc.host, "body", start + i);
      }
    }
  }
}

/** Yield all AST nodes in the tree (depth-first). */
function* streamAll(root: AstNode): Generator<AstNode> {
  yield root;
  yield* AstUtils.streamAllContents(root);
}
