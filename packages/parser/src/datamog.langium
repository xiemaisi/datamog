grammar Datamog

// =============================================================================
// Datamog — an educational Datalog dialect
//
// Extensional declarations define table-backed predicates.
// Rules compile to SQL views (including recursive views).
// Queries execute SELECT statements against the generated views.
// =============================================================================

entry Program:
    statements+=Statement*;

// --- Statements --------------------------------------------------------------

Statement:
    ExtDecl | Rule | Query;

// An input predicate: a parameter supplied from outside the rules (a data
// file at the CLI, or a wired module output on import). The AST node keeps
// its historical `ExtDecl` name; only the surface keyword changed from
// `extensional` to `input predicate`. The optional `^` declares the polarity of
// a module input or receiving binding, matching the sigil on rules and literals.
ExtDecl:
    'input' 'predicate' predicate=Identifier (maximal?='^')?
        '(' columns+=ColumnDecl (',' columns+=ColumnDecl)* ')'
        (':=' binding=Binding)? '.';

// The optional source an input predicate is bound to. `from` present means a
// module instantiation; a bare string means a data file. For a module, an
// omitted export name takes the module's unnamed default output, a name selects
// that `output predicate`, and the parenthesised actuals wire the module's own
// inputs (`moduleInput = localPredicate`). For a data file, `as <format>`
// forces a loader when the extension does not (or cannot) say; the format is a
// plain identifier checked against the loader registry, not a keyword.
Binding:
    ((export=Identifier)? isModule?='from' source=STRING
        ('(' actuals+=Actual (',' actuals+=Actual)* ')')?)
  | (source=STRING ('as' format=Identifier)?);

Actual:
    param=Identifier '=' arg=Identifier;

// The type annotation is optional; an unannotated column defaults to `string`
// (applied in `parseRaw` via `defaultColumnTypes`, so every later stage sees a
// concrete type). `a?` is a nullable untyped column, `a: integer?` a typed one.
ColumnDecl:
    name=Identifier (':' (type=PrimitiveType | shape=StructuralType))? (nullable?='?')?;

// Structural input-column types use JSON storage. Field presence and nested
// value nullability are independent.
StructuralType:
    RecordType | ArrayType;

RecordType:
    '{' (fields+=TypeField (',' fields+=TypeField)*)? '}';

TypeField:
    (name=Identifier | name=STRING) (optional?='?')? ':' value=TypeValue;

ArrayType:
    '[' element=TypeValue ']';

TypeValue:
    (type=PrimitiveType | shape=StructuralType) (nullable?='?')?;

PrimitiveType returns string:
    'string' | 'integer' | 'float' | 'boolean' | 'value' | 'null';

// Using `':' '-'` as two tokens instead of the composite `:-` keyword so
// that the lexer doesn't greedily munch the `:` in a slice like
// `W[0:-1]` together with its leading `-`.
//
// A named rule `:: Ctor` builds a proof term. Bare `:: Ctor` auto-derives the
// constructor's arguments (existential witnesses then sub-proofs);
// `:: Ctor(a, b, ...)` lists them explicitly instead, so a rule can name exactly
// what the proof term carries (typically captured sub-proofs) and leave
// intermediate variables out. `ctorParens` records that the argument list was
// written, distinguishing explicit `:: Ctor()` (nullary) from bare `:: Ctor`.
// A rule prefixed `output predicate` is a named output: it defines its
// predicate exactly like any rule and additionally exposes the predicate as a
// printed result, run like an implicit `?- head` query. Types are inferred, so
// the head takes ordinary variable arguments and reads like the intensional it
// is. A predicate is an output if any of its rules carries the marker.
//
// `error predicate` is the same shape with the opposite disposition: the
// predicate is an integrity constraint whose extension must be empty. Its
// tuples are the counterexamples, reported and fatal instead of printed. A
// predicate is a constraint if any of its rules carries the marker.
Rule:
    ((output?='output' | error?='error') 'predicate')?
    head=HeadAtom
        ('::' ruleName=Identifier (ctorParens?='(' (ctorArgs+=Expression (',' ctorArgs+=Expression)*)? ')')?)?
        (':' '-' body+=BodyElement (',' body+=BodyElement)*)? '.';

