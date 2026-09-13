import { describe, expect, test } from "bun:test";
import { parseRawLenient } from "datamog-parser";
import {
  type Definition,
  type ModuleSelector,
  findDefinition,
  findModuleTarget,
  findTypeAliasDefinitions,
} from "../src/definitions.ts";

/** Definition of the name at the start of the `nth` occurrence of `needle`. */
function defAt(source: string, needle: string, nth = 0): Definition | undefined {
  let offset = -1;
  for (let i = 0; i <= nth; i++) offset = source.indexOf(needle, offset + 1);
  if (offset < 0) throw new Error(`no occurrence ${nth} of ${needle}`);
  return findDefinition(parseRawLenient(source), offset);
}

/** The source text each target span points at, for readable assertions. */
function targetsAt(source: string, needle: string, nth = 0): string[] {
  const def = defAt(source, needle, nth);
  if (def?.kind !== "local") throw new Error(`expected a local definition, got ${def?.kind}`);
  return def.targets.map((t) => source.slice(t.offset, t.end));
}

function originAt(source: string, needle: string, nth = 0): string | undefined {
  const def = defAt(source, needle, nth);
  return def && source.slice(def.origin.offset, def.origin.end);
}

describe("predicates", () => {
  test("a body atom resolves to its input predicate declaration", () => {
    const source = "input predicate edge(s: string, d: string).\nreach(X, Y) :- edge(X, Y).";
    expect(targetsAt(source, "edge", 1)).toEqual(["edge"]);
    expect(originAt(source, "edge", 1)).toBe("edge");
  });

  test("a body atom resolves to every rule that derives the predicate", () => {
    const source = [
      "input predicate edge(s: string, d: string).",
      "reach(X, Y) :- edge(X, Y).",
      "reach(X, Y) :- edge(X, Z), reach(Z, Y).",
      "?- reach(A, B).",
    ].join("\n");
    // Two rule heads, and the recursive body atom is a reference too.
    expect(targetsAt(source, "reach(A", 0)).toEqual(["reach", "reach"]);
  });

  test("a declaration and its rules both count as definitions", () => {
    const source = "input predicate p(x: integer).\np(1).\n?- p(X).";
    expect(targetsAt(source, "p(X)")).toEqual(["p", "p"]);
  });

  test("a rule head offers the predicate's other definitions but not itself", () => {
    const source = "r(1).\nr(2).\nr(3).";
    const def = defAt(source, "r(2)");
    expect(def?.kind).toBe("local");
    if (def?.kind !== "local") return;
    // Three rules, minus the one under the cursor.
    expect(def.targets.length).toBe(2);
    expect(def.targets.some((t) => t.offset === source.indexOf("r(2)"))).toBe(false);
  });

  test("an undefined predicate resolves to no targets rather than erroring", () => {
    const source = "q(X) :- nosuch(X).";
    expect(targetsAt(source, "nosuch")).toEqual([]);
  });

  test("built-in body atoms have no definition", () => {
    const source = "q(V) :- p(A), array_element(A, _, V).\ninput predicate p(a: value).";
    expect(defAt(source, "array_element")).toBeUndefined();
  });

  test("the predicate of a proof capture resolves, the captured variable does not", () => {
    const source = "num_list(0) :: Nil.\nq(V) :- V : num_list(_).";
    expect(targetsAt(source, "num_list", 1)).toEqual(["num_list"]);
    expect(defAt(source, "V : num_list")).toBeUndefined();
  });
});

