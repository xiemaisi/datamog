-- Verification manifest SHA-256: 79219677507c174f9b69061e1608b186509a09928285b704306d5f1fc9c1e9a1
-- Generated: maintained proofs must inhabit these exact types.
import Datamog.Proofs
import Datamog.Audit
namespace Datamog.Checked
theorem successor : Generated.successor := Proofs.successor
theorem reachPreserves : Generated.reachPreserves := Proofs.reachPreserves
#audit successor
#audit reachPreserves
theorem falseGoal_refuted : ¬ Generated.falseGoal := Proofs.falseGoal_refuted
#audit falseGoal_refuted
end Datamog.Checked
