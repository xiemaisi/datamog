import Datamog.Generated

namespace Datamog.Proofs

theorem bothSafe_refuted : ¬ Generated.bothSafe := by
  intro claimed
  let one : SafeInt := ⟨1, by decide⟩
  have seed : Generated.bothSafeFamily (fun _ => True) 0 one :=
    Generated.bothSafeFamily.rule0_0 one True.intro (by decide)
  have step : Generated.bothSafeFamily (fun _ => True) 1 one :=
    Generated.bothSafeFamily.rule1_0 one one seed (by rfl)
  have bad := (claimed (fun _ => True)).2 one step
  change (1 : Int) > 1 at bad
  omega

end Datamog.Proofs
