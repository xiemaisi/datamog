import type { PrimitiveType } from "datamog-core";

/** Phase the error originated in. Used for both human and JSON-mode rendering. */
export type ErrorPhase = "parse" | "analyze" | "execute" | "command";

export type ReplEvent =
  | DeclaredEvent
  | RuleEvent
  | ResultEvent
  | InfoEvent
  | SchemaEvent
  | SqlEvent
  | ErrorEvent
  | DoneEvent;

export interface DeclaredEvent {
  kind: "declared";
  predicate: string;
  arity: number;
  /** Number of EDB rows the loader inserted; `undefined` for native backends
   *  that don't surface a count. */
  rowsLoaded: number | undefined;
}

export interface RuleEvent {
  kind: "rule";
  predicate: string;
  arity: number;
}

export interface ResultEvent {
  kind: "result";
  /** Result-row column names in declaration order. Empty for `?- p(*).`-style
   *  queries that select all of a predicate's columns under their EDB names. */
  columns: string[];
  /** Per-column declared `PrimitiveType`. Same length as `columns`; entries are
   *  `undefined` when the translator skipped type inference for the column. */
  types: (PrimitiveType | undefined)[];
  /**
   * Per-column nullability, same length and indexing as `types`. Reported beside
   * the base type rather than folded into it, matching `SchemaPredicate`.
   *
   * Without it the event could contradict itself: a client told `["integer"]` and
   * handed a row carrying `null` has been told something false, and under the value
   * model the `?` is precisely what says whether that NULL is the `null` value or an
   * absence. `false` on the paths where `types` is `undefined`, since a backend that
   * reports no type reports no nullability either.
   */
  nullable: boolean[];
  rows: Record<string, unknown>[];
  /** Generated SQL (empty string for native backends). */
  sql: string;
  /** Original Datalog source text for the query. */
  source: string | undefined;
  /** For a named output (`output predicate`), the output predicate's name.
   *  "default" for the `?-` query; undefined when not tracked. */
  label?: string;
}

export interface InfoEvent {
  kind: "info";
  message: string;
}

export interface SchemaEvent {
  kind: "schema";
  predicates: SchemaPredicate[];
}

export interface SchemaPredicate {
  name: string;
  predicateKind: "edb" | "idb";
  /**
   * `nullable` is half of the column's declared type, not a detail: it is what
   * decides whether a SQL NULL in that position is the `null` value or an absence
   * (spec §5.4). Printing the base type alone made `:schema` report `integer` for a
   * column declared `integer?`.
   */
  columns: { name: string; type: PrimitiveType | undefined; nullable: boolean }[];
}

export interface SqlEvent {
  kind: "sql";
  sql: string;
}

export interface ErrorEvent {
  kind: "error";
  phase: ErrorPhase;
  message: string;
  /** 1-based line within the chunk (or command argument), if known. */
  line?: number;
  /** 1-based column within the chunk (or command argument), if known. */
  column?: number;
  /** Source file the error is in, if the input came from one. Undefined for
   *  a live REPL chunk; set once a chunk can reference other files (modules). */
  file?: string;
}

export interface DoneEvent {
  kind: "done";
}
