# Prove a theorem

> Builds on classical propositional logic: truth tables, conjunctive normal
> form, and the [Tseitin transformation](https://en.wikipedia.org/wiki/Tseytin_transformation).

Queen Diana's court logicians keep arguing. One insists a proposed decree is
"obviously always true"; another disagrees. The Queen, tired of the noise,
wants the dispute settled mechanically: given a logical statement, decide
whether it is a **theorem** — true under every assignment of true/false to its
variables — and, when it is not, produce a counterexample that shows why.

You will build a propositional theorem prover in Datamog. The trick is to
build it **back to front**, in three steps:

1. an engine that decides a formula already in a normal form;
2. the conversion of a formula into that normal form;
3. the parser that reads the formula from text.

Each step turns the previous step's *given* data (an extensional predicate)
into *computed* data (an intensional one). That migration — pushing the
boundary of "what is supplied from outside" one layer further back — is the
heart of how Datalog programs grow, and it is the real lesson of this chapter.

> **Heads-up: non-linear recursion.** Steps 2 and 3 contain rules that refer to
> a recursive relation *twice* in the same body (converting a binary connective
> needs the results for *both* its children). That is non-linear recursion,
> which the SQL backends reject. Run these programs on an in-memory interpreter:
>
> ```bash
> bun run datamog --backend seminaive <file.dl>
> ```

## Part 1: decide a formula in CNF

> Complete solution: `packages/cli/examples/cnf-falsifiability/`

A formula in **conjunctive normal form** (CNF) is an *and* of clauses, each
clause an *or* of literals, each literal a variable or its negation. The key
fact:

> a formula is a theorem **if and only if** its CNF is **not falsifiable** —
> no assignment makes any clause entirely false.

So start by assuming the CNF is given as facts and just look for a falsifying
assignment. Represent it with `clause_lit(Clause, Var, Polarity)` (polarity
`1` positive, `0` negative) and `nvars(N)` for the variable count `0 .. N-1`.

With `N` variables there are `2^N` assignments, so enumerate them as the
integers `0 .. 2^N - 1` and read bit `V` of `A` as the value of variable `V`.
The bitwise operators express this directly: `1 << N` is `2^N`, and
`(A >> V) & 1` extracts bit `V`:

```prolog
var(V) :- nvars(N), V in [0 .. N - 1].
assignment(A) :- nvars(N), A in [0 .. (1 << N) - 1].
eval(A, V, (A >> V) & 1) :- assignment(A), var(V).
```

A clause is *falsified* by `A` when none of its literals is satisfied — a
textbook use of **stratified negation**:

```prolog
clause(C)       :- clause_lit(C, _, _).
satisfies(A, C) :- clause_lit(C, V, Pol), eval(A, V, Pol).
falsifies(A, C) :- assignment(A), clause(C), not satisfies(A, C).

falsifiable() :- falsifies(_, _).
theorem()     :- nvars(_), not falsifiable().

counterexample(A, V, B) :- falsifies(A, C), eval(A, V, B).
```

Here `falsifiable` and `theorem` are **nullary** (0-arity) predicates — boolean
propositions that either hold or not — so the ground query `?- theorem().`
prints `yes` or `no`.

Notice there is **no recursion** here: enumeration plus negation is enough, so
this part runs on every backend, the SQL ones included.

## Part 2: derive the CNF from a syntax tree

> Complete solution: `packages/cli/examples/cnf-from-ast/`

Now stop handing the engine a CNF. Instead hand it the formula's **abstract
syntax tree** and *derive* `clause_lit` and `nvars` with rules — the two
predicates that were extensional in Part 1 become intensional. We represent
the tree relationally:

```prolog
node(Id, Kind)             # Kind in {var, not, and, or, imp}
node_var(Id, Name)         # the variable name, for a var leaf
node_child(Id, Pos, Kid)   # child at position Pos (0, or 0/1 for binary)
root(Id)
```

CNF conversion has a famous Datalog snag: it *invents* clauses (distributing
`or` over `and` creates new ones), but Datalog cannot mint fresh names. The
fix is to name a clause by its **structure**: a variable's unit clause is
`["lit", N, Pol]`, and a clause built by distributing `C` and `D` is
`["m", C, D]`. Identical structures collapse to the same id automatically,
because values compare by their canonical form.

We compute, for every node, the clauses of the node *and* of its negation at
once (the "polarity trick"), so negation is just a swap, with no separate
negation-normal-form pass and no rewriting of implication:

```prolog
pos(N, ["lit", N, 1]) :- node(N, "var").
neg(N, ["lit", N, 0]) :- node(N, "var").

pos(N, C) :- node(N, "not"), node_child(N, 0, K), neg(K, C).   # swap
neg(N, C) :- node(N, "not"), node_child(N, 0, K), pos(K, C).

# and: pos is the union of the children's clauses; neg distributes
pos(N, C) :- node(N, "and"), node_child(N, 0, L), pos(L, C).
pos(N, C) :- node(N, "and"), node_child(N, 1, R), pos(R, C).
neg(N, ["m", C, D]) :- node(N, "and"), node_child(N, 0, L), node_child(N, 1, R),
                       neg(L, C), neg(R, D).
```

That last rule names a clause two ways at once. Because Datalog cannot take a
value *apart*, we record the parent pair as `merge(C, D)` at the moment we build
the id, then read each merged clause's literals back from its parents:

```prolog
clause_lit_named(["m", C, D], V, P) :- merge(C, D), clause_lit_named(C, V, P).
clause_lit_named(["m", C, D], V, P) :- merge(C, D), clause_lit_named(D, V, P).
```

Finally we rank the variable names into the dense `0 .. N-1` indices the engine
needs (a `count` aggregate does the ranking), keep just the root's clauses, and
hand them to the Part 1 engine unchanged.

### A second way: the Tseitin encoding

> Complete solution: `packages/cli/examples/cnf-tseitin/`

The naive conversion above is faithful but can blow up exponentially. The
**Tseitin transformation** trades differently: it invents one fresh variable
per subformula and emits a few *local* clauses per connective. The result is
only *equisatisfiable*, not equivalent, so the question flips — to prove the
formula we **refute its negation**, asserting the root is false and searching
for a model. The engine becomes the dual of Part 1's (hunt for a satisfying
assignment instead of a falsifying clause). Because every clause is local, the
encoding uses no recursion and *translates* on every backend — a useful
contrast with the naive conversion, which the SQL backends reject outright.

