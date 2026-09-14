# Datamog and the Datalog landscape

Datalog is a small idea with a wide range of incarnations: a teaching tool, a
query language for databases, a static-analysis engine that scales to millions
of lines of code, an embedded Rust library, a verification back-end. This
document places Datamog among them, comparing along three axes: what kind of
system it is (an educational prototype, a research system, a production system,
an embedded library, a verification tool), what its surface syntax looks like,
and which language features it supports.

The comparison is a snapshot (2026) and errs toward the slow-moving facts:
categories, evaluation strategy, syntax flavour, and the presence or absence of
core features. Version numbers are deliberately omitted since they age quickly;
the Sources section links the authoritative references for each system.

## Datamog in one paragraph

Datamog is an educational Datalog dialect implemented in TypeScript/Bun. It has
one language and five interchangeable backends that all agree on the same
semantics: three that compile a program to SQL (`CREATE TABLE` / `CREATE VIEW` /
`SELECT`) and run it on a relational database (PostgreSQL, SQLite, and sql.js,
the WASM build of SQLite), and two pure in-memory interpreters (a naive and a
seminaive bottom-up evaluator) that serve as readable reference implementations.
The surface is Prolog-like Horn clauses with `input predicate` declarations,
parity-stratified negation, aggregates, and static type inference over five column
types, one of which (`value`) is a first-class JSON/nested type; type
annotations are optional and, on rule heads, checked against inference, as is
whether a column may be NULL. A head position may also carry a proposition
instead of a type, checked against the tuples the predicate derives. Integrity
constraints (`!- ...`) declare conjunctions that must have no solutions, and
their counterexamples are reported before any query runs. A small
functor-style module system lets one file act as a function from its input
predicates to its outputs, bound to data files or other modules with `:=`. It is
built for
teaching and experimentation: it ships a browser playground, a VS Code
extension, and step-through tracing, and it deliberately stops short of the
extensibility that production engines carry.

## At a glance: positioning and implementation

| System | Category | Implemented in / how it runs | Surface syntax |
|---|---|---|---|
| **Datamog** | Educational | TypeScript/Bun; compiles to SQL (Postgres, SQLite, sql.js) or runs naive/seminaive in-memory interpreters | Prolog-like, `input predicate` declarations |
| **DES** | Educational deductive DB | Prolog (SWI/SICStus); top-down-driven bottom-up evaluation with tabling | Prolog-like; also SQL and relational-algebra front-ends |
| **Soufflé** | Research, production-used | C++; compiles Datalog to parallel C++ through a relational-algebra machine IR (semi-naive) | Prolog-like, `.decl` / `.input` / `.output` |
| **CodeQL (QL)** | Production (commercial) | Proprietary engine; compiles QL and evaluates bottom-up (parity-stratified least fixed point) over an extracted snapshot database | Object-oriented first-order logic; SQL-like `from` / `where` / `select` |
| **Flix** | Research language | Scala compiler to JVM bytecode; bottom-up lattice fixpoint | Functional (ML-like) with `#{ }` Datalog constraint blocks |
| **Datomic** | Production database | Clojure/JVM; Datalog query evaluated client-side over an immutable entity-attribute-value store | EDN data (queries-as-data), `:find` / `:where` |
| **Datafrog** | Embedded library | Rust; hand-assembled semi-naive joins, no runtime | None (Rust API) |
| **DDlog** | Research/production (archived) | Rust, compiled onto differential dataflow; incremental | `input`/`output relation` declarations + `:-` rules |
| **Z3 muZ** | Solver / verification | C++ (Z3); bottom-up Datalog, or Spacer/PDR for constrained Horn clauses over SMT theories | SMT-LIB `declare-rel` / `rule` / `query` |
| **LogicBlox (LogiQL)** | Commercial (dormant) | Native engine; bottom-up with incremental maintenance and worst-case-optimal (leapfrog-triejoin) joins over a transactional store | Datalog with `P[keys] = value` notation; `<-` rules, `->` constraints |
| **RelationalAI (Rel)** | Commercial (active) | Cloud knowledge-graph coprocessor; runs in-database (Snowflake native app); incremental maintenance | Relational language; `def Name(args): body`, first-order-logic bodies, first-class relations |
| **Cozo** | Production, embeddable | Rust; bottom-up semi-naive; pluggable storage (in-memory / SQLite / RocksDB / Sled / TiKV), ACID | CozoScript: `head[args] := body`, `?[...]` query, `*rel` stored relations |
| **Nemo** | Research | Rust; in-memory forward-chaining materialisation (semi-naive plus the restricted chase) | Datalog `:-` rules; `?` vars, `!` existentials, `~` negation, RDF literals |
| **Ascent** | Research / embedded library | Rust procedural macro; expands to native Rust at compile time; semi-naive (optional parallel) | `ascent!{ relation ...; head <-- body }` inside Rust; lattice columns |
| **Crepe** | Embedded library (minimally maintained) | Rust procedural macro; generates native Rust; semi-naive | `crepe!{ @input/@output struct ...; head <- body }` inside Rust |
| **Formulog** | Research | Java interpreter (semi-naive), plus an optional Soufflé/C++ backend; dispatches to an external SMT solver | Datalog `:-` rules plus ML-style functions and backtick-quoted SMT terms |

