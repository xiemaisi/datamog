# Datamog Language Specification

Datamog is an educational Datalog dialect. Programs declare table-backed
predicates, define derived predicates via rules, and issue queries.

Datamog ships with five backends. All of them implement the same
language semantics and agree on runtime invariants (divide-by-zero /
domain-error NULLs, slice bounds, integer vs float division); they
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
to finite JavaScript `Number` values; integer literals must also fit in the
safe-integer range.

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

It is polymorphic (no fixed base type) and propagates through every
operation except logical equality (Section 5.4). A column can never be
declared with type `null`; it acquires a type from another rule that
contributes a non-null value, and `null` flows through at runtime.

### 1.6 Keywords

**Lexical keywords** cannot appear as a bare identifier in any position
(predicate, column, or variable):

```
not    in    true    false    null
string    integer    float    boolean    value
```

`input`, `output`, `error`, `predicate`, `from`, and `as` are **contextual
keywords**: they lead the `input predicate` / `output predicate` /
`error predicate` declaration forms and the `:=` source binding (§9), but are
ordinary identifiers everywhere else, so a program may still name a predicate,
column, or variable after them (for example the `from`/`to` columns of an edge
relation, or a predicate called `error`).

**Built-in operation names** (functions, body atoms, and aggregates) are
reserved only against unquoted predicate names; they may be used as input-predicate
columns and as variables:

```
object_entry    array_element
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
Grouping:      (  )  [  ]
Separators:    ,  :  .
```

`=`/`<>` are the language's only equality and inequality, and they are
null-aware: `null = null` is true. Every comparison is total, so none of
them ever returns NULL (§5.4). Body-level Equality reuses the same
operator and can bind an unbound bare variable on either side.

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

- **Reserved keywords**: `input predicate`, `not`, `in`, `true`, `false`, `null`,
  and the five type names `string`, `integer`, `float`, `boolean`, `value`.
  These are *lexical* keywords, so the parser rejects them as a bare identifier
  in every position (predicate, extensional column, and variable alike). `true`, `false`,
  and `null` are also the literals of §1.5.
- **Built-in operation names**: one set covering the three kinds of built-in
  operation, the *functions* (`upper`, `abs`, `as_integer`, `to_json`,
  and so on), the *body atoms* (`object_entry`, `array_element`), and the
  *aggregates* (`count`, `sum`, `avg`, `min`, `max`, `concat`, `list`). The
  complete list is in §1.6. Lexically these are ordinary identifiers; they are
  reserved only against predicate names, and may be used freely as extensional
  columns and as variables.
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
Statement   ::= ExtDecl | Rule | Query | Constraint
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
ExtDecl     ::= 'input' 'predicate' Identifier '(' ColumnDecl (',' ColumnDecl)* ')' (':=' Binding)? '.'
ColumnDecl  ::= Identifier (':' PrimitiveType)? ('?')?
PrimitiveType ::= 'string' | 'integer' | 'float' | 'boolean' | 'value'
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

The optional `?` suffix marks a column as nullable. Nullable columns keep the
same Datamog base type for type inference, but loaders and the generated table
permit runtime `NULL` values.

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
HeadTerm    ::= (AggregateCall | Expression) (':' PrimitiveType)?
```

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
built-in atom `not e` is logical negation of the comparison and is
exactly equivalent to the filter `!(e)` (see *Filters* below); it carries
no stratification obligation, since built-ins do not recurse.

```
not X = Y                # equivalent to the filter !(X = Y)
not Age < 18             # equivalent to !(Age < 18)
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
  A bare `null` literal is the exception: it names no type (Section
  1.5), so `X = null` cannot introduce `X`, which stays unsafe. To
  bind a NULL, name the type: the `as_*` projections give the four
  primitives, `parse_json("null")` gives a `value`.
- **Constraint** — both sides are already bound expressions. Both
  sides are evaluated and compared with logical equality; the rule
  fires when they match (including the case where both are NULL).

```
D = S * 2          # binding: D := S * 2
C = X + Y + 1      # binding: C := X + Y + 1
X + 1 = Y          # binding: Y := X + 1 when X is safe
length(W) = 3      # constraint
N = null           # constraint when N is bound (matches null rows);
                   # unsafe when N is unbound: `null` names no type
N = as_integer(null)     # binding: N := an integer NULL
S = as_string(null)      # binding: S := a string NULL
V = parse_json("null")   # binding: V := a value NULL
```

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

