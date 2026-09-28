-- Verification manifest SHA-256: e02126eed569c8bee3ccfcd4aaa514e45217fdfd12ef9232bd0345169a5dc356
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

end Datamog.Checked
