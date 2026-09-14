# Chapter 14 — Working with values

Up to now every column Datamog has handled has been a single
primitive type: a string, a whole number, a floating-point
number, a boolean. That's enough for the flat-tuple modelling
philosophy of Chapter 10 — and for almost every example we've
seen — but the data we *find* in the world is rarely already
flat. Web logs arrive as nested JSON. API responses pack
arrays of objects inside arrays of objects. Configuration
files are deeply nested. Pre-flattening that data in some other
language before feeding it to Datalog is real friction.

So Datamog adds a fifth type, `value` — a union that covers
`null`, booleans, integers, floats, strings, arrays, and
objects — plus a small toolkit for picking it apart from inside
a rule body. The name "JSON" is reserved here for the syntax
(JSONL files, parsing strings) and the on-the-wire / on-disk
representation. Static inference can retain more precise record and array shapes
without changing that storage.

The design is **primarily destructure**: most data enters a
program through the EDB as a `value` and gets read, projected,
and coerced down to primitives. Construction is also supported:
primitives auto-lift wherever a `value` is expected (so
`r(J) :- t(J), J = 5` "just works"), `parse_json` parses a
string into a value (or no value, on malformed input), and array
/ object literals (`[1, 2, X]`, `{"k": V}`) build composites
directly. The finiteness checker (Chapter 5's lens, formalised
in spec §5.8) flags the recursive-loop patterns that would
otherwise manufacture an unbounded family of compounds.

## Loading from JSON: two shapes

Two loaders cover the two common shapes.

**JSONL with a single-`value` column.** When the extensional
declaration has exactly one column typed `value`, every non-blank
line of `<predicate>.jsonl` is consumed as the column's contents
directly — any JSON shape goes. From
[`code/ch14/events.dl`](code/ch14/events.dl):

```prolog
input predicate event(payload: value).
```

with `event.jsonl`:

```jsonl
{"id": 1, "method": "GET", "path": "/v1/users", "status": 200, "headers": {"x-trace": "abc"}}
{"id": 2, "method": "POST", "path": "/v1/users", "status": 201, "headers": {"x-trace": "def", "content-type": "application/json"}}
```

— each line becomes one row whose `payload` column holds the
whole parsed object.

**A whole `.json` file as one row.** When you want to ingest a
single JSON document (a config blob, a manifest), drop a file
named `<predicate>.json` next to the `.dl` and declare a
single-`value` column extensional. The file is parsed and inserted
as exactly one row. From
[`code/ch14/config.dl`](code/ch14/config.dl):

```prolog
input predicate config(blob: value).
```

with `config.json`:

```json
{
  "name": "datamog-demo",
  "features": {"tracing": true, "auth": false, "cache": true},
  "endpoints": [{"path": "/health"}, {"path": "/users"}, {"path": "/admin"}]
}
```

In both cases the loader works the same way: parse JSON, hand
the parsed value straight to the engine, no schema flattening.

## Subscript and slice on `value`s

`value`s destructure with the same `[ ]` syntax as strings, but
with one extra superpower: object keys are first-class. From
`events.dl`:

```prolog
request(Id, Method, Path, Status) :-
    event(E),
    Id = as_integer(E["id"]),
    Method = as_string(E["method"]),
    Path = as_string(E["path"]),
    Status = as_integer(E["status"]).
```

`E` has type `value`. The expressions `E["id"]`, `E["method"]`,
... return `value`s of whatever shape sits at that key: always
`value`, regardless of whether the underlying contents are a
number, a string, an object, or null.

**A missing key and a `null`-valued key are different things**, and this is
the distinction to have straight before reading further:

```prolog
d(J) :- J = {"present": null}.
a(V) :- d(J), V = J["present"].   # one row, V is the null value
b(V) :- d(J), V = J["absent"].    # no rows at all
```

`J["present"]` **has a value**, namely `null`, so it binds and the row is
derived. `J["absent"]` has **no value**, so the conjunct does not hold and
there is no row to put anything in. `type_of` tells them apart too:
`type_of(J["present"])` is the string `"null"`.

Indexing rules, where "no value" means the row is not derived:

- `J[I]` with `I : integer` looks up an array element. Out-of-range → no
  value.
- `J["key"]` (string index) looks up an object entry. Missing key → no
  value; a key present with a JSON `null` → the `null` value.
- `J[I:J]` slices an array `value` (string-style slice doesn't
  apply here). Empty / reversed range → `[]`. Slicing a non-array
  → no value.

A wrong-shape access (object indexed with an integer, primitive
leaf indexed at all) has no value either. There is no error to
catch and no exception to recover from: bad accesses just drop
their row.

## Coercing leaves to primitive types

