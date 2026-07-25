import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { openDataPopover } from "./data-popover.ts";
import { type EmbedData, type EmbedEngine, formatIterationCap, runProgram } from "./engine.ts";
import { type RunState, openResultPopover } from "./result-popover.ts";
import { type Structure, parseStructure } from "./structure.ts";

/** Extensional data for one predicate: its format and raw text. */
export interface PredData {
  format: "csv" | "jsonl";
  text: string;
}

/** Per-instance configuration, injected through a facet at editor-config time. */
export interface EmbedConfig {
  engine: EmbedEngine;
  /** Initial data per predicate (the editable working copy starts here). */
  initialData: Record<string, PredData>;
  /** Pristine defaults per predicate, used by the Reset action. */
  defaults: Record<string, PredData>;
}

const embedConfig = Facet.define<EmbedConfig, EmbedConfig>({
  combine: (values) => values[0]!,
});

interface DataState {
  current: Map<string, PredData>;
  defaults: Map<string, PredData>;
}

function toMap(record: Record<string, PredData>): Map<string, PredData> {
  return new Map(Object.entries(record).map(([k, v]) => [k, { ...v }]));
}

const setPredData = StateEffect.define<{ pred: string; data: PredData }>();
const resetPredData = StateEffect.define<string>();

const dataField = StateField.define<DataState>({
  create(state) {
    const cfg = state.facet(embedConfig);
    return { current: toMap(cfg.initialData), defaults: toMap(cfg.defaults) };
  },
  update(value, tr) {
    let next = value;
    const ensure = () => {
      if (next === value) next = { current: new Map(value.current), defaults: value.defaults };
    };
    for (const e of tr.effects) {
      if (e.is(setPredData)) {
        ensure();
        next.current.set(e.value.pred, e.value.data);
      } else if (e.is(resetPredData)) {
        ensure();
        const def = next.defaults.get(e.value);
        if (def) next.current.set(e.value, { ...def });
        else next.current.delete(e.value);
      }
    }
    return next;
  },
});

const structureField = StateField.define<Structure>({
  create(state) {
    return parseStructure(state.doc.toString());
  },
  update(value, tr) {
    return tr.docChanged ? parseStructure(tr.state.doc.toString()) : value;
  },
});

function currentEmbedData(view: EditorView): EmbedData {
  const csv: Record<string, string> = {};
  const jsonl: Record<string, string> = {};
  for (const [pred, pd] of view.state.field(dataField).current) {
    if (pd.format === "csv") csv[pred] = pd.text;
    else jsonl[pred] = pd.text;
  }
  return { csv, jsonl };
}

/** Run one query and stream its state (loading → result/error) to a popover. */
async function runQueryAt(
  view: EditorView,
  index: number,
  update: (state: RunState) => void,
): Promise<void> {
  update({ kind: "loading" });
  const engine = view.state.facet(embedConfig).engine;
  const source = view.state.doc.toString();
  const data = currentEmbedData(view);
  try {
    let warning: string | undefined;
    const results = await runProgram(source, data, engine, {
      onIterationCap: (info) => {
        warning = formatIterationCap(info);
      },
    });
    const result = results[index];
    update(
      result
        ? { kind: "result", result, warning }
        : { kind: "error", message: "No result for this query." },
    );
  } catch (err) {
    update({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

class QueryRunWidget extends WidgetType {
  constructor(readonly index: number) {
    super();
  }
  override eq(other: QueryRunWidget): boolean {
    return other.index === this.index;
  }
  toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "datamog-embed-runquery";
    btn.textContent = "▸ run";
    btn.title = "Run this query";
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      // Open the result popover anchored to this marker, then run into it.
      void runQueryAt(view, this.index, openResultPopover(btn));
    });
    return btn;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class ExtChipWidget extends WidgetType {
  constructor(
    readonly pred: string,
    readonly label: string,
    readonly columns: string[],
  ) {
    super();
  }
  override eq(other: ExtChipWidget): boolean {
    return other.pred === this.pred && other.label === this.label;
  }
  toDOM(view: EditorView): HTMLElement {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "datamog-embed-chip";
    chip.textContent = this.label;
    chip.title = `Data source for ${this.pred}`;
    chip.addEventListener("mousedown", (e) => e.preventDefault());
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      const data = view.state.field(dataField);
      openDataPopover({
        anchor: chip,
        predicate: this.pred,
        columns: this.columns,
        initial: data.current.get(this.pred),
        hasDefault: data.defaults.has(this.pred),
        onApply: (pd) => view.dispatch({ effects: setPredData.of({ pred: this.pred, data: pd }) }),
        onReset: () => view.dispatch({ effects: resetPredData.of(this.pred) }),
      });
    });
    return chip;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

function countRows(pd: PredData): number {
  const lines = pd.text.split("\n").filter((l) => l.trim() !== "");
  return pd.format === "csv" ? Math.max(0, lines.length - 1) : lines.length;
}

function chipLabel(pd: PredData | undefined, edited: boolean): string {
  if (!pd) return "◇ set data";
  const n = countRows(pd);
  return `${edited ? "● " : "◆ "}${pd.format} · ${n} row${n === 1 ? "" : "s"}`;
}

function isEdited(data: DataState, pred: string): boolean {
  const cur = data.current.get(pred);
  const def = data.defaults.get(pred);
  if (!cur || !def) return cur !== def;
  return cur.format !== def.format || cur.text !== def.text;
}

function buildDecorations(state: EditorState): DecorationSet {
  const structure = state.field(structureField);
  const data = state.field(dataField);
  const ranges: Range<Decoration>[] = [];

  for (const e of structure.extensionals) {
    const label = chipLabel(data.current.get(e.predicate), isEdited(data, e.predicate));
    ranges.push(
      Decoration.widget({
        widget: new ExtChipWidget(e.predicate, label, e.columns),
        side: 1,
      }).range(Math.min(e.to, state.doc.length)),
    );
  }

  for (const q of structure.queries) {
    const at = Math.min(q.to, state.doc.length);
    ranges.push(Decoration.widget({ widget: new QueryRunWidget(q.index), side: 1 }).range(at));
  }

  return Decoration.set(ranges, true);
}

const isAffordanceEffect = (e: StateEffect<unknown>) => e.is(setPredData) || e.is(resetPredData);

const decorationsField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    if (tr.docChanged || tr.effects.some(isAffordanceEffect)) return buildDecorations(tr.state);
    return value.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Build the inline-affordance extensions for one embed instance: a run marker
 * next to every query (whose result opens in a popover), and a data chip next
 * to every `extensional` declaration. `decorationsField` is listed last so the
 * fields it reads are already updated in `tr.state`.
 */
export function embedAffordances(config: EmbedConfig): Extension {
  return [embedConfig.of(config), dataField, structureField, decorationsField];
}
