/** Display provenance is separate from predicate identity and never affects checking. */
import type { Program } from "./ast.ts";

const labels = new WeakMap<Program, ReadonlyMap<string, string>>();
export function setModuleDiagnosticNames(
  program: Program,
  names: ReadonlyMap<string, string>,
): void {
  labels.set(program, names);
}
export function moduleDiagnosticNames(program: Program): ReadonlyMap<string, string> | undefined {
  return labels.get(program);
}

/** Replace only known generated names, in one pass so labels are never reinterpreted. */
export function formatModuleDiagnostic(
  message: string,
  names?: ReadonlyMap<string, string>,
): string {
  if (!names?.size) return message;
  const escaped = [...names.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return message.replace(
    new RegExp(`(?:${escaped.join("|")})(?![\\p{L}\\p{N}_$])`, "gu"),
    (name) => names.get(name)!,
  );
}
