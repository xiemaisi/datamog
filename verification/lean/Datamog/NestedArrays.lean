import Datamog.Semantics
namespace Datamog.NestedArrays
inductive Value where
  | scalar (value : Datamog.Value)
  | array (values : List Value)
-- One element-nullability flag per array dimension; [] describes an integer.
def accepts : List Bool → Bool → Value → Bool
  | _, nullable, .scalar .null => nullable
  | [], _, .scalar (.integer _) => true
  | nullable :: rest, _, .array values => values.all (accepts rest nullable)
  | _, _, _ => false
def lookupIndex : Value → Int → Option Value
  | .array values, index => if 0 ≤ index then values[index.toNat]? else none
  | _, _ => none
def lookupPath : Value → List Nat → Option Value
  | value, [] => some value
  | value, index :: rest => (lookupIndex value (Int.ofNat index)).bind (lookupPath · rest)
-- Every bound concerns the actual array reached by the preceding indices.
inductive Bounds : Value → List Nat → Prop where
  | done : Bounds value []
  | step (bound : index < values.length) (tail : Bounds values[index] rest) :
      Bounds (.array values) (index :: rest)
def leafNullable : List Bool → Bool → Bool
  | [], nullable => nullable
  | next :: rest, _ => leafNullable rest next
 theorem typedLookup (flags : List Bool) (nullable : Bool) (value : Value)
    (path : List Nat) (accepted : accepts flags nullable value = true)
    (bounds : Bounds value path) (depth : path.length = flags.length) :
    ∃ result, lookupPath value path = some result ∧
      accepts [] (leafNullable flags nullable) result = true := by
  induction flags generalizing nullable value path with
  | nil =>
    cases path with
    | nil => exact ⟨value, rfl, accepted⟩
    | cons _ _ => simp at depth
  | cons next rest ih =>
    cases bounds with
    | done => simp at depth
    | @step index values tail bound remaining =>
      simp only [accepts, List.all_eq_true] at accepted
      have child := accepted _ (List.getElem_mem bound)
      obtain ⟨result, found, valid⟩ := ih next values[index] tail child remaining (by simpa using depth)
      exact ⟨result, by simpa [lookupPath, lookupIndex, bound] using found, valid⟩
end Datamog.NestedArrays
