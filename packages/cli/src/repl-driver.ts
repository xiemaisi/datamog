import { createInterface } from "node:readline";
import { CsvLoader } from "datamog-csv";
import { type Backend, type ExtensionalLoader, IncrementalSession } from "datamog-engine";
import { JsonLoader } from "datamog-json";
import { JsonlLoader } from "datamog-jsonl";
import { MermaidLoader } from "datamog-mermaid";
import { ParquetLoader } from "datamog-parquet";
import {
  DatamogRepl,
  type ReplEvent,
  type SessionFactory,
  isFastCommitChunk,
  isInputComplete,
} from "datamog-repl";
import { bigintSafeReplacer, prettifyProofRows } from "./output.ts";

export interface RunReplOptions {
  backendName: string;
  jsonMode: boolean;
  dataDir: string;
  csvHasHeader: boolean;
  /** Loaders contributed by `--input` flags. Non-directory loaders that
   *  match a single predicate by name. */
  explicitLoaders: ExtensionalLoader[];
  /** Build a fresh backend. Called once on startup and again on every
   *  `:reset`, so each call must hand back an independent instance. */
  createBackend: () => Promise<Backend>;
}

export async function runRepl(opts: RunReplOptions): Promise<void> {
  const factory: SessionFactory = async () => {
    const backend = await opts.createBackend();
    const session = new IncrementalSession(backend, [
      ...opts.explicitLoaders,
      new CsvLoader({ directory: opts.dataDir, hasHeader: opts.csvHasHeader }),
      // The JSONL loader's single-json-column case also matches `.jsonl`
      // files, so place the JSON file loader earlier — its `canLoad`
      // checks for a `.json` (singular) file specifically, so the two
      // don't compete on the same predicate.
      new JsonLoader({ directory: opts.dataDir }),
      new JsonlLoader({ directory: opts.dataDir }),
      new MermaidLoader({ directory: opts.dataDir }),
      new ParquetLoader({ directory: opts.dataDir }),
    ]);
    return {
      session,
      close: () => backend.close(),
    };
  };

  const repl = new DatamogRepl(factory, { backendName: opts.backendName });

  if (opts.jsonMode) {
    await runJsonMode(repl);
  } else {
    await runInteractiveMode(repl, opts.backendName);
  }

  await repl.close();
}

// --- Interactive (TTY) mode --------------------------------------------------

// The primary and continuation prompts are kept the same length so the
// caret column doesn't jump between lines mid-statement.
const PRIMARY_PROMPT = "datamog> ";
const CONTINUATION_PROMPT = "     ... ";

async function runInteractiveMode(repl: DatamogRepl, backendName: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

  process.stdout.write(
    `Datamog REPL (backend: ${backendName}). Type :help for commands, :quit to exit.\n`,
  );
  process.stdout.write(
    "Queries and `input predicate` declarations commit on Enter; rules accumulate until a blank line.\n",
  );
  rl.setPrompt(PRIMARY_PROMPT);
  rl.prompt();

  let buffer = "";

  const commit = async (chunk: string): Promise<boolean> => {
    const events = await repl.feed(chunk);
    renderEventsInteractive(events);
    if (repl.shouldQuit) {
      rl.close();
      return true;
    }
    return false;
  };

  // `for await` on the readline interface serialises async handling of each
  // line — important so we don't reprint the prompt before the previous
  // chunk's events have been rendered.
  for await (const rawLine of rl) {
    const line = rawLine;

    // A leading `:` always commits immediately (commands are line-oriented
    // and never multi-line), but only when nothing is being accumulated —
    // otherwise a `:` showing up mid-buffer is part of a `:-` rule or a
    // similar token, not a meta-command.
    const isCommand = buffer.length === 0 && line.trim().startsWith(":");
    if (isCommand) {
      if (await commit(line)) return;
      rl.setPrompt(PRIMARY_PROMPT);
      rl.prompt();
      continue;
    }

    // Blank line on an empty buffer: just reprompt.
    if (line.trim() === "" && buffer.trim() === "") {
      rl.setPrompt(PRIMARY_PROMPT);
      rl.prompt();
      continue;
    }

    // Blank line on a non-empty buffer: commit whatever we have. The
    // parser/analyzer will surface any incompleteness as a normal error.
    if (line.trim() === "") {
      const chunk = buffer;
      buffer = "";
      if (await commit(chunk)) return;
      rl.setPrompt(PRIMARY_PROMPT);
      rl.prompt();
      continue;
    }

    buffer += `${line}\n`;

    // Fast-commit query chunks: the user expects `?- p(X).` to run on a
    // single Enter, no blank-line dance. Declarations and rules wait for
    // a blank line so multi-rule predicates can be defined naturally
    // across multiple lines (each rule needs the same head, all in one
    // chunk — the v1 IncrementalSession forbids extending a predicate's
    // rule set across chunks).
    if (isFastCommitChunk(buffer) && isInputComplete(buffer)) {
      const chunk = buffer;
      buffer = "";
      if (await commit(chunk)) return;
      rl.setPrompt(PRIMARY_PROMPT);
    } else {
      rl.setPrompt(CONTINUATION_PROMPT);
    }
    rl.prompt();
  }
}

