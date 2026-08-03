/**
 * A golden snapshot of what the analyzer says about a corpus of programs.
 *
 * Its job is the cases nobody wrote a test for. The other test files pin the
 * diagnostics their authors thought about; this one pins the whole surface, so
 * a refactor that quietly changes a message or flips an accept/reject shows up
 * as a diff instead of going unnoticed. It exists because the binding logic of
 * a rule body is re-derived in five places (see
 * `doc/design/typing-and-safety-constraints.md` §8), and collapsing that
 * duplication needs a net wider than the hand-written assertions.
 *
 * For each program it records either the inferred column types or the exact
 * error, message and source span. Both halves matter: a refactor can preserve
 * every verdict and still change an inferred type.
 *
 * Regenerate by deleting `diagnostics-snapshot.json` and re-running, the same
 * convention as the examples suite's `expected.json`. **Read the diff before
 * you do.** A changed entry is either a bug you just introduced or an
 * improvement worth mentioning in the commit message; regenerating without
 * looking throws away the only signal this file provides.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { inferTypes } from "../src/types.ts";

const SNAPSHOT_PATH = join(import.meta.dir, "diagnostics-snapshot.json");
const EXAMPLES_DIR = join(import.meta.dir, "../../cli/examples");

/** What the pipeline said about one program. */
type Outcome =
  | { ok: true; types: Record<string, (string | null)[]> }
  | { ok: false; error: string; message: string; span?: [number, number] };

function outcomeOf(source: string): Outcome {
  try {
    const typed = inferTypes(analyze(parse(source)));
    const types: Record<string, (string | null)[]> = {};
    for (const [pred, cols] of [...typed.columnTypes].sort(([a], [b]) => a.localeCompare(b))) {
      types[pred] = cols.map((c) => c ?? null);
    }
    return { ok: true, types };
  } catch (e) {
    const err = e as { name?: string; message?: string; offset?: number; end?: number };
    const outcome: Outcome = {
      ok: false,
      error: err.name ?? (e as object).constructor.name,
      message: err.message ?? String(e),
    };
    if (typeof err.offset === "number" && typeof err.end === "number") {
      outcome.span = [err.offset, err.end];
    }
    return outcome;
  }
}

// --- Generated corpus --------------------------------------------------------
//
// Each shape is instantiated with each operand kind. The cross product is what
// makes the harness catch what hand-written tests miss: the interesting bugs
// this session all lived in a (shape, operand) cell nobody had thought to
// write down, `X in [1 .. N]` with an untyped `N` being one of them.

/** `t` is the typed source; `U` is never declared; `null` is untyped. */
const PRELUDE = "input predicate t(x: integer).\n";

const OPERANDS: Record<string, string> = {
  // Ground in the shapes whose body contains `t(A)`, unbound in the rest.
  // Both are worth recording, and which is which is visible in the program.
  varA: "A",
  unbound: "U",
  null: "null",
  int: "1",
  float: "1.5",
  string: '"s"',
  bool: "true",
};

const SHAPES: Record<string, (e: string) => string> = {
  "eq-lhs": (e) => `q(X) :- X = ${e}.`,
  "eq-rhs": (e) => `q(X) :- ${e} = X.`,
  "eq-arith": (e) => `q(X) :- X = ${e} + 1.`,
  "eq-ground": (e) => `q(X) :- t(A), X = A, A = ${e}.`,
  "range-hi": (e) => `q(X) :- X in [1 .. ${e}].`,
  "range-lo": (e) => `q(X) :- X in [${e} .. 10].`,
  "range-filter": (e) => `q(X) :- t(A), X = A, A in [1 .. ${e}].`,
  filter: (e) => `q(X) :- t(A), X = A, A < ${e}.`,
  "atom-arg": (e) => `q(X) :- t(A), X = A, t(${e}).`,
  negated: (e) => `q(X) :- t(A), X = A, not t(${e}).`,
  subscript: (e) => `q(X) :- X = ${e}[0].`,
  slice: (e) => `q(X) :- X = ${e}[0:1].`,
  cast: (e) => `q(X) :- X = as_integer(${e}).`,
  "iter-source": (e) => `q(X) :- object_entry(${e}, K, X).`,
  "head-arg": (e) => `q(${e}).`,
  "head-arith": (e) => `q(X) :- t(A), X = A + ${e}.`,
  aggregate: (e) => `q(A, sum(B)) :- t(A), B = ${e}.`,
};

function generatedCorpus(): Record<string, string> {
  const corpus: Record<string, string> = {};
  for (const [shapeName, shape] of Object.entries(SHAPES)) {
    for (const [operandName, operand] of Object.entries(OPERANDS)) {
      corpus[`${shapeName}/${operandName}`] = `${PRELUDE}${shape(operand)}\n?- q(X).\n`;
    }
  }
  return corpus;
}

