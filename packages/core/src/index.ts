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
  Conditional,
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
  EQUALITY_OPS,
  LOGICAL_BINARY_OPS,
  ORDERING_OPS,
  isFloatLiteral,
} from "./ast.ts";
export {
  analyze,
  AnalyzerError,
  type AnalyzedProgram,
  type BuiltinBodyAtomSpec,
  aggregateFunctions,
  allVarsBound,
  BUILTIN_BODY_ATOMS,
  chooseEqualityBinding,
  containsAggregate,
  equalityBindingCandidates,
  hasGroupingColumns,
  isGroupingArg,
  literalBindings,
  isAnonymousVar,
  isBuiltinBodyAtom,
  queryProjection,
} from "./analyzer.ts";
export { type ContractDiagnostic, findInertContracts } from "./contracts.ts";
export { type Obligation, generateObligations, obligationScript } from "./obligations.ts";
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
  collectTypeAliases,
  collectProofTypeNames,
  collectVariablesInRule,
  findEnclosingRule,
  type PredicateInfo,
} from "./completions.ts";
export { AGGREGATE_NAMES } from "./analyzer.ts";
export { findInertPolarity, type PolarityDiagnostic } from "./polarity.ts";
export {
  inferNullness,
  mayBeNull,
} from "./nullness.ts";
export { canBeUndefined, type PartialityContext } from "./partiality.ts";
export type {
  BodyOwner,
  NullnessContext,
  NullnessInfo,
} from "./nullness.ts";
export {
  findNullnessRisks,
  type NullnessDiagnostic,
  type NullnessDiagnosticOptions,
} from "./nullness-diagnostics.ts";
export { findNullableOperands, type NullableOperandError } from "./nullable-operands.ts";
export { findRecursiveCalls, type RecursiveCall } from "./recursion.ts";
export { findPredicateReferences, type PredicateReference } from "./references.ts";
export {
  findDefinition,
  findTypeAliasDefinitions,
  findModuleTarget,
  findPredicateDefinitions,
  type Definition,
  type ModuleSelector,
  type SourceSpan,
} from "./definitions.ts";
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
export {
  ANY_VALUE,
  NEVER,
  ProofTypeRegistry,
  SemanticTypeLimitError,
  type SemanticTypeWorkOptions,
  fromPrimitiveType,
  normalizeType,
  projectType,
  projectProofPayload,
  sameSemanticType,
  isSemanticSubtype,
  intersectTypes,
  scalarType,
  semanticStorageType,
  unionType,
  type ProjectionType,
  type ProofConstructorType,
  type ProofTypeId,
  type ScalarType,
  type SemanticField,
  type SemanticType,
} from "./semantic-type.ts";
export {
  DEFAULT_TYPE_BUDGET,
  boundSemanticType,
  widenSemanticType,
  type TypeBudget,
} from "./semantic-widening.ts";

export {
  type StructuralColumnValidator,
  compileStructuralColumnValidator,
  rejectNominalInput,
  declaredColumnType,
  validateStructuralColumn,
} from "./structural-declarations.ts";
