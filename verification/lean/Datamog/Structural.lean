import Datamog.Semantics

namespace Datamog.Structural

inductive Value where
  | scalar (value : Datamog.Value)
  | record (fields : List (String × Value))
  | array (values : List Value)

inductive Schema where
  | integer
  | record (fields : List (String × Bool × Bool × Schema))
  | array (nullable : Bool) (element : Schema)

def lookup : List (String × Value) → String → Option Value
  | [], _ => none
  | (name, value) :: rest, key =>
    match lookup rest key with
    | some found => some found
    | none => if name = key then some value else none

inductive Segment where
  | field (key : String)
  | index (index : Nat)

def step : Value → Segment → Option Value
  | .record fields, .field key => lookup fields key
  | .array values, .index index => values[index]?
  | _, _ => none

def lookupPath : Value → List Segment → Option Value
  | value, [] => some value
  | value, segment :: rest => (step value segment).bind (lookupPath · rest)

def accepts (schema : Schema) (value : Value) : Bool :=
  match schema, value with
  | .integer, .scalar (.integer _) => true
  | .record schemaFields, .record fields =>
    schemaFields.attach.all (fun field =>
      have _bound := List.sizeOf_lt_of_mem field.property
      match lookup fields field.val.1 with
      | none => field.val.2.1
      | some (.scalar .null) => field.val.2.2.1
      | some value => accepts field.val.2.2.2 value) &&
    fields.all (fun entry => schemaFields.any (fun field => field.1 == entry.1))
  | .array nullable child, .array values => values.all (fun value =>
      match value with
      | .scalar .null => nullable
      | _ => accepts child value)
  | _, _ => false
termination_by sizeOf schema
decreasing_by
  · rcases field with ⟨⟨key, optional, nullable, child⟩, member⟩
    simp_all [Schema.record.sizeOf_spec, Prod.mk.sizeOf_spec]
    omega
  · simp_all [Schema.array.sizeOf_spec]

-- Only array steps impose existence/bounds. Field steps do not assume presence:
-- schema membership must establish required fields, even when no array is below.
def ArrayBounds : Value → List Segment → Prop
  | _, [] => True
  | value, .field key :: rest =>
      ∀ child, step value (.field key) = some child → ArrayBounds child rest
  | .array values, .index index :: rest =>
      ∃ bound : index < values.length, ArrayBounds values[index] rest
  | _, .index _ :: _ => False

inductive RequiredPath : Schema → List Segment → Bool → Prop where
  | fieldLeaf : (key, false, nullable, Schema.integer) ∈ fields →
      RequiredPath (.record fields) [.field key] nullable
  | fieldStep : (key, false, false, child) ∈ fields →
      RequiredPath child rest nullable → RequiredPath (.record fields) (.field key :: rest) nullable
  | indexLeaf : RequiredPath (.array nullable .integer) [.index index] nullable
  | indexStep : RequiredPath child rest nullable →
      RequiredPath (.array false child) (.index index :: rest) nullable

def leafMatches (nullable : Bool) : Value → Bool
  | .scalar (.integer _) => true
  | .scalar .null => nullable
  | _ => false

theorem fieldAccepted (schema : List (String × Bool × Bool × Schema))
    (fields : List (String × Value)) (key : String) (optional nullable : Bool) (child : Schema)
    (member : (key, optional, nullable, child) ∈ schema)
    (accepted : accepts (.record schema) (.record fields) = true) :
    (match lookup fields key with
      | none => optional
      | some (.scalar .null) => nullable
      | some value => accepts child value) = true := by
  simp only [accepts, Bool.and_eq_true, List.all_eq_true] at accepted
  exact accepted.1 ⟨(key, optional, nullable, child), member⟩ (by simp)

theorem nonnullableAccepted (schema : Schema) (value : Value)
    (h : (match value with | .scalar .null => false | _ => accepts schema value) = true) :
    accepts schema value = true := by
  cases value with
  | scalar v => cases v <;> simp_all
  | record _ => exact h
  | array _ => exact h

theorem integerAccepted (nullable : Bool) (value : Value)
    (h : (match value with | .scalar .null => nullable | _ => accepts .integer value) = true) :
    leafMatches nullable value = true := by
  cases value with
  | scalar v => cases v <;> simp_all [accepts, leafMatches]
  | record _ => simp [accepts] at h
  | array _ => simp [accepts] at h

theorem requiredLookup {schema : Schema} {path : List Segment} {nullable : Bool}
    (required : RequiredPath schema path nullable) (value : Value)
    (accepted : accepts schema value = true) (bounds : ArrayBounds value path) :
    ∃ result, lookupPath value path = some result ∧ leafMatches nullable result = true := by
  induction required generalizing value with
  | @fieldLeaf fields key nullable member =>
    cases value with
    | scalar _ => simp [accepts] at accepted
    | array _ => simp [accepts] at accepted
    | record entries =>
      have h := fieldAccepted fields entries key false nullable .integer member accepted
      cases found : lookup entries key with
      | none => simp [found] at h
      | some v =>
        exact ⟨v, by simp [lookupPath, step, found], integerAccepted nullable v (by
          cases v with
          | scalar s => cases s <;> simpa [found] using h
          | record _ => simpa [found] using h
          | array _ => simpa [found] using h)⟩
  | @fieldStep fields key child rest nullable member required ih =>
    cases value with
    | scalar _ => simp [accepts] at accepted
    | array _ => simp [accepts] at accepted
    | record entries =>
      have h := fieldAccepted fields entries key false false child member accepted
      cases found : lookup entries key with
      | none => simp [found] at h
      | some v =>
        have valid := nonnullableAccepted child v (by
          cases v with
          | scalar s => cases s <;> simpa [found] using h
          | record _ => simpa [found] using h
          | array _ => simpa [found] using h)
        obtain ⟨result, resultFound, resultValid⟩ := ih v valid (bounds v found)
        exact ⟨result, by simpa [lookupPath, step, found] using resultFound, resultValid⟩
  | @indexLeaf nullable index =>
    cases value with
    | scalar _ => simp [ArrayBounds] at bounds
    | record _ => simp [ArrayBounds] at bounds
    | array values =>
      obtain ⟨bound, _⟩ := bounds
      simp only [accepts, List.all_eq_true] at accepted
      have h := accepted _ (List.getElem_mem bound)
      exact ⟨values[index], by simp [lookupPath, step, bound], integerAccepted nullable values[index] h⟩
  | @indexStep child rest nullable index required ih =>
    cases value with
    | scalar _ => simp [ArrayBounds] at bounds
    | record _ => simp [ArrayBounds] at bounds
    | array values =>
      obtain ⟨bound, remaining⟩ := bounds
      simp only [accepts, List.all_eq_true] at accepted
      have h := accepted _ (List.getElem_mem bound)
      obtain ⟨result, found, valid⟩ := ih values[index] (nonnullableAccepted child values[index] h) remaining
      exact ⟨result, by simpa [lookupPath, step, bound] using found, valid⟩

