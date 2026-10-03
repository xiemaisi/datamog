import Datamog.Generated

namespace Datamog.Proofs

theorem noViolation : Generated.noViolation := by
  intro seed x h
  have safe : ∀ tag x, Generated.noViolationFamily seed tag x → x.val > 0 ∧ tag ≠ 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact (safe 0 x h).2 rfl

theorem positiveEmpty_refuted : ¬ Generated.positiveEmpty := by
  intro empty
  let one : SafeInt := ⟨1, by decide⟩
  exact empty (fun _ => True) one
    (Generated.positiveEmptyFamily.rule0_0 one True.intro (by decide))

theorem emptyCycle : Generated.emptyCycle := by
  have impossible : ∀ tag, Generated.emptyCycleFamily tag → False := by
    intro tag h
    induction h <;> assumption
  exact impossible 0

end Datamog.Proofs
