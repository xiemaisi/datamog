import Datamog.Generated
namespace Datamog.Proofs

theorem unique : Generated.unique := by
  intro item law k x y hx hy
  have origin : ∀ tag k v, Generated.uniqueFamily item tag k v → ∃ t, item k v t := by
    intro tag k v h
    induction h with
    | rule0_0 k v h ih => exact ih
    | rule1_0 k v t h => exact ⟨t, h⟩
  obtain ⟨tx, hx⟩ := origin 0 k x hx
  obtain ⟨ty, hy⟩ := origin 0 k y hy
  exact law k x tx y ty hx hy

theorem unrestricted_refuted : ¬ Generated.unrestricted := by
  intro unique
  let zero : SafeInt := ⟨0, by decide⟩
  let one : SafeInt := ⟨1, by decide⟩
  have equal := unique (fun _ _ _ => True) zero zero one
    (Generated.unrestrictedFamily.rule0_0 zero zero
      (Generated.unrestrictedFamily.rule1_0 zero zero zero True.intro))
    (Generated.unrestrictedFamily.rule0_0 zero one
      (Generated.unrestrictedFamily.rule1_0 zero one one True.intro))
  have impossible := congrArg Subtype.val equal
  change (0 : Int) = 1 at impossible
  omega

end Datamog.Proofs
