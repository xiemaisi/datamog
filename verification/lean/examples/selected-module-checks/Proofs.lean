import Datamog.Generated

namespace Datamog.Proofs

theorem safe : Generated.safe := by
  intro seed x h
  have positive : ∀ tag x, Generated.safeFamily seed tag x → x.val > 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact positive 0 x h

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

theorem inputEmpty_refuted : ¬ Generated.inputEmpty := by
  intro empty
  let one : SafeInt := ⟨1, by decide⟩
  exact empty (fun _ => True)
    (Generated.inputEmptyFamily.rule0_0 one True.intro)

end Datamog.Proofs
