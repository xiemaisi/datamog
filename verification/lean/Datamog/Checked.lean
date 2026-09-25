-- Verification manifest SHA-256: 44495a2a37a215d28df0de7d1e644c384d428e13f717d213304a1faabcb712e9
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
end Datamog.Checked
