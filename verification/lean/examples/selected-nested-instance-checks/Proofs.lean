import Datamog.Generated

namespace Datamog.Proofs

theorem safeCheck : Generated.safeCheck := by
  intro seed h
  have sound : ∀ tag x, Generated.safeCheckFamily seed tag x → x.val > 0 ∧ tag ≠ 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact (sound 0 _ h).2 rfl

theorem sharedError : Generated.sharedError := by
  intro seed x h
  have sound : ∀ tag x, Generated.sharedErrorFamily seed tag x → x.val > 0 ∧ tag ≠ 0 := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  exact (sound 0 x h).2 rfl

theorem unsafeCheck_refuted : ¬ Generated.unsafeCheck := by
  intro empty
  let zero : SafeInt := ⟨0, by decide⟩
  exact empty (fun _ => True)
    (Generated.unsafeCheckFamily.rule0_0 zero True.intro (by decide))

theorem unsafeError_refuted : ¬ Generated.unsafeError := by
  intro empty
  let zero : SafeInt := ⟨0, by decide⟩
  exact empty (fun _ => True) zero
    (Generated.unsafeErrorFamily.rule0_0 zero True.intro (by decide))

end Datamog.Proofs