A subscript on opaque `value` data, such as the loaded events above, does not
prove the leaf's type. Use an explicit extraction to work with primitives:


| Function         | Returns   | has no value when                                       |
|------------------|-----------|---------------------------------------------------------|
| `as_string(V)`   | `string`  | `V` is not a string leaf                                |
| `as_integer(V)`  | `integer` | not an integer-valued numeric leaf, or out of int range |
| `as_float(V)`    | `float`   | `V` is not a numeric leaf                               |
| `as_boolean(V)`  | `boolean` | `V` is not a boolean leaf                               |
| `length(V)`      | `integer` | `V` is not an array, object, or string                  |
| `type_of(V)`     | `string`  | never: always one of `"object"`, `"array"`, `"string"`, `"number"`, `"boolean"`, `"null"` |

Each of these is a **projection**, and a projection that does not apply has
no result, so the row goes. That includes the `null` leaf: a `null` is not a
string, so `as_string` of one has no value, and it is not a thing with a
length either. `type_of` is the exception, and deliberately so: reporting
that a value is `null` is the question it exists to answer.

`as_integer` is strict about integer-ness: `as_integer(1.5)` has no value
rather than yielding `1`. If you want truncation, do it explicitly with
`as_float` and `floor`. (Datamog won't smuggle silent precision
loss past you.)

## Declaring and inferring shapes

A structural input contract validates the data as it is loaded and lets later
rules use its known fields directly:

```prolog
type Person = {name: string, age?: integer, scores: [float?]}.
input predicate people(person: Person).
next_age(P["age"] + 1) :- people(P).
```

Records are closed: extra fields are rejected. `age?: integer` allows the field
to be missing; `age: integer?` requires it but permits null. A missing age makes
`next_age` derive no row. A nullable age instead needs a bound-variable guard
(`A = P["age"], A <> null`) before arithmetic. `[float?]` allows null elements;
`[float]?` allows a null array. Nested `value` accepts any JSON value.

Inference also discovers shapes without declarations:

```prolog
person({"age": 41}).
next_age(P["age"] + 1) :- person(P).
```

The result is 42. Declaring that producer as `person({"age": 41}: value).`
hides the field type from callers, so they must use `as_integer(P["age"])`.
Annotations check and publish a promise; they do not cast or alter stored JSON.
Inference uses bounded summaries, so explicit extraction remains useful when
it cannot prove a scalar type. See [spec §5](../spec.md#5-type-system).

## Object projection and serialisation

Three more single-argument builtins cover the operations that
relational destructuring doesn't already give you for free:

| Function       | Returns  | Behaviour                                                  |
|----------------|----------|------------------------------------------------------------|
| `keys(V)`      | `value`  | sorted array of the object's keys; no value on non-object   |
| `values(V)`    | `value`  | array of the object's values, ordered by key; no value on non-object |
| `to_json(V)`   | `string` | canonical JSON text for canonical values — keys sorted, no whitespace |

`keys` and `values` give you a one-step "what's inside this
object?" projection without having to write the
`object_entry` + `list` round-trip. They have no value on
non-object inputs (arrays, primitives, the `null` leaf), so a rule that asks
for the keys of a non-object simply derives nothing for that row.

`to_json` returns a value's canonical JSON text, which makes it
useful as a hash key, a dedup key, or a stable identifier for
canonical values. One v1 backend variance remains: SQLite / sql.js
`parse_json` minifies objects without sorting their keys, so
`to_json(parse_json(...))` can preserve source key order on those
backends.

## Iterating

Subscript pulls one value out at a known position. Iteration
walks every entry. Two built-in body atoms cover the cases:

```prolog
object_entry(O, K, V)    # K : string,    V : value — one row per entry of object O
array_element(A, I, V)   # I : integer, V : value — one row per element of array A
```

Both are body atoms — they sit alongside `p(X, Y)` and `X = Y`
in a rule body, not inside expressions. Their first argument
must be safe (its variables already bound somewhere else in the
rule body — same rule as range atoms `X in [lo .. hi]`); the
remaining positions become bindings when they're bare variables.

From `events.dl`:

```prolog
output predicate event_string_header(Id, Key, Value) :-
    event(E),
    Id = as_integer(E["id"]),
    object_entry(E["headers"], Key, V),
    Value = as_string(V).
```

Each event contributes one row per header, with the key as
string and the value coerced from `value` to `string`. Events
whose `headers` are missing or non-object simply don't appear —
`object_entry` on a wrong-shape source yields zero rows.

`array_element` is the symmetric primitive for lists:

```prolog
output predicate endpoint(I, Path) :-
    config(C),
    array_element(C["endpoints"], I, E),
    Path = as_string(E["path"]).
```

> **Logic lens.** `object_entry` and `array_element` are not new
> predicates — they're parameterised, EDB-like *families* of
> facts conjured from a single `value`. Think of
> `object_entry(O, K, V)` as the (extensional) ternary relation
> `{(O, K, V) | (K, V) ∈ entries(O)}`. Each O picks out a finite
> set of (K, V) pairs; the iteration primitive lets a rule range
> over them.
>
> Because the source has to be safe (bound elsewhere), the
> reachable set of `(K, V)` pairs is finite — exactly the
> finiteness property that makes Datalog Datalog. The
> construction primitives — auto-lift, `parse_json`, and the
> array / object literals (next section) — sit just outside
> that closure: they *can* manufacture new values, but
> always from inputs the rules already had. The finiteness
> checker (spec §5.8) flags the dangerous shape — a recursion
> that loops a `value` back through any of them — so the
> property holds as a warning rather than as a hard syntactic
> prohibition.

## Equality on `value`s

You can compare two `value`s with `=` and `<>`:

```prolog
same_payload(A, B) :- event(A), event(B), A = B.
```

Equality is **structural**: `{"a":1, "b":2}` equals
`{"b":2, "a":1}` because they describe the same `value`, even
though the textual representations differ. Datamog canonicalises
`value`s on insert (object keys sorted recursively, numbers
normalised) so that this works uniformly across every backend.

Ordering operators (`<`, `<=`, `>`, `>=`) on `value` are
rejected at type-check. There is no portable order on
structured values — SQL backends disagree, and adding our own
order-rule on top would just be a lie.

## Constructing values

Three routes move primitives *into* the `value` type:

- **Auto-lift.** A primitive flowing into a `value` slot is
  lifted automatically — atom args matched against a
  `value`-typed column, equality variants between primitive
  and `value`, and IDB column unification across rules
  contributing different types. This means a primitive-to-
  value conversion function isn't part of the surface
  language: in any context where you'd want one, the lift
  fires by itself. See the spec for the few sites where it
  intentionally doesn't (function arguments expecting
  `value`, the source of `object_entry` /
  `array_element`, ordering comparisons).
