import Datamog.Generated

namespace Datamog.Proofs

theorem Picked_coverage : Generated.Picked_coverage := by
  intro input value member accepted bounds
  have required : Structural.RequiredPath Generated.PickedSchema [.field "n"] false :=
    Structural.RequiredPath.fieldLeaf (by simp)
  obtain ⟨result, found, valid⟩ := Structural.requiredLookup required value accepted bounds
  exact ⟨result, Generated.Picked.rule member found, valid⟩

theorem Picked_soundness : Generated.Picked_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member found =>
    apply Structural.typedLookup _ _ result (admitted _ member) found
    exact Structural.TypedPath.fieldLeaf (optional := false) (by simp)

theorem Maybe_soundness : Generated.Maybe_soundness := by
  intro input admitted result derived
  cases derived with
  | rule member found =>
    apply Structural.typedLookup _ _ result (admitted _ member) found
    exact Structural.TypedPath.fieldLeaf (optional := true) (by simp)

end Datamog.Proofs