-- Typed paths permit absence and null containers and constrain successful lookups.
inductive TypedPath : Schema → List Segment → Bool → Prop where
  | fieldLeaf {optional : Bool} : (key, optional, nullable, Schema.integer) ∈ fields →
      TypedPath (.record fields) [.field key] nullable
  | fieldStep {optional parentNullable : Bool} : (key, optional, parentNullable, child) ∈ fields →
      TypedPath child rest nullable → TypedPath (.record fields) (.field key :: rest) nullable
  | indexLeaf : TypedPath (.array nullable .integer) [.index index] nullable
  | indexStep : TypedPath child rest nullable →
      TypedPath (.array parentNullable child) (.index index :: rest) nullable

theorem TypedPath.nonempty (typed : TypedPath schema path nullable) : path ≠ [] := by
  cases typed <;> simp

theorem nullLookupAbsent (path : List Segment) (nonempty : path ≠ []) :
    lookupPath (.scalar .null) path = none := by
  cases path with
  | nil => contradiction
  | cons segment rest => cases segment <;> rfl

theorem lookedUpChildAccepted (schema : Schema) (value : Value) (nullable : Bool)
    (path : List Segment) (result : Value) (nonempty : path ≠ [])
    (accepted : (match value with | .scalar .null => nullable | _ => accepts schema value) = true)
    (found : lookupPath value path = some result) : accepts schema value = true := by
  cases value with
  | scalar v =>
    cases v with
    | null => rw [nullLookupAbsent path nonempty] at found; contradiction
    | integer _ => exact accepted
    | boolean _ => exact accepted
  | record _ => exact accepted
  | array _ => exact accepted

theorem typedLookup {schema : Schema} {path : List Segment} {nullable : Bool}
    (typed : TypedPath schema path nullable) (value result : Value)
    (accepted : accepts schema value = true) (found : lookupPath value path = some result) :
    leafMatches nullable result = true := by
  induction typed generalizing value result with
  | @fieldLeaf fields key nullable optional member =>
    cases value with
    | scalar _ => simp [accepts] at accepted
    | array _ => simp [accepts] at accepted
    | record entries =>
      have h := fieldAccepted fields entries key optional nullable .integer member accepted
      have lookupResult : lookup entries key = some result := by
        simpa [lookupPath, step] using found
      rw [lookupResult] at h
      exact integerAccepted nullable result (by cases result with
        | scalar v => cases v <;> simpa using h
        | record _ => simpa using h
        | array _ => simpa using h)
  | @fieldStep fields key child rest nullable optional parentNullable member typed ih =>
    cases value with
    | scalar _ => simp [accepts] at accepted
    | array _ => simp [accepts] at accepted
    | record entries =>
      have h := fieldAccepted fields entries key optional parentNullable child member accepted
      cases lookupResult : lookup entries key with
      | none => simp [lookupPath, step, lookupResult] at found
      | some v =>
        have remaining : lookupPath v rest = some result := by
          simpa [lookupPath, step, lookupResult] using found
        rw [lookupResult] at h
        exact ih v result
          (lookedUpChildAccepted child v parentNullable rest result typed.nonempty (by
            cases v with
            | scalar s => cases s <;> simpa using h
            | record _ => simpa using h
            | array _ => simpa using h) remaining)
          remaining
  | @indexLeaf nullable index =>
    cases value with
    | scalar _ => simp [accepts] at accepted
    | record _ => simp [accepts] at accepted
    | array values =>
      have lookupResult : values[index]? = some result := by
        simpa [lookupPath, step] using found
      have member : result ∈ values := List.mem_of_getElem? lookupResult
      simp only [accepts, List.all_eq_true] at accepted
      exact integerAccepted nullable result (accepted result member)
  | @indexStep child rest nullable parentNullable index typed ih =>
    cases value with
    | scalar _ => simp [accepts] at accepted
    | record _ => simp [accepts] at accepted
    | array values =>
      cases lookupResult : values[index]? with
      | none => simp [lookupPath, step, lookupResult] at found
      | some v =>
        have remaining : lookupPath v rest = some result := by
          simpa [lookupPath, step, lookupResult] using found
        simp only [accepts, List.all_eq_true] at accepted
        have h := accepted v (List.mem_of_getElem? lookupResult)
        exact ih v result
          (lookedUpChildAccepted child v parentNullable rest result typed.nonempty (by
            cases v with
            | scalar s => cases s <;> simpa using h
            | record _ => simpa using h
            | array _ => simpa using h) remaining)
          remaining

end Datamog.Structural
