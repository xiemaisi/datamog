import Datamog.Generated
namespace Datamog.Proofs

theorem unique : Generated.unique := by
  intro item law k x y hx hy
  cases hx with
  | rule0_0 k x hx =>
    cases hy with
    | rule0_0 k y hy =>
      apply Subtype.ext
      exact (law k x hx).trans (law k y hy).symm

theorem equivalent : Generated.equivalent := by
  intro item law k v
  constructor
  · intro h
    cases h with
    | rule0_0 k v hv => exact Generated.equivalentFamily.rule1_0 k v hv (law k v hv)
  · intro h
    cases h with
    | rule1_0 k v hv _ => exact Generated.equivalentFamily.rule0_0 k v hv

theorem uniqueUnrestricted_refuted : ¬ Generated.uniqueUnrestricted := by
  intro unique
  let zero : SafeInt := ⟨0, by decide⟩
  let one : SafeInt := ⟨1, by decide⟩
  have equal := unique (fun _ _ => True) zero zero one
    (Generated.uniqueUnrestrictedFamily.rule0_0 zero zero True.intro)
    (Generated.uniqueUnrestrictedFamily.rule0_0 zero one True.intro)
  have impossible := congrArg Subtype.val equal
  change (0 : Int) = 1 at impossible
  omega

theorem equivalentUnrestricted_refuted : ¬ Generated.equivalentUnrestricted := by
  intro equivalent
  let one : SafeInt := ⟨1, by decide⟩
  have h := (equivalent (fun _ _ => True) one one).mp
    (Generated.equivalentUnrestrictedFamily.rule0_0 one one True.intro)
  cases h with
  | rule1_0 k v hv zero =>
    change (1 : Int) = 0 at zero
    omega

end Datamog.Proofs
