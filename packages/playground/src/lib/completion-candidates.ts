import {
  AGGREGATE_FUNCTION_NAMES,
  BUILTIN_BODY_ATOM_NAMES,
  BUILTIN_FUNCTION_NAMES,
  BUILTIN_TYPE_NAMES,
  RESERVED_KEYWORDS,
  collectProofTypeNames,
  collectTypeAliases,
  collectUserPredicates,
  collectVariablesInRule,
  findEnclosingRule,
} from "datamog-core";
import type { PredicateInfo } from "datamog-core";
import { parseLenient } from "datamog-parser";

/**
 * Categorical label for one completion candidate. The UI maps these onto
 * CodeMirror's built-in icon classes (`function`, `variable`, `keyword`,
 * `type`, …) via `iconType` below; keeping the categories here means
 * neither the worker nor the embed has to know how a candidate was
 * derived.
 */
export type CompletionKind =
  | "predicate-ext"
  | "predicate-idb"
  | "body-atom"
  | "function"
  | "aggregate"
  | "keyword"
  | "type"
  | "variable";

export interface CompletionCandidate {
  label: string;
  kind: CompletionKind;
  /** Tooltip-style hint (`extensional(name, age)`, `built-in function`, …). */
  detail?: string;
}

export interface CompletionResult {
  candidates: CompletionCandidate[];
}

/**
 * Collect every completion candidate for `source` at byte `offset`.
 * Pure compute (no I/O, no SQL), so it runs equally well inside the
 * playground worker or directly on the main thread in the embed.
 *
 * Uses `parseLenient` because completion fires mid-edit, where the strict
 * parser would throw on almost every keystroke; the collectors tolerate
 * the partial trees it returns.
 */
export function collectCompletionCandidates(source: string, offset: number): CompletionCandidate[] {
  const program = parseLenient(source);
  const candidates: CompletionCandidate[] = [];
  for (const pi of collectUserPredicates(program)) {
    candidates.push({
      label: pi.name,
      kind: pi.kind === "extensional" ? "predicate-ext" : "predicate-idb",
      detail: predicateDetail(pi),
    });
  }
  for (const name of BUILTIN_BODY_ATOM_NAMES) {
    candidates.push({ label: name, kind: "body-atom", detail: "iteration atom" });
  }
  for (const name of BUILTIN_FUNCTION_NAMES) {
    candidates.push({ label: name, kind: "function", detail: "built-in function" });
  }
  for (const name of AGGREGATE_FUNCTION_NAMES) {
    candidates.push({ label: name, kind: "aggregate", detail: "aggregate" });
  }
  for (const name of RESERVED_KEYWORDS) {
    candidates.push({ label: name, kind: "keyword" });
  }
  for (const name of BUILTIN_TYPE_NAMES) {
    candidates.push({ label: name, kind: "type", detail: "column type" });
  }
  for (const name of collectTypeAliases(program)) {
    candidates.push({ label: name, kind: "type", detail: "type alias" });
  }
  for (const name of collectProofTypeNames(program))
    candidates.push({ label: name, kind: "type", detail: "nominal proof type" });
  const rule = findEnclosingRule(program, offset);
  if (rule) {
    for (const v of collectVariablesInRule(rule)) {
      if (v === "_") continue;
      candidates.push({ label: v, kind: "variable" });
    }
  }
  return candidates;
}

function predicateDetail(pi: PredicateInfo): string {
  if (pi.kind === "extensional") {
    return pi.columns ? `input(${pi.columns.join(", ")})` : `input/${pi.arity}`;
  }
  return `rule/${pi.arity}`;
}

/**
 * Map a `CompletionKind` onto the CSS class CodeMirror appends to the
 * completion icon (`cm-completionIcon-<type>`). The library ships icons
 * for the items on the right of each `→`; the mapping bundles our
 * finer-grained categories into the closest match.
 */
export function iconType(kind: CompletionKind): string {
  switch (kind) {
    case "predicate-ext":
      // Visually distinguish "data table" predicates from rule-defined
      // ones. The library has no built-in `struct`/`class` divergence,
      // so we lean on `class` for extensionals and `function` for IDB.
      return "class";
    case "predicate-idb":
      return "function";
    case "body-atom":
      return "method";
    case "function":
    case "aggregate":
      return "function";
    case "keyword":
      return "keyword";
    case "type":
      return "type";
    case "variable":
      return "variable";
  }
}

/**
 * Boost values nudge equally-matching candidates up or down the list.
 * Range is -99…99. We favour what's already named in the rule (variables)
 * and the user's own predicates over the global keyword/builtin pool —
 * those are usually the right answer when both match.
 */
export function boostFor(kind: CompletionKind): number {
  switch (kind) {
    case "variable":
      return 50;
    case "predicate-ext":
    case "predicate-idb":
      return 30;
    case "body-atom":
    case "function":
    case "aggregate":
      return 10;
    case "type":
      return 0;
    case "keyword":
      return -20;
  }
}
