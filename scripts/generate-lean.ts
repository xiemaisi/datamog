import { exportLeanArraySchema } from "../packages/core/src/array-schema-lean.ts";
import { analyze, generateLogicalObligations, inferTypes } from "../packages/core/src/index.ts";
import { exportLeanNestedArraySchema } from "../packages/core/src/nested-array-schema-lean.ts";
import { exportLeanNestedRecordSchema } from "../packages/core/src/nested-record-schema-lean.ts";
import {
  assembleLeanClaims,
  exportLeanCoverage,
  exportLeanObligation,
  exportLeanUniqueness,
} from "../packages/core/src/obligation-lean.ts";
import { exportLeanRecordSchema } from "../packages/core/src/record-schema-lean.ts";
import { exportLeanStructuralProjection } from "../packages/core/src/structural-projection-lean.ts";
import { exportLeanStructuralSchema } from "../packages/core/src/structural-schema-lean.ts";
import {
  assertCurrentVerificationManifest,
  createVerificationManifest,
  verificationDigest,
} from "../packages/core/src/verification-manifest.ts";
import { parse } from "../packages/parser/src/index.ts";

const root = new URL("../", import.meta.url);
const project = new URL("verification/lean/", root);
const compile = (source: string) => inferTypes(analyze(parse(source)));
const successor = generateLogicalObligations(
  compile(await Bun.file(new URL("doc/invariants/code/08-verify.dl", root)).text()),
);
if (successor.length !== 1 || successor[0]!.dependencies.length)
  throw new Error("Expected one independent successor goal");