## At a glance: language features

| System | Recursion | Negation | Aggregation | Types | Standout feature |
|---|---|---|---|---|---|
| **Datamog** | General (in-memory) / linear only (SQL backends) | Parity-stratified (in-memory) / stratified (SQL backends) | count, sum, avg, min, max, concat, list | Static inference: primitives/null, structural JSON shapes, nominal proof types; aliases and optional head/constructor contracts | Multiple cross-checked backends; compiles Datalog to SQL |
| **DES** | General | Stratified | Yes, with `group_by` | Optional, declared as integrity constraints | One database queried via Datalog, SQL, and relational algebra; tracers and declarative debuggers; nulls and duplicates |
| **Soufflé** | General | Stratified | count, sum, min, max, mean | Static: number/unsigned/float/symbol plus records and ADTs | Subsumption, choice domains, generic components, C++ foreign functors |
| **CodeQL** | General, plus `+`/`*` transitive-closure operators | Parity-stratified (recursion through an even number of negations) | Yes, plus monotonic aggregates usable inside recursion | Static OO: int/float/string/boolean/date/bigint, classes, and algebraic datatypes (`newtype`) | First-order-logic bodies (not just Horn clauses); OO classes plus ADTs; no nulls |
| **Flix** | General (stratified) | Stratified | Expressed through lattices | Static Hindley-Milner inference, effects, ADTs, traits | First-class Datalog values; least fixed points over lattices |
| **Datomic** | Via named rules | `not` / `not-join` | Rich (sum, count, avg, min, max, ...) | Per-attribute schema | Datalog over immutable, time-travelling data; Pull API |
| **Datafrog** | Manual fixpoint loop | None built in | None built in | Rust tuple types (must be `Ord`) | Minimal embeddable engine: you assemble the joins yourself |
| **DDlog** | General | Yes | Yes, with grouping | Rich (ints, bitvectors, floats, strings, tuples, tagged unions, collections) | Incremental by construction (recomputes deltas on input change) |
| **Z3 muZ** | General (constrained Horn clauses) | Stratified (finite mode) | Not a first-class layer | SMT sorts (int, real, bitvector, array, ADT) | Datalog as a front-end to an SMT fixed-point / verification solver |
| **LogicBlox (LogiQL)** | General | Stratified | Yes (`agg<< >>`) | Static entity types; value constructors | Integrity constraints as language constructs; incremental maintenance; worst-case-optimal joins |
| **RelationalAI (Rel)** | General (no linearity limit) | Yes, with quantifier safety | From a single `reduce` primitive | Typed; relations as the sole primitive | First-class / higher-order relations; first-order-logic bodies; in-database cloud engine |
| **Cozo** | General | Stratified (`not`) | Yes, in rule heads | Typed columns incl. JSON and float vectors | Embeddable multi-backend DB; built-in graph algorithms + HNSW vector search; time travel |
| **Nemo** | General | Stratified (`~`) | Yes | RDF datatypes plus named nulls | Existential rules (labelled nulls via the chase); knowledge-graph reasoning |
| **Ascent** | General | Stratified | Built-in and user-defined; also lattices | Any Rust type (`Clone+Eq+Hash`); lattice columns | Lattice fixpoints (like Flix) as a Rust macro; native-Rust interop |
| **Crepe** | General | Stratified | Not built in | Any suitable Rust type | Minimal proc-macro Datalog; calls host Rust functions in bodies |
| **Formulog** | General | Stratified | Not a focus | ML-style ADTs plus SMT-LIB sorts | Builds and solves SMT formulas mid-evaluation; ML functional sublanguage |

