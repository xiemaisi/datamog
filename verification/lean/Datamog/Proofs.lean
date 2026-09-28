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

theorem identityUnique : Generated.identityUnique := by
  intro item x y z hxy hxz
  cases hxy
  cases hxz
  rfl

-- A branching input graph provides two different targets for one source.
theorem reachUnique_refuted : ¬ Generated.reachUnique := by
  intro unique
  let zero : SafeInt := ⟨0, by decide⟩
  let one : SafeInt := ⟨1, by decide⟩
  let two : SafeInt := ⟨2, by decide⟩
  let edge := fun (a b : SafeInt) => a = zero ∧ (b = one ∨ b = two)
  have h01 : Generated.Reach edge zero one :=
    Generated.Reach.rule0 zero one ⟨rfl, Or.inl rfl⟩
  have h02 : Generated.Reach edge zero two :=
    Generated.Reach.rule0 zero two ⟨rfl, Or.inr rfl⟩
  have bad := congrArg Subtype.val (unique edge zero one two h01 h02)
  change (1 : Int) = 2 at bad
  omega

theorem successorCoverage : Generated.successorCoverage := by
  intro sample x hx upper
  have bounds := x.property
  have hy : InRange (x.val + 1) := by
    unfold InRange maxSafe at *
    omega
  exact ⟨⟨x.val + 1, hy⟩, Generated.Successor.rule0 x ⟨x.val + 1, hy⟩ hx rfl⟩

theorem successorTotal_refuted : ¬ Generated.successorTotal := by
  intro total
  let top : SafeInt := ⟨maxSafe, by decide⟩
  obtain ⟨y, derivation⟩ := total (fun _ => True) top True.intro
  cases derivation with
  | rule0 _ value =>
    have bounds := y.property
    unfold InRange at bounds
    change y.val = maxSafe + 1 at value
    omega

end Datamog.Proofs
