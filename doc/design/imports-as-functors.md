# Design notes: modules as functors (inputs and outputs)

Status: **module core implemented; REPL/playground import integration and other
extensions deferred.** The grammar (the `:=` source binding on
input predicates), the per-instance expansion (`expandModule`), the elaborator
(`elaborate`: the entry's bindings and, recursively, nested module imports, with
the instantiation-graph acyclicity check; named exports and the unnamed `?-`
default output), the Bun file resolver, CLI wiring (`datamog main.dl` resolves
`from` imports from disk and wires `:=` data-file bindings into loaders), and
boundary type-and-polarity checking (actual vs callee input, selected output vs
receiving declaration), and VS Code wiring (the language-server validator and the
`datamog.run` command both elaborate imports from disk) all exist. A violated
constraint already names the instance it came from (`engine/src/constraints.ts`).
Still to come: REPL and playground **module-binding** wiring (see *Deferred*).
This is separate from the implemented REPL support for proof captures, constructor
matches and nominal type names from earlier chunks. Structural and nominal boundary
contracts are also implemented; see [constructor contracts](proof-signature-contracts.md). A `:=`
binding that reaches analysis (i.e. one the elaborator did not handle) is
rejected.

This is the ambitious alternative to the conservative module system in
[`imports.md`](./imports.md). Read that one first for the baseline; this doc
only states where it differs and why.

The core move: a Datamog program is a **function from input relations to output
relations**. Its inputs are its extensional predicates; its outputs are its
queries. Running it at the CLI instantiates the inputs (from CSV, by
convention) and prints the output. Loading it as a **module** instantiates the
inputs by wiring them to other predicates, and exposes the outputs for the
importer to use. That is exactly a parameterised module (an ML functor whose
parameters are relations, or a Soufflé component), reached by re-reading the two
things the language already has rather than adding a separate construct.

## Decisions baked in

Carried over from the discussion:

1. Named outputs are intensional predicates marked for export: a rule-style head
   with variable arguments and inferred types (`output predicate reach(X, Y) :-
   ...`), so they read like the intensionals they are. Only the single unnamed
   default output keeps query-style implicit projection. Column types are not
   declared on an output; the type contract at an import boundary lives on the
   receiving `input predicate`, checked against the output's published type.
2. **At most one unnamed query per file**, always (not only on import). Extra
   outputs must be named. This breaks programs that use several `?-` queries;
   there are no external clients, so the migration is ours alone.
3. Actuals passed to a module are **just predicate names**. (An input can still
   be bound directly to a data file with `:= "file"` — but that is a binding on
   the input itself, not an actual flowing into a module; actuals stay predicate
   names.)
4. Instantiating a module **duplicates** it (expansion / monomorphisation), but
   two instantiations that cannot be told apart are **shared**: instance identity
   is the module plus the predicate each input is wired to. Equal inputs mean
   equal outputs in a language with no side effects, so sharing is invisible apart
   from the smaller program. (The first version always duplicated; sharing landed
   with the alias-rule import binding, below.)

   In ML terms this makes the functors **applicative**, not **generative**:
   `F(A)` denotes one thing however many times it is written, rather than minting a
   fresh instance per application. The distinction is visible for proof-carrying
   outputs, where instances have identity you can observe (a constructor is
   qualified by its predicate, so a generative reading would give `a::Some` and
   `b::Some` as unrelated tags for two bindings with the same wiring, and an
   applicative one gives a single tag). Applicative is the coherent choice here:
   nothing in the language can distinguish two instantiations with equal arguments,
   so making them distinct types would be an artefact of the elaborator rather than
   a property of the program. Two instantiations with *different* wiring are still
   distinct — that is different arguments, not generativity.
5. Composition is by **expansion** (inline), not materialise-feed. Importing a
   module substitutes actuals for its inputs, freshens its private names per
   instance, and merges everything into one program with one global least fixed
   point (see *Semantics*).

## The interface of a module

A module (a file) has three interface elements:

```prolog
# reach.dl: generic reachability, parameterised by an edge relation
input predicate edge(src: integer, dst: integer).

output predicate reach(X, Y) :- edge(X, Y).
output predicate reach(X, Z) :- reach(X, Y), edge(Y, Z).
```

