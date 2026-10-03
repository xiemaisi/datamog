import Datamog.Generated

namespace Datamog.Proofs

theorem pipelineUnique : Generated.pipelineUnique := by
  intro seed x y z hxy hxz
  have diagonal : ∀ tag a b, Generated.pipelineUniqueFamily seed tag a b → a = b := by
    intro tag a b h
    induction h <;> simp_all
  exact (diagonal 0 x y hxy).symm.trans (diagonal 0 x z hxz)

end Datamog.Proofs
