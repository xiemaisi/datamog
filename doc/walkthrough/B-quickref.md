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
| `?- q(X, Y).`                              | query                                            |
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
| `X = Y`, `X <> Y` | logical (null-aware) equality / inequality (filter or binding) |
| `X == Y`, `X != Y` | computational (3VL) equality / inequality (filter) |
| `X < Y`, `X <= Y`, `X > Y`, `X >= Y` | ordering comparisons (filter) |
| `X in [lo .. hi]`              | range atom (generates integers) |
| `object_entry(O, K, V)`        | iterate `K`/`V` over each entry of object value `O` |
| `array_element(A, I, V)`       | iterate `I`/`V` over each element of array value `A` |

## Expressions

| Category       | Operators / functions                                       |
| -------------- | ----------------------------------------------------------- |
| arithmetic     | `+`, `-`, `*`, `/`, `%`, `**` (exponentiation, float-valued) |
| bitwise        | `&`, `\|`, `^`, `<<`, `>>`, `>>>` (32-bit signed integers; `>>` arithmetic, `>>>` logical; see spec §5.9) |
| comparison     | `=`, `<>`, `==`, `!=`, `<`, `<=`, `>`, `>=`                 |
| boolean        | `&&`, `\|\|`, `!` (three-valued logic on `null`)              |
| string         | `+` (concat), `length(W)`, `upper(W)`, `lower(W)`, `trim(W)`, `replace(W, old, new)`, `W[i]`, `W[i:j]`, `W[:j]`, `W[i:]` |
| math           | `abs(x)`, `round(x)` / `round(x, n)`, `floor(x)`, `ceil(x)`, `sqrt(x)`, `ln(x)`, `exp(x)` (exponentiation is the `**` operator) |
| value          | `V["key"]`, `V[i]`, `V[i:j]` (subscript / slice), `as_string(V)`, `as_integer(V)`, `as_float(V)`, `as_boolean(V)`, `length(V)` (array length / object key count / string length), `type_of(V)`, `keys(V)` / `values(V)` (object projection, NULL on non-object), `to_json(V)` (canonical JSON text), array literal `[e1, ...]`, object literal `{"k": v, ...}` |
| conversion     | `to_string(x)`, `to_integer(s)`, `to_float(s)`, `to_boolean(s)`, `parse_json(s)` (parsing variants return `NULL` on malformed input). Primitive → `value` is automatic at the unify-with-`value` boundary; no explicit lift is needed. `to_json(value)` serialises canonical JSON text, and primitive arguments embed first. |
| aggregate (head-only) | `count`, `sum`, `avg`, `min`, `max`, `concat`, `list` (primitives auto-lift to a `value`; result is an array `value`) |

`count(*)` means `COUNT(*)` — count all rows.

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
