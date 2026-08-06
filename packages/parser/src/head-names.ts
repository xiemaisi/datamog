// Head-argument names: `p(count(*) as N, N + 1)`.
//
// A name is a fresh binder scoped to the head. It denotes the argument at
// that position, may be used by the head's other arguments, and is invisible
// below the `:-`. That last part is what keeps this cheap: the name is
// substituted away here, so no stage after parsing knows it existed, and
// grouping, typing, nullness and codegen all see an ordinary expression.
//
// See doc/design/head-arguments.md §2.

import type { AstNode } from "langium";
import type { Expression, Rule } from "./generated/ast.js";

/** Is this an AST node rather than a string, number, or plain array? */
function isAstNodeValue(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "$type" in value;
}

/**
 * Deep-copy an AST node, reparenting the copy. Each use of a name gets its
 * own copy so the tree stays a tree. `$cstNode` is shared deliberately: an
 * error inside a substituted expression should point at the text the user
 * wrote, which is the original occurrence.
 */
function cloneNode(
  node: AstNode,
  container: AstNode,
  property: string,
  index: number | undefined,
): AstNode {
  const copy: Record<string, unknown> = {
    $type: node.$type,
    $container: container,
    $containerProperty: property,
    $containerIndex: index,
    $cstNode: node.$cstNode,
  };
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    if (Array.isArray(value)) {
      copy[key] = value.map((child: unknown, i) =>
        isAstNodeValue(child) ? cloneNode(child, copy as unknown as AstNode, key, i) : child,
      );
    } else if (isAstNodeValue(value)) {
      copy[key] = cloneNode(value, copy as unknown as AstNode, key, undefined);
    } else {
      copy[key] = value;
    }
  }
  return copy as unknown as AstNode;
}

/** Every variable name mentioned at or below `node`. */
function collectVariableNames(node: AstNode, into: Set<string>): void {
  if (node.$type === "Variable") into.add((node as unknown as { name: string }).name);
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    const children: unknown[] = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (isAstNodeValue(child)) collectVariableNames(child, into);
    }
  }
}

/**
 * Replace each Variable that names a head argument with a copy of that
 * argument's resolved expression. Descends into anything it does not
 * replace, so a name nested arbitrarily deep is still substituted.
 */
function substitute(node: AstNode, resolve: (name: string) => AstNode | undefined): void {
  const replacementFor = (
    child: AstNode,
    property: string,
    index: number | undefined,
  ): AstNode | undefined => {
    if (child.$type !== "Variable") return undefined;
    const resolved = resolve((child as unknown as { name: string }).name);
    return resolved === undefined ? undefined : cloneNode(resolved, node, property, index);
  };

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const child: unknown = value[i];
        if (!isAstNodeValue(child)) continue;
        const replacement = replacementFor(child, key, i);
        if (replacement) value[i] = replacement;
        else substitute(child, resolve);
      }
    } else if (isAstNodeValue(value)) {
      const replacement = replacementFor(value, key, undefined);
      if (replacement) (node as unknown as Record<string, unknown>)[key] = replacement;
      else substitute(value, resolve);
    }
  }
}

/**
 * Substitute every head-argument name in `rule` away. `named` maps each name
 * to the expression it was attached to, already unwrapped from its
 * AnnotatedHeadTerm. Reports duplicates, collisions with body variables, and
 * reference cycles; returns with the head rewritten otherwise.
 */
export function substituteHeadNames(
  rule: Rule,
  named: Map<string, Expression>,
  fail: (message: string, node: { $cstNode?: AstNode["$cstNode"] }) => Error,
): void {
  // A name is a new binder, not a reference, so it must not collide with a
  // variable the body already binds. Writing the equality out is the way to
  // say what such a collision would have meant.
  const bodyVars = new Set<string>();
  for (const element of rule.body) collectVariableNames(element as unknown as AstNode, bodyVars);
  for (const [name, expr] of named) {
    if (bodyVars.has(name)) {
      throw fail(
        `Head argument name '${name}' is also a body variable; head names are fresh, so rename it or write the equality in the body`,
        expr,
      );
    }
  }

  // Resolve each name to a fully substituted expression, depth first, so a
  // name may refer to another regardless of argument order.
  const resolved = new Map<string, AstNode>();
  const visiting = new Set<string>();
  const resolveName = (name: string): AstNode | undefined => {
    const source = named.get(name);
    if (source === undefined) return undefined;
    const done = resolved.get(name);
    if (done) return done;
    if (visiting.has(name)) {
      throw fail(`Head argument name '${name}' refers to itself`, source);
    }
    visiting.add(name);
    const copy = cloneNode(source as unknown as AstNode, rule.head, "args", undefined);
    substitute(copy, resolveName);
    visiting.delete(name);
    resolved.set(name, copy);
    return copy;
  };
  for (const name of named.keys()) resolveName(name);

  substitute(rule.head as unknown as AstNode, resolveName);
}
