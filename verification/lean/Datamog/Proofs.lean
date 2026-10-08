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

theorem schemaFieldMatches : Generated.schemaFieldMatches := by
  intro schema fields field member accepted
  simp only [integerRecordMatches, Bool.and_eq_true, List.all_eq_true] at accepted
  exact accepted.1 field member

theorem schemaClosed : Generated.schemaClosed := by
  intro schema fields accepted entry member
  simp only [integerRecordMatches, Bool.and_eq_true, List.all_eq_true] at accepted
  have declared := accepted.2 entry member
  simpa only [List.any_eq_true, beq_iff_eq] using declared

theorem emptySchemaExact : Generated.emptySchemaExact := by
  intro fields
  cases fields with
  | nil => decide
  | cons entry rest => simp [integerRecordMatches]

theorem DocumentSchema_field0 : Generated.DocumentSchema_field0 := by
  intro fields accepted
  exact nonnullableFieldInteger fields "required"
    (schemaFieldMatches Generated.DocumentSchema fields ⟨"required", false, false⟩
      (by simp [Generated.DocumentSchema]) accepted)

theorem DocumentSchema_field1 : Generated.DocumentSchema_field1 := by
  intro fields accepted
  exact requiredFieldPresent fields "nullable" true
    (schemaFieldMatches Generated.DocumentSchema fields ⟨"nullable", false, true⟩
      (by simp [Generated.DocumentSchema]) accepted)

theorem nestedRequiredPath : Generated.nestedRequiredPath := by
  intro schema path nullable required value accepted
  exact Nested.requiredPathLookup required value accepted

theorem NestedSchema_path0 : Generated.NestedSchema_path0 := by
  intro value accepted
  apply Nested.requiredIntegerLookup (schema := Generated.NestedSchema) _ value accepted
  apply Nested.RequiredPath.step (by simp [Generated.NestedSchema]; rfl)
  apply Nested.RequiredPath.step (by simp; rfl)
  exact Nested.RequiredPath.leaf (by simp)

theorem NestedSchema_path1 : Generated.NestedSchema_path1 := by
  intro value accepted
  have required : Nested.RequiredPath Generated.NestedSchema ["required", "inner", "nullable"] true := by
    apply Nested.RequiredPath.step (by simp [Generated.NestedSchema]; rfl)
    apply Nested.RequiredPath.step (by simp; rfl)
    exact Nested.RequiredPath.leaf (by simp)
  obtain ⟨result, found, _⟩ := Nested.requiredPathLookup required value accepted
  exact ⟨result, found⟩

private def nestedCounterexample : Nested.Value := .record [
  ("required", .record [("inner", .record [("n", .scalar (.integer ⟨0, by decide⟩)),
    ("nullable", .scalar .null)])]), ("nullable", .scalar .null)]

theorem optionalParentTotal_refuted : Generated.optionalParentTotal_refuted := by
  intro total
  obtain ⟨result, impossible⟩ := total nestedCounterexample (by
    simp [Generated.NestedSchema, nestedCounterexample, Nested.accepts, Nested.lookup])
  simp [nestedCounterexample, Nested.lookupPath, Nested.lookup] at impossible

theorem nullableParentTotal_refuted : Generated.nullableParentTotal_refuted := by
  intro total
  obtain ⟨result, impossible⟩ := total nestedCounterexample (by
    simp [Generated.NestedSchema, nestedCounterexample, Nested.accepts, Nested.lookup])
  simp [nestedCounterexample, Nested.lookupPath, Nested.lookup] at impossible

theorem IntegerArray_lookup : Generated.IntegerArray_lookup := by
  intro values index accepted bound
  exact Arrays.integerLookup values index accepted bound

theorem NullableIntegerArray_lookup : Generated.NullableIntegerArray_lookup := by
  intro values index _ bound
  exact Arrays.inBounds values index bound

theorem arrayElementValid : Generated.arrayElementValid := by
  intro nullable values index bound accepted
  exact Arrays.elementValid nullable values index accepted bound

theorem arrayNegativeAbsent : Generated.arrayNegativeAbsent := by
  intro values index negative
  simp [Arrays.lookupIndex, show ¬ 0 ≤ index by omega]

theorem arrayPastEndAbsent : Generated.arrayPastEndAbsent := by
  intro values index bound
  simp [Arrays.lookupIndex, List.getElem?_eq_none, bound]

theorem arrayTotal_refuted : Generated.arrayTotal_refuted := by
  intro nullable total
  obtain ⟨value, impossible⟩ := total [] (by simp [Arrays.accepts])
  simp [Arrays.lookupIndex] at impossible

theorem nestedArrayTypedLookup : Generated.nestedArrayTypedLookup := NestedArrays.typedLookup

