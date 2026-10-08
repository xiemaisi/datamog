import Datamog.Generated

namespace Datamog.Proofs

theorem flagsSafe : Generated.flagsSafe := by
  intro seed
  constructor
  · intro _
    exact Or.inl rfl
  · intro x h
    cases h
    assumption

-- A cycle without a base rule has no finite derivation.
theorem emptySafe : Generated.emptySafe := by
  have empty : ∀ tag, Generated.emptySafeFamily tag → False := by
    intro tag h
    induction h <;> assumption
  constructor <;> intro h <;> exact False.elim (empty _ h)

end Datamog.Proofs
