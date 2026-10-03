import Datamog.Generated

namespace Datamog.Proofs

theorem noViolation : Generated.noViolation := by
  intro seed h
  have safe : ∀ tag x, Generated.noViolationFamily seed tag x → x.val > 0 ∧ tag ≠ 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact (safe 0 _ h).2 rfl

theorem inputEmpty_refuted : ¬ Generated.inputEmpty := by
  intro empty
  let one : SafeInt := ⟨1, by decide⟩
  exact empty (fun _ => True)
    (Generated.inputEmptyFamily.rule0_0 one True.intro)

end Datamog.Proofs
