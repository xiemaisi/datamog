import Datamog.Generated

namespace Datamog.Proofs

theorem safe : Generated.safe := by
  intro seed x h
  have positive : ∀ tag x, Generated.safeFamily seed tag x → x.val > 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact positive 0 x h

theorem covered : Generated.covered := by
  intro seed x hx lower
  exact Generated.coveredFamily.rule0_0 x
    (Generated.coveredFamily.rule1_0 x hx lower)

theorem noViolation : Generated.noViolation := by
  intro seed h
  have sound : ∀ tag x, Generated.noViolationFamily seed tag x → x.val > 0 ∧ tag ≠ 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact (sound 0 _ h).2 rfl

theorem noBad : Generated.noBad := by
  intro seed x h
  have sound : ∀ tag x, Generated.noBadFamily seed tag x → x.val > 0 ∧ tag ≠ 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact (sound 0 x h).2 rfl

end Datamog.Proofs
