-- Verification manifest SHA-256: bdb022515b10c7020af6d3b99ce18ba5a47b37571a2d66a5ca90a31d40f1ded5
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
theorem identityUnique : Generated.identityUnique := Proofs.identityUnique
#audit identityUnique

theorem reachUnique_refuted : ¬ Generated.reachUnique := Proofs.reachUnique_refuted
#audit reachUnique_refuted

theorem successorCoverage : Generated.successorCoverage := Proofs.successorCoverage
#audit successorCoverage
theorem successorTotal_refuted : ¬ Generated.successorTotal := Proofs.successorTotal_refuted
#audit successorTotal_refuted
end Datamog.Checked
