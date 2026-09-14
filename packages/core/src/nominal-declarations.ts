import { containsNominalType, typeAliasName, visitNominalReferences } from "datamog-parser";
import { AnalyzerError } from "./analyzer.ts";
import type { Program } from "./ast.ts";

/** Run after elaboration: names must identify actual proof-carrying producers. */
export function validateNominalDeclarations(program: Program): void {
  const proofs = new Set(
    program.statements.flatMap((stmt) =>
      stmt.$type === "Rule" && stmt.ruleName !== undefined
        ? [typeAliasName(stmt.head.predicate)]
        : [],
    ),
  );
  for (const stmt of program.statements) {
    if (stmt.$type === "ExtDecl") {
      for (const column of stmt.columns)
        if (containsNominalType(column)) {
          throw new AnalyzerError(
            `Predicate '${stmt.predicate}', column '${column.name}': external JSON cannot establish nominal proof membership`,
            column.$cstNode?.offset,
            column.$cstNode?.end,
          );
        }
    }
    visitNominalReferences(stmt, (ref) => {
      const name = typeAliasName(ref.predicate);
      ref.predicate = name;
      if (ref.aliasName) {
        if (proofs.has(name))
          throw new AnalyzerError(
            `Ambiguous type name '${ref.aliasName}': both a type alias and a proof-carrying predicate`,
            ref.offset,
            ref.end,
          );
      } else if (!proofs.has(name))
        throw new AnalyzerError(
          `Type name '${name}' does not identify a proof-carrying predicate`,
          ref.offset,
          ref.end,
        );
    });
  }
}
