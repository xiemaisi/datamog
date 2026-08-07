# Introduction to Logic Programming with Datalog

[FLOLAC 2026](https://flolac.iis.sinica.edu.tw/zh/2026/)

## Predicates

Datalog programs are composed of zero or more _predicates_ and zero or more _queries_, each of which is really just a predicate with a special syntax.

Program execution consists of computing a _relation_, that is, a set of tuples of the same _arity_ (i.e., number of components), as the _denotation_ of each predicate. The denotations of the queries are the overall result of the program.

Predicates may be either _extensional_, _intensional_, or _built-in_.

### Extensional predicates

#### Syntax

Extensional predicates are declared, but not defined in the program itself. An extensional declaration like

```prolog
input predicate person(name: string, age: integer).
```

means that `person` is an extensional predicate of arity 2 (that is, it has 2 _arguments_, also called columns), the first of which is a string and the second an integer. The argument _names_ in extensional declarations are just for readability and do not have any semantic meaning.

#### Semantics

The denotation of an extensional predicate is provided at the start of program execution, for example as a table in a database or a CSV file. Each tuple in the relation must have the correct arity and be of the correct type. So, for `person` as declared above we could supply a database table with two columns as its relation, with the first column containing strings and the second integers. The denotation of an extensional predicate is always finite.

### Intensional predicates

#### Syntax

Intensional predicates are defined by one or more _rules_ expressed as _Horn clauses_ such as this one:

```prolog
same_age(Person1, Person2) :- person(Person1, Age), person(Person2, Age),
                              Person1 <> Person2.
```

A Horn clause consists of a _head atom_ and zero or more _body literals_.

The head atom (`same_age(Person1, Person2)` in our example) specifies the name of the predicate (`same_age`) and its arguments (here the variables `Person1` and `Person2`). Predicate names are lower-case, while variables are upper-case.

The body is a comma-separated list of _literals_. An _atom_ is either a _predicate atom_ — a predicate applied to arguments, such as `person(Person1, Age)` — or a _built-in atom_, such as `Age1 < Age2` or `Person1 <> Person2`. A _literal_ is an atom or a _negated atom_ (such as `not same_age(Person1, Person2)`).

Arguments to atoms (either in the head or the body) can be variables, constants (such as string or number literals) or more complex expressions built using arithmetic or string operators.

The argument to an atom can also be the special _don't-care_ variable `_`.

If the body is empty, it is omitted as in this example:

```prolog
nat(0).
```

Such a rule with an empty body is called a _fact_. The same intensional predicate can have a mixture of rules with and without bodies. All of the rules defining a given predicate must agree on its arity.

#### Semantics

The denotation of an intensional predicate is the smallest relation that satisfies the logical interpretation of all of the predicate's rules:

  - The body of a rule is viewed as a conjunction, existentially quantified over all variables that appear in the body but not the head.
  - The rule itself is viewed as an implication from the body to the head, universally quantified over all variables that appear in the head.

So for example the logical interpretation of the `same_age` rule from above is $$\forall \mathit{Person1}, \mathit{Person2}. (\exists \mathit{Age}. \mathtt{person}(\mathit{Person1}, \mathit{Age}) \land \mathtt{person}(\mathit{Person2}, \mathit{Age}) \land \\ \mathit{Person1} \ne \mathit{Person2}) \to \mathtt{same\_age}(\mathit{Person1}, \mathit{Person2})$$

Each occurrence of `_` is logically interpreted as a different variable, so two occurrences of `_` do not have to refer to the same value. For example, the rule body `p(X, _), q(X, _)` is interpreted as $\exists V_1, V_2. \mathtt{p}(X, V_1) \land \mathtt{q}(X, V_2)$.

Furthermore, `_` is scoped as tightly as possible: a negated literal `not p(X, _)` is logically interpreted as $\neg \exists V. \mathtt{p}(X, V)$, and not $\exists V.\neg \mathtt{p}(X, V)$.

Note that the order of literals in the body of a rule does not matter. However, each rule must be _safe_: every variable that appears in the head, in a negated predicate atom, or inside a compound expression (such as `X + 1`) must be _bound_. Variables are initially bound only by positive ordinary predicate calls, i.e., unnegated calls to extensional or intensional predicates, and by range atoms (`N in [1..9]`, which binds `N` to each integer in the range). Built-in comparisons such as `X < Y` or `X <> Y`, and negated atoms such as `not p(X)`, are filters: they do not bind any variable. In addition, an equality may bind a bare variable on one side if all variables on the other side are already bound. (This is symmetric: `X = Y + 1` and `Y + 1 = X` both bind `X`, provided `Y` is bound.) These rules are applied repeatedly until no further variables become bound, so that an equality can bind a variable only once the variables it depends on have themselves been established as bound.

### Built-in predicates

#### Syntax

Built-in predicates are neither declared nor defined in the program, but come predefined. The built-in comparison predicates are equality (`=`), disequality (`<>`), and the orderings `<`, `<=`, `>`, and `>=`. There is also the range atom `X in [lo..hi]`, which binds `X` to each integer from `lo` to `hi` when `X` is not already bound, and filters otherwise. For example, `Person1 = Person2`, `Person1 <> Person2`, and `Age1 < Age2` are all built-in atoms.

The expressions that appear as arguments (in atoms, comparisons, and rule heads) are built from constants and variables using arithmetic operators (`+`, `-`, `*`, `/`, and `%` for modulo) and string operators (such as concatenation), together with a library of built-in functions (for example `length`, `abs`, and `sqrt`). Division or modulo by zero, and other out-of-domain operations, yield the special value `null`.

#### Semantics

Each built-in predicate has its own special denotation that is the same for every program and does not depend on the denotation of other predicates in the program. For example, the denotation of the equality predicate is the (infinite) set of tuples `(v, v)` for every value `v`, and the semantics of the less-than built-in predicate is the (infinite) set of tuples `(x, y)` of numbers `x` and `y` such that `x` is numerically less than `y`.

### Queries

#### Syntax

A query has the same form as a rule body: a comma-separated list of one or more literals (predicate atoms, negated atoms, or built-in atoms), as in `?- same_age("Tim", P).` or `?- prime(N), even(N).`.

#### Semantics

The denotation of a query is the set of assignments to the named variables appearing in its body that simultaneously satisfy every literal. The don't-care variable `_` is not part of the output, and each occurrence is treated independently as above. Equivalently, a query is an implicit non-recursive predicate whose head contains the distinct named variables in the query body, in order of first occurrence. If a query contains no named variables, its denotation is either the singleton relation containing the empty tuple (the query succeeds) or the empty relation (the query fails).

## A first example

The pieces above are already enough to write a complete program. Suppose the denotation of the extensional predicate `person` is supplied as the following table:

| `name` | `age` |
| --- | --- |
| `"Alice"` | `30` |
| `"Bob"` | `15` |
| `"Carol"` | `17` |
| `"Dave"` | `42` |

A single non-recursive rule picks out the adults, and a query asks for them:

```prolog
input predicate person(name: string, age: integer).

adult(Name) :- person(Name, Age), Age >= 18.

?- adult(Name).
```

To evaluate `adult`, we consider every assignment to `Name` and `Age` that makes the body atom `person(Name, Age)` true — one per row of the table — and keep those that also satisfy the built-in literal `Age >= 18`. This rules out Bob and Carol. Projecting the surviving assignments onto the head variable `Name`, the denotation of `adult` is

$$\{\,(\texttt{"Alice"}),\ (\texttt{"Dave"})\,\}.$$

Since the query `?- adult(Name).` is just the predicate `adult` under another name, this set is also the program's output. The rest of this document explains how denotations like this one are computed in general, including the harder case where rules are recursive.

## Recursion

Intensional predicates may be defined _recursively_, i.e., the body of a rule for some predicate `p` can refer to `p` itself, or to some other predicate `q` that in turn refers to `p`.

For example, the following intensional predicate `reachable` is defined recursively as the transitive closure of a predicate `edge`, anchored at `"origin"`:

```prolog
reachable(X) :- edge("origin", X).
reachable(Y) :- reachable(X), edge(X, Y).
```

Negation must be _stratified_. A program is stratified if its predicates can be assigned to layers, or _strata_, such that positive dependencies point to the same or a lower stratum, while negative dependencies point to a strictly lower stratum. Equivalently, the predicate dependency graph must not contain a cycle that goes through a negated predicate call. (Datamog relaxes this slightly: a cycle through an *even* number of negations is accepted if the program says which side of it is the maximal one. That is beyond this course; see spec §4.3.) While the literals within a single rule body may be written in any order without changing its meaning, stratification imposes an order *across* predicates: each predicate's denotation must be fully determined before any negation of it is evaluated.

For example, this predicate `p` is not stratified, and hence invalid:

```prolog
p(X) :- u(X), not p(X).
```

Indirect self-references through other predicates under negation are also not allowed:

```prolog
p(X) :- u(X), not q(X).
q(X) :- u(X), not p(X).
```

Stratification ensures that the program has a well-defined _stratified model_. When no negation is involved this is simply the _least fixpoint_ of the predicate's rules. In the presence of stratified negation, evaluation proceeds one stratum at a time: predicates in lower strata are computed first, and each higher stratum is then computed as a least fixpoint while treating the lower-stratum denotations as fixed.

## Evaluation

> We use the following program as our running example:
>
> ```prolog
> input predicate number(n: integer).
>
> even(0).
> even(N) :- number(N), odd(N - 1).
> odd(N) :- number(N), even(N - 1).
>
> divides(P, Q) :- number(P), P > 0, number(N), Q = P * N.
> properly_divides(P, Q) :- divides(P, Q), P <> Q.
> composite(N) :- properly_divides(D, N), D <> 1.
> prime(N) :- number(N), N > 1, not composite(N).
>
> ?- prime(N), even(N).
> ```

Given the denotations of all extensional predicates, the denotation of all intensional predicates can be computed by _bottom-up evaluation_.

> For our example, assume that the denotation of `number` is the set $\{(0), (1), \ldots, (10)\}$ of 1-tuples wrapping the numbers zero to ten.

First, all intensional predicates are partitioned into _strongly connected components_ (SCC), that is, groups of predicates that recursively refer to each other. In particular, a predicate that is non-recursive or only recursive with itself forms an SCC of size 1, and two predicates that are defined in terms of each other form an SCC of size 2, but in general SCCs can be arbitrarily large.

> In our example, we have four SCCs of size 1, each containing one of the four non-recursive predicates `divides`, `properly_divides`, `composite` and `prime`, and one SCC of size 2 containing the predicates `even` and `odd`, which are mutually recursive.

Second, these SCCs are ordered in such a way that all predicates in an SCC only refer to other intensional predicates in the same SCC or earlier/lower SCCs. In particular, there is at least one "bottom-most" SCC that only refers to extensional predicates or built-ins.

> Here is an ordering for our example:
>
> ```mermaid
> graph TD
>   subgraph S1 ["S<sub>1</sub>: divides"]
>     divides
>   end
>
>   subgraph S2 ["S<sub>2</sub>: properly_divides"]
>     properly_divides
>   end
>
>   subgraph S3 ["S<sub>3</sub>: composite"]
>     composite
>   end
>
>   subgraph S4 ["S<sub>4</sub>: prime"]
>     prime
>   end
>
>   S4 --> S3
>   S3 --> S2
>   S2 --> S1
>
>   subgraph eo ["S<sub>5</sub>: even / odd"]
>     direction LR
>     even --> odd
>     odd --> even
>   end
> ```
>
> This ordering is not unique. The arrows above record the dependencies that constrain it: `prime` must come after `composite`, and so on down to `divides`, which (like `even`/`odd`) refers only to the extensional predicate `number`. The `even`/`odd` SCC has no dependency on the others at all, so it could equally well be evaluated first; we have simply numbered it last here.

Third, each SCC is evaluated on its own in order from bottom up. This means that by the time we get to SCC $n+1$ we have already computed the denotation of all predicates in SCCs $1, \ldots, n$. If this SCC is non-recursive and hence only consists of a single predicate, we compute its denotation by finding all assignments of values to its variables that satisfy the body of any of its rules, relying on the already-known denotations for extensional predicates and intensional predicates from lower SCCs for evaluating predicate calls.

> In our example, we begin by evaluating $S_1$, which contains the single predicate `divides` with the single rule
>
> ```prolog
> divides(P, Q) :- number(P), P > 0, number(N), Q = P * N.
> ```
>
> Since we already know the denotation of `number`, we can find all possible values of `P` ($1, \ldots, 10$, since the literal `P > 0` rules out $P = 0$) and `N` ($0, \ldots, 10$). This gives us 110 choices for `P` and `N`: the pairs $(1, 0)$, $(1, 1)$, and so on all the way up to $(10, 10)$. For each of these pairs $(P, N)$ we compute $Q = P * N$, and the denotation of `divides` is the set of all pairs $(P, Q)$ obtained in this way. (Note that $N = 0$ gives $Q = 0$, so every positive number "divides" zero here; this artifact is harmless, as it does not affect the primes we ultimately compute.) This finishes our evaluation of $S_1$.
>
> Next, we evaluate $S_2$, $S_3$, and $S_4$ in the same way, obtaining denotations for `properly_divides`, `composite`, and `prime`.

For recursive SCCs, we can use _naive evaluation_: initially, each predicate in the SCC is assigned an empty temporary denotation. Then we start an iteration where in every iteration we evaluate predicates the same way as we did for non-recursive predicates, using the temporary denotation for predicates in the same SCC. Stratification guarantees that predicates in the same SCC never refer to each other negatively, so each rule can only derive more tuples as its inputs grow. The new temporary denotation we obtain for each predicate is therefore a superset of, or the same as, the previous temporary denotation. We keep updating temporary denotations in every iteration until we reach a _fixpoint_, i.e., the denotations no longer change. Since the iteration starts from the empty relations and grows monotonically, the result is the _least fixpoint_ for each predicate in the SCC (by the Kleene fixpoint theorem), which is our final denotation.

> In our example, there is a single recursive SCC $S_5$ containing predicates `even` and `odd`.
>
> The following table shows how the iterative evaluation of these two predicates proceeds:
>
> Iteration | `even` | `odd`
> --: | --- | ---
> -- | $\emptyset$ | $\emptyset$
> 1 | $\{(0)\}$ | $\emptyset$
> 2 | $\{(0)\}$ | $\{(1)\}$
> 3 | $\{(0), (2)\}$ | $\{(1)\}$
> ... | $\ldots$ | $\ldots$
> 11 | $\{(0), (2), \ldots, (10)\}$ | $\{(1), (3), \ldots, (9)\}$
> 12 | $\{(0), (2), \ldots, (10)\}$ | $\{(1), (3), \ldots, (9)\}$
>
> Since the temporary denotations of `even` and `odd` have not changed in iteration 12, this means that we have reached the fixpoint and found the desired denotations.

Once all intensional predicates have been evaluated, we finally evaluate the queries in the same way (since a query is just a non-recursive predicate), and output their denotation as the final result.

> In our example, we consult the denotations of `prime` and `even` to determine that the final output is `N = 2`.

### Finiteness

The safety requirement ensures that the denotation of each non-recursive intensional predicate is finite. For recursive predicates, the key question is whether recursive cycles can generate unboundedly many fresh values. A simple sufficient condition for finiteness is that recursive cycles only pass around values drawn from the finite input relations and constants already present in the program. Recursive arithmetic or string operations may still terminate when their results are bounded by other conditions, but safety alone does not guarantee this.

For example, the following predicate definition is safe:

```prolog
nat(0).
nat(X + 1) :- nat(X).
```

However, the second rule produces a fresh value (i.e., the next-higher natural number) in a recursive cycle, so the denotation of `nat` is infinite, and attempting to evaluate it iteratively will not terminate.

## Aggregates

One or more arguments of an intensional predicate may be _aggregates_, which combine the values appearing in that position across a whole group of tuples into a single result (for example by summing or counting them). For example,

```prolog
prop_div_sum(N, sum(D)) :- properly_divides(D, N).
```

computes the sum of all proper divisors $D$ of a number $N$.

This is done as follows. Assume we have already computed the denotation $\mathbb{D}$ of `properly_divides` as described above, which contains among others the following tuples: $$\mathbb{D} \supseteq \{ (1, 2), (1, 3), \ldots, (1, 6), \ldots, (2, 4), (2, 6), \ldots, (3, 6), \ldots \}$$

Now we _group_ that denotation by its second component, that is, for each value of $n$ we collect the set of all $d$ such that $(d, n)$ is in $\mathbb{D}$: $$\mathbb{G}(n) = \{ d \mid (d, n) \in \mathbb{D} \}$$

So, for example $\mathbb{G}(6) = \{ 1, 2, 3 \}$.

Finally, the denotation of `prop_div_sum` is computed by summing over all values in $\mathbb{G}(n)$ for each $n$ for which the group $\mathbb{G}(n)$ is non-empty: $$\mathbb{D}' = \{ (n, \sum_{d\in\mathbb{G}(n)} d) \mid \mathbb{G}(n) \neq \emptyset \}$$

This gives us, among others, $$\mathbb{D}' \supseteq \{ (2, 1), (3, 1), (4, 3), (5, 1), (6, 6), \ldots \}$$

Besides `sum`, the available aggregate functions are `count` (the size of the group; `count(*)` counts rows), `avg`, `min`, `max`, `concat` (joining strings), and `list` (collecting the grouped values into an array). A head may use more than one aggregate, in which case they all share the same grouping.

A predicate defined using aggregates cannot be recursive.

## Metatheory

### Complexity

In this section, _pure Datalog_ means function-free Datalog over finite extensional input: rule arguments are variables or constants, and rules do not use arithmetic, string operations, or other built-in functions that can manufacture fresh values. For any fixed pure Datalog program, the denotations of all predicates can be computed in time polynomial in the size of the denotations of the extensional predicates. In particular:

  - Pure Datalog programs always terminate.
  - Pure Datalog is not Turing complete.

Note that this is a statement about _data complexity_: the degree of the polynomial depends on the program. If the program size is counted as part of the input as well (so-called _combined complexity_), evaluation can take time exponential in the size of the program.

Adding unrestricted arithmetic or string operations, especially inside recursion, makes Datalog Turing complete, and programs are no longer guaranteed to terminate.

### Decidability

Predicate containment (that is, whether the denotation of one predicate is a superset of the denotation of some other predicate for _every_ possible extensional input) is undecidable for pure Datalog, even without negation.

If negation is allowed, it becomes undecidable whether a program can ever produce any output at all, that is, whether there is _any_ choice of extensional input for which some query is non-empty. For a single, concrete input the question is of course decidable, since we can just run the program; what is undecidable is settling it for all possible inputs at once.

## Relational Algebra

Datalog can be translated to Relational Algebra, a variant of first-order logic without variable names, enriched with least fixpoints.

Relational algebra expressions operate on entire relations, represented by capital letters like $R$, $S$, $T$.

For a relation $R$ of arity $n$, a _column expression_ $e$ over $R$ is an expression involving arithmetic or string expressions over constants and _column references_ $\#i$ referring to column $i$ of $R$.

A relation may either be defined externally (like extensional predicates in Datalog), or by a definition of the form $I := \mathcal{E}$, where $\mathcal{E}$ is a _relational algebra expression_ built up using one of the following operators:

- $\{ (v_{1,1}, \ldots, v_{1,n}), \ldots, (v_{m,1}, \ldots, v_{m,n}) \}$: explicit set of tuples
- $R$: a relation
- $\pi_{e_1,\ldots,e_m}(\mathcal{E})$: projection of $\mathcal{E}$ onto column expressions $e_1, \ldots, e_m$ over $\mathcal{E}$
- $\sigma_{\varphi}(\mathcal{E})$: filter $\mathcal{E}$ to the tuples satisfying $\varphi$, a Boolean combination of comparisons of column expressions over $\mathcal{E}$
- $\mathcal{E}\cup\mathcal{E}'$: set union
- $\mathcal{E}\cap\mathcal{E}'$: set intersection
- $\mathcal{E}\times\mathcal{E}'$: Cartesian product
- $\mathcal{E}\setminus\mathcal{E}'$: set difference
- $\gamma_{\#c_1:\mathrm{agg}_1,\ldots,\#c_m:\mathrm{agg}_m}(\mathcal{E})$: aggregate $\mathcal{E}$ by applying $\mathrm{agg}_j$ to column $\#c_j$, grouped by the remaining columns of $\mathcal{E}$. The result has the grouping columns first (in their original order), followed by the aggregate results $\mathrm{agg}_1, \ldots, \mathrm{agg}_m$ in the order listed.

The non-recursive predicate from our running example above can be translated as follows:

$$
\begin{aligned}
\mathtt{divides}\           &:= \pi_{\#1,\, \#1 \cdot \#2}(\sigma_{\#1 > 0}(\mathtt{number} \times \mathtt{number})) \\
\mathtt{properly\_divides}\ &:= \sigma_{\#1 \neq \#2}(\mathtt{divides}) \\
\mathtt{composite}\         &:= \pi_{\#2}(\sigma_{\#1 \neq 1}(\mathtt{properly\_divides})) \\
\mathtt{prime}\             &:= \sigma_{\#1 > 1}(\mathtt{number}) \setminus \mathtt{composite}.
\end{aligned}
$$

The mutually recursive `even` and `odd` predicates translate to a pair of equations whose joint least fixpoint is obtained by iterating from $\mathtt{even} = \mathtt{odd} = \emptyset$:

$$
\begin{aligned}
\mathtt{even}\ &:= \{(0)\} \cup \pi_{\#1}(\sigma_{\#2 = \#1 - 1}(\mathtt{number} \times \mathtt{odd})) \\
\mathtt{odd}\  &:= \pi_{\#1}(\sigma_{\#2 = \#1 - 1}(\mathtt{number} \times \mathtt{even})).
\end{aligned}
$$

The query `?- prime(N), even(N).` is translated to $\mathtt{prime} \cap \mathtt{even}$.

Finally, the aggregate predicate `prop_div_sum` from the previous section becomes

$$\mathtt{prop\_div\_sum} := \gamma_{\#1 : \mathrm{sum}}(\mathtt{properly\_divides}),$$

with the un-aggregated column $\#2$ (the number $N$) serving implicitly as the grouping key. By the convention above, the grouping column comes first and the aggregate second, so the result has the shape $(N, \mathrm{sum})$, matching the head `prop_div_sum(N, sum(D))`.
