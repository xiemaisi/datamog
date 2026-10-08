import Datamog.Generated

namespace Datamog.Proofs

theorem pipelineSafe : Generated.pipelineSafe := by
  intro seed x derivation
  have positive : ∀ tag x, Generated.pipelineSafeFamily seed tag x → x.val > 0 := by
    intro tag x h
    induction h <;> simp_all <;> omega
  exact positive 0 x derivation

end Datamog.Proofs
