---
title: "Intensional layering"
kind: content
section: "Pokémon"
tight: true
---

Predicates build on each other: ability "prankster" adds 1 to a move's priority.

```datamog
input predicate learns(name: string, move: string).
input predicate move_priority(move: string, priority: integer).
input predicate doubles_move(move: string).
input predicate protection_move(move: string).
input predicate pokemon_ability(name: string, ability: string).

learns_priority(Name, Move, Priority) :-
  learns(Name, Move),
  not doubles_move(Move), not protection_move(Move), Move <> "bide",
  move_priority(Move, Priority), Priority > 0.

learns_effective_priority(Name, Move, Priority + 1) :-
  learns_priority(Name, Move, Priority), pokemon_ability(Name, "prankster").

learns_effective_priority(Name, Move, Priority) :-
  learns_priority(Name, Move, Priority), not pokemon_ability(Name, "prankster").

?- learns_effective_priority(Name, Move, Priority).
```
