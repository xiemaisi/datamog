/**
 * Semantic types, independent of the primitive storage types used by backends.
 * Inference and operand lowering use these types while backends retain primitive storage.
 *
 * Unknown inference state is `undefined`, not a SemanticType. `never` is empty;
 * `value` admits every value, including null. Expression absence is separate.
 * Proof references describe existing derived proofs, never permission to build one.
 */
import type { PrimitiveType } from "./ast.ts";

export type ScalarType = Exclude<PrimitiveType, "value">;

/** Use the elaborated predicate identity, not its source spelling. */
export interface ProofTypeId {
  readonly predicate: string;
}

export interface SemanticField {
  readonly name: string;
  readonly type: SemanticType;
  readonly optional: boolean;
}

export type SemanticType =
  | { readonly kind: "never" }
  | { readonly kind: "value" }
  | { readonly kind: "scalar"; readonly name: ScalarType }
  | { readonly kind: "array"; readonly element: SemanticType }
  | { readonly kind: "tuple"; readonly elements: readonly SemanticType[] }
  | {
      readonly kind: "record";
      readonly fields: readonly SemanticField[];
      /** Type of undeclared fields; never means no additional fields. */
      readonly additional: SemanticType;
    }
  | { readonly kind: "union"; readonly members: readonly SemanticType[] }
  | { readonly kind: "proof"; readonly id: ProofTypeId };

export const NEVER: SemanticType = { kind: "never" };
export const ANY_VALUE: SemanticType = { kind: "value" };

export function scalarType(name: ScalarType): SemanticType {
  return { kind: "scalar", name };
}

export function fromPrimitiveType(type: PrimitiveType): SemanticType {
  return type === "value" ? ANY_VALUE : scalarType(type);
}

/** Stable structural key. Proof identity stays nominal; recursion is not unfolded. */
function typeKey(type: SemanticType): string {
  switch (type.kind) {
    case "never":
    case "value":
      return type.kind;
    case "scalar":
      return JSON.stringify([type.kind, type.name]);
    case "proof":
      return JSON.stringify([type.kind, type.id.predicate]);
    case "array":
      return JSON.stringify([type.kind, typeKey(type.element)]);
    case "tuple":
      return JSON.stringify([type.kind, type.elements.map(typeKey)]);
    case "union":
      return JSON.stringify([type.kind, type.members.map(typeKey)]);
    case "record":
      return JSON.stringify([
        type.kind,
        type.fields.map((field) => [field.name, field.optional, typeKey(field.type)]),
        typeKey(type.additional),
      ]);
  }
}

/** Canonicalize structure, flatten unions, and remove empty/redundant alternatives. */
export function normalizeType(type: SemanticType): SemanticType {
  switch (type.kind) {
    case "array":
      return { kind: "array", element: normalizeType(type.element) };
    case "tuple": {
      const elements = type.elements.map(normalizeType);
      return elements.some((t) => t.kind === "never") ? NEVER : { kind: "tuple", elements };
    }
    case "record": {
      const fields = type.fields.map((f) => ({ ...f, type: normalizeType(f.type) }));
      fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (let i = 1; i < fields.length; i++) {
        if (fields[i - 1]!.name === fields[i]!.name) {
          throw new Error(`Duplicate semantic field '${fields[i]!.name}'`);
        }
      }
      if (fields.some((f) => !f.optional && f.type.kind === "never")) return NEVER;
      return { kind: "record", fields, additional: normalizeType(type.additional) };
    }
    case "union": {
      const members = type.members
        .map(normalizeType)
        .flatMap((t) => (t.kind === "union" ? t.members : t.kind === "never" ? [] : [t]));
      if (members.some((t) => t.kind === "value")) return ANY_VALUE;
      const hasFloat = members.some((t) => t.kind === "scalar" && t.name === "float");
      const unique = new Map<string, SemanticType>();
      for (const member of members) {
        if (hasFloat && member.kind === "scalar" && member.name === "integer") continue;
        unique.set(typeKey(member), member);
      }
      const sorted = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (sorted.length === 0) return NEVER;
      if (sorted.length === 1) return sorted[0]![1];
      return { kind: "union", members: sorted.map(([, member]) => member) };
    }
    default:
      return type;
  }
}

/** Structural equality after normalization, not a general subtype decision. */
export function sameSemanticType(a: SemanticType, b: SemanticType): boolean {
  return typeKey(normalizeType(a)) === typeKey(normalizeType(b));
}

/** Exact union; inference will need a separate widening policy for convergence. */
export function unionType(...members: readonly SemanticType[]): SemanticType {
  return normalizeType({ kind: "union", members });
}

