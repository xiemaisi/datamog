# Design notes: aggregates and names in head arguments

Status: implemented. §1 and §2 shipped together, with the spec changes in
§2.3 and §2.7. The only open question is whether an unused head name deserves a
warning (§7).

Two changes to what a rule head's argument may hold. They arrived together and
are worth keeping apart, because only one of them has a case of its own:

- **Aggregates inside expressions.** `var_index(Name, count(Other) - 1)`, where
  an aggregate previously had to be the entire argument.
- **Naming a position.** `span(NT, I, I + 1 as K)`, so something other than the
  expression itself can refer to that column.

Neither subsumes the other, which is the first thing to get straight. Naming
does not deliver the first: `var_index(Name, count(Other) as K, K - 1)` is three
columns and only two were wanted. Aggregates-in-expressions does not deliver the
second: an expression is still not a name, so nothing outside it can refer to
the column it computes.

The second is the IDB counterpart of something extensional predicates already
have. `input predicate survey(name: string, age: integer?)` names its columns at
its declaration; an intensional predicate has no declaration site, so its
positions are anonymous and can only be referred to by whatever expression a
given rule happens to put there.

## 1 Aggregates inside expressions

### 1.1 The workaround, four times over

Before §1 shipped, the corpus wrote the same helper predicate four times, in four
files, each used exactly once and existing only to subtract one from a 1-based
rank:

| File | The pair |
|---|---|
| `cnf-tseitin` | `rank(Name, count(Other))` then `var_index(Name, J) :- rank(Name, K), J = K - 1.` |
| `cnf-from-ast` | the same two lines |
| `parse-to-cnf` | the same two lines |
| `expression-fixer` | `oprank_raw(Id, count(Other))` then `oprank(Id, K - 1) :- oprank_raw(Id, K).` |

`cnf-from-ast` documents the workaround in a comment rather than the intent:
"name counts itself, so the smallest gets rank 1; the 0-based index is that rank
minus one." What the author wanted to write is one rule:

```prolog
var_index(Name, count(Other) - 1) :- varname(Name), varname(Other), Other <= Name.
```

In all four cases the helper has exactly one consumer, so the change removes a
predicate rather than shortening one.

Not every aggregate arithmetic is collapsible, and the same file shows why:

```prolog
tvar(N, Idx) :- internal(N), irank(N, R), nprop(P), Idx = P + R - 1.
```

This combines two aggregate predicates with *different* groupings, so `irank`
and `nprop` both survive. The pattern §1 fixes is narrower: one aggregate, one
consumer, arithmetic on the result.

### 1.2 The restriction is mechanical, not principled

Before §1 shipped, `post-process.ts` rewrote an aggregate `FunctionCall` into an
`AggregateCall` only at `rule.head.args[i]`, never inside an expression. The
analyzer's "Aggregate must be a top-level head argument" was that rewrite's
shadow. No rationale sat beside either, and the grammar already parsed the nested
form because an aggregate call is syntactically an ordinary `FunctionCall` until
post-processing says otherwise.

So this is a restriction nobody argued for, which is the best kind to lift.

### 1.3 What changed

- **Post-processing** walks head-argument expressions rather than only their
  roots, rewriting every aggregate `FunctionCall` it finds.
- **The analyzer's grouping rule** generalised from "this argument *is* an
  aggregate" to "this argument *contains* one" (§3.1), and gained one new
  well-formedness check (§3.2).
- **The translator** emits arithmetic over an aggregate. SQL already permits
  `COUNT(*) - 1` in a select list, so this is expression compilation over a new
  kind of leaf rather than new SQL shape.
- **The interpreters'** aggregate reducer computes the aggregate and then
  evaluates the enclosing expression, where the aggregate had been the result.

## 2 Naming a position

### 2.1 What it is for

Two things, and only the second is urgent.

**Referring to a computed column from elsewhere in the head.** The user's case:

```prolog
p(count(*) as N, N + 1) :- q(_).
```

