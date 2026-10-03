import Datamog.Generated

namespace Datamog.Proofs

theorem pipelineCoverage : Generated.pipelineCoverage := by
  intro seed x hx lower upper
  have bounds := x.property
  have hy : InRange (x.val + 1) := by
    unfold InRange maxSafe at *
    omega
  let y : SafeInt := ⟨x.val + 1, hy⟩
  refine ⟨y, Generated.pipelineCoverageFamily.rule0_0 x y ?_⟩
  apply Generated.pipelineCoverageFamily.rule1_0
  apply Generated.pipelineCoverageFamily.rule2_0
  exact Generated.pipelineCoverageFamily.rule3_0 x y
    (Generated.pipelineCoverageFamily.rule4_0 x hx lower) rfl

theorem pipelineTotal_refuted : ¬ Generated.pipelineTotal := by
  intro total
  let negative : SafeInt := ⟨-1, by decide⟩
  obtain ⟨y, h⟩ := total (fun _ => True) negative True.intro
  have nonnegative : ∀ tag x y, Generated.pipelineTotalFamily (fun _ => True) tag x y → x.val ≥ 0 := by
    intro tag x y derivation
    induction derivation <;> simp_all <;> omega
  have bad := nonnegative 0 negative y h
  change (-1 : Int) ≥ 0 at bad
  omega

end Datamog.Proofs