- `parse_json(s)` parses a string as JSON syntax and returns
  the parsed value. Malformed input has no value rather than
  raising, matching the rest of the parsing family
  (`to_integer` / `to_float` / `to_boolean`). A bare `"null"` parses
  successfully, to the `null` value.
- **Array and object literals** — `[e1, e2, ...]` produces an
  array; `{"k1": v1, "k2": v2, ...}` produces an object.
  Element / value expressions are auto-lifted, so primitives,
  already-`value` expressions, and `null` mix freely. Object
  keys are written as string literals (mirroring JSON syntax).

```prolog
input predicate sample(name: string, raw: string).

# Primitive auto-lift: comparing the primitive `length(N)` against
# a `value`-typed column is fine — the lift fires implicitly.
counted(N, V) :- sample(N, _), V = [length(N)][0].

# A string parsed into a structured value. A payload that isn't
# valid JSON syntax has no value, so its row is not derived.
parsed(N, V) :- sample(N, R), V = parse_json(R).

# Object and array literals — assemble structured values
# directly, without round-tripping through string form.
record(N, V) :- sample(N, _), V = {"name": N, "tags": ["sample", N]}.
```

> **Termination lens.** Auto-lift and array / object literals
> over already-bound variables are harmless: they don't produce
> values outside the active domain. `parse_json` can —
> `parse_json(as_string(J)) = J` only when the string
> round-trips, but `parse_json("[" + S + "]")` wraps each value
> in an extra layer, and a recursive rule that applies that
> pattern grows without bound. The finiteness checker treats
> every value constructor (literals and lifts included) like
> string concat and arithmetic for that reason: a cycle through
> any of them warns. The warning isn't a refusal to compile —
> sometimes the looping *terminates* for reasons the checker
> can't see — but it does mean "I cannot prove this terminates;
> you're on the hook."

> **Backend lens.** `parse_json` is one place the backends
> visibly differ. Postgres `jsonb` and the native evaluator both
> *canonicalise* parsed objects (sort keys, normalise numbers),
> so `parse_json('{"a":1,"b":2}')` and `parse_json('{"b":2,
> "a":1}')` join structurally. SQLite / sql.js use textual JSON
> and only minify — they don't sort keys — so on those backends
> the two parse results are textually distinct and won't unify in
> a join. If your join key is a freshly-parsed object, prefer
> Postgres or the native backend; otherwise round-trip through
> `as_*` so the join key is a primitive.

## Putting it together

The full `events.dl` from
[`code/ch14/events.dl`](code/ch14/events.dl) reads logs out of
`event.jsonl`, projects a flat `request(Id, Method, Path,
Status)` view, filters to `/v1/`-prefixed `2xx` responses, and
fans out per-event headers — all without leaving Datalog:

