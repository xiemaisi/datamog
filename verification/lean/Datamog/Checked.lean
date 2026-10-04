-- Verification manifest SHA-256: 65690d5e4454713ce6fed30b86f5cf37dd0196dc9f734304e06295f0aa043560
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
theorem FirstAge_coverage : Generated.FirstAge_coverage := Proofs.FirstAge_coverage
#audit FirstAge_coverage
theorem FirstAge_soundness : Generated.FirstAge_soundness := Proofs.FirstAge_soundness
#audit FirstAge_soundness
theorem FirstRating_coverage : Generated.FirstRating_coverage := Proofs.FirstRating_coverage
#audit FirstRating_coverage
theorem FirstRating_soundness : Generated.FirstRating_soundness := Proofs.FirstRating_soundness
#audit FirstRating_soundness
theorem ProfileAge_soundness : Generated.ProfileAge_soundness := Proofs.ProfileAge_soundness
#audit ProfileAge_soundness
theorem ProfileRating_soundness : Generated.ProfileRating_soundness := Proofs.ProfileRating_soundness
#audit ProfileRating_soundness
theorem OptionalAge_soundness : Generated.OptionalAge_soundness := Proofs.OptionalAge_soundness
#audit OptionalAge_soundness
theorem OptionalRating_soundness : Generated.OptionalRating_soundness := Proofs.OptionalRating_soundness
#audit OptionalRating_soundness
theorem DynamicAge_coverage : Generated.DynamicAge_coverage := Proofs.DynamicAge_coverage
#audit DynamicAge_coverage
theorem DynamicAge_soundness : Generated.DynamicAge_soundness := Proofs.DynamicAge_soundness
#audit DynamicAge_soundness
theorem DynamicRating_coverage : Generated.DynamicRating_coverage := Proofs.DynamicRating_coverage
#audit DynamicRating_coverage
theorem DynamicRating_soundness : Generated.DynamicRating_soundness := Proofs.DynamicRating_soundness
#audit DynamicRating_soundness
theorem ReusedAge_coverage : Generated.ReusedAge_coverage := Proofs.ReusedAge_coverage
#audit ReusedAge_coverage
theorem ReusedAge_soundness : Generated.ReusedAge_soundness := Proofs.ReusedAge_soundness
#audit ReusedAge_soundness
theorem DynamicScore_soundness : Generated.DynamicScore_soundness := Proofs.DynamicScore_soundness
#audit DynamicScore_soundness
theorem Paired_coverage : Generated.Paired_coverage := Proofs.Paired_coverage
#audit Paired_coverage
theorem Paired_soundness : Generated.Paired_soundness := Proofs.Paired_soundness
#audit Paired_soundness
theorem OptionalPair_soundness : Generated.OptionalPair_soundness := Proofs.OptionalPair_soundness
#audit OptionalPair_soundness
theorem RepeatedPair_coverage : Generated.RepeatedPair_coverage := Proofs.RepeatedPair_coverage
#audit RepeatedPair_coverage
theorem RepeatedPair_soundness : Generated.RepeatedPair_soundness := Proofs.RepeatedPair_soundness
#audit RepeatedPair_soundness
theorem Identified_coverage : Generated.Identified_coverage := Proofs.Identified_coverage
#audit Identified_coverage
theorem Identified_soundness : Generated.Identified_soundness := Proofs.Identified_soundness
#audit Identified_soundness
theorem Indexed_coverage : Generated.Indexed_coverage := Proofs.Indexed_coverage
#audit Indexed_coverage
theorem Indexed_soundness : Generated.Indexed_soundness := Proofs.Indexed_soundness
#audit Indexed_soundness
theorem OptionalIdentified_soundness : Generated.OptionalIdentified_soundness := Proofs.OptionalIdentified_soundness
#audit OptionalIdentified_soundness
theorem Filtered_coverage : Generated.Filtered_coverage := Proofs.Filtered_coverage
#audit Filtered_coverage
theorem Filtered_soundness : Generated.Filtered_soundness := Proofs.Filtered_soundness
#audit Filtered_soundness
theorem Excluded_coverage : Generated.Excluded_coverage := Proofs.Excluded_coverage
#audit Excluded_coverage
theorem Excluded_soundness : Generated.Excluded_soundness := Proofs.Excluded_soundness
#audit Excluded_soundness
theorem Positive_coverage : Generated.Positive_coverage := Proofs.Positive_coverage
#audit Positive_coverage
theorem Positive_soundness : Generated.Positive_soundness := Proofs.Positive_soundness
#audit Positive_soundness
theorem Ranged_coverage : Generated.Ranged_coverage := Proofs.Ranged_coverage
#audit Ranged_coverage
theorem Ranged_soundness : Generated.Ranged_soundness := Proofs.Ranged_soundness
#audit Ranged_soundness
theorem BothPositive_coverage : Generated.BothPositive_coverage := Proofs.BothPositive_coverage
#audit BothPositive_coverage
theorem BothPositive_soundness : Generated.BothPositive_soundness := Proofs.BothPositive_soundness
#audit BothPositive_soundness
theorem Ordered_coverage : Generated.Ordered_coverage := Proofs.Ordered_coverage
#audit Ordered_coverage
theorem Ordered_soundness : Generated.Ordered_soundness := Proofs.Ordered_soundness
#audit Ordered_soundness
theorem orderedTotal_refuted : Generated.orderedTotal_refuted := Proofs.orderedTotal_refuted
#audit orderedTotal_refuted
theorem bothPositiveSecond_refuted : Generated.bothPositiveSecond_refuted := Proofs.bothPositiveSecond_refuted
#audit bothPositiveSecond_refuted
theorem rangedUpper_refuted : Generated.rangedUpper_refuted := Proofs.rangedUpper_refuted
#audit rangedUpper_refuted
theorem positiveTotal_refuted : Generated.positiveTotal_refuted := Proofs.positiveTotal_refuted
#audit positiveTotal_refuted
theorem excludedTotal_refuted : Generated.excludedTotal_refuted := Proofs.excludedTotal_refuted
#audit excludedTotal_refuted
theorem filteredTotal_refuted : Generated.filteredTotal_refuted := Proofs.filteredTotal_refuted
#audit filteredTotal_refuted
theorem identifiedSameRow : Generated.identifiedSameRow := Proofs.identifiedSameRow
#audit identifiedSameRow
theorem identifiedTotal_refuted : Generated.identifiedTotal_refuted := Proofs.identifiedTotal_refuted
#audit identifiedTotal_refuted
theorem pairedFirstBounds_refuted : Generated.pairedFirstBounds_refuted := Proofs.pairedFirstBounds_refuted
#audit pairedFirstBounds_refuted
theorem optionalPairTotal_refuted : Generated.optionalPairTotal_refuted := Proofs.optionalPairTotal_refuted
#audit optionalPairTotal_refuted
theorem pairedSameRow : Generated.pairedSameRow := Proofs.pairedSameRow
#audit pairedSameRow
theorem firstAgeTotal_refuted : Generated.firstAgeTotal_refuted := Proofs.firstAgeTotal_refuted
#audit firstAgeTotal_refuted
theorem MixedSchema_path0 : Generated.MixedSchema_path0 := Proofs.MixedSchema_path0
#audit MixedSchema_path0
theorem MixedSchema_path1 : Generated.MixedSchema_path1 := Proofs.MixedSchema_path1
#audit MixedSchema_path1
theorem MixedArraySchema_path0 : Generated.MixedArraySchema_path0 := Proofs.MixedArraySchema_path0
#audit MixedArraySchema_path0

theorem dynamicTotal_refuted : Generated.dynamicTotal_refuted := Proofs.dynamicTotal_refuted
#audit dynamicTotal_refuted
theorem structuralTypedLookup : Generated.structuralTypedLookup := Proofs.structuralTypedLookup
#audit structuralTypedLookup
theorem optionalProfileTotal_refuted : Generated.optionalProfileTotal_refuted := Proofs.optionalProfileTotal_refuted
#audit optionalProfileTotal_refuted
theorem nullableProfileTotal_refuted : Generated.nullableProfileTotal_refuted := Proofs.nullableProfileTotal_refuted
#audit nullableProfileTotal_refuted
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
