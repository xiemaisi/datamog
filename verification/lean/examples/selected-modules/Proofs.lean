import Datamog.Generated

namespace Datamog.Proofs

theorem safe : Generated.safe := by
  intro seed x h
  have positive : ∀ tag x, Generated.safeFamily seed tag x → x.val > 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact positive 0 x h

end Datamog.Proofs