## The same problem in several syntaxes

Transitive closure (reach `path` from `edge`) is the "hello world" of Datalog.
Seeing it side by side is the quickest way to feel the syntactic range.

**Datamog** (typed declarations, Prolog-like rules, `?-` query):

```prolog
input predicate edge(x: integer, y: integer).
path(X, Y) :- edge(X, Y).
path(X, Y) :- path(X, Z), edge(Z, Y).
?- path(1, 3).
```

**DES** identical rule shape, facts inline, query at the `DES>` prompt:

```prolog
edge(1,2).  edge(2,3).
path(X,Y) :- edge(X,Y).
path(X,Y) :- path(X,Z), edge(Z,Y).
```

**Soufflé** adds `.decl` type signatures and explicit input/output directives:

```prolog
.decl edge(x:number, y:number)
.input edge
.decl path(x:number, y:number)
.output path
path(x, y) :- edge(x, y).
path(x, y) :- path(x, z), edge(z, y).
```

**CodeQL** writes the same relation as a recursive predicate in object-oriented
logic (illustrative):

```ql
predicate path(int x, int y) {
  edge(x, y)
  or
  exists(int z | path(x, z) and edge(z, y))
}
```

**Flix** embeds the rules as a first-class constraint value inside a function:

```scala
let rules = #{
    Path(x, y) :- Edge(x, y).
    Path(x, z) :- Path(x, y), Edge(y, z).
};
let paths = query edges, rules select (x, y) from Path(x, y);
```

**Datomic** expresses recursion as a rule set, written as EDN data:

```clojure
[[(path ?x ?y) [?x :edge ?y]]
 [(path ?x ?y) (path ?x ?z) [?z :edge ?y]]]
```

**DDlog** declares input/output relations, then the familiar rules:

```prolog
input relation Edge(s: node, t: node)
output relation Path(s1: node, s2: node)
Path(x, y) :- Edge(x, y).
Path(x, z) :- Path(x, w), Edge(w, z).
```

**Z3 muZ** writes rules as SMT-LIB implications and asks a reachability query:

```lisp
(declare-rel edge (Int Int))
(declare-rel path (Int Int))
(declare-var a Int) (declare-var b Int) (declare-var c Int)
(rule (=> (edge a b) (path a b)))
(rule (=> (and (path a b) (path b c)) (path a c)))
(query (path 1 3))
```

**Datafrog** has no language at all: you build the fixpoint in Rust:

```rust
let mut iteration = Iteration::new();
let path = iteration.variable::<(u32, u32)>("path");
path.insert(edges.into());
while iteration.changed() {
    path.from_join(&path, &edges, |_b, &a, &c| (a, c));
}
let result = path.complete();
```

Everything from `edge`/`path` down to `Edge`/`Path` is the same least fixed
point; the difference is entirely in how much ceremony, typing, and host
language surrounds it.

## The implementation spectrum

The systems fall into a few broad kinds. The point of Datamog is to sit
squarely in the first one while borrowing the relational framing of the last.

### Teaching systems

**DES** is Datamog's closest relative in intent: a free, Prolog-based deductive
database built to teach the concepts, with stratified negation, aggregates,
nulls, duplicates, tracers, and declarative debuggers. The instructive twist is
that DES and Datamog bridge the Datalog/SQL correspondence in opposite
directions. DES lets you query one in-memory database through Datalog, SQL, and
relational algebra, translating SQL down into Datalog and running everything on
a Prolog tabling engine. Datamog goes the other way: it translates Datalog up
into SQL and runs it on real relational databases. Both use the correspondence
as a teaching device; they just cross the bridge from opposite banks.

