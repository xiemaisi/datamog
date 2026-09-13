/**
 * Semantic types, independent of the primitive storage types used by backends.
 * Inference and operand lowering use these types while backends retain primitive storage.
 *
 * Unknown inference state is `undefined`, not a SemanticType. `never` is empty;
 * `value` admits every value, including null. Expression absence is separate.
 * Proof references describe existing derived proofs, never permission to build one.
 */
import type { PrimitiveType } from "./ast.ts";
import {
  SemanticTypeLimitError,
  SemanticTypeWork,
  type SemanticTypeWorkOptions,
} from "./semantic-work.ts";
export { SemanticTypeLimitError, type SemanticTypeWorkOptions } from "./semantic-work.ts";

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

/** Stable, linear-size key: embed child encodings instead of quoting them again. */
function typeKey(type: SemanticType, work: SemanticTypeWork): string {
  work.spend();
  const cached = work.keys.get(type);
  if (cached !== undefined) {
    work.spend(cached.length);
    return cached;
  }
  const quoted = (value: string) => {
    work.spend(value.length);
    return JSON.stringify(value);
  };
  const keys = (types: readonly SemanticType[]) => {
    work.spend(types.length);
    return types.map((t) => typeKey(t, work)).join(",");
  };
  let result: string;
  switch (type.kind) {
    case "never":
    case "value":
      result = type.kind;
      break;
    case "scalar":
      result = `["scalar",${quoted(type.name)}]`;
      break;
    case "proof":
      result = `["proof",${quoted(type.id.predicate)}]`;
      break;
    case "array":
      result = `["array",${typeKey(type.element, work)}]`;
      break;
    case "tuple":
    case "union":
      result = `["${type.kind}",[${keys(type.kind === "tuple" ? type.elements : type.members)}]]`;
      break;
    case "record": {
      work.spend(type.fields.length);
      const fields = type.fields.map(
        (f) => `[${quoted(f.name)},${f.optional},${typeKey(f.type, work)}]`,
      );
      result = `["record",[${fields.join(",")}],${typeKey(type.additional, work)}]`;
      break;
    }
  }
  work.spend(result.length);
  work.keys.set(type, result);
  return result;
}

/** Canonicalize exactly; excessive work fails explicitly rather than widening a contract. */
export function normalizeType(
  type: SemanticType,
  options: SemanticTypeWorkOptions = {},
): SemanticType {
  return normalize(type, new SemanticTypeWork(options));
}

