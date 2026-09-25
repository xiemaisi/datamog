import Std

namespace Datamog

def maxSafe : Int := 9007199254740991
def InRange (n : Int) : Prop := -maxSafe ≤ n ∧ n ≤ maxSafe
instance (n : Int) : Decidable (InRange n) := inferInstanceAs (Decidable (_ ∧ _))
abbrev SafeInt := {n : Int // InRange n}

inductive Value where
  | null
  | integer (n : SafeInt)
  | boolean (b : Bool)
  deriving DecidableEq

abbrev Result := Option Value

def Holds (r : Result) : Prop := r = some (.boolean true)
def negationAsFailure (r : Result) : Prop := ¬ Holds r

def logicalNot : Result → Result
  | some (.boolean b) => some (.boolean (!b))
  | _ => none

def bounded (n : Int) : Result :=
  if h : InRange n then some (.integer ⟨n, h⟩) else none

-- The quotient's sign follows the operands; Nat division supplies magnitude.
-- Zero is only a totalized IR placeholder, not a defined Datamog division.
def truncDiv (a b : Int) : Int :=
  let magnitude : Int := Int.ofNat (a.natAbs / b.natAbs)
  if a * b < 0 then -magnitude else magnitude

def add : Result → Result → Result
  | none, _ | _, none => none
  | some .null, _ | _, some .null => some .null
  | some (.integer a), some (.integer b) => bounded (a.val + b.val)
  | _, _ => none

def divide : Result → Result → Result
  | none, _ | _, none => none
  | some .null, _ | _, some .null => some .null
  | some (.integer a), some (.integer b) =>
    if b.val = 0 then none else bounded (truncDiv a.val b.val)
  | _, _ => none

def less : Result → Result → Result
  | some (.integer a), some (.integer b) => some (.boolean (decide (a.val < b.val)))
  | _, _ => none

def equal : Result → Result → Result
  | some a, some b => some (.boolean (decide (a = b)))
  | _, _ => none

theorem null_is_defined : (some Value.null : Result) ≠ none := by decide
theorem null_not_true : ¬ Holds (some .null) := by simp [Holds]
theorem undefined_not_true : ¬ Holds none := by simp [Holds]
theorem not_null_is_undefined : logicalNot (some .null) = none := rfl

end Datamog

namespace Datamog

def remainder : Result → Result → Result
  | none, _ | _, none => none
  | some .null, _ | _, some .null => some .null
  | some (.integer a), some (.integer b) =>
    if b.val = 0 then none else bounded (a.val - b.val * truncDiv a.val b.val)
  | _, _ => none

end Datamog
