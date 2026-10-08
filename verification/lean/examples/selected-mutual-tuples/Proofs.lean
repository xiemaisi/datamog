import Datamog.Generated

namespace Datamog.Proofs

theorem bothSafe : Generated.bothSafe := by
  intro seed
  have invariant : ∀ tag x y, Generated.bothSafeFamily seed tag x y → y.val > x.val := by
    intro tag x y derivation
    induction derivation <;> simp_all <;> omega
  constructor
  · intro x y h
    exact Or.inl (invariant 0 x y h)
  · intro x y h
    exact invariant 1 x y h

end Datamog.Proofs
