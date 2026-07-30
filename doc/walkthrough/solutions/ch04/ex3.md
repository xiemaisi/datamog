# Exercise 4.3 — Non-linear rejection

Uncommenting the rule

```prolog
tc(X, Z) :- tc(X, Y), tc(Y, Z).
```

and running the program under any SQL backend produces a Datamog
translator error:

```
Non-linear recursion is not supported by sqlite: predicate 'tc' has
rules with multiple recursive body atoms
```

(The backend name at the start depends on which SQL backend you ran
with — `sqlite`, `sqljs`, `postgres`. Every SQL backend
rejects non-linear recursion. The pure in-memory `native` and
`seminaive` backends, on the other hand, accept it and compute
the correct closure — they don't go through SQL, so the `WITH
RECURSIVE` limitation below doesn't apply to them.)

The long comment at
[`packages/cli/examples/transitive-closure/transitive-closure.dl`](../../../../packages/cli/examples/transitive-closure/transitive-closure.dl)
explains why: per SQL:1999, every reference to a recursive name
inside a `WITH RECURSIVE` step query resolves to the same "working
table" (roughly Δ, the rows produced in the previous iteration).
With one recursive reference — linear recursion — that's fine. With
two, both references see the same Δ, so derivations that need to
combine an *old* `tc` fact with a *new* one are silently missed.

The linear form `tc(X, Z) :- edge(X, Y), tc(Y, Z).` always works
because each iteration joins fresh `tc` rows against the full (and
non-recursive) `edge` relation.

Datamog rejects non-linear recursion at translation time so you
don't get wrong answers at runtime. The `SqlDialect` interface
exposes a `supportsNonLinearRecursion` flag, and every shipped SQL
dialect (Postgres, SQLite, sql.js) sets it to `false`
because each one's `WITH RECURSIVE` would silently drop rows on
chains longer than log(n). The pure in-memory backends bypass that
restriction by running a true seminaive iteration directly in TS,
which fires the rule once per recursive body position with the
right delta join.
