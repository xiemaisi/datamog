import Datamog.Generated

namespace Datamog.Proofs

theorem identityUnique : Generated.identityUnique := by
  intro item x y z hxy hxz
  cases hxy
  cases hxz
  rfl

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

end Datamog.Proofs