// Queries are syntactically (almost) the same as rule bodies — a
// conjunction of literals / equalities / range atoms / filters — so the
// same conjunctive shape that defines rules also expresses ad-hoc
// joins, filters, and computations at the top level. The projection
// is implicit: every distinct non-anonymous Variable that appears in
// the body becomes one output column, in first-mention source order.
//
// `!-` is the same conjunctive shape as an anonymous integrity constraint: the
// body must have no solution, and its implicit projection names the columns of
// any counterexample. `'!' '-'` is two existing tokens rather than a composite
// `!-` keyword, for the same reason `:-` is split below — `!` is also the
// logical-not operator, so a composite token could munch across an expression.
Query:
    ('?-' | isError?='!' '-') body+=BodyElement (',' body+=BodyElement)* '.';

// --- Head (allows aggregates) ------------------------------------------------

// A postfix `^` marks the predicate as *maximal*: the anti-monotone side of a
// parity-stratified recursion, which starts at ⊤ and is rebuilt each round.
// The sigil is written at every occurrence (head, body atoms, queries) but is
// not part of the predicate's name; the analyser keys the predicate under its
// bare name and checks that every occurrence agrees. See
// `doc/design/parity-stratification.md` and spec §4.3.
HeadAtom:
    predicate=Identifier (maximal?='^')? '(' (args+=HeadTerm (',' args+=HeadTerm)*)? ')';

// A head term is an Expression, optionally carrying a name (`e as N`) and a
// type annotation (`x: integer`), which may itself carry a `?` marking the
// column nullable (`x: integer?`), spelled the same way a ColumnDecl spells
// it. `as` binds tighter than `:`, since a thing is named before it is typed.
// When either is present the parsed expression is wrapped in an
// AnnotatedHeadTerm; post-processing substitutes each name away, lifts the
// type and the nullness onto the head's `argTypes`, and unwraps the
// expression, so downstream stages still see a plain head term. Aggregate
// calls (`count(X)`, `sum(X)`, ...) are syntactically FunctionCalls here;
// post-processing rewrites those into AggregateCall.
// A `_` position may instead carry a *refinement*: a proposition over the
// other head positions, whose witness is erased. `PrimitiveType` is a keyword
// set that `Identifier` does not re-admit, so `: integer` and `: Y > X` cannot
// be confused. See doc/design/refinement-annotations.md.
HeadTerm:
    Expression ({infer AnnotatedHeadTerm.expr=current}
        ('as' name=Identifier (':' (type=PrimitiveType | shape=StructuralType) (nullable?='?')?)?
        | ':' ((type=PrimitiveType | shape=StructuralType) (nullable?='?')? | refinement=Expression)))?;

// Not referenced directly by the grammar — synthesised by post-processing
// so downstream stages (analyzer, translator) can rely on the AggregateCall
// AST type.
AggregateCall:
    func=IDENT '(' arg=Expression ')';

// --- Body elements -----------------------------------------------------------
//
// Three shapes share a leading `Expression` and differ only in the
// trailing operator: Equality (`=`), RangeAtom (`in`), and Filter
// (catch-all — the expression itself is a boolean filter). The parser
// commits based on the token that follows the leading expression.
//
// Comparisons (`X > 0`) used to be a body-level construct of their own.
// They're now part of the expression hierarchy, so `X > 0` reaches the
// body as a Filter whose expression is a comparison BinaryExpr.

BodyElement:
    Literal | Equality | RangeAtom | Filter;