Datamog is narrower than DES (no relational-algebra or SQL front-end, no bag
semantics, no declarative debugger) but adds things DES does not have: a
browser playground, multiple backends that check each other, a first-class
JSON `value` type, algebraic datatypes as proof terms, and a functor-style
module system that lets a file act as a function from its input predicates to
its outputs.

### Research and production analysis engines

**Soufflé** is what Datalog looks like when performance is the goal. It compiles
a program to parallel C++ through a relational-algebra-machine IR, with
automatic index selection and purpose-built concurrent data structures, and it
is used for industrial-scale program analysis (points-to analysis, binary
disassembly). On top of plain Datalog it adds records and algebraic data types,
subsumption rules, choice domains, generic components, and a C++ foreign-function
interface. Datamog shares the Horn-clause surface and stratified negation but is
an interpreter/translator, not a compiler, and carries none of the
extensibility; where Soufflé allows general recursion, Datamog's SQL backends
are limited to linear recursion (its in-memory backends are not).

**CodeQL** is the most linguistically ambitious of the group and the least
Horn-clause-like. Its language, QL, keeps Datalog semantics underneath, but its
rule bodies are general first-order-logic *formulas* (`and`, `or`, `not`,
`exists`, `forall`, implication) rather than the conjunctions of literals a Horn
clause allows, wrapped in an object-oriented layer of classes, inheritance,
characteristic predicates, and `this`, and complemented by algebraic datatypes
(`newtype`) that sit orthogonally to classes (virtual dispatch plays the role of
pattern matching). That richer surface buys a stronger negation rule: QL is
*parity-stratified*, allowing recursion through negation as long as every
recursive cycle passes an even number of negations, which keeps the recursion
monotone and its least fixed point well-defined and rules out liar-paradox
predicates that would hold exactly when they do not. That is strictly more
permissive than the plain stratified negation of Soufflé and DES, which forbid
recursion through negation altogether, and it only makes sense because the
language is full first-order logic, not Horn clauses. Datamog admits the same
even-parity cycles, but asks the author to mark which side is maximal with a
`^` sigil rather than inferring it, and only its in-memory backends evaluate
one. QL is a
production, largely commercial system for security analysis, running queries
over a relational snapshot database extracted from a codebase, and it notably
has no nulls: a predicate either holds for a tuple or it does not. Datamog is
far smaller: flat predicates rather than a statically typed OO class hierarchy,
Horn-clause bodies, an explicitly annotated parity stratification, and nulls.

### A research language

**Flix** embeds Datalog into a full statically typed functional language on the
JVM. Constraint sets are first-class values that can be built and combined at
runtime, and the real generalisation is that Flix computes least fixed points
over user-defined lattices with monotone functions, not just over relations,
which lets one declarative program express analyses (constant propagation,
interval analysis) that plain relational Datalog cannot. Datamog stays
relational, with no lattices and no host language around the rules; its
"aggregation" is a fixed set of functions rather than an open lattice framework.

### Datalog as a database query language

**Datomic** uses Datalog not as a standalone deductive engine but as the query
language of an immutable, time-travelling database. Queries are EDN data (not
strings) over entity-attribute-value datoms, evaluated client-side, with a
separate Pull API for graph projection; recursion is expressed through named
rule sets and negation through `not`/`not-join`. It became free of licensing
fees in 2023 (binaries under Apache 2.0), though it is still developed
internally rather than as a source-open project. The contrast with Datamog is
instructive: Datomic *is* the database and treats Datalog as its query surface;
Datamog is a language that *compiles onto* a database (SQL) it does not own.

