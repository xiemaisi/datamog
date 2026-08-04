# Appendix B — Datamog quick reference

This is a condensed reference. For the authoritative language
definition, see [`doc/spec.md`](../spec.md).

## Top-level constructs

| Syntax                                     | Meaning                                          |
| ------------------------------------------ | ------------------------------------------------ |
| `input predicate p(col1: type, col2: type).`   | declare an EDB predicate with typed columns      |
| `input predicate p(col: type?).`               | declare a nullable EDB column                    |
| ``input predicate `p-name`(`col-name`: type).`` | quote predicate or column identifiers            |
| `p("value", 42).`                          | assert a ground fact                             |
| `h(X, Y) :- body.`                         | rule defining an IDB predicate                   |
| `h(X: integer) :- body.`                   | head argument with a checked type annotation     |
| `h(X, Y) :: Ctor :- body.`                 | proof-carrying rule: `h` becomes an ADT          |
| `output predicate h(X) :- body.`           | rule whose predicate is also a named result      |
| `error predicate bad(X) :- body.`          | named integrity constraint: `bad` must be empty  |
| `input predicate p(...) := "f.csv".`       | bind an input to a data file                     |
| `input predicate p(...) := h from "m.dl"(q = r).` | bind an input to an instance of another module |
| `?- q(X, Y).`                              | query                                            |
| `!- q(X), not r(X).`                       | anonymous integrity constraint: must have no solution |
| `# comment`                                | line comment                                     |

## Identifiers

- Unquoted predicate, function, and column names start with lowercase:
  `parent`, `all_prereqs`, `length`.
- Variables start with uppercase or `_`: `X`, `Score`, `_`, `_0`.
- Predicate and column names can be backtick-quoted when they contain
  punctuation or reserved words: `` `http-event`(`content-type`: string) ``.
  Function names are not quoted.

## Types

| Type      | Examples                      | Notes                                       |
| --------- | ----------------------------- | ------------------------------------------- |
| `string`    | `"hello"`                     | double-quoted strings                       |
| `integer` | `42`, `-3`                    | whole numbers                               |
| `float`    | `3.14`                        | floating point                              |
| `boolean` | `true`, `false`               | equality-only — no `<` / `>` ordering       |
| `value`   | (loaded via JSONL / `.json`)  | union of `null` / boolean / integer / float / string / array / object. Equality-only — no ordering. Destructure via `V["k"]`, `V[i]`, `V[i:j]`, the iteration primitives, and the `as_*` / `length` / `type_of` builtins. |

Widening: `integer → float` (automatic), and primitive → `value`
(automatic at any unify-with-`value` site — atom args, equalities,
function args, iteration sources, IDB column unification).

## Body atoms

| Syntax                         | Kind                          |
| ------------------------------ | ----------------------------- |
| `p(X, Y)`                      | predicate atom (EDB or IDB)   |
| `not p(X, Y)`                  | negated atom (stratified)     |
| `X = expr`, `expr = X`         | equality (binds a bare variable or filters) |
| `X = Y`, `X <> Y` | equality / inequality, null-aware (filter or binding) |
| `X < Y`, `X <= Y`, `X > Y`, `X >= Y` | ordering comparisons (filter); total, with `null` an isolated point |
| `X in [lo .. hi]`              | range atom (generates integers) |
| `object_entry(O, K, V)`        | iterate `K`/`V` over each entry of object value `O` |
| `array_element(A, I, V)`       | iterate `I`/`V` over each element of array value `A` |

## Expressions

| Category       | Operators / functions                                       |
| -------------- | ----------------------------------------------------------- |
| arithmetic     | `+`, `-`, `*`, `/`, `%`, `**` (exponentiation, float-valued) |
| bitwise        | `&`, `\|`, `^`, `<<`, `>>`, `>>>` (32-bit signed integers; `>>` arithmetic, `>>>` logical; see spec §5.9) |
| comparison     | `=`, `<>`, `<`, `<=`, `>`, `>=` (all total: never yield `null`) |
| boolean        | `&&`, `\|\|`, `!` (three-valued logic on `null`)              |
| string         | `+` (concat), `length(W)`, `upper(W)`, `lower(W)`, `trim(W)`, `replace(W, old, new)`, `W[i]`, `W[i:j]`, `W[:j]`, `W[i:]` |
| math           | `abs(x)`, `round(x)` / `round(x, n)`, `floor(x)`, `ceil(x)`, `sqrt(x)`, `ln(x)`, `exp(x)` (exponentiation is the `**` operator) |
| value          | `V["key"]`, `V[i]`, `V[i:j]` (subscript / slice), `as_string(V)`, `as_integer(V)`, `as_float(V)`, `as_boolean(V)`, `length(V)` (array length / object key count / string length), `type_of(V)`, `keys(V)` / `values(V)` (object projection, NULL on non-object), `to_json(V)` (canonical JSON text), array literal `[e1, ...]`, object literal `{"k": v, ...}` |
| conversion     | `to_string(x)`, `to_integer(s)`, `to_float(s)`, `to_boolean(s)`, `parse_json(s)` (parsing variants return `NULL` on malformed input). Primitive → `value` is automatic at the unify-with-`value` boundary; no explicit lift is needed. `to_json(value)` serialises canonical JSON text, and primitive arguments embed first. |
| aggregate (head-only) | `count`, `sum`, `avg`, `min`, `max`, `concat`, `list` (primitives auto-lift to a `value`; result is an array `value`) |

`count(*)` means `COUNT(*)` — count all rows.

## Head type annotations

