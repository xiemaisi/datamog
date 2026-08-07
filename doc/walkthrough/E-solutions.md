# Appendix E — Solutions index

A flat index to every exercise solution, grouped by chapter.

## Chapter 1

- [1.1 American scientists](solutions/ch01/ex1.dl)
- [1.2 Shared birth year](solutions/ch01/ex2.dl)
- [1.3 Extend the data](solutions/ch01/ex3.dl)
- [1.4 Read the SQL](solutions/ch01/ex4.md)
- [1.5 Inline vs. CSV](solutions/ch01/ex5.dl)

## Chapter 2

- [2.1 Grandchild](solutions/ch02/ex1.dl)
- [2.2 Project down](solutions/ch02/ex2.dl)
- [2.3 Self-parent](solutions/ch02/ex3.md)
- [2.4 Read the SQL](solutions/ch02/ex4.md)
- [2.5 Fourth generation](solutions/ch02/ex5-four-gens/ex5-four-gens.dl)

## Chapter 3

- [3.1 In-laws](solutions/ch03/ex1.dl)
- [3.2 Union with overlap](solutions/ch03/ex2.dl)
- [3.3 Symmetric closure](solutions/ch03/ex3.dl)
- [3.4 Read the SQL](solutions/ch03/ex4.md)
- [3.5 Disjunction as multiple predicates](solutions/ch03/ex5.md)

## Chapter 4

- [4.1 Bounded reachability](solutions/ch04/ex1.dl) / [discussion](solutions/ch04/ex1.md)
- [4.2 Reflexive closure](solutions/ch04/ex2.dl)
- [4.3 Non-linear rejection](solutions/ch04/ex3.md)
- [4.4 Mutual recursion](solutions/ch04/ex4-mutual/ex4-mutual.dl)
- [4.5 Same-generation](solutions/ch04/ex5.dl)

## Chapter 5

- [5.1 Diamond hand-trace](solutions/ch05/ex1.md)
- 5.2 Same program, different backend *(experiment — no written solution needed)*
- 5.3 Chain-length timing *(experiment — no written solution needed)*
- [5.4 Why seminaive doesn't handle negation](solutions/ch05/ex4.md)

## Chapter 6

- [6.1 Grading bands](solutions/ch06/ex1.dl)
- [6.2 Running sums](solutions/ch06/ex2.dl)
- [6.3 Prefixes](solutions/ch06/ex3.dl)
- 6.4 Range with computed bounds *(read the dry-run output)*
- 6.5 Deliberately divergent *(observational exercise)*

## Chapter 7

- [7.1 Spot the unsafe variable](solutions/ch07/ex1.md)
- [7.2 Spot the type error](solutions/ch07/ex2.md)
- [7.3 Fix the unsafe rule](solutions/ch07/ex3.dl)
- [7.4 Strict vs. loose](solutions/ch07/ex4.md)
- [7.5 Safety chain](solutions/ch07/ex5.dl)

## Chapter 8

- [8.1 Leaf nodes](solutions/ch08/ex1.dl)
- [8.2 Starter courses](solutions/ch08/ex2.dl)
- [8.3 Set difference](solutions/ch08/ex3.dl)
- [8.4 Unstratifiable program](solutions/ch08/ex4.md)
- [8.5 Emulating negation](solutions/ch08/ex5.md)

## Chapter 9

- [9.1 Simple counts](solutions/ch09/ex1.dl)
- [9.2 Ranks via filtering](solutions/ch09/ex2.dl)
- [9.3 Why aggregates can't recurse](solutions/ch09/ex3.md)
- 9.4 Read the SQL *(dry-run inspection)*
- [9.5 Multiple aggregates in one head](solutions/ch09/ex5.dl)

## Chapter 10

- [10.1 Library schema](solutions/ch10/ex1-schema/ex1-schema.dl)
- [10.2 Inline vs. factor](solutions/ch10/ex2.md)
- [10.3 Surprising answer](solutions/ch10/ex3-debug/ex3-debug.md)

## Chapter 11

- 11.1 Harder whodunit *(open-ended)*
- [11.2 Sum of three cubes](solutions/ch11/ex2.dl)
- [11.3 Who sits where](solutions/ch11/ex3-seating/ex3-seating.dl)

## Chapter 12

- 12.1 Trace the computation *(observational)*
- 12.2 Add a new block *(extension exercise — answer in chapter)*
- [12.3 Live variable analysis](solutions/ch12/ex3-live/ex3-live.dl)

## Chapter 13

- 13.1 Count reachable nodes *(straightforward from chapter 9 + 13 pattern)*
- 13.2 Unreachable pairs *(cross-product then filter)*
- 13.3 Path reconstruction *(open-ended)*

## Chapter 14

- 14.1 Status-code histogram *(straightforward from chapter 9 + `as_integer`)*
- 14.2 Largest JSON shape *(compose `length` with `as_integer` and a comparison)*
- 14.3 Pull a value out of an array *(two forms, both given in the exercise)*
- 14.4 Mixed-shape headers *(open-ended — the point is the trade-off)*

## Chapter 15

- 15.1 Booleans as a datatype *(two nullary constructors — the chapter's `bit` pattern)*
- 15.2 Binary trees *(non-linear; run on `--backend native`)*
- 15.3 Included vs. suppressed *(observational — run it both ways)*
- 15.4 Length by folding *(pattern-match `Nil` / `Cons`, as in the chapter's `append`)*

## Chapter 16

Every exercise here is a variation on the chapter's own `code/ch16/` programs;
the answer is the file you edit, so none ships separately.

- 16.1 Point it somewhere new *(extend `main.dl`)*
- 16.2 A data-file binding *(the answer is in the error you get without `as csv`)*
- 16.3 Filter, then reach *(chain two modules)*
- 16.4 Break the contract *(read the two boundary errors)*
- 16.5 A parameterised pair *(follow `option.dl`)*
- 16.6 Break a law *(observational — count which constraints fire)*
- 16.7 Watch sharing appear and disappear *(count views under `--dry-run`)*
- 16.8 A law that only the importer can state *(open-ended)*

## Chapter 17

- [17.1 Where does the sigil go?](solutions/ch17/ex1.dl)
- 17.2 Two readings of one graph *(prediction exercise -- run `code/ch17/purity.dl`)*
- [17.3 Find the draws](solutions/ch17/ex3.dl)
- 17.4 Why not just infer it? *(open-ended)*
- 17.5 Even/odd, revisited *(discussion -- see the chapter's note on one-negation cycles)*
