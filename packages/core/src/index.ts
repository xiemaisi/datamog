export type {
  Actual,
  AggregateCall,
  AggregateFunction,
  ArrayLiteral,
  BinaryExpr,
  BinaryOp,
  Binding,
  BitwiseOp,
  BodyElement,
  ColumnDecl,
  ComparisonOp,
  Equality,
  Expression,
  ExtDecl,
  Filter,
  FunctionCall,
  HeadAtom,
  HeadTerm,
  Literal,
  NullLiteral,
  NumberLiteral,
  ObjectEntry,
  ObjectLiteral,
  Program,
  Query,
  RangeAtom,
  Rule,
  Slice,
  PrimitiveType,
  Statement,
  StringLiteral,
  Subscript,
  Term,
  UnaryExpr,
  Variable,
} from "./ast.ts";
export {
  BITWISE_OPS,
  COMPARISON_OPS,
  COMPUTATIONAL_EQ_OPS,
  LOGICAL_BINARY_OPS,
  LOGICAL_EQ_OPS,
  isFloatLiteral,
} from "./ast.ts";
export {
  analyze,
  AnalyzerError,
  type AnalyzedProgram,
  type BuiltinBodyAtomSpec,
  BUILTIN_BODY_ATOMS,
  isAnonymousVar,
  isBuiltinBodyAtom,
  queryProjection,
} from "./analyzer.ts";
export {
  type Builtin,
  BUILTINS,
  BUILTIN_KEYS,
  type Overload,
  type Resolution,
  type ResolutionError,
  resolveCall,
} from "./builtins.ts";
export {
  columnTypesCompatible,
  inferTermType,
  inferTypes,
  meetTypes,
  rebuildVarTypes,
  type TypedProgram,
} from "./types.ts";
export {
  findInfiniteRisks,
  type FinitenessCycle,
  type FinitenessCycleEdge,
  type FinitenessCycleNode,
  type FinitenessDiagnostic,
} from "./finiteness.ts";
export type {
  NegationCycle,
  NegationCycleEdge,
  NegationCycleNode,
} from "./negation-cycle.ts";
export { BUILTIN_TYPE_NAMES, RESERVED_KEYWORDS } from "./keywords.ts";
export {
  AGGREGATE_FUNCTION_NAMES,
  BUILTIN_BODY_ATOM_NAMES,
  BUILTIN_FUNCTION_NAMES,
  collectUserPredicates,
  collectVariablesInRule,
  findEnclosingRule,
  type PredicateInfo,
} from "./completions.ts";
export { AGGREGATE_NAMES } from "./analyzer.ts";
export { findRecursiveCalls, type RecursiveCall } from "./recursion.ts";
export { findPredicateReferences, type PredicateReference } from "./references.ts";
export { expandModule, type ExpandOptions } from "./expand.ts";
export {
  elaborate,
  checkModuleBoundaries,
  type BoundaryConstraint,
  type DataSource,
  type ElaborationResult,
  type ModuleResolver,
  type ResolvedModule,
} from "./elaborate.ts";
export { assertNever } from "./util.ts";
