export { analyze, type AnalyzedProgram } from "datamog-core";
export type { Backend, QueryResult } from "./backend.ts";
export {
  colList,
  emptyAnchor,
  ident,
  type MutualCteParts,
  mutualCteParts,
  type MutualRuleTranslator,
  SQL_TYPE_MAP,
  type SqlDialect,
  sqlTypeFor,
} from "./dialect.ts";
export {
  type ConstraintViolation,
  ConstraintViolationError,
  formatConstraintViolations,
  projectConstraintRows,
  toViolation,
} from "./constraints.ts";
export { DatamogExecutor } from "./executor.ts";
export { expandGitHubShorthand } from "./github-shorthand.ts";
export {
  type DeclarationApplied,
  type IncrementalResult,
  IncrementalSession,
  type QueryResultWithTypes,
  type RuleApplied,
} from "./incremental.ts";
export {
  bigintSafeReplacer,
  canonicalizeJson,
  compareJsonbObjectKeys,
  formatProofTerm,
  isJsonValue,
  type JsonValue,
} from "./json-canonical.ts";
export {
  checkColumnValue,
  checkValue,
  coerceColumnValue,
  coerceValue,
  type ExtensionalLoader,
  insertRows,
  loadExtensionalData,
  type LoadResult,
} from "./loader.ts";
export { mermaidEscape, rowsToMermaid } from "./mermaid-output.ts";
export { translate, type SqlSpan, type TranslationResult } from "./translator.ts";
