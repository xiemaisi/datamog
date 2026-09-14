/** Symbolic predicate references in declaration types; elaboration resolves their names. */
export interface NominalReference {
  predicate: string;
  offset?: number;
  end?: number;
  /** Present only when an alias competes with a potentially proof-carrying input. */
  aliasName?: string;
}
export interface NominalTypeMetadata {
  nominal?: NominalReference;
  nominalConflicts?: NominalReference[];
}

declare module "./generated/ast.js" {
  interface TypeValue extends NominalTypeMetadata {}
  interface ColumnDecl extends NominalTypeMetadata {}
  interface AnnotatedHeadTerm extends NominalTypeMetadata {}
  interface AnnotatedConstructorArgument extends NominalTypeMetadata {}
}

/** Includes lifted annotation objects, which are deliberately not AST nodes. */
export function visitNominalReferences(
  value: unknown,
  visit: (ref: NominalReference) => void,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visitNominalReferences(item, visit);
    return;
  }
  const node = value as Record<string, unknown> & NominalTypeMetadata;
  if (node.nominal) visit(node.nominal);
  for (const ref of node.nominalConflicts ?? []) visit(ref);
  for (const [key, child] of Object.entries(node))
    if (!key.startsWith("$") && key !== "nominal" && key !== "nominalConflicts")
      visitNominalReferences(child, visit);
}

export function containsNominalType(value: unknown): boolean {
  let found = false;
  visitNominalReferences(value, (ref) => {
    if (!ref.aliasName) found = true;
  });
  return found;
}