describe("variables", () => {
  test("a use resolves to its binding occurrence in a positive atom", () => {
    const source = "input predicate edge(s: string, d: string).\nreach(X, Y) :- edge(X, Y).";
    // The X in the head binds from the X in the body atom.
    expect(targetsAt(source, "X")).toEqual(["X"]);
    const def = defAt(source, "X");
    if (def?.kind !== "local") throw new Error("expected local");
    expect(def.targets[0]?.offset).toBe(source.indexOf("edge(X", 20) + 5);
  });

  test("an equality's left side binds", () => {
    const source = "input predicate p(a: integer).\nq(D) :- p(A), D = A * 2.";
    expect(targetsAt(source, "D)")).toEqual(["D"]);
    const def = defAt(source, "D)");
    if (def?.kind !== "local") throw new Error("expected local");
    expect(def.targets[0]?.offset).toBe(source.indexOf("D ="));
  });

  test("a range atom's subject binds", () => {
    const source = "q(I) :- I in [0 .. 9].";
    const def = defAt(source, "I)");
    if (def?.kind !== "local") throw new Error("expected local");
    expect(def.targets[0]?.offset).toBe(source.indexOf("I in"));
  });

  test("a negated atom constrains but does not bind", () => {
    const source =
      "input predicate p(a: integer).\ninput predicate q(a: integer).\nr(X) :- p(X), not q(X).";
    // Only the positive p(X) occurrence, not the one under `not`.
    expect(targetsAt(source, "X)", 2)).toEqual(["X"]);
    const def = defAt(source, "X)", 2);
    if (def?.kind !== "local") throw new Error("expected local");
    expect(def.targets.length).toBe(1);
    expect(def.targets[0]?.offset).toBe(source.indexOf("p(X)") + 2);
  });

  test("variables are scoped to their own rule", () => {
    const source = ["input predicate p(a: integer).", "one(X) :- p(X).", "two(X) :- p(X)."].join(
      "\n",
    );
    const def = defAt(source, "two(X)");
    // The head X of rule two binds only from rule two's body.
    const varDef = defAt(source, "X) :- p(X).", 1);
    expect(def?.kind).toBe("local");
    if (varDef?.kind !== "local") throw new Error("expected local");
    expect(varDef.targets.length).toBe(1);
    expect(varDef.targets[0]?.offset).toBeGreaterThan(source.indexOf("two"));
  });

  test("a don't-care never resolves", () => {
    const source = "input predicate p(a: integer, b: integer).\nq(X) :- p(X, _).";
    expect(defAt(source, "_")).toBeUndefined();
  });

  test("an unsafe variable resolves to no binding rather than a bogus one", () => {
    const source = "q(X) :- X > 1.";
    expect(targetsAt(source, "X >")).toEqual([]);
  });

  test("a constructor pattern on an equality's right side binds", () => {
    const source = "output predicate present(V) :- P : opt, P = opt::Some(V).";
    const def = defAt(source, "V) :- P");
    if (def?.kind !== "local") throw new Error("expected local");
    expect(def.targets.map((t) => t.offset)).toEqual([source.indexOf("V).", 10)]);
  });

  test("a constructor pattern in a body atom binds what it destructures", () => {
    const source = "q(H) :- append(Cons(H, T), B, R).";
    const def = defAt(source, "H)");
    if (def?.kind !== "local") throw new Error("expected local");
    expect(def.targets.map((t) => t.offset)).toEqual([source.indexOf("H, T")]);
  });

  test("a head constructor pattern binds, a plain head argument does not", () => {
    const source = "append(Cons(H, T), B, Cons(H, R)) :- append(T, B, R).";
    const h = defAt(source, "H, R");
    if (h?.kind !== "local") throw new Error("expected local");
    // Both head occurrences are matches; B is a plain head argument bound by
    // the body atom, not by the head.
    expect(h.targets.map((t) => t.offset)).toEqual([
      source.indexOf("H, T"),
      source.indexOf("H, R"),
    ]);
    const b = defAt(source, "B, Cons");
    if (b?.kind !== "local") throw new Error("expected local");
    expect(b.targets.map((t) => t.offset)).toEqual([source.indexOf("B, R)")]);
  });

  test("an arithmetic argument uses a variable rather than binding it", () => {
    const source = "input predicate p(a: integer).\nq(X) :- p(X + 1).";
    expect(targetsAt(source, "X) :-")).toEqual([]);
  });

  test("a built-in call argument does not bind either", () => {
    const source = "input predicate p(a: value).\nq(V) :- p(as_string(V)).";
    expect(targetsAt(source, "V) :-")).toEqual([]);
  });
});

describe("constructors", () => {
  const source = [
    "num(1).",
    "num_list(0) :: Nil.",
    "num_list(n + 1) :: Cons :- num(Car), n <= 1, num_list(n).",
    "list_sum(Nil(), 0).",
    "list_sum(Cons(H, T), S + as_integer(H)) :- list_sum(T, S).",
  ].join("\n");

  test("a constructor term resolves to the rule that builds it", () => {
    expect(targetsAt(source, "Cons(H")).toEqual(["Cons"]);
    expect(originAt(source, "Cons(H")).toBe("Cons");
  });

  test("a nullary constructor term resolves too", () => {
    expect(targetsAt(source, "Nil()")).toEqual(["Nil"]);
  });

  test("a qualified constructor narrows to its predicate", () => {
    const shared = [
      "a(0) :: Leaf.",
      "b(0) :: Leaf.",
      "q(X) :- X = a::Leaf().",
      "r(X) :- X = Leaf().",
    ].join("\n");
    // Qualified picks one of the two same-named tags; bare offers both.
    expect(targetsAt(shared, "Leaf()", 0)).toEqual(["Leaf"]);
    expect(targetsAt(shared, "Leaf()", 1)).toEqual(["Leaf", "Leaf"]);
  });

  test("the qualifier itself resolves to the predicate", () => {
    const shared = "a(0) :: Leaf.\nq(X) :- X = a::Leaf().";
    expect(targetsAt(shared, "a::")).toEqual(["a"]);
    expect(originAt(shared, "a::")).toBe("a");
  });

  test("the `:: Ctor` marker is the definition, not a reference", () => {
    expect(defAt(source, ":: Cons")).toBeUndefined();
  });

  test("a built-in function is not mistaken for a constructor", () => {
    expect(defAt(source, "as_integer")).toBeUndefined();
  });

  test("an aggregate is not mistaken for a constructor", () => {
    const agg = "input predicate p(a: integer).\nq(sum(X)) :- p(X).";
    expect(defAt(agg, "sum")).toBeUndefined();
  });
});

