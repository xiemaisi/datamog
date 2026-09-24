/** Readable semantic contracts and paths where a subtype guarantee is not established. */
import { type SemanticType, isSemanticSubtype } from "./semantic-type.ts";

/** Bounded display only: ellipses never change the contract being checked. */
export function formatSemanticType(type: SemanticType, depth = 0): string {
  const child = (t: SemanticType) => formatSemanticType(t, depth + 1);
  const list = (items: readonly string[]) =>
    [...items.slice(0, 8), ...(items.length > 8 ? ["…"] : [])].join(", ");
  switch (type.kind) {
    case "never":
      return type.kind;
    case "value":
      return type.nonNull ? "value" : "value?";
    case "scalar":
      return type.name;
    case "proof":
      return `proof of '${type.id.predicate}'`;
    default:
      if (depth >= 6) return "…";
  }
  switch (type.kind) {
    case "array":
      return `[${child(type.element)}]`;
    case "tuple":
      return `tuple(${list(type.elements.slice(0, 9).map(child))})`;
    case "union":
      return [
        ...type.members.slice(0, 8).map(child),
        ...(type.members.length > 8 ? ["…"] : []),
      ].join(" | ");
    case "record": {
      const fields = type.fields
        .slice(0, 9)
        .map((f) => `${JSON.stringify(f.name)}${f.optional ? "?" : ""}: ${child(f.type)}`);
      const extra =
        type.additional.kind === "never"
          ? ""
          : `${fields.length ? ", " : ""}...: ${child(type.additional)}`;
      return `{${list(fields)}${extra}}`;
    }
  }
}

/** A failed subtype proof is not necessarily a counterexample (union coverage is incomplete). */
export function semanticContractMismatch(
  source: SemanticType,
  target: SemanticType,
  path = "$",
): string | undefined {
  if (isSemanticSubtype(source, target)) return undefined;
  const summary = () =>
    `${path}: expected ${formatSemanticType(target)}, inferred ${formatSemanticType(source)}`;
  if (source.kind === "union") {
    for (const member of source.members) {
      const mismatch = semanticContractMismatch(member, target, path);
      if (mismatch) return mismatch;
    }
  }
  if (target.kind === "union") {
    // Nullable declarations should point into their structure when possible.
    const nonNull = target.members.filter((t) => t.kind !== "scalar" || t.name !== "null");
    if (nonNull.length === 1 && source.kind !== "scalar")
      return semanticContractMismatch(source, nonNull[0]!, path);
    return `${summary()} (union coverage not established)`;
  }
  if (source.kind === "record" && target.kind === "record") {
    const from = new Map(source.fields.map((field) => [field.name, field]));
    const to = new Map(target.fields.map((field) => [field.name, field]));
    for (const name of new Set([...to.keys(), ...from.keys()])) {
      const a = from.get(name);
      const b = to.get(name);
      const memberPath = `${path}[${JSON.stringify(name)}]`;
      if (b && !b.optional && (!a || a.optional))
        return `${memberPath}: required field is not guaranteed`;
      const mismatch = semanticContractMismatch(
        a?.type ?? source.additional,
        b?.type ?? target.additional,
        memberPath,
      );
      if (mismatch) return mismatch;
    }
    return (
      semanticContractMismatch(source.additional, target.additional, `${path}[*]`) ?? summary()
    );
  }
  if (source.kind === "array" && target.kind === "array")
    return semanticContractMismatch(source.element, target.element, `${path}[*]`);
  if (source.kind === "tuple" && (target.kind === "array" || target.kind === "tuple")) {
    if (target.kind === "tuple" && source.elements.length !== target.elements.length)
      return `${path}: expected tuple length ${target.elements.length}, inferred ${source.elements.length}`;
    for (const [i, element] of source.elements.entries()) {
      const mismatch = semanticContractMismatch(
        element,
        target.kind === "array" ? target.element : target.elements[i]!,
        `${path}[${i}]`,
      );
      if (mismatch) return mismatch;
    }
  }
  return summary();
}