// A body literal: a positive or negated atom, optionally prefixed by a proof
// capture. `V : p(...)` binds the atom's proof term to `V`; `_ : p(...)`
// suppresses it (omits it from the enclosing constructor). Prefixing `not`
// produces a negated literal. The AST stays flat (proofVar / negated /
// predicate / args) for ergonomics; see the spec BNF for the formal structure.
//
// Two alternatives so the parentheses can be dropped ONLY after a proof
// capture: `V : p` is shorthand for `V : p(_, ..., _)` (one don't-care per
// declared column), expanded in post-processing. `parens` records whether the
// source had them, distinguishing the bare shorthand from an explicit `V : p()`
// (zero args). A bare atom with no capture still requires parens, so `p` on its
// own stays a Variable rather than a nullary atom.
// `maximal` is the postfix `^` sigil described on HeadAtom. It sits between the
// predicate name and the argument list, so `not bad^(E)` reads as the negation
// of a maximal atom. `^` is also the bitwise XOR operator; the only shape whose
// meaning this changes is a bare `A ^ (B)` as a complete body element, which
// was already a type error (a filter must be boolean, XOR yields an integer).
Literal:
    proofVar=Identifier ':' (negated?='not')? predicate=Identifier (maximal?='^')?
        (parens?='(' (args+=Expression (',' args+=Expression)*)? ')')?
  | (negated?='not')? predicate=Identifier (maximal?='^')? parens?='(' (args+=Expression (',' args+=Expression)*)? ')';

// Equality covers both binding (`X = expr`, left side is a bare variable
// or other unbound shape) and non-binding constraints (`X + 1 = Y`).
//
// The LHS is parsed at `Addition` level — *below* Cmp's `=`/`<>`
// operators — so a body element like `D = X * 2` reliably parses as
// body Equality (left=`D`, expr=`X * 2`) rather than as a Filter whose
// expression is the Cmp `D = (X * 2)`. Anything that wants the LHS
// to involve a comparison can wrap it in parentheses, but no realistic
// LHS shape today (variable, function call, arithmetic, subscript) is
// at the Cmp level anyway.
//
// The RHS is the full Expression so a logical-equality test can appear
// on the right (`B = (X = null)`).
Equality:
    left=Addition '=' expr=Expression;

RangeAtom:
    expr=Expression 'in' '[' low=Expression '..' high=Expression ']';

// A boolean Expression used as a filter on the rule's body. Catch-all
// for any body shape that isn't a Literal, Equality, or RangeAtom — the
// analyser checks the expression's type is `boolean`.
//
// A leading `not` negates a built-in atom (`not X = Y`, `not Age < 18`):
// any atom can be negated, not just predicate calls. The `negated` flag
// reaches the backends as it stands: `not e` is negation as failure over
// the expression and holds wherever `e` does not, an absence included,
// where the operator `!e` propagates the absence. Nothing rewrites one
// into the other. (Predicate calls still take the `not` on Literal —
// that alternative is tried first, so `not p(X)` stays a negated
// literal, never a negated filter.)
Filter:
    (negated?='not')? expr=Expression;

// --- Expressions (precedence climbing) ---------------------------------------
//
// Precedence (lowest binding to highest):
//   ||  (logical or)
//   &&  (logical and)
//   |   (bitwise or)
//   ^   (bitwise xor)
//   &   (bitwise and)
//   <  <=  >  >=  =  <>  !=   (comparison, non-associative)
//   << >> >>> (bit shifts)
//   +/- (additive)
//   * / % (multiplicative — `%` is modulo)
//   ! / - (unary)
//   ** (exponentiation, right-associative — binds tighter than * / %)
//
// `&&`/`||`/`!` are *logical*, not bitwise — operands and result must
// be boolean. There is no third truth value: a `null` is no truth value,
// so a connective handed one has *no value* except where the other
// operand dominates (`null && false` is `false`, `null || true` is
// `true`, while `null && true` and `!null` have none). The same holds of
// an operand that has no value, which is what makes `X <> 0 && 10 / X > 0`
// a usable guard. Identical on every backend (spec §5.4).
// Comparisons return boolean.
//
// `&`/`|`/`^`/`<<`/`>>`/`>>>` are *bitwise*, operating on 32-bit signed
// two's-complement integers (Java/JS `int` semantics): operands and
// result are `integer`, `>>` is arithmetic (sign-extending), `>>>` is
// logical (zero-fill), and the shift count is taken mod 32. They compute,
// so they reject a nullable operand statically. Each backend explicitly
// applies the 32-bit coercion so the result is identical despite wider
// integer storage (see spec §5.9).
//
// One equality: `=`/`<>`, null-aware (`null = null` is true,
// `null = X` is false). Body-level Equality (`X = expr`) reuses the same
// operator and additionally binds an unbound LHS. The orderings are
// *strict* at a null, which is outside the order, so they have no value
// there. See doc/design/null-as-a-value.md §4.1.
//
// `!=` is a spelling of `<>` for programmers who expect it. `parseRaw`
// rewrites it, so no stage past parsing sees the alias.

