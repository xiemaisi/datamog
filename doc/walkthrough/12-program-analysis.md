# Chapter 12 — Case study: program analysis

Datalog's biggest industrial user base is in **static program
analysis**. Frameworks like [Soufflé][soufflé], [LogicBlox][lb],
and [Doop][doop] express analyses as Datalog programs and compile
them to native code — turning what would be thousands of lines of
hand-written analysis in C++ into a few hundred lines of
declarative rules.

This chapter walks through one of the classic analyses, **reaching
definitions**, as expressed in
[`packages/cli/examples/reaching-defs/reaching-defs.dl`](../../packages/cli/examples/reaching-defs/reaching-defs.dl).
The example is a complete, runnable Datalog program that captures
the textbook data-flow equations directly — no auxiliary
scaffolding, no worklists, no abstract interpretation boilerplate.
It reads its CFG from `cfg.csv` and marks `reaches` an
`output predicate`; the version below inlines the same edges as
facts so it stands alone.

[soufflé]: https://souffle-lang.github.io/
[lb]: https://en.wikipedia.org/wiki/LogicBlox
[doop]: https://bitbucket.org/yanniss/doop/

## The analysis

In compilation, a **reaching definition** at program point *P* is
an assignment of the form `x = e` that might have produced the
current value of `x` on some path to *P*. The classic data-flow
equations say:

