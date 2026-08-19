# Chapter 1 — Facts, queries, and predicates

Every Datalog program is built from two kinds of statement: **facts**
(things we know are true) and **queries** (things we want to know).
In this chapter we write both, and introduce the core vocabulary —
*predicate*, *atom*, *argument* — that we will use for the rest of
the tutorial.

There are no rules yet; that's Chapter 2. For now, Datalog is going to
look like a very terse way of describing a small database.

## A tiny database

Our running example is a handful of computer scientists and where they
were born. We'll extend it into family relationships in the next
chapter.

Open [`code/ch01/people-inline.dl`](code/ch01/people-inline.dl):

```prolog
person("ada_lovelace",    "uk", 1815).
person("alan_turing",     "uk", 1912).
person("grace_hopper",    "us", 1906).
person("edsger_dijkstra", "nl", 1930).
person("john_mccarthy",   "us", 1927).
person("tony_hoare",      "uk", 1934).
person("barbara_liskov",  "us", 1939).
person("niklaus_wirth",   "ch", 1934).

?- person(Name, Country, Year).
```

Each of the first eight lines is a **fact**: a statement that some
particular tuple of values satisfies the `person` relation. The last
line is a **query**: `?- person(Name, Country, Year).` asks "give me
every assignment of `Name`, `Country`, and `Year` such that
`person(Name, Country, Year)` is true".

Run it:

```bash
bun run datamog doc/walkthrough/code/ch01/people-inline.dl
```

You should see a table with all eight rows. Congratulations — you've
written a Datalog program.