theorem NestedArray_lookup : Generated.NestedArray_lookup := by
  intro value path accepted bounds depth
  exact NestedArrays.typedLookup Generated.NestedArray false value path accepted bounds depth

theorem NullableNestedArray_lookup : Generated.NullableNestedArray_lookup := by
  intro value path accepted bounds depth
  exact NestedArrays.typedLookup Generated.NullableNestedArray false value path accepted bounds depth

theorem DeepArray_lookup : Generated.DeepArray_lookup := by
  intro value path accepted bounds depth
  exact NestedArrays.typedLookup Generated.DeepArray false value path accepted bounds depth

theorem nestedArrayTotal_refuted : Generated.nestedArrayTotal_refuted := by
  intro total
  obtain ⟨result, impossible⟩ := total (.array [.scalar .null]) (by decide)
  simp [NestedArrays.lookupPath, NestedArrays.lookupIndex] at impossible

theorem structuralRequiredLookup : Generated.structuralRequiredLookup := by
  intro schema path nullable required value accepted bounds
  exact Structural.requiredLookup required value accepted bounds

theorem MixedSchema_path0 : Generated.MixedSchema_path0 := by
  intro value i0 i1 accepted bounds
  apply Structural.requiredLookup (value := value) _ accepted bounds
  · apply Structural.RequiredPath.fieldStep (by simp [Generated.MixedSchema]; rfl)
    apply Structural.RequiredPath.indexStep
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)

theorem MixedSchema_path1 : Generated.MixedSchema_path1 := by
  intro value i0 i1 accepted bounds
  apply Structural.requiredLookup (value := value) _ accepted bounds
  · apply Structural.RequiredPath.fieldStep (by simp [Generated.MixedSchema]; rfl)
    apply Structural.RequiredPath.indexStep
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)

theorem MixedArraySchema_path0 : Generated.MixedArraySchema_path0 := by
  intro value i0 i1 i2 accepted bounds
  apply Structural.requiredLookup (value := value) _ accepted bounds
  · apply Structural.RequiredPath.indexStep
    apply Structural.RequiredPath.fieldStep (by simp [Generated.MixedArraySchema]; rfl)
    apply Structural.RequiredPath.indexStep
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)

theorem mixedEmptyTotal_refuted : Generated.mixedEmptyTotal_refuted := by
  intro total
  obtain ⟨result, impossible⟩ := total (.record [("teams", .array []), ("nullable", .scalar .null)])
    (by simp [Structural.accepts, Structural.lookup, Generated.MixedSchema])
  simp [Structural.lookupPath, Structural.step, Structural.lookup] at impossible

theorem mixedOptionalTotal_refuted : Generated.mixedOptionalTotal_refuted := by
  intro total
  obtain ⟨result, impossible⟩ := total (.record [("teams", .array []), ("nullable", .scalar .null)])
    (by simp [Structural.accepts, Structural.lookup, Generated.MixedSchema])
  simp [Structural.lookupPath, Structural.step, Structural.lookup] at impossible

theorem mixedNullTotal_refuted : Generated.mixedNullTotal_refuted := by
  intro total
  obtain ⟨result, impossible⟩ := total (.record [("teams", .array []), ("nullable", .scalar .null)])
    (by simp [Structural.accepts, Structural.lookup, Generated.MixedSchema])
  simp [Structural.lookupPath, Structural.step, Structural.lookup] at impossible

theorem FirstAge_coverage : Generated.FirstAge_coverage := by
  intro input value member accepted bounds
  have required : Structural.RequiredPath Generated.FirstAgeSchema
      [.field "teams", .index 0, .field "members", .index 0, .field "age"] false := by
    apply Structural.RequiredPath.fieldStep (by simp [Generated.FirstAgeSchema]; rfl)
    apply Structural.RequiredPath.indexStep
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨result, Generated.FirstAge.rule member found, valid⟩

theorem FirstRating_coverage : Generated.FirstRating_coverage := by
  intro input value member accepted bounds
  have required : Structural.RequiredPath Generated.FirstRatingSchema
      [.field "teams", .index 0, .field "members", .index 0, .field "rating"] true := by
    apply Structural.RequiredPath.fieldStep (by simp [Generated.FirstRatingSchema]; rfl)
    apply Structural.RequiredPath.indexStep
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨result, Generated.FirstRating.rule member found, valid⟩

theorem firstAgeTotal_refuted : Generated.firstAgeTotal_refuted := by
  intro total
  let empty : Structural.Value := .record [("teams", .array [])]
  obtain ⟨result, derived⟩ := total (fun value => value = empty) empty rfl
    (by simp [empty, Structural.accepts, Structural.lookup, Generated.FirstAgeSchema])
  cases derived with
  | rule member found =>
    subst member
    simp [empty, Structural.lookupPath, Structural.step, Structural.lookup] at found