function renderEventsInteractive(events: ReplEvent[]): void {
  for (const ev of events) {
    switch (ev.kind) {
      case "declared":
        if (ev.rowsLoaded === undefined) {
          console.log(`declared ${ev.predicate}/${ev.arity}`);
        } else {
          console.log(`declared ${ev.predicate}/${ev.arity} (${ev.rowsLoaded} rows)`);
        }
        break;
      case "rule":
        console.log(`added rule for ${ev.predicate}/${ev.arity}`);
        break;
      case "result": {
        // Named outputs print under their name; the transient `?-` default
        // (label "default") is the user's own query, so it needs no header.
        if (ev.label && ev.label !== "default") {
          console.log(`-- ${ev.label}`);
        }
        if (ev.rows.length === 0) {
          console.log("(no rows)");
        } else {
          console.table(prettifyProofRows(ev.rows));
        }
        break;
      }

      case "info":
        console.log(ev.message);
        break;
      case "schema": {
        if (ev.predicates.length === 0) {
          console.log("(no predicates)");
          break;
        }
        for (const p of ev.predicates) {
          // `?` for a nullable column, spelled as the declaration spells it. An
          // unknown base type is `?` on its own, which is unambiguous: it sits where
          // a type name goes, not after one.
          const cols = p.columns
            .map((c) => `${c.name}: ${c.type ?? "?"}${c.nullable ? "?" : ""}`)
            .join(", ");
          console.log(`${p.predicateKind} ${p.name}(${cols})`);
        }
        break;
      }
      case "sql":
        console.log(ev.sql);
        break;
      case "error": {
        const loc =
          ev.line !== undefined && ev.column !== undefined
            ? ` at line ${ev.line}, column ${ev.column}`
            : "";
        // A live REPL chunk has no file; `ev.file` is set only once a chunk
        // can reference other files (modules).
        const where = ev.file ? ` in ${ev.file}` : "";
        console.error(`error (${ev.phase}): ${ev.message}${loc}${where}`);
        break;
      }
      case "done":
        // Interactive mode never emits `done` itself, but harmless to ignore.
        break;
    }
  }
}

// --- JSON mode ---------------------------------------------------------------

async function runJsonMode(repl: DatamogRepl): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });

  let buffer = "";

  for await (const rawLine of rl) {
    if (rawLine.trim() === "") {
      // Blank line = chunk boundary. Send what we've buffered (if anything),
      // emit per-statement events, then a `done` sentinel.
      if (buffer.trim().length === 0) {
        emitJson({ kind: "done" });
        continue;
      }
      const chunk = buffer;
      buffer = "";
      const events = await repl.feed(chunk);
      for (const ev of events) emitJson(ev);
      emitJson({ kind: "done" });
      if (repl.shouldQuit) return;
    } else {
      buffer += `${rawLine}\n`;
    }
  }

  // EOF without trailing blank line: flush any pending buffer.
  if (buffer.trim().length > 0) {
    const events = await repl.feed(buffer);
    for (const ev of events) emitJson(ev);
    emitJson({ kind: "done" });
  }
}

function emitJson(event: ReplEvent): void {
  process.stdout.write(`${JSON.stringify(event, bigintSafeReplacer)}\n`);
}
