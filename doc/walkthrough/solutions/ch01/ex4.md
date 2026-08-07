# Exercise 1.4 — Read the SQL

The query

```prolog
?- person(Name, "uk", 1934).
```

compiles to a SQL statement along the lines of:

```sql
SELECT DISTINCT "name" AS "Name"
FROM "person"
WHERE "country" = 'uk' AND "year_born" = 1934;
```

Two constants in the atom turn into two equality conditions in the
`WHERE` clause, joined with `AND`. Only the variable `Name` appears
in the select list, because only `Name` was left free in the query.

(The exact layout Datamog prints may differ slightly — whitespace,
quoting — but the shape is as above.)

## Why this matters

This is the simplest case of a general principle we will see a lot:
every constant occurrence in a query becomes an equality condition in
the generated SQL, and every variable that appears in the query head
becomes a column in the `SELECT` list. Chapter 2 extends this rule to
**joins**, where a single variable appears in *two* body atoms.