function normalize(type: SemanticType, work: SemanticTypeWork, depth = 0): SemanticType {
  work.visit(depth);
  const child = (t: SemanticType) => normalize(t, work, depth + 1);
  const compare = (a: string, b: string) => {
    work.spend(a.length + b.length);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  switch (type.kind) {
    case "array":
      return { kind: "array", element: child(type.element) };
    case "tuple": {
      work.spend(type.elements.length);
      const elements = type.elements.map(child);
      return elements.some((t) => t.kind === "never") ? NEVER : { kind: "tuple", elements };
    }
    case "record": {
      work.spend(type.fields.length);
      const fields = type.fields.map((f) => {
        work.spend(f.name.length);
        return { ...f, type: child(f.type) };
      });
      fields.sort((a, b) => compare(a.name, b.name));
      for (let i = 1; i < fields.length; i++) {
        if (fields[i - 1]!.name === fields[i]!.name)
          throw new Error(`Duplicate semantic field '${fields[i]!.name}'`);
      }
      if (fields.some((f) => !f.optional && f.type.kind === "never")) return NEVER;
      return { kind: "record", fields, additional: child(type.additional) };
    }
    case "union": {
      work.spend(type.members.length);
      const members: SemanticType[] = [];
      for (const raw of type.members) {
        const member = child(raw);
        if (member.kind === "union") {
          work.spend(member.members.length);
          for (const item of member.members) members.push(item);
        } else if (member.kind !== "never") members.push(member);
      }
      if (members.some((t) => t.kind === "value")) return ANY_VALUE;
      const hasFloat = members.some((t) => t.kind === "scalar" && t.name === "float");
      const unique = new Map<string, SemanticType>();
      for (const member of members) {
        if (hasFloat && member.kind === "scalar" && member.name === "integer") continue;
        unique.set(typeKey(member, work), member);
      }
      const sorted = [...unique.entries()].sort(([a], [b]) => compare(a, b));
      if (sorted.length === 0) return NEVER;
      if (sorted.length === 1) return sorted[0]![1];
      return { kind: "union", members: sorted.map(([, member]) => member) };
    }
    case "proof":
      work.spend(type.id.predicate.length);
      return type;
    default:
      return type;
  }
}

/** Structural equality after normalization, not a general subtype decision. */
export function sameSemanticType(
  a: SemanticType,
  b: SemanticType,
  options: SemanticTypeWorkOptions = {},
): boolean {
  const work = new SemanticTypeWork(options);
  return typeKey(normalize(a, work), work) === typeKey(normalize(b, work), work);
}

/** Exact union; producer inference uses a separate bounded widening policy. */
export function unionType(...members: readonly SemanticType[]): SemanticType {
  return normalizeType({ kind: "union", members });
}

/**
 * Sound structural contract check, including bounded collective union coverage.
 * Tuples and records can be split along component unions or field presence;
 * array elements and additional record fields cannot be distributed this way.
 * Split-budget exhaustion declines the guarantee; structural work exhaustion
 * throws SemanticTypeLimitError. Proofs remain nominal even though their storage representation is JSON.
 */
export function isSemanticSubtype(
  source: SemanticType,
  target: SemanticType,
  options: SemanticTypeWorkOptions & { maxUnionSplits?: number } = {},
): boolean {
  const remaining = options.maxUnionSplits ?? 256;
  if (!Number.isSafeInteger(remaining) || remaining < 0)
    throw new Error("Union coverage split limit must be a nonnegative safe integer");
  const work = new SemanticTypeWork(options);
  return semanticSubtype(normalize(source, work), normalize(target, work), { remaining }, work);
}

function semanticSubtype(
  source: SemanticType,
  target: SemanticType,
  budget: { remaining: number },
  work: SemanticTypeWork,
  depth = 0,
): boolean {
  work.visit(depth);
  const recurse = (a: SemanticType, b: SemanticType) =>
    semanticSubtype(a, b, budget, work, depth + 1);
  const a = source;
  const b = target;
  // Compare products componentwise below: whole-product equality keys add work
  // before repeating the same traversal, especially across Cartesian branches.
  if (a.kind === "never" || b.kind === "value" || a === b) return true;
  if (a.kind === "scalar" && b.kind === "scalar")
    return a.name === b.name || (a.name === "integer" && b.name === "float");
  if (a.kind === "proof" && b.kind === "proof") {
    work.spend(a.id.predicate.length + b.id.predicate.length);
    return a.id.predicate === b.id.predicate;
  }
  // Equal wide unions should not search their alternatives quadratically.
  if (a.kind === "union" && b.kind === "union" && typeKey(a, work) === typeKey(b, work))
    return true;
  if (a.kind === "union") return a.members.every((member) => recurse(member, b));
  if (b.kind === "union") {
    if (b.members.some((member) => recurse(a, member))) return true;
    const alternatives = splitProductType(a, budget, work);
    return alternatives?.every((member) => recurse(member, b)) ?? false;
  }
  if (a.kind === "array" && b.kind === "array") {
    return recurse(a.element, b.element);
  }
  if (a.kind === "tuple" && b.kind === "array") {
    return a.elements.every((element) => recurse(element, b.element));
  }
  if (a.kind === "array" && b.kind === "tuple") {
    return a.element.kind === "never" && b.elements.length === 0;
  }
  if (a.kind === "tuple" && b.kind === "tuple") {
    return (
      a.elements.length === b.elements.length &&
      a.elements.every((element, i) => recurse(element, b.elements[i]!))
    );
  }
  if (a.kind === "record" && b.kind === "record") {
    const fromField = recordFields(a, work);
    const toField = recordFields(b, work);
    const names = new Set([...a.fields, ...b.fields].map((field) => field.name));
    for (const name of names) {
      const from = fromField(name);
      const to = toField(name);
      if (!to.optional && from.optional) return false;
      if (!recurse(from.type, to.type)) return false;
    }
    return recurse(a.additional, b.additional);
  }
  return false;
}

/**
 * Split one finite product choice into exact alternatives. In an open record,
 * the absent branch must explicitly forbid the field, not merely omit its entry.
 * Only split one position at a time, avoiding materialization of a Cartesian
 * product. The shared budget caps alternatives across the entire subtype check.
 */
function splitProductType(
  type: SemanticType,
  budget: { remaining: number },
  work: SemanticTypeWork,
  depth = 0,
): SemanticType[] | undefined {
  work.visit(depth);
  if (budget.remaining < 2 || depth >= 32) return undefined;
  if (type.kind === "union") {
    if (type.members.length > budget.remaining) return undefined;
    work.spend(type.members.length);
    budget.remaining -= type.members.length;
    return [...type.members];
  }
  if (type.kind === "tuple") {
    for (const [i, element] of type.elements.entries()) {
      const alternatives = splitProductType(element, budget, work, depth + 1);
      if (alternatives) {
        work.spend(alternatives.length * type.elements.length);
        return alternatives.map((member) => ({
          kind: "tuple",
          elements: type.elements.map((item, j) => (j === i ? member : item)),
        }));
      }
    }
  }
  if (type.kind === "record") {
    for (const [i, field] of type.fields.entries()) {
      const replace = (replacement: SemanticField): SemanticType => {
        work.spend(type.fields.length);
        return { ...type, fields: type.fields.map((item, j) => (j === i ? replacement : item)) };
      };
      if (field.optional && field.type.kind !== "never") {
        budget.remaining -= 2;
        return [replace({ ...field, type: NEVER }), replace({ ...field, optional: false })];
      }
      const alternatives = splitProductType(field.type, budget, work, depth + 1);
      if (alternatives) return alternatives.map((member) => replace({ ...field, type: member }));
    }
  }
  return undefined;
}

function recordFields(
  type: Extract<SemanticType, { kind: "record" }>,
  work: SemanticTypeWork,
): (name: string) => SemanticField {
  work.spend(type.fields.length);
  const fields = new Map(type.fields.map((field) => [field.name, field]));
  return (name) => fields.get(name) ?? { name, type: type.additional, optional: true };
}

/** Exact intersection of the represented types, distributing over unions. */
export function intersectTypes(
  left: SemanticType,
  right: SemanticType,
  options: SemanticTypeWorkOptions = {},
): SemanticType {
  const work = new SemanticTypeWork(options);
  return intersect(normalize(left, work), normalize(right, work), work);
}

const INTERSECTION_LIMIT = Symbol("intersection work limit");

/**
 * Exact intersection or unknown on work exhaustion, never a partial result.
 * The caller's limit caps recursive pairs; the shared structural operation
 * budget also covers normalization and keys. Either exhaustion returns unknown.
 */
export function intersectTypesWithinBudget(
  left: SemanticType,
  right: SemanticType,
  maxWork: number,
): SemanticType | undefined {
  if (!Number.isSafeInteger(maxWork) || maxWork < 0)
    throw new Error("Intersection work limit must be a nonnegative safe integer");
  try {
    const work = new SemanticTypeWork();
    return intersect(normalize(left, work), normalize(right, work), work, { remaining: maxWork });
  } catch (error) {
    if (error === INTERSECTION_LIMIT || error instanceof SemanticTypeLimitError) return undefined;
    throw error;
  }
}

function intersect(
  left: SemanticType,
  right: SemanticType,
  work: SemanticTypeWork,
  budget?: { remaining: number },
  depth = 0,
): SemanticType {
  work.visit(depth);
  if (budget && --budget.remaining < 0) throw INTERSECTION_LIMIT;
  const recurse = (a: SemanticType, b: SemanticType) => intersect(a, b, work, budget, depth + 1);
  const a = left;
  const b = right;
  if (a.kind === "never" || b.kind === "never") return NEVER;
  if (a.kind === "value") return b;
  if (b.kind === "value" || typeKey(a, work) === typeKey(b, work)) return a;
  if (a.kind === "union")
    return normalize(
      { kind: "union", members: a.members.map((member) => recurse(member, b)) },
      work,
    );
  if (b.kind === "union")
    return normalize(
      { kind: "union", members: b.members.map((member) => recurse(a, member)) },
      work,
    );
  if (a.kind === "scalar" && b.kind === "scalar") {
    return (a.name === "integer" && b.name === "float") ||
      (a.name === "float" && b.name === "integer")
      ? scalarType("integer")
      : NEVER;
  }
  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", element: recurse(a.element, b.element) };
  }
  if (a.kind === "array" && b.kind === "tuple") return recurse(b, a);
  if (a.kind === "tuple" && b.kind === "array") {
    return normalize(
      {
        kind: "tuple",
        elements: a.elements.map((element) => recurse(element, b.element)),
      },
      work,
    );
  }
  if (a.kind === "tuple" && b.kind === "tuple") {
    if (a.elements.length !== b.elements.length) return NEVER;
    return normalize(
      {
        kind: "tuple",
        elements: a.elements.map((element, i) => recurse(element, b.elements[i]!)),
      },
      work,
    );
  }
  if (a.kind === "record" && b.kind === "record") {
    const fromField = recordFields(a, work);
    const toField = recordFields(b, work);
    const names = new Set([...a.fields, ...b.fields].map((field) => field.name));
    return normalize(
      {
        kind: "record",
        fields: [...names].map((name) => {
          const from = fromField(name);
          const to = toField(name);
          return {
            name,
            type: recurse(from.type, to.type),
            optional: from.optional && to.optional,
          };
        }),
        additional: recurse(a.additional, b.additional),
      },
      work,
    );
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
export function projectType(
  input: SemanticType,
  key: string | number,
  options: SemanticTypeWorkOptions = {},
): ProjectionType {
  const work = new SemanticTypeWork(options);
  return project(normalize(input, work), key, work);
}

function project(
  type: SemanticType,
  key: string | number,
  work: SemanticTypeWork,
  depth = 0,
): ProjectionType {
  work.visit(depth);
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
      const results = type.members.map((member) => project(member, key, work, depth + 1));
      return {
        type: normalize({ kind: "union", members: results.map((result) => result.type) }, work),
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
    const work = new SemanticTypeWork();
    work.spend(id.predicate.length + constructors.length);
    if (this.definitions.has(id.predicate)) {
      throw new Error(`Proof type '${id.predicate}' is already defined`);
    }
    const signatures = new Map<string, readonly SemanticType[]>();
    for (const ctor of constructors) {
      work.spend(ctor.payload.length + ctor.name.length);
      if (signatures.has(ctor.name)) {
        throw new Error(`Duplicate constructor '${ctor.name}' in '${id.predicate}'`);
      }
      signatures.set(
        ctor.name,
        ctor.payload.map((type) => normalize(type, work)),
      );
    }
    this.definitions.set(id.predicate, signatures);
  }

  /**
   * Check closure after all definitions have been registered. Walk structural
   * payloads but never unfold proof references, so forward and recursive
   * signatures are valid as long as every nominal identity is registered.
   * This validates compiler metadata, not membership of runtime proof values.
   */
  validateReferences(options: SemanticTypeWorkOptions = {}): void {
    const work = new SemanticTypeWork(options);
    work.spend(this.definitions.size);
    for (const [predicate, constructors] of this.definitions) {
      work.spend(constructors.size);
      for (const [name, payload] of constructors) {
        work.spend(payload.length);
        for (const [index, root] of payload.entries()) {
          const pending = [root];
          const seen = new Set<SemanticType>();
          while (pending.length > 0) {
            const type = pending.pop()!;
            work.spend();
            if (seen.has(type)) continue;
            seen.add(type);
            switch (type.kind) {
              case "proof":
                work.spend(type.id.predicate.length);
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
                work.spend(type.elements.length);
                for (const element of type.elements) pending.push(element);
                break;
              case "union":
                work.spend(type.members.length);
                for (const member of type.members) pending.push(member);
                break;
              case "record":
                work.spend(type.fields.length);
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
  options: SemanticTypeWorkOptions = {},
): SemanticType {
  const work = new SemanticTypeWork(options);
  work.spend(predicate.length + name.length);
  const project = (type: SemanticType, depth = 0): SemanticType => {
    work.visit(depth);
    switch (type.kind) {
      case "never":
      case "scalar":
      case "array":
      case "tuple":
        return NEVER;
      case "proof":
        return type.id.predicate === predicate
          ? (lookup(type.id, name)?.[index] ?? ANY_VALUE)
          : NEVER;
      case "union":
        return normalize(
          { kind: "union", members: type.members.map((member) => project(member, depth + 1)) },
          work,
        );
      default:
        return ANY_VALUE;
    }
  };
  return normalize(project(normalize(source, work)), work);
}