theorem structuralTypedLookup : Generated.structuralTypedLookup := by
  intro schema path nullable typed value result accepted found
  exact Structural.typedLookup typed value result accepted found

theorem FirstAge_soundness : Generated.FirstAge_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member found =>
    apply Structural.typedLookup _ _ result (admitted _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp [Generated.FirstAgeSchema]; rfl)
    apply Structural.TypedPath.indexStep
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem FirstRating_soundness : Generated.FirstRating_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member found =>
    apply Structural.typedLookup _ _ result (admitted _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp [Generated.FirstRatingSchema]; rfl)
    apply Structural.TypedPath.indexStep
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem ProfileAge_soundness : Generated.ProfileAge_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member found =>
    apply Structural.typedLookup _ _ result (admitted _ member) found
    apply Structural.TypedPath.fieldStep (optional := true) (parentNullable := true) (by simp [Generated.ProfileAgeSchema]; rfl)
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem ProfileRating_soundness : Generated.ProfileRating_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member found =>
    apply Structural.typedLookup _ _ result (admitted _ member) found
    apply Structural.TypedPath.fieldStep (optional := true) (parentNullable := true) (by simp [Generated.ProfileRatingSchema]; rfl)
    exact Structural.TypedPath.fieldLeaf (optional := true) (by simp)

theorem OptionalAge_soundness : Generated.OptionalAge_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member found =>
    apply Structural.typedLookup _ _ result (admitted _ member) found
    apply Structural.TypedPath.fieldStep (optional := true) (parentNullable := true) (by simp [Generated.OptionalAgeSchema]; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := true) (by simp)

theorem OptionalRating_soundness : Generated.OptionalRating_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member found =>
    apply Structural.typedLookup _ _ result (admitted _ member) found
    apply Structural.TypedPath.fieldStep (optional := true) (parentNullable := true) (by simp [Generated.OptionalRatingSchema]; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := true) (by simp)

theorem optionalProfileTotal_refuted : Generated.optionalProfileTotal_refuted := by
  intro total
  let empty : Structural.Value := (.record [])
  obtain ⟨result, derived⟩ := total (fun value => value = empty) empty rfl
    (by simp [empty, Structural.accepts, Structural.lookup, Generated.ProfileAgeSchema])
  cases derived with
  | rule member found =>
    subst member
    simp [empty, Structural.lookupPath, Structural.step, Structural.lookup] at found

theorem nullableProfileTotal_refuted : Generated.nullableProfileTotal_refuted := by
  intro total
  let empty : Structural.Value := (.record [("profile", .scalar .null)])
  obtain ⟨result, derived⟩ := total (fun value => value = empty) empty rfl
    (by simp [empty, Structural.accepts, Structural.lookup, Generated.ProfileAgeSchema])
  cases derived with
  | rule member found =>
    subst member
    simp [empty, Structural.lookupPath, Structural.step, Structural.lookup] at found

