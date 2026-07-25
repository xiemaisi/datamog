import type { QueryResult } from "datamog-engine";
import { renderQueryResult, renderRunError } from "./results-view.ts";

/** Run state for one query, shown in the result popover. */
export type RunState =
  | { kind: "loading" }
  | { kind: "result"; result: QueryResult; warning?: string }
  | { kind: "error"; message: string };

// At most one popover (data or result) open at a time would be ideal, but the
// data popover tracks its own singleton; this tracks the result one.
let current: { el: HTMLElement; dispose: () => void } | null = null;

function closeCurrent(): void {
  current?.dispose();
  current = null;
}

function summary(state: RunState): string {
  if (state.kind === "loading") return "running…";
  if (state.kind === "error") return "error";
  const rows = state.result.rows;
  const arity = rows.length > 0 ? Object.keys(rows[0]!).length : 0;
  if (rows.length === 0) return "no";
  if (arity === 0) return "yes";
  return `${rows.length} row${rows.length === 1 ? "" : "s"}`;
}

/**
 * Open a floating result popover anchored to a query's run marker and return an
 * `update` callback to fill in the run state (loading → result/error). Like the
 * data popover it is appended to <body> (so a host page's content typography
 * can't reach it), sized to the embed's own font, and dismissed on Escape or an
 * outside click.
 */
export function openResultPopover(anchor: HTMLElement): (state: RunState) => void {
  closeCurrent();

  const el = document.createElement("div");
  el.className = "datamog-embed-popover datamog-embed-result-popover";
  // Match the embed's (host-scaled) font so results stay as legible as the editor.
  const host = anchor.closest<HTMLElement>(".datamog-embed");
  if (host) el.style.fontSize = getComputedStyle(host).fontSize;

  const header = el.appendChild(document.createElement("div"));
  header.className = "datamog-embed-popover-header";
  const title = header.appendChild(document.createElement("span"));
  title.className = "datamog-embed-popover-title";
  const close = header.appendChild(document.createElement("button"));
  close.type = "button";
  close.className = "datamog-embed-popover-x";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", () => closeCurrent());

  const body = el.appendChild(document.createElement("div"));
  body.className = "datamog-embed-result-body";

  document.body.appendChild(el);

  const place = () => {
    const rect = anchor.getBoundingClientRect();
    el.style.top = `${rect.bottom + 4}px`;
    el.style.left = `${Math.min(rect.left, window.innerWidth - el.offsetWidth - 8)}px`;
  };
  place();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeCurrent();
  };
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node) && e.target !== anchor) closeCurrent();
  };
  document.addEventListener("keydown", onKey);
  // Defer the outside-click listener so the opening click doesn't close it.
  setTimeout(() => document.addEventListener("mousedown", onDown), 0);

  const self = {
    el,
    dispose: () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      el.remove();
    },
  };
  current = self;

  return (state: RunState) => {
    if (current !== self) return; // a newer run replaced this popover
    title.textContent = `Result · ${summary(state)}`;
    body.replaceChildren();
    if (state.kind === "loading") {
      body.textContent = "running…";
    } else if (state.kind === "error") {
      body.appendChild(renderRunError(state.message));
    } else {
      if (state.warning) {
        const warn = body.appendChild(document.createElement("div"));
        warn.className = "datamog-embed-result-warning";
        warn.textContent = state.warning;
      }
      body.appendChild(renderQueryResult(state.result));
    }
    place(); // content size changed; keep it within the viewport
  };
}
