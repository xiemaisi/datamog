import type { QueryResult } from "datamog-engine";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { CycleModal } from "./components/cycle-modal.tsx";
import { DataPanel } from "./components/data-panel.tsx";
import { Editor } from "./components/editor.tsx";
import { type ResultsTab, TabbedResults } from "./components/tabbed-results.tsx";
import { DEFAULT_ITERATION_CAP, Toolbar } from "./components/toolbar.tsx";
import { examples } from "./examples/index.ts";
import { setCycleHandler } from "./lib/cycle-viewer.ts";
import { setLintStatusHandler } from "./lib/lint-status.ts";
import { type Theme, applyTheme, getStoredTheme } from "./lib/theme.ts";
import { getShowWarnings, setShowWarnings } from "./lib/warnings.ts";
import * as bridge from "./worker/bridge.ts";
import type {
  ActiveCycle,
  BackendName,
  DryRunResult,
  SourceSpan,
  StepResult,
} from "./worker/bridge.ts";
import "./styles/playground.css";

// Backends that actually execute in the browser. SQLite runs via sql.js;
// the native and seminaive backends interpret Datalog directly. Postgres
// can only show generated SQL.
const RUNNABLE_BACKENDS: ReadonlySet<BackendName> = new Set(["sqlite", "native", "seminaive"]);
const STEP_BACKENDS: ReadonlySet<BackendName> = new Set(["native", "seminaive"]);

interface ExtDecl {
  predicate: string;
  columns: string;
}

const EXT_RE = /^\s*input\s+predicate\s+(\w+)\s*\(([^)]+)\)/gm;

function extractExtensionals(source: string): ExtDecl[] {
  const decls: ExtDecl[] = [];
  EXT_RE.lastIndex = 0;
  let match = EXT_RE.exec(source);
  while (match !== null) {
    decls.push({ predicate: match[1]!, columns: match[2]! });
    match = EXT_RE.exec(source);
  }
  return decls;
}

// URL-fragment program loading.
//
// Shape: `#p=<URI-encoded program>[&d=<URI-encoded JSON>][&norun]`. The
// tutorial links directly to the playground with a prefilled program —
// and, optionally, its extensional data — via this fragment. Fragments
// don't hit GitHub Pages' access logs and update in place as the user
// edits, so a "copy link" always reflects the current editor content and
// data.
//
// The `d` param carries the Data panel's per-predicate buffers as
// `{csv?,jsonl?,csvUrl?}` — each a `predicate -> contents/URL` map, with
// empty maps omitted — so a reload (or a shared link) keeps the data, not
// just the program. It's left out entirely when there's no data to store.
//
// When a program is loaded from the fragment, the playground
// auto-runs it once the worker is ready. Pass `&norun` to opt out —
// useful for links that want the reader to inspect the code first.
//
// Corrupt or empty fragments fall through to the default example.
// Compression is a future improvement — URI encoding is fine for
// tutorial-sized snippets and data.

interface ExtData {
  csv: Record<string, string>;
  jsonl: Record<string, string>;
  csvUrl: Record<string, string>;
}

function emptyExtData(): ExtData {
  return { csv: {}, jsonl: {}, csvUrl: {} };
}

interface FragmentParams {
  source: string | null;
  data: ExtData;
  autoRun: boolean;
}

function isStringMap(v: unknown): v is Record<string, string> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}

// Decode the `d=` param into the three data maps. Anything malformed —
// bad percent-encoding, non-JSON, wrong shape — degrades to empty maps
// rather than throwing, matching how a corrupt `p=` falls through.
function parseDataParam(encoded: string): ExtData {
  try {
    const obj = JSON.parse(decodeURIComponent(encoded)) as unknown;
    if (typeof obj !== "object" || obj === null) return emptyExtData();
    const rec = obj as Record<string, unknown>;
    return {
      csv: isStringMap(rec.csv) ? rec.csv : {},
      jsonl: isStringMap(rec.jsonl) ? rec.jsonl : {},
      csvUrl: isStringMap(rec.csvUrl) ? rec.csvUrl : {},
    };
  } catch {
    return emptyExtData();
  }
}