// --- Curated corpus ---------------------------------------------------------
//
// Cases with a specific history, or that the cross product cannot express.
// Each is here because it was once wrong, or because it is the boundary
// between two rules.

const CURATED: Record<string, string> = {
  // The three untyped-null defects fixed in this area, and their neighbours.
  "null-binds-nothing": "q(X) :- X = null.\n?- q(X).\n",
  "null-sibling-rule": "q(1).\nq(X) :- X = null.\n?- q(X).\n",
  "null-head-arg-sibling": "q(1).\nq(null).\n?- q(X).\n",
  "null-filter-on-ground": "q(X) :- X = 1 / 0.\nr(X) :- q(X), X = null.\n?- r(X).\n",
  "null-range-bound": "q(X) :- N = null, X in [1 .. N].\n?- q(X).\n",
  "null-range-literal-bound": "q(X) :- X in [1 .. null].\n?- q(X).\n",
  "null-typed-integer": "q(X) :- X = as_integer(null).\n?- q(X).\n",
  "null-typed-value": 'q(X) :- X = parse_json("null").\n?- q(X).\n',
  "null-arith-typed": "q(X) :- X = null + 0.\n?- q(X).\n",

  // A binding range must enumerate integers; a filter range need not. Which a
  // range is depends on whether something else grounds the variable, and two
  // constructs used to be miscounted as grounding it, which let a float-bounded
  // binding range through to a backend that could not enumerate it.
  "range-float-masked-by-self-equality": "q(X) :- X in [1.5 .. 2.5], X = X.\n?- q(X).\n",
  "range-float-masked-by-later-range": "q(X) :- X in [1.5 .. 2.5], X in [1 .. 3].\n?- q(X).\n",
  "range-integer-binder-then-float-filter": "q(X) :- X in [1 .. 3], X in [1.5 .. 2.5].\n?- q(X).\n",
  "range-float-filter-on-atom-bound": "p(1). p(2).\nq(X) :- p(X), X in [1.5 .. 2.5].\n?- q(X).\n",
  "self-equality-grounds-nothing": "q(X) :- X = X.\n?- q(X).\n",
  "self-referential-equality-grounds-nothing": "q(X) :- X = X + 1.\n?- q(X).\n",

  // Blame order: both a body variable and a head variable are unsafe.
  "unsafe-head-only": "input predicate b(x: integer).\nq(X, Y) :- b(X).\n?- q(X, Y).\n",
  "unsafe-via-equality": "q(X, Y) :- Y = X + 1.\n?- q(X, Y).\n",
  "unsafe-via-negation": "r(1).\nq(X, Y) :- r(X), not r(Y).\n?- q(X, Y).\n",
  "unsafe-via-filter": "input predicate b(x: integer).\nq(X) :- b(X), Y > 10.\n?- q(X).\n",

  // Uninhabited by the three routes §6 distinguishes.
  "conflict-across-atoms":
    "input predicate p(x: integer).\ninput predicate s(x: string).\nq(X) :- p(X), s(X).\n?- q(X).\n",
  "conflict-in-equality": 'q(X) :- X = 1, X = "hello".\n?- q(X).\n',
  "no-contribution-recursive": "s(X) :- s(Y), X = Y + 1.\n?- s(X).\n",
  "no-contribution-tautology": "s(X) :- s(X).\n?- s(X).\n",
  "recursive-only-but-typed": "b(1).\ns(X) :- s(X), b(X).\n?- s(X).\n",

  // Widening and narrowing across the lattice.
  "sibling-widen-to-value": 'q(1).\nq("a").\n?- q(X).\n',
  "meet-integer-value":
    "input predicate p(x: integer).\ninput predicate v(x: value).\nq(X) :- p(X), v(X).\n?- q(X).\n",
  "float-into-integer-column": "input predicate p(x: integer).\nq(Y) :- Y = 1.5, p(Y).\n?- q(Y).\n",
  "unannotated-defaults-string": "input predicate p(x).\nq(X) :- p(X).\n?- q(X).\n",
  "unannotated-used-numerically": "input predicate p(x).\nq(Y) :- p(X), Y = X * 2.\n?- q(Y).\n",

  // Head annotations: widening allowed, narrowing not.
  "annotation-widens": "input predicate p(x: integer).\nq(X: value) :- p(X).\n?- q(X).\n",
  "annotation-narrows": "input predicate p(x: value).\nq(X: integer) :- p(X).\n?- q(X).\n",
  "annotation-published-to-consumer":
    "input predicate b(x: integer).\np(X: value) :- b(X).\nk(K) :- p(P), K = P + 1.\n?- k(K).\n",
  "annotation-own-recursion-sees-inferred":
    "input predicate b(x: integer).\np(X: value) :- b(X).\np(X) :- p(Y), X = Y + 1, Y < 3.\n?- p(X).\n",

  // Recursion, negation, aggregates.
  "stratified-negation":
    'input predicate n(x: string).\ninput predicate e(a: string, b: string).\nr(X) :- e("s", X).\nr(X) :- e(Y, X), r(Y).\nu(X) :- n(X), not r(X).\n?- u(X).\n',
  "unstratifiable-negation":
    "input predicate b(x: string).\nf(X) :- b(X), not g(X).\ng(X) :- b(X), not f(X).\n?- f(X).\n",
  "aggregate-grouped":
    "input predicate s(n: string, v: integer).\nq(N, sum(V)) :- s(N, V).\n?- q(N, T).\n",
  "aggregate-count-star": "input predicate s(n: string).\nq(count(*)) :- s(_).\n?- q(C).\n",
  "aggregate-recursive":
    "input predicate s(v: integer).\nq(sum(V)) :- s(V).\nq(sum(V)) :- q(V).\n?- q(T).\n",

  // Arity and shape errors, to pin their messages too.
  "arity-mismatch-rules":
    'input predicate p(a: string, b: string).\nr(X, Y) :- p(X, Y).\nr(X) :- p(X, "a").\n?- r(X).\n',
  "edb-and-idb": "input predicate p(x: string).\np(X) :- p(X).\n?- p(X).\n",
  "undefined-predicate": "q(X) :- nope(X).\n?- q(X).\n",
  "filter-not-boolean": "input predicate p(x: integer).\nq(X) :- p(X), X + 1.\n?- q(X).\n",
  "bitwise-on-float": "input predicate p(x: float).\nq(Y) :- p(X), Y = X & 1.\n?- q(Y).\n",
  "order-on-value": "input predicate v(x: value).\nq(X) :- v(X), X < 5.\n?- q(X).\n",
  "negative-subscript": 'q(Y) :- Y = "abc"[-1].\n?- q(Y).\n',
};