A leading `not` negates a built-in atom — `not e` is sugar for the filter
`!(e)`, applied after the predicate-literal alternative (so `not p(X)`
remains a negated predicate literal, while `not X = Y` is a negated
comparison). This is the negation referred to under *Literals* above.

```
Age >= 30                          # single comparison
X <> Y                             # single comparison
(S > 80) && (S < 95)               # compound filter
(N = 3) || (N = 5) || (N = 7)      # disjunction of equalities
```

A filter expression must have type `boolean` — non-boolean filters
(`X + 1`, `length(S)`) are rejected at analysis time. A NULL filter
value is treated as "doesn't match", same as SQL's `WHERE`, so the row
is dropped. Comparisons are total (§2.6) and never produce that NULL;
it can only arrive from a nullable `boolean?` column or an expression
that propagates one into boolean position.

### 2.6 Expressions

Expressions are used in atom arguments, equality right-hand sides,
comparisons, ranges, and rule heads. The grammar uses precedence levels:

```
Expression     ::= Or
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

`**` binds tighter than the multiplicative operators but its left operand
is a unary expression, so `-2 ** 2` is `(-2) ** 2`. It is always float-
valued, with the domain guards described in §5.4. The bitwise / shift
levels mirror C and Java: shifts bind tighter than comparison, and
`&`/`^`/`|` bind looser than comparison but tighter than the logical
connectives. See §5.9 for their integer semantics.

The Datalog source uses `%` for modulo, matching the SQL `%` operator
that the translator emits. (Datamog comments use `#`, so the lexer
sees the two characters distinctly.)

#### Boolean Operators

`&&`, `||`, and `!` are *logical* operators on `boolean` values
(matching C's `&&`/`||`/`!`, not the bitwise `&`/`|`/`~`). Operands
must be of type `boolean`; the result is also `boolean`. The
translator emits `AND`, `OR`, and `NOT` respectively.

NULL operands extend these via SQL three-valued logic — see
Section 5.4 for the truth tables and short-circuit rules.

#### Comparison Operators

The comparison operators all produce `boolean`, and all of them are
**total**: no operand combination returns NULL. There is one equality,
`=` / `<>`, which is null-aware. Ordering treats `null` as an isolated
point in the order, comparable only to itself.

| operator | meaning | NULL behaviour | SQL emit |
|----------|---------|----------------|----------|
| `=` | equality | `null = null` is true; `null = X` is false | `IS NOT DISTINCT FROM` (Postgres), `IS` (SQLite / sql.js) |
| `<>` (also `!=`) | inequality | inverse of `=` | `IS DISTINCT FROM` / `IS NOT` |
| `<` `>` | strict ordering | false whenever either side is null | `COALESCE(a < b, FALSE)` |
| `<=` `>=` | ordering | true when both sides are null, otherwise false if either is | `COALESCE(a <= b, (a IS NULL AND b IS NULL))` |

The full table, with `5` standing for any non-null value:

| left | right | `=` | `<>` | `<` | `<=` | `>` | `>=` |
|--------|--------|-------|-------|-------|-------|-------|-------|
| `5` | `5` | true | false | false | true | false | true |
| `5` | `null` | false | true | false | false | false | false |
| `null` | `5` | false | true | false | false | false | false |
| `null` | `null` | true | false | false | true | false | true |

This is a partial order: `<=` is reflexive, antisymmetric and
transitive, and `a < b` is equivalent to `a <= b && a <> b`. It is not
total — `null` and `5` are incomparable, so neither `X < 2` nor
`X >= 2` holds of a NULL `X`. Guard with `<> null` where that matters.
There is no three-valued comparison family; a second equality would be
indistinguishable from `=`.

```
Age >= 30                             # ordering
X <> Y                                # inequality
X = Y                                 # equality (null-aware)
N = null                              # matches null rows
N <> null                             # matches non-null rows
B = (Score = 100)                     # bind B to a boolean
```

Operands must have compatible types (same type, or `integer`/`float`
joining via Section 5.6); the `null` literal is polymorphic and
composes with any operand type. Booleans support equality only
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
  array-`value` slices, `""` for string subscripts (the receiver's
  empty value), and `NULL` for `value` subscripts that fall out of
  range.

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
| `to_integer(s)`      | `string`                  | `integer`   | Strict canonical decimal. NULL on parse failure. |
| `to_float(s)`         | `string`                  | `float`      | Strict canonical decimal (no exponent). NULL on parse failure. |
| `to_boolean(s)`      | `string`                  | `boolean`   | Accepts exactly `'true'` / `'false'`. NULL otherwise. |
| `parse_json(s)`      | `string`                  | `value`     | Parse `s` as JSON syntax. NULL on malformed input. |

The string → number parsers accept only canonical decimal form: optional
`-`, no leading zeros (except plain `0`), no leading `+`, no whitespace.
`to_integer` additionally caps at ±999,999,999 (9 digits absolute value)
to fit within every backend's natural 32-bit integer range. `to_float`
accepts an optional `.<digits>` fraction; exponent forms (`1e10`) are
rejected.

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

### 2.7 Aggregates

```
AggregateCall ::= IDENT '(' (Expression | '*') ')'
```

The `*` wildcard is accepted only by `count` (see below).

where `IDENT` is one of: `count`, `sum`, `avg`, `min`, `max`,
`concat`, `list`.

Aggregates may only appear as **top-level arguments** in rule heads (not
nested in expressions, not in rule bodies). Non-aggregate head arguments
become GROUP BY columns in the generated SQL.

```
student_avg(Student, avg(Score)) :- scores(Student, _, Score).
#           ^^^^^^^ grouping      ^^^^^^^^^^^ aggregate

record_count(count(*)) :- scores(_, _, _).
#            ^^^^^^^^^ count with no grouping columns
```

The argument `*` is a wildcard accepted only by `count`: `count(*)` counts
every row in the group and translates to SQL `COUNT(*)`. Given an expression,
`count(expr)` counts the rows in which `expr` is non-null. Neither counts
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
backend. SQL `NULL` inputs are skipped, and an all-`NULL` or empty
group yields `NULL` — matching `concat` and the rest of the
aggregate family.

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

Datamog has a `value` column type — the union of every kind a
column can carry: primitive leaves (`null`, `boolean`,
`integer`, `float`, `string`) plus the two structured shapes
(arrays and objects). When persisted, `value` columns are
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
     anything on a primitive leaf) → SQL `NULL`.