Expression:
    Conditional;

// Conditional, C-style: `c ? a : b`. Right-associative, so `c ? a : d ? b : e`
// chains without parentheses and reads as an else-if ladder. It needs no new
// precedence level (the parts are `Or`, the tightest thing above it) and no
// keywords, so nothing has to be reserved.
//
// The `:` does not collide with the other five things `:` does (head
// annotations, column declarations, proof captures, slices, object entries),
// checked rather than assumed: a `?` commits the parser to consuming the
// matching `:` before any of those is considered, so `W[c ? 1 : 2]` is a
// subscript whose index is a conditional and `W[c ? 1 : 2 : 3]` is a slice from
// one to `3`. The one shape that does not parse is `q(X: integer ? 1 : 2)`,
// where the annotation has already closed the term; write
// `q((c ? 1 : 2): integer)`.
Conditional infers Expression:
    Or ({infer Conditional.cond=current} '?' consequent=Or ':' alternate=Conditional)?;

Or infers Expression:
    And ({infer BinaryExpr.left=current} op='||' right=And)*;

And infers Expression:
    BitOr ({infer BinaryExpr.left=current} op='&&' right=BitOr)*;

BitOr infers Expression:
    BitXor ({infer BinaryExpr.left=current} op='|' right=BitXor)*;

BitXor infers Expression:
    BitAnd ({infer BinaryExpr.left=current} op='^' right=BitAnd)*;

BitAnd infers Expression:
    Cmp ({infer BinaryExpr.left=current} op='&' right=Cmp)*;

// Non-associative: `?` rather than `*` so `X > Y > Z` is a parse
// error rather than a misleading `(X > Y) > Z`.
// There is one equality, `=` / `<>`. Every comparison is total (a null
// operand never yields null), so a second, three-valued family would be
// indistinguishable from this one.
Cmp infers Expression:
    Shift ({infer BinaryExpr.left=current} op=('<' | '<=' | '>' | '>=' | '=' | '<>' | '!=') right=Shift)?;

Shift infers Expression:
    Addition ({infer BinaryExpr.left=current} op=('<<' | '>>' | '>>>') right=Addition)*;

Addition infers Expression:
    Multiplication ({infer BinaryExpr.left=current} op=('+' | '-') right=Multiplication)*;

Multiplication infers Expression:
    Exponent ({infer BinaryExpr.left=current} op=('*' | '/' | '%') right=Exponent)*;

// Exponentiation `**` binds tighter than the multiplicative operators and
// is right-associative (`2 ** 3 ** 2` is `2 ** (3 ** 2)`), matching JS. The
// left operand is a UnaryExpr, so `-2 ** 2` is `(-2) ** 2`. The result is
// always `float`, with the same domain guards the old `power` builtin had.
Exponent infers Expression:
    UnaryExpr ({infer BinaryExpr.left=current} op='**' right=Exponent)?;

UnaryExpr infers Expression:
    {infer UnaryExpr} op=('-' | '!') operand=UnaryExpr
    | Postfix;

// Both Subscript (`W[i]`) and Slice (`W[i:j]`) start with `[ Expression`,
// and Chevrotain can't decide between them with fixed lookahead once the
// first Expression is non-trivial (e.g. `W[0:-1]` — the parser has to
// scan past the entire first Expression before it sees the disambiguating
// token). We parse a unified `BracketAccess` form and let the
// post-processing pass split it into Subscript or Slice based on whether
// a `:` was present.
Postfix infers Expression:
    Primary
    (
        {infer BracketAccess.object=current} '['
        (start=Expression)?
        (sliceColon?=':' (end=Expression)?)?
        ']'
    )*;

