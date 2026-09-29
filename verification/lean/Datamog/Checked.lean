-- Verification manifest SHA-256: 65fd7facfe3bd8df8dc8417364d07ad99c646b3e8c0e8227435dc3ed104c3c92
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
