/** Isolated native execution; inputs and module sources come only from a snapshot. */
import { dirname, relative, resolve } from "node:path";
import { DatamogExecutor } from "../packages/engine/src/index.ts";
import { parseRaw } from "../packages/parser/src/index.ts";
import { executeInputSnapshot } from "./lean-input-run.ts";

export interface ExecutionSnapshot {
  source: string;
  file: string;
  modules?: { path: string; text: string }[];
  imports?: { importer: string; reference: string; file: string }[];
}

if (import.meta.main) {
  try {
    const { snapshot, rows } = (await Bun.file(process.argv[2]!).json()) as {
      snapshot: ExecutionSnapshot;
      rows: [string, Record<string, unknown>[]][];
    };
    const root = dirname(snapshot.file);
    const typed = snapshot.modules
      ? DatamogExecutor.prepareElaborated(
          snapshot.source,
          (ref, importer) => {
            const edge = snapshot.imports?.find(
              (e) =>
                e.reference === ref &&
                e.importer === relative(root, importer ?? snapshot.file).replaceAll("\\", "/"),
            );
            const module = snapshot.modules!.find((m) => m.path === edge?.file);
            if (!module) throw new Error(`Missing snapshot module: ${ref}`);
            const file = resolve(root, module.path);
            return { program: parseRaw(module.text, file), file };
          },
          snapshot.file,
        ).program
      : DatamogExecutor.prepare(snapshot.source, snapshot.file);
    const result = await executeInputSnapshot(typed, new Map(rows));
    console.log(JSON.stringify({ result }));
  } catch (error) {
    console.log(
      JSON.stringify({
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: String(error instanceof Error ? error.message : error),
        },
      }),
    );
  }
}
