import Datamog.Generated

namespace Datamog.Proofs

theorem bothSafe : Generated.bothSafe := by
  intro seed
  have invariant : ∀ tag x, Generated.bothSafeFamily seed tag x →
      (tag = 0 → x.val > 0) ∧ (tag = 1 → x.val > 1) := by
    intro tag x derivation
    induction derivation <;> simp_all <;> omega
  constructor
  · intro x h
    exact Or.inl ((invariant 0 x h).1 rfl)
  · intro x h
    exact (invariant 1 x h).2 rfl

-- Computed outputs require an actual bounded witness, including at the edge.
example : ∃ y : SafeInt, y.val = (maxSafe - 1) + 1 := by
  refine ⟨⟨maxSafe, by decide⟩, ?_⟩
  change maxSafe = (maxSafe - 1) + 1
  omega

example : ¬ ∃ y : SafeInt, y.val = maxSafe + 1 := by
  rintro ⟨y, h⟩
  have bounds := y.property
  unfold InRange at bounds
  omega

end Datamog.Proofs
