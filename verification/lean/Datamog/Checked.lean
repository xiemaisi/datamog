-- Verification manifest SHA-256: 0de6c4e09b5e4f3c2b98edea24f53cbce36b62cf5c3ff8cb6014981044002885
-- Generated: maintained proofs must inhabit these exact types.
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
theorem reachUnique_refuted : ¬ Generated.reachUnique := Proofs.reachUnique_refuted
#audit reachUnique_refuted

theorem identityUnique : Generated.identityUnique := Proofs.identityUnique
#audit identityUnique

theorem successorCoverage : Generated.successorCoverage := Proofs.successorCoverage
#audit successorCoverage

theorem successorTotal_refuted : ¬ Generated.successorTotal := Proofs.successorTotal_refuted
#audit successorTotal_refuted

theorem guardedCoverage : Generated.guardedCoverage := Proofs.guardedCoverage
#audit guardedCoverage

theorem guardedTotal_refuted : ¬ Generated.guardedTotal := Proofs.guardedTotal_refuted
#audit guardedTotal_refuted

theorem saturatingCoverage : Generated.saturatingCoverage := Proofs.saturatingCoverage
#audit saturatingCoverage

theorem saturatingUnique : Generated.saturatingUnique := Proofs.saturatingUnique
#audit saturatingUnique

theorem overlappingUnique_refuted : ¬ Generated.overlappingUnique := Proofs.overlappingUnique_refuted
#audit overlappingUnique_refuted

theorem diagonalUnique : Generated.diagonalUnique := Proofs.diagonalUnique
#audit diagonalUnique

theorem diagonalTotal_refuted : ¬ Generated.diagonalTotal := Proofs.diagonalTotal_refuted
#audit diagonalTotal_refuted

theorem DocumentSchema_field0 : Generated.DocumentSchema_field0 := Proofs.DocumentSchema_field0
#audit DocumentSchema_field0
theorem DocumentSchema_field1 : Generated.DocumentSchema_field1 := Proofs.DocumentSchema_field1
#audit DocumentSchema_field1
theorem NestedSchema_path0 : Generated.NestedSchema_path0 := Proofs.NestedSchema_path0
#audit NestedSchema_path0
theorem NestedSchema_path1 : Generated.NestedSchema_path1 := Proofs.NestedSchema_path1
#audit NestedSchema_path1
theorem MixedSchema_path0 : Generated.MixedSchema_path0 := Proofs.MixedSchema_path0
#audit MixedSchema_path0
theorem MixedSchema_path1 : Generated.MixedSchema_path1 := Proofs.MixedSchema_path1
#audit MixedSchema_path1
theorem MixedArraySchema_path0 : Generated.MixedArraySchema_path0 := Proofs.MixedArraySchema_path0
#audit MixedArraySchema_path0

theorem structuralRequiredLookup : Generated.structuralRequiredLookup := Proofs.structuralRequiredLookup
#audit structuralRequiredLookup
theorem mixedEmptyTotal_refuted : Generated.mixedEmptyTotal_refuted := Proofs.mixedEmptyTotal_refuted
#audit mixedEmptyTotal_refuted
theorem mixedOptionalTotal_refuted : Generated.mixedOptionalTotal_refuted := Proofs.mixedOptionalTotal_refuted
#audit mixedOptionalTotal_refuted
theorem mixedNullTotal_refuted : Generated.mixedNullTotal_refuted := Proofs.mixedNullTotal_refuted
#audit mixedNullTotal_refuted
theorem NestedArray_lookup : Generated.NestedArray_lookup := Proofs.NestedArray_lookup
#audit NestedArray_lookup
theorem NullableNestedArray_lookup : Generated.NullableNestedArray_lookup := Proofs.NullableNestedArray_lookup
#audit NullableNestedArray_lookup
theorem DeepArray_lookup : Generated.DeepArray_lookup := Proofs.DeepArray_lookup
#audit DeepArray_lookup
theorem nestedArrayTypedLookup : Generated.nestedArrayTypedLookup := Proofs.nestedArrayTypedLookup
#audit nestedArrayTypedLookup
theorem nestedArrayTotal_refuted : Generated.nestedArrayTotal_refuted := Proofs.nestedArrayTotal_refuted
#audit nestedArrayTotal_refuted
theorem IntegerArray_lookup : Generated.IntegerArray_lookup := Proofs.IntegerArray_lookup
#audit IntegerArray_lookup
theorem NullableIntegerArray_lookup : Generated.NullableIntegerArray_lookup := Proofs.NullableIntegerArray_lookup
#audit NullableIntegerArray_lookup
theorem arrayElementValid : Generated.arrayElementValid := Proofs.arrayElementValid
#audit arrayElementValid
theorem arrayNegativeAbsent : Generated.arrayNegativeAbsent := Proofs.arrayNegativeAbsent
#audit arrayNegativeAbsent
theorem arrayPastEndAbsent : Generated.arrayPastEndAbsent := Proofs.arrayPastEndAbsent
#audit arrayPastEndAbsent
theorem arrayTotal_refuted : Generated.arrayTotal_refuted := Proofs.arrayTotal_refuted
#audit arrayTotal_refuted
theorem nestedRequiredPath : Generated.nestedRequiredPath := Proofs.nestedRequiredPath
#audit nestedRequiredPath
theorem optionalParentTotal_refuted : Generated.optionalParentTotal_refuted := Proofs.optionalParentTotal_refuted
#audit optionalParentTotal_refuted
theorem nullableParentTotal_refuted : Generated.nullableParentTotal_refuted := Proofs.nullableParentTotal_refuted
#audit nullableParentTotal_refuted
theorem schemaFieldMatches : Generated.schemaFieldMatches := Proofs.schemaFieldMatches
#audit schemaFieldMatches
theorem schemaClosed : Generated.schemaClosed := Proofs.schemaClosed
#audit schemaClosed
theorem emptySchemaExact : Generated.emptySchemaExact := Proofs.emptySchemaExact
#audit emptySchemaExact
theorem requiredFieldPresent : Generated.requiredFieldPresent := Proofs.requiredFieldPresent
#audit requiredFieldPresent
theorem nonnullableFieldInteger : Generated.nonnullableFieldInteger := Proofs.nonnullableFieldInteger
#audit nonnullableFieldInteger
theorem optionalFieldTotal_refuted : Generated.optionalFieldTotal_refuted := Proofs.optionalFieldTotal_refuted
#audit optionalFieldTotal_refuted
theorem recordAbsent : Generated.recordAbsent := Proofs.recordAbsent
#audit recordAbsent
theorem recordLastWrite : Generated.recordLastWrite := Proofs.recordLastWrite
#audit recordLastWrite
theorem recordNullDistinct : Generated.recordNullDistinct := Proofs.recordNullDistinct
#audit recordNullDistinct
end Datamog.Checked
