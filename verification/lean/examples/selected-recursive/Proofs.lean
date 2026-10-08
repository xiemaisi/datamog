import Datamog.Generated

namespace Datamog.Proofs

-- Induction on the actual finite derivation, including the bounded successor.
theorem growSafe : Generated.growSafe := by
  intro sample x derivation
  induction derivation <;> simp_all <;> omega

end Datamog.Proofs