which uses one aggregate value twice rather than writing `count(*)` twice and
relying on the reader to see they must agree.

**Giving a refinement annotation something to mention.**
[refinement-annotations.md](./refinement-annotations.md) §2.3 requires every
position mentioned by a contract to have a name. A computed expression has no
name of its own, so `as` supplies one without introducing a body variable:

```prolog
span(NT, I, I + 1 as K, _: I < K) :- token(I, W), lexicon(NT, W).
```

That also disposes of the trap that section documents. Rewriting a head
expression into a body equality changes an auto-derived proof term, because
§8.2 counts the body variables that do *not* appear in the head, and the rewrite
makes the old variable existential: `nat(n + 1) :: Succ` becomes `Succ/2` and
breaks every `Succ(A)` pattern elsewhere. Naming touches no body, and `n` still
occurs in the head, so the arity is unchanged.

### 2.2 A head-scoped binder, not a variable

A name is **fresh and scoped to the head**, not an ordinary variable shared with
the body. This is the choice that makes everything else simple.

If a name were an ordinary variable, `p(I + 1 as K) :- q(K)` would be a join
constraint, `p(I + 1 as I)` would assert `I = I + 1` and be quietly always
false, and every question about shadowing and about whether the name counts as a
proof-term witness would have to be answered. Head-scoped, none of them arises:
the name denotes the argument at that position, may be used by other head
arguments and by annotations, and is invisible below the `:-`.

Nothing is lost. The join above is already writable as
`p(I + 1) :- q(K), K = I + 1.`

### 2.3 What it does not fix

Naming avoids body rewrites, but it does not touch the larger cost in
refinement-annotations.md §9.3. Under that document's disjunction rule, `jugs`
still needs its invariant on all nine rules.

## 3 Semantics

### 3.1 Grouping

Spec §2.7 groups by the non-aggregate head arguments. That generalises to: a
head argument is a **grouping column** iff it contains no aggregate call and
mentions no name bound to an argument that does. Both clauses are needed, and
only the second is new, arriving with §2.

```prolog
var_index(Name, count(Other) - 1)   # groups by Name
p(count(*) as N, N + 1)             # no grouping column: N + 1 mentions N
p(K, count(*) as N, N + 1)          # groups by K
```

### 3.2 The well-formedness check

Once an aggregate can sit inside an expression, the expression can also mention
a variable that is neither grouped nor aggregated, which today has nowhere to
appear:

```prolog
p(K, count(*) - Y) :- q(K, Y).      # rejected: Y is neither grouped nor aggregated
```

Grouping is `{K}`, so `Y` has no single value within a group. This is SQL's rule
and it needs stating: **inside a head argument containing an aggregate, every
variable must be a grouping variable or lie within an aggregate's argument.**

### 3.3 Types, nullness, proof terms

Each falls out, but each is worth checking rather than assuming.

- **Types.** An expression over an aggregate types as any other expression, with
  the aggregate's result type at the leaf (spec §5.5). A name has its
  expression's type.
- **Nullness.** Likewise: `count` is non-null, so `count(*) - 1` is, while
  `sum(X) - 1` inherits whatever `sum(X)` has. A name has its expression's
  nullness bit. Nothing in `nullness-tracking.md` §4.1 changes shape.
- **Proof terms.** §8.1 forbids aggregates in a proof-carrying predicate, so §1
  cannot interact with them at all. §2 can, and does so benignly per §2.1: a
  name introduces no body variable, so §8.2's witness derivation is untouched.

### 3.4 Backends

Both features are source-level. §1 changes what the translator emits inside a
`GROUP BY` query and what the interpreters' reducer evaluates, but adds no
construct either has to learn. §2 reaches neither: a name is substituted during
parsing and nothing downstream sees it.

## 4 Surface syntax

The head-term production carries optional naming and type components:

```
Expression ({infer AnnotatedHeadTerm.expr=current}
    ('as' name=Identifier (':' type=PrimitiveType (nullable?='?')?)?
    | ':' type=PrimitiveType (nullable?='?')?))?;
```

`as` binds tighter than `:`, since you name a thing and then say what it is:

```prolog
p(count(*) as N: integer, N + 1) :- q(_).
```

`as` was already a contextual keyword (`core/src/keywords.ts`, used by the
data-file binding `:= "f" as fmt`), so this needed no new reserved word or lexer
change. The playground already read the shared keyword set; the VS Code TextMate
grammar needed its hard-coded alternation updated and now has a drift test.

## 5 Rejected alternatives

**Naming only, without §1.** Rejected on the evidence: the four corpus cases
want `count(Other) - 1` in one column, and naming gives them
`count(Other) as K, K - 1` in two.

**Aggregates in rule bodies.** A larger and different feature, and one §4.5
constrains heavily, since a recursive aggregate is forbidden. Nothing here needs
it: every corpus case computes from an aggregate in a head.

**A name as an ordinary body-visible variable.** Answered in §2.2. It buys a
join spelling that already exists and costs the shadowing and witness questions.

**Positional reference instead of names**, so an annotation could say `$2` where
it otherwise needs a named position. It reads badly, and it silently retargets
when a column is inserted, which a name does not.

**A `let` binding in the head**, `p(let N = count(*), N + 1)`. Same meaning as
`as`, more punctuation, and `let` would be a new reserved word where `as` is not.

## 6 Staging, as built

**Stage 1: aggregates inside expressions.** §1.3's four touch points plus
§3.2's check, landed by collapsing the four corpus workarounds, all four
byte-identical with one fewer predicate each.

Two notes from building it. The post-processing rewrite is now a generic walk
over AST properties rather than a case per expression shape, so a later grammar
addition cannot escape it silently, and the same shape serves the analyzer's
three new walkers. And the interpreter needed less than expected: `evalTerm`
took an optional resolver for the AggregateCall leaf rather than growing a
parallel walker, because §3.2's check guarantees every ordinary variable in
such an expression is a grouping variable, so any one substitution in the group
speaks for all of them.

**Stage 2: naming.** Implemented as a **substitution during parsing** rather
than resolution during analysis, which is what §2.2's head-scoped choice buys.
`parser/src/head-names.ts` replaces each name with a copy of its argument's
expression, so nothing after parsing knows a name existed, and §3.1's second
grouping clause needed no code at all: the substituted argument simply contains
the aggregate. Copies share a `$cstNode` deliberately, so an error inside a
substituted expression points at the text the user wrote.

**Stage 3: update refinement-annotations.md §2.3.** Complete. The proposal uses
head-position names and records that refinement extraction must run before the
parser substitutes them away.

## 7 Open questions

Three of the four are answered; what is left is one judgement call.

1. **May a named position be referenced by an earlier argument?** Yes.
   `p(N + 1, count(*) as N)` derives the same tuples as the other order, which
   is what order-independence everywhere else in the language leads a reader to
   expect. Cycles and duplicate names are rejected.
2. **Should a name be allowed where nothing reads it?** Still open.
   `p(count(*) as N)` with no other mention of `N` is inert, and
   `findInertPolarity` is the precedent for warning about that shape. Not done,
   because unlike an inert `^` sigil this one is merely redundant rather than
   misleading: it cannot make a program mean something other than it reads.
3. **Does an aggregate expression belong in an `output predicate` head, a
   constraint, or a query?** In the first two, confirmed by running them: an
   `output predicate` head takes one, and `error predicate bad(count(*) - 5)`
   fires and reports its witness. Not in a query, which has no head for a name
   or an aggregate to attach to.
4. **Did collapsing the four helpers disturb the prose?** No. doc/case-studies
   chapter 8 describes the ranking at one remove, "a `count` aggregate does the
   ranking", never as two steps. The only test artefact that moved was the
   diagnostics snapshot, which lost the four helper predicates and nothing else.