/**
 * Sound structural contract check. A target union must contain an alternative
 * accepting the entire source (after splitting source unions). This deliberately
 * does not prove collective coverage by several target record/tuple alternatives.
 * Proofs are nominal, even though their storage representation is a JSON object.
 */
export function isSemanticSubtype(source: SemanticType, target: SemanticType): boolean {
  const a = normalizeType(source);
  const b = normalizeType(target);
  if (a.kind === "never" || b.kind === "value" || typeKey(a) === typeKey(b)) return true;
  if (a.kind === "union") return a.members.every((member) => isSemanticSubtype(member, b));
  if (b.kind === "union") return b.members.some((member) => isSemanticSubtype(a, member));
  if (a.kind === "scalar" && b.kind === "scalar") {
    return a.name === "integer" && b.name === "float";
  }
  if (a.kind === "array" && b.kind === "array") {
    return isSemanticSubtype(a.element, b.element);
  }
  if (a.kind === "tuple" && b.kind === "array") {
    return a.elements.every((element) => isSemanticSubtype(element, b.element));
  }
  if (a.kind === "array" && b.kind === "tuple") {
    return a.element.kind === "never" && b.elements.length === 0;
  }
  if (a.kind === "tuple" && b.kind === "tuple") {
    return (
      a.elements.length === b.elements.length &&
      a.elements.every((element, i) => isSemanticSubtype(element, b.elements[i]!))
    );
  }
  if (a.kind === "record" && b.kind === "record") {
    const names = new Set([...a.fields, ...b.fields].map((field) => field.name));
    for (const name of names) {
      const from = recordField(a, name);
      const to = recordField(b, name);
      if (!to.optional && from.optional) return false;
      if (!isSemanticSubtype(from.type, to.type)) return false;
    }
    return isSemanticSubtype(a.additional, b.additional);
  }
  return false;
}

function recordField(type: Extract<SemanticType, { kind: "record" }>, name: string): SemanticField {
  return (
    type.fields.find((field) => field.name === name) ?? {
      name,
      type: type.additional,
      optional: true,
    }
  );
}

/** Exact intersection of the represented types, distributing over unions. */
export function intersectTypes(left: SemanticType, right: SemanticType): SemanticType {
  const a = normalizeType(left);
  const b = normalizeType(right);
  if (a.kind === "never" || b.kind === "never") return NEVER;
  if (a.kind === "value") return b;
  if (b.kind === "value" || typeKey(a) === typeKey(b)) return a;
  if (a.kind === "union") return unionType(...a.members.map((member) => intersectTypes(member, b)));
  if (b.kind === "union") return unionType(...b.members.map((member) => intersectTypes(a, member)));
  if (a.kind === "scalar" && b.kind === "scalar") {
    return (a.name === "integer" && b.name === "float") ||
      (a.name === "float" && b.name === "integer")
      ? scalarType("integer")
      : NEVER;
  }
  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", element: intersectTypes(a.element, b.element) };
  }
  if (a.kind === "array" && b.kind === "tuple") return intersectTypes(b, a);
  if (a.kind === "tuple" && b.kind === "array") {
    return normalizeType({
      kind: "tuple",
      elements: a.elements.map((element) => intersectTypes(element, b.element)),
    });
  }
  if (a.kind === "tuple" && b.kind === "tuple") {
    if (a.elements.length !== b.elements.length) return NEVER;
    return normalizeType({
      kind: "tuple",
      elements: a.elements.map((element, i) => intersectTypes(element, b.elements[i]!)),
    });
  }
  if (a.kind === "record" && b.kind === "record") {
    const names = new Set([...a.fields, ...b.fields].map((field) => field.name));
    return normalizeType({
      kind: "record",
      fields: [...names].map((name) => {
        const from = recordField(a, name);
        const to = recordField(b, name);
        return {
          name,
          type: intersectTypes(from.type, to.type),
          optional: from.optional && to.optional,
        };
      }),
      additional: intersectTypes(a.additional, b.additional),
    });
  }
  return NEVER;
}

export interface ProjectionType {
  /** Values produced when the projection succeeds. */
  readonly type: SemanticType;
  /** Missing fields, out-of-bounds indices, or incompatible receivers may fail. */
  readonly mayBeAbsent: boolean;
}

