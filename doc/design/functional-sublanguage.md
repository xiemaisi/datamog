# Design proposal: a functional sub-language

Status: **proposal, step 1 implemented.** The conditional expression is in
(spec §2.6); it was always independent of the rest, and the ladder's own advice was
to build it regardless. User-defined functions and the proposed datatype syntax are unimplemented.
Existing rule-derived proof types and their contracts are separate features,
described in [constructor contracts](proof-signature-contracts.md). The four boundary decisions a
review raised are answered below; the datatype half stays deferred. Datamog already
has an implicit functional sub-language: the inline arithmetic, string and `value`
expressions of spec §2.6 and §2.9, plus the built-in registry in
`core/src/builtins.ts`. This doc asks whether to spin that out into a language
proper.

The recommendation is narrower than the question. Build user-defined recursive
functions over `value`, with a conditional expression and no pattern matching. The
algebraic-datatype half is written up here too, in
[Deferred: the datatype half](#deferred-the-datatype-half), because the corpus asks
for it, but it needs more thought and nothing below depends on it.

The motivating problem is real and is *not* the one you reach for first. It is not
ergonomics and it is not termination. It is that Datalog safety forces every
relation to be enumerable from below, and a function's parameters are inputs by
construction.

## The boundary decisions

Four questions affect the language boundary rather than a local lowering, so they
have to be answered before any of this is implementable. Three are settled here and
the fourth in [Termination](#termination). Settled on paper: none is validated by an
implementation.

### Signatures: declared for recursive functions, inferred for the rest

"Functions recurse over `value`" does not cover the array fold below, which needs
`value`, `integer` and a numeric accumulator in one signature. Rather than build
inference across recursive calls, split along a line that already exists:

```prolog
fun double(X) = X * 2.                                        # inlines, inferred
fun sum_from(L: value, I: integer, Acc: integer): integer? =  # recursive, declared
  Acc if I >= length(L) else sum_from(L, I + 1, Acc + as_integer(L[I])).
```

A non-recursive function is a macro, so the call site types it exactly as it types
the expression it expands into and no signature is needed. A recursive one must
declare its parameter and result types, which removes the fixed point over the call
graph entirely. The annotation syntax is the one stage 1 of
[`nullness-tracking.md`](./nullness-tracking.md) shipped: a `PrimitiveType` with an
optional `?`.

A `fun` is monomorphic, so a call whose argument does not fit its declared type is a
type error exactly as a builtin overload mismatch is. Polymorphism, if it is ever
wanted, is the monomorphising higher-order step at the end of the ladder rather than
an inference problem here.

A recursive function's result annotation **must** be nullable. The size budget can
yield NULL from non-null arguments, so a non-null result would be a contract the
evaluator cannot keep. Requiring `?` is "never `total`" made syntactic and checkable
at the declaration, which is also what settles the `{strict, total}` question: `total`
comes from the annotation, and `strict` is `false` for every user function, since
that direction only licenses refinement and giving it up is sound.

### Names: one flat uniqueness rule, no precedence

A raw `FunctionCall` already means one of three things: a builtin, an aggregate, or a
proof-constructor tag that `resolveCtor` maps to the predicate declaring it. User
functions would be a fourth. Rather than order four namespaces, forbid the overlap: a
`fun` name may not equal a builtin name, an aggregate name, or any constructor tag
declared in the program, checked where the function is declared. No precedence rule,
so there is nothing to remember and nothing to get subtly wrong.

### Modules: functions are file-private

`expandModule` freshens private predicate names with a `$` prefix and deliberately
does *not* rename constructors, because a constructor is qualified by its predicate
and so rides along when the predicate is renamed. A function has no such carrier, so
two imports that each define `helper` would collide. Hence:

- `expandModule` must freshen function names itself, with the same prefix.
- Functions are **not exportable**. A module exposing a computation exposes a
  predicate; there is no `fun` in an export list. That removes the selection and
  visibility design altogether.

One ordering constraint sits underneath this. `prepareElaborated` runs
`parseRaw → elaborate → postProcess`, so the elaborator sees the *raw* AST. Function
declarations must therefore survive `parseRaw` as their own node rather than being
lowered during post-processing, or the elaborator has nothing to freshen.

## The finding: safety is the constraint

Three separate contortions in the corpus have one root cause.

| Symptom | Where | What it is |
|---|---|---|
| `double(X, Y) :- Y = X * 2.` fails with `Unsafe variable 'X' in equality 'Y = ...'` | any reusable helper | `X` is a mode-input, and relations have no modes |
| `num_list` enumerates all 15 lists over `{1, 2}` up to length 3 in order to reverse one | `examples/list-ops` | `append(Nil(), B, B)` needs `B : num_list` to be safe |
| `expr`, `node` and `answer_node`: three separately maintained subterm closures | `examples/symbolic-differentiation` | `deriv(E, D) :- expr(E), ...` needs `E` bound by something |

Call the first row the **unsafe-helper gap**: there is no way to name a computation
over an argument the caller supplies. `double` is perfectly well-defined as a
function and rejected as a relation, because a relation must be enumerable and the
integers are not. Today you re-inline the expression at every call site, or invent a
bound for the argument so that the relation becomes finite.

The consequences are worse than verbosity. `list-ops` records that "a result longer
than the length cap has no matching proof and simply drops out", so `append` and
`reverse` return silently wrong answers outside the enumerated universe.
`symbolic-differentiation` records that merging two of its three closures makes the
program diverge, since the rules would differentiate their own output forever.

A function needs no universe, no closure and no range restriction, because its
argument is supplied by the caller. That is the whole argument, and it is not a
sugar argument.

## The second finding: proof terms are not a datatype

Proof-term constructors are match-only, and that is correct for them: a derivation
witness that witnesses nothing is meaningless. But they are the only constructor
mechanism in the language, so any program that has to *build* structure either
abandons them or works around them.

`symbolic-differentiation` abandons them, and says so in its header:

> Differentiation is the first program that has to *build* structure rather than
> take it apart: d(u*v) is a sum of two products that appear nowhere in the input.
> That rules out proof terms, whose constructors are match-only [...] The JSON
> `value` type has no such restriction.

So it hand-rolls `{"kind": "op", "op": "*", "l": ..., "r": ...}` and dispatches on
`E["kind"] = "op"`. No arity check, no exhaustiveness check, every node typed
`value`. That is a regression against a feature the language already has.

`sk-proof-terms` takes the other route and pays with a request protocol: a `want`
predicate, an `app` lookup rule, five bookkeeping rules, and a fixed point that
needs one round per level of nesting because "the outer request needs the inner
nodes to exist first".

This finding is the case for the datatype half, and it is the half being deferred.
Functions alone remove the `want`/`app` protocol but leave tagged JSON as the
idiom.

## The third finding: the `value` layer cannot build either

`value` is read-mostly. A program can destructure arbitrarily deeply but can only
construct fixed shapes: object keys must be string literals, and `list` sorts by
its argument with no `ORDER BY` escape, so an array cannot be rebuilt in a chosen
order. `map`, `filter`, `reverse`, `zip` and `sort_by` over a JSON array are
therefore inexpressible, and so is any deep JSON transformation. The measurements
and the fix are in [`value-construction.md`](./value-construction.md).

One detail belongs here. The escape hatch is to fold into nested pairs instead of
arrays:

```prolog
acc(0, null) :- doc(_).
acc(I + 1, [V, A]) :- acc(I, A), doc(D), array_element(D, I, V).
# [10, [2, [1, [3, null]]]]
```

Reversal works, but only by giving up the native array representation, and there is
no way back: rebuilding a flat array needs the ordered aggregate that does not
exist. So a two-element array literal is a usable cons cell, and that is what the
functions below recurse over.

## What this costs on the SQL backends: nothing

The obvious objection is that a recursive function does not compile to a SQL scalar
expression, so the feature would be interpreter-only like non-linear recursion and
parity stratification.

That objection does not survive contact with the corpus. Every term-manipulating
example is *already* interpreter-only: `list-ops`, `symbolic-differentiation`,
`sk-proof-terms`, `sk-strings`, `expression-fixer`, `cnf-from-ast`, `cnf-tseitin`,
`peano`, `parse-to-cnf`, `pretty-print-expression` and `expr-eval` all carry a
`native-only` marker. The set of programs that want recursive functions is a subset
of the set already restricted to the interpreters, so restricting recursive
functions to them costs nothing that is not already paid.

A **non-recursive** function is a macro: it inlines at the call site and works on all
five backends. A recursive one is rejected at translation time under a SQL backend,
with the same shape of message non-linear recursion already produces, so the
unsupported case is a diagnostic rather than a silent difference in answers.

## Sketch

One construct, `fun`. A single clause per function, no patterns, all branching via
the conditional of the next section.

```prolog
fun d(E) =
  {"kind": "num", "value": 0}                                     if E["kind"] = "num"
  else {"kind": "num", "value": 1 if E["name"] = "x" else 0}      if E["kind"] = "var"
  else {"kind": "op", "op": "+", "l": d(E["l"]), "r": d(E["r"])}  if E["op"] = "+"
  else {"kind": "op", "op": "+",
        "l": {"kind": "op", "op": "*", "l": d(E["l"]), "r": E["r"]},
        "r": {"kind": "op", "op": "*", "l": E["l"], "r": d(E["r"])}}.

fun show(N) =
  to_string(as_integer(N["value"]))  if N["kind"] = "num"
  else as_string(N["name"])          if N["kind"] = "var"
  else "(" + show(N["l"]) + " " + as_string(N["op"]) + " " + show(N["r"]) + ")".

?- input_expr(E), R = show(d(E)).
```

Two functions replace eight rules, and the ten subterm-closure rules
(`expr`, `node`, `answer_node`) disappear entirely. That is the win: not the line
count, which is roughly a wash, but that the closures and the divergence hazard the
current file warns about both become impossible. The sketch does not reproduce
`node_count`, which would need a third function.

Be clear about what is *not* won. The dispatch is still `E["kind"] = "num"` against
untyped JSON, with no arity or exhaustiveness check. That is exactly the idiom
`symbolic-differentiation` already uses, and only the datatype half would improve
it.

`reverse` needs no universe, over cons-pairs:

```prolog
fun rev(L, Acc) = Acc if L = null else rev(L[1], [L[0], Acc]).
fun reverse(L) = rev(L, null).
```

Over a *flat* array it still needs the ordered `list` from
[`value-construction.md`](./value-construction.md); functions cannot emit an array
of data-determined length on their own.

For SK reduction, construction moves into a function and the relation keeps the
nondeterminism, which is what it is for. The whole `want`/`app` protocol goes:

```prolog
fun s_reduct(T) =
  {"tag": "App", "f": {"tag": "App", "f": T["f"]["f"]["x"], "x": T["x"]},
                 "x": {"tag": "App", "f": T["f"]["x"],      "x": T["x"]}}.
step(T, s_reduct(T)) :- s_redex(T).
```

Five bookkeeping rules and a multi-round fixed point become one function, and it is
markedly harder to read than the constructor version would be. That trade is the
whole content of the deferred half.

## The conditional expression

C-style:

```prolog
X = "x" ? 1 : 0
```

**This section first argued for a postfix `1 if X = "x" else 0` and against the
ternary, and the argument against was wrong.** It is kept because the reasoning is
worth not repeating. The three claims were: that `:` is already spoken for by head
annotations, column declarations, proof captures (`V : p`), slices and
object-literal entries, so `p(c ? a : integer)` would collide with the annotation
slot (`AnnotatedHeadTerm.expr ':' PrimitiveType`); that a postfix form keeps `if`
and `else` contextual where a *prefix* `if c then a else b` would have to reserve
`if`; and that it needs no new precedence level.

Only the third survived, and it is true of both forms. Checked against the parser
rather than reasoned about:

- **The `:` does not collide.** A `?` commits the parse to consuming the matching
  `:`, so every other use of `:` is reached only when no `?` opened a conditional.
  `W[c ? 1 : 2]` is a subscript whose index is a conditional, `W[c ? 1 : 2 : 3]` is
  a slice from that conditional to `3`, and refinements and annotations are
  unaffected. The one shape that does not parse is `q(X: integer ? 1 : 2)`, where
  the annotation has already closed the term.
- **`p(c ? a : integer)` was a bad example.** It fails, but so does `q(integer)`:
  a type name is not an identifier, and that has nothing to do with the
  conditional. `q(c ? 1 : B)` is fine.
- **The keyword argument was aimed at the wrong alternative.** It compared postfix
  against *prefix* `if`. Against the ternary it inverts: the ternary needs no
  keywords at all, so `if` and `else` stay ordinary identifiers rather than
  contextual keywords, and `keywords.ts` needs no entry.

`Cond ::= Or ('?' Or ':' Cond)?` is right-associative, which gives the else-if
chain.

**This is why a function needs only one clause.** With a conditional in the
language there is nothing for multiple clauses to do: dispatch is a condition like
any other. That deletes the clause-order question (ordered first-match would have
been the only order-sensitive construct in the language), the disjointness check,
and the exhaustiveness check.

It also deletes a trap. Guards do not partition in general: `=` and `<>` are exact
complements in every cell, so `X = "x"` against `X <> "x"` would have been fine, but
`N < 0` against `N >= 0` is not, since null is incomparable and falls in neither. A
checker that believed `N < 0 ∨ N >= 0` was total would be wrong. That shape is now
reported directly by `core/src/nullness-diagnostics.ts` as an ordering gap over a
nullable operand, which is a warning a clause-guard checker would have had to
duplicate. With a single clause there is nothing to partition.

Worth having on its own, which is why it leads the ladder: one grammar production,
one `CASE`, one branch in `values.ts`. Three typing rules complete it. The condition
must type `boolean`. The result's base type is the join of the branches, and where
they join to `value` the primitive branch takes the translator's existing
`liftToJsonIfNeeded` lift, the same one `=` uses across the type-tag boundary, rather
than a `CASE` between incompatible SQL types. Its nullness is the join of the two
branches' nullness (`nonnull ⊔ maybenull = maybenull`); the condition's own nullness
does not enter, since a NULL condition selects the else branch rather than
propagating.

One caution for a teaching language. It is not a way to merge rules.
`pretty-print-expression`'s six guard-differing `wrap_left` / `wrap_right` rules
would collapse to two, which is shorter but abandons "two cases, two rules".

## Termination

This is where dropping patterns costs something real, and the cost is not the one
you would guess.

With constructor patterns, "the recursive call passes a strict subterm" is sound by
construction: a pattern variable is bound to a child of a node that exists, and the
pattern simply fails to match a leaf. Without patterns the analogous rule is
syntactic, and it is **not** sound, because NULL is a fixed point of subscripting:
`L[1]` is NULL when `L` is a leaf, and `NULL[1]` is NULL again.

```prolog
fun f(L) = 1 if L[0] > 5 else f(L[1]).
```

On a leaf this recurses forever. `L[0]` is NULL, `NULL > 5` is *false* rather than
unknown because comparison is total, so control takes the else branch and calls
`f(NULL)` again. Total comparison makes the mistake silent instead of noisy.

Proving the function returns without recursing at a leaf means reading the
condition, which is the ranking-function analysis
[`finiteness-checking.md`](./finiteness-checking.md) rejects as too heavy.

The obvious answer is a **depth budget**: designate one parameter, require every
recursive call inside an SCC to pass a subscript chain rooted at it, and bound
recursion at runtime by that value's JSON depth. It is sound, since subscripting
never grows a value. It is also too tight, and the aggregates section below is what
shows why. The natural fold over an array recurses on an *index*:

```prolog
fun sum_from(L, I, Acc) = Acc if I >= length(L) else sum_from(L, I + 1, Acc + as_integer(L[I])).
```

`I + 1` is not a subscript chain, so the static rule rejects it outright, and the
runtime bound is worse: a flat array has JSON depth 2 however long it is, so a
hundred-element fold would be cut off after two calls. The rule forbids the shape
that makes the feature useful.

So the budget is on **size**, not depth. Being the termination mechanism rather than
a backstop, it needs stating exactly:

- **Metric.** A leaf counts 1, including `null`. An array counts 1 plus its
  elements. An object counts 1 plus its values; keys are not counted. The budget is
  the sum over the arguments at the outermost call.
- **Depth, not calls.** The budget bounds nesting depth of `fun` application, not
  the total number of calls. Sibling and mutually recursive calls each see the
  remaining depth, so a function that recurses twice is not charged exponentially
  for branching.
- **Off-by-one.** The budget decrements on entry. At zero the call yields NULL
  without evaluating its body, so `f(null)` has budget 1 and its inner call is NULL.
- **No static decrease rule.** The subscript-chain check survives at most as a
  warning.

Size subsumes depth, admits index recursion over an n-element array, and costs
nothing more to compute. It degrades the way every other out-of-domain operation
does: an exhausted budget is NULL, not an error.

**The host stack is the real limit, so the budget needs a cap.** A large document
gives a budget in the hundreds of thousands, and a recursive evaluator in TypeScript
would exhaust the host stack long before reaching it, turning a bounded computation
into a crash. The interpreters therefore bound recursion by `min(size, cap)`, with
`cap` a constructor option and a reported stop reason, exactly as
[`finiteness-checking.md`](./finiteness-checking.md)'s per-stratum iteration cap
already does: partial result plus a banner beats a stack trace. That makes an
explicit stack or trampoline an optimisation rather than a prerequisite, and it means
the one place this proposal needs a cap constant is the one place the language
already has the pattern for it.

Be clear about what that gives up. A depth budget with its static rule would make
the runtime bound a backstop for a class already proven terminating. The size
budget has no such class: the bound *is* the termination mechanism, and a function
that would otherwise loop is cut off rather than rejected. One fewer analysis to
build, one fewer property to promise.

**What this does not buy.** Each *call* terminates. Programs do not: feeding a
function's output into a recursive predicate diverges exactly as `parse_json` does
today, and `finiteness.ts` already flags it via the `FunctionCall → PLUS` rule,
unchanged. Cost is not bounded usefully either, since the bound is the argument's
size and a function may do exponential work within it. Termination here is a
code-generation property, not a safety property.

The pedagogy shifts with the design: the lesson becomes "your recursion is bounded
by the size of the data" rather than "your recursion is structural". The datatype
half is what would give the second lesson.

## Aggregates: generalise them, but not with a fold

The tempting move is to notice that `count`, `sum`, `avg`, `min`, `max`, `concat`
and `list` are all folds, and replace the fixed seven with a user-supplied
combining function. It is the wrong trade, for five reasons that are worth
recording because the shape of the argument is the opposite of the one that made
recursive functions cheap.

**The SQL argument runs the other way.** Recursive `fun` costs nothing on the SQL
backends because all eleven term-manipulating examples are already `native-only`.
Aggregates are the reverse: 17 of the 25 aggregate-using example files run on SQL
backends today, compiling to `SUM`, `COUNT`, `STRING_AGG` and `JSONB_AGG`. A
user-defined fold compiles to none of those, so this trades a working feature for
a broken one.

**A fold needs an order that a relation does not have.** Only five of the seven
are commutative monoids. `concat` and `list` are order-dependent and buy
determinism with a hardcoded `ORDER BY` on the argument (spec §2.7). Commutativity
of a user-supplied combiner is not checkable, so a generic fold hands the user a
way to write an order-dependent aggregate over an unordered bag and get a
different answer per backend.

**A bare fold cannot express `avg`.** The reducer accumulates `(total, n)` and
divides at the end. What that needs is the initial/combine/finalise triple of
`CREATE AGGREGATE`, not a fold, so the proposal understates its own interface.

**The monoid unit disagrees with SQL's empty group.** Measured on an empty
relation, `count(*)` yields a row containing `0` while `sum` yields a row
containing `null`. `fold (+) 0` would give `0`. The existing aggregates are folds
with a *partial* unit, so re-presenting them as monoid folds would quietly change
`sum` on empty groups. NULL-skipping is baked into every arm of the reducer for
the same reason.

**What would be deleted is the small part.** `evalAggregate` is 104 lines.
`analyzer.ts` alone carries 59 aggregate references: the top-level-head-position
rule, the all-rules-must-agree check, the no-recursion rule, and the GROUP BY
synthesis in the translator. None of that concerns *which* seven functions exist.
The machinery is grouping, not the function table, so the simplification is a
user-extensible 104-line table bought with everything above.

### What does generalise, for free

`list(X)` already collects a group into a `value` array, so with a recursive `fun`
any user-defined aggregate is two rules:

```prolog
collected(G, list(X)) :- data(G, X).
result(G, median(L)) :- collected(G, L).
```

No fold combinator, no higher-order functions, no change to the aggregate
machinery, and the `list` half still compiles on every backend, with only the
outer `fun` interpreter-bound. That covers `product`, `argmax`, `stddev`,
`any` / `all`, `median`, and joining with a separator other than the `,` the
dialects hardcode.

The limits are real: it materialises the group as JSON, so it is for user-defined
aggregates rather than a replacement for `SUM` over a million rows; it inherits
`list`'s NULL-skipping and its NULL for an empty group; and `list` sorts by value,
so an order-sensitive fold also wants the `order by` from
[`value-construction.md`](./value-construction.md).

This is also the route that rules out a depth budget, since folding an array means
recursing on an index. See Termination above.

## Where it does not help

Worth stating, because it bounds the feature's reach.

- `pretty-print-expression`, `expression-fixer` and `logic-circuit` store their
  trees as id-keyed *relations* (`binop(2, "+", 1, 3)`), not as terms. Functions
  cannot read relations, so the functional layer is useless here, and
  `pretty-print`'s relational bottom-up rebuild is 40 clean lines anyway. The
  functional layer only helps when the data is already a term.
- `proof-term-fold`: a catamorphism to a scalar is two rules today. Functions add
  nothing.
- `cnf-tseitin`: its point is that node-local clause emission needs no recursion and
  translates on every backend. Functions would make it worse.

## What total comparison settles

Comparison became total in `a205ee8`, and [`null.md`](./null.md) §5 draws the line
as: NULL propagates through *operations* and is absorbed by *comparisons*.

**The operations inside a function propagate, so out-of-shape input needs no
special rule.** Subscripting a leaf yields NULL, arithmetic on NULL yields NULL,
and the size budget yields NULL. That is the answer `3 / 0` and `sqrt(-1)`
already give, so a function applied to garbage returns NULL rather than raising.
Note this is a statement about the body, not about the function: a function as a
whole need not propagate, which is the subject of the nullness decision below.

**The conditional's condition absorbs.** A condition is a test, and tests absorb,
so a NULL condition takes the else branch and the conditional is total. That is the
cheap answer as well as the principled one: `CASE WHEN c THEN a ELSE b END` is
already exactly this on every SQL backend, and the interpreters test `cond === true`.

The price is an asymmetry with filter position, which does not absorb. Measured over
`{true, false, null}`, `q(I) :- p(B, I), B.` yields `{1}` and `r(I) :- p(B, I), not
B.` yields `{2}`, so the null row is in neither: a filter can keep unknown as
unknown because it has a third outcome available, namely dropping the row. An
expression has nowhere to put unknown except NULL, so it has to pick a side, and
totality is worth more than the symmetry. Guard with `<> null` when the difference
matters (`null.md` §8).

## Decisions to get right

**Functions cannot call predicates.** Non-negotiable. Allowing it makes expression
evaluation mutually recursive with stratification, polarity and the finiteness
graph.

**Do not touch the base lattice.** A non-recursive function inlines, so the
existing inference types it with no new machinery. A recursive one declares its
types, drawn from the five that already exist. Either way there is no new base
element and still no `null` type ([`null.md`](./null.md) §7).

**Nullness is a separate obligation, and it is not free.** Since
[`nullness-tracking.md`](./nullness-tracking.md) shipped through stage 2, every
builtin overload carries a `NullBehaviour` of `{strict, total}`, required rather
than defaulted because inheriting `total` by omission would claim non-nullness
the analysis cannot prove. A `fun` is a call in expression position, so it needs
the same two bits, and neither comes for free:

- **Never `total`.** The size budget yields NULL from non-null arguments, so no
  recursive function can claim it. `{strict, total: false}` is the ceiling, which
  puts `fun` in the same class as the parsing and domain-error families.
- **Usually not `strict` either.** Every builtin is strict. A function with a
  null base case is not: `rev(null, Acc)` returns `Acc`, so a NULL argument gives
  a non-NULL result. That is the *idiomatic* shape for recursion over cons-pairs,
  not a corner case, so `fun` would be the first routinely non-strict callee in
  the language. `builtins.ts` calls this out as exactly the case that would
  otherwise inherit refinement it does not license.

Both facts are why a recursive function declares its result type rather than having
one inferred. The mandatory `?` states `total: false` where the checker can enforce
it, and `strict` is simply `false` for every user function: it licenses only
backward refinement, so declining it costs precision and never soundness. That turns
what would have been a fixed point over the call graph into two lines in the
declaration checker.

**First-order kills the payoff.** Without higher-order functions there is no `map`
and no `fold`, and each traversal is hand-written, which is what a recursive
predicate already does. The usable version is compile-time higher-order only:
function arguments must be statically known names, monomorphised at elaboration.
Runtime stays first-order, no closures in data, everything still inlines.

## Deferred: the datatype half

The second finding is the case for it, and the sketch above shows what its absence
costs: dispatch on `E["kind"]` against untyped JSON, no arity check, no
exhaustiveness check, and a structural termination argument replaced by a runtime
size budget. A `data` declaration with constructors usable as builders would fix
all four.

It is deferred because it is unsatisfying as currently conceived, and the specific
problem is that it collides with proof terms. `Cons(H, T)` from a `data`
declaration would build, `Some(X)` from `p(...) :: Some` matches, the two are
spelled identically, and the only way to tell them apart is to chase the
declaration. For a teaching language that is a trap. Note the power question is
already settled and is not the objection: object literals build freely in rule
heads today, so a buildable constructor adds no hazard the finiteness checker does
not already see.

Two other things would come back with it, both of which the single-clause design
currently sidesteps:

- Multiple clauses, and with them clause order, disjointness and exhaustiveness.
  Total comparison makes those checks well defined, since matching is a comparison
  and therefore two-valued, and `null` becomes a matchable value in its own right.
- The lowering. A constructor pattern would lower to a capture, a tag guard and
  per-argument accessor equalities (spec §8.4). With two equalities that lowering
  would have had to pick one, and picking wrong would make `f(Cons(H, T))` mean
  something different from its spelled-out equivalent; `null.md` §4 now guarantees
  they agree.

## Recommended order

1. **The conditional expression.** *Built.* C-style `c ? a : b`, right-
   associative, no keywords. The estimate above was one grammar production, one
   `CASE` and one branch in `values.ts`; the production and the two emits were
   right, and what it missed was the seventeen other expression walkers a new AST
   node has to appear in (safety, both type passes, nullness, partiality,
   Position 3, finiteness, completion, navigation, the head-term collectors).

   Two things the plan got wrong, both about NULL rather than about functions:

   - **"A NULL condition selects the else branch"** was SQL's `CASE` default, and it
     predates the null/undefined split. Every other boolean position in the
     language is strict at a null (`null && true`, `!null`, all four orderings), so
     the conditional is too: a null or absent condition withholds the row. The emit
     is `CASE c WHEN TRUE .. WHEN FALSE ..`, whose missing `ELSE` is what makes a
     NULL condition yield NULL.
   - **The branches have to be non-nullable**, which the plan did not foresee
     because it treated `null` and undefined as one thing. A conditional is the
     first expression that could be nullable *and* partial at once — a branch
     supplying the null, the condition the absence — and one SQL NULL cannot say
     which, so the definedness guard could not tell the row to keep from the row to
     drop. The interpreters carry two markers and would have got it right, so
     leaving it would have been a cross-backend divergence. Position 3 on the
     branches settles it, and the condition stays exempt because it cannot produce
     a null *result*. The cost is that the coalesce idiom
     `A <> null ? A : 0` does not type; narrowing or two rules is the answer,
     and lifting the restriction needs `canBeUndefined` to become nullness-aware,
     which is a change to a central analysis rather than a local one.

   Still independent of everything else here, and still what would let a function be
   single-clause.
2. **The declaration form**: the `fun` node surviving `parseRaw`, the signature
   grammar, the flat name-uniqueness check, and freshening in `expandModule`. Small
   individually, but it is what the parser and elaborator must agree on before
   either kind of function works, so it comes before both.
3. **Non-recursive `fun`.** A grammar rule plus one substitution pass in
   `post-process.ts`. Closes the unsafe-helper gap by inlining: `fun double(X) = X *
   2.` used as `Y = double(V)` expands to `Y = V * 2`, so the argument is bound by
   whatever the call site already binds and no relation is created. Works on all
   five backends, and nothing downstream learns the feature exists. It does not give
   you `double` in body-atom position, since this is an expression and not a
   relation.
4. **Recursive `fun`**, interpreter-only, with the size budget and its cap. Removes
   the universe enumeration and the subterm closures, and makes user-defined
   aggregates writable as `fun` over `list`.
5. **Compile-time higher-order**, so `map` and `fold` exist. Only if 4 earns it.

Step 1 is worth doing regardless of what happens to the rest and is unrelated to
this proposal. Steps 2 to 4 are one feature split three ways; the split is worth
keeping because step 3 is the whole payoff for the unsafe-helper gap and needs
neither the budget nor the interpreters.

The independent ordered-aggregate proposal is in
[`value-construction.md`](./value-construction.md). Its computed-object-key half has
separate unresolved semantics and should not be treated as part of the same small
change.

## Open questions

1. Does "functions cannot read relations" stay, knowing it rules out the
   id-keyed-tree half of the corpus? Relaxing it takes stratification with it.
2. Is a size budget an acceptable termination story for a teaching language, or
   does the lesson have to be structural recursion? If the latter, the datatype half
   stops being optional.
3. Can the datatype half be spelled so that a builder is visibly not a proof
   constructor? That is the objection that deferred it.
4. [`refinement-annotations.md`](./refinement-annotations.md) proposes the other
   kind of statically checked, codegen-free annotation. If the datatype half ever
   lands, refinements over datatypes rather than over primitives is the next
   question, so the two should be read together.
