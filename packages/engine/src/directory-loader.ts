// Factory for the file-per-predicate ExtensionalLoader pattern. Each
// directory loader (csv, jsonl, json, mermaid, parquet) reads
// `<directory>/<predicate>.<ext>` and feeds parsed rows into
// `insertRows`. The differences across the five collapse to:
//
//   - the file extension
//   - whether the declaration is eligible at all (json's
//     "single value column" gate, mermaid's "2 or 3 string columns")
//   - the per-format parse step, over text or over bytes
//
// Bun-only: imports `node:path` and calls `Bun.file(...)` directly. The
// browser playground uses its own in-memory loaders and never reaches
// this module — kept off the engine root entry to stop bundlers from
// pulling Bun globals into the browser graph.

import { join } from "node:path";
import type { ExtDecl } from "datamog-core";
import type { Backend } from "./backend.ts";
import { type ExtensionalLoader, type LoadResult, insertRows } from "./loader.ts";

type ParsedRows = Promise<Record<string, unknown>[]> | Record<string, unknown>[];

export interface DirectoryLoaderOptions {
  /** Loader name surfaced via `ExtensionalLoader.name`. */
  name: string;
  /** File extension (with dot, e.g. `.csv`). */
  extension: string;
  /** Directory in which to look up `<predicate><extension>`. */
  directory: string;
  /**
   * Optional eligibility gate evaluated before `Bun.file(...).exists()`.
   * Returning `false` (or throwing) makes `canLoad` return `false`. Use
   * for shape-of-decl gates (e.g. json's "single value column").
   */
  eligible?(decl: ExtDecl): boolean;
  /**
   * Optional pre-parse validation. Throws to reject. Distinct from
   * `eligible` because rejection here is a hard error rather than a
   * "skip me, try the next loader". Mermaid uses this for its 2-or-3
   * column shape check.
   */
  validate?(decl: ExtDecl): void;
}

/**
 * A text format supplies `parse`, a binary one `parseBinary`, and which
 * of the two is present decides how the file is read. Exactly one, as a
 * union rather than two optional fields, so the choice is checked at the
 * call site instead of at run time.
 */
export type DirectoryLoaderConfig = DirectoryLoaderOptions &
  (
    | {
        /**
         * Parse the file's text content into typed rows for `decl`. Called
         * once per matched declaration with the file already read.
         */
        parse(content: string, decl: ExtDecl): ParsedRows;
      }
    | {
        /** Parse the file's bytes into typed rows for `decl`. */
        parseBinary(buffer: ArrayBuffer, decl: ExtDecl): ParsedRows;
      }
  );

/**
 * `ExtensionalLoader` exposing `readRows(decl)` for unit tests, in
 * addition to the `canLoad` / `load` interface methods.
 */
export interface DirectoryLoader extends ExtensionalLoader {
  readRows(decl: ExtDecl): Promise<Record<string, unknown>[]>;
}

export function createDirectoryLoader(config: DirectoryLoaderConfig): DirectoryLoader {
  const filePath = (decl: ExtDecl) =>
    join(config.directory, `${decl.predicate}${config.extension}`);

  return {
    name: config.name,

    async canLoad(decl: ExtDecl): Promise<boolean> {
      if (config.eligible && !config.eligible(decl)) return false;
      return Bun.file(filePath(decl)).exists();
    },

    async load(decl: ExtDecl, backend: Backend): Promise<LoadResult> {
      const rows = await this.readRows(decl);
      await insertRows(backend, decl, rows);
      return { rowsLoaded: rows.length };
    },

    async readRows(decl: ExtDecl): Promise<Record<string, unknown>[]> {
      config.validate?.(decl);
      const file = Bun.file(filePath(decl));
      return "parseBinary" in config
        ? await config.parseBinary(await file.arrayBuffer(), decl)
        : await config.parse(await file.text(), decl);
    },
  };
}
