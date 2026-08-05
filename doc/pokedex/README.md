# A Datalog Pokédex — working with nested JSON

This short tutorial builds a Datalog view over a real, nested JSON
document: the community [pokemon-data.json](https://github.com/Purukitto/pokemon-data.json)
Pokédex. It is a companion to [walkthrough Chapter 14](../walkthrough/14-json.md),
which introduces Datamog's `value` type and its JSON toolkit; here we
point that toolkit at a single, nested, real-world blob and carve flat
relations out of it.

The motivation is the lovely
[Prolog Pokémon](https://unplannedobsolescence.com/blog/prolog-basics-pokemon/)
post, which models Pokémon battle data as Prolog facts[^prolog] and then
has a lot of fun querying it (which of my team can hit yours
super-effectively, who has a priority move, and so on). We're **not** out to replicate that
whole tutorial — the battle analysis is the fun part, and it's left as
the next step. What we reproduce here is just its **data layer**: the
base facts it takes as given, reconstructed in Datamog by extracting them
straight out of JSON.

We start with two predicates:

- `pokemon(Id, Name, HP)` — one row per Pokémon, with its numeric id,
  English name, and base HP.
- `type(Id, Type)` — one row per (Pokémon, type) pair, since a Pokémon
  can have more than one type.

…then build out the rest of that data layer — `pokemon_spa`,
`pokemon_ability`, `super_effective`, `move_category`, `move_priority`,
and `learns`.

Everything runs against data fetched live over HTTPS — no local copy to
download or keep in sync.

## The shape of the data

The source is a single top-level JSON **array**. Each element looks like
this (trimmed):

```json
[
  {
    "id": 1,
    "name": { "english": "Bulbasaur", "japanese": "フシギダネ", "chinese": "妙蛙种子", "french": "Bulbizarre" },
    "type": ["Grass", "Poison"],
    "base": { "HP": 45, "Attack": 49, "Defense": 49, "Sp. Attack": 65, "Sp. Defense": 65, "Speed": 45 }
  }
]
```

Three features of this shape drive the whole design:

- The document is **one array**, not a stream of records. Datamog's JSON
  loader ingests a whole `.json` document as a **single** `value` row —
  so the entire array lands in one column, and we iterate it ourselves.
- `name` is a **nested object** keyed by language; the English name lives
  at `name.english`.
- `type` is an **array** — a Pokémon has one or two types — and `base` is
  a nested object whose `HP` key (capitalised) holds the stat we want.

## Loading: the whole array as one `value`

Declare a single-`value`-column extensional predicate and bind it to the
URL with the like-named `--pokedex` input flag (after the program):

```prolog
input predicate pokedex(data: value).
```

```bash
bun run datamog \
  doc/pokedex/pokedex.dl \
  --pokedex gh:Purukitto/pokemon-data.json/pokedex.json
```

`gh:OWNER/REPO/PATH` is Datamog's GitHub shorthand: it expands to
`https://raw.githubusercontent.com/OWNER/REPO/HEAD/PATH`, so you don't
have to spell out the `raw.githubusercontent.com/.../refs/heads/master/`
URL by hand. The ref defaults to the repo's default branch (`HEAD`); pin
a branch, tag, or commit with a trailing `#ref` (e.g.
`gh:owner/repo/data.json#v1.2.0`). `github:` works as a longer alias.

The loader fetches the URL, parses it as one JSON value, and inserts
exactly **one row** into `pokedex` whose `data` column holds the entire
array. Nothing is flattened on the way in — the flattening is the job of
the rules below.

> **Loader lens.** The `.json` whole-file loader (local file or URL) is
> the "one document, one row" shape. Its sibling — the JSONL loader —
> handles the "one record per line" shape instead. The Pokédex is a
> single array literal, so it is squarely a whole-file `.json` source.
> See [Chapter 14 §"Loading from JSON"](../walkthrough/14-json.md) for the
> two shapes side by side.

## `pokemon(Id, Name, HP)`

To turn the one-row array into one fact per Pokémon, iterate it with
`array_element`, then destructure each element `P`:

```prolog
pokemon(Id, Name, HP) :-
    pokedex(D),
    array_element(D, _, P),
    Id   = as_integer(P["id"]),
    Name = as_string(P["name"]["english"]),
    HP   = as_integer(P["base"]["HP"]).
```

What each line does:

- `pokedex(D)` binds `D` to the single `value` — the whole array.
- `array_element(D, _, P)` walks the array, binding `P` to each element
  in turn (we don't care about the index, so it's `_`). This is what
  fans the one row out into ~900 facts.
- `P["id"]`, `P["name"]`, `P["base"]` are object-key subscripts. Each
  returns a `value`, so `P["name"]["english"]` **chains** a second
  subscript through the nested `name` object.
- `as_integer` / `as_string` coerce the `value` leaves down to the
  primitive column types. A wrong-shape access anywhere (missing key,
  wrong type) yields `null` rather than erroring — the row still comes
  out, just with `null` in that column. The real Pokédex is uniform, so
  in practice every column is filled; to drop malformed rows instead, add
  a guard (e.g. a comparison) that fails on `null`.

## `type(Id, Type)`

`type` is itself an array, so it needs a *second* `array_element` — one
nested inside the per-Pokémon iteration:

```prolog
type(Id, Type) :-
    pokedex(D),
    array_element(D, _, P),
    Id   = as_integer(P["id"]),
    array_element(P["type"], _, T),
    Type = as_string(T).
```

`array_element(P["type"], _, T)` iterates the inner type array, so a
dual-type Pokémon like Bulbasaur contributes two rows: `(1, "Grass")`
and `(1, "Poison")`. This is the idiomatic way to normalise a
one-to-many array field into a flat relation.

## More sources, more predicates

The [Prolog Pokémon](https://unplannedobsolescence.com/blog/prolog-basics-pokemon/)
example also needs special-attack stats, abilities, a type chart, and
move data. Two more fields come straight out of `pokedex.json`; the rest
need data this Pokédex doesn't carry, so we add three more live sources:

| Predicate | Source | Document shape |
|-----------|--------|----------------|
| `pokemon_spa`, `pokemon_ability` | `pokedex.json` (already loaded) | array of species |
| `super_effective` | `types.json` (same repo) | array of 18 type entries |
| `move_category`, `move_priority` | Pokémon Showdown `moves.json` | object keyed by move id |
| `learns` | Pokémon Showdown `learnsets.json` | object keyed by Pokémon id |
| `showdown_key` (bridge) | Pokémon Showdown `pokedex.json` | object keyed by Pokémon id |

`pokedex.json` has no move data, so `learns` and `move_priority` come
from [Pokémon Showdown's](https://play.pokemonshowdown.com/data/) battle
data instead — all plain JSON keyed by id.

### Still from `pokedex.json`

`pokemon_spa` is the same recipe as `pokemon` — note the literal object
key `"Sp. Attack"`, spaces and all:

```prolog
pokemon_spa(Id, SpA) :-
    pokedex(D),
    array_element(D, _, P),
    Id  = as_integer(P["id"]),
    SpA = as_integer(P["base"]["Sp. Attack"]).
```

`pokemon_ability` reaches `profile.ability`, an array of
`[name, hidden-flag]` pairs like `[["Overgrow", "false"], ["Chlorophyll",
"true"]]`. Iterate the outer array and take element `0` of each pair (the
hidden-flag at index `1` is left for you — a natural `pokemon_ability/3`
extension):

```prolog
pokemon_ability(Id, Ability) :-
    pokedex(D),
    array_element(D, _, P),
    Id      = as_integer(P["id"]),
    array_element(P["profile"]["ability"], _, A),
    Ability = as_string(A[0]).
```

### The type chart, from `types.json`

`types.json` is an array of the 18 types; each entry lists the types it
hits super-effectively in an `effective` array. So `super_effective` is a
doubly-nested iteration — over types, then over each type's `effective`
list:

```prolog
super_effective(Attacker, Defender) :-
    types(D),
    array_element(D, _, T),
    Attacker = as_string(T["english"]),
    array_element(T["effective"], _, E),
    Defender = as_string(E).
```

Both arguments are type *names* (`"Fighting"`, `"Normal"`), so this joins
straight onto `type(Id, Type)`.

### Moves and learnsets, from Pokémon Showdown

Showdown's `moves.json` is an *object* keyed by move id, so we iterate it
with `object_entry` (the object analogue of `array_element`) rather than
`array_element`:

```prolog
move_category(Move, Category) :-
    moves(D),
    object_entry(D, Move, M),
    Category = as_string(M["category"]).

move_priority(Move, Priority) :-
    moves(D),
    object_entry(D, Move, M),
    Priority = as_integer(M["priority"]).
```

`learnsets.json` is keyed by Pokémon id, and each entry's `learnset` is
itself an object mapping move id → source codes. We only want the keys,
so the inner value is a don't-care.

But the keys don't line up yet. The learnsets key Pokémon by Showdown
*id* (`"bulbasaur"`), whereas `pokemon`, `type`, and friends key on the
national-dex `Id` (`1`). (Move ids like `"absorb"` are shared between
`moves.json` and the learnsets, so `move_category`/`move_priority` join
to `learns` on the move with no trouble — it's only the *Pokémon* key
that mismatches.) If we left `learns` keyed by the string id, it wouldn't
join to `pokemon` at all. We want **one** Pokémon key throughout.

The robust bridge is Showdown's *own* `pokedex.json`: every entry carries
its national-dex number in a `num` field. So a one-rule translation maps
the string id to our `Id` — a plain JSON-to-JSON join, no fragile
name-munging (which would trip over `Mr. Mime`, `Farfetch'd`, `Type:
Null`, `Nidoran♀`, …):

```prolog
showdown_key(Id, Key) :-
    showdex(D),
    object_entry(D, Key, E),
    Id = as_integer(E["num"]).
```

Now `learns` reads the learnsets with two nested `object_entry`s and
runs the key through `showdown_key`, so it comes out keyed on the
national-dex `Id` like everything else:

```prolog
learns(Id, Move) :-
    learnsets(L),
    object_entry(L, Key, E),
    showdown_key(Id, Key),
    object_entry(E["learnset"], Move, _).
```

With that, `learns(1, Move)` joins straight onto `pokemon(1, Name, HP)`
and `pokemon_spa(1, SpA)` — one key everywhere.

> **Forms fold in.** Alternate forms (mega, regional, Gigantamax) are
> separate Showdown ids but share their base species' `num`, so a form's
> learnset folds into the base species' `Id`. For a movepool view that's
> usually what you want; if you ever need them split, key on the Showdown
> id instead.

## Running it

Because the program now reads five documents, pass an input flag for
each. The demo lookups at the bottom of
[`pokedex.dl`](pokedex.dl) are deterministic (Bulbasaur is
always #1). The file has one `?-` default output and six named outputs,
so `--all` evaluates every one (without it, only the default
`pokemon(1, Name, HP)` prints):

```prolog
?- pokemon(1, Name, HP).
output predicate bulbasaur_type(Type) :- type(1, Type).
output predicate bulbasaur_spa(SpA) :- pokemon_spa(1, SpA).
output predicate fighting_hits(Defender) :- super_effective("Fighting", Defender).
output predicate absorb_category(Category) :- move_category("absorb", Category).
output predicate quickattack_priority(Priority) :- move_priority("quickattack", Priority).
output predicate bulbasaur_key(ShowdownId) :- showdown_key(1, ShowdownId).
```

```bash
bun run datamog --all \
  doc/pokedex/pokedex.dl \
  --pokedex gh:Purukitto/pokemon-data.json/pokedex.json \
  --types gh:Purukitto/pokemon-data.json/types.json \
  --moves https://play.pokemonshowdown.com/data/moves.json \
  --learnsets https://play.pokemonshowdown.com/data/learnsets.json \
  --showdex https://play.pokemonshowdown.com/data/pokedex.json
```

Bulbasaur comes back as Grass/Poison with Sp. Attack 65, Fighting is
super-effective against `Normal, Ice, Rock, Dark, Steel`, `absorb` is a
`Special` move, `quickattack` has priority `1`, and Pokémon #1's Showdown
id is `bulbasaur`. Drop the anchors for the full tables — `?- pokemon(Id,
Name, HP).` alone is ~900 rows, and `?- learns(1, Move).` lists all of
Bulbasaur's moves (around 90, now keyed on the dex `Id`). The exact move
counts track Showdown's live data, so they drift as the game updates.

> **Backend note.** This runs on any backend — the default in-memory
> SQLite (`bun:sqlite`), `--backend native`, `--backend sqljs`, and
> Postgres all produce identical answers. If `DATABASE_URL` is set in
> your environment the CLI defaults to Postgres, which (unlike the
> in-memory backends) **persists tables across runs** — pass
> `--backend sqlite` or `--backend native` for a clean, repeatable run.

## Where this goes next

That's the whole data layer — every predicate here is a base fact carved
out of JSON with the same three moves: iterate with `array_element` /
`object_entry`, subscript into nested objects, coerce leaves. The
*analysis* is where it gets interesting, and it's all ordinary rules over
these predicates (no more JSON):

- `damaging_move(Move)` — `move_category(Move, "Physical")` or
  `move_category(Move, "Special")`.
- `special_sweeper(P, Move)` — a Pokémon with `pokemon_spa(P, SpA)`,
  `SpA > 120`, that `learns` a `Special` move.
- `priority_move(P, Move, Prio)` — `learns` joined to `move_priority`,
  filtered to `Prio > 0`.
- `super_effective_move(Move, Defender)` — a move's `type` joined through
  `super_effective` onto a defending type.

Each of those is a short rule away — and that's the part the
[Prolog Pokémon](https://unplannedobsolescence.com/blog/prolog-basics-pokemon/)
post works through.

[^prolog]: The post is framed in terms of Prolog, but it never actually
    uses Prolog's distinctive expressive power. There are no compound
    terms built by unification, no recursion, no backtracking search, no
    cut — the data is a fixed set of ground facts, and every query is a
    conjunctive query (a join) with a handful of comparisons (`SpA #> 120`
    and the like). That is precisely the fragment **Datalog** was designed
    for, which is why it all ports to Datamog without losing anything. If
    the example reached for genuine Prolog features — generating
    structured terms, searching an unbounded space, ordering-sensitive
    control flow — the translation would be a different story; this one
    simply doesn't need them.
