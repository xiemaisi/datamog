# Datamog Language Specification

Datamog is an educational Datalog dialect. Programs declare table-backed
predicates, define derived predicates via rules, and issue queries.

Datamog ships with five backends. All of them implement the same
language semantics and agree on runtime invariants (divide-by-zero and
domain errors having no value, slice bounds, integer vs float division); they
differ only in how rules are evaluated.

The **SQL backends** — PostgreSQL, SQLite, and sql.js (WASM SQLite) —
translate programs into standard SQL (CREATE TABLE, CREATE VIEW,
SELECT) and execute them against a relational database. Dialect
differences only affect the generated SQL.

The **in-memory backends** evaluate Datalog directly, without going
through SQL:

- **`--backend native`** — naive bottom-up evaluator. Strata are evaluated
  in topological order and each stratum is re-run in full until no new
  tuples appear.
- **`--backend seminaive`** — the same walk across strata, but each
  recursive iteration fires every rule once per body atom referencing a
  same-stratum predicate, forcing that atom to read from the previous
  iteration's *delta* (newly-derived tuples) while other atoms read from
  the accumulated result. Non-recursive strata finish in a single pass.
  Produces identical results to `native`, but avoids re-deriving tuples
  that couldn't yield new facts this round.

## 1 Lexical Structure

### 1.1 Character Set

Datamog source files are UTF-8 encoded text.

### 1.2 Whitespace

Tabs, spaces, carriage returns, and newlines are ignored between tokens.

### 1.3 Comments

Line comments begin with `#` and extend to the end of the line:

```
# This is a comment.
ancestor(X, Y) :- parent(X, Y).   # inline comment
```

### 1.4 Identifiers

There is a single identifier surface, `IDENT`, matched by

```
/[a-zA-Z_][a-zA-Z0-9_]*/
```

Whether a given identifier denotes a *predicate*, a *function*, or a
*variable* is determined by its **syntactic position**, not by its
spelling:

- An identifier immediately followed by `(` is a predicate or function
  name (in declarations, rule heads, body literals, and call
  expressions).
- An identifier appearing anywhere else a term is expected is a
  variable.

Stylistically Datamog follows the Prolog convention of capitalising
variables and lower-casing predicates (`parent(X, Y) :- mother(X, Y).`),
and the editor highlighters render them that way — but the grammar
imposes no such rule. `Foo(x, y) :- bar(x, y).` parses identically and
binds `x`, `y` as variables.

Either kind may also be written in **backtick-quoted** form. Backticks
are a purely syntactic escape: they allow extra characters in a name
(punctuation, spaces, reserved words) that the bare `IDENT` pattern
wouldn't accept. The token is `QUOTED_IDENT`, matched by

```
/`(\\.|[^`\\\n\r])+`/
```

Quoting never changes the role: `` `X` `` and `X` are the same variable;
`` `foo` `` and `foo` are the same predicate. Backticks decode backslash
escapes inside and are stripped before the decoded name is exposed to
downstream stages.

```
input predicate `http-event`(`content-type`: string, `in`: integer).
ok(`First Name`) :- `http-event`(`First Name`, _).
```

Function names are not backtick-quotable: `` `length`(X) `` parses as a
predicate atom (with predicate name `length`), while `length(X)` in an
expression is the built-in function call.

### 1.5 Literals

**String literals** are enclosed in double quotes. Backslash escapes are
supported:

```
"hello"    "line\nbreak"    "say \"hi\""
```

Pattern: `/"(\\.|[^"\\])*"/`

**Numeric literals** are integers or reals:

```
42    0    3.14    100.0    0b1010
```

Pattern: `/0[bB][01]+|[0-9]+(\.[0-9]+)?/`

A literal written with a decimal point (e.g. `1.0`) is treated as `float`
even if its mathematical value is integral. This distinction is preserved
through parsing and used during type inference. Numeric literals must parse
to finite JavaScript `Number` values; integer literals must also fit in
`[-(2^53 - 1), 2^53 - 1]`.

A literal prefixed with `0b` (e.g. `0b1010`) is a **binary integer**; it is
converted to its decimal value during parsing (so `0b1010` and `10` are
indistinguishable thereafter) and is always an integer.

**Boolean literals** are the keywords `true` and `false`:

```
true    false
```

They have type `boolean` and may appear anywhere a term is expected
(facts, rule heads, atom arguments, equalities). They cannot be ordered
with `<`, `<=`, `>`, `>=` (no boolean order in Datalog); equality
comparisons are fine.

**Null literal** is the keyword `null`:

```
null
```

It has type `null`, whose single value is `null` itself (Section 5.1). It is
an ordinary value: it binds a variable (`X = null`), inhabits a column, and
may be written as a column's declared type. It is *not* a marker for a
failed operation, which is a separate notion with no value at all
(Section 5.4).

### 1.6 Keywords

**Lexical keywords** cannot appear as a bare identifier in any position
(predicate, column, or variable):

```
not    in    true    false    null
string    integer    float    boolean    value
```

`input`, `output`, `error`, `predicate`, `from`, `as`, and `type` are **contextual
keywords**: they lead the `input predicate` / `output predicate` /
`error predicate` declaration forms, type aliases (§2.2), and the `:=` source binding (§9), but are
ordinary identifiers everywhere else, so a program may still name a predicate,
column, or variable after them (for example the `from`/`to` columns of an edge
relation, or a predicate called `error`).

**Built-in operation names** (functions, body atoms, and aggregates) are
reserved only against unquoted predicate names; they may be used as input-predicate
columns and as variables:

```
object_entry    array_element    defined
upper    lower    trim    replace
abs    round    floor    ceil    sqrt    ln    exp
as_string    as_integer    as_float    as_boolean    length    type_of
has_key    keys    values    to_json    parse_json
to_string    to_integer    to_float    to_boolean
count    sum    avg    min    max    concat    list
```

Backtick-quoting escapes both restrictions (§1.4). See §1.8 for how these
groups interact with the predicate, column, and variable namespaces.

### 1.7 Operators and Punctuation

```
Arithmetic:    +  -  *  /  %  **
Boolean:       &&  ||  !
Bitwise:       &  |  ^  <<  >>  >>>
Comparison:    <  >  <=  >=  =  <>  (!= spells <>)
Rule:          :-
Query:         ?-
Constraint:    !-
Binding:       :=
Constructor:   ::
Maximal:       ^        (postfix, on a predicate name)
Range:         ..
Grouping:      (  )  [  ]  {  }
Separators:    ,  :  .
```

`=`/`<>` are the language's only equality and inequality, and they are
null-aware: `null = null` is true. No comparison ever *returns* `null`, but the
orderings are strict at one and have no value there, while `=`/`<>` answer for it
(§2.6, §5.4). Body-level Equality reuses the same operator and can bind an unbound
bare variable on either side.

`!=` is an accepted spelling of `<>`, for programmers who reach for it
first. It is normalised during parsing, so the two are the same operator
in every respect; this document uses `<>`.

`^` serves twice. Between two expressions it is bitwise XOR; immediately after
a predicate name and before its argument list (`bad^(E)`) it marks the
predicate **maximal** (§4.3). The positions do not overlap, so no expression
changes meaning.

### 1.8 Namespaces

Identifiers in Datamog fall into several namespaces. Because an identifier's
role is fixed by its syntactic position, not its spelling (§1.4), two names in
different namespaces never collide even when written identically. The
constraints below are the only exceptions.

**The namespaces**

- **Reserved keywords**: `not`, `in`, `true`, `false`, `null`,
  and the five type names `string`, `integer`, `float`, `boolean`, `value`.
  These are *lexical* keywords, so the parser rejects them as a bare identifier
  in every position (predicate, extensional column, and variable alike). `true`, `false`,
  and `null` are also the literals of §1.5. The declaration words `input`,
  `output`, `error`, `predicate`, `from`, `as`, and `type` are *contextual* (§1.6) and
  stay available as ordinary names.
- **Built-in operation names**: one set covering the three kinds of built-in
  operation, the *functions* (`upper`, `abs`, `as_integer`, `to_json`,
  `defined`, and so on), the *body atoms* (`object_entry`, `array_element`), and
  the *aggregates* (`count`, `sum`, `avg`, `min`, `max`, `concat`, `list`). The
  complete list is in §1.6. Lexically these are ordinary identifiers; they are
  reserved only against predicate names, and may be used freely as extensional
  columns and as variables.
- **Type aliases**: file-local names for types (§2.2), separate from predicates
  and variables. Aliases cannot redefine primitive type names, even when quoted.
- **Predicate names**: a single namespace shared by extensional (EDB) and
  intensional (IDB) predicates. Each name is one or the other, never both
  (§4.6), and carries a fixed arity (§4.2).
- **Extensional columns**: the named, typed fields of an `input predicate`
  declaration (§2.2), unique within it, and matched against loader input by
  exact, case-sensitive name. Intensional (rule-defined) predicates have no
  named columns; their fields are positional.
- **Variables**: scoped to a single rule or query and never declared. Repeated
  occurrences of one spelling within a rule denote the same variable; the same
  spelling in a different rule is unrelated. Names are case-sensitive, so `X`
  and `x` are distinct.
- **Constructor names**: the rule names introduced by a head annotation
  `p(args) :: Ctor` (Section 8). Scoped to their predicate —
  unique *within* a predicate but able to recur across predicates — so the full
  name is `predicate::Ctor`, referenced bare (`Ctor(...)`) when unambiguous or
  qualified (`p::Ctor(...)`) otherwise.

**Two reservation mechanisms.** Keywords and type names are rejected by the
*parser*, a hard syntax error in any position (predicate, column, or variable).
Built-in operation names are rejected by the *analyzer*, and only as predicate
names: written `f(...)`, a predicate named after a built-in operation would be
indistinguishable from an invocation of that operation, giving `f(...)` two
meanings.
Extensional columns and variables need no such protection, because neither is
ever written in the `name(...)` call form: a column is declared `name: type`
and matched positionally, and a bare `count` in term position is unambiguously a
variable while `count(X)` is the aggregate. Both restrictions are lifted by
backtick-quoting the name (§1.4), which forces the identifier reading, so
`` `value` `` can name a predicate, column, or variable despite `value` being a
type keyword.

**Overlap.** Whether a word W may fill each role:

| Word W                            | predicate | extensional column / variable | escaped as `` `W` `` |
|-----------------------------------|:---------:|:-----------------------------:|:--------------------:|
| a plain identifier (`foo`, `p2`)  | yes       | yes                           | not needed           |
| a reserved keyword or type name   | no        | no                            | yes                  |
| a built-in operation name         | no        | yes                           | yes (as a predicate) |

Because roles are position-based, one spelling can name both a predicate and a
variable in the same rule: in `p(p) :- edge(p, _).` the head `p(...)` is the
predicate and the argument `p` is a variable.

**Not identifiers.** String, numeric, boolean, and null literals (§1.5) and
object-literal keys (`{"k": ...}`) are literal tokens, not identifiers, so they
do not touch any namespace above. There are no bare-word constants: an unquoted
term is always a variable, so `friend(alice, bob)` binds `alice` and `bob` as
variables (here unsafe, since neither appears in a body), not as string
constants.

## 2 Grammar

### 2.1 Program

A program is a sequence of statements, each terminated by a period (`.`):

```
Program     ::= Statement*
Statement   ::= TypeAlias | ExtDecl | Rule | Query | Constraint
```

Programs are analysed as a whole. Extensional declarations, rules, and
queries may be freely interleaved, and a rule or query may reference
predicates declared or defined later in the file.

A program produces one result per **output**: the single `?-` query (the
**default output**, §2.4) and each `output predicate` rule (a **named
output**, §2.3). Results are reported in source order.

A program may also assert **integrity constraints** (§2.10): predicates whose
extension must be empty. Every constraint is checked before any output is
produced, so a program whose data violates its own constraints yields no
results at all.

### 2.2 Extensional Declarations

```
ExtDecl     ::= 'input' 'predicate' Identifier '^'? '(' ColumnDecl (',' ColumnDecl)* ')' (':=' Binding)? '.'
ColumnDecl  ::= Identifier (':' (PrimitiveType | StructuralType | Identifier))? ('?')?
StructuralType ::= '{' (TypeField (',' TypeField)*)? '}' | '[' TypeValue ']'
TypeField   ::= (Identifier | StringLiteral) '?'? ':' TypeValue
TypeValue   ::= (PrimitiveType | StructuralType | Identifier) '?'?
TypeAlias   ::= 'type' Identifier '=' TypeValue '.'
PrimitiveType ::= 'string' | 'integer' | 'float' | 'boolean' | 'value' | 'null'
```

An input predicate declaration introduces an **extensional predicate** (EDB): a
predicate supplied from outside the program's rules. Each column has a name and
a type. At execution time the predicate is populated from an external data
source (CSV, JSONL, JSON, Google Sheets, or Mermaid diagram) via a loader
plugin.

The type annotation is optional; a column declared without one defaults to
`string`, so its cells load verbatim. Annotate a column when you need a narrower
type -- for example `integer`/`float` for arithmetic or range bounds, or `value`
to parse JSON. A column used in a position its default `string` cannot satisfy
(say, `X * 2`) is a static type error until annotated.

```
input predicate scores(student, subject, score: integer).  # student, subject: string
input predicate survey(name: string, age: integer?, email: string?).
input predicate edges(from, to).                            # both string
```

The optional `?` suffix marks a column as nullable: its cells may hold the `null`
value as well as values of the base type (§5.1). It leaves the base type alone for
inference, and it is checked statically as well as at load time. An operation that
*computes* rejects a nullable operand outright (§5.4), so

```prolog
input predicate survey(name: string, age: integer?).
adult(N) :- survey(N, A), A >= 18.        # fine: an ordering takes a null
doubled(N, A * 2) :- survey(N, A).        # error: `*` needs a value
doubled(N, A * 2) :- survey(N, A), A <> null.   # fine: narrowed first
```

Input columns can also declare nested JSON records and homogeneous arrays:

```prolog
input predicate people(person: {name: string, age?: integer, scores: [float?]}).
```

Records are closed: undeclared fields are rejected. `age?: integer` permits a
missing field, while `age: integer?` requires the field but permits JSON null.
These modifiers can be combined. `[integer]?` permits a null array;
`[integer?]` permits null elements. Quoted field names and empty records (`{}`)
are supported. Nested `value` accepts any JSON value, including null.

These declarations retain `value` storage and publish their shape to consumers,
so proven scalar fields can be used in typed operations (§5.1). Loaders validate
nested values before insertion and report the offending column and JSON path.
Module bindings check structural contracts against the supplied predicate's
published type. The same structural syntax is available in rule-head annotations (§5.10).
Tuple declarations, open records and JSON Schema import are not supported.

#### Type aliases

A `type` declaration gives a reusable name to a primitive or structural type:

```prolog
type Person = {name: string, age?: Age, scores: [Age?]}.
type Age = integer.
input predicate people(person: Person).
person({"name": "Ada", "scores": [37]}: Person).
next_age(P["age"] + 1) :- people(P).
```

Aliases are transparent: using `Person` has exactly the same meaning, storage,
validation and published contract as writing its definition inline. They introduce
no nominal identity, constructors or proof membership. An alias may be used in an
input column, rule-head annotation (including after `as`), record field, array
element, or another alias. `?` composes with nullability in the definition:
`type Age = integer?.` makes both `Age` and `Age?` nullable integers.

Names are case-sensitive and local to their source file. Forward references are
allowed; unknown names, duplicate aliases and direct or indirect cycles are
errors, including in unused declarations. A module resolves its aliases before
its predicates are elaborated. Aliases are neither imported nor exported; module
boundaries compare their expanded contracts, so files may use the same alias name
for different types. In an incremental session, a successful chunk's aliases are
available to later chunks; redefinition is rejected and reset clears them.

A bare name after a head's `:` denotes an alias. On an erased witness, `_: B`
retains its Boolean-refinement meaning when no alias `B` is declared. Write
`_: (B)` to explicitly select the expression when a type alias has the same name.
Compound refinement expressions retain their existing meaning.

Recursive aliases and parameterized aliases are not supported. Expansion is
bounded compiler work: excessive nesting or expansion is rejected, never replaced
with a weaker contract. This limit does not restrict the size of runtime values.

A column without `?` is emitted `NOT NULL`, and a `null` in its data is a load
error rather than a silently missing value (§7). The one exception is the `null`
type itself, which is declarable as a column type (§1.5) and needs no `?`: `null`
is the only value it admits, so a `NOT NULL` there would leave the column
uninhabited. `null` and `null?` are the same type.

An input predicate may carry the postfix `^` polarity sigil (§4.3). This is
principally a module-interface contract: a maximal input accepts only a maximal
actual, and a binding that receives a maximal output must itself carry `^` (§9).
An input predicate may be **bound** to a source with `:=` — a specific data file
or an instance of another module (§9). An unbound input is a free parameter. In
the *entry* program it is supplied at the frontend — the CLI and playground load
it from `<name>.csv` by convention, or a `--input` flag — but that convention is
not part of the language. An input of an *imported* module must instead be
supplied explicitly (wired or `:=`-bound); a module never auto-loads (§9).

### 2.3 Rules

```
Rule        ::= (('output' | 'error') 'predicate')? HeadAtom (':-' BodyElement (',' BodyElement)*)? '.'
HeadAtom    ::= Identifier '^'? '(' (HeadTerm (',' HeadTerm)*)? ')'
HeadTerm    ::= Expression ( 'as' Identifier (':' TypeValue)?
                           | ':' (TypeValue | Refinement) )?
Refinement  ::= Expression
```

A refinement attaches only to the bare `:` branch, so a named position takes a
type but not a refinement: `_ as N: I < N` is a parse error. Name the position
in one term and refine it from another (`I + 1 as K, _: I < K`).

An `Expression` in head position may contain aggregate calls (§2.7).

A **rule** defines a derived predicate (IDB) in terms of other predicates.
The head names the predicate being defined; the body is a conjunction of
conditions. Multiple rules for the same predicate define alternative ways to
derive tuples (their results are unioned).

A rule with no body (`:-` omitted) is a **fact** -- it unconditionally
asserts a tuple:

```
edge("a", "b").
flight("london", "new_york", 9.0).
```

A rule with a body derives tuples when all body elements are satisfied:

```
ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
```

**Naming a head argument.** A head argument may be given a name with `as`, and
the head's other arguments may then refer to it. This is what lets one value be
used twice without writing the expression twice:

```
p(count(*) as N, N + 1) :- q(_).
```

A name is a **fresh binder scoped to the head**. It denotes the argument at that
position, is invisible below the `:-`, and is substituted away before any later
stage sees the rule, so naming never changes what a rule means. Three things
follow:

- Order does not matter: `p(N + 1, count(*) as N)` derives the same tuples.
- A name must not collide with a variable the body binds, since it introduces a
  binder rather than referring to one. Write the equality in the body instead.
- Names must not refer to one another in a cycle, and each name must be
  distinct within a head.

`as` binds tighter than a type annotation, so a named argument is typed
`p(count(*) as N: integer, N + 1)`.

A rule prefixed with `output predicate` defines its predicate exactly as an
ordinary rule does, and additionally exposes the predicate as a **named
output**: when the program runs, that predicate's whole relation is reported
as a result, labelled with the predicate name. Types are inferred as for any
derived predicate, so the head takes ordinary variable (or aggregate)
arguments; a predicate is an output if any of its rules carries the marker.

```
output predicate reachable(X) :- edge("start", X).
output predicate class_totals(Class, sum(Fee)) :- enrolment(_, Class, Fee).
```

Named outputs are how a program reports more than one result: a file may
contain at most one `?-` query (§2.4), so any additional results are written
as `output predicate` rules.