## Part 3: parse the formula from text

> Complete solution: `packages/cli/examples/parse-to-cnf/`

One given remains: the syntax tree. Remove it too by **parsing** the tree out
of a plain string, so `node`/`node_child`/`root` become intensional and the
only extensional left is the source text.

The parser is a **chart parser** over character positions, in the style of
`examples/grammar`. A relation `x(F, T, Id)` means "nonterminal `x` spans
characters `F..T-1` and builds AST node `Id`", and operator precedence is
encoded by layering the nonterminals `pimp < por < pand < pnot < patom`:

```prolog
patom(F, F1, {"type": "var", "name": C}) :- varchar(F, C), F1 = F + 1.
patom(F, T, Id) :- char(F, "("), F1 = F + 1, pimp(F1, C, Id), char(C, ")"), T = C + 1.

pnot(F, T, Id) :- patom(F, T, Id).
pnot(F, T, {"type": "not", "args": [Id]}) :- char(F, "~"), F1 = F + 1, pnot(F1, T, Id).

pand(F, T, Id) :- pnot(F, T, Id).
pand(F, T, {"type": "and", "args": [L, R]}) :- pand(F, M, L), char(M, "&"), M1 = M + 1, pnot(M1, T, R).
# ... por and pimp follow the same shape

root(Id) :- pimp(0, N, Id), len(N).
```

The node ids are structural JSON objects, named by their shape just as the CNF
derivation named its clauses, so the parser's output plugs straight into Part 2. (A chart parser also finds partial
constituents that are not part of the whole-string parse; the example keeps
only the nodes reachable from the root, which is exactly the parse tree.)

Stacking all three parts gives the complete prover. The concrete syntax uses
single-character variables, `~ & | >` for not/and/or/implies, and `( )` to
group; `>` binds loosest and associates to the right. The example's `input.csv`
holds De Morgan's law `~(p&q)>(~p|~q)` under a column header `s`, so:

