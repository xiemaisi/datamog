/** Fresh checks of explicit integer input laws against supplied CSV relations. */
import { resolve } from "node:path";
import type { ExtDecl } from "../packages/core/src/ast.ts";
import type { createVerificationManifest } from "../packages/core/src/verification-manifest.ts";
import { verificationDigest } from "../packages/core/src/verification-manifest.ts";
import { parseCsvContent } from "../packages/loader/csv/src/index.ts";
import type { InputLaw } from "./lean-mutual.ts";

type Manifest = Awaited<ReturnType<typeof createVerificationManifest>>;
export interface InputFile {
  predicate: string;
  file: string;
}

function lawForGoal(manifest: Manifest) {
  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  return manifest.entries
    .filter((entry) => entry.kind === "goal")
    .map((goal) => ({
      id: goal.id,
      laws: goal.closure.flatMap((id) => {
        const node = byId.get(id);
        const statement = node?.statement as { law?: InputLaw; formula?: string } | undefined;
        if (
          node?.kind !== "definition" ||
          typeof statement !== "object" ||
          !statement ||
          !("law" in statement)
        )
          return [];
        if (!statement.law || typeof statement.formula !== "string")
          throw new Error(`Invalid input law definition ${id}`);
        return [{ id: statement.law.id, formula: statement.formula, law: statement.law }];
      }),
    }));
}

function checkLaw(law: InputLaw, rows: Record<string, unknown>[], columns: string[]) {
  if (law.kind === "functional-dependency") {
    const seen = new Map<string, { values: unknown[]; row: number }>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const key = JSON.stringify(law.keyColumns.map((column) => row[columns[column]!]));
      const values = law.outputColumns.map((column) => row[columns[column]!]);
      const previous = seen.get(key);
      if (previous && values.some((value, j) => value !== previous.values[j]))
        throw new Error(
          `Input law ${law.id} fails for ${law.predicate} rows ${previous.row} and ${i + 1}`,
        );
      seen.set(key, { values, row: i + 1 });
    }
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    const value = rows[i]![columns[law.column]!] as number;
    const holds =
      law.op === "<"
        ? value < law.value
        : law.op === "<="
          ? value <= law.value
          : law.op === ">"
            ? value > law.value
            : law.op === ">="
              ? value >= law.value
              : value === law.value;
    if (!holds) throw new Error(`Input law ${law.id} fails for ${law.predicate} row ${i + 1}`);
  }
}

/** Dataset evidence does not change the universal theorem's conditional status. */
export async function validateInputData(
  manifest: Manifest,
  declarations: Map<string, ExtDecl>,
  supplied: InputFile[],
) {
  const goals = lawForGoal(manifest);
  const laws = goals.flatMap((goal) => goal.laws);
  if (!laws.length) throw new Error("No selected goals have input laws to check");
  const required = new Set(laws.map(({ law }) => law.predicate));
  const files = new Map<string, string>();
  for (const { predicate, file } of supplied) {
    if (!predicate || !file || files.has(predicate) || !required.has(predicate))
      throw new Error(`Duplicate, empty, or unneeded input file binding: ${predicate}`);
    files.set(predicate, resolve(file));
  }
  for (const predicate of required)
    if (!files.has(predicate)) throw new Error(`Missing input file for law on ${predicate}`);
  const inputs = [];
  const rowsByPredicate = new Map<string, Record<string, unknown>[]>();
  for (const [predicate, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!file.endsWith(".csv")) throw new Error(`Input-law file must be CSV: ${file}`);
    const decl = declarations.get(predicate);
    if (!decl || decl.columns.some((column) => column.type !== "integer" || column.nullable))
      throw new Error(`Input-law file requires a non-null integer input declaration: ${predicate}`);
    const text = await Bun.file(file).text();
    const rows = parseCsvContent(text, decl, { source: file });
    rowsByPredicate.set(predicate, rows);
    inputs.push({ predicate, file, digest: await verificationDigest(text), rows: rows.length });
  }
  const results = goals
    .filter((goal) => goal.laws.length)
    .map((goal) => {
      for (const { law } of goal.laws)
        checkLaw(
          law,
          rowsByPredicate.get(law.predicate)!,
          declarations.get(law.predicate)!.columns.map((c) => c.name),
        );
      return {
        id: goal.id,
        laws: goal.laws.map(({ id, formula }) => ({ id, formula })),
        status: "premises-satisfied-for-supplied-inputs" as const,
      };
    });
  return {
    schema: "datamog-input-law-dataset-check-v1" as const,
    scope: "supplied-input-relations" as const,
    manifestDigest: manifest.digest,
    inputs,
    goals: results,
  };
}

export async function assertInputDataUnchanged(inputs: { file: string; digest: string }[]) {
  for (const input of inputs)
    if ((await verificationDigest(await Bun.file(input.file).text())) !== input.digest)
      throw new Error(`Input-law file changed during checking: ${input.file}`);
}
