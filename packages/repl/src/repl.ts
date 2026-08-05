import { AnalyzerError, type PrimitiveType } from "datamog-core";
import type { IncrementalSession, QueryResultWithTypes } from "datamog-engine";
import { ParseError } from "datamog-parser";
import { offsetToLineColumn } from "./boundary.ts";
import type { ErrorEvent, ReplEvent, SchemaPredicate } from "./events.ts";

/** Caller-supplied factory for backend-bound sessions. The REPL calls it
 *  once on first use and again on every `:reset`, closing the previous
 *  binding via the returned `close` callback. The factory is the single
 *  point at which the CLI plugs in its chosen backend / loaders, without
 *  the REPL knowing about either. */
export type SessionFactory = () => Promise<{
  session: IncrementalSession;
  close: () => Promise<void> | void;
}>;

export interface ReplOptions {
  /** Display name of the backend (used by `:backend`). Purely cosmetic. */
  backendName: string;
}

const HELP_TEXT = [
  "Commands:",
  "  :help                  show this help",
  "  :reset                 clear all state and start a fresh backend",
  "  :show                  print accumulated declarations and rules",
  "  :schema                print EDB/IDB names with arities and types",
  "  :sql ?- atom.          preview the SQL a query would generate (no execution)",
  "  :backend               print the current backend name",
  "  :quit | :q             exit",
  "",
  "Datamog input:",
  "  Queries (?- ...) and `input predicate` declarations run as soon as you press",
  "  Enter on a complete line. Rules accumulate across lines and commit on a",
  "  blank line — put every rule for the same predicate in one chunk (predicates",
  "  are locked once committed; use :reset to start over).",
].join("\n");

/**
 * REPL driver. Translates input chunks (raw text or `:`-commands) into a
 * stream of typed events for a host (CLI prompt, JSON ndjson emitter,
 * Jupyter cell magic, ...) to render.
 *
 * Statefully tracks one `IncrementalSession`. `:reset` calls
 * `factory.close` on the current session and constructs a fresh one via
 * the factory.
 */
export class DatamogRepl {
  private current: { session: IncrementalSession; close: () => Promise<void> | void } | undefined;

  constructor(
    private factory: SessionFactory,
    private options: ReplOptions,
  ) {}

  /** Lazily instantiate the backend-bound session on first feed/command. */
  private async ensureSession(): Promise<IncrementalSession> {
    if (!this.current) {
      this.current = await this.factory();
    }
    return this.current.session;
  }

  /** Close the active session, if any. Idempotent. */
  async close(): Promise<void> {
    if (!this.current) return;
    const c = this.current;
    this.current = undefined;
    await c.close();
  }

  /**
   * Process one chunk. A chunk is either a single `:`-command line
   * (leading `:` after stripping whitespace) or a slab of Datamog source.
   *
   * Always returns at least one event. `:quit` is signalled by an
   * `info` event with the "exit" sentinel — host decides whether to
   * call `close()` and stop reading. Errors are returned as events
   * rather than thrown so the host can render them uniformly.
   */
  async feed(chunk: string): Promise<ReplEvent[]> {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) return [];

    if (trimmed.startsWith(":")) {
      return this.runCommand(trimmed);
    }

