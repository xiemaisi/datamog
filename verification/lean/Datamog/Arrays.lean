import Datamog.Semantics

namespace Datamog.Arrays

-- The first array fragment: scalar values, with integer element schemas.
def elementMatches (nullable : Bool) : Value → Bool
  | .integer _ => true
  | .null => nullable
  | .boolean _ => false

def accepts (nullable : Bool) (values : List Value) : Bool :=
  values.all (elementMatches nullable)

def lookupIndex (values : List Value) (index : Int) : Result :=
  if 0 ≤ index then values[index.toNat]? else none

theorem inBounds (values : List Value) (index : Nat) (bound : index < values.length) :
    ∃ value, lookupIndex values (Int.ofNat index) = some value := by
  exact ⟨values[index], by simp [lookupIndex, bound]⟩

theorem elementValid (nullable : Bool) (values : List Value) (index : Nat)
    (accepted : accepts nullable values = true) (bound : index < values.length) :
    elementMatches nullable values[index] = true := by
  simp only [accepts, List.all_eq_true] at accepted
  exact accepted _ (List.getElem_mem bound)

theorem integerLookup (values : List Value) (index : Nat)
    (accepted : accepts false values = true) (bound : index < values.length) :
    ∃ n : SafeInt, lookupIndex values (Int.ofNat index) = some (.integer n) := by
  have valid := elementValid false values index accepted bound
  have found : lookupIndex values (Int.ofNat index) = some values[index] := by
    simp [lookupIndex, bound]
  cases result : values[index] with
  | null => simp [result, elementMatches] at valid
  | boolean b => simp [result, elementMatches] at valid
  | integer n => exact ⟨n, by simpa [result] using found⟩

end Datamog.Arrays
