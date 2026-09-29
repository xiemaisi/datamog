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

theorem guardedCoverage : Generated.guardedCoverage := by
  intro sample x hx upper
  have bounds := x.property
  have hy : InRange (x.val + 1) := by
    unfold InRange maxSafe at *
    omega
  exact ⟨⟨x.val + 1, hy⟩, Generated.Guarded.rule0 x ⟨x.val + 1, hy⟩ hx upper rfl⟩

-- This input has a defined successor, but the rule's guard excludes it.
theorem guardedTotal_refuted : ¬ Generated.guardedTotal := by
  intro total
  let excluded : SafeInt := ⟨9007199254740990, by decide⟩
  obtain ⟨y, derivation⟩ := total (fun _ => True) excluded True.intro
  cases derivation with
  | rule0 _ guard _ =>
    change (9007199254740990 : Int) < 9007199254740990 at guard
    omega

-- Sibling rules jointly cover the full bounded domain.
theorem saturatingCoverage : Generated.saturatingCoverage := by
  intro sample x hx
  by_cases upper : x.val < 9007199254740991
  · have bounds := x.property
    have hy : InRange (x.val + 1) := by
      unfold InRange maxSafe at *
      omega
    exact ⟨⟨x.val + 1, hy⟩, Generated.Saturating.rule0 x ⟨x.val + 1, hy⟩ hx upper rfl⟩
  · exact ⟨x, Generated.Saturating.rule1 x hx (by omega)⟩

theorem saturatingUnique : Generated.saturatingUnique := by
  intro sample x y z hxy hxz
  cases hxy <;> cases hxz <;> apply Subtype.ext <;> simp_all <;> omega

-- Moving the second guard down by one permits two distinct outputs.
theorem overlappingUnique_refuted : ¬ Generated.overlappingUnique := by
  intro unique
  let nearTop : SafeInt := ⟨9007199254740990, by decide⟩
  let top : SafeInt := ⟨9007199254740991, by decide⟩
  let sample := fun (_ : SafeInt) => True
  have increment : Generated.Overlapping sample nearTop top :=
    Generated.Overlapping.rule0 nearTop top True.intro (by decide) (by decide)
  have unchanged : Generated.Overlapping sample nearTop nearTop :=
    Generated.Overlapping.rule1 nearTop True.intro (by decide)
  have bad := congrArg Subtype.val (unique sample nearTop top nearTop increment unchanged)
  change (9007199254740991 : Int) = 9007199254740990 at bad
  omega

theorem diagonalUnique : Generated.diagonalUnique := by
  intro pair x y z hxy hxz
  cases hxy
  cases hxz
  apply Subtype.ext
  omega

theorem diagonalTotal_refuted : ¬ Generated.diagonalTotal := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let one : SafeInt := ⟨1, by decide⟩
  let pair := fun (a b : SafeInt) => a = zero ∧ b = one
  obtain ⟨y, derivation⟩ := total pair zero one ⟨rfl, rfl⟩
  cases derivation with
  | rule0 input equal =>
    have target := congrArg Subtype.val input.2
    change (0 : Int) = y.val at equal
    change y.val = 1 at target
    omega

theorem recordAbsent : Generated.recordAbsent := by
  intro fields key
  induction fields with
  | nil => simp [lookupField]
  | cons entry rest ih =>
    intro absent
    have head := absent entry (by simp)
    have tail := ih (by
      intro e member
      exact absent e (by simp [member]))
    simp [lookupField, tail, head]

theorem recordLastWrite : Generated.recordLastWrite := by
  intro fields key value
  induction fields with
  | nil => simp [lookupField]
  | cons entry rest ih => simp [lookupField, ih]

theorem recordNullDistinct : Generated.recordNullDistinct := by
  intro fields key absent
  rw [recordLastWrite fields key Value.null, absent]
  exact null_is_defined

theorem requiredFieldPresent : Generated.requiredFieldPresent := by
  intro fields key nullable accepted
  cases result : lookupField fields key with
  | none => simp [integerFieldMatches, result] at accepted
  | some value => exact ⟨value, rfl⟩

theorem nonnullableFieldInteger : Generated.nonnullableFieldInteger := by
  intro fields key accepted
  cases result : lookupField fields key with
  | none => simp [integerFieldMatches, result] at accepted
  | some value =>
    cases value with
    | null => simp [integerFieldMatches, result] at accepted
    | boolean b => simp [integerFieldMatches, result] at accepted
    | integer n => exact ⟨n, rfl⟩

theorem optionalFieldTotal_refuted : Generated.optionalFieldTotal_refuted := by
  intro total
  obtain ⟨value, impossible⟩ := total [] "x" (by rfl)
  simp [lookupField] at impossible

theorem DocumentSchema_field0 : Generated.DocumentSchema_field0 := by
  intro fields accepted
  have field : integerFieldMatches fields "required" false false = true := by
    simp [integerRecordMatches, Generated.DocumentSchema] at accepted
    exact accepted.1.1
  exact nonnullableFieldInteger fields _ field

theorem DocumentSchema_field1 : Generated.DocumentSchema_field1 := by
  intro fields accepted
  apply requiredFieldPresent fields _ true
  simp [integerRecordMatches, Generated.DocumentSchema] at accepted
  exact accepted.1.2.1

end Datamog.Proofs
