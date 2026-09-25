import Lean

open Lean Elab Command in
elab "#audit " id:ident : command => do
  let names ← liftCoreM <| realizeGlobalConstWithInfos id
  for name in names do
    let axioms ← collectAxioms name
    let allowed := #[``propext, ``Classical.choice, ``Quot.sound]
    for axiomName in axioms do
      unless allowed.contains axiomName do
        throwError "Unapproved axiom {axiomName} in {name}"
    logInfo m!"Audited {name}: {axioms}"