- A definition **generated** in a block "reaches" the exit of that
  block (unless it's later killed).
- A definition reaches the entry of a block if it reaches the exit
  of some predecessor block *and is not killed along the way*.

This is a forward "may" analysis — computed bottom-up over the
control-flow graph, accumulating a set of definitions that could
reach each program point.

## The Datalog version

```prolog
# Control-flow graph
cfg("start", "b1").
cfg("b1", "b2").
cfg("b1", "b3").
cfg("b2", "b4").
cfg("b3", "b4").
cfg("b4", "b1").
cfg("b4", "end").

# Definitions generated at each block
gen("b2", "d1").
gen("b4", "d2").

# Definitions killed at each block
kill("b4", "d1").
kill("b2", "d2").

# A definition reaches a block if it is generated there, or it
# reaches a predecessor and is not killed there.
reaches(D, U) :- gen(U, D).
reaches(D, V) :- cfg(U, V), reaches(D, U), not kill(U, D).

?- reaches(Def, Block).
```

Three sets of ground facts — the CFG (`cfg`) and the program's
`gen` and `kill` sets — and one intensional predicate `reaches` with
two rules — one base case (definitions reach the block where they're
generated) and one recursive propagation step.

That's it. Six lines of actual logic. No worklist code, no
termination condition, no iteration counter. Datalog handles all
of that as part of its fixed-point semantics.

**[Open this program in the playground →](https://xiemaisi.github.io/datamog/#p=%23%20Control-flow%20graph%0Acfg(%22start%22%2C%20%22b1%22).%0Acfg(%22b1%22%2C%20%22b2%22).%0Acfg(%22b1%22%2C%20%22b3%22).%0Acfg(%22b2%22%2C%20%22b4%22).%0Acfg(%22b3%22%2C%20%22b4%22).%0Acfg(%22b4%22%2C%20%22b1%22).%0Acfg(%22b4%22%2C%20%22end%22).%0A%0A%23%20Definitions%20generated%20at%20each%20block%0Agen(%22b2%22%2C%20%22d1%22).%0Agen(%22b4%22%2C%20%22d2%22).%0A%0A%23%20Definitions%20killed%20at%20each%20block%0Akill(%22b4%22%2C%20%22d1%22).%0Akill(%22b2%22%2C%20%22d2%22).%0A%0A%23%20A%20definition%20reaches%20a%20block%20if%20it%20is%20generated%20there%2C%20or%20it%0A%23%20reaches%20a%20predecessor%20and%20is%20not%20killed%20there.%0Areaches(D%2C%20U)%20%3A-%20gen(U%2C%20D).%0Areaches(D%2C%20V)%20%3A-%20cfg(U%2C%20V)%2C%20reaches(D%2C%20U)%2C%20not%20kill(U%2C%20D).%0A%0A%3F-%20reaches(Def%2C%20Block).%0A)**

## What Datalog is doing for us

Comparing to the imperative version of the same analysis (a
worklist-based BFS over the CFG, maintaining a `reaches_in` and
`reaches_out` set per block, iterating until sets stabilise), the
Datalog version elides:

- **The worklist and termination check.** Datalog's seminaive
  evaluation handles this automatically — see Chapter 5.
- **The "is this a `gen` or a propagation" case analysis.** Each
  rule expresses one of the two cases; multiple rules union
  naturally.
- **The "not killed along the way" handling.** Stratified
  negation (Chapter 8) lets us express it in-line; the fact that
  `kill` is separately stratified means the analyzer doesn't get
  confused about *when* to evaluate the negation.
- **The fixed-point orchestration.** Pure recursion, linear
  recursive step, standard pattern.

The full reaching-definitions machinery reduces to "what you
naturally wrote in pseudo-code" — no translation step.

## Why the pattern generalises

Reaching definitions is one of a whole family of **data-flow
analyses**:

- *Live variables* (backwards version of reaching definitions).
- *Available expressions* (must-reach instead of may-reach).
- *Very busy expressions*.
- *Copy propagation*.
- *Constant propagation* (trickier — needs values, not just
  reachability; lattice-height issues).

Every one of them follows the same "rules + recursion + optional
negation" skeleton. Industrial Soufflé programs scale this to
whole-program pointer analyses (Doop's main engine is ~1000 lines
of Datalog) and security analyses (various taint-tracking systems).

The reason the style works at scale is that **declarative
recursion over relations** is exactly what data-flow analysis
*is*, mathematically. Imperative implementations have historically
buried that identity under layers of bookkeeping; Datalog
surfaces it.

## Extending the analysis

Suppose we want to mark a definition as "tainted" (perhaps it
came from user input) and propagate that:

```prolog
tainted_at_source("d2").

tainted_def(D) :- tainted_at_source(D).
tainted_reaches(Block, D) :- reaches(D, Block), tainted_def(D).
```

Two rules, one reading from the existing `reaches` IDB. No change
to the analysis core, no re-plumbing of the worklist. That's the
payoff of composability.

Or add "used" blocks and find every `(def, use)` pair where the
definition actually reaches a use:

```prolog
input predicate use(block: string, defname: string).

def_use(Block, D) :- use(Block, D), reaches(D, Block).
```

Again, one rule on top of the existing pipeline.

## Recap

- Many classical program analyses — reaching definitions, live
  variables, constant propagation, pointer analysis — reduce to
  "fixed-point over a few recursive rules".
- Datalog's language features (recursion, negation,
  stratification) match the mathematical structure of these
  analyses directly.
- Industrial frameworks (Soufflé, LogicBlox, Doop) compile
  Datalog analyses to efficient native code, making the
  declarative form the *source* of production systems.

## Exercises

### Exercise 12.1 — Trace the computation ★

Run
[`packages/cli/examples/reaching-defs/reaching-defs.dl`](../../packages/cli/examples/reaching-defs/reaching-defs.dl).
with `reaches` as the output (`datamog reaching-defs.dl reaches`;
its default query prints the CFG instead).
For each block, list which definitions reach it. Cross-check
against the CFG by tracing on paper.

### Exercise 12.2 — Add a new block ★★

Extend the example with a new block `b5` between `b3` and `b4`,
which generates a new definition `d3`. What's the minimum change
needed to the Datalog program? (Answer: add `cfg` rows and a
`gen` row — no rule change.)

### Exercise 12.3 — Live-variable analysis ★★★

Live-variable analysis is the *dual* of reaching definitions:
instead of flowing forward from definitions, it flows backward
from uses. A variable is "live" at a program point if its value
could be used along some path to the exit.

Write a `live(Block, Var)` predicate analogous to `reaches`. You'll
need `use(block, var)` (variable used in the block) and `kill(block,
var)` (variable reassigned in the block). The recursion goes
*backwards* along the CFG edges. Sample data and starter in
[`code/ch12/ex3-live/`](code/ch12/ex3-live/).

---

Next: **[Chapter 13 — Case study: graph algorithms](13-graphs.md)** —
closures, shortest paths, bills of materials. The other big family of
problems Datalog handles with unusual grace.