**[Open this program in the playground →](https://xiemaisi.github.io/datamog/#p=%23%20Same%20facts%20as%20people.dl%2C%20but%20written%20inline%20instead%20of%20loaded%0A%23%20from%20a%20CSV.%20Useful%20for%20one-off%20experiments%3A%20no%20companion%20data%0A%23%20file%20is%20needed.%0A%0Aperson(%22ada_lovelace%22%2C%20%20%20%20%22uk%22%2C%201815).%0Aperson(%22alan_turing%22%2C%20%20%20%20%20%22uk%22%2C%201912).%0Aperson(%22grace_hopper%22%2C%20%20%20%20%22us%22%2C%201906).%0Aperson(%22edsger_dijkstra%22%2C%20%22nl%22%2C%201930).%0Aperson(%22john_mccarthy%22%2C%20%20%20%22us%22%2C%201927).%0Aperson(%22tony_hoare%22%2C%20%20%20%20%20%20%22uk%22%2C%201934).%0Aperson(%22barbara_liskov%22%2C%20%20%22us%22%2C%201939).%0Aperson(%22niklaus_wirth%22%2C%20%20%20%22ch%22%2C%201934).%0A%0A%3F-%20person(Name%2C%20Country%2C%20Year).%0A)**

### Facts, atoms, predicates

A few terms to fix before going further:

- **Predicate.** The name of a relation. Here, `person`.
- **Atom.** An application of a predicate to some arguments:
  `person("ada_lovelace", "uk", 1815)` is an atom, and so is
  `person(Name, Country, Year)`. The first is a ground atom (all
  arguments are values); the second is a pattern (some arguments
  are variables).
- **Fact.** A ground atom asserted as true, written with a trailing
  dot.
- **Arity.** How many arguments a predicate takes. `person` is
  ternary (arity 3).

**Variable names start with a capital letter** (`Name`, `Country`,
`X`, `Answer`). Lowercase bare words (`ada_lovelace`, `uk`) are not
variables — they're not legal as arguments unless quoted as strings.
Datamog will reject the unquoted form; put everything in double
quotes the way the facts above do.

## Typed, declared predicates

Writing eight facts inline is fine for a toy. At any realistic size
you want the data somewhere else — a CSV, a JSONL file, a Google
Sheet — and you want Datamog to know what *type* each column has.

For that we use `input predicate`, which declares a predicate and names
its columns. Look at [`code/ch01/people.dl`](code/ch01/people.dl):

```prolog
input predicate person(name: string, country: string, year_born: integer).

# A file runs a single query. Edit it to ask a different question.
?- person(Name, Country, Year).
```

No inline facts, no CSV import machinery — just a schema. The actual
data lives alongside it in [`code/ch01/person.csv`](code/ch01/person.csv):

```
name,country,year_born
ada_lovelace,uk,1815
alan_turing,uk,1912
...
```

When you run the `.dl` file, Datamog looks for a sibling file whose
basename matches the predicate (`person.csv`, `person.jsonl`,
`person.json` for a single-`value`-column declaration, or `person.mmd`
for a Mermaid graph) and loads it.

```bash
bun run datamog doc/walkthrough/code/ch01/people.dl
```

The query prints everyone. To ask the other questions (everyone from
the UK, or everyone born in 1912), edit the query and run again: a file
reports one query, its **default output**. Chapter 2 shows how to report
several results from a single file at once, as *named outputs*.

### "Extensional" vs. "intensional"

The word `input predicate` is Datalog jargon; it comes straight from
logic. A predicate is *extensional* when its meaning is given by
explicit enumeration (a list of facts, or a table). It is
*intensional* when its meaning is given by a *definition* — a rule
that derives it from other predicates.

We will meet intensional predicates in the next chapter. For now:
everything in this chapter is extensional.

## Queries, and what variables mean in them

A query has the same shape as a body atom: a predicate applied to
arguments. Arguments can be:

- **Constants** — strings, numbers, booleans. They must match
  exactly.
- **Variables** — capitalised identifiers. The query returns every
  binding of those variables that makes the atom true.
- **The don't-care variable `_`** — "something, I don't care what".
  Use it when a column needs to be present syntactically but its
  value doesn't matter.

A few example queries; try them one at a time, editing the query line
in `people.dl` and re-running:

```prolog
?- person(Name, "us", Year).     # Americans and the year they were born
?- person("alan_turing", _, Y).  # When was Turing born?
?- person(_, _, 1934).           # Too many variables to bind? Use _
```

The same variable may appear in more than one argument; in that
case all its occurrences must take the same value. That's how
Datalog expresses equalities — but it really shines once you have
more than one atom in a query body, which we'll see in Chapter 2.

> **Logic lens.** A Datalog predicate is a *relation* in the
> mathematical sense: a set of tuples. A ground fact like
> `person("alan_turing", "uk", 1912)` is an *atomic formula*
> asserted as true. A query `?- person(Name, "uk", Year)` is, in
> logical notation, the formula
>
> ```
> ∃Name, Year. person(Name, "uk", Year)
> ```
>
> but with a twist: instead of returning a single yes/no answer, we
> report every *witness* — every assignment to `Name` and `Year`
> that makes it true. That's the usual convention in database
> logic, and it's exactly what `SELECT` does in SQL.

> **SQL lens.** Run the same program with `--dry-run`:
>
> ```bash
> bun run datamog --dry-run doc/walkthrough/code/ch01/people.dl
> ```
>
> You should see:
>
> ```sql
> CREATE TABLE IF NOT EXISTS "person" (
>   "name" TEXT NOT NULL,
>   "country" TEXT NOT NULL,
>   "year_born" INTEGER NOT NULL
> );
>
> SELECT DISTINCT "name" AS "Name", "country" AS "Country", "year_born" AS "Year" FROM "person";
> ```
>
> The `input predicate` declaration became `CREATE TABLE`, and the query
> became a `SELECT DISTINCT`. Variables in the query turned into `AS`
> aliases. Swap a constant into the query (say `?- person(Name, "uk",
> Year).`) and re-run `--dry-run`: the constant becomes a `WHERE`
> condition, `WHERE "country" = 'uk'`. Datamog keeps things `DISTINCT`
> by default because Datalog has set semantics: a tuple is either in
> the relation or it isn't; it can't be in it "twice".

> **Imperative lens.** In Python you'd write out the data as a list
> of tuples and then write a separate function for each question you
> care about:
>
> ```python
> people = [
>     ("ada_lovelace", "uk", 1815),
>     ("alan_turing",  "uk", 1912),
>     # ...
> ]
>
> def all_people():
>     return people
>
> def people_from(country):
>     return [p for p in people if p[1] == country]
>
> def people_born_in(year):
>     return [p for p in people if p[2] == year]
>
> def in_country_and_year(country, year):
>     return [p for p in people if p[1] == country and p[2] == year]
> ```
>
> Four questions, four functions, and if a fifth kind of query comes
> along you'll write a fifth function. The Datalog version is a single
> predicate you can ask any of these questions of, because a predicate
> is a *relation*, not a procedure: no column is the "input" and no
> column is the "output". Put a variable where you want an answer and a
> constant where you know the value; the same `person` predicate handles
> all combinations. You ask one question per run by editing the query;
> Chapter 2 introduces *named outputs* for reporting several at once.

## The playground shortcut

Everything in this chapter works identically in the
[playground][pg]. Paste the contents of `people-inline.dl` into
the editor, hit "Run", and you'll see the same output. The
playground also has a SQL pane that mirrors what `--dry-run`
prints on the CLI — useful when you want to see both at once.

If you're working through the tutorial, pick whichever environment
you prefer. Some exercises are easier in the playground (quick
tweaks); some are easier locally (you have a proper editor and
version control).

## Recap

- A Datalog program is a collection of **facts** (ground atoms)
  and a **query** (an atom with variables, prefixed with `?-`) whose
  answers are the program's default output.
- `input predicate` declares a typed predicate whose extent lives in
  a data file; inline facts work for small examples.
- Through the **logic lens**, predicates are relations and facts
  are atomic formulas; queries ask for the set of witnesses.
  Through the **SQL lens**, `input predicate` is a `CREATE TABLE` and
  a query is a `SELECT DISTINCT`. Through the **imperative lens**,
  each question that would be its own Python function is instead
  one query against the same predicate.

## Exercises

Each runnable exercise has a starter file under `code/ch01/exN-*.dl`
and a reference solution in `solutions/ch01/exN.dl` (or `.md` for
analytical exercises). Try it before looking at the solution.

### Exercise 1.1 — American scientists ★

Starter: [`code/ch01/ex1-americans.dl`](code/ch01/ex1-americans.dl)

Write a query that lists the name and birth year of every person
born in the US. The CSV already contains three of them.

### Exercise 1.2 — Who shares a birth year? ★

Starter: [`code/ch01/ex2-shared-year.dl`](code/ch01/ex2-shared-year.dl)

Two of the people in our CSV were born in 1934. Write a query that
lists the name and country of everyone born in that year.

### Exercise 1.3 — Extend the data ★★

Starter: [`code/ch01/ex3-extend.dl`](code/ch01/ex3-extend.dl)

This starter uses inline facts instead of a CSV. Add three more
computer scientists — any three you like, as long as each fact has
all three columns. Run the program and confirm your new rows show
up in the query output. Then change the query to ask about a
specific year of your choosing. (You don't have a `<` operator yet;
equality is all you have for now.)

### Exercise 1.4 — Read the SQL ★★

Using `--dry-run`, look at the SQL generated for this query:

```prolog
?- person(Name, "uk", 1934).
```

What does the `WHERE` clause look like, and why? Predict the answer
before you run it. (Hint: two constants in one atom means two
equality conditions.)

### Exercise 1.5 — Inline vs. CSV ★★★

Starter: [`code/ch01/ex5-roundtrip.dl`](code/ch01/ex5-roundtrip.dl)

Recreate `people-inline.dl` by reading the CSV file by hand and
pasting the facts as inline `person(...)` calls. Run both versions
of the program and confirm the queries return the same rows — order
may differ, but the *set* of answers should be identical. Why is the
order free to change? (We'll answer this one in Chapter 4, but
jot down your guess now.)

---

Next: **[Chapter 2 — Rules, variables, and joins](02-rules-and-joins.md).** Now
that we can state facts and ask questions, we'll give Datalog some
general principles to work with — and see how a rule with shared
variables is secretly a SQL join.

[pg]: https://xiemaisi.github.io/datamog/
