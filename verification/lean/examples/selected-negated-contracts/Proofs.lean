import Datamog.Generated

namespace Datamog.Proofs

theorem bothSafe : Generated.bothSafe := by
  intro seed
  have bounds : ∀ tag x, Generated.bothSafeFamily seed tag x → 0 ≤ x.val ∧ x.val ≤ 3 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  constructor
  · intro x h
    have hx := bounds 0 x h
    omega
  · intro x h
    have hx := bounds 1 x h
    omega

theorem singleSafe : Generated.singleSafe := by
  intro seed x derivation
  have bounds : ∀ x, Generated.Single seed x → 0 ≤ x.val ∧ x.val ≤ 3 := by
    intro x h
    induction h <;> simp_all <;> omega
  have hx := bounds x derivation
  omega

end Datamog.Proofs
