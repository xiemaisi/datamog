import Datamog.Generated
namespace Datamog.Proofs

theorem check : Generated.check := by
  intro seed law h
  cases h with
  | rule0_0 x hx bad => have positive := law x hx; omega

theorem noBad : Generated.noBad := by
  intro seed law x h
  cases h with
  | rule0_0 x hx bad => have positive := law x hx; omega

theorem empty : Generated.empty := by
  intro seed law x h
  cases h with
  | rule0_0 x hx bad => have positive := law x hx; omega

theorem unrestricted_refuted : ¬ Generated.unrestricted := by
  intro empty
  let zero : SafeInt := ⟨0, by decide⟩
  exact empty (fun _ => True)
    (Generated.unrestrictedFamily.rule0_0 zero True.intro (by decide))

end Datamog.Proofs
