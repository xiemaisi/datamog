import Datamog.Generated

namespace Datamog.Proofs

theorem growSafe_refuted : ¬ Generated.growSafe := by
  intro claimed
  let one : SafeInt := ⟨1, by decide⟩
  let two : SafeInt := ⟨2, by decide⟩
  have seed : Generated.Grow (fun _ => True) one :=
    Generated.Grow.rule0 one True.intro rfl
  have step : Generated.Grow (fun _ => True) two :=
    Generated.Grow.rule1 one two seed rfl
  have bad := claimed (fun _ => True) two step
  change (2 : Int) ≤ 1 ∨ (2 : Int) ≤ 1 at bad
  omega

end Datamog.Proofs