    return this.runSource(chunk);
  }

  /** True iff the most recent `:quit`/`:q` command was processed. The host
   *  reads this after `feed` to decide whether to exit. */
  shouldQuit = false;

  private async runCommand(line: string): Promise<ReplEvent[]> {
    // Split off the verb. Everything after the first whitespace is the argument.
    const m = /^:(\S+)\s*([\s\S]*)$/.exec(line);
    if (!m) return [errorEvent("command", `unrecognised command '${line}'`)];
    const verb = m[1]!;
    const rest = m[2]!;

    switch (verb) {
      case "help":
      case "h":
      case "?":
        return [{ kind: "info", message: HELP_TEXT }];

      case "quit":
      case "q":
      case "exit":
        this.shouldQuit = true;
        return [{ kind: "info", message: "bye" }];

      case "backend":
        return [{ kind: "info", message: `backend: ${this.options.backendName}` }];

      case "reset":
        await this.close();
        return [{ kind: "info", message: "session reset" }];

      case "show":
        return this.handleShow();

      case "schema":
        return this.handleSchema();

      case "sql":
        return this.handleSql(rest);

      default:
        return [errorEvent("command", `unrecognised command ':${verb}'`)];
    }
  }

  private async handleShow(): Promise<ReplEvent[]> {
    const session = await this.ensureSession();
    const stmts = session.accumulatedStatements;
    if (stmts.length === 0) {
      return [{ kind: "info", message: "(no statements yet)" }];
    }
    const lines: string[] = [];
    for (const stmt of stmts) {
      const text = stmt.$cstNode?.text ?? `<${stmt.$type}>`;
      lines.push(text);
    }
    return [{ kind: "info", message: lines.join("\n") }];
  }

  private async handleSchema(): Promise<ReplEvent[]> {
    const session = await this.ensureSession();
    const typed = session.typedProgram;
    if (!typed) {
      return [{ kind: "schema", predicates: [] }];
    }
    const predicates: SchemaPredicate[] = [];

    for (const [name, decl] of typed.extDecls) {
      predicates.push({
        name,
        predicateKind: "edb",
        columns: decl.columns.map((c) => ({ name: c.name, type: c.type })),
      });
    }

    for (const [name, _rules] of typed.rules) {
      const arity = typed.arities.get(name) ?? 0;
      const types = typed.columnTypes.get(name) ?? [];
      const cols: { name: string; type: PrimitiveType | undefined }[] = [];
      for (let i = 0; i < arity; i++) {
        cols.push({ name: `col${i + 1}`, type: types[i] });
      }
      predicates.push({ name, predicateKind: "idb", columns: cols });
    }

    return [{ kind: "schema", predicates }];
  }

  private async handleSql(arg: string): Promise<ReplEvent[]> {
    const trimmed = arg.trim();
    if (trimmed === "") {
      return [errorEvent("command", ":sql expects a query, e.g. ':sql ?- p(X).'")];
    }
    const session = await this.ensureSession();
    try {
      const sql = session.peekSql(trimmed);
      return [{ kind: "sql", sql }];
    } catch (err) {
      // peekSql throws a plain Error for command-shape complaints (not a
      // single query, no SQL dialect). Surface those as command errors so
      // the host can reach for `:help` cues; parse/analyze errors keep
      // their natural phase.
      if (err instanceof Error && /:sql expects|has no SQL dialect/.test(err.message)) {
        return [errorEvent("command", err.message)];
      }
      return [convertError(err, trimmed)];
    }
  }

  private async runSource(source: string): Promise<ReplEvent[]> {
    let session: IncrementalSession;
    try {
      session = await this.ensureSession();
    } catch (err) {
      return [errorEvent("execute", errorMessage(err))];
    }

    let result: Awaited<ReturnType<IncrementalSession["addStatements"]>>;
    try {
      result = await session.addStatements(source);
    } catch (err) {
      return [convertError(err, source)];
    }

    const events: ReplEvent[] = [];
    for (const decl of result.declarations) {
      events.push({
        kind: "declared",
        predicate: decl.predicate,
        arity: decl.arity,
        rowsLoaded: decl.rowsLoaded,
      });
    }
    for (const rule of result.rules) {
      events.push({ kind: "rule", predicate: rule.predicate, arity: rule.arity });
    }
    for (const r of result.queries) {
      events.push(toResultEvent(r));
    }
    return events;
  }
}

function toResultEvent(r: QueryResultWithTypes): ReplEvent {
  // Prefer the translator's column-name set (insertion-ordered to match
  // the SELECT) over `Object.keys(rows[0])`, so an empty result still
  // carries the column names. Fall back to the first row's keys when
  // the type map is missing (native backends).
  const columns =
    Object.keys(r.columnTypes).length > 0
      ? Object.keys(r.columnTypes)
      : r.rows.length > 0
        ? Object.keys(r.rows[0]!)
        : [];
  const types: (PrimitiveType | undefined)[] = columns.map((c) => r.columnTypes[c]);
  return {
    kind: "result",
    columns,
    types,
    rows: r.rows,
    sql: r.sql,
    source: r.source,
    label: r.label,
  };
}

function errorEvent(
  phase: ErrorEvent["phase"],
  message: string,
  line?: number,
  column?: number,
): ErrorEvent {
  return { kind: "error", phase, message, line, column };
}

function convertError(err: unknown, source: string): ErrorEvent {
  if (err instanceof ParseError) {
    // ParseError's constructor appends ` at line N, column M` to the
    // message. The renderer reads `line`/`column` independently and adds
    // its own location suffix, so strip the duplicate here.
    const suffix = ` at line ${err.line}, column ${err.column}`;
    const message = err.message.endsWith(suffix)
      ? err.message.slice(0, -suffix.length)
      : err.message;
    return {
      kind: "error",
      phase: "parse",
      message,
      line: err.line,
      column: err.column,
      file: err.file,
    };
  }
  if (err instanceof AnalyzerError) {
    if (err.offset !== undefined) {
      const { line, column } = offsetToLineColumn(source, err.offset);
      return {
        kind: "error",
        phase: "analyze",
        message: err.message,
        line,
        column,
        file: err.file,
      };
    }
    return { kind: "error", phase: "analyze", message: err.message, file: err.file };
  }
  return { kind: "error", phase: "execute", message: errorMessage(err) };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