3. **Slice** `X[I:J]` where `X : value`. Returns `value`.
   - Operates on arrays only; slicing a non-array → SQL `NULL`.
   - Empty / reversed range (`I >= J`) → `[]`.
4. **Iteration primitives** (built-in body atoms — see below).
5. **Coercion / introspection builtins** (see below).
   `as_string` / `as_integer` / `as_float` / `as_boolean` /
   `length` / `type_of` / `has_key` read leaf primitives or summarise
   structure; `parse_json` produces a `value` from a JSON
   syntax string (NULL on malformed input).
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
key. The coercion/projection functions return `NULL` on shape
mismatch — there is no implicit conversion. `has_key` instead returns
`false` for non-object values and absent keys, while preserving ordinary
function NULL propagation for `NULL` arguments. `parse_json` parses a
string as JSON syntax, returning `NULL` on malformed input rather than
raising.

| Datamog          | Returns   | Behaviour                                                          |
|------------------|-----------|--------------------------------------------------------------------|
| `as_string(V)`   | `string`  | string-leaf → string content; anything else → `NULL`.              |
| `as_integer(V)`  | `integer` | Integer-valued numeric leaf in JS safe-integer range (±(2^53−1)) → integer; anything else (including a numeric leaf with a fractional part) → `NULL`. |
| `as_float(V)`    | `float`   | Numeric leaf → float; anything else → `NULL`.                      |
| `as_boolean(V)`  | `boolean` | Boolean leaf → boolean; anything else → `NULL`.                    |
| `length(V)`      | `integer` | Array length / object key count / string length; non-collection → `NULL`. |
| `type_of(V)`     | `string`  | Returns one of `"object"`, `"array"`, `"string"`, `"number"`, `"boolean"` for non-NULL values. Returns `NULL` if `V` evaluates to `NULL`. |
| `has_key(V, K)`  | `boolean` | Object has own string key `K` → `true`; missing key or non-object `V` → `false`; `NULL` argument → `NULL`. |
| `keys(V)`        | `value`   | Sorted array of the object's keys (each as a string; Unicode-code-point order); empty object → `[]`; non-object → `NULL`. |
| `values(V)`      | `value`   | Array of the object's values, ordered by key in Unicode-code-point order; empty object → `[]`; non-object → `NULL`. |
| `to_json(V)`     | `string`  | Canonical JSON text for canonical `value`s (object keys in canonical JSON order, no whitespace), safe as a hash / dedup key. |
| `parse_json(s)`  | `value`   | Parse `s` as JSON syntax. `NULL` on any malformed input, matching `to_integer` / `to_float` / `to_boolean`. |

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