**Cozo** is the embeddable counterpart. It is a Rust relational-graph-vector
database whose query language, CozoScript, is a Datalog dialect (`head[args] :=
body`, `?[...]` for output, `*rel` for stored relations), evaluated bottom-up
over pluggable storage (in-memory, SQLite, RocksDB, Sled, TiKV) with ACID
transactions. What sets it apart is what it folds into the Datalog surface:
whole-graph algorithms as built-in "fixed rules" (PageRank and the like, invoked
with `<~`), HNSW vector-similarity indices for embedding search, and time travel.
Where Datomic is a heavyweight JVM database that speaks Datalog, and Datamog
compiles Datalog out to a SQL engine it does not own, Cozo is a small engine that
owns its storage and targets production graph and AI-retrieval workloads rather
than teaching.

### Commercial general-purpose platforms

Two proprietary systems build full application platforms on Datalog, and they
share a bloodline: Molham Aref founded **LogicBlox** and then **RelationalAI**,
and the Rel language explicitly cites LogiQL (with QL and Soufflé) as an
influence.

**LogicBlox** (language **LogiQL**) was an influential commercial deductive
database for retail and supply-chain analytics. Beyond textbook Datalog it added
a functional `P[keys] = value` notation, integrity constraints as first-class
`->` clauses (distinct from `<-` derivation rules), static entity types, and a
module system, over an engine built for continuous incremental maintenance of
materialised predicates, worst-case-optimal (leapfrog-triejoin) joins, and
transactional persistence. It was folded into Infor (via Predictix) around 2016
and now looks dormant as a public product.

**RelationalAI**'s **Rel** is the living successor. Relations, tuples, and even
relation variables are first-class; rule bodies are first-order-logic formulas;
recursion carries no linearity restriction; and aggregation is derived from a
single `reduce` primitive, alongside quantifiers and declarative integrity
constraints. It ships as a managed knowledge-graph coprocessor that runs
in-database (currently a Snowflake native app), maintaining a materialised graph
incrementally. Both sit at the opposite end from Datamog: where Datamog is a
small, local, educational Datalog that compiles to SQL, these are large
proprietary engines whose reason for being is incremental maintenance of a
materialised store at production scale.

### Embedded Datalog libraries

**Datafrog** is Frank McSherry's lean Datalog engine for Rust, best known as the
core of an early version of the Rust compiler's Polonius borrow checker. It has
no surface language at all: you construct the semi-naive fixpoint by hand out of
`Variable`s and `from_join` calls, and there is no built-in negation or
aggregation. It is the minimalist extreme, a toolkit rather than a system, and
about as far from Datamog's batteries-included teaching setup as a Datalog can
get while still being one.

Two systems keep Datafrog's embeddable, host-integrated spirit but add a real
surface language through Rust procedural macros. **Crepe** (`crepe!{ ... }`) is
the minimal one: you declare `@input`/`@output` relations and write `head <-
body` rules, and the macro emits a native-Rust struct with a semi-naive engine
and auto-built indices, with rule bodies free to call ordinary Rust functions.
**Ascent** (`ascent!{ ... }`) goes further and, like Flix, computes fixpoints
over user-defined **lattices** as well as plain relations, with built-in and
user-defined aggregation and an optional parallel evaluator. Both expand at
build time into ordinary Rust rather than interpreting a standalone language, so
unlike Datamog there is no parser, REPL, SQL translation, or separate backend:
once the macro expands, the Datalog *is* Rust.

The neighbouring **DDlog** (Differential Datalog, from VMware) is a real
Datalog-like language that compiles onto McSherry's *differential dataflow*
substrate and is therefore incremental by construction: it ingests streams of
input changes and recomputes only the output deltas. It is now archived, but it
represents an axis Datamog does not attempt at all, incremental maintenance;
Datamog always evaluates from scratch. (Differential dataflow itself is the
underlying engine, not a Datalog language.)

### Existential rules

**Nemo** (from TU Dresden, the successor to VLog) is a Rust rule engine for
knowledge-graph and semantic-web reasoning, and it is the one system here whose
rules can be **existential**: a head variable prefixed `!` asserts that *some*
value exists without naming or constructing it, and the engine mints a fresh
labelled null (an RDF blank node) as a witness, handled by the chase rather than
by plain saturation.