// Encode the non-empty data maps as a `d=` value, or null when there's
// nothing to store (so the param can be omitted from the hash).
function encodeDataParam(data: ExtData): string | null {
  const payload: Partial<ExtData> = {};
  if (Object.keys(data.csv).length > 0) payload.csv = data.csv;
  if (Object.keys(data.jsonl).length > 0) payload.jsonl = data.jsonl;
  if (Object.keys(data.csvUrl).length > 0) payload.csvUrl = data.csvUrl;
  if (Object.keys(payload).length === 0) return null;
  return encodeURIComponent(JSON.stringify(payload));
}

function readFragment(): FragmentParams {
  if (typeof location === "undefined")
    return { source: null, data: emptyExtData(), autoRun: false };
  const hash = location.hash;
  if (!hash.startsWith("#")) return { source: null, data: emptyExtData(), autoRun: false };
  let source: string | null = null;
  let data = emptyExtData();
  let optOut = false;
  let exampleName: string | null = null;
  for (const part of hash.slice(1).split("&")) {
    if (part.startsWith("p=")) {
      try {
        source = decodeURIComponent(part.slice(2));
      } catch {
        // Malformed percent-encoding — fall through to default.
      }
    } else if (part.startsWith("d=")) {
      data = parseDataParam(part.slice(2));
    } else if (part.startsWith("example=")) {
      try {
        exampleName = decodeURIComponent(part.slice(8));
      } catch {
        // Malformed percent-encoding — ignore.
      }
    } else if (part === "norun") {
      optOut = true;
    }
  }
  // `#example=<name>` deep-links a bundled example by name (used by the course
  // slides to hand off a live demo). An explicit `p=` program always wins.
  if (source === null && exampleName !== null) {
    const ex = examples.find((e) => e.name === exampleName);
    if (ex) {
      source = ex.source;
      data = {
        csv: { ...(ex.csvData ?? {}) },
        jsonl: { ...(ex.jsonlData ?? {}) },
        csvUrl: { ...(ex.csvUrlData ?? {}) },
      };
    }
  }
  return { source, data, autoRun: source !== null && !optOut };
}

function writeStateToHash(source: string, data: ExtData): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  // Writebacks always produce `#p=<encoded>[&d=<encoded>]` — we drop any
  // `norun` that was in the loading URL, since it's a one-time
  // initial-load preference. Readers who edit and share the URL get an
  // auto-running link by default.
  const encodedData = encodeDataParam(data);
  const newHash =
    encodedData === null
      ? `#p=${encodeURIComponent(source)}`
      : `#p=${encodeURIComponent(source)}&d=${encodedData}`;
  if (location.hash === newHash) return;
  // replaceState so each keystroke doesn't stack a history entry.
  history.replaceState(null, "", `${location.pathname}${location.search}${newHash}`);
}