The `null` leaf collapses to SQL `NULL` for cross-backend
uniformity. As a consequence, `type_of(parse_json("null"))` and
`type_of(J["key"])` for a JSON-null leaf return `NULL`, not the string
`"null"`; the runtime expression model does not distinguish a JSON-null
leaf from another NULL-producing expression.

JS `Number` precision (IEEE doubles, 2⁵³) caps integer fidelity
for numeric leaves — values larger than 2⁵³ may round through
canonicalisation. This is the same constraint that already
applies to `integer`-typed columns elsewhere in Datamog.
Non-finite numeric leaves produced by host JSON parsers (for example
`9e999` overflowing to IEEE `Infinity`) are rejected: `parse_json`
returns `NULL` for the whole input.

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
and be referenced from other rules. Nothing about the marker changes how the
predicate is evaluated or how it is compiled (§6) — only what happens to a
non-empty result. See §4.7 for when constraints are checked, and §9 for how a
module's constraints reach its importer.

## 3 Formal Grammar

For reference, the complete grammar in BNF notation:

```
Program        ::= Statement*

Statement      ::= ExtDecl | Rule | Query | Constraint

ExtDecl        ::= 'input' 'predicate' Identifier '(' ColumnDecl (',' ColumnDecl)* ')' (':=' Binding)? '.'
ColumnDecl     ::= Identifier (':' PrimitiveType)? ('?')?
PrimitiveType  ::= 'string' | 'integer' | 'float' | 'boolean' | 'value'
Binding        ::= (Identifier? 'from' STRING ('(' Actual (',' Actual)* ')')?)   -- module
                 | (STRING ('as' Identifier)?)                                    -- data file
Actual         ::= Identifier '=' Identifier

Rule           ::= (('output' | 'error') 'predicate')? HeadAtom (':-' BodyElement (',' BodyElement)*)? '.'
HeadAtom       ::= Identifier '^'? '(' (HeadTerm (',' HeadTerm)*)? ')'
HeadTerm       ::= (AggregateCall | Expression) (':' PrimitiveType)?
AggregateCall  ::= IDENT '(' Expression ')'

Query          ::= '?-' BodyElement (',' BodyElement)* '.'
Constraint     ::= '!-' BodyElement (',' BodyElement)* '.'

BodyElement    ::= Literal | Equality | RangeAtom | Filter
Literal        ::= ('not')? Atom
Atom           ::= Identifier '^'? '(' (Expression (',' Expression)*)? ')'
Equality       ::= Addition '=' Expression
RangeAtom      ::= Expression 'in' '[' Expression '..' Expression ']'
Filter         ::= ('not')? Expression

Expression     ::= Or
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
                  | ArrayLiteral | ObjectLiteral
BOOLEAN        ::= 'true' | 'false'
FunctionCall   ::= IDENT '(' Expression (',' Expression)* ')'
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
default. The sigil is written at every occurrence of the name -- rule heads,
body literals, and queries -- and all of them must agree, since the definition
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
3. **Top-level only:** Aggregates must appear as direct head arguments, not
   embedded in arithmetic expressions.
4. **No nesting:** Aggregate calls may not contain other aggregate calls.
5. **Name conflict:** A predicate name cannot be the same as an aggregate
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

Datamog has five basic types:

| Type      | Description           | SQL type                                  |
|-----------|-----------------------|-------------------------------------------|
| `string`    | Unicode strings       | `TEXT`                                    |
| `integer` | Whole numbers         | `INTEGER`                                 |
| `float`    | Floating-point numbers| `DOUBLE PRECISION` (Postgres) / `REAL` (SQLite/sql.js, 8-byte) |
| `boolean` | True/false values     | `BOOLEAN`                                 |
| `value`   | union of `null` / `boolean` / `integer` / `float` / `string` / array / object | `JSONB` (Postgres) / `TEXT` (SQLite/sql.js) |

SQLite and sql.js have no native `BOOLEAN` storage type — they round-
trip `TRUE`/`FALSE` and comparison results as `0` / `1`. The executor
coerces those back to JS `true`/`false` at the result-row boundary
for any column whose declared type is `boolean`, so query-result
shape is uniform across every backend.

The `value` type is opaque to the type system — the spec does not
distinguish an object-shaped `value` from an array-shaped `value`
from a string-leaf `value` statically. Only the EDB declaration, the
iteration primitives, and the coercion builtins (§2.9) make any
structural commitment. See §2.9 for the operators and builtins that
work on `value`s.

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
| Null literal `null`       | polymorphic — composes with any operand    |
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

A handful of these operations are *runtime-partial* — arithmetic
overflow, `/`, `%`, `sqrt`, `ln`, `exp`, and `**` evaluate to
`NULL` for inputs outside their mathematical / finite-number domain
rather than raising an error or producing an IEEE special value. The
full list, propagation rules, and three-valued logic are in Section 5.4.

#### Expression totality

Every well-typed expression denotes a total function from assignments of
runtime values to its free variables (respecting their inferred types) to
exactly one Datamog runtime value. Expressions are never nondeterministic,
set-valued, or allowed to abort evaluation. Operations that would be
partial in the host language or database instead return `NULL` as specified
below, and ill-typed expressions are rejected by the analyzer before
execution.

### 5.4 NULL Semantics

Datamog exposes NULL as the polymorphic literal `null` (Section
1.5), but it is otherwise a *runtime* phenomenon: every column has
a non-null declared base type, and most operations propagate NULL
when given one. The *logical* equality operators `=`/`<>` (Section
2.6) are the exception — they treat null as a value and return a
total boolean.

#### Sources

NULL enters an expression through the `null` literal or through
runtime-partial operations, builtins, and accessors:

1. **The `null` literal** in source — appears anywhere a value is
   expected, with no fixed base type.
2. **Partial math operations** — the following yield `NULL` rather than
   raising a database error or producing an IEEE special value, so
   semantics are identical on every backend:

   - `+`, `-`, `*`, `/`, `%`, unary `-`, and math builtins when the
     result would be non-finite (`Infinity`, `-Infinity`, or `NaN`).
   - `a / b` and `a % b` when `b = 0`.
   - `sqrt(x)` for `x < 0`.
   - `ln(x)` for `x <= 0`.
   - `exp(x)` when the result overflows the finite `float` range.
   - `x ** y` for `x < 0` with fractional `y`, or for `x = 0`
     with `y < 0`, or when the result overflows the finite `float`
     range.
3. **Partial conversions, value builtins, and value accessors** —
   malformed `parse_json`, failed `to_*` parses, failed `as_*`
   projections, wrong-shape `length` / `keys` / `values`, and missing or
   wrong-shape `value` subscripts/slices yield `NULL`.

Slice with `i >= j` produces the empty string `""` / empty array `[]`
(Section 2.6); a string subscript out of range produces `""`; a `value`
subscript out of range / missing key / wrong-shape access produces `NULL`.

Non-null EDB columns are emitted with `NOT NULL`, so loaders cannot
introduce NULL through those extensional columns — coercion failures raise
load-time errors instead. EDB columns declared with `?` omit `NOT NULL`
and may contain runtime NULLs.

#### Propagation in expressions

NULL propagates through arithmetic, string concatenation, subscript,
slice, and built-in (non-aggregate) functions: any `NULL` operand
makes the whole expression `NULL`. The exceptions are `&&` and `||`
(short-circuit, see below) and the logical-equality operators
`=`/`<>` (null-aware, see below).

#### Three-valued boolean logic

`&&`, `||`, and `!` extend to NULL via SQL three-valued logic,
identical on every backend including the native evaluator:

```
true  && true  = true       true  || true  = true       !true  = false
true  && false = false      true  || false = true       !false = true
false && false = false      false || false = false      !null  = null
null  && true  = null       null  || true  = true
null  && false = false      null  || false = null
null  && null  = null       null  || null  = null
```

`false` dominates `&&` and `true` dominates `||` — when one operand
decides the answer, NULL on the other side does not propagate.

#### Comparisons and filters

**Comparison is where NULL stops travelling.** Every comparison
operator is total: no operand combination returns NULL, so a filter
built from comparisons alone never drops a row "silently for null
reasons", and `not` over a comparison is genuine complementation.

`=` and `<>` are null-aware (`null = null` is `true`). Ordering treats
`null` as an isolated point in the order, comparable only to itself.

| left   | right  | `=`    | `<>`   | `<`   | `<=`  | `>`   | `>=`  |
|--------|--------|--------|--------|-------|-------|-------|-------|
| `5`    | `5`    | true   | false  | false | true  | false | true  |
| `5`    | `6`    | false  | true   | true  | true  | false | false |
| `5`    | `null` | false  | true   | false | false | false | false |
| `null` | `5`    | false  | true   | false | false | false | false |
| `null` | `null` | true   | false  | false | true  | false | true  |

A NULL can still reach filter position from elsewhere: a nullable
`boolean?` column, `as_boolean(null)`, or an expression that
propagates a NULL into a boolean slot. Such a row is dropped, matching
SQL's `WHERE`. See Section 2.6 and `doc/design/null.md` §5.

#### Equalities (body-level)

Body Equality (Section 2.5) is the same logical operator. It has two
roles:

- **Binding** (one side is an unbound bare variable): `X = expr` or
  `expr = X` introduces `X` and sets it to the value of `expr`,
  including when `expr` evaluates to NULL — the row is *not* dropped,
  and subsequent uses of `X` propagate that NULL through any
  non-logical operation. `expr` must name a type, so a bare `null`
  does not bind (Section 2.5): `X = 1 / 0` introduces an integer `X`
  whose value is NULL, while `X = null` leaves `X` unsafe.
- **Constraint** (both sides already bound): the body equality emits a
  null-aware comparison. `X = null` matches NULL rows; `Y = Z` with
  both bound matches when both happen to be NULL.

Atom matching uses the same null-aware equality: a literal `null` in
an atom argument matches a NULL column, and a shared variable across
two atoms joins NULL to NULL. `p(X), q(X)` and `p(X), q(Y), X = Y`
therefore denote the same relation, as they should, and a NULL row of
`q` is excluded from `not q(X)`. This departs from SQL, which joins
three-valued; `doc/design/null.md` §4 gives the reasoning and §6 the
cost, which is a quadratic plan for a large nullable-column join on
the Postgres backend.

#### Aggregates

Aggregates inherit standard SQL semantics:

- `count(*)` translates to `COUNT(*)` — counts every group row,
  including those with NULLs in other columns.
- `count(expr)`, `sum(expr)`, `avg(expr)`, `min(expr)`, `max(expr)`,
  `concat(expr)` ignore rows where `expr` is NULL.
- A group whose `expr` is NULL for every row yields NULL for
  `sum`/`avg`/`min`/`max`/`concat` and `0` for
  `count(expr)`.

The aggregate's result *type* (Section 5.5) is unaffected by this:
Datamog has no nullable types, so an all-NULL group simply emits a
runtime NULL in a column whose declared type is still "same as
`expr`" (or `integer` / `float` / `string`, per Section 5.5). NULL is
always a possible runtime value of any column; the type system
only fixes what the *non-NULL* values look like.

#### Heads

A rule whose head expression evaluates to NULL still emits a row,
with NULL in the corresponding column. Downstream rules reading
that column propagate the NULL through the rules above (filtered
out by comparisons, ignored by aggregates, kept by binding
equalities).

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

Every column of every predicate is typed with exactly one of `string`,
`integer`, `float`, `boolean`, or `value`.

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
  `parse_json` accepts exactly `string` (NULL on malformed input).
  Failed string parses produce `NULL` rather than raising.
- **Iteration primitives** (`object_entry`, `array_element`): the
  source argument (position 0) must have type `value`; the bound
  positions are typed per §2.9.
- **Comparisons and non-binding equalities**: the two sides must have
  compatible types (same type, or `integer`/`float`, or
  primitive ↔ `value` via auto-lift — see §2.9 and §5.6). The
  ordering operators `<`, `<=`, `>`, `>=` additionally reject
  `boolean` and `value` operands.

```
X in [1 .. 10]            # OK: integer bounds
X in ["a" .. "z"]         # ERROR: non-numeric bounds
-"hello"                  # ERROR: unary minus on string
42[0]                     # ERROR: subscript on integer
length(42)                # ERROR: length expects string or value
sqrt("hello")             # ERROR: sqrt expects numeric
X > "5"                   # ERROR: comparing integer with string (if X : integer)
B > true                  # ERROR: '>' does not order booleans
J > J2                    # ERROR: '>' does not order `value` (if J, J2 : value)
as_integer("42")              # ERROR: as_integer expects value, got string
length(42)                # ERROR: length expects string or value
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
error (§5.7). A `NULL` operand propagates to `NULL` (§5.4).

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

