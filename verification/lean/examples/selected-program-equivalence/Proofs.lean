import Datamog.Generated

namespace Datamog.Proofs

theorem sameRows : Generated.sameRows := by
  intro seed x
  have fromInput : ∀ tag x, Generated.sameRowsFamily seed tag x → seed x := by
    intro tag x h
    induction h <;> assumption
  constructor
  · intro h
    exact Generated.sameRowsFamily.rule1_0 x
      (Generated.sameRowsFamily.rule2_0 x (fromInput 0 x h))
  · intro h
    exact Generated.sameRowsFamily.rule0_0 x (fromInput 1 x h)

theorem filteredRows_refuted : ¬ Generated.filteredRows := by
  intro equivalent
  let zero : SafeInt := ⟨0, by decide⟩
  have first := Generated.filteredRowsFamily.rule0_0 (input0 := fun _ => True) zero True.intro
  have positive := (equivalent (fun _ => True) zero).mp first
  cases positive <;> simp_all [zero]

end Datamog.Proofs
