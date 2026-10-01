import Datamog.Generated

namespace Datamog.Proofs

theorem positiveSafe : Generated.positiveSafe := by
  unfold Generated.positiveSafe
  intros
  simp_all

theorem forwardedSafe : Generated.forwardedSafe := by
  unfold Generated.forwardedSafe
  intros
  simp_all

theorem resultSafe : Generated.resultSafe := by
  unfold Generated.resultSafe
  intros
  simp_all
  omega

end Datamog.Proofs
