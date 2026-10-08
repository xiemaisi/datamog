/** Execute the same typed program and row snapshot used by a fresh proof check. */
import { create } from "../packages/backend/native/src/index.ts";
import type { TypedProgram } from "../packages/core/src/types.ts";
import { DatamogExecutor, insertRows } from "../packages/engine/src/index.ts";

export async function executeInputSnapshot(
  typed: TypedProgram,
  rows: Map<string, Record<string, unknown>[]>,
) {
  for (const predicate of typed.extDecls.keys())
    if (!rows.has(predicate)) throw new Error(`Missing execution input: ${predicate}`);
  let capped = false;
  const maxIterations = 1000;
  const backend = await create({
    maxIterations,
    onIterationCap: () => {
      capped = true;
    },
  });
  try {
    const executor = new DatamogExecutor(backend, [
      {
        name: "checked-input-snapshot",
        async canLoad(decl) {
          return rows.has(decl.predicate);
        },
        async load(decl, target) {
          const input = rows.get(decl.predicate)!;
          await insertRows(target, decl, input);
          return { rowsLoaded: input.length };
        },
      },
    ]);
    const results = await executor.executeAnalyzed(typed);
    if (capped)
      throw new Error(
        `Native execution did not reach a fixed point within ${maxIterations} iterations`,
      );
    return {
      backend: "native" as const,
      assurance: "runtime-executed" as const,
      inputSource: "checked-csv-snapshot" as const,
      status: "completed" as const,
      maxIterations,
      results,
    };
  } finally {
    await backend.close();
  }
}
