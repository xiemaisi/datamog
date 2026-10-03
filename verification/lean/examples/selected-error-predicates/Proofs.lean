import Datamog.Generated

namespace Datamog.Proofs

theorem noBad : Generated.noBad := by
  intro seed x h
  have safe : ∀ tag x, Generated.noBadFamily seed tag x → x.val > 0 ∧ tag ≠ 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact (safe 0 x h).2 rfl

theorem nonemptyEmpty_refuted : ¬ Generated.nonemptyEmpty := by
  intro empty
  let one : SafeInt := ⟨1, by decide⟩
  exact empty (fun _ => True) one
    (Generated.nonemptyEmptyFamily.rule0_0 one True.intro)

theorem inputEmpty_refuted : ¬ Generated.inputEmpty := by
  intro empty
  let one : SafeInt := ⟨1, by decide⟩
  exact empty (fun _ => True)
    (Generated.inputEmptyFamily.rule0_0 one True.intro)

end Datamog.Proofs
