import type { Example } from "../examples/index.ts";
import type { Theme } from "../lib/theme.ts";
import type { BackendName } from "../worker/bridge.ts";

/**
 * Default per-stratum iteration cap for the playground's in-memory
 * interpreters. On by default; the user can raise it or turn it off. See
 * `doc/design/finiteness-checking.md`.
 */
export const DEFAULT_ITERATION_CAP = 1000;

interface ToolbarProps {
  onRun: () => void;
  isRunning: boolean;
  ready: boolean;
  canRun: boolean;
  /** True when the linter has surfaced at least one error diagnostic. */
  hasErrors: boolean;
  /** True when the program contains at least one `?-` query. */
  hasQueries: boolean;
  backend: BackendName;
  onBackendChange: (backend: BackendName) => void;
  examples: Example[];
  onLoadExample: (index: number) => void;
  theme: Theme;
  onToggleTheme: () => void;
  showWarnings: boolean;
  onToggleWarnings: () => void;
  /** Per-stratum iteration cap for the interpreters; null means unlimited. */
  iterationCap: number | null;
  onIterationCapChange: (value: number | null) => void;
}

/** The interpreter backends the iteration cap applies to. */
function isInterpreted(backend: BackendName): boolean {
  return backend === "native" || backend === "seminaive";
}

const NATIVE_BACKEND_OPTIONS = [
  { value: "native", label: "Interpreted (naive, step-by-step)" },
  { value: "seminaive", label: "Interpreted (seminaive, step-by-step)" },
] as const satisfies readonly { value: BackendName; label: string }[];

const SQL_BACKEND_OPTIONS = [
  { value: "sqlite", label: "Compiled to SQLite (runs in browser)" },
  { value: "postgres", label: "Compiled to PostgreSQL (code generation only)" },
] as const satisfies readonly { value: BackendName; label: string }[];

const ALL_BACKEND_OPTIONS = [...NATIVE_BACKEND_OPTIONS, ...SQL_BACKEND_OPTIONS];

function isBackendName(value: string): value is BackendName {
  return ALL_BACKEND_OPTIONS.some((opt) => opt.value === value);
}

const SunIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

const MoonIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const WarningIcon = ({ muted }: { muted: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
    {muted && <line x1="3" y1="3" x2="21" y2="21" />}
  </svg>
);

export function Toolbar({
  onRun,
  isRunning,
  ready,
  canRun,
  hasErrors,
  hasQueries,
  backend,
  onBackendChange,
  examples,
  onLoadExample,
  theme,
  onToggleTheme,
  showWarnings,
  onToggleWarnings,
  iterationCap,
  onIterationCapChange,
}: ToolbarProps) {
  return (
    <div class="toolbar">
      <div class="toolbar-left">
        <img
          src={`${import.meta.env.BASE_URL}datamog-mark.png`}
          alt="Datamog"
          class="toolbar-logo"
        />
        <a
          class="toolbar-title"
          href={import.meta.env.BASE_URL}
          title="Start a fresh playground"
          onClick={(e) => {
            // Plain click resets to a fresh playground: drop the program/data
            // from the URL hash, then reload so the default example boots.
            // Modifier-clicks fall through to the href to open it in a new tab.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            history.replaceState(null, "", import.meta.env.BASE_URL);
            location.reload();
          }}
        >
          Datamog Playground
        </a>
        <select
          class="example-select"
          onChange={(e) => {
            const idx = e.currentTarget.selectedIndex - 1;
            if (idx >= 0) onLoadExample(idx);
            e.currentTarget.selectedIndex = 0;
          }}
        >
          <option>Load example...</option>
          {examples.map((ex, i) => (
            <option key={ex.name} value={i}>
              {ex.name} — {ex.description}
            </option>
          ))}
        </select>
      </div>
      <div class="toolbar-right">
        <a
          class="btn btn-secondary"
          href={`${import.meta.env.BASE_URL}spec.html`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the Datamog language specification"
        >
          Spec
        </a>
        <select
          class="backend-select"
          value={backend}
          title="Select a backend. Native and SQLite execute in the browser; other backends show the generated SQL only."
          onChange={(e) => {
            const value = e.currentTarget.value;
            if (isBackendName(value)) onBackendChange(value);
          }}
        >
          {NATIVE_BACKEND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
          <hr />
          {SQL_BACKEND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {isInterpreted(backend) && (
          <label
            class="itercap"
            title="Stop after this many fixed-point passes per stratum so a non-terminating program returns a partial result instead of hanging. Uncheck for no limit."
          >
            <input
              type="checkbox"
              checked={iterationCap !== null}
              onChange={(e) =>
                onIterationCapChange(e.currentTarget.checked ? DEFAULT_ITERATION_CAP : null)
              }
            />
            <span>cap</span>
            <input
              type="number"
              min="1"
              class="itercap-input"
              value={iterationCap ?? ""}
              disabled={iterationCap === null}
              onInput={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isInteger(n) && n >= 1) onIterationCapChange(n);
              }}
            />
          </label>
        )}
        <button
          type="button"
          class="btn btn-secondary btn-icon btn-warnings-toggle"
          onClick={onToggleWarnings}
          title={showWarnings ? "Hide warnings" : "Show warnings"}
          aria-label={showWarnings ? "Hide warnings" : "Show warnings"}
          aria-pressed={showWarnings}
        >
          <WarningIcon muted={!showWarnings} />
        </button>
        <button
          type="button"
          class="btn btn-secondary btn-icon"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          onClick={onRun}
          disabled={isRunning || !ready || !canRun || hasErrors || !hasQueries}
          title={
            !canRun
              ? "This backend does not run in the browser"
              : hasErrors
                ? "Fix the errors in the editor before running"
                : !hasQueries
                  ? "Add a `?- ...` query to the program before running"
                  : undefined
          }
        >
          {isRunning ? "Running..." : "Run"}
          {ready && !isRunning && canRun && !hasErrors && hasQueries && (
            <span class="shortcut">Ctrl+Enter</span>
          )}
        </button>
      </div>
    </div>
  );
}