theorem DynamicAge_coverage : Generated.DynamicAge_coverage := by
  intro input value i1 i2 i3 member accepted nonnegative1 nonnegative2 bounds
  have required : Structural.RequiredPath Generated.DynamicAgeSchema [.field "rows", .index i1.val.toNat, .field "cells", .index i2.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨result, Generated.DynamicAge.rule member nonnegative1 nonnegative2 found, valid⟩

theorem DynamicAge_soundness : Generated.DynamicAge_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member _ _ found =>
    apply Structural.typedLookup _ _ result (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem DynamicRating_coverage : Generated.DynamicRating_coverage := by
  intro input value i1 i2 i3 member accepted nonnegative1 nonnegative2 bounds
  have required : Structural.RequiredPath Generated.DynamicRatingSchema [.field "rows", .index i1.val.toNat, .field "cells", .index i2.val.toNat, .field "rating"] true := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨result, Generated.DynamicRating.rule member nonnegative1 nonnegative2 found, valid⟩

theorem DynamicRating_soundness : Generated.DynamicRating_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member _ _ found =>
    apply Structural.typedLookup _ _ result (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem ReusedAge_coverage : Generated.ReusedAge_coverage := by
  intro input value i1 i2 i3 member accepted nonnegative1 bounds
  have required : Structural.RequiredPath Generated.ReusedAgeSchema [.field "rows", .index i1.val.toNat, .field "cells", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨result, Generated.ReusedAge.rule member nonnegative1 found, valid⟩

theorem ReusedAge_soundness : Generated.ReusedAge_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member _ found =>
    apply Structural.typedLookup _ _ result (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem DynamicScore_soundness : Generated.DynamicScore_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member _ _ found =>
    apply Structural.typedLookup _ _ result (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := true) (by simp)

theorem dynamicTotal_refuted : Generated.dynamicTotal_refuted := by
  intro total
  let negative : SafeInt := ⟨-1, by decide⟩
  let zero : SafeInt := ⟨0, by decide⟩
  let row : Structural.Value := .record [("rows", .array [
    .record [("cells", .array [.record [("n", .scalar (.integer zero)), ("rating", .scalar .null)]])]])]
  obtain ⟨result, derived⟩ := total
    (fun value i j u => value = row ∧ i = negative ∧ j = zero ∧ u = zero)
    row negative zero zero ⟨rfl, rfl, rfl, rfl⟩
    (by simp [row, zero, Structural.accepts, Structural.lookup, Generated.DynamicAgeSchema])
  cases derived with
  | rule member nonnegative _ _ =>
    rcases member with ⟨rfl, rfl, rfl, rfl⟩
    simp [negative] at nonnegative

theorem Paired_coverage : Generated.Paired_coverage := by
  intro input value i1 i2 member accepted nonnegative1 nonnegative2 bounds0 bounds1
  have required0 : Structural.RequiredPath Generated.PairedSchema [.field "left", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result0, found0, valid0⟩ := Structural.requiredLookup required0 value accepted bounds0
  have required1 : Structural.RequiredPath Generated.PairedSchema [.field "right", .index i2.val.toNat, .field "rating"] true := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result1, found1, valid1⟩ := Structural.requiredLookup required1 value accepted bounds1
  exact ⟨result0, result1, Generated.Paired.rule member nonnegative1 nonnegative2 found0 found1, valid0, valid1⟩

theorem Paired_soundness : Generated.Paired_soundness := by
  intro input admitted result0 result1 derived
  cases derived with
  | rule member _ _ found0 found1 =>
    constructor
    · apply Structural.typedLookup _ _ result0 (admitted _ _ _ member) found0
      apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
      apply Structural.TypedPath.indexStep
      exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)
    · apply Structural.typedLookup _ _ result1 (admitted _ _ _ member) found1
      apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
      apply Structural.TypedPath.indexStep
      exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem OptionalPair_soundness : Generated.OptionalPair_soundness := by
  intro input admitted result0 result1 derived
  cases derived with
  | rule member _ found0 found1 =>
    constructor
    · apply Structural.typedLookup _ _ result0 (admitted _ _ _ member) found0
      apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
      apply Structural.TypedPath.indexStep
      exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)
    · apply Structural.typedLookup _ _ result1 (admitted _ _ _ member) found1
      exact Structural.TypedPath.fieldLeaf (optional := true) (by simp)

theorem RepeatedPair_coverage : Generated.RepeatedPair_coverage := by
  intro input value i1 i2 member accepted nonnegative1 nonnegative2 bounds0 bounds1 bounds2
  have required0 : Structural.RequiredPath Generated.RepeatedPairSchema [.field "left", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result0, found0, valid0⟩ := Structural.requiredLookup required0 value accepted bounds0
  have required1 : Structural.RequiredPath Generated.RepeatedPairSchema [.field "left", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result1, found1, valid1⟩ := Structural.requiredLookup required1 value accepted bounds1
  have required2 : Structural.RequiredPath Generated.RepeatedPairSchema [.field "right", .index i2.val.toNat, .field "rating"] true := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result2, found2, valid2⟩ := Structural.requiredLookup required2 value accepted bounds2
  exact ⟨result0, result1, result2, Generated.RepeatedPair.rule member nonnegative1 nonnegative2 found0 found1 found2, valid0, valid1, valid2⟩

theorem RepeatedPair_soundness : Generated.RepeatedPair_soundness := by
  intro input admitted result0 result1 result2 derived
  cases derived with
  | rule member _ _ found0 found1 found2 =>
    refine ⟨?_, ?_, ?_⟩
    · apply Structural.typedLookup _ _ result0 (admitted _ _ _ member) found0
      apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
      apply Structural.TypedPath.indexStep
      exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)
    · apply Structural.typedLookup _ _ result1 (admitted _ _ _ member) found1
      apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
      apply Structural.TypedPath.indexStep
      exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)
    · apply Structural.typedLookup _ _ result2 (admitted _ _ _ member) found2
      apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
      apply Structural.TypedPath.indexStep
      exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem pairedSameRow : Generated.pairedSameRow := by
  intro input x y derived
  cases derived with
  | rule member _ _ foundX foundY => exact ⟨_, _, _, member, foundX, foundY⟩

theorem pairedFirstBounds_refuted : Generated.pairedFirstBounds_refuted := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let row : Structural.Value := .record [
    ("left", .array [.record [("n", .scalar (.integer zero))]]), ("right", .array [])]
  have accepted : Structural.accepts Generated.PairedSchema row = true := by
    simp [row, zero, Structural.accepts, Structural.lookup, Generated.PairedSchema]
  have bounds : Structural.ArrayBounds row [.field "left", .index zero.val.toNat, .field "n"] := by
    simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup]
  obtain ⟨x, y, derived⟩ := total
    (fun value i j => value = row ∧ i = zero ∧ j = zero)
    row zero zero ⟨rfl, rfl, rfl⟩ accepted (by decide) (by decide) bounds
  cases derived with
  | rule member _ _ _ found =>
    rcases member with ⟨rfl, rfl, rfl⟩
    simp [row, zero, Structural.lookupPath, Structural.step, Structural.lookup] at found

theorem optionalPairTotal_refuted : Generated.optionalPairTotal_refuted := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let row : Structural.Value := .record [
    ("left", .array [.record [("n", .scalar (.integer zero))]]), ("right", .array [])]
  have accepted : Structural.accepts Generated.OptionalPairSchema row = true := by
    simp [row, zero, Structural.accepts, Structural.lookup, Generated.OptionalPairSchema]
  have bounds : Structural.ArrayBounds row [.field "left", .index zero.val.toNat, .field "n"] := by
    simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup]
  obtain ⟨x, y, derived⟩ := total
    (fun value i j => value = row ∧ i = zero ∧ j = zero)
    row zero zero ⟨rfl, rfl, rfl⟩ accepted (by decide) bounds
  cases derived with
  | rule member _ _ found =>
    rcases member with ⟨rfl, rfl, rfl⟩
    simp [row, zero, Structural.lookupPath, Structural.step, Structural.lookup] at found

theorem Identified_coverage : Generated.Identified_coverage := by
  intro input value i1 i2 i3 member accepted nonnegative bounds
  have required : Structural.RequiredPath Generated.IdentifiedSchema [.field "rows", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨.scalar (.integer i3), result,
    Generated.Identified.rule member nonnegative rfl found, rfl, valid, rfl⟩

theorem Identified_soundness : Generated.Identified_soundness := by
  intro input admitted result0 result1 derived
  cases derived with
  | rule member _ carried0 found =>
    subst result0
    refine ⟨rfl, ?_⟩
    apply Structural.typedLookup _ _ result1 (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem Indexed_coverage : Generated.Indexed_coverage := by
  intro input value i1 i2 i3 member accepted nonnegative bounds
  have required : Structural.RequiredPath Generated.IndexedSchema [.field "rows", .index i1.val.toNat, .field "rating"] true := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨.scalar (.integer i1), result, .scalar (.integer i3), .scalar (.integer i1),
    Generated.Indexed.rule member nonnegative rfl found rfl rfl,
    rfl, valid, rfl, rfl, rfl, rfl, rfl⟩

theorem Indexed_soundness : Generated.Indexed_soundness := by
  intro input admitted result0 result1 result2 result3 derived
  cases derived with
  | rule member _ carried0 found carried2 carried3 =>
    subst result0
    subst result2
    subst result3
    refine ⟨rfl, ?_, rfl, rfl⟩
    apply Structural.typedLookup _ _ result1 (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem OptionalIdentified_soundness : Generated.OptionalIdentified_soundness := by
  intro input admitted result0 result1 derived
  cases derived with
  | rule member _ carried0 found =>
    subst result0
    refine ⟨rfl, ?_⟩
    apply Structural.typedLookup _ _ result1 (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := true) (by simp)

theorem identifiedSameRow : Generated.identifiedSameRow := by
  intro input key result derived
  cases derived with
  | rule member _ carried found => exact ⟨_, _, _, _, member, carried, found⟩

theorem identifiedTotal_refuted : Generated.identifiedTotal_refuted := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let key : SafeInt := ⟨-9007199254740991, by decide⟩
  let row : Structural.Value := .record [("rows", .array [])]
  obtain ⟨outputKey, result, derived⟩ := total
    (fun value i j k => value = row ∧ i = zero ∧ j = zero ∧ k = key)
    row zero zero key ⟨rfl, rfl, rfl, rfl⟩
    (by simp [row, Structural.accepts, Structural.lookup, Generated.IdentifiedSchema]) (by decide)
  cases derived with
  | rule member _ _ found =>
    rcases member with ⟨rfl, rfl, rfl, rfl⟩
    simp [row, zero, Structural.lookupPath, Structural.step, Structural.lookup] at found

theorem Filtered_coverage : Generated.Filtered_coverage := by
  intro input value i1 i2 i3 member accepted keyGuard indexGuard nonnegative bounds
  have required : Structural.RequiredPath Generated.FilteredSchema [.field "rows", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨.scalar (.integer i3), result,
    Generated.Filtered.rule member keyGuard indexGuard nonnegative rfl found, rfl, valid, rfl⟩

theorem Filtered_soundness : Generated.Filtered_soundness := by
  intro input admitted result0 result1 derived
  cases derived with
  | rule member _ _ _ carried0 found =>
    subst result0
    refine ⟨rfl, ?_⟩
    apply Structural.typedLookup _ _ result1 (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem filteredTotal_refuted : Generated.filteredTotal_refuted := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let row : Structural.Value := .record [("rows", .array [.record [("n", .scalar (.integer zero)), ("rating", .scalar .null)]])]
  obtain ⟨key, result, derived⟩ := total
    (fun value i j k => value = row ∧ i = zero ∧ j = zero ∧ k = zero)
    row zero zero zero ⟨rfl, rfl, rfl, rfl⟩
    (by simp [row, Structural.accepts, Structural.lookup, Generated.FilteredSchema])
    (by decide)
    (by simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup])
  cases derived with
  | rule member _ rejected _ _ _ =>
    rcases member with ⟨rfl, rfl, rfl, rfl⟩
    exact (Int.lt_irrefl _) rejected

theorem Excluded_coverage : Generated.Excluded_coverage := by
  intro input value i1 i2 i3 member accepted different nonnegative bounds
  have required : Structural.RequiredPath Generated.ExcludedSchema [.field "rows", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨.scalar (.integer i3), result,
    Generated.Excluded.rule member different nonnegative rfl found, rfl, valid, rfl⟩

theorem Excluded_soundness : Generated.Excluded_soundness := by
  intro input admitted result0 result1 derived
  cases derived with
  | rule member _ _ carried0 found =>
    subst result0
    refine ⟨rfl, ?_⟩
    apply Structural.typedLookup _ _ result1 (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem excludedTotal_refuted : Generated.excludedTotal_refuted := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let row : Structural.Value := .record [("rows", .array [.record [("n", .scalar (.integer zero)), ("rating", .scalar .null)]])]
  obtain ⟨key, result, derived⟩ := total
    (fun value i j k => value = row ∧ i = zero ∧ j = zero ∧ k = zero)
    row zero zero zero ⟨rfl, rfl, rfl, rfl⟩
    (by simp [row, Structural.accepts, Structural.lookup, Generated.ExcludedSchema])
    (by decide)
    (by simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup])
  cases derived with
  | rule member rejected _ _ _ =>
    rcases member with ⟨rfl, rfl, rfl, rfl⟩
    exact rejected rfl

theorem Positive_coverage : Generated.Positive_coverage := by
  intro input value i1 i2 i3 member accepted nonnegative condition bounds
  have required : Structural.RequiredPath Generated.PositiveSchema [.field "rows", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  have integer : ∃ (n : SafeInt), result = Structural.Value.scalar (.integer n) := by
    cases result with
    | scalar v => cases v <;> simp_all [Structural.leafMatches]
    | record fields => simp [Structural.leafMatches] at valid
    | array values => simp [Structural.leafMatches] at valid
  obtain ⟨n, rfl⟩ := integer
  have property : ∃ (m : SafeInt), Structural.Value.scalar (.integer n) = .scalar (.integer m) ∧ m.val > 0 :=
    ⟨n, rfl, condition n found⟩
  exact ⟨.scalar (.integer i3), .scalar (.integer n),
    Generated.Positive.rule member nonnegative rfl found property, rfl, rfl, property, rfl⟩

theorem Positive_soundness : Generated.Positive_soundness := by
  intro input admitted result0 result1 derived
  cases derived with
  | rule member _ carried found property =>
    subst result0
    refine ⟨rfl, ?_, property⟩
    apply Structural.typedLookup _ _ result1 (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem positiveTotal_refuted : Generated.positiveTotal_refuted := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let row : Structural.Value := .record [("rows", .array [.record [("n", .scalar (.integer zero)), ("rating", .scalar .null)]])]
  obtain ⟨key, result, derived⟩ := total
    (fun value i j k => value = row ∧ i = zero ∧ j = zero ∧ k = zero)
    row zero zero zero ⟨rfl, rfl, rfl, rfl⟩
    (by simp [row, Structural.accepts, Structural.lookup, Generated.PositiveSchema])
    (by decide)
    (by simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup])
  cases derived with
  | rule member _ _ found property =>
    rcases member with ⟨rfl, rfl, rfl, rfl⟩
    rcases property with ⟨n, rfl, positive⟩
    simp [row, zero, Structural.lookupPath, Structural.step, Structural.lookup] at found
    have : n.val = 0 := by simpa [zero] using congrArg Subtype.val found.symm
    omega

theorem Ranged_coverage : Generated.Ranged_coverage := by
  intro input value i1 i2 i3 member accepted nonnegative lower upper bounds
  have required : Structural.RequiredPath Generated.RangedSchema [.field "rows", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  have integer : ∃ (n : SafeInt), result = Structural.Value.scalar (.integer n) := by
    cases result with
    | scalar v => cases v <;> simp_all [Structural.leafMatches]
    | record fields => simp [Structural.leafMatches] at valid
    | array values => simp [Structural.leafMatches] at valid
  obtain ⟨n, rfl⟩ := integer
  have property : ∃ (m : SafeInt), Structural.Value.scalar (.integer n) = .scalar (.integer m) ∧ m.val > 0 ∧ m.val ≤ 10 :=
    ⟨n, rfl, lower n found, upper n found⟩
  exact ⟨.scalar (.integer i3), .scalar (.integer n),
    Generated.Ranged.rule member nonnegative rfl found property, rfl, rfl, property, rfl⟩

theorem Ranged_soundness : Generated.Ranged_soundness := by
  intro input admitted result0 result1 derived
  cases derived with
  | rule member _ carried found property =>
    subst result0
    refine ⟨rfl, ?_, property⟩
    apply Structural.typedLookup _ _ result1 (admitted _ _ _ _ member) found
    apply Structural.TypedPath.fieldStep (optional := false) (parentNullable := false) (by simp; rfl)
    apply Structural.TypedPath.indexStep
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem rangedUpper_refuted : Generated.rangedUpper_refuted := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let eleven : SafeInt := ⟨11, by decide⟩
  let row : Structural.Value := .record [("rows", .array [.record [("n", .scalar (.integer eleven)), ("rating", .scalar .null)]])]
  obtain ⟨key, result, derived⟩ := total
    (fun value i j k => value = row ∧ i = zero ∧ j = zero ∧ k = zero)
    row zero zero zero ⟨rfl, rfl, rfl, rfl⟩
    (by simp [row, Structural.accepts, Structural.lookup, Generated.RangedSchema])
    (by decide)
    (by simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup])
    (by
      intro n found
      simp [row, zero, Structural.lookupPath, Structural.step, Structural.lookup] at found
      have : n.val = 11 := by simpa [eleven] using congrArg Subtype.val found.symm
      omega)
  cases derived with
  | rule member _ _ found property =>
    rcases member with ⟨rfl, rfl, rfl, rfl⟩
    rcases property with ⟨n, rfl, _, upper⟩
    simp [row, zero, Structural.lookupPath, Structural.step, Structural.lookup] at found
    have : n.val = 11 := by simpa [eleven] using congrArg Subtype.val found.symm
    omega

private theorem integerLeafWitness {value : Structural.Value}
    (valid : Structural.leafMatches false value = true) :
    ∃ (n : SafeInt), value = Structural.Value.scalar (.integer n) := by
  cases value with
  | scalar v => cases v <;> simp_all [Structural.leafMatches]
  | record fields => simp [Structural.leafMatches] at valid
  | array values => simp [Structural.leafMatches] at valid

theorem BothPositive_coverage : Generated.BothPositive_coverage := by
  intro input value i1 i2 member accepted sign1 sign2 condition1 condition2 bounds1 bounds2
  have required1 : Structural.RequiredPath Generated.BothPositiveSchema [.field "left", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  have required2 : Structural.RequiredPath Generated.BothPositiveSchema [.field "right", .index i2.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨first, found1, valid1⟩ := Structural.requiredLookup required1 value accepted bounds1
  obtain ⟨second, found2, valid2⟩ := Structural.requiredLookup required2 value accepted bounds2
  obtain ⟨n1, rfl⟩ := integerLeafWitness valid1
  obtain ⟨n2, rfl⟩ := integerLeafWitness valid2
  have property1 : ∃ (n : SafeInt), Structural.Value.scalar (.integer n1) = .scalar (.integer n) ∧ n.val > 0 := ⟨n1, rfl, condition1 n1 found1⟩
  have property2 : ∃ (n : SafeInt), Structural.Value.scalar (.integer n2) = .scalar (.integer n) ∧ n.val > 0 := ⟨n2, rfl, condition2 n2 found2⟩
  exact ⟨.scalar (.integer n1), .scalar (.integer n2),
    Generated.BothPositive.rule member sign1 sign2 found1 found2 ⟨property1, property2⟩,
    rfl, rfl, property1, property2⟩

theorem BothPositive_soundness : Generated.BothPositive_soundness := by
  intro input _ first second derived
  cases derived with
  | rule _ _ _ _ _ property =>
    rcases property with ⟨⟨n1, rfl, positive1⟩, ⟨n2, rfl, positive2⟩⟩
    exact ⟨rfl, rfl, ⟨n1, rfl, positive1⟩, ⟨n2, rfl, positive2⟩⟩

theorem bothPositiveSecond_refuted : Generated.bothPositiveSecond_refuted := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let one : SafeInt := ⟨1, by decide⟩
  let row : Structural.Value := .record [("left", .array [.record [("n", .scalar (.integer one))]]), ("right", .array [.record [("n", .scalar (.integer zero))]])]
  obtain ⟨first, second, derived⟩ := total
    (fun value i j => value = row ∧ i = zero ∧ j = zero)
    row zero zero ⟨rfl, rfl, rfl⟩
    (by simp [row, Structural.accepts, Structural.lookup, Generated.BothPositiveSchema])
    (by decide) (by decide)
    (by simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup])
    (by simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup])
    (by
      intro n found
      simp [row, zero, Structural.lookupPath, Structural.step, Structural.lookup] at found
      have : n.val = 1 := by simpa [one] using congrArg Subtype.val found.symm
      omega)
  cases derived with
  | rule member _ _ _ found2 property =>
    rcases member with ⟨rfl, rfl, rfl⟩
    rcases property with ⟨_, ⟨n, rfl, positive⟩⟩
    simp [row, zero, Structural.lookupPath, Structural.step, Structural.lookup] at found2
    have : n.val = 0 := by simpa [zero] using congrArg Subtype.val found2.symm
    omega

theorem Ordered_coverage : Generated.Ordered_coverage := by
  intro input value i1 i2 member accepted sign1 sign2 condition bounds1 bounds2
  have required1 : Structural.RequiredPath Generated.OrderedSchema [.field "left", .index i1.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  have required2 : Structural.RequiredPath Generated.OrderedSchema [.field "right", .index i2.val.toNat, .field "n"] false := by
    apply Structural.RequiredPath.fieldStep (by simp; rfl)
    apply Structural.RequiredPath.indexStep
    exact Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨first, found1, valid1⟩ := Structural.requiredLookup required1 value accepted bounds1
  obtain ⟨second, found2, valid2⟩ := Structural.requiredLookup required2 value accepted bounds2
  obtain ⟨n1, rfl⟩ := integerLeafWitness valid1
  obtain ⟨n2, rfl⟩ := integerLeafWitness valid2
  have property : ∃ (n m : SafeInt), Structural.Value.scalar (.integer n1) = .scalar (.integer n) ∧ Structural.Value.scalar (.integer n2) = .scalar (.integer m) ∧ n.val ≤ m.val :=
    ⟨n1, n2, rfl, rfl, condition n1 n2 found1 found2⟩
  exact ⟨.scalar (.integer n1), .scalar (.integer n2),
    Generated.Ordered.rule member sign1 sign2 found1 found2 property,
    rfl, rfl, property⟩

theorem Ordered_soundness : Generated.Ordered_soundness := by
  intro input _ first second derived
  cases derived with
  | rule _ _ _ _ _ property =>
    rcases property with ⟨n, m, rfl, rfl, ordered⟩
    exact ⟨rfl, rfl, ⟨n, m, rfl, rfl, ordered⟩⟩

theorem orderedTotal_refuted : Generated.orderedTotal_refuted := by
  intro total
  let zero : SafeInt := ⟨0, by decide⟩
  let one : SafeInt := ⟨1, by decide⟩
  let row : Structural.Value := .record [("left", .array [.record [("n", .scalar (.integer one))]]), ("right", .array [.record [("n", .scalar (.integer zero))]])]
  obtain ⟨first, second, derived⟩ := total
    (fun value i j => value = row ∧ i = zero ∧ j = zero)
    row zero zero ⟨rfl, rfl, rfl⟩
    (by simp [row, Structural.accepts, Structural.lookup, Generated.OrderedSchema])
    (by decide) (by decide)
    (by simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup])
    (by simp [row, zero, Structural.ArrayBounds, Structural.step, Structural.lookup])
  cases derived with
  | rule member _ _ found1 found2 property =>
    rcases member with ⟨rfl, rfl, rfl⟩
    rcases property with ⟨n, m, rfl, rfl, ordered⟩
    simp [row, zero, Structural.lookupPath, Structural.step, Structural.lookup] at found1 found2
    have : n.val = 1 := by simpa [one] using congrArg Subtype.val found1.symm
    have : m.val = 0 := by simpa [zero] using congrArg Subtype.val found2.symm
    omega

end Datamog.Proofs
