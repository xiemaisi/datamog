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

end Datamog