export function App() {
  const initialFragment = readFragment();
  const fromHash = initialFragment.source !== null;
  const [source, setSource] = useState(() => initialFragment.source ?? examples[0]!.source);
  // When prefilled from the hash, the extensional data comes from the
  // hash's `d=` param too (empty maps if the link carried only a program).
  // Otherwise we seed the default example's bundled data.
  const [csvData, setCsvData] = useState<Record<string, string>>(() =>
    fromHash ? initialFragment.data.csv : (examples[0]!.csvData ?? {}),
  );
  const [jsonlData, setJsonlData] = useState<Record<string, string>>(() =>
    fromHash ? initialFragment.data.jsonl : (examples[0]!.jsonlData ?? {}),
  );
  const [csvUrlData, setCsvUrlData] = useState<Record<string, string>>(() =>
    fromHash ? initialFragment.data.csvUrl : (examples[0]!.csvUrlData ?? {}),
  );
  const [results, setResults] = useState<QueryResult[] | null>(null);
  const [sqlResult, setSqlResult] = useState<DryRunResult | null>(null);
  const [stepResult, setStepResult] = useState<StepResult | null>(null);
  const [activeTab, setActiveTab] = useState<ResultsTab>("results");
  const [hoveredRange, setHoveredRange] = useState<SourceSpan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [backend, setBackend] = useState<BackendName>("native");
  // Per-stratum iteration cap for the interpreters; null means unlimited.
  const [iterationCap, setIterationCap] = useState<number | null>(DEFAULT_ITERATION_CAP);
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [showWarnings, setShowWarningsState] = useState<boolean>(getShowWarnings);
  const [activeCycle, setActiveCycle] = useState<ActiveCycle | null>(null);
  const [hasErrors, setHasErrors] = useState(false);
  const [hasQueries, setHasQueries] = useState(false);
  const sourceRef = useRef(source);
  const csvDataRef = useRef(csvData);
  const jsonlDataRef = useRef(jsonlData);
  const csvUrlDataRef = useRef(csvUrlData);
  const backendRef = useRef(backend);
  const iterationCapRef = useRef(iterationCap);

  sourceRef.current = source;
  csvDataRef.current = csvData;
  jsonlDataRef.current = jsonlData;
  csvUrlDataRef.current = csvUrlData;
  backendRef.current = backend;
  iterationCapRef.current = iterationCap;

  const canRun = RUNNABLE_BACKENDS.has(backend);

  // Whether to auto-run the prefilled program once the worker is
  // ready. Captured as a ref so the later auto-run effect (below)
  // and the bridge-init effect (next) agree on the same one-time
  // value and re-renders don't re-fire. Latched to false by the
  // auto-run effect after it fires.
  const shouldAutoRunRef = useRef(initialFragment.autoRun);

  useEffect(() => {
    // Minimum splash time: none when we're about to auto-run (every
    // millisecond delays the reader seeing results), a short visible
    // flash otherwise so the mascot registers but doesn't overstay.
    const minMs = shouldAutoRunRef.current ? 0 : 800;
    const minDisplay = new Promise<void>((r) => setTimeout(r, minMs));
    Promise.allSettled([bridge.init(), minDisplay]).then(() => setReady(true));
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Register the module-level dispatcher so the linter's "Show cycle"
  // action — which lives inside a CodeMirror extension and has no
  // React/Preact context — can hand the cycle to this component.
  useEffect(() => {
    setCycleHandler((cycle) => setActiveCycle(cycle));
    return () => setCycleHandler(null);
  }, []);

  // Same indirection for the linter's per-pass status: error count and
  // query presence both gate the Run button.
  useEffect(() => {
    setLintStatusHandler((status) => {
      setHasErrors(status.hasErrors);
      setHasQueries(status.hasQueries);
    });
    return () => setLintStatusHandler(null);
  }, []);

  // Keep the URL fragment in sync with the editor content *and* the Data
  // panel buffers. Skip the first render: if we already loaded from the
  // hash it's redundant, and if we booted the default example we don't
  // want to pollute the URL with it.
  const skipFirstHashWrite = useRef(true);
  useEffect(() => {
    if (skipFirstHashWrite.current) {
      skipFirstHashWrite.current = false;
      return;
    }
    writeStateToHash(source, { csv: csvData, jsonl: jsonlData, csvUrl: csvUrlData });
  }, [source, csvData, jsonlData, csvUrlData]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const toggleWarnings = useCallback(() => {
    setShowWarningsState((prev) => {
      const next = !prev;
      setShowWarnings(next);
      return next;
    });
  }, []);

  const run = useCallback(async () => {
    if (isRunning) return;
    if (hasErrors || !hasQueries) return;
    const current = backendRef.current;
    if (!RUNNABLE_BACKENDS.has(current)) return;
    setIsRunning(true);
    setError(null);
    setRunNotice(null);
    setResults(null);
    if (STEP_BACKENDS.has(current)) setStepResult(null);
    try {
      if (STEP_BACKENDS.has(current)) {
        // The native/seminaive backends give us results + a trace in one call.
        const stepOut = await bridge.step(
          sourceRef.current,
          csvDataRef.current,
          jsonlDataRef.current,
          csvUrlDataRef.current,
          current as "native" | "seminaive",
          iterationCapRef.current ?? undefined,
        );
        setResults(stepOut.queries);
        setStepResult(stepOut);
        if (stepOut.iterationCap) setRunNotice(stepOut.iterationCap);
      } else {
        const queryResults = await bridge.execute(
          sourceRef.current,
          csvDataRef.current,
          jsonlDataRef.current,
          csvUrlDataRef.current,
        );
        setResults(queryResults);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }, [isRunning, hasErrors, hasQueries]);

  // If the page loaded with a program in the URL fragment and auto-run
  // is requested (default when a fragment is present; opt out with
  // `&norun`), fire `run()` once the worker is ready. The ref
  // (declared above) latches so re-renders don't re-fire; `run()`
  // itself already no-ops on backends that can't execute in-browser.
  useEffect(() => {
    if (ready && shouldAutoRunRef.current) {
      shouldAutoRunRef.current = false;
      run();
    }
  }, [ready, run]);

  const fetchSqlFor = useCallback(async (target: BackendName) => {
    // Native / seminaive don't produce SQL; callers should avoid this path for them.
    if (STEP_BACKENDS.has(target)) return;
    setError(null);
    try {
      const result = await bridge.dryRun(sourceRef.current, target);
      setSqlResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleBackendChange = useCallback((next: BackendName) => {
    setBackend(next);
    backendRef.current = next;
    setHoveredRange(null);
    // Any cached SQL was for the previous dialect — drop it so the SQL
    // tab re-fetches for the new backend on next activation.
    setSqlResult(null);
    if (!RUNNABLE_BACKENDS.has(next)) {
      // Results from the previous run were produced by a different
      // backend; clear them so the user doesn't mistake stale output
      // for the current selection.
      setResults(null);
    }
    // Any cached trace belongs to the previous backend's engine; drop it
    // on every backend change so the user isn't looking at stale output.
    setStepResult(null);
  }, []);

  const loadExample = useCallback((index: number) => {
    const ex = examples[index]!;
    setSource(ex.source);
    setCsvData(ex.csvData ?? {});
    setJsonlData(ex.jsonlData ?? {});
    setCsvUrlData(ex.csvUrlData ?? {});
    setResults(null);
    setSqlResult(null);
    setStepResult(null);
    setError(null);
    setHoveredRange(null);
    setActiveTab("results");
  }, []);

  const extensionals = extractExtensionals(source);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
    },
    [run],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const requestSql = useCallback(() => {
    fetchSqlFor(backendRef.current);
  }, [fetchSqlFor]);

  return (
    <div class="playground">
      <Toolbar
        onRun={run}
        isRunning={isRunning}
        ready={ready}
        canRun={canRun}
        hasErrors={hasErrors}
        hasQueries={hasQueries}
        backend={backend}
        onBackendChange={handleBackendChange}
        examples={examples}
        onLoadExample={loadExample}
        theme={theme}
        onToggleTheme={toggleTheme}
        showWarnings={showWarnings}
        onToggleWarnings={toggleWarnings}
        iterationCap={iterationCap}
        onIterationCapChange={setIterationCap}
      />
      <div class="playground-body">
        <div class="editor-side">
          <Editor
            source={source}
            onChange={setSource}
            elements={sqlResult?.elements ?? null}
            hoveredRange={hoveredRange}
            onHoverRange={setHoveredRange}
            showWarnings={showWarnings}
            activeCycle={activeCycle}
          />
          {extensionals.length > 0 && (
            <DataPanel
              extensionals={extensionals}
              csvData={csvData}
              jsonlData={jsonlData}
              csvUrlData={csvUrlData}
              onChange={(nextCsv, nextJsonl, nextCsvUrl) => {
                setCsvData(nextCsv);
                setJsonlData(nextJsonl);
                setCsvUrlData(nextCsvUrl);
              }}
            />
          )}
        </div>
        <div class="output-side">
          {error && <div class="error-box">{error}</div>}
          {runNotice && <div class="notice-box">{runNotice}</div>}
          {ready ? (
            <TabbedResults
              backend={backend}
              activeTab={activeTab}
              onActiveTabChange={setActiveTab}
              results={results}
              stepResult={stepResult}
              sqlResult={sqlResult}
              hoveredRange={hoveredRange}
              onHoverRange={setHoveredRange}
              onRequestSql={requestSql}
            />
          ) : (
            <div class="placeholder">
              <div class="mascot-drive">
                <img
                  src={`${import.meta.env.BASE_URL}datamog.jpg`}
                  alt="Datamog loading"
                  class="mascot-img"
                />
              </div>
            </div>
          )}
        </div>
      </div>
      <CycleModal cycle={activeCycle} onClose={() => setActiveCycle(null)} />
    </div>
  );
}
