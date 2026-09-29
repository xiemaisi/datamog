import Datamog.Semantics

namespace Datamog

-- A deliberately flat record model: only the scalar Value fragment is admitted.
-- Entries follow construction order, so the last occurrence of a key wins.
abbrev FlatRecord := List (String × Value)

def lookupField : FlatRecord → String → Result
  | [], _ => none
  | (name, value) :: rest, key =>
    match lookupField rest key with
    | some found => some found
    | none => if name = key then some value else none

-- This checks one integer field, not closed-record membership or nested shapes.
def integerFieldMatches (fields : FlatRecord) (key : String)
    (optional nullable : Bool) : Bool :=
  match lookupField fields key with
  | none => optional
  | some .null => nullable
  | some (.integer _) => true
  | some (.boolean _) => false

structure IntegerField where
  name : String
  optional : Bool
  nullable : Bool

-- Validate the final value of each declared field, and reject every extra key.
def integerRecordMatches (schema : List IntegerField) (fields : FlatRecord) : Bool :=
  schema.all (fun field => integerFieldMatches fields field.name field.optional field.nullable) &&
  fields.all (fun entry => schema.any (fun field => field.name == entry.1))

end Datamog