It is worth being precise about what is new here, because "inventing values" is
not the line. Soufflé and CodeQL build new values with algebraic-datatype
constructors; Datamog does too — its proof terms are constructed datatype values
— as well as with JSON object/array literals and `parse_json` (which is exactly
why Datamog carries a finiteness checker); all of these leave the input's active
domain. The difference is that a constructor
produces a *specific, transparent* term (`pair(1, 2)`, `{"k": v}`) that you can
inspect and that has structural identity, whereas an existential rule *posits an
unnamed, opaque* individual, which shifts the task from computing a least model
to computing a universal model for certain-answer query answering over
incomplete data. (Skolemising the existential turns it back into a constructed
term `f(x)`, which is the formal bridge between the two.)

Datamog has term construction but no existential quantification: every head
variable must be bound by the body, so it can build a new `value` but never
merely assert that one exists. Reasoning about entities absent from the data is
Nemo's purpose and outside Datamog's scope. (Commercial RDF reasoners such as
RDFox occupy the same existential-rule space.)

### Datalog and SMT solvers

**Z3's muZ** fixed-point engine shows Datalog used for verification rather than
data. Rules are universally quantified Horn clauses; a "query" asks whether some
relation (for example an error state) is derivable. Its default finite mode is a
bottom-up Datalog engine, but the interesting mode is Spacer, a PDR-style solver
for constrained Horn clauses whose relations range over SMT theories (integers,
reals, bitvectors, arrays), which lets it reason about infinite-state programs.
Datamog and muZ share the Horn-clause skeleton and essentially nothing else:
Datamog computes finite relations over stored data, muZ solves for the existence
of a model over theories.

**Formulog** approaches the same border from the other side. Where Z3's muZ is a
solver with a Datalog front-end, Formulog is a Datalog that *embeds* a solver: it
adds an ML-style functional sublanguage (algebraic datatypes, pattern matching)
and treats SMT formulas as first-class terms, so a rule can assemble a formula
mid-evaluation and discharge it with `is_sat` / `is_valid` against an external
solver (Z3 by default). It is a Harvard research language, a Java interpreter
with a newer Soufflé/C++ compiled backend, built for SMT-based static analyses
such as symbolic execution and refinement typing. Datamog has algebraic
datatypes of its own — proof terms, where a named rule is a constructor — and
refinement annotations, where a head position carries a proposition rather than
a type. But it bundles no solver: a refinement is *checked* against the tuples a
predicate derived, and proving it for all inputs means supplying one.
`--obligations` writes the proof obligations out as SMT-LIB and `--verify` runs
them through the solver `--solver` names. It also has no ML-style
functional sublanguage; its datatypes also desugar to the dynamically-shaped
`value` type rather than Formulog's statically-typed ADTs.

## Where Datamog fits

Datamog is unambiguously in the educational-prototype tier, alongside DES rather
than Soufflé, CodeQL, or Datomic. What distinguishes it within that tier is a
small set of deliberate choices:

- **It compiles Datalog to SQL.** The primary backends emit `CREATE VIEW` /
  `SELECT`, which makes the Datalog-to-relational-algebra correspondence
  something you can read in the generated output rather than take on faith.
- **It runs several backends against each other.** The two in-memory
  interpreters are readable reference semantics; the SQL backends are checked
  against them. Divergence is a bug, so the SQL backends cannot quietly drift
  from the readable reference.
- **It has a first-class JSON `value` type.** Nested data is handled directly,
  which most classical Datalogs (flat, typed or untyped tuples) do not offer.
- **It presents algebraic datatypes as proof terms.** Naming a rule turns its
  predicate into a datatype whose values are the derivations — a concrete
  Curry-Howard reading you can compute with, unusual among Datalogs.
- **It composes files as functions.** A functor-style module system treats each
  file as a function from its input predicates to its outputs, wired with `:=`
  to data or to other modules — a level of modular composition most teaching
  Datalogs lack.
- **It is approachable.** A browser playground, a VS Code extension, and
  step-through tracing lower the barrier for learners.

