import Datamog.Generated

namespace Datamog.Proofs

theorem bothSafe : Generated.bothSafe := by
  intro seed edge
  have invariant : ∀ tag x y, Generated.bothSafeFamily seed edge tag x y →
      (tag = 0 → x.val > 0) ∧ (tag = 1 → x.val > 0 ∧ y.val > x.val) := by
    intro tag x y derivation
    induction derivation <;> simp_all <;> omega
  constructor
  · intro x h
    exact Or.inl ((invariant 0 x _ h).1 rfl)
  · intro x y h
    exact (invariant 1 x y h).2 rfl

-- The unused unary slot cannot contain an arbitrary extra output.
example (seed : SafeInt → Prop) (edge : SafeInt → SafeInt → Prop)
    (x padding : SafeInt) (h : Generated.bothSafeFamily seed edge 0 x padding) :
    padding.val = 0 := by
  cases h <;> rfl

end Datamog.Proofs