**Optional head type annotations.** A head term may carry a type annotation:

```
ancestor(X: string, Y: string) :- parent(X, Y).
class_totals(Class: string, sum(Fee): float) :- enrolment(_, Class, Fee).
```

Annotations are optional: they never drive inference or code generation, but they
are not inert. Inference runs exactly as it would without them, and each declared
type is verified against the inferred one; beyond that, a predicate advertises a
*published* type (its inferred type widened by its annotations) against which its
consumers and any module boundary are type-checked (§5.10).
They are **per rule and per argument** -- a rule may annotate any subset of its
head arguments, and sibling rules of the same predicate may annotate
differently or omit annotations entirely. Each annotated position is checked
against that rule's own inferred contribution: the declared type must equal or
widen it, so you may annotate a column `value` to document that it holds
arbitrary shapes, but claiming a type narrower than the rule proves (for example
`integer` on a position inferred as `value`) is rejected. See §5.10.

### 2.4 Queries

```
Query       ::= '?-' BodyElement (',' BodyElement)* '.'
```

A query is a conjunction of body elements — the same shape as a rule
body — that yields rows of variable bindings. **Projection** is
implicit: every distinct non-anonymous Variable that appears anywhere
in the body becomes one output column, in source order of first
mention. `_` is a wildcard and is never projected. Repeated use of
the same named variable across positions constrains those positions
to be equal (just as in rule bodies).

The `?-` query is the program's **default output**, and a file may contain
**at most one** of them (a second `?-`, or a `?-` together with an
`output predicate default`, is rejected). Additional results are expressed as
named outputs (`output predicate`, §2.3). The examples below illustrate query
*forms*; each is a separate single-query program.

```
?- ancestor("alice", X).            # all descendants of alice
?- ancestor(X, Y).                  # all ancestor-descendant pairs
?- ancestor(X, _).                  # all ancestors (descendant unconstrained)
?- ancestor(X, X).                  # all self-ancestors
?- parent(N, C), ancestor(C, G).    # join two atoms; project N, C, G
?- person(N, A), A > 30.            # filter on a body expression
?- t(X), Y = X + 1.                 # equality binds a new projection column
?- I in [1 .. 10].                  # range query — projects I
?- t(X), not excluded(X).           # safe negation (X bound by the positive atom)
```

**Ground queries** are queries with no projected variables. They
produce either a single empty row (signalling the query is
satisfied — the conventional Prolog "yes") or zero rows (the
conventional "no"):

```
?- ancestor("alice", "carol").      # `yes` if alice is an ancestor of carol
```

The CLI renders these as the literal strings `yes` / `no` to match
the convention; embedding APIs see one empty record or zero records
and can render however they like.

Query bodies are subject to the same safety rule as rule bodies (§4.1):
every variable mentioned in the body — including projected ones —
must be bound by a positive atom, a binding equality, or a binding
range somewhere in the body. `?- not p(X).` is therefore an error
(X has no positive binding); `?- p(X), not q(X).` is fine.

### 2.5 Body Elements

```
BodyElement ::= Literal | Equality | RangeAtom | Filter
```

#### Literals

```
Literal     ::= ('not')? Atom
Atom        ::= Identifier '^'? '(' (Expression (',' Expression)*)? ')'
```

The `Atom` here is a predicate application `p(...)`. A predicate
**literal** is either a positive atom or a negated atom (`not p(...)`): a
positive atom tests membership in a predicate, a negated atom tests
non-membership. Negation-as-failure is subject to the polarity
constraints of Section 4.3, which is also where the `^` sigil is defined;
an atom must spell it exactly as the predicate's rules do.

```
ancestor(X, Y)           # positive literal (an atom)
not composite(X)         # negated literal
```

A predicate may be **nullary** (arity 0), written with empty parentheses
`p()` — a boolean proposition that either holds or does not. (A bare `p` is
a variable, so the parentheses are required.) Nullary predicates may be
defined by rules (`p() :- ...`) or as facts (`p().`), used positively or
negated in a body (`q() :- p(), not r().`), and queried: `?- p().` yields a
single (empty) row when `p` holds and none otherwise.

Built-in atoms (comparisons such as `X = Y` or `Age < 18`) may equally be
negated — any atom can be negated, not only predicate calls. A negated
built-in atom `not e` is negation as failure over the comparison: it holds
wherever `e` does not, including where `e` has no value. It carries no
stratification obligation, since built-ins do not recurse.

It is **not** the filter `!(e)`, which is the boolean operator and propagates
undefinedness (§5.4). The two agree wherever the operand has a value that is not
`null`, and diverge at both of the other cases: `!` is strict at a `null` and at
an absence, `not` is strict at neither. A bare `boolean?` variable is enough to
tell them apart, so the divergence does not need a compound expression.

```
not X = Y                # holds unless X = Y holds
not Age < 18             # holds unless Age < 18 holds, Age null included
not B                    # over `B: boolean?`, holds at `false` and at `null`
!B                       # holds at `false` only: no value at `null`
```

#### Equalities

```
Equality    ::= Addition '=' Expression
```

`=` is *logical* (null-aware) equality (Section 5.4). At body level
it has two roles:

- **Binding** — either side is a bare variable that has not yet been
  bound, and the other side is safe. The equality introduces that
  variable and sets it to the value of the other side. `X = Y + 1`
  and `Y + 1 = X` are therefore equivalent when `Y` is safe.
  A bare `null` literal binds like any other, `null` being an ordinary value
  with its own type (Section 5.1): `X = null` introduces `X` and binds it to
  the null.
- **Constraint** — both sides are already bound expressions. Both
  sides are evaluated and compared with logical equality; the rule
  fires when they match (including the case where both are NULL).

```
D = S * 2          # binding: D := S * 2
C = X + Y + 1      # binding: C := X + Y + 1
X + 1 = Y          # binding: Y := X + 1 when X is safe
length(W) = 3      # constraint
N = null           # binding when N is unbound: N := the null value;
                   # constraint when N is bound (matches null rows)
V = parse_json("null")   # binding: V := a JSON null, inside a value
```

The `as_*` projections do *not* serve here: `as_integer(null)` has no value, a
null being no integer, so a rule using it derives nothing (§5.7).

`=` is also a Cmp-level operator at expression level (Section 2.6),
so `B = (X = null)` parses as a binding equality whose RHS is a
logical-equality comparison. The body-level Equality form is
disambiguated from the expression-level operator by parsing the LHS
at `Addition` precedence — no realistic LHS shape (variable, function
call, arithmetic, subscript) involves a comparison.

#### Range Atoms

```
RangeAtom   ::= Expression 'in' '[' Expression '..' Expression ']'
```

A range atom either binds a fresh variable to every integer in an inclusive
range, or constrains an already-computed numeric value to lie between two
bounds. When the left-hand side is an otherwise-unbound bare variable, the
range **binds** that variable (making it safe). When the left-hand side is
already bound, or is a complex expression, the range acts as a **filter**
(BETWEEN):

```
I in [2 .. 30]                       # binds I to integers 2..30
X in [1 .. length(S) - 1]           # binds X
(A + B) in [10 .. 20]               # filters: 10 <= A+B <= 20
```

Binding ranges require integer bounds; filter ranges accept numeric
integer/float expressions and bounds (Section 5).

#### Filters

```
Filter      ::= ('not')? Expression
```

Any boolean Expression on its own line is a **filter**: the rule fires
when the expression evaluates to `true`. Comparisons (`<`, `<=`, `>`,
`>=`, `=`, `<>`) and the logical operators (`&&`, `||`, `!`) live in
the expression hierarchy (Section 2.6), so they compose freely:

A leading `not` negates the filter. The predicate-literal alternative is tried
first, so `not p(X)` stays a negated predicate literal while `not X = Y` is a
negated comparison. It is negation as failure over the expression and **not** the
filter `!(e)`: `not e` holds wherever `e` does not hold, an absence included,
while `!e` propagates the absence (§5.4). The two agree wherever the operand has
a value that is not `null`, and diverge at both of the other cases: `!` is strict
at a `null` as well as at an absence, `not` is strict at neither. This is the
negation referred to under *Literals* above.

```prolog
n(0). n(2).
neq(X) :- n(X), not (10 / X = 10 / X).   # {0}: the equality has no value there
bang(X) :- n(X), !(10 / X = 10 / X).     # no rows: `!` has no value either
```

```
Age >= 30                          # single comparison
X <> Y                             # single comparison
(S > 80) && (S < 95)               # compound filter
(N = 3) || (N = 5) || (N = 7)      # disjunction of equalities
```

A filter expression must have type `boolean` — non-boolean filters
(`X + 1`, `length(S)`) are rejected at analysis time. A filter holds only where
it is `true`: one that has no value, and one whose value is `null`, both drop
their row, same as SQL's `WHERE`. No comparison returns a `null` (§2.6), so a
`null` in filter position arrives only from a nullable `boolean?` column, and an
absence arrives from any partial expression (§5.4). The `null` case is warned
about by default (`nullable-filter`, §5.4); the absence is not, and deliberately
so. A filter *tests* rather than uses a value, so an absence and a `false` are
indistinguishable there and dropping the row is the filter doing its job. The
undefined-expression warning reports the positions that *use* a value instead
(§5.4).

### 2.6 Expressions

Expressions are used in atom arguments, equality right-hand sides,
comparisons, ranges, and rule heads. The grammar uses precedence levels:

```
Expression     ::= Conditional
Conditional    ::= Or ('?' Or ':' Conditional)?
Or             ::= And ('||' And)*
And            ::= BitOr ('&&' BitOr)*
BitOr          ::= BitXor ('|' BitXor)*
BitXor         ::= BitAnd ('^' BitAnd)*
BitAnd         ::= Cmp ('&' Cmp)*
Cmp            ::= Shift (('<' | '<=' | '>' | '>=' | '=' | CmpNeq) Shift)?
CmpNeq         ::= '<>' | '!='   (* the same operator, two spellings *)
Shift          ::= Addition (('<<' | '>>' | '>>>') Addition)*
Addition       ::= Multiplication (('+' | '-') Multiplication)*
Multiplication ::= Exponent (('*' | '/' | '%') Exponent)*
Exponent       ::= UnaryExpr ('**' Exponent)?
UnaryExpr      ::= ('-' | '!') UnaryExpr | Postfix
Postfix        ::= Primary (Subscript | Slice)*
Primary        ::= '(' Expression ')' | FunctionCall | Variable | STRING
                 | NUMBER | BOOLEAN | 'null' | ArrayLiteral | ObjectLiteral

BOOLEAN        ::= 'true' | 'false'
FunctionCall   ::= IDENT '(' Expression (',' Expression)* ')'
Subscript      ::= '[' Expression ']'
Slice          ::= '[' Expression? ':' Expression? ']'
ArrayLiteral   ::= '[' (Expression (',' Expression)*)? ']'
ObjectLiteral  ::= '{' (ObjectEntry (',' ObjectEntry)*)? '}'
ObjectEntry    ::= STRING ':' Expression
```

**Operator precedence** (highest to lowest):

1. Subscript/slice: `X[0]`, `X[1:3]`
2. Unary minus / logical not: `-X`, `!P`
3. Exponentiation: `**` (right-associative — `2 ** 3 ** 2` is `2 ** (3 ** 2)`)
4. Multiplication, division, modulo: `*`, `/`, `%`
5. Addition, subtraction: `+`, `-`
6. Bit shifts: `<<`, `>>`, `>>>`
7. Comparison: `<`, `<=`, `>`, `>=`, `=`, `<>` (`!=`)
   (non-associative — `X > Y > Z` is a parse error)
8. Bitwise and: `&`
9. Bitwise xor: `^`
10. Bitwise or: `|`
11. Logical and: `&&`
12. Logical or: `||`
13. Conditional: `c ? a : b` (right-associative, so
    `c ? a : d ? b : e` is `c ? a : (d ? b : e)`)

`**` binds tighter than the multiplicative operators but its left operand
is a unary expression, so `-2 ** 2` is `(-2) ** 2`. It is always float-
valued, with the domain guards described in §5.4. The bitwise / shift
levels mirror C and Java: shifts bind tighter than comparison, and
`&`/`^`/`|` bind looser than comparison but tighter than the logical
connectives. See §5.9 for their integer semantics.

The Datalog source uses `%` for modulo, matching the SQL `%` operator
that the translator emits. (Datamog comments use `#`, so the lexer
sees the two characters distinctly.)

#### The conditional expression

`c ? a : b` denotes `a` where `c` is true and `b` where `c` is false, as in
C. It is right-associative, which is what makes
`V < 0 ? "neg" : (V = 0 ? "zero" : "pos")` an else-if chain, and it needs no
keywords, so nothing is reserved for it.

The `:` is the sixth thing `:` does, after head annotations, column
declarations, proof captures, slices and object entries, and it does not
collide with any of them: a `?` commits the parse to the matching `:`, so
`W[c ? 1 : 2]` is a subscript whose index is a conditional and
`W[c ? 1 : 2 : 3]` is a slice from that conditional to `3`. The one shape
that does not parse is a conditional after an annotation on the same head
term, `q(X: integer ? 1 : 2)`, where the annotation has already closed the
term; write `q((c ? 1 : 2): integer)`.

Three rules complete it.

- **The condition must be `boolean`**, exactly as `!`'s operand and `&&`'s
  two must be.
- **The result's type is the join of the branches** (§5.6), so
  `c ? [1] : 2` is a `value` and the primitive branch takes the same
  lift a `value`-typed position gives it elsewhere. Two branches with no
  join, such as `integer` and `string`, are an error rather than a
  widening to `value`.
- **It is strict in the condition and lazy in the branches.** A condition
  that is a null or has no value leaves the whole conditional with no
  value, the same strictness the four orderings and the connectives have
  past their absorbing value (§5.4); the row is withheld rather than a
  branch being chosen. Only the branch the condition names is evaluated, so
  `V > 0 ? 7 : 0 / 0` has a value wherever `V > 0`.

Both branches must be non-nullable (§5.4). This is the one asymmetry worth
stating, because the condition is not: a branch is what could make the
*result* a null, and a conditional whose result could be a null and could
also have no value would need one NULL to mean both. The condition can only
ever contribute an absence, so it is free to be nullable. Narrow a nullable
branch with `<> null`, or write the two cases as two rules.

#### Boolean Operators