The flip side is everything it leaves out on purpose: no user-defined or foreign
functions (Soufflé) or host-language interop (Ascent, Crepe), no lattices (Flix,
Ascent), no statically typed record/ADT type system (Soufflé, Formulog), no
incremental maintenance (DDlog, LogicBlox, RelationalAI), no persistence or time
travel (Datomic, Cozo), no existential rules (Nemo), no SMT or theory reasoning
(Z3, Formulog), and linear-recursion-only on the SQL path. It does construct
values (JSON objects, arrays, `parse_json`, and proof-term datatypes), so it is
not value-free; what it lacks is the *existential*
positing of unnamed ones. Those richer features are what turn a Datalog into a
research or production system; leaving them out is what keeps Datamog a teaching
one.

## What the neighbours' examples show

The feature lists above are abstract. The example collections these systems
ship are concrete, and working through them is a direct way to find where
Datamog's boundary actually runs. Most of the classics transfer:
`packages/cli/examples/` now carries relational algebra, relational division
and the Towers of Hanoi adapted from DES, water jugs and the prison guards
from Ciao, and the zebra puzzle and Collatz sequences from SWI-Prolog and
Logtalk. Four groups do not transfer, each for a different reason.

### Negation inside a cycle

XSB's win/lose game is a single rule:

```prolog
win(X) :- move(X, Y), not win(Y).
```

DES ships two smaller versions of the same shape: `russell.dl`, where the
barber shaves everyone who does not shave himself, and `paradox.dl`, which
is just `p :- not p`.

Datamog rejects all three at analysis time. Each of their cycles passes an
odd number of negations, and Datamog's parity rule needs a negated call to
flip polarity, which an odd cycle cannot do. The systems that accept them
give up a two-valued model to do it. XSB evaluates
under the well-founded semantics, where a game position can be *undefined*
rather than won or lost, which is exactly what a drawn position should be.
DES warns that the program is non-stratifiable and reports a set of
undefined tuples alongside the true ones, by an algorithm its manual notes
is incomplete. CodeQL takes a third route, parity stratification, accepting
recursion through an even number of negations, which readmits some useful
programs while still ruling out the liar-shaped ones. Datamog takes that
route too, so an even cycle is expressible, but none of these three is: the
odd parity is what makes them paradoxical in the first place.

### Search that needs propagation or pruning

Datamog's only search strategy is generate-and-test: enumerate candidates
as a cross product and filter them with comparisons. Putting the filters in
the same rule as the generators lets the join discard partial candidates as
it goes, which is a poor relation of constraint propagation and enough for a
surprising amount. `map-colouring`, `zebra` and `guardians` all work this
way, and n-queens does too.

It stops working when the candidate space is astronomically large but
heavily constrained, which is precisely the CLP(FD) sweet spot: Ciao's
`sudoku_clpfd.pl` and SWISH's `clpfd_sudoku.pl` search a space of 9^81
grids that only domain propagation makes tractable, and no join ordering
substitutes for it. Optimisation problems (knapsack, magic series) fail for
a related reason: Datalog can enumerate feasible solutions and take a `min`
over them, but it cannot use a bound found so far to prune the rest.

Ciao's `knights.pl`, a knight's tour, fails a third way. It is expressible
in principle, since a tour is a path in a graph, but a Hamiltonian-path
search needs to order and prune its frontier, and a least fixed point
enumerates every partial tour in no particular order.

### Terms, unification, and general recursion

Ciao's `boyer.pl` (a rewriting theorem prover), `tak.pl`, `qsort.pl` and
`poly.pl`, SWISH's `lists.pl`, and Logtalk's `ack` are Prolog benchmarks
built on unification over unbounded terms, with recursion that builds new
structure as it descends.

Datamog does construct values: JSON arrays and objects, and proof terms as
an algebraic datatype. What it does not do is posit them existentially. A
constructor term is always a match, so a rule cannot mint a node whose parts
do not already exist; building terms means either bounding the universe with
an index (`examples/peano`) or driving construction from a request predicate
(`examples/sk-proof-terms`). That covers a fixed, finite term universe, and
not `qsort` over an arbitrary list.

### Program-level features with no counterpart

