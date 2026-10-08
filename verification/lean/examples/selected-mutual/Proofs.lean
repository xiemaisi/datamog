import Datamog.Generated

namespace Datamog.Proofs

theorem bothSafe : Generated.bothSafe := by
  intro seed
  have invariant : ∀ tag x, Generated.bothSafeFamily seed tag x → x.val > 0 := by
    intro tag x derivation
    induction derivation <;> simp_all
  constructor
  · intro x h
    exact Or.inl (invariant 0 x h)
  · intro x h
    exact invariant 1 x h

end Datamog.Proofs