- Optional, and **checked rather than used**: inference runs unchanged and each
  annotation is verified against it.
- Per rule and per argument — a rule may annotate any subset of its head
  arguments, and sibling rules may annotate differently or not at all.
- A declared type must equal or widen what the rule proves (`integer` may be
  declared `float` or `value`; a narrower claim is rejected). Annotations are the
  predicate's **published** contract: consumers are checked against them, while
  the predicate's own body still sees its inferred types.
- No runtime effect; codegen ignores them.

## Proof terms (ADTs)

| Syntax                        | Meaning                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `h(X, Y) :: Ctor :- body.`    | constructor args derived (witnesses, then sub-proofs)     |
| `h(X, Y) :: Ctor(A, B) :- body.` | constructor args listed explicitly                     |
| `V : p(X, Y)`                 | capture `p`'s proof term into `V`                         |
| `V : p`                       | shorthand for `V : p(_, ..., _)`, one per declared column |
| `_ : p(X, Y)`                 | match without capturing (omits the sub-proof)             |
| `V = Ctor(A, B)`              | match a constructor, bare when one predicate declares it  |
| `V = p::Ctor(A, B)`           | qualified match, required when several predicates share the tag |

- A proof-carrying predicate gains an **implicit trailing `value` column** holding
  the derivation; it is the last column, a query hides it, and output renders the
  term bare (`Ctor(...)`).
- Constructors are scoped to their predicate, so a tag may recur across
  predicates. Naming is all-or-nothing: name every rule of a predicate, or none.
- A constructor term is always a **match**, never a value builder.

## Modules

A file is a function: its `input predicate`s are parameters, its
`output predicate`s and single `?-` default are results. Bind an input with `:=`;
`from` present means a module, a bare string means a data file.

| Syntax                                          | Meaning                                |
| ----------------------------------------------- | -------------------------------------- |
| `:= "data/x.tsv" as csv.`                       | data file, loader forced (`csv`, `jsonl`, `json`, `mermaid`) |
| `:= reach from "m.dl"(edge = road).`            | instance of `m.dl`, taking output `reach`, wiring `edge` to `road` |
| `:= from "m.dl"(edge = road).`                  | same, taking the module's `?-` default output |

- Every input of an imported module must be **supplied** — wired by an actual or
  `:=`-bound inside the module. A module never auto-loads.
- A `:=` on an input is an **overridable default**: a wired actual wins, and the
  default is not instantiated. An actual naming a non-input is an error.
- **One output per import site.** Take several outputs with several bindings.
- Identical (module, wiring) pairs **share** one instance; differing wiring gives
  separate copies. Instantiation is applicative: equal arguments, one instance.
- Declared columns are the instance's public face and are checked against the
  output's published types (equal or wider, never narrower). For a proof-carrying
  output the declaration also counts the implicit proof column.
- A module's `!-` and `error predicate` constraints travel with it, checked per
  instance against the data wired in — an interface can enforce its own laws.
- The **instantiation graph must be acyclic**: mutually recursive predicates share
  a file. Recursion inside a module is fine.
- Multi-file programs need the CLI; the browser playground runs single files.

## Cross-backend runtime guarantees

- Division / modulo by zero → `NULL`
- `sqrt(negative)`, `ln(≤ 0)`, `0 ** negative`, `negative ** fractional` → `NULL`
- `W[i:j]` with `i >= j` → `""` (string) or `[]` (array value)
- Wrong-shape access on a `value` (`obj[i]` where i is integer
  but `obj` is an object, missing key, out-of-range index,
  `as_integer(string-leaf)`) → `NULL`
- `value`s are canonicalised on insert (sorted keys, normalised
  numbers) so structural equality coincides with textual equality
  on every backend; the `null` leaf collapses to SQL NULL
- EDB queries are `DISTINCT` (set semantics)

## Restrictions

- Rules must be **safe**: every head variable bound by a positive
  body atom (or a range, or an equality to an already-safe side).
- Recursion must be **linear** on SQL backends: each recursive body
  atom appears at most once. The non-SQL `native` and `seminaive`
  evaluators accept non-linear recursion (their delta-aware iteration
  computes the correct fixed point).
- Negation must be **stratified**: no cycle through a negative
  edge in the predicate dependency graph.
- Aggregate predicates cannot be recursive.
- At most one **default output** per file: a `?-` query, or a rule named
  `output predicate default`. Further results must be named outputs.
- Predicates must have consistent arity across all rules.
- Column types always unify across rules: `integer`/`float` widen to
  `float`, and other primitive mismatches widen to `value`.

## CLI flags

| Flag                   | Effect                                         |
| ---------------------- | ---------------------------------------------- |
| `--dry-run`            | print generated SQL instead of executing       |
| `--backend <name>`     | pick a backend (`sqlite`, `sqljs`, `postgres`, `native`, `seminaive`) |
| `--data-dir <path>`    | base directory loaders read from (defaults to the program's directory) |
| `--all`                | evaluate every output (default `?-` plus every named output) instead of a single one |
| `--<input> src`        | supply input predicate `<input>` from a CSV/JSONL/JSON/MMD file or HTTP(S) URL, Google Sheets, or a GitHub `gh:owner/repo/path` shorthand (placed after the program; `--input n=src` for names no flag can express) |
| `--output-format F`    | output format (`table`, `csv`, `jsonl`, ...)   |
| `--csv-no-header`      | treat CSV files as headerless                  |
| `--warn-finiteness`    | warn about predicate columns that may grow unboundedly |

Default backend: `sqlite` (unless `DATABASE_URL` is set, then `postgres`).
