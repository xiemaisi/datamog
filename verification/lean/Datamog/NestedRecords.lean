import Datamog.Semantics

namespace Datamog.Nested

inductive Value where
  | scalar (value : Datamog.Value)
  | record (fields : List (String × Value))

def lookup : List (String × Value) → String → Option Value
  | [], _ => none
  | (name, value) :: rest, key =>
    match lookup rest key with
    | some found => some found
    | none => if name = key then some value else none

def lookupPath : Value → List String → Option Value
  | value, [] => some value
  | .record fields, key :: rest => (lookup fields key).bind (fun value => lookupPath value rest)
  | .scalar _, _ :: _ => none

inductive Schema where
  | integer
  | record (fields : List (String × Bool × Bool × Schema))

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
  | _, _ => false
termination_by sizeOf schema
decreasing_by
  rcases field with ⟨⟨key, optional, nullable, child⟩, member⟩
  simp_all [Schema.record.sizeOf_spec, Prod.mk.sizeOf_spec]
  omega

-- Every parent is required and non-nullable. The leaf may explicitly admit null.
inductive RequiredPath : Schema → List String → Bool → Prop where
  | leaf : (key, false, nullable, Schema.integer) ∈ fields →
      RequiredPath (.record fields) [key] nullable
  | step : (key, false, false, Schema.record children) ∈ fields →
      RequiredPath (.record children) rest nullable →
      RequiredPath (.record fields) (key :: rest) nullable

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

theorem requiredPathLookup {schema : Schema} {path : List String} {nullable : Bool}
    (required : RequiredPath schema path nullable) (value : Value)
    (accepted : accepts schema value = true) :
    ∃ result, lookupPath value path = some result ∧ leafMatches nullable result = true := by
  induction required generalizing value with
  | @leaf fields key nullable member =>
    cases value with
    | scalar v => simp [accepts] at accepted
    | record entries =>
      have h := fieldAccepted fields entries key false nullable .integer member accepted
      cases found : lookup entries key with
      | none => simp [found] at h
      | some v =>
        refine ⟨v, ?_, ?_⟩
        · simp [lookupPath, found]
        · cases v with
          | record r => simp [found, accepts] at h
          | scalar v => cases v <;> simp_all [accepts, leafMatches]
  | @step fields key children rest nullable member required ih =>
    cases value with
    | scalar v => simp [accepts] at accepted
    | record entries =>
      have h := fieldAccepted fields entries key false false (.record children) member accepted
      cases found : lookup entries key with
      | none => simp [found] at h
      | some v =>
        cases v with
        | scalar v => cases v <;> simp [found, accepts] at h
        | record inner =>
          have childAccepted : accepts (.record children) (.record inner) = true := by
            simpa [found] using h
          obtain ⟨result, lookupResult, valid⟩ := ih (.record inner) childAccepted
          exact ⟨result, by simpa [lookupPath, found] using lookupResult, valid⟩

theorem requiredIntegerLookup {schema : Schema} {path : List String}
    (required : RequiredPath schema path false) (value : Value)
    (accepted : accepts schema value = true) :
    ∃ n : SafeInt, lookupPath value path = some (.scalar (.integer n)) := by
  obtain ⟨result, found, valid⟩ := requiredPathLookup required value accepted
  cases result with
  | record fields => simp [leafMatches] at valid
  | scalar v =>
    cases v with
    | null => simp [leafMatches] at valid
    | boolean b => simp [leafMatches] at valid
    | integer n => exact ⟨n, found⟩

end Datamog.Nested
