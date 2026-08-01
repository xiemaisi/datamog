import { titanicExample } from "./titanic.ts";

export interface Example {
  name: string;
  description: string;
  source: string;
  csvData?: Record<string, string>;
  jsonlData?: Record<string, string>;
  csvUrlData?: Record<string, string>;
  /**
   * No SQL backend can run this program: it uses non-linear recursion or
   * parity-stratified recursion. Read from the `native-only` marker file the
   * CLI example suite already keys off, so the fact lives in one place. The
   * app switches to an interpreter when such an example is loaded, rather than
   * letting the user land on a translation error they did not ask for.
   */
  nativeOnly?: boolean;
}

// Playground metadata, authored per example as a `playground.json` file in its
// CLI example directory. An example opts into the playground simply by having
// this file -- there is no central registration list. We discover them at
// build time and pull the `.dl` source and any `.csv` / `.jsonl` data straight
// from the same directory, so the playground never carries a second copy of
// the example code.
interface PlaygroundMeta {
  name: string;
  description: string;
  // Position in the dropdown (ascending); ties break on directory name.
  order: number;
  // CSV rows to feed the in-browser loader, overriding the directory's native
  // data. Use when the CLI example's data is in a format the playground loader
  // does not understand (e.g. Mermaid). Each value is that CSV file's lines.
  csvDataOverride?: Record<string, string[]>;
}

const EXAMPLE_PREFIX = "../../../cli/examples/";

const metaFiles = import.meta.glob<PlaygroundMeta>("../../../cli/examples/*/playground.json", {
  import: "default",
  eager: true,
});
const dlFiles = import.meta.glob<string>("../../../cli/examples/*/*.dl", {
  query: "?raw",
  import: "default",
  eager: true,
});
const csvFiles = import.meta.glob<string>("../../../cli/examples/*/*.csv", {
  query: "?raw",
  import: "default",
  eager: true,
});
const jsonlFiles = import.meta.glob<string>("../../../cli/examples/*/*.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
});
// The marker is an empty file, so only its presence matters.
const nativeOnlyMarkers = import.meta.glob("../../../cli/examples/*/native-only", {
  query: "?raw",
  import: "default",
  eager: true,
});

function dirOfMeta(metaPath: string): string {
  // ".../cli/examples/<dir>/playground.json" -> "<dir>"
  const rest = metaPath.slice(EXAMPLE_PREFIX.length);
  return rest.slice(0, rest.indexOf("/"));
}

function dataFilesFor(
  dir: string,
  files: Record<string, string>,
  ext: string,
): Record<string, string> | undefined {
  const prefix = `${EXAMPLE_PREFIX}${dir}/`;
  const suffix = `.${ext}`;
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue;
    const predicate = path.slice(prefix.length, -suffix.length);
    out[predicate] = content;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function loadExample(dir: string, meta: PlaygroundMeta): Example {
  const dlKey = `${EXAMPLE_PREFIX}${dir}/${dir}.dl`;
  const source = dlFiles[dlKey];
  if (source === undefined) {
    throw new Error(`Missing CLI example source at ${dlKey}`);
  }
  const override = meta.csvDataOverride
    ? Object.fromEntries(
        Object.entries(meta.csvDataOverride).map(([pred, rows]) => [pred, rows.join("\n")]),
      )
    : undefined;
  return {
    name: meta.name,
    description: meta.description,
    source,
    csvData: override ?? dataFilesFor(dir, csvFiles, "csv"),
    jsonlData: dataFilesFor(dir, jsonlFiles, "jsonl"),
    nativeOnly: `${EXAMPLE_PREFIX}${dir}/native-only` in nativeOnlyMarkers,
  };
}

const discovered = Object.entries(metaFiles)
  .map(([path, meta]) => ({ dir: dirOfMeta(path), meta }))
  .sort((a, b) => a.meta.order - b.meta.order || a.dir.localeCompare(b.dir));

if (discovered.length === 0) {
  throw new Error("No playground examples found (expected cli/examples/*/playground.json)");
}

export const examples: Example[] = [
  ...discovered.map(({ dir, meta }) => loadExample(dir, meta)),
  titanicExample,
];
