import Datamog.Generated
namespace Datamog.Proofs

theorem total : Generated.total := by
  intro item law x hx
  have upper := law x hx
  have bounds := x.property
  have hy : InRange (x.val + 1) := by
    unfold InRange maxSafe at *
    omega
  let y : SafeInt := ⟨x.val + 1, hy⟩
  exact ⟨y, Generated.totalFamily.rule0_0 x y hx rfl⟩

theorem unrestricted_refuted : ¬ Generated.unrestricted := by
  intro total
  let maximum : SafeInt := ⟨maxSafe, by unfold InRange maxSafe; decide⟩
  obtain ⟨y, h⟩ := total (fun _ => True) maximum True.intro
  cases h with
  | rule0_0 x y hx equal =>
    have bounds := y.property
    change y.val = maxSafe + 1 at equal
    unfold InRange at bounds
    omega

end Datamog.Proofs