describe("module bindings", () => {
  const source = [
    'input predicate dist(a: string, b: string) := shortest from "path.dl"(edge = link).',
    "input predicate link(a: string, b: string).",
    "q(X, Y) :- dist(X, Y).",
  ].join("\n");

  test("the module path resolves to the selected output", () => {
    const def = defAt(source, '"path.dl"');
    expect(def?.kind).toBe("module");
    if (def?.kind !== "module") return;
    expect(def.ref).toBe("path.dl");
    expect(def.select).toEqual({ what: "output", name: "shortest" });
  });

  test("the bound predicate name resolves into the module too", () => {
    const def = defAt(source, "dist");
    expect(def?.kind).toBe("module");
    if (def?.kind !== "module") return;
    expect(def.select).toEqual({ what: "output", name: "shortest" });
  });

  test("an omitted export selects the module's default output", () => {
    const dflt = 'input predicate d(a: string) := from "m.dl".';
    const def = defAt(dflt, '"m.dl"');
    if (def?.kind !== "module") throw new Error("expected module");
    expect(def.select).toEqual({ what: "default" });
  });

  test("an actual's parameter names an input of the imported module", () => {
    const def = defAt(source, "edge =");
    expect(def?.kind).toBe("module");
    if (def?.kind !== "module") return;
    expect(def.select).toEqual({ what: "input", name: "edge" });
    expect(def.ref).toBe("path.dl");
  });

  test("an actual's argument names a predicate in the importing file", () => {
    expect(targetsAt(source, "link)")).toEqual(["link"]);
  });

  test("a data-file binding resolves to the file", () => {
    const data = 'input predicate e(a: string) := "edges.csv".';
    const def = defAt(data, '"edges.csv"');
    expect(def?.kind).toBe("file");
    if (def?.kind !== "file") return;
    expect(def.ref).toBe("edges.csv");
  });

  test("a reference to a bound predicate still resolves locally", () => {
    // `dist` in the query body points at its declaration in this file; the
    // hop into the module is the second click, from the declaration.
    expect(targetsAt(source, "dist(X, Y)")).toEqual(["dist"]);
  });

  test("an unbound declaration's name has nowhere to go", () => {
    const plain = "input predicate p(a: string).";
    expect(defAt(plain, "p(a")).toBeUndefined();
  });

  test("a constructor of an imported module resolves under its export name", () => {
    // Elaboration renames the module's proof-carrying output to the importer's
    // name, so `int_opt::Some` here is `opt::Some` inside option.dl.
    const src = [
      'input predicate int_opt(o: value) := opt from "option.dl"(elem = n).',
      "q(V) :- P : int_opt, P = int_opt::Some(V).",
    ].join("\n");
    const def = defAt(src, "Some(V)");
    expect(def?.kind).toBe("module");
    if (def?.kind !== "module") return;
    expect(def.ref).toBe("option.dl");
    expect(def.select).toEqual({ what: "constructor", tag: "Some", predicate: "opt" });
  });

  test("a default-export constructor leaves the predicate unresolved", () => {
    const src = [
      'input predicate o(v: value) := from "option.dl".',
      "q(V) :- P : o, P = o::Some(V).",
    ].join("\n");
    const def = defAt(src, "Some(V)");
    if (def?.kind !== "module") throw new Error("expected module");
    expect(def.select).toEqual({ what: "constructor", tag: "Some", predicate: undefined });
  });

  test("a local constructor wins over an import of the same qualifier", () => {
    const src = [
      'input predicate p(v: value) := out from "m.dl".',
      "p(0) :: Local.",
      "q(V) :- X = p::Local(V).",
    ].join("\n");
    expect(targetsAt(src, "Local(V)")).toEqual(["Local"]);
  });
});