// --- Example programs -------------------------------------------------------
//
// The examples suite pins their *results* on every backend; this pins their
// inferred types, which is a different property and would catch an inference
// regression that leaves results unchanged. Programs using `:=` need a module
// resolver, which this harness deliberately does not have, so they are skipped
// rather than recorded as a resolver error.

function exampleCorpus(): Record<string, string> {
  const corpus: Record<string, string> = {};
  if (!existsSync(EXAMPLES_DIR)) return corpus;

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(path));
      else if (entry.name.endsWith(".dl")) out.push(path);
    }
    return out;
  };

  for (const path of walk(EXAMPLES_DIR).sort()) {
    const text = readFileSync(path, "utf8");
    if (text.includes(":=")) continue;
    corpus[`example/${path.slice(EXAMPLES_DIR.length + 1)}`] = text;
  }
  return corpus;
}

// --- The snapshot -----------------------------------------------------------

describe("diagnostics snapshot", () => {
  test("the analyzer's verdict on the corpus is unchanged", async () => {
    const corpus = { ...generatedCorpus(), ...CURATED, ...exampleCorpus() };
    const actual: Record<string, Outcome> = {};
    for (const name of Object.keys(corpus).sort()) {
      actual[name] = outcomeOf(corpus[name]!);
    }

    const file = Bun.file(SNAPSHOT_PATH);
    if (!(await file.exists())) {
      await Bun.write(SNAPSHOT_PATH, `${JSON.stringify(actual, null, 2)}\n`);
      console.log(`Generated ${SNAPSHOT_PATH} with ${Object.keys(actual).length} entries`);
      return;
    }

    const expected = (await file.json()) as Record<string, Outcome>;

    // Report every difference at once, keyed by program, rather than letting a
    // whole-object comparison bury them in one enormous diff. Added and
    // removed entries are listed separately: those are corpus edits, which are
    // fine, while a *changed* entry is a behaviour change and is the thing
    // this test exists to surface.
    const changed: string[] = [];
    for (const name of Object.keys(expected)) {
      if (!(name in actual)) continue;
      const before = JSON.stringify(expected[name]);
      const after = JSON.stringify(actual[name]);
      if (before !== after) {
        changed.push(
          `${name}\n  program: ${JSON.stringify(corpus[name])}\n  before:  ${before}\n  after:   ${after}`,
        );
      }
    }

    if (changed.length > 0) {
      throw new Error(
        `${changed.length} program(s) changed verdict.\n\n${changed.join("\n\n")}\n
Each of these is either a bug you just introduced or an improvement worth naming
in the commit message. If they are intended, delete
packages/core/test/diagnostics-snapshot.json and re-run to regenerate.`,
      );
    }

    const added = Object.keys(actual).filter((n) => !(n in expected));
    const removed = Object.keys(expected).filter((n) => !(n in actual));
    expect({ added, removed }).toEqual({ added: [], removed: [] });
  });
});