The 32-bit width is not incidental: it is the width of the `integer`
column type on the most constrained backend (Postgres `INTEGER`) and of
JavaScript's native bitwise operators (used by the in-memory evaluators).
The translator reconciles the backends that differ: SQLite has no XOR or
`>>>` operator and computes in 64-bit, so XOR is emulated as
`(a | b) & ~(a & b)`, `>>>` masks the operand to unsigned 32-bit before
shifting, and both `<<` and `>>>` wrap their 64-bit result back to signed
32-bit; Postgres spells XOR `#`, masks shift counts mod 32, and emulates
`>>>` via a `bigint` mask. See §6.8.

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

## 6 SQL Translation

### 6.1 Overview

A Datamog program translates to three groups of SQL statements:

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

Each rule translates to a SELECT statement. The translation makes a single
left-to-right pass over the body elements, classifying them into:

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
```

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
external column or key names (CSV, JSONL object form, Google Sheets)
match them **by exact name** (case-sensitively). A declaration
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
  `-?[1-9]\d{0,8}` (nine digits maximum); `float` requires canonical
  decimal `((0|-?[1-9]\d*)(\.\d+)?|-0\.\d+)` (no exponent, no leading
  `+`, no leading zeros except plain `0`, no surface `-0`); `boolean`
  accepts `true`/`1`/`yes` and `false`/`0`/`no` (case-insensitive,
  surrounding whitespace allowed). Anything else raises a load-time error
  rather than silently coercing.
- A `value` column accepts any JSON text; the contents are parsed
  with `JSON.parse` and canonicalised on insert.
- For nullable columns (`type?`), an empty or whitespace-only cell is loaded
  as runtime `NULL`.
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

### 8.2 Proof-term structure

With the bare `:: Ctor` form, the proof term of a derivation is the constructor
applied to, in order:

1. the values of the *existential body variables* (the body variables that do
   not appear in the head), in first-occurrence order; then
2. the *sub-proofs* of the positive proof-carrying body atoms, in body order.

Extensional atoms, comparisons, negations, and range/filter elements contribute
nothing, and a don't-care `_` is never a witness. A proof term is a `value`
(§2.9), specifically the object

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
any predicate, use a raw `value` literal (§7), not constructor syntax.

### 8.5 Finiteness

The set of derivations can be infinite even when the set of facts is finite: a
recursion whose constructor nests a sub-proof (for example transitive closure
over a cyclic graph) manufactures unboundedly large proof terms. This is
ordinary `value` growth, so the finiteness check (§5.8, CLI flag
`--warn-finiteness`) flags the proof column of such a recursion as potentially
unbounded. Suppressing the recursive sub-proof with `_ :` removes the growth and
keeps the proof terms finite; it is the way to record a shallow derivation over
cyclic data.

### 8.6 Evaluation

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
with `as <format>` (`csv`, `jsonl`, `json`, `mermaid`) when the extension does
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
  the importing file's scope. A module input the actuals do not wire must be
  `:=`-bound inside the module; one that is neither wired nor bound is an error
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
| **Module error** | Import cycle, missing default output, unknown named export, boundary type/arity mismatch (§9), unreadable module reference |
| **Translation error** | Non-linear recursion (SQL backends only — `native` and `seminaive` accept it) |