/** JSON projection only: proof payloads must be accessed via a checked match. */
export function projectType(input: SemanticType, key: string | number): ProjectionType {
  const type = normalizeType(input);
  const missing: ProjectionType = { type: NEVER, mayBeAbsent: true };
  switch (type.kind) {
    case "never":
      return { type: NEVER, mayBeAbsent: false };
    case "value":
      return { type: ANY_VALUE, mayBeAbsent: true };
    case "record": {
      if (typeof key !== "string") return missing;
      const field = type.fields.find((f) => f.name === key);
      return field
        ? { type: field.type, mayBeAbsent: field.optional }
        : { type: type.additional, mayBeAbsent: true };
    }
    case "array":
      return typeof key === "number" && Number.isInteger(key) && key >= 0
        ? { type: type.element, mayBeAbsent: true }
        : missing;
    case "tuple": {
      if (typeof key !== "number" || !Number.isInteger(key) || key < 0) return missing;
      const element = type.elements[key];
      return element ? { type: element, mayBeAbsent: false } : missing;
    }
    case "union": {
      const results = type.members.map((member) => projectType(member, key));
      return {
        type: unionType(...results.map((result) => result.type)),
        mayBeAbsent: results.some((result) => result.mayBeAbsent),
      };
    }
    default:
      return missing;
  }
}

/** Storage of a whole value, not instructions for extracting it from JSON. */
export function semanticStorageType(input: SemanticType): PrimitiveType | undefined {
  const type = normalizeType(input);
  if (type.kind === "never") return undefined;
  return type.kind === "scalar" ? type.name : "value";
}

export interface ProofConstructorType {
  readonly name: string;
  readonly payload: readonly SemanticType[];
}

/**
 * Constructor signatures supplied by inference after elaboration.
 * References need not be registered yet, allowing mutually recursive signatures.
 * Registration establishes metadata only, never proof membership.
 */
export class ProofTypeRegistry {
  private readonly definitions = new Map<string, ReadonlyMap<string, readonly SemanticType[]>>();

  define(id: ProofTypeId, constructors: readonly ProofConstructorType[]): void {
    if (this.definitions.has(id.predicate)) {
      throw new Error(`Proof type '${id.predicate}' is already defined`);
    }
    const signatures = new Map<string, readonly SemanticType[]>();
    for (const ctor of constructors) {
      if (signatures.has(ctor.name)) {
        throw new Error(`Duplicate constructor '${ctor.name}' in '${id.predicate}'`);
      }
      signatures.set(ctor.name, ctor.payload.map(normalizeType));
    }
    this.definitions.set(id.predicate, signatures);
  }

  /**
   * Check closure after all definitions have been registered. Walk structural
   * payloads but never unfold proof references, so forward and recursive
   * signatures are valid as long as every nominal identity is registered.
   * This validates compiler metadata, not membership of runtime proof values.
   */
  validateReferences(): void {
    for (const [predicate, constructors] of this.definitions) {
      for (const [name, payload] of constructors) {
        for (const [index, root] of payload.entries()) {
          const pending = [root];
          const seen = new Set<SemanticType>();
          while (pending.length > 0) {
            const type = pending.pop()!;
            if (seen.has(type)) continue;
            seen.add(type);
            switch (type.kind) {
              case "proof":
                if (!this.definitions.has(type.id.predicate)) {
                  throw new Error(
                    `Unknown proof type '${type.id.predicate}' in '${predicate}::${name}' payload ${index + 1}`,
                  );
                }
                break;
              case "array":
                pending.push(type.element);
                break;
              case "tuple":
                for (const element of type.elements) pending.push(element);
                break;
              case "union":
                for (const member of type.members) pending.push(member);
                break;
              case "record":
                pending.push(type.additional);
                for (const field of type.fields) pending.push(field.type);
                break;
            }
          }
        }
      }
    }
  }

  payload(id: ProofTypeId, name: string): readonly SemanticType[] | undefined {
    return this.definitions.get(id.predicate)?.get(name);
  }
}

/**
 * Type of a payload after a successful generated constructor match. Unrelated
 * nominal alternatives cannot pass the tag guard. A structural/opaque alternative
 * grants no proof membership, so its payload remains unknown even if its JSON
 * could pass the runtime guard. References are compared, never unfolded.
 */
export function projectProofPayload(
  source: SemanticType,
  predicate: string,
  name: string,
  index: number,
  lookup: (id: ProofTypeId, name: string) => readonly SemanticType[] | undefined,
): SemanticType {
  switch (source.kind) {
    case "never":
    case "scalar":
    case "array":
    case "tuple":
      return NEVER;
    case "proof":
      return source.id.predicate === predicate
        ? (lookup(source.id, name)?.[index] ?? ANY_VALUE)
        : NEVER;
    case "union":
      return unionType(
        ...source.members.map((member) =>
          projectProofPayload(member, predicate, name, index, lookup),
        ),
      );
    default:
      return ANY_VALUE;
  }
}