- **`input predicate P(cols).`** declares a parameter, with column types. It is
  supplied from outside the module's rules: at the CLI from `P.csv` in the
  module's own directory (per the conservative doc's decision 1), from a source
  bound with `:=` (see *Instantiation and wiring*), or, when the module is
  imported, by an actual the importer wires in. The `input predicate` keyword
  names that role directly: supplied from outside these rules, rather than
  table-backed.
- **`output predicate Head :- body.`** marks a rule as defining a named export.
  The head is rule-style (a predicate name and variable arguments, no declared
  types), so an output reads exactly like the intensional it is; a predicate is
  an output if any of its rules carries the marker. Types are inferred, as for
  any derived predicate.
- **The unnamed default output** is a single `?- body.` query. It keeps
  implicit projection (distinct non-anonymous variables, first-mention order).
  It is what prints at the CLI and what an importer gets when it does not name a
  specific output. It is optional: a pure library has only `output predicate`s
  and no `?-`.

Predicates that are neither `input` nor `output` are private to the module.
Encapsulation is implicit: you expose a predicate by declaring it an output, and
keep it private by not.

## Instantiation and wiring

An input predicate may be **bound** to a source with `:=` (a pun on `:-`: `:-`
means "defined by rules", `:=` means "bound to a source"). The binding is either
a data file or a module instantiation. The single rule: **`from` present means a
module; a bare string means a data file.**

```prolog
# main.dl
input predicate road(src: integer, dst: integer).       # leaf input, from road.csv
input predicate flight(src: integer, dst: integer).      # leaf input, from flight.csv

# an explicit data file, forcing the loader when the extension lies
input predicate airport(code: string, name: string) := "data/airports.tsv" as csv.

# instantiate reach.dl twice, wiring its `edge` input to two different relations
input predicate road_reach(src: integer, dst: integer)   := reach from "reach.dl"(edge = road).
input predicate flight_reach(src: integer, dst: integer) := reach from "reach.dl"(edge = flight).

?- road_reach(1, X).
```

Reading the right-hand side:

- A **bare string** (`:= "data/airports.tsv"`) is a data file, resolved relative
  to the importing file; the loader is chosen by extension, or forced with `as
  <format>` (`csv`, `jsonl`, `json`, `mermaid`, ...) when the extension does not
  or cannot say. This is the explicit form of the CLI's `P.csv`-by-convention
  default.
- **`reach from "reach.dl"`** is a module instantiation: `"reach.dl"` is a module
  reference (resolved relative to the importing file) and `reach` selects a named
  output. Omit the export name (`:= from "reach.dl"(...)`) to take the module's
  unnamed default output; the local name (`road_reach`) renames whatever is
  selected.
