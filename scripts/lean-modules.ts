/** Local source modules for selected proofs; no data loading or proof import. */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import {
  analyze,
  checkModuleBoundaries,
  elaborate,
  inferTypes,
} from "../packages/core/src/index.ts";
import { parseRaw, postProcess } from "../packages/parser/src/index.ts";

export function loadLeanModules(source: string, sourcePath: string) {
  const entry = realpathSync(sourcePath);
  const sources = new Map([[entry, source]]);
  const label = (file: string) => relative(dirname(entry), file).replaceAll("\\", "/");
  const imports: { importer: string; reference: string; file: string }[] = [];
  const entryProgram = parseRaw(source, entry);
  const entryConstraintNodes = new Set(
    entryProgram.statements.filter((s) => s.$type === "Query" && s.isError).map((s) => s.$cstNode),
  );
  const entryRuleNodes = new Set(
    entryProgram.statements.filter((s) => s.$type === "Rule").map((s) => s.$cstNode),
  );
  const entryErrorPredicates = entryProgram.statements.flatMap((s) =>
    s.$type === "Rule" && s.error ? [s.head.predicate] : [],
  );
  const elaborated = elaborate(
    entryProgram,
    (ref, importer) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) || extname(ref) !== ".dl")
        throw new Error("Lean module imports require local .dl files");
      const file = realpathSync(resolve(dirname(importer ?? entry), ref));
      let text = sources.get(file);
      if (text === undefined) {
        text = readFileSync(file, "utf8");
        sources.set(file, text);
      }
      imports.push({ importer: label(importer ?? entry), reference: ref, file: label(file) });
      return { program: parseRaw(text, file), file };
    },
    entry,
  );
  if (elaborated.dataSources.length)
    throw new Error("Lean verification does not support data-file bindings");
  postProcess(elaborated.program);
  const typed = inferTypes(analyze(elaborated.program, entry));
  checkModuleBoundaries(typed, elaborated.boundaries);
  return {
    program: elaborated.program,
    entryPath: label(entry),
    entryErrorPredicates,
    entryRuleNodes,
    entryConstraints: elaborated.program.statements.filter(
      (s) =>
        s.$type === "Query" && s.isError && !s.synthetic && entryConstraintNodes.has(s.$cstNode),
    ),
    typed,
    sources: [...sources]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, text]) => ({ file, path: label(file), text })),
    imports,
    boundaries: elaborated.boundaries.map(
      ({ predicate, expected, expectedNullable, expectedMaximal, note, pos, file }) => ({
        predicate,
        expected,
        expectedNullable,
        expectedMaximal,
        note,
        pos,
        file: file ? label(file) : undefined,
      }),
    ),
  };
}