```bash
$ bun run datamog --backend seminaive parse-to-cnf.dl
# theorem = "yes"
```

A string went in; a proof came out. Try editing `input.csv` to a non-theorem
like `p>q` and you will get `theorem = "no"` with a counterexample instead.

## The pattern: push the boundary back

Every step did the same thing: it took a predicate that the previous step read
as **extensional** data and made it **intensional**, defined by rules. CNF →
derived from an AST → derived from a string. The downstream code never changed,
because in Datalog a predicate's *interface* is its name and arity, not how it
is populated — exactly like swapping a stored table for a view.

Along the way we met the techniques that let Datalog reach this far:

- **Datalog is a fixed-point engine.** Deciding a formula is searching for an
  assignment; deriving a CNF and parsing are least fixed points over structure.
- **Value invention by structure.** Datalog cannot gensym, so we name invented
  things (clauses, AST nodes) by their shape, and equal shapes coincide for
  free.
- **Linear vs non-linear recursion.** Combining two recursive results (CNF
  distribution, binary parse rules) is non-linear and needs an in-memory
  backend; the SQL backends accept only linear recursion.
- **Stratified negation and aggregates** express "no clause is satisfied" and
  the variable-index ranking.

## A second machine: proof search

Every prover above is **model search** — it hunts for an assignment that makes
the formula false. A cut-free **sequent calculus** answers the same question by
**proof search** — it hunts for a derivation. Same verdicts, opposite
philosophy: model theory versus proof theory. The complete solution is in
`packages/cli/examples/sequent-prover/`.

A sequent `Γ ⊢ Δ` reads "assuming all of Γ, prove one of Δ", and we prove φ by
deriving `⊢ φ`. Read bottom-up, each rule decomposes one connective into the
subformulas of its conclusion — the **subformula property** of cut-free proofs
— so the search space is finite and terminates. Every propositional rule is
invertible, so we decompose eagerly with no backtracking: a branch closes at an
**axiom** (a variable on both sides), and a sequent is provable when some
rule's premises are all provable.

The catch is the one we already know: a sequent is a *set* (of signed
formulas), and Datalog cannot build sets in a recursion without a forbidden
aggregate. So we reuse the structural-id trick — a sequent is a value id naming
its derivation, and its contents live in a membership relation
`mem(Seq, Side, Node)`. A rule builds a premise by *copying* the conclusion's
members except the principal, then adding the subformulas:

```prolog
mem(Prem, S2, N2) :- carry(S, Prem, PS, PN), mem(S, S2, N2), S2 <> PS.
mem(Prem, S2, N2) :- carry(S, Prem, PS, PN), mem(S, S2, N2), N2 <> PN.
```

Together the two rules keep every member except the exact principal pair
`(PS, PN)`. That `N2 <> PN` is disequality on `value` node ids — which works
because equality and inequality *are* defined on values (only ordering is not:
there is no total order on JSON that every backend agrees on).

The eight inference rules are themselves **data** — fact tables describing how
each connective decomposes on each side — driven by a few generic transition
rules, so adding a connective means adding rows, not rules. Provability is then
the classic **and-or fixpoint**:

```prolog
provable(S) :- axiom(S).                                       # a closed branch
provable(C) :- step1(C, P), provable(P).                       # one-premise rule
provable(C) :- step2(C, P1, P2), provable(P1), provable(P2).   # two-premise: AND
theorem() :- provable("init").
```

Counterexamples come for free: a fully decomposed branch that is *not* an axiom
is an open branch — a countermodel, with its left-hand variables true and
right-hand ones false — and the branch id even records the proof-search path
that exposed it. Combining two premises is non-linear recursion, so like the
CNF derivation this prover is native/seminaive only.

## What's next?

You have now seen Datamog used for everything from family trees to a working
theorem prover. To go deeper, run any example with `--dry-run` to see the SQL
it compiles to, or switch backends with `--backend native` / `--backend
seminaive` to watch the same program evaluated by a pure-TS interpreter instead
of SQLite.