- **`(edge = road)`** supplies actuals for the callee's inputs by name
  (`moduleInput = localPredicate`). `road` is a predicate in `main.dl`'s scope
  (here a leaf input; it could equally be a derived predicate or another
  instantiation's result). This is decision 3: the only thing that flows across
  the boundary as an actual is a predicate name.

An input with a module default reads like a local binding but stays a parameter:
an importer of `main.dl` may override `road_reach` by wiring its own predicate,
or leave it and get the default instance. (A non-overridable, private "fixed"
import is a later refinement; the first version makes every import an overridable
default. See *Deferred*.)

Overriding is a real substitution, not a shadowing: an actual wired for an input
that also has a `:=` binding wins, and the bound source is then not instantiated
at all. That is what makes a module readable as an **interface**: its inputs are
the operations an importer must supply, a `:=`-bound input is a *default method*
the module derives for itself, and its integrity constraints are the interface's
*laws*, checked per instance against the data actually wired in. An actual naming
something that is not an input is rejected, so a misspelled override cannot
silently revert to the default. See the walkthrough's Chapter 16 for the worked
example.

Column types on the receiving declaration (`road_reach(src: integer, dst:
integer)`) must accept the selected output's signature, and each actual's columns
must be accepted by the callee input's declared types. Accept, not equal: the
declared type may equal or widen, never narrow (see *type checking* below).
Nullness rides the same contract. The existing type machinery checks both at the
boundary. The receiving types could later be inferred from the
selected output instead of restated, but declaring them keeps the interface
explicit. Polarity is part of the same boundary contract: a maximal module
input or output is written with `^` on its `input predicate` declaration in the
importer, and a `^` boundary accepts only a maximal predicate. The elaborator
preserves the sigil on its generated alias rule and rejects a polarity mismatch
at the binding.

## Semantics: expansion

Elaboration turns the whole import graph into one flat program, which the
existing analyze / translate / evaluate pipeline then runs unchanged.

```mermaid
graph TD
  entry["entry file"] --> parse["parse each referenced module (raw)"]
  parse --> graph["build instantiation graph from input defaults + overrides"]
  graph --> acyclic["check the instantiation graph is acyclic"]
  acyclic --> expand["per instantiation: copy module, substitute inputs, freshen private names + constructors"]
  expand --> merge["merge all expanded rules into one Program"]
  merge --> post["post-process merged program (global checks)"]
  post --> analyze["analyze + inferTypes + translate/evaluate (existing pipeline)"]
```

Per instantiation:

1. Take a fresh copy of the module's private and output predicates.
2. **Substitute** each input predicate with the actual predicate name the
   importer supplied (or, recursively, the input's own default). A wired input is
   not renamed, it resolves to a predicate in the importer's scope; an input left
   on a `:= "file"` data binding keeps its declaration and is freshened with the
   rest, so its data is private to the instance.
3. **Freshen** every private and output predicate name with a per-instance prefix
   (for example `road_reach$0$reach`), so two instances do not collide with each
   other or with the importer's names. The importer's chosen name binds to the
   instance's selected output through an **alias rule**
   (`road_reach(a, b) :- road_reach$0$reach(a, b).`), which is what lets several
   sites take different outputs of one shared instance, and names the result
   columns after the importing declaration. If the selected output is maximal,
   both sides retain `^` (`local^(...) :- instance$output^(...)`), and the
   receiving declaration must be `input predicate local^(...)`.
4. **Proof constructors** need no renaming, because they are qualified by their
   predicate (`predicate::Ctor`, see `qualified-constructors.md`). Renaming the
   head predicate carries the constructor with it: `opt`'s `Some`, imported as
   `dist`, becomes `dist::Some` — a writable name the importer can pattern-match,
   distinct per instance, so one program can match against several instantiations
   of one ADT module at once. (This superseded an earlier `<import>_<Ctor>`
   affix, which decisions 2 and 4 had introduced to dodge the old global
   constructor-uniqueness rule.)

Every input of an imported module must be **supplied** — wired by an actual, or
bound with `:= "file"` (a data source resolved relative to the module). An input
that is neither is an error (raised during elaboration); a module never
auto-loads. So the merged program's EDBs are the *entry* program's own free
inputs plus every `:=` data binding (entry or module). Everything derived is
IDB, the chosen output is the query, and the result is an ordinary single-file
Datamog program the backends run unchanged.

Auto-loading `<name>.csv` by convention is therefore not a language feature — it
is a CLI/playground convenience applied to the entry program's free inputs only.
A module carries its own data dependencies explicitly (via `:=`), so it behaves
identically wherever it is imported, regardless of files sitting next to the
importer.

## Consequences and limitations

State these plainly; they are the cost of expansion.

- **The instantiation graph must be acyclic.** Keep two graphs apart. The
  *predicate-dependency* graph (which predicate's rules mention which) may cycle
  freely; those cycles are recursion, resolved by the least fixed point over the
  expanded program. The *instantiation* graph (to build a copy of module A I
  must first build a copy of module B, because an input of A defaults to an
  instance of B) must not cycle. Expansion is not idempotent: each instantiation
  is expanded before its importer, and the post-expansion cache is keyed on the
  finished expansion, so a cycle among instantiations has no base case to stop
  it: instantiation is static and data-independent. Recursion *within* a module is therefore fine; recursion
  *across* a wiring cycle (A takes an input from B while B takes an input from A)
  is rejected. The practical rule: mutually recursive predicates must live in the
  same module. This is the one real expressiveness loss against the conservative
  merge design, whose merge-by-name is idempotent (include-once) and so tolerates
  cyclic imports and cross-file recursion; it is an acceptable trade for
  parameterisation and reuse in a teaching tool. The check is cycle detection
  over the reachable, post-override instantiation graph, so a default that points
  into a cycle but is always overridden before it fires is not flagged.
- **Duplicate per distinct wiring.** Two instantiations with the same actuals are
  expanded once and bound twice (decision 4); two with different actuals are two
  copies, which is the price of monomorphisation. Sharing does not change which
  programs are accepted — in particular it cannot turn linear recursion
  non-linear, because two instances only share when their wiring is identical, and
  identical wiring already places both copies in one SCC whenever a cycle runs
  through it.
- **A proof-carrying output is bound by name, not by an alias rule.** Its
  constructors are qualified by the predicate they land on, so the output is
  renamed to an importing site's name to make `local::Ctor` writable. An alias rule
  cannot substitute: proof-carrying-ness comes from a predicate's own `:: Ctor`
  rules and does not propagate through a pass-through rule, so the alias would drop
  the implicit proof column and a capture against it would be rejected. A second
  binding of the same output therefore adopts the first one's predicate outright,
  which keeps equal-wiring instantiations equal (one relation, one constructor) at
  the price of the second declaration's column labels and its own entry in `--all`.
  Making the alias route work instead would mean teaching post-processing that a
  predicate defined by a pass-through inherits its target's proof column and named
  rules — a change to the parser layer the module system otherwise never touches,
  and one that would affect hand-written pass-through rules too.
- **One unnamed query per file, enforced always.** A file with two `?-` queries
  is an error. The example corpus has already been migrated, and no further corpus
  work remains for this rule.
- **Diagnostics carry an instantiation path.** As in the conservative doc, each
  merged statement needs to trace back to its source module and position. Here it
  also needs the instantiation it came from, so an error in a module used twice
  can name which use triggered it. Slightly more plumbing than the single-file
  merge, same shape.

## CLI behaviour

`datamog main.dl` treats `main.dl` as the root module:

- Its free inputs (`road`, `flight`) load from `road.csv` / `flight.csv` in
  `main.dl`'s directory, or via `--road` / `--flight` input-flag overrides
  (`--input name=source` for names no flag can express).
- Its single unnamed `?-` output prints.
- A named `output predicate` is selected by a positional argument after the
  program (`datamog main.dl road_reach`), and `--all` runs every output. This is
  the CLI's equivalent of selecting a named export.

## Relation to the conservative design

The two are different composition models, not nested:

- Conservative (`imports.md`) shares predicates **by name** and merges, so a
  reference to an imported `path` is the same relation everywhere. Cross-file
  recursion is free; there is no parameterisation.
- This design **wires** inputs to outputs and expands, so a module can be reused
  with different inputs. Parameterisation and reuse are native; cross-file
  recursion via imports is not allowed.

For the common case (an acyclic import graph, modules with no free parameters,
one output taken per import) the two produce the same results. This design earns
its keep exactly when a module has free inputs and is reused, which is use case 2
from the conservative doc, delivered as the native model instead of a bolt-on.

## Touch points by package

Beyond the conservative doc's list (grammar, keywords, resolver, per-module
diagnostics, per-module EDB directories):

- **parser / keywords**: the `input predicate` / `output predicate` declaration
  forms and the `:=` source binding on inputs (`[export] from "path"(actual =
  pred, ...)` for a module, a bare string with optional `as <format>` for a data
  file). `input`, `output`, `predicate`, `from`, and `as` are contextual
  keywords. (Done.)
- **core**: `expandModule` does the per-instance expansion (substitute inputs,
  freshen private + output predicate names, rename the selected output to the
  importer's local name via `exportAs`; proof constructors are qualified by their
  predicate, so the rename carries them — `opt::Some` -> `dist::Some`).
  `elaborate` drives it recursively (the
  entry's bindings and nested imports), checks the instantiation graph is
  acyclic, and collects data-file bindings as a `DataSource[]`; it takes a
  `ModuleResolver` callback so it stays free of filesystem access. Selecting a
  module's `?-` default output synthesises a named `$default` output rule so it
  reuses the named-export path; an instance exposes only its selected output (its
  other outputs and its `?-` do not leak into the merged program). (All done.)
- **engine**: no backend changes; the entry's free inputs (and every `:=` data
  binding) become the merged program's EDBs — a module input must be supplied, so
  it is never left free. `DatamogExecutor.prepareElaborated(source, resolve, file)` runs the elaborate
  pipeline (parseRaw → elaborate → postProcess → analyze → inferTypes →
  `checkModuleBoundaries`) with the resolver injected, so the engine core stays
  filesystem-free (for the playground); the Node/Bun `createNodeModuleResolver`
  lives on the `datamog-engine/module-resolver` subpath. (Done.)
- **cli**: `datamog main.dl` parses raw, elaborates (resolving `from` imports
  relative to the entry), post-processes, then analyses and runs the merged
  program. `:=` data-file bindings become loaders (precedence: `--input` > `:=`
  binding > auto-load-by-convention). Imported outputs are selectable like any
  named output (`datamog main.dl <name>` / `--all`). (Done.)
- **vscode**: the `datamog.run` command runs the buffer via `prepareElaborated`
  (imports resolved relative to the saved file); the language-server validator
  elaborates a binding-using document (re-parsed into a throwaway AST so the
  Langium model is untouched) so a `:=` binding is validated rather than flagged
  as an error. (Done.)
- **boundary checking**: `elaborate` records a `BoundaryConstraint` per wiring
  (each actual vs the callee input's declared columns and polarity; the selected
  output vs the receiving declaration's columns and polarity), since those
  declarations are dropped when the binding is elaborated away.
  `elaborate` rejects known polarity mismatches before analysis can encounter a
  wrongly sigilled substituted call. `checkModuleBoundaries` verifies polarity
  again alongside the merged program's published types (inferred and widened by
  annotations) after `inferTypes`, using the
  directional subtype check `columnTypesCompatible` (the declared type must equal
  or widen the published one, never narrow it -- the same rule head type
  annotations use). The polarity must match exactly. The CLI runs the checks
  right after inference. (Done.)

## Deferred

- **Fixed / private imports** (a module-backed binding that is not part of the
  module's parameter surface). The first version makes every import an
  overridable input default.
- **A per-site identity for a second binding of a proof-carrying output.** It
  shares the instance (see *Consequences*) by adopting the first binding's
  predicate, so it is not a predicate of its own: its declared column names go
  unused and the relation prints once, under the first name, rather than once per
  binding. Presentation only — the relation and its constructors are the ones the
  wiring calls for either way, and a projection rule
  (`mine(derivation) :- derivation : a.`) recovers a labelled copy. Fixing it
  properly needs the alias route, hence proof-carrying pass-through rules in
  post-processing: post-processing derives an implicit proof column and a
  predicate's constructors from its own `:: Ctor` rules, and neither crosses a
  pass-through. Deciding *which* rules qualify is the awkward part — any
  single-atom pass-through changes what a hand-written `q(X, Y) :- p(X, Y).` means
  (today it drops the proof), while restricting it to elaboration's own aliases
  needs a marker on the generated rule, putting a module-system concept into the
  one layer the module system has so far never touched.
- **Inferring receiving column types** from the selected output signature instead
  of restating them.
- **Aliased whole-module access** (`import g = "mod.dl"(...)` then `g.a`, `g.b`).
  The first version selects one output per import site, naming it before
  `from` (`minimal from "order.dl"(...)`). (An
  instance's proof constructors are reachable as `<import>::<Ctor>`, so matching
  several instantiations of one ADT module already works; what remains deferred
  is multi-*output* access under one alias.)
- **REPL module bindings.** The REPL's `IncrementalSession` re-analyses the whole
  accumulated program each chunk and computes a per-chunk delta keyed off the new
  fragment's statements; elaboration transforms the whole program (dropping
  bindings, merging module rules), so the delta model would need reworking to a
  full re-diff. A `:=` line in the REPL is still rejected. Lower value: multi-file
  modules in an interactive session are unusual.
- **Playground module bindings.** The playground has no filesystem and no
  multi-source concept — a program is a single `source` string plus in-memory
  per-predicate data. Supporting imports needs a virtual resolver backed by
  additional in-memory `.dl` sources, which is a UX question (how the user
  supplies and edits several files), not just wiring. `prepareElaborated` already
  takes a `ModuleResolver`, so an in-memory resolver would slot in once that UX
  exists.