// Not referenced from any parse rule — kept so Langium still generates
// the `Subscript` and `Slice` AST types that post-processing synthesises
// from `BracketAccess`.
Subscript:
    object=Expression '[' index=Expression ']';

Slice:
    object=Expression '[' start=Expression? ':' end=Expression? ']';

Primary infers Expression:
    '(' Expression ')'
    | FunctionCall
    | {infer Variable} name=Identifier
    | {infer StringLiteral} value=STRING
    | {infer NumberLiteral} value=NUMBER
    | {infer BooleanLiteral} (value?='true' | 'false')
    | {infer NullLiteral} 'null'
    | ArrayLiteral
    | ObjectLiteral
    // A bare `*` is the row-count wildcard. It parses as a Primary anywhere
    // (like the don't-care `_`), but the analyzer restricts it to the single
    // argument of `count(*)`.
    | {infer Wildcard} '*';

// A `qualifier::name(...)` form names a constructor by its predicate
// (`num_list::Cons(H, T)`); the bare `name(...)` form is a constructor term
// resolved by tag, or an ordinary function / aggregate call.
FunctionCall:
    (qualifier=Identifier '::')? name=IDENT '(' (args+=Expression (',' args+=Expression)*)? ')';

// A single identifier surface shared by predicates, variables, function
// names, column names. Case is a stylistic convention (uppercase =
// variable, lowercase = predicate, mirroring Prolog) but the grammar no
// longer enforces it — `Foo(X)` is a predicate, `foo` is a variable.
// FunctionCall vs Variable in Primary, and Literal vs Filter in body
// position, are disambiguated by whether `(` follows the identifier.
// `input`, `output`, `error`, `predicate`, `from`, and `as` are contextual
// keywords: they lead the declaration / binding forms above, but are otherwise
// ordinary identifiers, so a program can still name a predicate/column/variable
// after them (they are common words: `from`/`to` are the usual columns of an
// edge relation, `error` a plausible predicate name). The parser tells the forms
// apart by lookahead: `input`/`output`/`error` followed by `predicate`; an
// optional export identifier followed by `from`.
Identifier returns string:
    IDENT | QUOTED_IDENT | 'input' | 'output' | 'error' | 'predicate' | 'from' | 'as';

// JSON-style construction. Both literals produce a `value` (an array
// or object). Element expressions of any primitive type are auto-lifted
// (the translator wraps them via the dialect's primitive-to-value
// conversion); already-`value` elements pass through unchanged. Keys in
// object literals must be string literals, the same shape JSON object
// keys take.
ArrayLiteral:
    {infer ArrayLiteral} '[' (elements+=Expression (',' elements+=Expression)*)? ']';

ObjectLiteral:
    {infer ObjectLiteral} '{' (entries+=ObjectEntry (',' entries+=ObjectEntry)*)? '}';

ObjectEntry:
    key=STRING ':' value=Expression;

// --- Terminals ---------------------------------------------------------------

// A single identifier surface: any identifier can be a predicate, a
// function name, or a variable; the role is determined by syntactic
// context (an identifier followed by `(` is a predicate or function
// call; otherwise it's a variable). Backticks are a pure escape
// mechanism for names that contain characters the bare IDENT pattern
// wouldn't accept (or that collide with keywords).
terminal IDENT: /[a-zA-Z_][a-zA-Z0-9_]*/;
terminal QUOTED_IDENT: /`(\\.|[^`\\\n\r])+`/;
terminal STRING: /"(\\.|[^"\\])*"/;
// Binary integer literals (`0b1010`) match first so the `0b` prefix is not
// split into `0` and an identifier; post-processing converts them to their
// decimal value. Otherwise: decimal integers and floats.
terminal NUMBER returns number: /0[bB][01]+|[0-9]+(\.[0-9]+)?/;

hidden terminal WS: /[\t\r\n ]+/;
hidden terminal COMMENT: /#[^\n\r]*/;
