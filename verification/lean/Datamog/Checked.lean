-- Verification manifest SHA-256: 869294e93e5fe8e94f47049221c2d6975c4bf7d79b6bfd34dc7d34667a445db4
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
