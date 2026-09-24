/** Bounded producer accumulation for structural type inference. */
import {
  ANY_VALUE,
  NEVER,
  type SemanticType,
  isSemanticSubtype,
  normalizeType,
  unionType,
} from "./semantic-type.ts";

export interface TypeBudget {
  /** Maximum nesting of arrays, tuples, records, and unions. Scalars/proofs are leaves. */
  readonly maxDepth: number;
  /** Maximum fields, tuple components, or alternatives at any single node. */
  readonly maxWidth: number;
}

/** Initial precision policy, not a language-level restriction on values. */
export const DEFAULT_TYPE_BUDGET: TypeBudget = Object.freeze({ maxDepth: 4, maxWidth: 8 });

function validateBudget(budget: TypeBudget): void {
  if (
    !Number.isSafeInteger(budget.maxDepth) ||
    budget.maxDepth < 0 ||
    !Number.isSafeInteger(budget.maxWidth) ||
    budget.maxWidth < 1
  ) {
    throw new Error(
      "Type budget requires a nonnegative integer depth and a positive integer width",
    );
  }
}

/**
 * Bound representation size by replacing excess structure with `value`.
 * Never narrows the input. Traversal bounds children before normalization, so
 * normalization does not first expand or traverse an unbounded input subtree.
 * Inputs are trusted type trees: this is not a validator for malformed types.
 */
export function boundSemanticType(
  input: SemanticType,
  budget: TypeBudget = DEFAULT_TYPE_BUDGET,
): SemanticType {
  validateBudget(budget);
  return bound(input, budget.maxDepth, budget.maxWidth);
}

function bound(type: SemanticType, depth: number, width: number): SemanticType {
  switch (type.kind) {
    case "never":
    case "value":
    case "scalar":
    case "proof":
      return type;
    default:
      if (depth === 0) return ANY_VALUE;
  }
  const child = (t: SemanticType) => bound(t, depth - 1, width);
  switch (type.kind) {
    case "array":
      return { kind: "array", element: child(type.element) };
    case "tuple": {
      if (type.elements.length <= width)
        return normalizeType({ kind: "tuple", elements: type.elements.map(child) });
      let element = NEVER;
      for (const item of type.elements) {
        element = widenSemanticType(element, item, { maxDepth: depth - 1, maxWidth: width });
        if (element.kind === "value" && !element.nonNull) break;
      }
      return { kind: "array", element };
    }
    case "record": {
      const wide = type.fields.length > width;
      // Pick fields by name, independent of their source order. Undeclared
      // fields remain permitted when the width limit hides part of the shape.
      const fields = wide
        ? [...type.fields]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .slice(0, width)
        : type.fields;
      return normalizeType({
        kind: "record",
        fields: fields.map((field) => ({ ...field, type: child(field.type) })),
        additional: wide ? ANY_VALUE : child(type.additional),
      });
    }
    case "union": {
      if (type.members.length > width) return ANY_VALUE;
      const result = unionType(...type.members.map(child));
      return result.kind === "union" && result.members.length > width ? ANY_VALUE : result;
    }
  }
}

/**
 * Accumulate a producer monotonically, then bound the resulting type. Use NEVER
 * as the initial state, and hold the budget fixed throughout a solve. Unknown
 * producers must be deferred by the caller; they are not an empty producer.
 *
 * An already-covered contribution leaves the state alone, avoiding accumulation
 * of redundant structural alternatives. A failed subtype proof can lose precision
 * sooner, but never makes the result unsound. This is widening, not an exact join:
 * scheduling may affect precision. With fixed program names and a fixed budget,
 * the bounded type domain is finite, and each changing result strictly expands
 * its denotation or simplifies to an equivalent bounded representation.
 */
export function widenSemanticType(
  previous: SemanticType,
  contribution: SemanticType,
  budget: TypeBudget = DEFAULT_TYPE_BUDGET,
): SemanticType {
  const old = boundSemanticType(previous, budget);
  const next = boundSemanticType(contribution, budget);
  if (old.kind === "never") return next;
  if (isSemanticSubtype(next, old)) return old;
  if (isSemanticSubtype(old, next)) return next;
  return boundSemanticType(unionType(old, next), budget);
}