describe("findModuleTarget", () => {
  const module = [
    "input predicate edge(a: string, b: string).",
    "output predicate shortest(X, Y) :- edge(X, Y).",
    "reach(X, Y) :- edge(X, Y).",
    "?- reach(A, B).",
  ].join("\n");

  const target = (select: ModuleSelector) => {
    const span = findModuleTarget(parseRawLenient(module), select);
    return span && module.slice(span.offset, span.end);
  };

  test("selects a named output predicate", () => {
    expect(target({ what: "output", name: "shortest" })).toBe("shortest");
  });

  test("a non-output rule is not selectable as an output", () => {
    expect(target({ what: "output", name: "reach" })).toBeUndefined();
  });

  test("selects an input predicate", () => {
    expect(target({ what: "input", name: "edge" })).toBe("edge");
  });

  test("the default output is the module's query", () => {
    expect(target({ what: "default" })).toBe("?- reach(A, B).");
  });

  test("selects a constructor by tag and predicate", () => {
    const adt = ["output predicate opt() :: None.", "output predicate opt() :: Some :- e(V)."].join(
      "\n",
    );
    const span = findModuleTarget(parseRawLenient(adt), {
      what: "constructor",
      tag: "Some",
      predicate: "opt",
    });
    expect(span && adt.slice(span.offset, span.end)).toBe("Some");
  });

  test("a constructor selector with no predicate matches on the tag alone", () => {
    const adt = "output predicate opt() :: None.";
    const span = findModuleTarget(parseRawLenient(adt), { what: "constructor", tag: "None" });
    expect(span && adt.slice(span.offset, span.end)).toBe("None");
  });
});

describe("robustness", () => {
  test("navigation survives a syntax error elsewhere in the buffer", () => {
    const source = "input predicate p(a: integer).\nq(X) :- p(X).\nbroken(((";
    expect(targetsAt(source, "p(X)")).toEqual(["p"]);
  });

  test("an offset in whitespace resolves to nothing", () => {
    const source = "input predicate p(a: integer).\n\nq(X) :- p(X).";
    expect(findDefinition(parseRawLenient(source), source.indexOf("\n\n") + 1)).toBeUndefined();
  });

  test("a keyword is not a name", () => {
    const source = "input predicate p(a: integer).";
    expect(defAt(source, "input")).toBeUndefined();
  });

  test("a string literal is not a name", () => {
    const source = 'q(X) :- X = "edge".';
    expect(defAt(source, '"edge"')).toBeUndefined();
  });
});

describe("type aliases", () => {
  test("input columns, nested aliases and lifted heads link to their own definitions", () => {
    const source =
      "type Age = integer. type Person = {age: Age}. input predicate p(x: Person). q(X: Person) :- p(X).";
    expect(targetsAt(source, "Age", 1)).toEqual(["Age"]);
    expect(targetsAt(source, "Person", 1)).toEqual(["Person"]);
    expect(targetsAt(source, "Person", 2)).toEqual(["Person"]);
    expect(originAt(source, "Person", 2)).toBe("Person");
    expect(defAt(source, "Age")).toBeUndefined();
  });

  test("forward and quoted references use the original spelling and span", () => {
    const source = "type Person = {age: Age}. type `Age` = integer. input predicate p(x: `Age`).";
    expect(targetsAt(source, "Age")).toEqual(["`Age`"]);
    expect(targetsAt(source, "`Age`", 1)).toEqual(["`Age`"]);
    expect(originAt(source, "`Age`", 1)).toBe("`Age`");
  });

  test("navigation survives failed expansion and stays in the alias namespace", () => {
    const source =
      "type Broken = Unknown. type Age = integer. Age(1). input predicate p(x: Age). q(X: Age) :- Age(X).";
    expect(targetsAt(source, "Age", 2)).toEqual(["Age"]);
    expect(defAt(source, "Age", 2)?.targets[0]?.offset).toBe(source.indexOf("Age"));
    expect(targetsAt(source, "Age", 3)).toEqual(["Age"]);
    expect(targetsAt(source, "Age", 4)).toEqual(["Age"]);
    expect(defAt(source, "Age", 4)?.targets[0]?.offset).toBe(source.indexOf("Age(1)"));
    expect(targetsAt(source, "Unknown")).toEqual([]);
  });

  test("recursive aliases remain navigable while invalid", () => {
    const source = "type A = [B]. type B = {next?: A}.";
    expect(targetsAt(source, "B")).toEqual(["B"]);
    expect(targetsAt(source, "A", 1)).toEqual(["A"]);
  });

  test("Boolean refinements are not mistaken for alias references", () => {
    const source = "q(_: B) :- B = true.";
    expect(findTypeAliasDefinitions(parseRawLenient(source))).toEqual([]);
  });
});

test("constructor payload annotations navigate aliases and expression bindings", () => {
  const source = "type Amount = float. input predicate n(x: integer). p() :: C(X: Amount) :- n(X).";
  expect(targetsAt(source, "Amount", 1)).toEqual(["Amount"]);
  expect(targetsAt(source, "X")).toEqual(["X"]);
  const broken = "type Bad = Missing. type Amount = float. p() :: C(3: Amount).";
  expect(targetsAt(broken, "Amount", 1)).toEqual(["Amount"]);
});
