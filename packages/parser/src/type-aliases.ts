import { type AstNode, AstUtils } from "langium";
import type {
  AnnotatedHeadTerm,
  ColumnDecl,
  Program,
  StructuralType,
  TypeAlias,
  TypeValue,
} from "./generated/ast.js";
import { ParseError } from "./parse-error.js";

/** Aliases are transparent syntax: resolve them in their file before elaboration. */
export function resolveTypeAliases(program: Program, inherited: readonly TypeAlias[] = []): void {
  const definitions = new Map<string, TypeAlias>();
  const resolved = new Map<string, TypeValue>();
  const visiting: string[] = [];
  // Expansion must never silently widen a declared contract. Reject excessive
  // expansion instead of letting an acyclic but exponentially branching alias
  // graph exhaust memory. These limits apply to syntax, not runtime JSON values.
  let remaining = 100_000;
  const fail = (message: string, node: AstNode): never => {
    const cst = node.$cstNode;
    const error = new ParseError(
      message,
      (cst?.range.start.line ?? 0) + 1,
      (cst?.range.start.character ?? 0) + 1,
      cst?.offset,
    );
    error.end = cst?.end;
    throw error;
  };
  const nameOf = (name: string, node: AstNode): string => {
    const decoded = name.startsWith("`") ? name.slice(1, -1).replace(/\\([\s\S])/g, "$1") : name;
    if (decoded.startsWith("$")) fail("Type alias names may not start with '$'", node);
    if (["string", "integer", "float", "boolean", "value", "null"].includes(decoded))
      fail(`Type alias '${decoded}' conflicts with a primitive type`, node);
    return decoded;
  };
  const locals = program.statements.filter((s): s is TypeAlias => s.$type === "TypeAlias");
  for (const declaration of [...inherited, ...locals]) {
    const name = nameOf(declaration.name, declaration);
    if (definitions.has(name)) fail(`Duplicate type alias '${name}'`, declaration);
    definitions.set(name, declaration);
  }

  const resolve = (name: string, site: AstNode): TypeValue => {
    const key = nameOf(name, site);
    const cached = resolved.get(key);
    if (cached) return cached;
    const declaration = definitions.get(key);
    if (!declaration) return fail(`Unknown type alias '${key}'`, site);
    if (visiting.includes(key))
      fail(`Recursive type alias: ${[...visiting, key].join(" -> ")}`, site);
    if (visiting.length >= 128) fail("Type alias nesting exceeds 128 levels", site);
    visiting.push(key);
    const value = expand(declaration.value, 0);
    visiting.pop();
    resolved.set(key, value);
    return value;
  };
  const expand = (
    value: Pick<TypeValue, "type" | "shape" | "alias" | "nullable"> & AstNode,
    depth: number,
  ): TypeValue => {
    if (--remaining < 0 || depth >= 128)
      fail("Type alias expansion exceeds the syntax limit", value);
    if (value.alias !== undefined) {
      const target = resolve(value.alias, value);
      const expanded = expand(target, depth + 1);
      expanded.nullable ||= value.nullable;
      return expanded;
    }
    let shape: StructuralType | undefined;
    if (value.shape?.$type === "ArrayType") {
      shape = { ...value.shape, element: expand(value.shape.element, depth + 1) };
    } else if (value.shape?.$type === "RecordType") {
      const fields = new Set<string>();
      shape = {
        ...value.shape,
        fields: value.shape.fields.map((field) => {
          if (fields.has(field.name)) fail(`Duplicate structural field '${field.name}'`, field);
          fields.add(field.name);
          return { ...field, value: expand(field.value, depth + 1) };
        }),
      };
    }
    return {
      $type: "TypeValue",
      $container: value.$container as TypeValue["$container"],
      $cstNode: value.$cstNode,
      type: shape ? undefined : value.type,
      shape,
      nullable: value.nullable || value.type === "null",
    };
  };
  const apply = (site: ColumnDecl | AnnotatedHeadTerm): void => {
    // A bare Boolean refinement was parsed as a type reference by lookahead.
    // Preserve that existing syntax on an erased witness when no alias has that
    // name. Parenthesising the expression always selects the refinement form.
    if (
      site.$type === "AnnotatedHeadTerm" &&
      site.alias !== undefined &&
      site.name === undefined &&
      !site.nullable &&
      site.expr.$type === "Variable" &&
      site.expr.name === "_" &&
      !definitions.has(nameOf(site.alias, site))
    ) {
      site.refinement = {
        $type: "Variable",
        name: site.alias,
        $container: site,
        $cstNode: site.$cstNode,
      };
      site.alias = undefined;
      return;
    }
    if (site.alias === undefined && !site.shape) return;
    const value = expand(site, 0);
    site.type = value.shape ? "value" : value.type;
    site.shape = value.shape;
    site.nullable = value.nullable;
    site.alias = undefined;
    if (site.shape) {
      AstUtils.linkContentToContainer(site);
      for (const node of AstUtils.streamAllContents(site.shape))
        AstUtils.linkContentToContainer(node);
      AstUtils.linkContentToContainer(site.shape);
    }
  };

  // Validate even unused declarations. Keeping their expanded definitions in
  // the parsed program lets an incremental session reuse them in later chunks.
  for (const declaration of locals) {
    declaration.value = resolve(declaration.name, declaration);
    AstUtils.linkContentToContainer(declaration);
    for (const node of AstUtils.streamAllContents(declaration))
      AstUtils.linkContentToContainer(node);
  }
  for (const statement of program.statements) {
    if (statement.$type === "ExtDecl") statement.columns.forEach(apply);
    else if (statement.$type === "Rule")
      for (const arg of statement.head.args) if (arg.$type === "AnnotatedHeadTerm") apply(arg);
  }
}
