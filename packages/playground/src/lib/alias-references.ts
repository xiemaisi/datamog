import { findTypeAliasDefinitions } from "datamog-core";
import { parseRawLenient } from "datamog-parser";

/** Alias navigation remains available even when the program cannot be analyzed. */
export function collectAliasReferences(source: string) {
  return findTypeAliasDefinitions(parseRawLenient(source)).flatMap((link) => {
    const target = link.targets[0];
    return target
      ? [{ start: link.origin.offset, end: link.origin.end, target: target.offset }]
      : [];
  });
}
