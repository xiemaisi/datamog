import Datamog.Generated

namespace Datamog.Proofs

theorem successor : Generated.successor := by
  unfold Generated.successor
  intros
  simp_all
  omega

theorem reachPreserves : Generated.reachPreserves := by
  intro edge P preserves a b h
  induction h with
  | rule0 b hab => exact preserves _ b hab
  | rule1 c b _ hbc ih => exact fun ha => preserves b c hbc (ih ha)

-- Concatenate finite derivations by induction on the second path.
-- This uses no additional law about the input relation.
theorem reachTransitive : Generated.reachTransitive := by
  intro edge a b c hab hbc
  induction hbc with
  | rule0 c hbc => exact Generated.Reach.rule1 a c b hab hbc
  | rule1 c d _ hdc ih => exact Generated.Reach.rule1 a c d ih hdc

-- The negative fixture really is false; it must never be accepted as a proof.
theorem falseGoal_refuted : ¬ Generated.falseGoal := by
  intro h
  have bad := h 0 (by decide)
  omega

end Datamog.Proofs