```prolog
input predicate event(payload: value).

request(Id, Method, Path, Status) :-
    event(E),
    Id = as_integer(E["id"]),
    Method = as_string(E["method"]),
    Path = as_string(E["path"]),
    Status = as_integer(E["status"]).

output predicate ok_v1_request(Id, Path) :-
    request(Id, _, Path, Status),
    Status >= 200,
    Status < 300,
    Path[0:4] = "/v1/".

output predicate event_string_header(Id, Key, Value) :-
    event(E),
    Id = as_integer(E["id"]),
    object_entry(E["headers"], Key, V),
    Value = as_string(V).

?- request(Id, M, P, S).
```

Run it:

```bash
bun run datamog doc/walkthrough/code/ch14/events.dl
```

> **SQL lens.** Run `--dry-run` to see what each backend emits.
> Postgres uses `JSONB` columns and the `->` operator for
> subscript; iteration becomes `LATERAL jsonb_each(...)`; `as_integer`
> compiles to a `CASE WHEN jsonb_typeof = 'number' AND ...
> THEN ... ELSE NULL END`. SQLite/sql.js use `TEXT` columns with
> `json_extract` and `json_each`, plus a canonicalising pass at
> insert time so textual equality lines up with structural
> equality. Same Datalog source, very different SQL, identical
> answers.

> **Imperative lens.** The Python-shaped equivalent of the
> request projection is roughly:
>
> ```python
> rows = [json.loads(line) for line in open("event.jsonl")]
> requests = [
>     (r["id"], r["method"], r["path"], r["status"])
>     for r in rows
>     if isinstance(r.get("id"), int)
>     and isinstance(r.get("method"), str)
>     # ...etc
> ]
> ```
>
> The `as_integer` / `as_string` checks in Datalog play exactly the role
> the `isinstance` guards play here — without them, a `value`
> of the wrong shape would silently get the wrong type. The
> difference is that the Datalog version composes: once `request`
> is defined, `ok_v1_request` and `event_string_header` consume
> it directly, and they too get the safety/typing guarantees for
> free.

## Recap

- JSON storage carries booleans, integers, floats, strings, arrays, objects,
  and null. A top-level null needs `value?` in a column contract; null inside
  an object or array does not. Datamog reads them with subscript / iteration /
  coercion, and constructs new ones via auto-lift (anywhere a
  `value` slot meets a primitive), `parse_json(s)` (parse a
  string, no value on malformed input), and array / object
  literals (`[e1, e2, ...]` and `{"k1": v1, "k2": v2, ...}`).
- Two loaders feed value columns: JSONL with a single-`value`
  column declaration, and a standalone `<predicate>.json` file.
- Read fields with `J["key"]` / `J[i]`; iterate with
  `object_entry` / `array_element`; coerce leaves with `as_string`,
  `as_integer`, `as_float`, `as_boolean`; introspect with `length` and
  `type_of`. Wrong-shape access and a missing key have no value, never an
  error, so the row is withheld; a key present with a JSON `null` yields the
  `null` value and keeps its row.
- Equality is structural and works across backends thanks to
  canonicalisation on insert. Ordering on `json` is rejected.

JSON support is the escape hatch for "the data arrived as a
nested blob and I don't want to flatten it before I look at
it" — once you've pulled out the fields that matter, the rest of
the language treats them as ordinary primitives.

## Exercises

### Exercise 14.1 — Status-code histogram ★

Starter: [`code/ch14/events.dl`](code/ch14/events.dl)

Define `status_count(S, count(Id))` — the number of events with
each HTTP status code, grouped by status. You'll need the
`request` predicate from the chapter; the aggregate is from
Chapter 9. Hint: the only new piece is `as_integer(E["status"])`.

### Exercise 14.2 — Largest JSON shape ★★

Define `complex_event(Id)` — events whose payload object has
five or more top-level keys. Compose `length` (over the
top-level object) with `as_integer` and a comparison.

### Exercise 14.3 — Pull a value out of an array ★★

Define `first_endpoint_path(P)` — the path of the first endpoint
in `config.json`. Use `array_element` and filter by `I = 0`,
or the equivalent literal-key form `C["endpoints"][0]["path"]`
with subscript chaining. Try both; compare the SQL each emits.

### Exercise 14.4 — Mixed-shape headers ★★★

Some events have `"x-internal": "true"` (a JSON string that
*looks* like a boolean); some others might have
`"x-internal": true` (an actual JSON boolean). Define
`internal_event(Id)` that matches both shapes — using `as_boolean`
*or* `as_string` and a string comparison. Then think about which
form you'd prefer in production code, and why.

---

Next: **[Chapter 15 — Proof terms](15-proof-terms.md)**.