const falseGoal = generateLogicalObligations(
  compile("input predicate sample(n: integer). bad(X, _: X > 0) :- sample(X)."),
)[0]!;
const reach = compile(await Bun.file(new URL("fixtures/reach.dl", project)).text());
const successorRelation = compile(await Bun.file(new URL("fixtures/successor.dl", project)).text());
const guarded = compile(await Bun.file(new URL("fixtures/guarded-successor.dl", project)).text());
const identity = compile(await Bun.file(new URL("fixtures/identity.dl", project)).text());
// Keep registered relation statements explicit, rather than extracting a range
// of generated text that could accidentally absorb a neighboring declaration.
const reachPreserves = `def reachPreserves : Prop :=
  ∀ (edge : SafeInt → SafeInt → Prop) (P : SafeInt → Prop),
  (∀ a b, edge a b → P a → P b) →
  ∀ a b, Reach edge a b → P a → P b
`;
const reachTransitive = `def reachTransitive : Prop :=
  ∀ (edge : SafeInt → SafeInt → Prop) (a b c : SafeInt),
  Reach edge a b → Reach edge b c → Reach edge a c
`;
const identityUnique = exportLeanUniqueness(identity, {
  id: "identityUnique",
  predicate: "identity",
  relationName: "Identity",
  keyColumns: [0],
  outputColumns: [1],
});
const reachUnique = exportLeanUniqueness(
  reach,
  {
    id: "reachUnique",
    predicate: "reach",
    relationName: "Reach",
    keyColumns: [0],
    outputColumns: [1],
  },
  "refute",
);
const coverageDescriptor = {
  id: "successorCoverage",
  predicate: "succ",
  relationName: "Successor",
  inputPredicate: "sample",
  outputToInput: [0, null],
  bounds: [{ column: 0, op: "<" as const, value: Number.MAX_SAFE_INTEGER }],
};
const successorCoverage = exportLeanCoverage(successorRelation, coverageDescriptor);
const successorTotal = exportLeanCoverage(
  successorRelation,
  { ...coverageDescriptor, id: "successorTotal", bounds: [] },
  "refute",
);
const guardedDescriptor = {
  ...coverageDescriptor,
  id: "guardedCoverage",
  predicate: "guarded",
  relationName: "Guarded",
  bounds: [{ column: 0, op: "<" as const, value: Number.MAX_SAFE_INTEGER - 1 }],
};
const guardedCoverage = exportLeanCoverage(guarded, guardedDescriptor);
const guardedTotal = exportLeanCoverage(
  guarded,
  { ...guardedDescriptor, id: "guardedTotal", bounds: [] },
  "refute",
);
const saturating = compile(
  await Bun.file(new URL("fixtures/saturating-successor.dl", project)).text(),
);
const overlapping = compile(
  await Bun.file(new URL("fixtures/overlapping-successor.dl", project)).text(),
);
const saturatingCoverage = exportLeanCoverage(saturating, {
  ...coverageDescriptor,
  id: "saturatingCoverage",
  predicate: "saturating",
  relationName: "Saturating",
  bounds: [],
});
const saturatingUnique = exportLeanUniqueness(saturating, {
  id: "saturatingUnique",
  predicate: "saturating",
  relationName: "Saturating",
  keyColumns: [0],
  outputColumns: [1],
});
const overlappingUnique = exportLeanUniqueness(
  overlapping,
  {
    id: "overlappingUnique",
    predicate: "overlapping",
    relationName: "Overlapping",
    keyColumns: [0],
    outputColumns: [1],
  },
  "refute",
);
const diagonal = compile(await Bun.file(new URL("fixtures/diagonal.dl", project)).text());
const diagonalUnique = exportLeanUniqueness(diagonal, {
  id: "diagonalUnique",
  predicate: "diagonal",
  relationName: "Diagonal",
  keyColumns: [0],
  outputColumns: [1],
});
const diagonalTotal = exportLeanCoverage(
  diagonal,
  {
    id: "diagonalTotal",
    predicate: "diagonal",
    relationName: "Diagonal",
    inputPredicate: "pair",
    outputToInput: [0, null],
    bounds: [],
  },
  "refute",
);
const claims = assembleLeanClaims([
  reachUnique,
  identityUnique,
  successorCoverage,
  successorTotal,
  guardedCoverage,
  guardedTotal,
  saturatingCoverage,
  saturatingUnique,
  overlappingUnique,
  diagonalUnique,
  diagonalTotal,
]);
const recordSchema = exportLeanRecordSchema(
  compile(await Bun.file(new URL("fixtures/record-schema.dl", project)).text()),
  { id: "DocumentSchema", predicate: "document", column: 0 },
);
const emptyRecordSchema = exportLeanRecordSchema(
  compile(await Bun.file(new URL("fixtures/empty-record-schema.dl", project)).text()),
  { id: "EmptySchema", predicate: "document", column: 0 },
);
const nestedSchema = exportLeanNestedRecordSchema(
  compile(await Bun.file(new URL("fixtures/nested-record-schema.dl", project)).text()),
  { id: "NestedSchema", predicate: "document", column: 0 },
);
const nestedGoals = [
  {
    id: "nestedRequiredPath",
    statement: `def nestedRequiredPath : Prop :=
  ∀ (schema : Nested.Schema) (path : List String) (nullable : Bool),
  Nested.RequiredPath schema path nullable → ∀ value,
  Nested.accepts schema value = true →
  ∃ result, Nested.lookupPath value path = some result ∧ Nested.leafMatches nullable result = true
`,
  },
  ...["optional", "nullable"].map((key) => ({
    id: `${key}ParentTotal_refuted`,
    statement: `def ${key}ParentTotal_refuted : Prop :=
  ¬ (∀ value, Nested.accepts NestedSchema value = true →
  ∃ result, Nested.lookupPath value ["${key}", "n"] = some result)
`,
  })),
];
const arraySchemas = await Promise.all(
  [
    ["IntegerArray", "integer-array.dl"],
    ["NullableIntegerArray", "nullable-integer-array.dl"],
  ].map(async ([id, fixture]) =>
    exportLeanArraySchema(compile(await Bun.file(new URL(`fixtures/${fixture}`, project)).text()), {
      id: id!,
      predicate: "items",
      column: 0,
    }),
  ),
);
const projectionProgram = compile(
  await Bun.file(new URL("fixtures/structural-projection.dl", project)).text(),
);
const structuralProjections = [
  { id: "FirstAge", predicate: "firstAge" },
  { id: "FirstRating", predicate: "firstRating" },
].map((descriptor) => exportLeanStructuralProjection(projectionProgram, descriptor));
const optionalProjectionProgram = compile(
  await Bun.file(new URL("fixtures/optional-projection.dl", project)).text(),
);
structuralProjections.push(
  ...[
    { id: "ProfileAge", predicate: "profileAge" },
    { id: "ProfileRating", predicate: "profileRating" },
    { id: "OptionalAge", predicate: "optionalAge" },
    { id: "OptionalRating", predicate: "optionalRating" },
  ].map((descriptor) =>
    exportLeanStructuralProjection(optionalProjectionProgram, {
      ...descriptor,
      coverage: false,
    }),
  ),
);
const dynamicProjectionProgram = compile(
  await Bun.file(new URL("fixtures/dynamic-projection.dl", project)).text(),
);
structuralProjections.push(
  ...[
    { id: "DynamicAge", predicate: "dynamicAge" },
    { id: "DynamicRating", predicate: "dynamicRating" },
    { id: "ReusedAge", predicate: "reusedAge" },
    { id: "DynamicScore", predicate: "dynamicScore", coverage: false },
  ].map((descriptor) => exportLeanStructuralProjection(dynamicProjectionProgram, descriptor)),
);
const tupleProjectionProgram = compile(
  await Bun.file(new URL("fixtures/tuple-projection.dl", project)).text(),
);
structuralProjections.push(
  ...[
    { id: "Paired", predicate: "paired" },
    { id: "OptionalPair", predicate: "optionalPair", coverage: false },
    { id: "RepeatedPair", predicate: "repeatedPair" },
  ].map((descriptor) => exportLeanStructuralProjection(tupleProjectionProgram, descriptor)),
);
const carriedProjectionProgram = compile(
  await Bun.file(new URL("fixtures/carried-projection.dl", project)).text(),
);
structuralProjections.push(
  ...[
    { id: "Identified", predicate: "identified" },
    { id: "Indexed", predicate: "indexed" },
    { id: "OptionalIdentified", predicate: "optionalIdentified", coverage: false },
  ].map((descriptor) => exportLeanStructuralProjection(carriedProjectionProgram, descriptor)),
);
const filteredProjectionProgram = compile(
  await Bun.file(new URL("fixtures/filtered-projection.dl", project)).text(),
);
structuralProjections.push(
  exportLeanStructuralProjection(filteredProjectionProgram, {
    id: "Filtered",
    predicate: "filtered",
  }),
);
const excludedProjectionProgram = compile(
  await Bun.file(new URL("fixtures/excluded-projection.dl", project)).text(),
);
structuralProjections.push(
  exportLeanStructuralProjection(excludedProjectionProgram, {
    id: "Excluded",
    predicate: "excluded",
  }),
);
const positiveProjectionProgram = compile(
  await Bun.file(new URL("fixtures/positive-projection.dl", project)).text(),
);
structuralProjections.push(
  exportLeanStructuralProjection(positiveProjectionProgram, {
    id: "Positive",
    predicate: "positive",
  }),
);
const rangedProjectionProgram = compile(
  await Bun.file(new URL("fixtures/ranged-projection.dl", project)).text(),
);
structuralProjections.push(
  exportLeanStructuralProjection(rangedProjectionProgram, { id: "Ranged", predicate: "ranged" }),
);
const bothPositiveProgram = compile(
  await Bun.file(new URL("fixtures/both-positive-projection.dl", project)).text(),
);
structuralProjections.push(
  exportLeanStructuralProjection(bothPositiveProgram, {
    id: "BothPositive",
    predicate: "bothPositive",
  }),
);
const orderedProjectionProgram = compile(
  await Bun.file(new URL("fixtures/ordered-projection.dl", project)).text(),
);
structuralProjections.push(
  exportLeanStructuralProjection(orderedProjectionProgram, { id: "Ordered", predicate: "ordered" }),
);
const projectionLaws = [
  {
    id: "orderedTotal_refuted",
    relation: "Ordered",
    statement: `def orderedTotal_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → Prop) value i j,
  input value i j → Structural.accepts OrderedSchema value = true →
  0 ≤ i.val → 0 ≤ j.val →
  Structural.ArrayBounds value [.field "left", .index i.val.toNat, .field "n"] →
  Structural.ArrayBounds value [.field "right", .index j.val.toNat, .field "n"] →
  ∃ first second, Ordered input first second)
`,
  },
  {
    id: "bothPositiveSecond_refuted",
    relation: "BothPositive",
    statement: `def bothPositiveSecond_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → Prop) value i j,
  input value i j → Structural.accepts BothPositiveSchema value = true →
  0 ≤ i.val → 0 ≤ j.val →
  Structural.ArrayBounds value [.field "left", .index i.val.toNat, .field "n"] →
  Structural.ArrayBounds value [.field "right", .index j.val.toNat, .field "n"] →
  (∀ (n : SafeInt), Structural.lookupPath value [.field "left", .index i.val.toNat, .field "n"] = some (.scalar (.integer n)) → n.val > 0) →
  ∃ first second, BothPositive input first second)
`,
  },
  {
    id: "rangedUpper_refuted",
    relation: "Ranged",
    statement: `def rangedUpper_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → SafeInt → Prop) value i j k,
  input value i j k → Structural.accepts RangedSchema value = true →
  0 ≤ i.val → Structural.ArrayBounds value [.field "rows", .index i.val.toNat, .field "n"] →
  (∀ (n : SafeInt), Structural.lookupPath value [.field "rows", .index i.val.toNat, .field "n"] = some (.scalar (.integer n)) → n.val > 0) →
  ∃ key result, Ranged input key result)
`,
  },
  {
    id: "positiveTotal_refuted",
    relation: "Positive",
    statement: `def positiveTotal_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → SafeInt → Prop) value i j k,
  input value i j k → Structural.accepts PositiveSchema value = true →
  0 ≤ i.val → Structural.ArrayBounds value [.field "rows", .index i.val.toNat, .field "n"] →
  ∃ key result, Positive input key result)
`,
  },
  {
    id: "excludedTotal_refuted",
    relation: "Excluded",
    statement: `def excludedTotal_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → SafeInt → Prop) value i j k,
  input value i j k → Structural.accepts ExcludedSchema value = true →
  0 ≤ i.val → Structural.ArrayBounds value [.field "rows", .index i.val.toNat, .field "n"] →
  ∃ key result, Excluded input key result)
`,
  },
  {
    id: "filteredTotal_refuted",
    relation: "Filtered",
    statement: `def filteredTotal_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → SafeInt → Prop) value i j k,
  input value i j k → Structural.accepts FilteredSchema value = true →
  0 ≤ i.val → Structural.ArrayBounds value [.field "rows", .index i.val.toNat, .field "n"] →
  ∃ key result, Filtered input key result)
`,
  },
  {
    id: "identifiedSameRow",
    relation: "Identified",
    statement: `def identifiedSameRow : Prop :=
  ∀ (input : Structural.Value → SafeInt → SafeInt → SafeInt → Prop) key result,
  Identified input key result →
  ∃ value i j k, input value i j k ∧ key = Structural.Value.scalar (.integer k) ∧
  Structural.lookupPath value [.field "rows", .index i.val.toNat, .field "n"] = some result
`,
  },
  {
    id: "identifiedTotal_refuted",
    relation: "Identified",
    statement: `def identifiedTotal_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → SafeInt → Prop) value i j k,
  input value i j k → Structural.accepts IdentifiedSchema value = true →
  0 ≤ i.val → ∃ key result, Identified input key result)
`,
  },

  {
    id: "pairedFirstBounds_refuted",
    relation: "Paired",
    statement: `def pairedFirstBounds_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → Prop) value i j,
  input value i j → Structural.accepts PairedSchema value = true →
  0 ≤ i.val → 0 ≤ j.val →
  Structural.ArrayBounds value [.field "left", .index i.val.toNat, .field "n"] →
  ∃ x y, Paired input x y)
`,
  },
  {
    id: "optionalPairTotal_refuted",
    relation: "OptionalPair",
    statement: `def optionalPairTotal_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → Prop) value i j,
  input value i j → Structural.accepts OptionalPairSchema value = true →
  0 ≤ i.val →
  Structural.ArrayBounds value [.field "left", .index i.val.toNat, .field "n"] →
  ∃ x y, OptionalPair input x y)
`,
  },
  {
    id: "pairedSameRow",
    relation: "Paired",
    statement: `def pairedSameRow : Prop :=
  ∀ (input : Structural.Value → SafeInt → SafeInt → Prop) x y, Paired input x y →
  ∃ value i j, input value i j ∧
  Structural.lookupPath value [.field "left", .index i.val.toNat, .field "n"] = some x ∧
  Structural.lookupPath value [.field "right", .index j.val.toNat, .field "rating"] = some y
`,
  },
];
const projectionRefutation = `def firstAgeTotal_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → Prop) value, input value →
  Structural.accepts FirstAgeSchema value = true → ∃ result, FirstAge input result)
`;
const structuralSchemas = await Promise.all(
  [
    ["MixedSchema", "mixed-schema.dl"],
    ["MixedArraySchema", "mixed-array-schema.dl"],
    ["MixedOptionalSchema", "mixed-optional-schema.dl"],
  ].map(async ([id, fixture]) =>
    exportLeanStructuralSchema(
      compile(await Bun.file(new URL(`fixtures/${fixture}`, project)).text()),
      { id: id!, predicate: "items", column: 0 },
    ),
  ),
);
const structuralGoals = [
  {
    id: "dynamicTotal_refuted",
    statement: `def dynamicTotal_refuted : Prop :=
  ¬ (∀ (input : Structural.Value → SafeInt → SafeInt → SafeInt → Prop) value i j u,
  input value i j u → Structural.accepts DynamicAgeSchema value = true →
  ∃ result, DynamicAge input result)
`,
  },

  {
    id: "structuralTypedLookup",
    statement: `def structuralTypedLookup : Prop :=
  ∀ schema path nullable, Structural.TypedPath schema path nullable →
  ∀ value result, Structural.accepts schema value = true →
  Structural.lookupPath value path = some result → Structural.leafMatches nullable result = true
`,
  },
  ...["optionalProfileTotal_refuted", "nullableProfileTotal_refuted"].map((id) => ({
    id,
    statement: `def ${id} : Prop :=
  ¬ (∀ (input : Structural.Value → Prop) value, input value →
  Structural.accepts ProfileAgeSchema value = true → ∃ result, ProfileAge input result)
`,
  })),

  {
    id: "structuralRequiredLookup",
    statement: `def structuralRequiredLookup : Prop :=
  ∀ schema path nullable, Structural.RequiredPath schema path nullable →
  ∀ value, Structural.accepts schema value = true → Structural.ArrayBounds value path →
  ∃ result, Structural.lookupPath value path = some result ∧ Structural.leafMatches nullable result = true
`,
  },
  ...[
    [
      "mixedEmptyTotal_refuted",
      '[.field "teams", .index 0, .field "members", .index 0, .field "age"]',
    ],
    ["mixedOptionalTotal_refuted", '[.field "optional", .field "age"]'],
    ["mixedNullTotal_refuted", '[.field "nullable", .field "age"]'],
  ].map(([id, path]) => ({
    id: id!,
    statement: `def ${id} : Prop :=
  ¬ (∀ value, Structural.accepts MixedSchema value = true →
  ∃ result, Structural.lookupPath value ${path} = some result)
`,
  })),
];
const nestedArraySchemas = await Promise.all(
  [
    ["NestedArray", "nested-array.dl"],
    ["NullableNestedArray", "nullable-nested-array.dl"],
    ["DeepArray", "deep-array.dl"],
  ].map(async ([id, fixture]) =>
    exportLeanNestedArraySchema(
      compile(await Bun.file(new URL(`fixtures/${fixture}`, project)).text()),
      { id: id!, predicate: "items", column: 0 },
    ),
  ),
);
const nestedArrayGoals = [
  {
    id: "nestedArrayTypedLookup",
    statement: `def nestedArrayTypedLookup : Prop :=
  ∀ flags nullable value path, NestedArrays.accepts flags nullable value = true →
  NestedArrays.Bounds value path → path.length = flags.length →
  ∃ result, NestedArrays.lookupPath value path = some result ∧
    NestedArrays.accepts [] (NestedArrays.leafNullable flags nullable) result = true
`,
  },
  {
    id: "nestedArrayTotal_refuted",
    statement: `def nestedArrayTotal_refuted : Prop :=
  ¬ (∀ value, NestedArrays.accepts NullableNestedArray false value = true →
  ∃ result, NestedArrays.lookupPath value [0, 0] = some result)
`,
  },
];
const arrayGoals = [
  {
    id: "arrayElementValid",
    statement: `def arrayElementValid : Prop :=
  ∀ (nullable : Bool) (values : List Value) (index : Nat) (bound : index < values.length),
  Arrays.accepts nullable values = true → Arrays.elementMatches nullable values[index] = true
`,
  },
  {
    id: "arrayNegativeAbsent",
    statement: `def arrayNegativeAbsent : Prop :=
  ∀ (values : List Value) (index : Int), index < 0 → Arrays.lookupIndex values index = none
`,
  },
  {
    id: "arrayPastEndAbsent",
    statement: `def arrayPastEndAbsent : Prop :=
  ∀ (values : List Value) (index : Nat), values.length ≤ index →
  Arrays.lookupIndex values (Int.ofNat index) = none
`,
  },
  {
    id: "arrayTotal_refuted",
    statement: `def arrayTotal_refuted : Prop :=
  ∀ nullable : Bool, ¬ (∀ values : List Value, Arrays.accepts nullable values = true →
  ∃ value, Arrays.lookupIndex values 0 = some value)
`,
  },
];
const recordGoals = [
  {
    id: "schemaFieldMatches",
    statement: `def schemaFieldMatches : Prop :=
  ∀ (schema : List IntegerField) (fields : FlatRecord) (field : IntegerField),
  field ∈ schema → integerRecordMatches schema fields = true →
  integerFieldMatches fields field.name field.optional field.nullable = true
`,
  },
  {
    id: "schemaClosed",
    statement: `def schemaClosed : Prop :=
  ∀ (schema : List IntegerField) (fields : FlatRecord),
  integerRecordMatches schema fields = true →
  ∀ entry ∈ fields, ∃ field ∈ schema, field.name = entry.1
`,
  },
  {
    id: "emptySchemaExact",
    statement: `def emptySchemaExact : Prop :=
  ∀ fields : FlatRecord, integerRecordMatches [] fields = true ↔ fields = []
`,
  },
  {
    id: "requiredFieldPresent",
    statement: `def requiredFieldPresent : Prop :=
  ∀ (fields : FlatRecord) (key : String) (nullable : Bool),
  integerFieldMatches fields key false nullable = true →
  ∃ value, lookupField fields key = some value
`,
  },
  {
    id: "nonnullableFieldInteger",
    statement: `def nonnullableFieldInteger : Prop :=
  ∀ (fields : FlatRecord) (key : String),
  integerFieldMatches fields key false false = true →
  ∃ n : SafeInt, lookupField fields key = some (Value.integer n)
`,
  },
  {
    id: "optionalFieldTotal_refuted",
    statement: `def optionalFieldTotal_refuted : Prop :=
  ¬ (∀ (fields : FlatRecord) (key : String),
  integerFieldMatches fields key true true = true →
  ∃ value, lookupField fields key = some value)
`,
  },

  {
    id: "recordAbsent",
    statement: `def recordAbsent : Prop :=
  ∀ (fields : FlatRecord) (key : String),
  (∀ entry ∈ fields, entry.1 ≠ key) → lookupField fields key = none
`,
  },
  {
    id: "recordLastWrite",
    statement: `def recordLastWrite : Prop :=
  ∀ (fields : FlatRecord) (key : String) (value : Value),
  lookupField (fields ++ [(key, value)]) key = some value
`,
  },
  {
    id: "recordNullDistinct",
    statement: `def recordNullDistinct : Prop :=
  ∀ (fields : FlatRecord) (key : String),
  lookupField fields key = none →
  lookupField (fields ++ [(key, Value.null)]) key ≠ lookupField fields key
`,
  },
];
const generated = `-- Generated by bun run generate:lean. Edit maintained proofs in Proofs.lean.
import Datamog.Semantics
import Datamog.Records
import Datamog.NestedRecords
import Datamog.Arrays
import Datamog.NestedArrays
import Datamog.Structural
namespace Datamog.Generated
${exportLeanObligation(successor[0]!, "successor")}
${exportLeanObligation(falseGoal, "falseGoal")}
${structuralProjections.map((p) => p.source).join("\n")}
${projectionRefutation}
${projectionLaws.map((goal) => goal.statement).join("\n")}
${structuralSchemas.map((schema) => schema.source + schema.goals.map((goal) => goal.statement).join("\n")).join("\n")}
${structuralGoals.map((goal) => goal.statement).join("\n")}
${nestedArraySchemas.map((schema) => schema.source + schema.statement).join("\n")}
${nestedArrayGoals.map((goal) => goal.statement).join("\n")}
${arraySchemas.map((schema) => schema.source + schema.statement).join("\n")}
${arrayGoals.map((goal) => goal.statement).join("\n")}
${nestedSchema.source}
${nestedSchema.goals.map((goal) => goal.statement).join("\n")}
${nestedGoals.map((goal) => goal.statement).join("\n")}
${recordSchema.source}
${emptyRecordSchema.source}
${recordSchema.goals.map((goal) => goal.statement).join("\n")}
${claims.relations}
${reachPreserves}
${reachTransitive}
${claims.statements}
${recordGoals.map((goal) => goal.statement).join("\n")}
end Datamog.Generated
`;
const checker = `-- Generated: maintained proofs must inhabit these exact types.
import Datamog.Proofs
import Datamog.Audit
namespace Datamog.Checked
theorem successor : Generated.successor := Proofs.successor
theorem reachPreserves : Generated.reachPreserves := Proofs.reachPreserves
#audit successor
#audit reachPreserves
theorem reachTransitive : Generated.reachTransitive := Proofs.reachTransitive
#audit reachTransitive
theorem falseGoal_refuted : ¬ Generated.falseGoal := Proofs.falseGoal_refuted
#audit falseGoal_refuted
${claims.checker}
${recordSchema.checker}
${nestedSchema.checker}
${structuralProjections.map((p) => p.checker).join("\n")}
${projectionLaws.map(({ id }) => `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}`).join("\n")}
theorem firstAgeTotal_refuted : Generated.firstAgeTotal_refuted := Proofs.firstAgeTotal_refuted
#audit firstAgeTotal_refuted
${structuralSchemas.map((schema) => schema.checker).join("\n")}
${structuralGoals.map(({ id }) => `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}`).join("\n")}
${nestedArraySchemas.map((schema) => schema.checker).join("\n")}
${nestedArrayGoals.map(({ id }) => `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}`).join("\n")}
${arraySchemas.map((schema) => schema.checker).join("\n")}
${arrayGoals.map(({ id }) => `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}`).join("\n")}
${nestedGoals.map(({ id }) => `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}`).join("\n")}
${recordGoals.map(({ id }) => `theorem ${id} : Generated.${id} := Proofs.${id}\n#audit ${id}`).join("\n")}
end Datamog.Checked
`;
// Hash the full frontend source inventories, not only the exporter entry point:
// an analysis/import change must invalidate a result even if generated text agrees.
const paths = new Set([
  "doc/invariants/code/08-verify.dl",
  "verification/lean/fixtures/reach.dl",
  "verification/lean/fixtures/identity.dl",
  "verification/lean/fixtures/successor.dl",
  "verification/lean/fixtures/guarded-successor.dl",
  "verification/lean/fixtures/saturating-successor.dl",
  "verification/lean/fixtures/overlapping-successor.dl",
  "verification/lean/fixtures/diagonal.dl",
  "verification/lean/fixtures/record-schema.dl",
  "verification/lean/fixtures/nested-record-schema.dl",
  "verification/lean/fixtures/structural-projection.dl",
  "verification/lean/fixtures/optional-projection.dl",
  "verification/lean/fixtures/dynamic-projection.dl",
  "verification/lean/fixtures/tuple-projection.dl",
  "verification/lean/fixtures/carried-projection.dl",
  "verification/lean/fixtures/filtered-projection.dl",
  "verification/lean/fixtures/excluded-projection.dl",
  "verification/lean/fixtures/positive-projection.dl",
  "verification/lean/fixtures/ranged-projection.dl",
  "verification/lean/fixtures/both-positive-projection.dl",
  "verification/lean/fixtures/ordered-projection.dl",
  "verification/lean/fixtures/mixed-schema.dl",
  "verification/lean/fixtures/mixed-array-schema.dl",
  "verification/lean/fixtures/mixed-optional-schema.dl",
  "verification/lean/fixtures/nested-array.dl",
  "verification/lean/fixtures/nullable-nested-array.dl",
  "verification/lean/fixtures/deep-array.dl",
  "verification/lean/fixtures/integer-array.dl",
  "verification/lean/fixtures/nullable-integer-array.dl",
  "verification/lean/fixtures/empty-record-schema.dl",
  "scripts/generate-lean.ts",
  "scripts/test-lean.ts",
  "bun.lock",
  "verification/lean/lean-toolchain",
  "verification/lean/lakefile.toml",
  "verification/lean/lake-manifest.json",
  "verification/lean/Datamog.lean",
]);
for (const directory of ["packages/core/src", "packages/parser/src", "verification/lean/Datamog"]) {
  for await (const path of new Bun.Glob("**/*").scan({
    cwd: new URL(`${directory}/`, root).pathname,
    onlyFiles: true,
  })) {
    if (directory.endsWith("Datamog") && ["Generated.lean", "Checked.lean"].includes(path))
      continue;
    if (/\.(ts|langium|lean)$/.test(path)) paths.add(`${directory}/${path}`);
  }
}
const artifacts: Record<string, string> = {};
for (const path of [...paths].sort())
  artifacts[path] = await verificationDigest(await Bun.file(new URL(path, root)).text());
const manifest = await createVerificationManifest(
  [
    {
      id: "successor",
      theorem: "Datamog.Checked.successor",
      kind: "goal",
      statement: successor[0]!,
      assumptions: [],
      dependencies: [],
    },
    ...claims.nodes,
    ...recordSchema.nodes,
    ...nestedSchema.nodes,
    ...structuralProjections.flatMap((p) => p.nodes),
    ...projectionLaws.map(({ id, relation, statement }) => ({
      id,
      kind: "goal" as const,
      theorem: `Datamog.Checked.${id}`,
      statement: { profile: "datamog-structural-integer-v1", lean: statement },
      assumptions: [],
      dependencies: [relation],
    })),
    {
      id: "firstAgeTotal_refuted",
      kind: "goal",
      theorem: "Datamog.Checked.firstAgeTotal_refuted",
      statement: { profile: "datamog-structural-integer-v1", lean: projectionRefutation },
      assumptions: [],
      dependencies: ["FirstAge"],
    },
    ...structuralSchemas.flatMap((schema) => schema.nodes),
    {
      id: "StructuralSemantics",
      kind: "definition",
      statement: await Bun.file(new URL("Datamog/Structural.lean", project)).text(),
      assumptions: [],
      dependencies: [],
    },
    ...structuralGoals.map(({ id, statement }) => ({
      id,
      kind: "goal" as const,
      theorem: `Datamog.Checked.${id}`,
      statement: { profile: "datamog-structural-integer-v1", lean: statement },
      assumptions: [],
      dependencies:
        id === "dynamicTotal_refuted"
          ? ["DynamicAge"]
          : id.startsWith("structural")
            ? ["StructuralSemantics"]
            : id.endsWith("ProfileTotal_refuted")
              ? ["ProfileAge"]
              : ["MixedSchema"],
    })),
    ...nestedArraySchemas.flatMap((schema) => schema.nodes),
    {
      id: "NestedArraySemantics",
      kind: "definition",
      statement: await Bun.file(new URL("Datamog/NestedArrays.lean", project)).text(),
      assumptions: [],
      dependencies: [],
    },
    ...nestedArrayGoals.map(({ id, statement }) => ({
      id,
      kind: "goal" as const,
      theorem: `Datamog.Checked.${id}`,
      statement: { profile: "datamog-nested-array-v1", lean: statement },
      assumptions: [],
      dependencies: ["NestedArraySemantics", "NullableNestedArray"],
    })),
    ...arraySchemas.flatMap((schema) => schema.nodes),
    {
      id: "ArraySemantics",
      kind: "definition",
      statement: await Bun.file(new URL("Datamog/Arrays.lean", project)).text(),
      assumptions: [],
      dependencies: [],
    },
    ...arrayGoals.map(({ id, statement }) => ({
      id,
      kind: "goal" as const,
      theorem: `Datamog.Checked.${id}`,
      statement: { profile: "datamog-integer-array-v1", lean: statement },
      assumptions: [],
      dependencies: ["ArraySemantics"],
    })),
    {
      id: "NestedRecords",
      kind: "definition",
      statement: await Bun.file(new URL("Datamog/NestedRecords.lean", project)).text(),
      assumptions: [],
      dependencies: [],
    },
    ...nestedGoals.map(({ id, statement }) => ({
      id,
      kind: "goal" as const,
      theorem: `Datamog.Checked.${id}`,
      statement: { profile: "datamog-nested-record-v1", lean: statement },
      assumptions: [],
      dependencies: id === "nestedRequiredPath" ? ["NestedRecords"] : ["NestedSchema"],
    })),
    ...emptyRecordSchema.nodes,
    {
      id: "RecordLookup",
      kind: "definition",
      statement: await Bun.file(new URL("Datamog/Records.lean", project)).text(),
      assumptions: [],
      dependencies: [],
    },
    ...recordGoals.map(({ id, statement }) => ({
      id,
      kind: "goal" as const,
      theorem: `Datamog.Checked.${id}`,
      statement: { profile: "datamog-flat-record-v1", lean: statement },
      assumptions: [],
      dependencies:
        id === "recordNullDistinct" ? ["RecordLookup", "recordLastWrite"] : ["RecordLookup"],
    })),

    {
      id: "reachPreserves",
      theorem: "Datamog.Checked.reachPreserves",
      kind: "goal",
      statement: reachPreserves,
      assumptions: ["Every input edge preserves P"],
      dependencies: ["Reach"],
    },
    {
      id: "reachTransitive",
      theorem: "Datamog.Checked.reachTransitive",
      kind: "goal",
      statement: reachTransitive,
      assumptions: [],
      dependencies: ["Reach"],
    },
    {
      id: "falseGoal",
      kind: "definition",
      statement: falseGoal,
      assumptions: [],
      dependencies: [],
    },
    {
      id: "falseGoal_refuted",
      theorem: "Datamog.Checked.falseGoal_refuted",
      kind: "goal",
      statement: "¬ Datamog.Generated.falseGoal",
      assumptions: [],
      dependencies: ["falseGoal"],
    },
  ],
  {
    profile:
      "datamog-integer-v1+flat-record-v1+nested-record-v1+integer-array-v1+nested-array-v1+structural-integer-v1",
    toolchain: (await Bun.file(new URL("lean-toolchain", project)).text()).trim(),
    method: "lean-kernel-checked",
    artifacts,
  },
);
for (const [path, contents] of [
  ["Datamog/Generated.lean", generated],
  ["Datamog/Checked.lean", `-- Verification manifest SHA-256: ${manifest.digest}\n${checker}`],
  ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
]) {
  const target = new URL(path!, project);
  if (process.argv.includes("--check")) {
    if (path === "manifest.json") {
      assertCurrentVerificationManifest(manifest, await Bun.file(target).json());
    }
    if ((await Bun.file(target).text()) !== contents) throw new Error(`Stale Lean output: ${path}`);
  } else await Bun.write(target, contents!);
}
