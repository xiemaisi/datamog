import Datamog.Generated
namespace Datamog.Proofs

theorem positive : Generated.positive := by
  intro item law x h
  cases h with
  | rule0_0 x hx => exact law x hx

theorem unrestricted_refuted : ¬ Generated.unrestricted := by
  intro all
  let zero : SafeInt := ⟨0, by decide⟩
  have bad := all (fun _ => True) zero
    (Generated.unrestrictedFamily.rule0_0 zero True.intro)
  change (0 : Int) > 0 at bad
  omega

end Datamog.Proofs