`&&`, `||`, and `!` are *logical* operators on `boolean` values
(matching C's `&&`/`||`/`!`, not the bitwise `&`/`|`/`~`). Operands
must be of type `boolean`; the result is also `boolean`. The
translator emits `AND`, `OR`, and `NOT` respectively.

A `null` is no truth value, so a connective handed one has **no value**, except
where the other operand dominates: `false && e` is `false` and `true || e` is
`true` whatever `e` is. Section 5.4 has the rule and its reason.

#### Comparison Operators

No comparison operator ever *yields* `null`. What each does when handed one
differs, and the difference is the value/order distinction. There is one
equality, `=` / `<>`, which is total over values and compares `null` like any
other. The orderings need an order and `null` is not in one, so they are
**strict** at it: no value, hence no tuple derived where the result is used
(§5.4).

| operator | meaning | `null` behaviour | SQL emit |
|----------|---------|----------------|----------|
| `=` | equality | `null = null` is true; `null = X` is false | `IS NOT DISTINCT FROM` (Postgres), `IS` (SQLite / sql.js) |
| `<>` (also `!=`) | inequality | inverse of `=` **over values** | `IS DISTINCT FROM` / `IS NOT` |
| `<` `>` `<=` `>=` | ordering | no value whenever either side is null | the bare operator; SQL's own NULL propagation is this rule |

In condition position a strict ordering is indistinguishable from a false one:
both drop the row, and `not` holds of both. So a filter or a negation over an
ordering behaves the same whether or not its operands can be null. Two things do
differ. `null <= null` has no value, where a total reading would have to pick
`true` or `false` and either is arbitrary. And an ordering **bound to a
variable** derives no tuple at a null, rather than binding a boolean.

Because a true ordering therefore has non-null operands, it proves them non-null,
which nullness inference uses (§5.4) and `<=` / `>=` could not do under a total
reading.

The full table, with `5` standing for any non-null value:

| left | right | `=` | `<>` | `<` | `<=` | `>` | `>=` |
|--------|--------|-------|-------|-------|-------|-------|-------|
| `5` | `5` | true | false | false | true | false | true |
| `5` | `null` | false | true | — | — | — | — |
| `null` | `5` | false | true | — | — | — | — |
| `null` | `null` | true | false | — | — | — | — |

A dash is "no value", not a third truth value: the ordering has no answer, so
whatever uses it derives nothing. `null` is simply outside the order, so neither
`X < 2` nor `X >= 2` holds of a `null` `X`, and neither does their conjunction or
disjunction. Guard with `<> null` where that matters. Over non-null values the
order is total and `a < b` is equivalent to `a <= b && a <> b`.

There is no three-valued comparison family; a second equality would be
indistinguishable from `=`.

**An operand with no value is a separate matter.** A comparison whose operand
is undefined (§5.4) does not hold, so it drops its row in filter position and
satisfies `not`. That is where `<>` and `not (=)` come apart: `a <> b` needs
both sides defined, while `not (a = b)` holds whenever `a = b` does not.

```
X <> 10 / Y          # does not hold when Y is 0: the right side has no value
not (X = 10 / Y)     # holds when Y is 0, for the same reason
X <> null            # ordinary value comparison; both sides are defined
```

```
Age >= 30                             # ordering
X <> Y                                # inequality
X = Y                                 # equality (null-aware)
N = null                              # matches null rows
N <> null                             # matches non-null rows
B = (Score = 100)                     # bind B to a boolean
```

Operands must have compatible types (same type, or `integer`/`float`
joining via Section 5.6). The `null` literal composes with any operand type
in a **comparison**, `X <> null` being the guard the language expects, but
not in an arithmetic or string operation: `null + 1` is a type error, since a
`null` is not a number and, being statically `null`, can never be narrowed to
one (Section 5.4). Booleans support equality only
(set equality is well-defined) but ordering operators reject them.
String ordering is lexicographic by Unicode code point, independent
of backend locale.

Comparisons are non-associative — `X > Y > Z` is a parse error
rather than a misleading `(X > Y) > Z`. Use `&&` to combine:
`(X > Y) && (Y > Z)`.

Body-level Equality (Section 2.5) reuses `=` and additionally binds
an unbound bare variable on either side. The expression-level `=`/`<>`
operators are pure comparisons.

#### Subscript and Slice

Subscript extracts a single character (zero-indexed):

```
W[0]          # first character of W
S[I]          # character at position I
```

Slice extracts a substring. Both bounds are optional:

```
W[1:3]        # characters at positions 1 and 2  (start inclusive, end exclusive)
W[:3]         # first 3 characters (from start)
W[2:]         # from position 2 to end
W[:]          # the whole string
```

Subscript and slice on a `string` receiver always produce `string` values.
On a `value` receiver, both produce `value` (see §2.9).

Index conventions:

- Indices are zero-based integers (with one exception: a `value` whose
  shape is an object is indexed by a `string` key — see §2.9).
- In a slice `W[i:j]`, the result is empty (`""` for string, `[]` for
  array `value`s) when `i >= j`; the substring / sub-array never wraps
  around.
- Omitted bounds default to the start (`i = 0`) or end (`j = length(W)`
  for string, the array length for `value`).
- Negative integer literals (`W[-1]`, `W[0:-1]`, `W[:-1]`) are
  rejected by the analyser. Variable-valued indices pass through —
  the analyser can't prove them non-negative statically.
- Indices beyond the receiver length produce `""` / `[]` for string /
  array-`value` slices and `""` for string subscripts (the receiver's
  empty value). A `value` subscript that falls out of range has **no
  value**, exactly as a missing key does (§5.4).

> **Cross-backend variance.** Strings containing an embedded NUL
> character (`U+0000`, reachable via `parse_json("\"\\u0000\"")`) are
> not portable. `length`, subscript, and slice count Unicode code
> points on the native/seminaive backends, but SQLite/sql.js treat a
> NUL as a C-string terminator (so `length` and `SUBSTR` stop there),
> and PostgreSQL's `text`/`jsonb` cannot store `U+0000` at all. Avoid
> embedded NULs in string data if cross-backend behaviour matters.

#### Function Calls

Only the following built-in functions are allowed. Using an unknown
function name is an analyzer error.

**String functions:**

| Datamog              | SQL                  | Return type |
|----------------------|----------------------|-------------|
| `length(x)`        | `LENGTH(x)`        | `integer`   |
| `upper(x)`           | `UPPER(x)`           | `string`      |
| `lower(x)`           | `LOWER(x)`           | `string`      |
| `trim(x)`            | `TRIM(x)`            | `string`      |
| `replace(s,old,new)` | `REPLACE(s,old,new)` | `string`      |

`upper` and `lower` case-fold ASCII letters only; non-ASCII code points are
left unchanged so programs do not depend on backend locale or Unicode tables.

**Math functions:**

| Datamog              | SQL                  | Return type           |
|----------------------|----------------------|-----------------------|
| `abs(x)`             | `ABS(x)`             | same as `x`           |
| `round(x)`           | `ROUND(x)`           | `integer`             |
| `round(x, n)`        | `ROUND(x, n)`        | same as `x`           |
| `floor(x)`           | `FLOOR(x)`           | `integer`             |
| `ceil(x)`            | `CEIL(x)`            | `integer`             |
| `sqrt(x)`            | `SQRT(x)`            | `float`                |
| `ln(x)`              | `LN(x)`              | `float`                |
| `exp(x)`             | `EXP(x)`             | `float`                |
| `x ** y`             | guarded `POWER(x, y)` (see §5.4) | `float`    |

`round`'s arity-2 form preserves the input domain: `round(integer, integer)`
stays integer, `round(float, integer)` stays float. Positive `n` rounds to
that many fractional digits; negative `n` rounds to tens, hundreds, and so
on. Arity-1 always returns integer (rounding to the nearest whole number).

All listed functions are portable across PostgreSQL and SQLite (and sql.js,
which uses SQLite's JSON1 implementation).

```
contribution(C, X) :- prob(C, P), X = -1.0 * P * ln(P) / ln(2).
```

**Primitive conversions:**

| Datamog              | Argument types          | Return type | Notes                                      |
|----------------------|-------------------------|-------------|--------------------------------------------|
| `to_string(x)`       | `integer`/`float`/`boolean` | `string`   | Decimal string for numbers; `'true'`/`'false'` for booleans. |
| `to_integer(s)`      | `string`                  | `integer`   | Strict canonical decimal. No value on parse failure. |
| `to_float(s)`         | `string`                  | `float`      | Strict canonical decimal (no exponent). No value on parse failure. |
| `to_boolean(s)`      | `string`                  | `boolean`   | Accepts exactly `'true'` / `'false'`. No value otherwise. |
| `parse_json(s)`      | `string`                  | `value`     | Parse `s` as JSON syntax. No value on malformed input. |

The string → number parsers accept only canonical decimal form: optional
`-`, no leading zeros (except plain `0`), no leading `+`, no whitespace.
`to_integer` additionally requires the result to be in
`[-(2^53 - 1), 2^53 - 1]`. `to_float` accepts an optional `.<digits>`
fraction; exponent forms (`1e10`) are rejected.

```
parsed_int(R, N)   :- raw(R), N = to_integer(R).
parsed_real(R, N)  :- raw(R), N = to_float(R).
formatted(N, S)    :- numbers(N), S = to_string(N).
# Auto-lift fires anywhere a `value` slot meets a primitive — no
# explicit primitive-to-value conversion is needed.
```

Identity casts (`to_string("hi")`, `to_integer(42)`, etc.) are rejected
at type-check — the value is already in the target type. Number-to-
number conversions are intentionally absent: `integer` widens to `float`
implicitly, and `floor`/`ceil`/`round` cover the `float → integer`
direction.

> **Cross-backend variance.** `to_string` of an integer-valued float
> (`1.0`) renders as `'1'` on PostgreSQL and the native evaluator
> (matching JS `String(1.0)`) but as `'1.0'` on SQLite/sql.js, which
> always pads integer reals with a trailing `.0`. Programs that need
> bit-identical string on every backend should round to integer first
> (`to_string(round(x))`).

#### String Concatenation

The `+` operator, when either operand has type `string`, translates to SQL
string concatenation (`||`):

```
prefixed(R) :- words(W), R = "hello_" + W.
```

The other operand must be numeric or `string`. A `boolean` or a `value` is
rejected rather than rendered, because the backends disagree on how to render
one (SQLite gives `1` for a boolean, the interpreter `true`).

### 2.7 Aggregates

```
AggregateCall ::= IDENT '(' (Expression | '*') ')'
```

The `*` wildcard is accepted only by `count` (see below).

where `IDENT` is one of: `count`, `sum`, `avg`, `min`, `max`,
`concat`, `list`.

Aggregates may appear only in **rule heads**, never in a rule body. Within a
head an aggregate may sit anywhere inside an argument's expression, so a head
argument is a **grouping column** when it contains no aggregate *and* is not
constant. Grouping columns become the GROUP BY columns of the generated SQL.

An argument is **constant** when it is a literal of any kind — string, number,
boolean or `null` — or a negated numeric literal, or a variable the body binds to
one of those with an equality. `null` is included for the same reason as the
others: it is an ordinary value written as an ordinary literal, and it does not
vary per group. A constant is not grouped by, so the two spellings mean the same
thing:

```
totals("all", sum(V)) :- s(V).
totals(G, sum(V)) :- s(V), G = "all".     # the same predicate
```

An expression that merely happens to be constant, such as `G = 2 + 3`, is not
constant in this sense and is a grouping column.

```
student_avg(Student, avg(Score)) :- scores(Student, _, Score).
#           ^^^^^^^ grouping      ^^^^^^^^^^^ aggregate

record_count(count(*)) :- scores(_, _, _).
#            ^^^^^^^^^ count with no grouping columns

var_index(Name, count(Other) - 1) :- varname(Name), varname(Other), Other <= Name.
#         ^^^^ grouping   ^^^^^^^^^^^^^^^^ an aggregate inside an expression
```

Two rules constrain what may sit beside an aggregate.

An aggregate's own argument may not contain another aggregate: there is one
group to reduce over, not two.

Outside the aggregates, an argument that contains one may mention only
**grouping variables**. Every other variable has no single value within the
group, so there is nothing for the expression to denote:

```
# rejected: grouping is {X}, so Y has no one value per group
bad(X, sum(S) + Y) :- scores(X, S, Y).
```

**Over a group with no defined contributions**, each aggregate folds to its
identity where the domain has one, and has **no value** where it does not:

| aggregate | identity | empty group |
|---|---|---|
| `count(*)`, `count(e)`, `sum(e)` | `0` | `0` |
| `concat(e)` | `""` | `""` |
| `list(e)` | `[]` | `[]` |
| `avg(e)`, `min(e)`, `max(e)` | none in the domain | undefined |

An aggregate with no value withholds its tuple, like any other undefined head
expression (§5.4). So a rule with no grouping columns derives one tuple when
every one of its aggregates has an identity, and none otherwise; a rule with at
least one grouping column derives nothing over empty input either way, there
being no group to reduce. Constants take their own values.

```
totals(count(*)) :- s(_).            # s empty: derives (0)
totals("all", count(*)) :- s(_).     # s empty: derives ("all", 0)
totals(G, count(*)) :- s(G).         # s empty: derives nothing
totals(min(X)) :- s(X).              # s empty: derives nothing, min having no identity
totals(count(*), min(X)) :- s(X).    # s empty: derives nothing, one undefined position
                                     # withholding the tuple
```

That last line is the cost of the rule: a `count` sharing a head with a `min`
becomes unobservable over empty input, and the two have to be split to see both.

**A row whose aggregate argument has no value** contributes to no aggregate
mentioning that argument, and still counts for `count(*)`. So an argument that is
undefined on every row of a group leaves that group with no contributions, which
is the case the table above covers.

The argument `*` is a wildcard accepted only by `count`: `count(*)` counts
every row in the group. Given an expression, `count(expr)` counts the rows in
which `expr` **has a value**, and a `null` is a value, so nulls are counted. This
departs from SQL's `COUNT(col)`, which skips them; `COUNT(col)` is the right rule
for an *undefined* contribution and the wrong one for a `null`, and Datamog now
distinguishes those. Neither form counts
_distinct_ values: an aggregate sees one value per row (a multiset), so a value
that occurs in several rows is counted several times. This holds for `sum` and
`avg` too, and is what makes them useful — the relation is a set of rows, but
the values fed to the aggregate are a bag.

**Aggregate functions:**

| Function         | SQL                          | Return type          |
|------------------|------------------------------|----------------------|
| `count(expr)`    | `COUNT(expr)` / `COUNT(*)`   | `integer`            |
| `sum(expr)`      | `SUM(expr)`                  | same as `expr`       |
| `avg(expr)`      | `AVG(expr)`                  | `float`               |
| `min(expr)`      | `MIN(expr)`                  | same as `expr`       |
| `max(expr)`      | `MAX(expr)`                  | same as `expr`       |
| `concat(expr)` | dialect-specific         | `string`               |
| `list(expr)`     | dialect-specific             | `value`                |

`concat` translates to `GROUP_CONCAT(expr, ',' ORDER BY expr)` on
SQLite/sql.js and `STRING_AGG(expr::TEXT, ',' ORDER BY expr)` on
PostgreSQL. The native evaluator sorts the per-group values
the same way before joining. Output is therefore deterministic and
identical across every backend: numeric values come out in numeric
order (`"2,7,10"`, not `"10,2,7"`), strings in Unicode-code-point
lexicographic order.

`list(expr)` collects values into an array `value`. Primitive
arguments are auto-lifted to a `value` (`integer` / `float` → number
leaf, `string` → string leaf, `boolean` → `true` / `false` leaf);
already-`value` arguments pass through unchanged.

Per-element order depends on the argument's type:

- **Primitive arguments** sort by their natural SQL value — numeric
  for numbers, Unicode-code-point lexicographic for strings,
  false-before-true for booleans. So `list(N)` over integers `2`, `10`, `7` produces
  `[2, 7, 10]`, not the lex-ordered `[10, 2, 7]`.
- **`value` arguments** sort by their canonical-text form (object
  keys in canonical JSON order, no whitespace), compared with the
  same Unicode-code-point string order used for `string` arguments.
  The natural jsonb / TEXT-storage ordering of objects and arrays
  diverges between backends, so the canonical form is the only stable
  cross-backend choice.

In both cases the same program produces the same array on every
backend. A `null` input is collected like any other value and sorts before all
of them, whatever the argument's type; the array therefore has one element per
row whose argument is defined, so `length(list(V))` equals `count(V)`. Only an
*undefined* contribution is left out, and a group with none left to collect
yields `[]`, append's identity, rather than a null.

`list` is the closest the language gets to a list comprehension:
build a per-row value in a non-aggregate rule (a primitive
expression or an array / object literal), then aggregate it.

```
records(Student, {"subject": Subject, "score": Score}) :-
    scores(Student, Subject, Score).
all_records(Student, list(R)) :- records(Student, R).

# Primitive auto-lift — collect every score per student as an
# array of numbers.
all_scores(Student, list(Score)) :- scores(Student, _, Score).
```

### 2.8 Don't-Care Variable

The anonymous variable `_` may appear anywhere a variable is expected.
Each occurrence is internally renamed to a unique synthetic variable, so
multiple uses of `_` are independent. User-written variables such as `_0` or
`_X` are still ordinary variables:

```
composite(X) :- divides(_, X).    # _ is an independent unnamed variable
record_count(count(*)) :- scores(_, _, _).   # four independent _'s
```

### 2.9 Value Operations

Datamog has a `value` column type — every JSON shape a column
can carry: primitive leaves (`boolean`, `integer`, `float`,
`string`) plus the two structured shapes (arrays and objects).
A `null` may appear anywhere *inside* one; a `value` that is
itself a bare `null` needs the nullable spelling `value?`,
`?` meaning the same on `value` as on any other base type
(§1.5). When persisted, `value` columns are
stored as JSONB (Postgres) or canonical JSON text (SQLite /
sql.js); when constructed in a program, the array and object
literal forms `[e1, e2, ...]` and `{"k1": v1, "k2": v2, ...}`
are visually JSON-like but produce native `value`s, not
strings. The name "JSON" in this section is reserved for the
syntax (parser-level) and the on-the-wire / on-disk
representation; in the language proper the type is `value`.

Programs can both **destructure** existing `value`s
(subscript, slice, iterate, coerce to primitives) and
**construct** new ones from primitives (auto-lift), from
text (`parse_json`), or from array and object literals.
The finiteness checker (§5.8) flags recursions that loop a
constructed value back through any of these constructors as
potentially-infinite, since these are the mechanisms that
can grow an unbounded family of compounds.

#### Sources

A `value`-typed expression reaches a rule body in one of
these ways:

1. **A `value`-typed EDB column.** Declared via
   `input predicate p(col1: value, ...).` and populated via the JSONL
   loader (with the single-`value`-column special case in §7.2)
   or the standalone JSON loader (§7.5).
2. **Subscript** `X[K]` where `X : value`. Returns `value`.
   - When `K : integer`, looks up an array element.
   - When `K : string`, looks up an object key.
   - Out-of-range index, missing key, or wrong-shape receiver
     (object indexed with integer / array indexed with string /
     anything on a primitive leaf) → **no value** (§5.4).
   - A key that is *present* and holds a JSON `null` → the `null` value.
     A missing key and a `null`-valued key are therefore distinguishable,
     which is what reserving SQL `NULL` for "no value" buys.
3. **Slice** `X[I:J]` where `X : value`. Returns `value`.
   - Operates on arrays only; slicing a non-array → **no value**.
   - Empty / reversed range (`I >= J`) → `[]`.
4. **Iteration primitives** (built-in body atoms — see below).
5. **Coercion / introspection builtins** (see below).
   `as_string` / `as_integer` / `as_float` / `as_boolean` /
   `length` / `type_of` / `has_key` read leaf primitives or summarise
   structure; `parse_json` produces a `value` from a JSON
   syntax string (no value on malformed input).
6. **Auto-lift.** A primitive expression flowing into a
   `value` slot is lifted automatically — see "Primitive ↔
   value auto-lift" below.
7. **Array and object literals.** `[e1, e2, ...]` constructs
   an array; `{"k1": v1, "k2": v2, ...}` constructs an object
   whose keys are written as string literals. Element / value
   expressions of any primitive type are auto-lifted, so a
   literal can mix integers, strings, booleans, already-value
   expressions, and `null` directly. The literals are emitted
   via each backend's `jsonb_build_*` / `json_array` /
   `json_object` primitive — no string round-trip is involved.
   If the same object-literal key appears more than once, the last
   occurrence wins before canonicalisation.

#### Iteration primitives

Two built-in body atoms walk a `value` as a stream of
`(key, value)` or `(index, value)` pairs:

```prolog
object_entry(O, K, V)   # K : string, V : value — one row per object entry
array_element(A, I, V)  # I : integer, V : value — one row per array element
```

The first argument (the source) is a `value` slot and its
variables must already be safe (bound by another body atom or
range — same rule as range atoms). Primitive source expressions
auto-lift to `value` leaves; since leaves are neither objects nor
arrays, iterating them yields zero rows. The other two positions
bind their variables when those are bare variables; non-variable
expressions become equality constraints against the iterated
key/value. Iterating a `value` of the wrong shape (`object_entry`
on an array, `array_element` on an object, anything on a
primitive leaf) yields zero rows.

Built-in body-atom names (`object_entry`, `array_element`) are
reserved: they cannot be declared as `input predicate` or defined
as IDB. Negation of a built-in body atom is rejected.

#### Coercion and introspection

Functions over `value` (plus `length`, which is also available for
strings). Most take one argument; `has_key(V, K)` also takes a string
key. The coercion/projection functions have **no value** on a shape
mismatch (§5.4); there is no implicit conversion. `has_key` instead answers
`false` for non-object values and absent keys, a `null` receiver included: a
`value` parameter accepts `null` as one of the shapes it holds, so a `null`
there is an argument rather than an absence. `parse_json` parses a string as
JSON syntax, having no value on malformed input rather than raising, and
parsing a bare `null` to the `null` value.

| Datamog          | Returns   | Behaviour                                                          |
|------------------|-----------|--------------------------------------------------------------------|
| `as_string(V)`   | `string`  | string-leaf → string content; anything else, `null` included → no value. |
| `as_integer(V)`  | `integer` | Integer-valued numeric leaf in JS safe-integer range (±(2^53−1)) → integer; anything else (including a numeric leaf with a fractional part) → no value. |
| `as_float(V)`    | `float`   | Numeric leaf → float; anything else → no value.                    |
| `as_boolean(V)`  | `boolean` | Boolean leaf → boolean; anything else → no value.                  |
| `length(V)`      | `integer` | Array length / object key count / string length; non-collection, `null` included → no value. |
| `type_of(V)`     | `string`  | One of `"object"`, `"array"`, `"string"`, `"number"`, `"boolean"`, `"null"`. Answers for a `null` rather than propagating it, that being the question it exists to answer. No value only where `V` has none. |
| `has_key(V, K)`  | `boolean` | Object has own string key `K` → `true`; missing key or non-object `V`, `null` included → `false`. |
| `defined(E)`     | `boolean` | `true` where `E` has a value, no value where it does not, never `false`. Takes any base type, and takes a nullable operand where other operations reject one. Usable as a bare body condition, `not defined(E)` included. `defined(X)` on a bare variable is always `true`, not `X <> null`. See §5.4. |
| `keys(V)`        | `value`   | Sorted array of the object's keys (each as a string; Unicode-code-point order); empty object → `[]`; non-object → no value. |
| `values(V)`      | `value`   | Array of the object's values, ordered by key in Unicode-code-point order; empty object → `[]`; non-object → no value. |
| `to_json(V)`     | `string`  | Canonical JSON text for canonical `value`s (object keys in canonical JSON order, no whitespace), safe as a hash / dedup key. |
| `parse_json(s)`  | `value`   | Parse `s` as JSON syntax. No value on any malformed input, matching `to_integer` / `to_float` / `to_boolean`. A bare `null` parses to the `null` value. |

#### Equality and ordering

`value` operands are compared by structural equality:

- `=` and `<>` (equality / inequality) are allowed.
- `<`, `<=`, `>`, `>=` are **rejected** at type-check (cross-
  backend ordering on `value` does not agree).

#### Primitive ↔ value auto-lift

A primitive (`integer`, `float`, `string`, `boolean`) is
auto-lifted to its `value` form anywhere a `value` slot meets a
primitive expression:

- **Atom args** matching a `value`-typed column: `t(5)` over
  `input predicate t(j: value)` matches rows where the column's
  contents are the numeric leaf `5`.
- **Equality** (`=`, `<>`): `J = 5` where `J : value` matches rows
  where `J` is the numeric leaf `5`.
- **Function arguments** whose parameter type is `value`:
  `type_of(5)`, `as_integer(5)`, and `to_json("hi")` are accepted
  by embedding the primitive argument first.
- **Iteration sources**: `object_entry(X, K, V)` accepts primitive
  `X` values after auto-lift; primitive leaves simply produce zero
  rows because there is no object to iterate.
- **IDB column unification**: sibling rules contributing
  primitive and `value` head terms unify upward to `value`; the
  primitive branch's emission lifts via the dialect's
  `to_jsonb` / `json_quote` / equivalent so every UNION member
  produces JSONB / canonical-TEXT JSON.

The lift is automatic and runtime-cheap (a single `to_jsonb` /
`json_quote` / `CAST` call per emission site). Since auto-lift
covers every site that demands a `value`, an explicit
"primitive-to-value" function is no longer part of the surface
language — the lift fires implicitly wherever it would have
been needed.

The lift **does not** apply to ordering comparisons (`<`, `<=`,
`>`, `>=`). `value` has no cross-backend ordering, so the
rejection there is the language-level guarantee, not an emission
detail.

#### Cross-backend invariants

`value`s are canonicalised on insert: object keys are sorted
recursively in canonical JSON order, numbers are normalised via
`JSON.parse`/`JSON.stringify`. This makes textual equality
coincide with structural equality on SQLite / sql.js (which
store the type as canonical TEXT). PostgreSQL's `jsonb`
canonicalises natively.

Canonical JSON key order follows PostgreSQL `jsonb`: UTF-8 byte
length first, then byte value. This is distinct from Datamog's
Unicode-code-point string comparison order used by `<` / `>` and
by `keys(V)` / `values(V)`.

`parse_json` canonicalises parsed object keys into this same order, so
values parsed from text join and deduplicate with equivalent values from
EDB loaders, object literals, and other backends.

A JSON `null` leaf is the `null` **value** and is kept as such: inside a
`value` it is stored the JSON way, as `'null'::jsonb` on Postgres and the
canonical text `null` on SQLite / sql.js, never as SQL `NULL`. That is
required rather than incidental, because a `value`-typed expression can be
both undefined and `null`-valued and SQL has only one `NULL` to say it with,
so SQL `NULL` there is reserved for "no value" (§5.4).

So `type_of(parse_json("null"))` and `type_of(J["key"])` for a `null`-valued
key both return the string `"null"`, and a key that is *missing* has no value
at all and withholds its row. Earlier versions of Datamog collapsed the two,
and could not express the distinction.

JS `Number` precision (IEEE doubles, 2⁵³) caps integer fidelity
for numeric leaves — values larger than 2⁵³ may round through
canonicalisation. This is the same constraint that already
applies to `integer`-typed columns elsewhere in Datamog.
Non-finite numeric leaves produced by host JSON parsers (for example
`9e999` overflowing to IEEE `Infinity`) are rejected: `parse_json` has no
value for the whole input, so the row is withheld.

### 2.10 Integrity Constraints

```
Constraint  ::= '!-' BodyElement (',' BodyElement)* '.'
```

An **integrity constraint** is a predicate whose extension must be empty. Its
tuples are counterexamples: if it derives any, the program is in violation. Two
forms express the same thing.

An **anonymous constraint** is written `!-` followed by a conjunction, exactly
the shape of a query (§2.4), and with the same implicit projection — every
distinct non-anonymous variable in the body becomes one column of the reported
counterexample:

```
!- order(Id, Cust), not customer(Cust).      # every order has a known customer
!- person(_, Age), Age < 0.                  # no negative ages
```

A **named constraint** is a rule prefixed `error predicate`. It defines its
predicate exactly like any other rule and additionally asserts that the
predicate is empty:

```
error predicate orphan_order(Id, Cust) :- order(Id, Cust), not customer(Cust).
```

The two differ only in whether the constraint has a name. Prefer the named form
when the constraint deserves one in the violation message, when several rules
contribute alternative violation shapes, or when other rules read it; prefer
`!-` for a one-off assertion.

Give a constraint arguments even though nothing reads them: the projected
columns are what a violation reports, so `error predicate bad(Id)` names the
offending `Id` while a nullary `error predicate bad()` says only that something
is wrong. A **ground constraint** (one with no projected variables, as in
`!- order(1, "alice").`) is permitted and reports a witness-free row.

Constraints are otherwise ordinary intensional predicates: they may be
recursive, use aggregates and negation, carry head type annotations (§5.10),
and be referenced from other rules. They may not be maximal: a `^` sigil on a
constraint's own name is an error, since ⊤ is never materialised (§4.3). Nothing about the marker changes how the
predicate is evaluated or how it is compiled (§6) — only what happens to a
non-empty result. See §4.7 for when constraints are checked, and §9 for how a
module's constraints reach its importer.

## 3 Formal Grammar

For reference, the complete grammar in BNF notation:

```
Program        ::= Statement*

Statement      ::= TypeAlias | ExtDecl | Rule | Query | Constraint

ExtDecl        ::= 'input' 'predicate' Identifier '(' ColumnDecl (',' ColumnDecl)* ')' (':=' Binding)? '.'
ColumnDecl     ::= Identifier (':' (PrimitiveType | StructuralType | Identifier))? ('?')?
StructuralType ::= '{' (TypeField (',' TypeField)*)? '}' | '[' TypeValue ']'
TypeField      ::= (Identifier | StringLiteral) '?'? ':' TypeValue
TypeValue      ::= (PrimitiveType | StructuralType | Identifier) '?'?
TypeAlias      ::= 'type' Identifier '=' TypeValue '.'
PrimitiveType  ::= 'string' | 'integer' | 'float' | 'boolean' | 'value' | 'null'
Binding        ::= (Identifier? 'from' STRING ('(' Actual (',' Actual)* ')')?)   -- module
                 | (STRING ('as' Identifier)?)                                    -- data file
Actual         ::= Identifier '=' Identifier

Rule           ::= (('output' | 'error') 'predicate')? HeadAtom
                   ('::' Identifier ('(' (Expression (',' Expression)*)? ')')?)?
                   (':-' BodyElement (',' BodyElement)*)? '.'
HeadAtom       ::= Identifier '^'? '(' (HeadTerm (',' HeadTerm)*)? ')'
HeadTerm       ::= (AggregateCall | Expression)
                   ( 'as' Identifier (':' TypeValue)?
                   | ':' (TypeValue | Expression) )?
AggregateCall  ::= IDENT '(' (Expression | '*') ')'

Query          ::= '?-' BodyElement (',' BodyElement)* '.'
Constraint     ::= '!-' BodyElement (',' BodyElement)* '.'

BodyElement    ::= Literal | Equality | RangeAtom | Filter
Literal        ::= Identifier ':' ('not')? Identifier '^'? ArgList?   -- proof capture
                 | ('not')? Atom
Atom           ::= Identifier '^'? ArgList
ArgList        ::= '(' (Expression (',' Expression)*)? ')'
Equality       ::= Addition '=' Expression
RangeAtom      ::= Expression 'in' '[' Expression '..' Expression ']'
Filter         ::= ('not')? Expression

Expression     ::= Conditional
Conditional    ::= Or ('?' Or ':' Conditional)?
Or             ::= And ('||' And)*
And            ::= BitOr ('&&' BitOr)*
BitOr          ::= BitXor ('|' BitXor)*
BitXor         ::= BitAnd ('^' BitAnd)*
BitAnd         ::= Cmp ('&' Cmp)*
Cmp            ::= Shift (CmpOp Shift)?
CmpOp          ::= '<' | '<=' | '>' | '>=' | '=' | '<>' | '!='
Shift          ::= Addition (('<<' | '>>' | '>>>') Addition)*
Addition       ::= Multiplication (('+' | '-') Multiplication)*
Multiplication ::= Exponent (('*' | '/' | '%') Exponent)*
Exponent       ::= UnaryExpr ('**' Exponent)?
UnaryExpr      ::= ('-' | '!') UnaryExpr | Postfix
Postfix        ::= Primary (('[' Expression ']')
                          | ('[' Expression? ':' Expression? ']'))*
Primary        ::= '(' Expression ')' | FunctionCall
                  | Variable | STRING | NUMBER | BOOLEAN | 'null'
                  | ArrayLiteral | ObjectLiteral | '*'
BOOLEAN        ::= 'true' | 'false'
FunctionCall   ::= (Identifier '::')? IDENT '(' (Expression (',' Expression)*)? ')'
ArrayLiteral   ::= '[' (Expression (',' Expression)*)? ']'
ObjectLiteral  ::= '{' (STRING ':' Expression (',' STRING ':' Expression)*)? '}'
Identifier     ::= IDENT | QUOTED_IDENT
Variable       ::= Identifier
```

`Cmp` is non-associative — `X > Y > Z` is a parse error rather than
a misleading `(X > Y) > Z`. `=`/`<>` is the only equality
(Section 2.6 / 5.4); the LHS of body Equality
is parsed at `Addition` precedence so `D = X * 2` reliably parses
as a binding rather than a Cmp filter. A body element that doesn't
match Literal / Equality / RangeAtom falls through to Filter, whose
expression must have boolean type (checked post-parse).

**Terminals:**

```
IDENT           ::= /[a-zA-Z_][a-zA-Z0-9_]*/
QUOTED_IDENT    ::= /`(\\.|[^`\\\n\r])+`/
STRING    ::= /"(\\.|[^"\\])*"/
NUMBER    ::= /0[bB][01]+|[0-9]+(\.[0-9]+)?/
COMMENT   ::= /#[^\n\r]*/          (ignored)
WS        ::= /[\t\r\n ]+/         (ignored)
```

## 4 Semantic Rules

### 4.1 Variable Safety

A rule is **safe** if every variable that appears in the head, in a negated
atom, in a comparison, in an equality, or in range bounds is grounded by
the rule body. A variable is **safe** (grounded) if:

1. It appears as a direct argument of a positive (unnegated) body atom, or
2. It is a bare-variable side of an equality whose other side's variables
   are all safe, or
3. It is bound via a range atom `V in [low .. high]` where all variables in
   `low` and `high` are safe.

Safety is computed by fixed-point iteration: start with variables from
positive atoms, then repeatedly propagate through equalities and ranges
until no new variables become safe.

**Safe:**

```
foo(X, Z) :- bar(X, Y), Z = Y + 1.    # X, Y safe from bar; Z safe via equality
foo(X, Z) :- bar(X, Y), Y + 1 = Z.    # same binding with equality reversed
squares(X, Y) :- X in [1 .. 10], Y = X * X.   # X safe from range; Y safe via equality
```

**Unsafe:**

```
foo(X) :- bar(X), Y > 10.             # ERROR: Y is not grounded
foo(X) :- not bar(X, Y).              # ERROR: Y in negation must be safe
```

### 4.2 Arity Consistency

- All rules for the same predicate must have the same arity (number of
  head arguments).
- All uses of a predicate (in rule bodies and queries) must match its
  declared arity.

### 4.3 Stratification and polarity

Every predicate has a **polarity**. A predicate whose name carries the postfix
`^` sigil is **maximal**; every other predicate is **minimal**, which is the
default. The sigil is written at every occurrence of the name -- input declarations,
rule heads, body literals, and queries -- and all of them must agree, since the definition
claims the polarity and each call site repeats the claim. It is not part of the
name: `bad` and `bad^` cannot be two predicates, module wiring and constructor
qualifiers use the bare name, and only labels (query output, `--all`, the REPL)
show the sigil.

Within one strongly connected component of the dependency graph:

- a **positive** body atom must name a predicate of the **same** polarity;
- a **negated** body atom must name one of the **opposite** polarity.

Outside an SCC there is no restriction: negation across strata is unrestricted,
and a later stratum may read a maximal predicate positively.

With no sigil anywhere the second rule can never be satisfied, so this
degenerates to classical **stratified negation**: negation may not occur within
an SCC.

**Allowed** (stratified, no sigil needed):

```
reachable(X) :- edge("a", X).
reachable(X) :- edge(Y, X), reachable(Y).
frontier(X) :- reachable(X), not has_outgoing(X).
# frontier depends negatively on has_outgoing, but has_outgoing does not
# depend on frontier.
```

**Forbidden** (one negation around the cycle):

```
p(X) :- not q(X).
q(X) :- not p(X).     # ERROR: same polarity on both ends of a negated call
```

**Allowed** (parity-stratified: two negations around the cycle):

```
constant(E) :- literal(E).
constant(E) :- composite(E), not has_nonconstant_child^(E).
has_nonconstant_child^(E) :- child(E, C), not constant(C).
```

The rules above are local, but they imply the global condition: following a
cycle flips polarity exactly at its negated edges, and returning to the start
takes an even number of flips. A cycle may therefore cross only an even number
of negations, and the sigil additionally records *which* side starts at ⊤.

**Semantics.** A stratum holding both polarities is evaluated by an
**alternating fixed point**. Write `U` for the tuples of its minimal
predicates and `V` for those of its maximal predicates:

```
V₀ = ⊤                     every maximal predicate holds of every tuple
U₁ = lfp F(·, V₀)          minimal side, maximal side frozen
V₁ = lfp G(U₁, ·)          maximal side, minimal side frozen
U₂ = lfp F(·, V₁)
...
```

`U` increases and `V` decreases; iteration stops when `V` stops changing, at
which point `U` is already at its fixed point for that `V`. Both sides are
*least* fixed points within a round, so positive recursion inside the maximal
class means what it always does; `^` sets a predicate's starting value, it does
not make it a greatest fixed point.

`⊤` is never materialised. The polarity rules guarantee that the only atoms
which can observe a maximal predicate at `⊤` are negated ones, and those simply
fail, so no rule ever enumerates it. Variable safety (§4.1) is therefore
unchanged: every positive body atom still reads a finite relation.

The choice of which side carries the sigil is a modelling decision, not a
detail. Both assignments satisfy the parity condition and they generally
compute different answers, the minimal side being the one that must prove
itself. See `examples/purity`.

A sigil on a predicate whose SCC holds only one polarity has no effect, since
nothing reads it at `⊤`. It is accepted and reported as a warning.

Parity-stratified strata are rejected by every SQL backend (§6.1) and run on
`native` and `seminaive`.

### 4.4 Recursion

A predicate is **recursive** if it belongs to a non-trivial strongly
connected component (SCC) in the dependency graph, or it has a self-loop
(a rule whose body references itself). Recursive predicates are compiled
to recursive SQL views using `WITH RECURSIVE`.

A predicate is **non-linearly recursive** if some rule for a predicate in
its SCC has more than one body atom referring to predicates in the same SCC:

```
# Linear recursion (one self-reference per rule):
tc(X, Y) :- edge(X, Y).
tc(X, Z) :- edge(X, Y), tc(Y, Z).

# Non-linear recursion (two self-references):
tc(X, Z) :- tc(X, Y), tc(Y, Z).
```

Non-linear recursion is rejected by every SQL backend: PostgreSQL,
SQLite, and sql.js all reject non-linearly recursive predicates at
translation time, because their `WITH RECURSIVE` semantics would
silently miss derivations that combine an "old" tuple with a "new"
one. The non-SQL `native` and `seminaive` evaluators accept it —
their delta-aware iteration fires every recursive rule once per
recursive body atom with that atom reading from the previous
iteration's delta, computing the correct fixed point.

**Mutually recursive** predicates (predicates that depend on each other)
are compiled together into a shared recursive CTE block.

A **parity-stratified** predicate is recursive through an even number of
negations (§4.3). Its stratum is evaluated by an alternating fixed point rather
than a single least fixed point, which no SQL dialect can express, so the SQL
backends reject it and the `native` / `seminaive` evaluators run it.

### 4.5 Aggregate Constraints

1. **No recursion:** A predicate with aggregate functions in its head cannot
   be recursive.
2. **Consistency:** All rules for the same predicate must agree on which
   head positions are aggregates and which are grouping columns.
3. **No nesting:** Aggregate calls may not contain other aggregate calls.
4. **No facts:** A rule with an aggregate in its head must have a body.
5. **Same function:** Sibling rules must agree on which aggregate function
   occupies an aggregate position, not merely that the position aggregates.
   Both this and rule 2 are judged on the whole head term, so `count(X)` and
   `count(X) - 1` agree, while `count(X) - 1` and `sum(X) - 1` do not.
6. **Name conflict:** A predicate name cannot be the same as an aggregate
   function name (`count`, `sum`, `avg`, `min`, `max`, `concat`, `list`).

### 4.6 Predicate Uniqueness

- A predicate cannot be declared as both extensional (EDB) and intensional
  (IDB).
- Extensional declarations may not be duplicated.
- All rules for one predicate must agree on their marker: a predicate marked
  `output predicate` by one rule and `error predicate` by another is rejected.

### 4.7 Constraint Checking

Integrity constraints (§2.10) are checked at their fixed point, after all
predicates are evaluated and **before any output is produced**:

1. Every constraint is evaluated.
2. If any is non-empty, evaluation stops. *All* violated constraints are
   reported, each with its counterexample rows — not just the first.
3. No query runs and no output is printed. A violated program produces
   no results, rather than results derived from data it declares invalid.

A constraint's identity in the report is its predicate name (`error predicate`)
or its source text (an anonymous `!-`). A constraint that came from an imported
module is reported under the name its author wrote, together with the binding
that brought it in (§9).

Constraints are subject to the same static rules as queries: body safety
(§4.1), arity consistency (§4.2), stratification (§4.3), and type validation
(§5.7). Since a constraint is an ordinary predicate, it also participates
normally in the dependency graph and stratification.

Constraint checking is a whole-program operation. An **incremental session**
(the REPL) is built up a statement at a time, so it instead checks each
constraint once, when the statement introducing it is entered; a constraint that
held when written is not re-checked against later additions.

## 5 Type System

### 5.1 Types

Datamog has six basic types:

| Type      | Description           | SQL type                                  |
|-----------|-----------------------|-------------------------------------------|
| `string`    | Unicode strings       | `TEXT`                                    |
| `integer` | Whole numbers         | `BIGINT` (Postgres) / `INTEGER` (SQLite/sql.js) |
| `float`    | Floating-point numbers| `DOUBLE PRECISION` (Postgres) / `REAL` (SQLite/sql.js, 8-byte) |
| `boolean` | True/false values     | `BOOLEAN`                                 |
| `null`    | the single value `null` | `TEXT` (unobservable: only `NULL` is stored) |
| `value`   | any JSON shape except a bare `null`: `boolean` / `integer` / `float` / `string` / array / object, with `null` allowed *inside* one | `JSONB` (Postgres) / `TEXT` (SQLite/sql.js) |
| `value?`  | the same, and a bare `null` as well | as `value` |

`null` is a type like any other. It sits **beside** the primitives rather
than below them, so `string` and `integer` still have no common value and a
variable shared between them is still a type error; a variable shared
between two *nullable* columns can only be `null`. Which storage carries a
`null`-typed column is unobservable, nothing but `NULL` ever being written
there.

A column that can hold `null` **as well as** other values is written with a
`?` suffix (`age: integer?`, §2.2). That is not a sixth kind of type but the
union of the base type and `null`, so `integer?` accepts an integer or a
`null` and `integer` accepts integers only.

`?` means the same thing on `value` as on every other base type, so `value` is
any JSON shape but not a bare `null`, and a column that can carry one must say
`value?`:

```prolog
doc(J: value)  :- J = {"k": null}.   # fine: the null is inside the object
top(J: value?) :- J = null.          # `value` here is an error, naming `value?`
```

The distinction is between the JSON document `null` and a document that merely
contains one. Only the first needs the `?`.

SQLite and sql.js have no native `BOOLEAN` storage type — they round-
trip `TRUE`/`FALSE` and comparison results as `0` / `1`. The executor
coerces those back to JS `true`/`false` at the result-row boundary
for any column whose declared type is `boolean`, so query-result
shape is uniform across every backend.

An explicit `value` declaration remains opaque. Unannotated producers can retain
inferred object fields, tuple components, array element types and nominal proof
payload types. Consumers can use a proven scalar projection in arithmetic and
scalar builtin calls without spelling an extraction builtin:

```prolog
person({"age": 41, "name": "Ada"}).
next_age(P["age"] + 1) :- person(P).
shout(upper(P["name"])) :- person(P).
```

Shared variables satisfy the intersection of their positive predicate and equality
requirements. For example, a variable bound to an integer-or-string JSON field can
be used numerically after an equality constrains it to an integer. Nested proof
matches can select a known constructor payload from a union of nominal proof
types; an opaque alternative does not establish a payload type from its tag alone.

These operands lower to the existing type-strict extraction builtins (§2.9).
Published annotations control what consumers can rely on: declaring the producer
as `value` hides its inferred shape. A nullable scalar requires a bound-variable
`<> null` guard before implicit extraction; missing fields and indices stay
undefined, while standalone JSON null projections remain ordinary null values.
Dynamic integer indexing retains array element types or the union of possible
tuple component types through predicate boundaries. For example:

```prolog
rows([{"n": 7}, {"n": 9}]).
index(0). index(1).
selected(A[I]) :- rows(A), index(I).
answer(P["n"] + 1) :- selected(P).
```

Whole structured values retain JSON storage. Inference uses bounded widening:
wide records may retain only some field guarantees, wide tuples may become array
summaries, and excess nesting or alternatives may fall back to `value`. These
precision limits do not restrict the size or shape of runtime values. A structural
contract that inference cannot establish is rejected with a mismatch path and the
expected/inferred types; a failure to prove union coverage is not necessarily a
counterexample. Exact compiler budgets are implementation policy, not language
syntax. If exact structural checking exceeds a compiler resource limit, it reports
that failure explicitly rather than silently weakening the declared contract.

### 5.2 Type Inference

Types are inferred automatically via fixed-point iteration over the
predicate dependency graph (processed stratum-by-stratum):

1. **EDB types** are taken directly from extensional declarations (an
   unannotated column is `string`, §2.2).
2. **Fact types** are inferred from literal values in rules with empty
   bodies (`"hello"` is `string`, `42` is `integer`, `3.14` is `float`,
   `true`/`false` is `boolean`).
3. **Variable types** are propagated from body atoms: if `p(X, Y)` has
   column types `[string, integer]`, then `X` gets `string` and `Y` gets
   `integer`. A variable that appears in several atoms takes the **meet**
   (greatest lower bound) of those column types, since it must be a valid
   value in every position it occupies: `integer` and `float` narrow to
   `integer`, a primitive shared with a `value` column narrows to the
   primitive (the `value` column merely accepts it; the variable is still
   primitive-valued), and two incompatible primitives (e.g. `string` and
   `integer`) are a static error. This is the opposite direction to the
   widening in §5.6, where sibling *rules* combine a column's producers with
   the least upper bound.
4. **Equality types** propagate through a bare-variable side: in `Z = expr`
   or `expr = Z`, `Z` gets the type of `expr`.
5. **Range types** propagate: in `V in [low .. high]`, `V` gets the joined
   type of the bounds.

It is an error if a column's type cannot be inferred from its context.

### 5.3 Expression Typing Rules

| Expression                | Result type                                |
|---------------------------|--------------------------------------------|
| String literal `"..."`    | `string`                                     |
| Integer literal `42`      | `integer`                                  |
| Real literal `3.14`       | `float`                                     |
| Boolean literal `true`/`false` | `boolean`                             |
| Null literal `null`       | `null`                                     |
| Variable                  | type from environment                      |
| `a + b` (both numeric)    | `float` if either is `float`, else `integer`  |
| `a + b` (either `string`)   | `string` (string concatenation)              |
| `a - b`, `a * b`          | `float` if either is `float`, else `integer`  |
| `a / b`, `a % b`          | `float` if either is `float`, else `integer`  |
| `a ** b` (operands numeric) | `float` always (see §5.4)                  |
| `a & b`, `a \| b`, `a ^ b`, `a << b`, `a >> b`, `a >>> b` (operands `integer`) | `integer` (see §5.9) |
| `-a`                      | same as `a`                                |
| `length(x)`               | `integer`                                  |
| `upper(x)`, `lower(x)`, `trim(x)`, `replace(...)` | `string`           |
| `abs(x)`                  | same as `x`                                |
| `round(x)`                | `integer`                                  |
| `round(x, n)`             | same as `x`                                |
| `floor(x)`, `ceil(x)`     | `integer`                                 |
| `sqrt(x)`, `ln(x)`, `exp(x)` | `float`                              |
| `x[i]` (subscript), `x` is `string`         | `string`                     |
| `x[i:j]` (slice), `x` is `string`           | `string`                     |
| `x[i]` (subscript), `x` is `value`        | `value`                    |
| `x[i:j]` (slice), `x` is `value`          | `value`                    |
| `as_string(j)`              | `string`                                     |
| `as_integer(j)`               | `integer`                                  |
| `as_float(j)`              | `float`                                     |
| `as_boolean(j)`              | `boolean`                                  |
| `length(j)` / `length(s)` | `integer`                                  |
| `type_of(j)`              | `string`                                     |
| `defined(x)`              | `boolean`                                    |
| `has_key(j, s)`           | `boolean`                                  |
| `to_string(x)`            | `string`                                     |
| `to_integer(s)`           | `integer`                                  |
| `to_float(s)`              | `float`                                     |
| `to_boolean(s)`           | `boolean`                                  |
| `parse_json(s)`           | `value`                                    |

When both operands are `integer`, `/` performs truncated division
(rounded toward zero): `7 / 2 = 3`, `-7 / 2 = -3`. Integer `%`
returns the sign of the dividend: `-7 % 2 = -1`. When either
operand is `float`, `/` is true floating-point division.

The `integer` domain is `[-(2^53 - 1), 2^53 - 1]`. Integer arithmetic is
exact when its mathematical result is in that range and has **no value**
otherwise, so a rule computing one derives no tuple there (§5.4). Integer inputs from literals, loaders, conversions and direct
insertion obey the same bound. Bitwise operators are the exception described
in Section 5.9: they deliberately coerce to and wrap within signed 32 bits.

A handful of these operations are *partial*: arithmetic overflow, `/`, `%`,
`sqrt`, `ln`, `exp`, and `**` have **no value** for inputs outside their
mathematical / finite-number domain, rather than raising an error, producing
an IEEE special value, or yielding `null`. The full list and the rules for
what an expression with no value does are in Section 5.4.

#### Expression partiality

Every well-typed expression denotes a *partial* function from assignments of
runtime values to its free variables (respecting their inferred types) to at
most one Datamog runtime value. Expressions are never nondeterministic,
set-valued, or allowed to abort evaluation, and ill-typed expressions are
rejected by the analyzer before execution. Where an expression has no value,
the construct containing it does not hold and no row is derived from it; this
is specified per construct in Section 5.4.

Being *undefined* in this sense is not the same as evaluating to `null`.
`null` is an ordinary value (Section 1.5) that a column holds and a
comparison compares; an undefined expression has no value to hold or
compare. Keeping the two apart is what lets a missing `value` key withhold
its row while a key present with a `null` derives one carrying it.

### 5.4 Partiality and NULL

Two separate notions, and the section is organised around keeping them
apart.

- **`null`** is an ordinary value with its own type (§1.5, §5.1). It is
  stored, compared, joined and counted like any other.
- **Undefined** is the absence of a value. It is not a value: there is no
  literal for it, no column holds it, and no variable is bound to it.

An operation is undefined when an operand is undefined, or when the
operation has no result at those arguments.

#### Sources of undefinedness

1. **Partial arithmetic and math.** Each of the following has no value
   rather than raising or producing an IEEE special value, so every backend
   agrees:

   - Integer arithmetic and integer-returning math builtins whose result
     lies outside `[-(2^53 - 1), 2^53 - 1]`.
   - Float arithmetic and math builtins whose result would be non-finite.
   - `a / b` and `a % b` when `b = 0`.
   - `sqrt(x)` for `x < 0`; `ln(x)` for `x <= 0`.
   - `exp(x)` when the result overflows the finite `float` range.
   - `x ** y` for `x < 0` with fractional `y`, for `x = 0` with `y < 0`, or
     on overflow.

2. **Partial conversions, `value` builtins and accessors.** Malformed
   `parse_json`, a failed `to_*` parse, a failed `as_*` projection, a
   wrong-shape `length` / `keys` / `values`, and a **missing** `value` key or
   out-of-range index.

3. **Aggregates with no identity.** `avg`, `min` and `max` over a group
   with no defined contributions, and an integer `sum` that leaves the
   integer domain (§2.7).

Slice with `i >= j` produces `""` / `[]`, and a string subscript out of
range produces `""`; neither is undefined.

#### Sources of `null`

1. The **`null` literal** in source.
2. An **extensional column declared `?`**, whose cells may be `null`.
3. **JSON data** containing a `null` leaf, read through a `value` column or
   `parse_json`.

A `value` key that is *present* and holds a JSON `null` yields the `null`
value; only a *missing* key is undefined. `type_of` reports `"null"` for the
former.

#### Where definedness is required

Per construct, and compositionally: what matters is whether the construct
*holds*, so an undefined expression inside a negation makes the negation
hold rather than the rule fail.

| construct | holds when |
|---|---|
| atom `p(e₁ … eₙ)` | every `eᵢ` is defined **and** the resulting tuple is in `p` |
| equality `e = f` | both sides are defined and equal as values |
| filter `e` | `e` is defined and `true` |
| `not φ` | `φ` does not hold, for any reason, undefinedness included |
| rule head | every head expression is defined; otherwise no tuple is derived |

Consequences worth stating outright:

- `p(1 / 0)` never holds, and `not p(1 / 0)` always does, whatever `p`
  contains.
- **`e <> f` is not `not (e = f)`.** Both sides of `<>` must be defined for
  it to hold, while `not (e = f)` holds precisely when `e = f` does not,
  undefinedness included. A `<>` whose operand can be undefined draws a warning
  naming the other reading; it is reported by default, the two spellings being
  one rewrite apart and the difference invisible in the output, which is simply a
  shorter table. Writing whichever is meant silences it, since only `<>` warns.
- **`defined(e)` is the definedness test.** It is `true` where `e` has a value
  and *undefined* where it does not, never `false`, so `not (defined(e))` is how
  you ask for the rows an expression lost. `not (e = e)` says the same thing
  without the builtin, an equality needing both sides to have a value.

  Two things to know about it. It takes an operand every other computing
  operation would reject, asking whether there is a value not being able to
  require one. And `defined(X)` on a bare **variable** is always `true`, a
  variable being bound to a value and `null` being one; it is not `X <> null`,
  and writing it draws a warning saying so.

  A body element shaped `name(args)` parses as an atom, so `defined(e)` in body
  position is rewritten into a condition during parsing, negation included:
  `not defined(e)` is negation as failure over it and holds exactly where `e`
  has no value. It is the only built-in function with that reading; every other
  one has to appear inside an expression.
- **`not` and `!` differ.** `not` is negation as failure over a body element;
  `!` is the boolean operator and propagates undefinedness *and* is strict at a
  `null`. So they agree wherever the operand has a value that is not `null`, and
  differ at both of the other cases: over a `boolean?` variable holding `null`,
  `not B` holds and `!B` has no value.

#### Propagation

Undefinedness propagates through arithmetic, string concatenation,
subscript, slice, value construction, and every non-aggregate builtin: an
undefined operand makes the whole expression undefined.

`&&` and `||` are **non-strict** in it, so a dominating operand wins:
`false && e` is `false` and `true || e` is `true` even where `e` is
undefined. That is what makes `X <> 0 && 10 / X > 0` usable as a guard.

The `null` *value* is a different matter, and mostly it cannot arise: **an
operation that computes requires a non-null operand.** Arithmetic, negation, the
bitwise operators, string concatenation, a subscript or slice index, a range
bound, a builtin with a primitive parameter, either branch of a conditional, and
the aggregates `sum`, `avg`, `min`, `max` and `concat` all reject one statically.
So does a statically `null` operand, the same rule at its far end: `null + 1` is
rejected (§5.3).

A conditional's *condition* is not on that list, and the asymmetry is the reason
the branches are. A branch is what could make the result a null; the condition can
only withhold the row. Were both nullable, one NULL would have to carry the null
value and the absence at once, which is the guarantee this rule exists to keep.

Narrow first. Any of these conjuncts proves every variable in a **strict
position** of its operand non-null for the rest of the rule:

- `X <> null`, the direct one, and `not (X = null)`, which is the same fact;
- any ordering (`X < 2`, `X >= Y`, …), all four being strict at a null;
- a range atom (`X in [1 .. 10]`), which is strict for the same reason;
- an equality `X = e` where `e` cannot be null, only a null matching a null;
- a positive atom whose column at that position is non-null.

The narrowing is per rule and order-independent, a body being a conjunction, so a
guard written last refines an atom written first. It is not `defined(X)`: a
variable denotes a value and `null` is one, so `defined` on a bare variable is
constantly true and narrows nothing. The two spellings are one keystroke apart
and the wrong one draws a warning. Three positions are exempt from needing a
guard at all:

- **Comparisons.** They take a `null` on either side. `=` answers, and an
  ordering is strict at it and simply does not hold, which is a guard doing its
  job rather than a bug to prevent.
- **The connectives.** `&&`, `||` and `!` take one too, and are strict at it for
  the ordering's reason: a null is no truth value, so `null && true`,
  `null || false` and `!null` have no value, while `null && false` is still
  `false` by dominance. So a connective, like a comparison, never *returns* a
  null, which is what keeps the rule below true of it.
- **`value` operands.** A `value` spells its null inside the value (as JSON
  `null`), so nothing is ambiguous about it and it propagates: `V["k"]` on a
  `null` leaf is a `null`, and `type_of` of one is `"null"`. `count` and `list`
  are exempt for a related reason: `count` counts a `null` and `list` collects
  one, so neither has to compute with it.

The point of the rule is to keep a SQL NULL single-valued. A `T?`-typed
expression is therefore never undefined, so a NULL in a `T?` context means the
`null` value and nothing else; let arithmetic take a `T?` and that stops being
true, `X + 1` being a `T?`-typed expression with no value at the top of the
integer domain.

#### Comparisons

`=` and `<>` compare values, `null` included, and never yield `null`:
`null = null` is `true` and `null = 1` is `false`. The orderings are strict at
`null`, which is outside the order: no value at all.

| left   | right  | `=`    | `<>`   | `<`   | `<=`  |
|--------|--------|--------|--------|-------|-------|
| `5`    | `5`    | true   | false  | false | true  |
| `5`    | `6`    | false  | true   | true  | true  |
| `5`    | `null` | false  | true   | —     | —     |
| `null` | `null` | true   | false  | —     | —     |

A comparison whose operand is *undefined* does not hold, by the table above
in "Where definedness is required", and so drops its row in filter position
and satisfies `not`. An ordering over a `null` behaves the same way, for the
same reason: it has no value either.

Because a true ordering therefore has non-null operands, it refines them to
non-null for the rest of the rule. All four orderings do; under a total reading
`<=` and `>=` could not, being true of two nulls.

Atom matching uses the same value equality: a `null` argument matches a
`null` column, and a shared variable joins `null` to `null`. `p(X), q(X)`
and `p(X), q(Y), X = Y` therefore denote the same relation.

#### Equalities (body-level)

Body equality (§2.5) has two roles:

- **Binding** (one side is an unbound bare variable): `X = expr` introduces
  `X` and sets it to the value of `expr`. If `expr` has no value the conjunct
  does not hold and no row is derived, so `X` is never bound to an absence.
  `X = null` binds `X` to the `null` value and types it `null`.
- **Constraint** (both sides bound): an ordinary value equality, per the
  table above.

#### Aggregates

See §2.7 for the full rules. In summary: a row whose aggregate argument is
undefined contributes to no aggregate mentioning it and still counts for
`count(*)`; a group with no defined contributions yields each aggregate's
identity where one exists (`count` and `sum` → `0`, `concat` → `""`,
`list` → `[]`) and is undefined otherwise (`avg`, `min`, `max`), withholding
the tuple. `count` counts a `null` like any other value and `list` collects one,
so the two agree on how many. `sum`, `avg`, `min` and `max` never meet one: they
reject a nullable operand statically and their argument types exclude `value`
(§5.7). `concat` can meet one, a `value` argument being the exemption, and it
skips it.

#### Nullness

Whether a column can hold `null` is inferred per column, as a fixed point over
the dependency graph seeded non-null. An extensional column is nullable exactly
when declared `?`; an intensional one is nullable when some rule for it can
contribute a `null`. Head annotations may declare it (§5.10), module boundaries
are checked against it (§9.3), and it selects between the two equality lowerings
so a join over provably non-null columns keeps a plain `=`.

A partial operation is not a source of nullness, because it yields no value
rather than a `null` one: `X = A / B` contributes nothing to `X`'s nullness
whatever `A` and `B` are, and a column receiving it needs no `?`. Nullness
originates only where an actual `null` can appear: a `null` literal, a `?`
extensional column, and a `value` expression whose result may be a JSON `null`
(`parse_json`, or an accessor reaching a `null` leaf). Every other operation
merely propagates its operands' nullness. The comparisons and the connectives
stop it entirely, neither returning a `null`: `=` answers for one, and an ordering
or a connective is strict at one and has no value there. No aggregate is nullable,
per the empty-group rules above.

#### Storage

`null` is stored as SQL `NULL` in a `T?` column and as a JSON `null` inside
a `value`. The second is required rather than incidental: a `value`-typed
expression can be both undefined and `null`-valued, so SQL `NULL` there is
reserved for undefined and the JSON spelling carries the value.

Non-`?` extensional columns are emitted `NOT NULL`, so a loader cannot
introduce a `null` through them; coercion failures raise at load time. A
`null`-typed column is the exception and carries no `NOT NULL`, `null` being the
only value it holds (§2.2).

#### Diagnostics

Six warnings, none of them an error: each reports specified behaviour that is
sometimes exactly what was wanted. The symptom they share is a row that quietly
is not there, whose cost is otherwise paid by reading output and counting.

| code | reports | default |
|---|---|---|
| `nullable-filter` | a filter whose operand can be `null`, which never holds (§2.5) | on |
| `nullable-ordering-gap` | two complementary orderings over the same operands, which partition the non-null rows and silently drop the `null` ones | on |
| `nullable-negated-ordering` | `not` over an ordering, which *keeps* the `null` row, the ordering having no value there | on |
| `partial-inequality` | `<>` over an operand that can have no value, where `not (a = b)` is the other reading (§2.6) | on |
| `constant-defined` | `defined(X)` on a bare variable, which is constantly true and is not `X <> null` | on |
| `undefined-expression` | an expression that can have no value, in a position that *uses* one | off |

The last is opt-in, behind the CLI flag `--warn-undefined`, and is the mitigation
for partiality's one real cost: where a `NULL` used to appear in the output, the
row is now simply absent and nothing says so, so a warning before the run beats
counting rows after it. It is off by default because partial operations are
pervasive and usually deliberate — a program writing `Y = 10 / X` generally knows
`X` can be zero and wants those rows gone — and it fires 236 times across the
single-file examples. It is the flag to reach for when rows you expected are
missing.

It reports the positions that use a value: head arguments, both sides of an
equality, atom arguments, and range bounds. Not filters, which test rather than
use; there an absence and a `false` both drop the row and are indistinguishable,
so nothing surprising has happened. One diagnostic per rule, naming the first
offending expression.

### 5.5 Aggregate Typing Rules

| Aggregate          | Result type          |
|--------------------|----------------------|
| `count(expr)`      | `integer`            |
| `sum(expr)`        | same as `expr` (`float` if `expr` is `float`, else `integer`) |
| `avg(expr)`        | `float`               |
| `min(expr)`        | same as `expr`       |
| `max(expr)`        | same as `expr`       |
| `concat(expr)` | `string`            |
| `list(expr)`   | `value` (array)     |

### 5.6 Type Widening

When multiple rules define the same predicate, its columns are combined
across rules by the **join** (least upper bound) of each rule's head
contribution. The join is total, so it never fails:

- same type + same type = no change
- `integer` + `float` = `float`
- `null` + any type = that type, `null` being the join's identity: a rule
  contributing a bare `null` makes the column nullable (§5.4) and leaves its base
  type to the other rules
- `value` + any primitive = `value` (the primitive auto-lifts; see §2.9)
- any other pair (`string` + `integer`, `boolean` + `float`, …) = `value`

The last rule is the key point: a column fed a `string` by one rule and an
`integer` by another has no common primitive supertype, so it widens to
`value` and holds both as JSON (each primitive branch lifts via the
translator, §2.9). This is the opposite direction to a variable shared
across atoms *within* a single rule, which takes the **meet** (§5.2) and
errors on incompatible primitives, because there one value must satisfy
both positions at once.

Widening rather than rejecting is deliberate: it keeps the join total, so
every column has a least upper bound and inference stays a clean fixed point,
and it describes a mixed column as the heterogeneous JSON it is. The cost is
that a mistyped sibling rule silently produces a `value` column instead of an
error. See the type-lattice design note (`doc/design/type-lattice.md`) for the
full rationale.

Every column of every predicate is typed with exactly one of the six types of
§5.1, plus a nullness bit inferred separately (§5.4). A column that only ever
receives a bare `null` has no base type of its own; one is picked to carry the
nulls and is unobservable there, but a rule reading such a column cannot infer a
type for it, so it needs a sibling rule contributing a real type.

### 5.7 Type Validation

The following type constraints are enforced after type inference:

- **Range atoms**: binding ranges (`X in [...]` where `X` is a fresh bare
  variable) require integer bounds and bind `X : integer`. Filter ranges
  require numeric bounds and expressions (`integer` or `float`).
- **Unary minus**: the operand must have numeric type.
- **Subscript** (`x[i]`): the object must have type `string` or `value`.
  When `x : string`, the index must be `integer`. When `x : value`, the
  index may be `integer` (array) or `string` (object key).
- **Slice** (`x[i:j]`): the object must have type `string` or `value`.
  Bounds are always `integer`.
- **String functions** (`length`, `upper`, `lower`, `trim`): the first
  argument must have type `string`. All arguments of `replace` must be
  `string`. `length` is also overloaded for `value` arguments.
- **Math functions** (`abs`, `round`, `floor`, `ceil`, `sqrt`, `ln`,
  `exp`): all arguments must have numeric type.
- **Exponentiation** (`x ** y`): both operands must have numeric type.
- **Value coercion / introspection** (`as_string`, `as_integer`,
  `as_float`, `as_boolean`, `length`, `type_of`, `has_key`, `keys`,
  `values`, `to_json`): the inspected value argument must have type
  `value`, except that `length` also accepts strings as an alias for
  string length. `has_key`'s second argument must be `string`. As with any
  `value`-typed parameter, a primitive argument auto-lifts into the `value`
  slot (Section 2.9).
- **Primitive conversions** (`to_string`, `to_integer`, `to_float`,
  `to_boolean`, `parse_json`): `to_string` accepts any of
  `integer`/`float`/`boolean` and rejects `string` (no identity
  overload). The string → number/boolean parsers accept exactly
  `string` and reject identity inputs of the target type.
  `parse_json` accepts exactly `string`. A failed parse, of JSON or of a
  number or boolean, has **no value** rather than raising (§5.4).
- **Iteration primitives** (`object_entry`, `array_element`): the
  source argument (position 0) must have type `value`; the bound
  positions are typed per §2.9.
- **Comparisons and non-binding equalities**: the two sides must have
  compatible types (same type, or `integer`/`float`, or
  primitive ↔ `value` via auto-lift — see §2.9 and §5.6). The
  ordering operators `<`, `<=`, `>`, `>=` additionally reject
  `boolean` and `value` operands.
- **Addition**: with a `string` operand, `+` is concatenation (§2.6) and the
  other operand must be numeric or `string`; `boolean` and `value` are
  rejected, since their rendering differs across backends. Otherwise both
  operands must be numeric.
- **Aggregate arguments**: `sum` and `avg` require a numeric argument.
  `min` and `max` require an orderable one (`integer`, `float`, or `string`),
  rejecting `boolean` and `value`, which the backends order differently.
  `count`, `concat`, and `list` accept any type.

```
X in [1 .. 10]            # OK: integer bounds
X in ["a" .. "z"]         # ERROR: non-numeric bounds
-"hello"                  # ERROR: unary minus on string
42[0]                     # ERROR: subscript on integer
sqrt("hello")             # ERROR: sqrt expects numeric
X > "5"                   # ERROR: comparing integer with string (if X : integer)
B > true                  # ERROR: '>' does not order booleans
J > J2                    # ERROR: '>' does not order `value` (if J, J2 : value)
```

A `value` parameter is the one place where a primitive argument is not a type
error, the auto-lift (§2.9) turning it into a `value`. Such a call type-checks and
then simply has no value, which is a different outcome from being rejected:

```
as_integer("42")          # OK, and no value: a string leaf is no numeric leaf
length(42)                # OK, and no value: an integer has no length
```

### 5.8 Finiteness analysis (warnings)

A separate, opt-in static check (CLI flag `--warn-finiteness`; always
on in the playground) flags predicate columns whose values may grow
without bound across recursive iterations. Pure Datalog terminates
because every value reachable in the fixed point is drawn from the
extensional input — but Datamog adds arithmetic, string concat, and
`parse_json`, which can manufacture values outside that input set,
so a recursive rule like `s(Y) :- s(X), Y = X + 1.` does not
terminate, and neither does `g(parse_json(as_string(J))) :- g(J).`.

The analysis builds a single program-wide dataflow graph:

- A node for each `(predicate, columnIndex)` pair (shared across
  rules).
- A node for each `(rule, variable)` pair (rule-local).

Edges are added when walking each rule:

- A body atom `p(t1, …, tn)` (positive, non-negated):
  - if `tj` is a Variable `V`, edge `(p, j) → (rule, V)`;
  - if `tj` is any non-Variable expression, the variables of the
    expression flow *into* `(p, j)`, marked **PLUS** to record that
    the value is computed.
- A head atom `q(e1, …, en)`:
  - Variable / aggregate / literal head args produce *clean* edges;
  - any other expression at position `j` adds edges
    `(rule, V) → (q, j)` marked **PLUS** for every variable `V`
    referenced.
- A binding equality with a bare variable on either side: clean if the
  other side is a bare variable or literal; **PLUS** otherwise.
- A binding range `V in [lo .. hi]`: clean if both bounds are integer
  literals (the range is finite by construction); **PLUS** if either
  bound is a variable expression.
- Comparisons, non-binding equalities, negated atoms, filter ranges
  contribute *no* edges.

The analysis runs Tarjan's SCC. Any SCC that contains both a cycle
and at least one PLUS-labelled internal edge produces one warning per
predicate-column node it includes:

```
warning: Column N of predicate 'p' is on a value-producing recursion
cycle and may grow without bound
```

The check is intentionally conservative: it flags every program where
termination depends on a comparison or filter the analyser doesn't
read (e.g. Fibonacci's `I < 10`). It is therefore **only ever a
warning** — programs are still translated and executed.

Because the static check is necessarily incomplete, the in-memory
interpreters (`native`, `seminaive`) also accept an optional **iteration
cap**: a limit on fixed-point passes per stratum. When a stratum reaches
the cap without converging, evaluation stops and returns the partial
(prefix) result with a note naming the still-growing predicate, instead
of looping forever. The cap is off by default on the CLI (opt in with
`--max-iterations N`), on by default in the playground (adjustable, and
switchable off) and in tutorial embeds. It is a runtime safeguard, not a
semantic change: an uncapped run computes the same least fixed point as
before. See `doc/design/finiteness-checking.md`.

### 5.9 Bitwise integer semantics

The bitwise / shift operators `&`, `|`, `^`, `<<`, `>>`, `>>>` operate on
**32-bit signed two's-complement integers**, matching Java/JavaScript `int`
semantics. Both operands and the result are `integer`; a non-integer
operand (`float`, `string`, `boolean`, `value`) is a compile-time type
error (§5.7), and so is a nullable one: these compute, so they require a value
(§5.4).

| Operator | Meaning                                                        |
|----------|----------------------------------------------------------------|
| `a & b`  | bitwise AND                                                    |
| `a \| b` | bitwise OR                                                     |
| `a ^ b`  | bitwise XOR                                                    |
| `a << b` | left shift; bits shifted past bit 31 are discarded (wraps)     |
| `a >> b` | arithmetic right shift (sign-extending)                        |
| `a >>> b`| logical right shift (zero-fill), result reinterpreted as int32 |

The shift count is taken **mod 32** (so `1 << 32` is `1`, and a negative
count `n` shifts by `n & 31`). Left shifts wrap within 32 bits, so
`1 << 31` is `-2147483648`. These rules make every result fit the
`integer` column type and be identical on every backend.

The 32-bit width matches JavaScript's native bitwise operators, used by the
in-memory evaluators, and is part of the language independently of the wider
safe-integer domain. The translator reconciles the SQL backends: SQLite has no XOR or
`>>>` operator and computes in 64-bit, so XOR is emulated as
`(a | b) & ~(a & b)`, `>>>` masks the operand to unsigned 32-bit before
shifting, and both `<<` and `>>>` wrap their 64-bit result back to signed
32-bit; Postgres spells XOR `#`, masks and reinterprets operands and results,
and emulates `>>>` via a `bigint` mask. See §6.8.

### 5.10 Head type annotations

Head terms may carry optional type annotations (§2.3). They are checked against
inference, never used to drive it. Annotations are **per rule and per
argument**: a rule may annotate any subset of its head arguments, and sibling
rules of the same predicate may annotate differently or omit annotations. Each
annotated position of each rule is validated:

**Soundness.** For an annotated head position, the declared type `D` must equal
or widen that rule's own inferred contribution `I` for the position:
`widen(I, D) = D` (widening per §5.6, extended with the primitive/`value` lift).
So `value` may be declared for any position, `integer` may be declared `float`,
but a type narrower than the rule proves (for example `integer` for a position
the rule infers as `value`) is rejected.

**Contract for consumers (assume-guarantee).** A predicate advertises a
*published* type to its consumers: its inferred type, widened at each position
by the annotations on it. Other predicates and queries that read the predicate
are type-checked against this published type, not its inferred type. So if `p`
is declared `value` while it currently produces only integers, a consumer
`q(Z) :- p(Y), Z = Y + 1` is rejected -- `Y` is `value` at the boundary, and
arithmetic on `value` is not defined. This lets a declaration promise more
generality than the body currently delivers and holds callers to that promise,
so they keep type-checking if the body later widens.

A predicate's *own* body is the exception: its recursive self-references use its
inferred type, not its published type. Otherwise a deliberately wide declaration
would reject the very body that produced it -- a `value`-declared recursive
predicate could not do arithmetic on its own recursive result. This is the
guarantee half of the pair: a definition is checked against reality, its
consumers against its advertised contract. The guarantee check above computes a
rule's contribution the same way -- callees contribute their published type, the
predicate's own references their inferred type.

Because annotations do not influence inference, a column whose type inference
cannot determine is still an error (§5.2) even when annotated. Annotations carry
no runtime effect and do not change the emitted SQL: codegen uses the inferred
type, so declaring a column `value` that a rule fills with integers documents
intended generality and constrains consumers, but the column is still stored and
returned as integers. This invariant -- annotations affect only checking, never
codegen -- is deliberate: keeping codegen on the inferred type means it never has
to down-cast a wider declared type (say `value`) back to the narrower value a
recursive body computes with. See the type-lattice design note
(`doc/design/type-lattice.md`).

Module boundaries (§9.3) apply this same directional subtype check: the value
flowing across a boundary must fit within the type declared for it.

#### Structural annotations

Head positions accept the record and array types described in §2.2:

```prolog
person({"name": "Ada", "age": 37}: {name: string, age?: integer}).
ages([37, null]: [integer?]).
```

The rule's contribution must be a semantic subtype of the declared shape.
Checking is conservative: if bounded inference cannot prove the shape, the
annotation is rejected. An opaque `value` from a callee cannot be asserted to
have a record type. Missing required fields, undeclared extra fields and
incompatible nested values are rejected statically. Optionality and nullability
have the same independent meanings as in input declarations.

Consumers see the declared generality, including optional fields and widened
field types, through subsequent predicates. Unannotated sibling rules still
contribute their own types. Recursive self-references retain inferred types.
Shapes keep JSON storage; annotations do not validate or coerce runtime values.
Computed fields use the existing expression nullness analysis, and a nullable
field requires a guard before it can satisfy a nonnullable field annotation.

#### Nullness annotations

A head annotation may carry a `?` after the type (`ratio(X: integer?)`),
spelled as an input column spells it (§2.2). It is checked in the same
direction as the type and by the same rules: per rule, per argument, and
declared-must-equal-or-widen-inferred.

- A `?` where the rule's contribution can be NULL is required. Omitting it is
  an error naming the annotation that fixes it.
- A `?` where the contribution cannot be NULL is accepted, and documents
  looseness the way annotating `value` on an integer column does.
- Nullness is inferred whether or not anything is annotated (§5.4, "Nullness"),
  so the annotation adds a check and never an inference input.
- The published contract widens by `?` exactly as it widens by type, so
  consumers and module boundaries (§9.3) see the declared nullness while the
  predicate's own body sees the inferred one.

Codegen reads the inferred nullness, never the declared one, so a `?` on a
provably non-null column does not change the emitted SQL.

### 5.11 Head refinements

A `_` head position may carry a **proposition** over the predicate's other
positions instead of a type. It declares a contract: every tuple the predicate
derives satisfies it.

```
span(X, Y, _: Y > X) :- edge(X, Y).
```

The position is not a column. Its inhabitant would be a witness that the
proposition holds, which carries no information beyond that fact, so it is
erased and `span` is binary. Writing a refinement anywhere but a `_` is an
error, since any other position *is* a column.

A refinement may mention only the head's own positions. A bare variable names
its own position; a literal or computed position needs an `as` name (§2.3)
before a refinement can refer to it, and a body variable may not be mentioned
at all.

```
sp(I, I + 1 as K, _: I < K) :- token(I).
```

**A predicate's contract is the disjunction over its rules**, since a tuple
comes from whichever rule derived it, and a rule that carries no refinement
contributes `true`. So one unannotated sibling makes the contract vacuous, and
that is reported as a warning rather than silently checking nothing. Several
refinements on one rule conjoin.

**The contract is checked**, at the fixed point and before any query runs,
exactly as an integrity constraint is (§4.7), and a violation is reported the
same way. A tuple that satisfies no rule's claim is a counterexample. The check is
negation as failure over the proposition, so it reports any tuple where the
proposition fails to *hold*, whether it is false or has no value. NULL therefore
needs no special rule: an ordering is strict at a null (§2.6), so a null in a
constrained position leaves the proposition without a value and the tuple is
reported. A partial proposition (`_: 10 / X > 1` at `X = 0`) is reported for the
same reason.

Refinements never reach codegen beyond that check: no column is added and no
tuple is altered.

**Advisories.** Two are reported, both warnings by default. The first is the
vacuous contract above. The second is a refinement that mentions no head
position: `_: 0 <= 0` is a closed formula, so it is the same proposition for
every tuple and constrains none of them, and if it is true it takes the whole
contract vacuous by the disjunction rule. `--strict-contracts` promotes every
contract advisory to an error, and the CLI then exits non-zero without
evaluating the program.

**Proof obligations.** `--obligations` prints the contracts as an SMT-LIB 2
script instead of evaluating: one `push` / `assert` / `check-sat` / `pop` block
per refinement, where `unsat` discharges the obligation. The logic is `QF_LIA`,
widening to `QF_NIA` if the program multiplies or divides by a variable. No
solver ships with Datamog; the script is the deliverable, so that any solver can
consume it. The encoding writes out what SMT-LIB spells differently: division
and modulo truncate toward zero (§5.3) rather than being Euclidean, `null` is
modelled as a value paired with a null-condition so the null-aware comparisons of
§5.4 hold, and partiality is modelled separately from that, as a definedness
condition.

Definedness enters as a **hypothesis**: a rule derives a tuple only where every
head expression has a value (§5.4), so a contract makes no claim about the cases
where one does not, and the encoding says so. An `integer` head expression is
therefore assumed to be inside the bounded domain of §5.1, and a division's
divisor assumed non-zero. A *free variable* is confined to the domain instead,
by a constraint: an unbounded SMT `Int` is otherwise falsified with a value no
column can hold.

A rule may assume the contract of any predicate it calls positively. Where the
call is to the rule's own predicate that is an induction hypothesis, sound
because the induction is on the derivation and every rule of a predicate is
discharged together or not at all. A negated call assumes nothing: the absence
of a tuple says nothing about values.

**Discharging them.** `--verify` runs each obligation through an SMT solver and
reports `proved`, `FAILED` with the assignment that falsifies the claim, or
`skipped` for a claim outside the fragment above. The solver is named by
`--solver` and defaults to `z3 -in`; anything that reads an SMT-LIB 2 script on
standard input will do. The exit status is non-zero unless every
obligation is discharged.

A contract that cannot be discharged is not thereby false. It may be a property
of the data rather than a theorem, or it may need a bound the program has not
stated: nothing says an input column is non-negative unless a refinement on it
does, and a claim that depends on it is then declined with that as the
counterexample. Bounding the inputs is itself a refinement.

## 6 SQL Translation

### 6.1 Overview

A Datamog program translates to four groups of SQL statements:

1. **CREATE TABLE** statements for each extensional predicate.
2. **CREATE VIEW** statements for each intensional predicate (one view per
   predicate, possibly recursive).
3. **SELECT** statements for each integrity constraint (§2.10), run first.
4. **SELECT** statements for each query.

A constraint compiles to exactly the SELECT its query form would; the marker
changes only what the executor does with a non-empty result.

IDB column names use the convention `col1`, `col2`, ..., `colN`. EDB
column names use the declared names from the extensional declaration.

Two shapes have no SQL translation and are rejected here rather than
mistranslated: non-linear recursion (§4.4) and parity-stratified recursion
(§4.3). The latter needs an outer loop that rebuilds a relation from empty
between rounds, where `WITH RECURSIVE` computes one least fixed point of a
monotone body and cannot delete. A sigil whose stratum holds only one polarity
has no effect on evaluation and compiles normally.

### 6.2 Rule Translation

Each rule translates to a SELECT statement. The translation makes two passes
over the body: pass 1 registers the bindings introduced by positive atoms, and
pass 2 iterates to a fixed point over equalities and range atoms, so a forward
reference across the body resolves and body order stays irrelevant (§4.1). The
body elements classify into:

- **Positive atoms** -- become FROM clause entries with aliases (`__b0`,
  `__b1`, ...).
- **Negated atoms** -- become `NOT EXISTS (SELECT 1 FROM ...)` in the WHERE
  clause.
- **Equalities** -- register variable bindings used in the SELECT and WHERE
  clauses.
- **Comparisons** -- become WHERE conditions.
- **Binding ranges** (variable `in` range) -- become FROM clause entries
  using the dialect's range source.
- **Filter ranges** (expression `in` range) -- become BETWEEN conditions in
  the WHERE clause.

Shared variables between atoms produce join conditions. Non-variable atom
arguments produce equality filters.

**Definedness guards.** A partial expression (§5.4) lowers to SQL NULL, and a
guard is what turns that NULL into a withheld row. One is emitted per **head
argument** and per **side of an equality**, as `<sql> IS NOT NULL` in the WHERE
clause; per **aggregate** with no identity, as the same test in `HAVING` (§6.6);
per **part of a `value` construction**, as a `CASE` with no `ELSE` so an
undefined part withholds the row instead of becoming a JSON `null`; and around
**`defined`**'s argument, again a `CASE` with no `ELSE`, since `defined` is
true-or-undefined and never false. A **comparison** is guarded locally rather
than at rule level, so the guard sits inside whatever negation encloses it and
`X <> e` and `not (X = e)` come out different (§5.4).

```sql
-- root(V, R) :- s(V), R = sqrt(V).
SELECT __b0."v" AS col1, SQRT(CASE WHEN (__b0."v") < 0 THEN NULL ELSE __b0."v" END) AS col2
FROM "s" AS __b0
WHERE SQRT(CASE WHEN (__b0."v") < 0 THEN NULL ELSE __b0."v" END) IS NOT NULL
```

Head and equality guards read the **unlifted** SQL, so an auto-lift cannot paper
over an absence. Lifting into a `value` is the one place a NULL changes meaning
rather than being tested: a nullable expression's NULL becomes the JSON `null`
the `value` spells it with (§5.4, "Storage").

Equality has two lowerings, and nullness inference (§5.4) picks between them.
The null-aware spelling of §6.8 is the meaning; where inference proves an
operand non-null, a plain `=` is emitted instead. The two agree there, since a
NULL against a non-null value is false either way, and the plain form is what
keeps a large join hash-joinable on Postgres.

Multiple rules for the same predicate are combined with UNION.

### 6.3 Non-Recursive Views

```sql
CREATE OR REPLACE VIEW "pred" AS        -- PostgreSQL
  (SELECT ...) UNION (SELECT ...)

CREATE VIEW IF NOT EXISTS "pred" AS     -- SQLite / sql.js
  (SELECT ...) UNION (SELECT ...)
```

### 6.4 Recursive Views

**PostgreSQL:**

```sql
CREATE RECURSIVE VIEW "pred" (col1, col2) AS
  (base cases) UNION (recursive case)
```

PostgreSQL allows exactly one recursive term, containing exactly one reference
to the CTE. A predicate with two or more recursive rules therefore cannot be a
flat union of them: the rules are folded into a single term that names the CTE
once and unions their bodies inside a `LATERAL`, each branch reading the
previous iteration through that one alias.

```sql
CREATE RECURSIVE VIEW "pred" (col1, col2) AS
  (base cases)
  UNION
  SELECT __lat.* FROM "pred" AS __rec, LATERAL (
    (recursive rule 1, reading __rec)
    UNION
    (recursive rule 2, reading __rec)
  ) AS __lat
```

Recursion is linear (§4.4), so each rule has exactly one recursive body atom and
this shape always applies.

**SQLite / sql.js:**

```sql
CREATE VIEW IF NOT EXISTS "pred" AS
  WITH RECURSIVE "pred"(col1, col2) AS (
    (base cases) UNION (recursive cases)
  )
  SELECT * FROM "pred"
```

SQLite accepts any number of recursive branches in the flat union, so no folding
is needed.

### 6.5 Mutually Recursive Views

Neither backend can express an SCC as several CTEs referring to each other:
SQLite does not support multiple recursive CTEs, and PostgreSQL reports
`mutual recursion between WITH items is not implemented`. Both therefore merge
the whole SCC into one self-recursive CTE with a `__tag` discriminator column,
and separate non-recursive views filter by tag:

```sql
WITH RECURSIVE "__mutual_pred1_pred2"(__tag, col1, col2) AS (...)
```

A predicate narrower than the widest in the SCC has its branch padded with
NULLs to match the CTE's column count.

**PostgreSQL** differs in two details. The recursive branches are folded into a
single `LATERAL` term (§6.4), because the combined CTE has one branch per rule
across the SCC and Postgres allows only one recursive term. And the padding
NULLs are cast to their column's type, since PostgreSQL takes the CTE's column
types from the anchor, where an uncast NULL would resolve to `text`.

Because the group is one relation, it has one type per column, so on a backend
that types those columns two predicates in the same SCC must agree at every
position. `a(N)` carrying an `integer` where `b(S)` in its group carries a
`string` is rejected, naming both predicates and the column. Integer and float
agree, a union over the two resolving to the float. The in-memory interpreters
keep a relation per predicate and SQLite leaves the combined columns untyped, so
neither has the restriction and both run such a program.

### 6.6 Aggregate Views

Rules with aggregates in the head produce GROUP BY queries:

```
student_avg(Student, avg(Score)) :- scores(Student, _, Score).
```

becomes:

```sql
SELECT __b0."student" AS col1, AVG(__b0."score") AS col2
FROM "scores" AS __b0
GROUP BY __b0."student"
HAVING AVG(__b0."score") IS NOT NULL
```

The `HAVING` is the definedness guard of §6.2: `avg` has no identity over an
empty group, so it has no value there and the tuple is withheld (§2.7). An
aggregate that does have one (`count`, `sum`, `concat`, `list`) supplies that
identity instead, and supplies it *inside* the integer-domain guard rather than
outside it, since an empty `SUM` and an overflowing `SUM` are both SQL NULL and
have to go opposite ways: `0` for the first, no value for the second.

### 6.7 Range Sources

Binding ranges (where a variable is bound to a range of integers) use
dialect-specific SQL:

- **PostgreSQL:** `generate_series(low, high)` as a table source
- **SQLite / sql.js:** A recursive CTE that generates values from `low` to
  `high`

### 6.8 SQL Dialect Summary

| Feature                  | PostgreSQL                   | SQLite / sql.js              |
|--------------------------|------------------------------|------------------------------|
| CREATE VIEW              | `CREATE OR REPLACE VIEW`     | `CREATE VIEW IF NOT EXISTS`  |
| Recursive view           | `CREATE RECURSIVE VIEW`      | `WITH RECURSIVE` in view     |
| Non-linear recursion     | rejected                     | rejected                     |
| Mutual recursion         | tagged combined CTE, `LATERAL` fold | tagged combined CTE          |
| Range source             | `generate_series`            | recursive CTE                |
| `concat`           | `STRING_AGG(expr::TEXT, ',' ORDER BY expr)` | `GROUP_CONCAT(expr, ',' ORDER BY expr)` |
| `<>` (null-aware)        | `IS DISTINCT FROM`           | `IS NOT`                     |
| bitwise XOR `^`          | `#`                          | emulated `(a\|b) & ~(a&b)`    |
| `>>>` (logical shift)    | `bigint` mask + reinterpret  | unsigned mask + int32 wrap   |
| `<<` / `>>` count        | masked mod 32                | masked mod 32; result int32-wrapped |

## 7 Data Loading

Extensional predicates are populated from external data sources via loader
plugins. The loader determines which data source to use based on the
predicate name and its configuration.

If no configured loader matches a given extensional declaration, the
predicate is simply left empty rather than treated as an error. Rules that
reference an empty EDB produce no rows, and embedding APIs may populate
predicates directly (e.g. via `insertRows`) without going through a loader
at all. This keeps Datamog usable as a library and avoids spurious failures
in scenarios where some EDBs are intentionally unsourced.

**Header matching.** Loaders that resolve declared column names against
external column or key names (CSV, JSONL object form, Google Sheets,
Parquet) match them **by exact name** (case-sensitively). A declaration
`input predicate p(Name: string, Age: integer).` accepts a CSV with headers
`Name,Age`, a JSONL line `{"Name": "...", "Age": ...}`, or a Google
Sheet whose first row reads `Name | Age`. Identifiers may be written in
any case, so declared column names can be chosen to match the source's
header casing exactly. Loaders that match positionally (Mermaid, CSV
without a header row, JSONL array form) are unaffected.

### 7.1 CSV Loader

Loads data from a file named `{predicate}.csv` in a configured directory.

- First row is a header by default (configurable).
- Fields are delimiter-separated (default `,`).
- String values are coerced to the declared column types. Coercion is
  **strict**: `integer` requires canonical decimal `0` or
  `-?[1-9]\d*` within `[-(2^53 - 1), 2^53 - 1]`; `float` requires canonical
  decimal `((0|-?[1-9]\d*)(\.\d+)?|-0\.\d+)` (no exponent, no leading
  `+`, no leading zeros except plain `0`, no surface `-0`); `boolean`
  accepts `true`/`1`/`yes` and `false`/`0`/`no` (case-insensitive).
  Surrounding whitespace is stripped for all three, so a padded field from a
  hand-formatted CSV still loads. Anything else raises a load-time error
  rather than silently coercing.
- A `value` column accepts any JSON text; the contents are parsed
  with `JSON.parse` and canonicalised on insert.
- For a nullable column (`type?`), an empty or whitespace-only cell is loaded as
  the `null` value, since no other value of its type reads an empty cell.
  **`string?` is the exception**: `""` is a string, and `string ⊑ string?` requires
  the nullable type to accept everything the base type does, so an empty cell in a
  `string?` column is the empty string exactly as it is in a `string` column. The
  consequence is that **no CSV cell can put a `null` in a `string?` column** — the
  format cannot distinguish a quoted `""` from a bare empty cell, so one of the two
  readings has to lose. Use JSONL or JSON, which carry a real `null`, where a
  nullable text column needs one.
- Without a header row, every record's field count must match the predicate
  arity. With a header row, every declared column must appear in the
  header (matched by exact name per the §7 intro); extra header
  columns are ignored, and each data row must provide values for the
  declared columns.

### 7.2 JSONL Loader

Loads data from a file named `{predicate}.jsonl`. Each line is a JSON
value matched in one of two shapes:

- **Objects:** Every declared column must appear as a key (matched by
  exact name per the §7 intro); extra keys are ignored.
- **Arrays:** Length must match predicate arity; elements map to columns in
  order.

Values are type-checked (not coerced): a JSON string is not accepted for an
`integer` column. For nullable columns (`type?`), JSON `null` is accepted
and loaded as runtime `NULL`.

**Single-`value`-column special case.** When the extensional declaration
has exactly one column, and that column is typed `value`, each
non-blank line is consumed as the column's contents directly — any
JSON shape (object, array, primitive, null). This is the natural way
to ingest a stream of heterogeneous self-describing records:

```prolog
input predicate event(payload: value).
```

with `event.jsonl` of the form

```jsonl
{"id": 1, "method": "GET",  "path": "/v1/users",  "status": 200}
{"id": 2, "method": "POST", "path": "/v1/users",  "status": 201}
```

— each line becomes one row whose `payload` column holds the parsed
object as-is.

### 7.3 Google Sheets Loader

Loads data from a Google Sheets spreadsheet. Sheets are mapped to predicate
names via configuration. The first row is treated as headers; every declared
column must appear there (matched by exact name per the §7 intro)
and extra sheet columns are ignored. Values are coerced from strings (like
CSV).

### 7.4 Mermaid Loader

Loads data from a Mermaid graph file named `{predicate}.mmd`. Parses edges
from `graph` or `flowchart` diagrams. Predicates with 2 columns (source,
target) or 3 columns (source, target, label) are supported. Edge labels
are extracted from the `-->|label|` syntax; edges without labels get an
empty string for the label column.

### 7.5 JSON Loader

Loads a JSON document from a file named `{predicate}.json`. A
URL-backed variant (`UrlJsonLoader`) fetches the document over HTTP /
HTTPS instead, mapping each predicate to a configured URL; both
loaders share parsing and error semantics — they only differ in where
the bytes come from.

The extensional declaration must have exactly one column, and that
column must be typed `value`:

```prolog
input predicate config(blob: value).
```

The whole file is parsed as a single JSON value (any shape — object,
array, primitive, or null) and inserted as the sole row's column
value. The natural use is "load this configuration blob and let rules
destructure it":

```prolog
app_name(N) :- config(C), N = as_string(C["name"]).
enabled_feature(F) :-
    config(C),
    object_entry(C["features"], F, Flag),
    as_boolean(Flag) = true.
```

For the `UrlJsonLoader`, only `http:` and `https:` URLs are accepted;
non-2xx responses raise a load-time error carrying the predicate name
and the HTTP status.

```typescript
new UrlJsonLoader({
  urls: {
    config: "https://example.com/config.json",
  },
});
```

### 7.6 Parquet Loader

Loads data from an Apache Parquet file named `{predicate}.parquet`. Only
the declared columns are decoded, which is the point of a columnar format;
a declared column the file lacks is a load-time error rather than an empty
column, and undeclared columns in the file are ignored.

Values are type-checked, not coerced, as in JSONL: a Parquet `BYTE_ARRAY`
does not load into an `integer` column. A `NULL` in the file needs a
nullable column (`type?`), and a repeated or nested column (`LIST`, `MAP`,
a struct) needs a `value` column, whose contents it becomes.

Three of Parquet's physical types have no direct counterpart in the type
lattice (§3):

- **`INT64`** — the default integer width of most writers — is decoded as
  an `integer`, so a value outside `[-(2^53 - 1), 2^53 - 1]` is a
  load-time error rather than a silent rounding.
- A **date or timestamp** column loads as its ISO 8601 text, there being
  no date type; declare the column `string`.
- **Raw bytes** (a `FIXED_LEN_BYTE_ARRAY` carrying no logical type) have
  no representation and are a load-time error. Strings, UUIDs and decimals
  are decoded before this point and are unaffected.

Compression is transparent for uncompressed and Snappy files (Snappy being
what the common writers emit by default). Another codec raises a load-time
error naming it.

## 8 Proof Terms

Naming a rule records *how* each fact is derived. A rule head annotated with a
constructor name, `p(args) :: Ctor`, makes `p` a **proof-carrying** predicate: for
every derivation it carries a proof term, so the predicate's meaning becomes an
algebraic datatype whose inhabitants are its derivations. This is the
Curry-Howard reading of a Horn clause: the predicate, indexed by its head
arguments, is a proposition; each named rule is a constructor; a proof term is
an inhabitant.

### 8.1 Named rules and proof-carrying predicates

A rule head may carry a constructor name after a `::`:

```prolog
suit() :: Hearts.
suit() :: Spades.
num_list(0) :: Nil.
num_list(n + 1) :: Cons :- num(Car), n <= 9, num_list(n).
```

A predicate is *proof-carrying* if any of its rules is named. Naming is
all-or-nothing: either every rule for the predicate is named or none is, and
mixing the two is an error. A proof-carrying predicate may not use aggregates.

Constructors are scoped to their predicate (§1.8): a tag is unique *within* a
predicate but may recur across predicates, so a constructor's full name is
`predicate::Ctor` (for example `num_list::Cons`). As a term (§8.4) it is
referenced either **bare** — `Cons(...)`, resolved to the one predicate that
declares that tag — or **qualified** — `num_list::Cons(...)`. Bare suffices
whenever exactly one predicate declares the tag; when several share it, the
reference must be qualified.

Proof terms also carry a nominal static identity determined by their predicate
(after module elaboration). A body variable cannot simultaneously satisfy two
known disjoint proof identities. Constructor matches check known receiver and
payload types, including nested nullary patterns: a known integer payload cannot
match a string literal, and a proof of one predicate cannot match a constructor
of another. These checks apply in rules, queries, and integrity constraints.

Checks respect published annotations. A producer advertised as `value` hides its
more precise implementation type from consumers, including constructor payload
inference. Unknown or `value` payloads remain matchable and are checked by the
existing runtime guards. This adds no constructors or construction permissions;
proof terms retain the same tagged JSON representation and derivation semantics.

### 8.2 Proof-term structure

With the bare `:: Ctor` form, the proof term of a derivation is the constructor
applied to, in order:

1. the values of the *existential body variables* (the body variables that do
   not appear in the head), in first-occurrence order; then
2. the *sub-proofs* of the positive proof-carrying body atoms, in body order.

Extensional atoms, comparisons, negations, and range/filter elements contribute
nothing, and a don't-care `_` is never a witness.

That list is a consequence rather than a rule of its own. Every premise has a
witness; the ones above are **proof-irrelevant**, meaning any two derivations of
them are the same derivation, so their witness is trivial and would be `true` if
it were ever written down. A trivial witness is drawn from a one-element type and
is always defined (§5.4), so carrying it in the proof term would record nothing
that reading the rule does not already say. It is therefore erased, and what is
left is the enumeration above: the premises whose derivation is worth naming.
Erasure is also why a capture binder on such a premise is rejected rather than
bound to its trivial witness (§8.3).

A proof term is a `value` (§2.9), specifically the object

```
{ "$proof": "<predicate>::<Ctor>", "args": [ <arg>, ... ] }
```

The reserved `$proof` key keeps proof terms from colliding with ordinary JSON
data, and holds the *qualified* constructor name so two predicates' same-named
constructors stay distinct. The proof terms of `num_list` above are therefore
`{"$proof":"num_list::Nil","args":[]}`,
`{"$proof":"num_list::Cons","args":[7,{"$proof":"num_list::Nil","args":[]}]}`,
and so on: the proof terms *are* the lists. Output renders a proof bare —
`Cons(7, Nil())` — dropping the qualifier, which is clear from context.

A rule may instead **list the constructor's arguments explicitly**,
`:: Ctor(a1, ..., an)`, and then the proof term carries exactly those expressions
(usually captured sub-proofs and chosen witnesses) rather than the auto-derived
list. This keeps an intermediate body variable out of the proof term -- for
instance a chart parser's split position:

```prolog
ast(i, k) :: Add(L, R) :- L : ast(i, j), token(j, "plus", _), R : ast(j + 1, k).
```

The split point `j` is a body variable that auto-derivation would record;
`:: Add(L, R)` lists only the two captured sub-parses, so the AST stays clean.
Explicit `:: Ctor()` forces a nullary proof term even for a rule with witnesses.

Because the proof term distinguishes derivations, a proof-carrying predicate is
evaluated as a set of (head-argument, proof-term) rows: two different
derivations of the same fact are two rows, while identical derivations
deduplicate like any other tuple.

### 8.3 Capturing and suppressing proof terms

A proof term is carried implicitly; an ordinary reference `p(args)` does not
mention it. A prefix on a body or query atom controls it:

- `V : p(args)` **captures** the proof term into the variable `V` (read as "V is
  a proof of `p(args)`"), so it can be projected by a query or used elsewhere.
- `_ : p(args)` **suppresses** it, omitting that atom's sub-proof from the
  enclosing constructor.
- a bare `p(args)` neither names nor suppresses: inside a named rule its
  sub-proof is included anonymously; in a query or an unnamed rule the proof is
  ignored.

A query observes proof terms by capturing them:

```prolog
?- Xs : num_list(Len).
```

When a capture ignores every declared column, the parentheses may be dropped:
`V : p` is shorthand for `V : p(_, ..., _)` (one don't-care per declared column,
and just `p()` for a nullary predicate), so `?- Xs : num_list.` captures every
proof of `num_list` without naming its length column. The shorthand is available
only after a `V :` or `_ :` capture; a bare `p` with no capture is still a
variable, not a nullary atom, so ordinary atoms keep their parentheses.

A proof mark may be applied only to a positive atom of a proof-carrying
predicate. Applying one to an extensional or unnamed predicate, or to a negated
atom, is an error.

A negated atom therefore never observes a proof. It is written at the declared
arity like any other reference, and `not p(args)` holds exactly when `p(args)`
has *no* proof, rather than when some particular derivation is missing. Since
§8.2 gives a proof-carrying predicate one row per derivation, this is the reading
to keep in mind when negating one: a fact with several derivations is no less
present than a fact with one.

### 8.4 Destructuring and matching

The `V :` capture surfaces a whole proof term; to look inside one, put a
**constructor pattern** on one side of a body or query equality:

```prolog
opt_value(V) :- P = Some(V).
```

`P = Ctor(p1, ..., pn)` desugars to the capture `P : Pred(_)` (`Pred` being the
predicate `Ctor` names a rule of), the tag guard
`as_string(P["$proof"]) = "Ctor"`, and one match per argument against the
accessor `P["args"][i]`: a variable binds (via `=`), a literal becomes a guard,
`_` ignores the position, and a nested pattern recurses. Because the capture is
part of the desugaring, the scrutinee is range-restricted to `Pred`'s proofs
automatically; a separate `P : num_opt(_)` is no longer needed (though writing
one is harmless).

A pattern's arity must match the constructor's, and a constructor name may not
collide with a built-in operation, so `Ctor(...)` is unambiguous. Extracted
components are `value`-typed, so an explicit coercion (`as_integer(...)` below)
is still needed to use one as a primitive.

**A constructor term is always a match, never a value builder**, and this holds
wherever it appears. In a head argument or a body-atom argument it is read as an
implicit equality against a fresh variable and desugars exactly as above, so
folds and the classic list operations can be written with patterns in the head.
Case analysis is ordinary rule disjunction, one rule per constructor. A fold
sums a list proof term (the head expression `S + as_integer(H)` combines the
tail's sum with the matched head):

```prolog
list_sum(Nil(), 0).
list_sum(Cons(H, T), S + as_integer(H)) :- list_sum(T, S).
```

and append concatenates two:

```prolog
append(Nil(), B, B) :- B : num_list.
append(Cons(H, T), B, Cons(H, R)) :- append(T, B, R).
```

`Cons(H, T)` in a head argument takes a list apart; `Cons(H, R)` relates a
result to a num_list proof. The only thing that *builds* a proof is the head
annotation `:: Ctor` (§8.1); every other `Ctor(...)` matches one a rule already
derived. (append's base case still needs `B : num_list` — shorthand for
`B : num_list(_)`, §8.3 — because `B` is a plain variable passed straight
through, with no constructor term to range-restrict it.)

One consequence is worth stating plainly. Because every constructor term is
range-restricted to its predicate, an operation can only produce proofs the
predicate already enumerates. `num_list` above is finite (lists over a fixed set
up to a length cap), so `append` computes the append *relation restricted to
that universe*: concatenating two lists whose result exceeds the cap yields no
matching proof, and that row drops out. To invent a value that is not a proof of
any predicate, use a raw `value` literal (§2.9), not constructor syntax.

### 8.5 Proving a universal quantification

Because §4.1 range-restricts every variable, "every `C` related to `S` satisfies
`P`" quantifies over a finite relation, so it is a finite conjunction and its
proof is the finite list of the sub-proofs. Both ways of building one use only
what is already here; which applies depends on whether the quantification sits
inside a recursion.

**Outside a recursion, count and collect.** Aggregate the sub-proofs in a helper
predicate, and join against the size of the domain so the list is known to be
complete:

```prolog
pass(S, C) :: Pass :- did_pass(S, C).

n_took(S, count(*))          :- took(S, _).
passes(S, count(*), list(P)) :- took(S, C), P : pass(S, C).

all_passed(S) :: Forall(Ps) :- n_took(S, N), passes(S, N, Ps).
```

Two things carry the weight. The aggregates sit in `passes`, which is not
proof-carrying, so §8.1's rule against aggregates in a proof-carrying predicate
is satisfied; and matching `passes`'s count against `n_took`'s is what makes the
claim universal rather than existential, since without it the rule would fire
whenever *some* course was passed. `all_passed` itself uses no aggregate, and
§8.2's explicit-argument form takes the collected list as it stands.

**Inside a recursion, walk the domain positionally.** §4.5 forbids a recursive
aggregate, so the encoding above is unavailable and the standard answer is a
prefix counter, where `p(X, N)` means "the first `N` elements satisfy it":

```prolog
body_derived(Clause, 0)     :: BNil  :- kb(Clause, _, _).
body_derived(Clause, N + 1) :: BCons :- body_derived(Clause, N), body_atom_derived(Clause, N).
```

Here the list comes for free: the counter's recursion is structural, so the proof
term is already a `Nil`/`Cons` chain of the elements' sub-proofs, the same shape
as any other list-valued proof. `examples/proplog` is the full program, and
`examples/proplog-forall` writes the same thing with a maximal predicate (§4.3)
instead of a counter.

### 8.6 Finiteness

The set of derivations can be infinite even when the set of facts is finite: a
recursion whose constructor nests a sub-proof (for example transitive closure
over a cyclic graph) manufactures unboundedly large proof terms. This is
ordinary `value` growth, so the finiteness check (§5.8, CLI flag
`--warn-finiteness`) flags the proof column of such a recursion as potentially
unbounded. Suppressing the recursive sub-proof with `_ :` removes the growth and
keeps the proof terms finite; it is the way to record a shallow derivation over
cyclic data.

### 8.7 Evaluation

Proof terms are a source-level feature: a proof-carrying predicate gains one
extra `value` column that its named rules fill with a tagged object, and every
constructor term elsewhere desugars to accessors over that column. Every backend
evaluates them (the SQL backends through the usual translation, the in-memory
interpreters directly). As with any recursion, a proof-carrying predicate whose
recursion is non-linear (§4.4) is rejected by the SQL backends and runs only on
the `native` and `seminaive` interpreters. Recursive programs that thread proofs
through several constructor matches (such as the list operations) translate to
SQL with nested accessor chains that can exceed a SQL engine's parser or
expression-depth limit; the in-memory interpreters have no such limit, so they
are the reliable target for substantial proof-term manipulation.

A **maximal predicate** (§4.3) may be proof-carrying, and its proof terms are
ordinary ones. Each side of a parity stratum is a least fixed point, rebuilt from
∅ in every round of the alternating fixed point, so a derivation is finite and
the proof term records the one that survived to the round at which the
alternation converged. The polarity rule puts the opposite side only under
negation, and a negated atom contributes no sub-proof (§8.2), so every sub-proof
inside a maximal predicate's proof term belongs to a predicate of the same
polarity. Like parity stratification itself, this is interpreter-only.

```prolog
# "every child is constant" as a maximal predicate, whose proof term records
# the counterexample child it found.
bad^(E) :: Nonconstant :- child(E, C), not constant(C).
constant(E) :- composite(E), not bad^(E).
```

## 9 Modules

A Datamog file is a **function from input relations to output relations**: its
`input predicate`s are parameters and its `output predicate`s and unnamed `?-`
default (§2.3, §2.4) are results. An `input predicate` can be **bound** with `:=`
to a source — a data file, or an instance of another module. Binding one file's
inputs to other files' outputs composes programs without a separate module
construct.

### 9.1 Source bindings

```
Binding  ::= (Identifier? 'from' STRING ('(' Actual (',' Actual)* ')')?)   -- module
           | (STRING ('as' Identifier)?)                                    -- data file
Actual   ::= Identifier '=' Identifier
```

`from` present means a **module** binding; a bare string is a **data-file**
binding. An input with no binding is a free parameter (§2.2).

**Data file.** `:= "source"` binds the input to a specific file (resolved
relative to the importing file), a URL, or a `gh:` shorthand, instead of the
by-convention default. The loader is chosen by the source's extension, or forced
with `as <format>` (`csv`, `jsonl`, `json`, `mermaid`, `parquet`) when the extension does
not, or cannot, say:

```
input predicate airport(code: string, name: string) := "data/airports.tsv" as csv.
```

**Module.** `:= <export> from "mod.dl"(actual = pred, ...)` instantiates the
module `mod.dl` and binds this input to one of its outputs:

- `<export>` names an `output predicate` of the module; omit it
  (`:= from "mod.dl"(...)`) to take the module's unnamed `?-` default output.
- The parenthesised **actuals** wire the module's own inputs by name
  (`moduleInput = localPredicate`), where `localPredicate` is any predicate in
  the importing file's scope. Their polarities must agree: an
  `input predicate moduleInput^(...)` accepts only a maximal actual. A module
  input the actuals do not wire must be `:=`-bound inside the module; one that
  is neither wired nor bound is an error
  (§9.3) — a module never auto-loads. An actual naming something that is not an
  input of the module is also an error.
- A `:=` binding on a module's own input is a **default**, not a fixture: an
  actual wired for that input overrides it, and the default is then not
  instantiated (§9.3). A module can therefore ship a derived implementation of
  part of its own parameter surface — an interface with default methods — and let
  an importer replace any of it.

```
# reach.dl: reachability, parameterised by an edge relation
input predicate edge(src: integer, dst: integer).
output predicate reach(X, Y) :- edge(X, Y).
output predicate reach(X, Z) :- reach(X, Y), edge(Y, Z).

# main.dl: instantiate reach.dl twice against different relations
input predicate road(src: integer, dst: integer).
input predicate flight(src: integer, dst: integer).
input predicate road_reach(a: integer, b: integer)   := reach from "reach.dl"(edge = road).
input predicate flight_reach(a: integer, b: integer) := reach from "reach.dl"(edge = flight).
?- road_reach(1, X).
```

### 9.2 Elaboration

A program with bindings is **elaborated** into one flat program before analysis;
that program then runs through the ordinary pipeline unchanged, so the backends
need no module-specific support. Per instantiation:

1. The module reference is resolved (relative to the importing file) and parsed.
2. The module's wired inputs are **substituted** with the actuals; every private
   and output predicate name is **freshened** with a per-instance prefix (which
   contains `$`, so it never clashes with a source identifier, §1.4).
3. A data-file binding leaves the input as an EDB, loaded from its bound source.
   Its declaration is freshened like a private predicate, so the data belongs to
   that one instance: a module carrying its own data can be instantiated any
   number of times, and its input names never collide with the importer's.
4. The importing input's name is bound to the selected output by an **alias rule**
   (`local(a, b) :- <instance>$<output>(a, b).`), whose head variables are the
   declared column names. So the importing declaration's column names become the
   result column names, and the module's own head-variable names are not exposed.
   A maximal output uses a maximal alias on both ends; the receiving declaration
   is therefore written `input predicate local^(...)`.
5. Everything merges into one program evaluated by one global least fixed point.

**Instances are shared.** Two bindings of the same module with the same wiring
denote the same relations, so they are elaborated to one expansion that each site
binds its own name into: an interface's several outputs cost one copy of its rules,
not one per output. Instantiation is therefore *applicative* rather than
*generative* in the ML sense — instantiating a module twice with the same arguments
denotes one instance, it does not mint two. Instance identity is the module plus the
predicate each input is wired to; inputs left on a `:=` default need no part in it,
since how a default resolves follows from the module. Differing wiring (including one site overriding a
default that another leaves alone) gives separate instances, as does a module
reached by two paths that do not resolve to the same file.

**A proof-carrying output is bound by name, not by an alias rule.** When the
selected output carries a constructor (§8) it is **renamed** to the importing
input's name, because a constructor is qualified by its predicate: for
`input predicate dist(...) := opt from "..."`, `Some` becomes `dist::Some`, a
writable name the importer can pattern-match. An alias rule could not do this job
— proof-carrying-ness comes from a predicate's own `:: Ctor` rules and does not
propagate through a pass-through rule, so an alias would drop the implicit proof
column. A further binding of the same instance and output therefore takes the
renamed predicate as its own name too: every reference written against the second
name (body atom, proof capture, constructor qualifier) resolves to the first, so
equal wiring yields one relation with one set of constructors. The cost is that
the later declaration's column names are not used, and the shared relation prints
once, under the first name. Instantiations whose wiring *differs* remain separate
instances with distinct constructors, which is what lets one program match several
instantiations of one ADT module side by side.

The receiving declaration counts the **implicit proof column** (§8.2), so it is
one wider than the output's value columns — a `tc(X, Y) :: Step` output is received
as `input predicate p(a: integer, b: integer, why: value)` — and omitting it is an
arity error at the boundary. The declared names apply to the value columns; the
proof column is named only for the declaration's own sake, since a query hides it
(§8.3).

### 9.3 Constraints

- **Every module input must be supplied.** Each input of an imported module must
  be wired by an actual or bound with `:=`; an input that is neither is a static
  error. A module never auto-loads its inputs — the `<name>.csv`-by-convention
  loading is a frontend (CLI / playground) convenience for the entry program's
  free inputs only, not a language feature.
- **An actual overrides a `:=` default.** When an input carries both a `:=`
  binding and a wired actual, the actual wins and the bound source is not
  instantiated at all (for a module binding, no copy of it is expanded; for a data
  binding, nothing is loaded). An actual that names no input of the module is a
  static error, so a misspelled override cannot silently fall back to the default.
- **The instantiation graph must be acyclic.** Two modules whose inputs each
  default to an instance of the other are rejected. This is distinct from
  recursion *within* a module (an ordinary least fixed point, always allowed):
  mutually recursive predicates must live in the same module.
- **One output per import site.** An instance exposes only the selected output;
  the module's other outputs and its `?-` default do not leak into the merged
  program (they remain available internally, both as dependencies of the selection
  and as the target of another site's alias, §9.2).
- **Integrity constraints propagate.** A module's `!-` statements and
  `error predicate` rules (§2.10) survive elaboration and are checked against the
  data actually wired in, once per instance — a module asserts its invariants
  wherever it is instantiated. Unlike the `?-` default, a `!-` is therefore not
  dropped at the import boundary, and is not a candidate for the module's default
  output. A violated module constraint is reported under the name its author
  wrote, plus the binding it arrived through (its internal freshened name, §9.2,
  is not shown); where several bindings share one instance, that is the binding
  the instance was created for, and the constraint is reported once, not per
  binding.
- **Boundary polarity must match.** A maximal module input accepts only a
  maximal actual, and a maximal selected output must be received by an
  `input predicate name^(...)` declaration. A minimal predicate likewise cannot
  cross a boundary declared maximal. The sigil is omitted from actual and export
  names because it is not part of predicate identity (§4.3).
- **Boundary types must satisfy the declaration.** A boundary is checked as a
  directional subtype relation (§5.10), not mutual compatibility: each actual's
  **published** column types must equal or widen to the type declared for the
  module input it is wired to, and the selected output's published types must fit
  within the columns of the importing declaration. Published, not inferred: the
  boundary honours a predicate's advertised contract (§5.10), so a predicate
  declared `value` may not be wired into an `integer` input even while it happens
  to hold integers, and a module output declared `value` may not be imported
  under an `integer` declaration. A declaration may therefore be the same as, or
  wider than, the contract flowing into it (up to `value`), but never narrower --
  declaring `integer` for a column contracted `value` is a static error, since
  the declaration would promise more than the contract guarantees. A mismatch
  either way is a static error.

  Nullness travels the same contract (§5.4). A column whose published nullness
  admits a NULL may not cross a boundary whose declaration omits `?`, in either
  direction: not into a module input, and not out under an importing
  declaration. As with types, the declaration may be looser than the contract
  (declaring `?` for a column that never holds one) but never tighter.

## 10 Examples

### Transitive Closure (Recursion)

```
input predicate parent(name: string, child: string).

ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).

?- ancestor("alice", X).
```

### Fibonacci (Recursion with Arithmetic)

```
fib_step(1, 0, 1).
fib_step(I + 1, Curr, Prev + Curr) :- fib_step(I, Prev, Curr), I < 10.

fibonacci(I, V) :- fib_step(I, _, V).

?- fibonacci(I, V).
```

### Primes (Ranges and Negation)

```
num(I) :- I in [2 .. 30].

divides(D, X) :- num(D), num(X), D > 1, D < X, R = X % D, R < 1.

composite(X) :- divides(_, X).

prime(X) :- num(X), not composite(X).

?- prime(X).
```

### Aggregates (Grouping and Counting)

```
input predicate scores(student: string, subject: string, score: integer).

output predicate student_avg(Student, avg(Score)) :- scores(Student, _, Score).
output predicate total_score(Student, sum(Score)) :- scores(Student, _, Score).
output predicate best_score(Student, max(Score)) :- scores(Student, _, Score).
output predicate record_count(count(*)) :- scores(_, _, _).
```

### String Operations

```
input predicate words(w: string).

prefixed(R) :- words(W), R = "hello_" + W.
lengths(W, N) :- words(W), N = length(W).
initials(W, C) :- words(W), C = W[0].
first_three(W, S) :- words(W), length(W) >= 3, S = W[:3].

?- prefixed(R).
```

### Shortest Path (Recursion with Aggregation)

```
road("castle", "village", 2).
road("castle", "forest", 5).
road("village", "bridge", 4).
road("village", "castle", 3).
road("forest", "river", 3).
road("river", "village", 1).
road("river", "bridge", 2).

max_cost(sum(W)) :- road(_, _, W).

path(X, Y, C) :- road(X, Y, C).
path(X, Y, C) :-
  path(X, Z, C0), road(Z, Y, C1),
  max_cost(Max), C0 < Max,
  C = C0 + C1.

shortest(X, Y, min(C)) :- path(X, Y, C).

?- shortest(X, Y, C).
```

### Reaching Definitions (Data-Flow Analysis)

```
cfg("start", "b1").
cfg("b1", "b2").
cfg("b1", "b3").
cfg("b2", "b4").
cfg("b3", "b4").
cfg("b4", "b1").
cfg("b4", "end").

gen("b2", "d1").
gen("b4", "d2").

kill("b4", "d1").
kill("b2", "d2").

reaches(D, U) :- gen(U, D).
reaches(D, V) :- cfg(U, V), reaches(D, U), not kill(U, D).

?- reaches(Def, Block).
```

### Shannon Entropy (Strings, Ranges, Aggregates, Math)

```
text_input("abracadabra").

char_at(I, C) :- text_input(S), I in [0 .. length(S) - 1], C = S[I].

total(count(*)) :- char_at(_, _).
freq(C, count(*)) :- char_at(_, C).

output predicate prob(C, P) :- freq(C, N), total(T), P = (N * 1.0) / T.

contribution(C, X) :- prob(C, P), X = -1.0 * P * ln(P) / ln(2).

output predicate entropy(sum(X)) :- contribution(_, X).

?- freq(C, N).
```

## 11 Error Categories

Datamog reports errors with source positions (byte offsets) for IDE
integration:

| Category        | Examples                                                    |
|-----------------|-------------------------------------------------------------|
| **Parse error** | Missing period, unexpected token, malformed expression       |
| **Analyzer error** | Undefined predicate, arity mismatch, unsafe variable, unstratifiable negation, duplicate input predicate declaration, EDB/IDB conflict, aggregate constraint violation, unknown function, function arity mismatch |
| **Type error**  | Non-numeric range bounds, unary minus on string, subscript/slice on non-string, wrong function argument type |
| **Nullable operand** | A nullable expression in a position that computes: arithmetic, negation, a bitwise operator, string concatenation, a subscript or slice index, a range bound, a builtin with a primitive parameter, either branch of a conditional, or `sum` / `avg` / `min` / `max` / `concat` (§5.4). Narrow with `<> null` first |
| **Module error** | Import cycle, missing default output, unknown named export, boundary type/arity mismatch (§9), unreadable module reference |
| **Translation error** | Non-linear recursion, parity-stratified recursion (SQL backends only — `native` and `seminaive` accept both) |
