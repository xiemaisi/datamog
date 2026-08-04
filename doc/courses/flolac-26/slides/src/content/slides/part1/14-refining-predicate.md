---
title: "Refining the predicate"
kind: content
section: "Pokémon"
---

Not every priority move is useful.

Drop moves that only work in doubles battles, and the special move `bide`.

```datamog
input predicate learns(name: string, move: string).
input predicate move_priority(move: string, priority: integer).
input predicate doubles_move(move: string).

learns_priority(Name, Move, Priority) :-
  learns(Name, Move),
  not doubles_move(Move),
  Move <> "bide",
  move_priority(Move, Priority),
  Priority > 0.

?- learns_priority(Name, Move, Priority).
```