DES's **hypothetical queries** (manual §4.1.19) answer "what would this
query return if these extra facts also held", without changing the
database, and compose with its integrity constraints and negation. Datamog
has no what-if construct: the only way to ask is to edit the program.

Its **restricted predicates** (§4.1.17) and **limited-domain predicates**
(§4.1.18) are safety escape hatches for rules Datamog would simply reject.
And DES supports **duplicates** (§4.1.9), with bag semantics and duplicate
counting throughout; Datamog is set-valued everywhere, by choice, so
`count` is the only way to recover multiplicity.

## Further afield

Even this list is not exhaustive. Others one might reach for next include
**RDFox** and Nemo's predecessor **VLog** (existential-rule and RDF reasoners),
**Bloom** / **Dedalus** (Datalog for distributed and temporal computation),
**IncA** (a language for incremental program analyses), and the Datalog engines
tucked inside various graph databases. This document stops here rather than
trace the whole family tree.

## Sources

Datamog's own behaviour is defined by [`doc/spec.md`](spec.md). For the other
systems:

- **Soufflé**: <https://souffle-lang.github.io/>, <https://github.com/souffle-lang/souffle>
- **Flix**: <https://flix.dev/>, <https://doc.flix.dev/>, "From Datalog to Flix" (PLDI 2016)
- **CodeQL / QL**: <https://codeql.github.com/docs/ql-language-reference/>, recursion and parity stratification <https://codeql.github.com/docs/ql-language-reference/recursion/>, algebraic datatypes <https://codeql.github.com/publications/algebraic-data-types.pdf>, <https://github.com/github/codeql>
- **DES**: <https://des.sourceforge.net/>, DES User's Manual (Sáenz-Pérez, UCM) <https://www.fdi.ucm.es/profesor/fernan/des/html/manual/manualDES.html>
- **XSB**: <https://xsb.sourceforge.net/>, "XSB: Extending Prolog with Tabled Logic Programming" <https://arxiv.org/abs/1012.5123>
- **SWI-Prolog / SWISH**: <https://www.swi-prolog.org/>, example collection <https://swish.swi-prolog.org/example/examples.swinb>
- **Ciao**: <https://ciao-lang.org/>, example collection <https://github.com/ciao-lang/ciao/tree/master/core/examples>
- **Logtalk**: <https://logtalk.org/>, example collection <https://github.com/LogtalkDotOrg/logtalk3/blob/master/examples/NOTES.md>
- **Datomic**: <https://docs.datomic.com/query/query-data-reference.html>, <https://blog.datomic.com/2023/04/datomic-is-free.html>
- **Datafrog**: <https://github.com/rust-lang/datafrog>, McSherry's blog <https://github.com/frankmcsherry/blog>
- **DDlog / differential dataflow**: <https://github.com/vmware/differential-datalog>, <https://github.com/frankmcsherry/differential-dataflow>
- **Z3 muZ**: <https://microsoft.github.io/z3guide/docs/fixedpoints/basicdatalog/>, "muZ" (CAV 2011)
- **LogicBlox / LogiQL**: "Design and Implementation of the LogicBlox System" (SIGMOD 2015) <https://dl.acm.org/doi/10.1145/2723372.2742796>, <https://en.wikipedia.org/wiki/LogicBlox>
- **RelationalAI / Rel**: "Rel: A Programming Language for Relational Data" <https://arxiv.org/abs/2504.10323>, <https://www.relational.ai/>
- **Cozo**: <https://github.com/cozodb/cozo>, <https://docs.cozodb.org/>
- **Nemo**: <https://github.com/knowsys/nemo>, "Nemo: A Scalable and Versatile Datalog Engine" <https://ceur-ws.org/Vol-3801/short3.pdf>
- **Ascent**: <https://github.com/s-arash/ascent>, "Seamless Deductive Inference via Macros" (CC 2022)
- **Crepe**: <https://github.com/ekzhang/crepe>, <https://docs.rs/crepe/>
- **Formulog**: <https://github.com/HarvardPL/formulog>, "Formulog: Datalog for SMT-Based Static Analysis" (OOPSLA 2020) <https://arxiv.org/pdf/2009.08361>
