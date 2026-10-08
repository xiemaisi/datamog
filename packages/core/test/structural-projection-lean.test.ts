import { expect, test } from "bun:test";
import { parse } from "datamog-parser";
import { analyze } from "../src/analyzer.ts";
import { exportLeanStructuralProjection } from "../src/structural-projection-lean.ts";
import { inferTypes } from "../src/types.ts";
import { canonicalVerificationJson, verificationDigest } from "../src/verification-manifest.ts";
const compile = (source: string) => inferTypes(analyze(parse(source)));
const descriptor = { id: "Picked", predicate: "picked" };
const source = (
  shape = "{rows: [{n: integer, m: integer?}]}",
  term = 'V["rows"][0]["n"]',
  rules = "",
) => `input predicate items(v: ${shape}). picked(${term}) :- items(V). ${rules}`;
const exported = (program: string) => exportLeanStructuralProjection(compile(program), descriptor);

test("source projection produces an exact relation and bounded coverage claim", () => {
  const result = exported(source());
  expect(result.projections[0]!.path).toEqual(["rows", 0, "n"]);
  expect(result.projections[0]!.nullable).toBe(false);
  expect(result.source).toContain("inductive Picked");
  expect(result.source).toContain("input value → Datamog.Structural.lookupPath");
  expect(result.source).toContain("Datamog.Structural.ArrayBounds value");
  expect(result.source).toContain("∃ result, Picked input result ∧");
  expect(result.nodes.map((node) => node.id)).toEqual([
    "PickedSchema",
    "Picked",
    "Picked_coverage",
    "Picked_soundness",
  ]);
  expect(result.nodes[1]!.dependencies).toEqual(["PickedSchema"]);
  expect(result.checker).toContain("Generated.Picked_coverage := Proofs.Picked_coverage");
});
test("nullable leaves, literal dotted keys, and array roots preserve their meaning", () => {
  expect(exported(source(undefined, 'V["rows"][1]["m"]')).projections[0]!.nullable).toBe(true);
  expect(exported(source('{"a.b": integer}', 'V["a.b"]')).projections[0]!.path).toEqual(["a.b"]);
  expect(
    exported(source("[{n: integer}]", 'V[9007199254740991]["n"]')).projections[0]!.path,
  ).toEqual([9007199254740991, "n"]);
});
for (const program of [
  source("{rows?: [{n: integer}]}"),
  source("{rows: [{n: integer}]?}"),
  source("{rows: [{n: integer}?]}"),
  source("{rows: [{n?: integer}]}"),
  source(undefined, 'V["rows"][0]'),
  source(undefined, "V"),
  source(undefined, 'V["rows"][0+1]["n"]'),
  source(undefined, 'V["rows"][0]["n"]', 'picked(V["rows"][1]["n"]) :- items(V).'),
  'input predicate items(v: {n: integer}). inner(V) :- items(V). picked(V["n"]) :- inner(V).',
])
  test(`rejects unsupported projection: ${program}`, () =>
    expect(() => exported(program)).toThrow());

test("renamed input and changed literal paths invalidate projection identities", async () => {
  const variants = [
    source(),
    source(undefined, 'V["rows"][1]["n"]'),
    source(undefined, 'V["rows"][0]["m"]'),
    source().replaceAll("items", "renamed"),
  ];
  const hashes = await Promise.all(
    variants.map((program) =>
      verificationDigest(canonicalVerificationJson(exported(program).nodes)),
    ),
  );
  expect(new Set(hashes).size).toBe(variants.length);
});
test("invalid selectors and binder collisions fail before code generation", () => {
  for (const id of ["input", "value", "result", "result0", "i1", "bad\naxiom"])
    expect(() =>
      exportLeanStructuralProjection(compile(source()), { ...descriptor, id }),
    ).toThrow();
  expect(() =>
    exportLeanStructuralProjection(compile(source()), { ...descriptor, predicate: "items" }),
  ).toThrow();
  expect(() =>
    exportLeanStructuralProjection(compile(source()), { ...descriptor, predicate: "missing" }),
  ).toThrow();
});

test("soundness requires admission of all inputs, without lookup or bounds assumptions", () => {
  const result = exported(source());
  const goal = result.nodes.find((node) => node.id === "Picked_soundness")!;
  const statement = (goal.statement as { lean: string }).lean;
  expect(statement).toContain(
    "∀ value, input value → Datamog.Structural.accepts PickedSchema value = true",
  );
  expect(statement).toContain(
    "∀ result, Picked input result → Datamog.Structural.leafMatches false result = true",
  );
  expect(statement).not.toContain("ArrayBounds");
  expect(statement).not.toContain("lookupPath");
  expect(goal.dependencies).toEqual(["Picked"]);
  expect(result.checker).toContain("Generated.Picked_soundness := Proofs.Picked_soundness");
});

for (const shape of [
  "{rows?: [{n: integer}]}",
  "{rows: [{n: integer}]?}",
  "{rows: [{n: integer}?]}",
  "{rows: [{n?: integer}]}",
  "{rows?: [{n?: integer?}?]?}",
])
  test(`soundness-only supports partial path ${shape} without claiming coverage`, () => {
    const typed = compile(source(shape));
    const result = exportLeanStructuralProjection(typed, { ...descriptor, coverage: false });
    expect(result.nodes.map((node) => node.id)).toEqual([
      "PickedSchema",
      "Picked",
      "Picked_soundness",
    ]);
    expect(result.source).not.toContain("_coverage");
    expect(result.source).not.toContain("ArrayBounds");
    expect(result.projections[0]!.nullable).toBe(shape.includes("n?: integer?"));
    expect(() => exportLeanStructuralProjection(typed, descriptor)).toThrow("coverage requires");
    expect(() => exportLeanStructuralProjection(typed, { ...descriptor, coverage: true })).toThrow(
      "coverage requires",
    );
  });

test("soundness-only still rejects missing fields, wrong shapes, and container outputs", () => {
  for (const term of ['V["missing"]', 'V["rows"]["n"]', 'V["rows"][0]', 'V["rows"][0]["n"][0]'])
    expect(() =>
      exportLeanStructuralProjection(compile(source(undefined, term)), {
        ...descriptor,
        coverage: false,
      }),
    ).toThrow();
});

test("path flags and requested claim families invalidate manifest identities", async () => {
  const programs = [
    source("{rows: [{n: integer}]}"),
    source("{rows?: [{n: integer}]}"),
    source("{rows: [{n?: integer}]}"),
    source("{rows: [{n: integer?}]}"),
    source("{rows: [{n: integer}?]}"),
  ];
  const exports = programs.map((program) =>
    exportLeanStructuralProjection(compile(program), { ...descriptor, coverage: false }),
  );
  exports.push(exported(programs[0]!));
  const hashes = await Promise.all(
    exports.map((result) => verificationDigest(canonicalVerificationJson(result.nodes))),
  );
  expect(new Set(hashes).size).toBe(exports.length);
});

const dynamicSource = (term = 'V["rows"][I][J]["n"]', shape = "{rows: [[{n: integer}]]}") =>
  `input predicate items(v: ${shape}, i: integer, j: integer, spare: integer).
   picked(${term}) :- items(V, I, J, Spare).`;

test("dynamic indices retain signed bounds, input order, and unused columns", () => {
  const result = exported(dynamicSource());
  expect(result.projections[0]!.path).toEqual(["rows", { column: 1 }, { column: 2 }, "n"]);
  expect(result.indexColumns).toEqual([1, 2, 3]);
  expect(result.rootColumn).toBe(0);
  expect(result.source).toContain("input value i1 i2 i3 → 0 ≤ i1.val → 0 ≤ i2.val →");
  expect(result.source).toContain(".index i1.val.toNat, .index i2.val.toNat");
  expect(result.source).not.toContain("0 ≤ i3.val");
  expect(result.source).toContain("(i3 : Datamog.SafeInt)");
  const soundness = (
    result.nodes.find((node) => node.id === "Picked_soundness")!.statement as { lean: string }
  ).lean;
  expect(soundness).toContain("∀ value i1 i2 i3, input value i1 i2 i3 →");
  expect(soundness).not.toContain("0 ≤");
  expect(soundness).not.toContain("ArrayBounds");
});

test("reused indices share one guard and support mixed literal/dynamic paths", () => {
  const result = exported(dynamicSource('V["rows"][I][I]["n"]'));
  expect(result.source).toContain(
    "input value i1 i2 i3 → 0 ≤ i1.val → Datamog.Structural.lookupPath",
  );
  expect(result.source).not.toContain("0 ≤ i2.val");
  expect(exported(dynamicSource('V["rows"][1][J]["n"]')).projections[0]!.path).toEqual([
    "rows",
    1,
    { column: 2 },
    "n",
  ]);
});

test("structural input need not be the first column", () => {
  const result = exported(
    "input predicate items(i: integer, v: [integer], unused: integer). picked(V[I]) :- items(I,V,U).",
  );
  expect(result.rootColumn).toBe(1);
  expect(result.indexColumns).toEqual([0, 2]);
  expect(result.source).toContain("input i0 value i2 → 0 ≤ i0.val →");
  expect(result.source).toContain(
    "input : Datamog.SafeInt → Datamog.Structural.Value → Datamog.SafeInt → Prop",
  );
});

test("dynamic partial paths support soundness alone and retain coverage rejection", () => {
  const program = dynamicSource('V["rows"][I][J]["n"]', "{rows?: [[{n?: integer?}?]?]?}");
  const result = exportLeanStructuralProjection(compile(program), {
    ...descriptor,
    coverage: false,
  });
  expect(result.projections[0]!.nullable).toBe(true);
  expect(result.source).toContain("Picked_soundness");
  expect(result.source).not.toContain("Picked_coverage");
  expect(() => exported(program)).toThrow("coverage requires");
});

for (const program of [
  dynamicSource().replace("items(V, I, J, Spare)", "items(V, I, I, Spare)"),
  dynamicSource().replace("items(V, I, J, Spare)", "items(V, I, J, 0)"),
  dynamicSource().replace("spare: integer", "spare: string"),
  dynamicSource().replace("i: integer", "i: integer?"),
  dynamicSource().replace("i: integer", "i: float"),
  dynamicSource('V["rows"][I+1][J]["n"]'),
  dynamicSource('V["rows"][V][J]["n"]'),
])
  test(`rejects unsupported dynamic input: ${program}`, () =>
    expect(() => exported(program)).toThrow());

test("dynamic index column identities invalidate manifests", async () => {
  const variants = [
    dynamicSource(),
    dynamicSource('V["rows"][J][I]["n"]'),
    dynamicSource('V["rows"][I][I]["n"]'),
    dynamicSource()
      .replace("spare: integer", "extra: integer, spare: integer")
      .replace("J, Spare)", "J, Extra, Spare)"),
  ];
  const hashes = await Promise.all(
    variants.map((program) =>
      verificationDigest(canonicalVerificationJson(exported(program).nodes)),
    ),
  );
  expect(new Set(hashes).size).toBe(variants.length);
});

test("tuple projections share one row, preserve output order, and check every leaf", () => {
  const result = exported(source(undefined, 'V["rows"][0]["n"], V["rows"][1]["m"]'));
  expect(result.projections.map(({ path, nullable }) => ({ path, nullable }))).toEqual([
    { path: ["rows", 0, "n"], nullable: false },
    { path: ["rows", 1, "m"], nullable: true },
  ]);
  const relation = (result.nodes[1]!.statement as { lean: string }).lean;
  expect(relation.match(/input value →/g)).toHaveLength(1);
  expect(relation.match(/lookupPath value/g)).toHaveLength(2);
  expect(relation).toContain("= some result0 → Datamog.Structural.lookupPath value");
  expect(relation).toContain("= some result1 → Picked input result0 result1");
  const coverage = (
    result.nodes.find((node) => node.id === "Picked_coverage")!.statement as { lean: string }
  ).lean;
  expect(coverage.match(/ArrayBounds value/g)).toHaveLength(2);
  expect(coverage).not.toContain("lookupPath");
  expect(coverage).toContain(
    "∃ result0 result1, Picked input result0 result1 ∧ Datamog.Structural.leafMatches false result0 = true ∧ Datamog.Structural.leafMatches true result1 = true",
  );
  const soundness = (
    result.nodes.find((node) => node.id === "Picked_soundness")!.statement as { lean: string }
  ).lean;
  expect(soundness).toContain("∀ result0 result1, Picked input result0 result1 →");
  expect(soundness).not.toContain("ArrayBounds");
});

test("tuple guards cover the union of indices across outputs", () => {
  const result = exported(
    dynamicSource('V["rows"][I][0]["n"], V["rows"][J][I]["n"], V["rows"][I][0]["n"]'),
  );
  expect(result.projections).toHaveLength(3);
  expect(result.source).toContain("input value i1 i2 i3 → 0 ≤ i1.val → 0 ≤ i2.val →");
  expect(result.source).not.toContain("0 ≤ i3.val");
  expect(result.projections[0]!.path).toEqual(result.projections[2]!.path);
});

test("one optional output rejects tuple coverage but retains soundness of all columns", () => {
  const program = source(
    "{rows: [{n: integer, m?: integer?}]}",
    'V["rows"][0]["n"], V["rows"][0]["m"]',
  );
  expect(() => exported(program)).toThrow("every output");
  const result = exportLeanStructuralProjection(compile(program), {
    ...descriptor,
    coverage: false,
  });
  expect(result.projections.map((projection) => projection.nullable)).toEqual([false, true]);
  expect(result.nodes.map((node) => node.id)).toEqual([
    "PickedSchema",
    "Picked",
    "Picked_soundness",
  ]);
});

for (const program of [
  source(undefined, 'V["rows"][0]["n"], 1'),
  source(undefined, 'V["rows"][0]["n"], V["rows"]'),
  source(undefined, 'V["rows"][0]["n"], V["rows"][0]["n"] + 1'),
  'input predicate items(a: {n: integer}, b: {n: integer}). picked(A["n"], B["n"]) :- items(A,B).',
])
  test(`rejects unsupported tuple output: ${program}`, () =>
    expect(() => exported(program)).toThrow());

test("output arity, ordering, and repeated paths invalidate tuple identities", async () => {
  const terms = [
    'V["rows"][0]["n"]',
    'V["rows"][0]["n"], V["rows"][0]["m"]',
    'V["rows"][0]["m"], V["rows"][0]["n"]',
    'V["rows"][0]["n"], V["rows"][0]["n"]',
  ];
  const hashes = await Promise.all(
    terms.map((term) =>
      verificationDigest(canonicalVerificationJson(exported(source(undefined, term)).nodes)),
    ),
  );
  expect(new Set(hashes).size).toBe(terms.length);
});

test("carried identifiers retain input identity and add no sign or lookup bounds", () => {
  const result = exported(dynamicSource('Spare, V["rows"][I][J]["n"]'));
  expect(result.projections[0]).toMatchObject({ kind: "input", column: 3, nullable: false });
  expect(result.source).toContain("result0 = Datamog.Structural.Value.scalar (.integer i3) →");
  expect(result.source).not.toContain("0 ≤ i3.val");
  const coverage = (
    result.nodes.find((node) => node.id === "Picked_coverage")!.statement as { lean: string }
  ).lean;
  expect(coverage.match(/ArrayBounds value/g)).toHaveLength(1);
  expect(coverage).toContain("result0 = Datamog.Structural.Value.scalar (.integer i3)");
  expect(coverage).toContain("leafMatches false result0 = true");
});

test("carried index values and repeated identifiers preserve head ordering", () => {
  const result = exported(dynamicSource('I, V["rows"][I][J]["n"], Spare, I'));
  expect(
    result.projections.map((output) => (output.kind === "input" ? output.column : output.kind)),
  ).toEqual([1, "lookup", 3, 1]);
  expect(result.source).toContain("result3 = Datamog.Structural.Value.scalar (.integer i1)");
  expect(result.source).not.toContain("0 ≤ i3.val");
});

test("carrying integers supports non-first structural columns and optional lookup soundness", () => {
  const result = exportLeanStructuralProjection(
    compile(
      'input predicate items(id: integer, data: {n?: integer?}). picked(Id, R["n"]) :- items(Id,R).',
    ),
    { ...descriptor, coverage: false },
  );
  expect(result.rootColumn).toBe(1);
  expect(result.projections[0]).toMatchObject({ kind: "input", column: 0 });
  expect(result.projections[1]!.nullable).toBe(true);
  expect(result.source).not.toContain("_coverage");
});

for (const program of [
  dynamicSource("Spare"),
  dynamicSource('V, V["rows"][I][J]["n"]'),
  dynamicSource('Spare, V["rows"][I][J]["n"]').replace("spare: integer", "spare: integer?"),
  dynamicSource('Spare, V["rows"][I][J]["n"]').replace("spare: integer", "spare: string"),
])
  test(`rejects unsupported carried output: ${program}`, () =>
    expect(() => exported(program)).toThrow());

test("changing the carried input column invalidates statement identities", async () => {
  const variants = [
    'I, V["rows"][I][J]["n"]',
    'J, V["rows"][I][J]["n"]',
    'Spare, V["rows"][I][J]["n"]',
  ];
  const hashes = await Promise.all(
    variants.map((term) =>
      verificationDigest(canonicalVerificationJson(exported(dynamicSource(term)).nodes)),
    ),
  );
  expect(new Set(hashes).size).toBe(variants.length);
});

const filteredSource = (
  guard: string,
) => `input predicate items(v: {n: integer}, i: integer, j: integer).
picked(I, V["n"]) :- ${guard}, items(V, I, J).`;
for (const [operator, lean] of [
  ["<", "<"],
  ["<=", "≤"],
  [">", ">"],
  [">=", "≥"],
  ["=", "="],
  ["!=", "≠"],
  ["<>", "≠"],
])
  test(`projection exports integer filter ${operator}`, () => {
    const result = exported(filteredSource(`I ${operator} J`));
    expect(result.source).toContain(`(i1.val ${lean} i2.val) →`);
    const soundness = result.nodes.find((node) => node.id === "Picked_soundness")!;
    expect((soundness.statement as { lean: string }).lean).not.toContain(`i1.val ${lean}`);
  });
test("projection retains ordered literal filters and hashes their changes", async () => {
  const first = exported(filteredSource("I >= -1, J < 9007199254740991"));
  expect(first.source).toContain("(i1.val ≥ (-1 : Int)) → (i2.val < (9007199254740991 : Int)) →");
  expect(await verificationDigest(canonicalVerificationJson(first.nodes))).not.toBe(
    await verificationDigest(
      canonicalVerificationJson(exported(filteredSource("I >= 0, J < 9007199254740991")).nodes),
    ),
  );
});
for (const guard of ['V["n"] > 0', "I + 1 > J", "! (I < J)", "K = I", "I < 1.0"])
  test(`rejects unsupported projection filter ${guard}`, () =>
    expect(() => exported(filteredSource(guard))).toThrow());

test("integer disequality spellings export the same statement", () => {
  expect(exported(filteredSource("I != J")).nodes).toEqual(
    exported(filteredSource("I <> J")).nodes,
  );
  expect(exported(filteredSource("I != -9007199254740991")).source).toContain(
    "(i1.val ≠ (-9007199254740991 : Int)) →",
  );
});
test("disequality rejects nullable operands and missing bindings", () => {
  for (const guard of ["K != I", 'V["n"] != I', "I != null", "not I != J"])
    expect(() => exported(filteredSource(guard))).toThrow();
  expect(() => exported(filteredSource("I != J").replace("i: integer", "i: integer?"))).toThrow();
});

const lookupFiltered = (
  guard = 'as_integer(V["rows"][I]["n"]) > 0',
) => `input predicate items(v: {rows: [{n: integer, m: integer?}]}, i: integer).
picked(V["rows"][I]["n"]) :- items(V, I), ${guard}.`;
test("lookup comparison proves a value property without assuming lookup existence", () => {
  const result = exported(lookupFiltered());
  const coverage = (
    result.nodes.find((n) => n.id === "Picked_coverage")!.statement as { lean: string }
  ).lean;
  const soundness = (
    result.nodes.find((n) => n.id === "Picked_soundness")!.statement as { lean: string }
  ).lean;
  expect(coverage).toContain("∀ (n : Datamog.SafeInt), Datamog.Structural.lookupPath");
  expect(coverage).toContain("→ n.val > (0 : Int)");
  expect(soundness).toContain(
    "∃ (n : Datamog.SafeInt), result = Datamog.Structural.Value.scalar (.integer n) ∧ n.val > (0 : Int)",
  );
});
for (const guard of [
  'as_integer(V["rows"][I]["m"]) > 0',
  'V["rows"][0]["n"] > 0',
  'V["rows"][I]["n"] > I',
  '0 < V["rows"][I]["n"]',
  'V["rows"][I]["n"] + 1 > 0',
  'not V["rows"][I]["n"] > 0',
  'V["rows"][I]["n"] > 0, V["rows"][I]["n"] < 2',
])
  test(`rejects lookup filter outside the initial fragment: ${guard}`, () =>
    expect(() => exported(lookupFiltered(guard))).toThrow());

test("lookup filters reject unprojected paths and variable limits", () => {
  for (const guard of ['as_integer(V["rows"][0]["n"]) > 0', 'as_integer(V["rows"][I]["n"]) > I'])
    expect(() => exported(lookupFiltered(guard))).toThrow();
});

for (const [operator, lean] of [
  ["<", "<"],
  ["<=", "≤"],
  [">", ">"],
  [">=", "≥"],
  ["=", "="],
  ["!=", "≠"],
  ["<>", "≠"],
])
  test(`lookup comparison exports ${operator}`, () => {
    expect(
      exported(lookupFiltered(`as_integer(V["rows"][I]["n"]) ${operator} -1`)).source,
    ).toContain(`n.val ${lean} (-1 : Int)`);
  });
test("lookup filter rejects nullable leaves even when projected", () => {
  expect(() => exported(lookupFiltered().replaceAll('["n"]', '["m"]'))).toThrow(
    "non-null integer leaf",
  );
});
test("lookup comparison changes invalidate identity", async () => {
  const digest = (guard: string) =>
    verificationDigest(canonicalVerificationJson(exported(lookupFiltered(guard)).nodes));
  expect(await digest('as_integer(V["rows"][I]["n"]) > 0')).not.toBe(
    await digest('as_integer(V["rows"][I]["n"]) >= 0'),
  );
});

test("multiple lookup filters retain every comparison on the same witness", () => {
  const result = exported(
    lookupFiltered('as_integer(V["rows"][I]["n"]) > 0, as_integer(V["rows"][I]["n"]) <= 10'),
  );
  expect(result.source).toContain("∧ n.val > (0 : Int) ∧ n.val ≤ (10 : Int)");
  const coverage = (
    result.nodes.find((n) => n.id === "Picked_coverage")!.statement as { lean: string }
  ).lean;
  expect(coverage.match(/∀ \(n : Datamog.SafeInt\)/g)).toHaveLength(2);
});
test("contradictory lookup filters remain explicit", () => {
  const result = exported(
    lookupFiltered('as_integer(V["rows"][I]["n"]) > 0, as_integer(V["rows"][I]["n"]) <= 0'),
  );
  expect(result.source).toContain("∧ n.val > (0 : Int) ∧ n.val ≤ (0 : Int)");
});

test("lookup conjunction keeps independent witnesses for distinct projected paths", () => {
  const program = `input predicate items(v: {n: integer, m: integer}).
    picked(V["n"], V["m"]) :- items(V), as_integer(V["n"]) > 0, as_integer(V["m"]) > 0.`;
  const result = exported(program);
  expect(result.source).toContain(
    "result0 = Datamog.Structural.Value.scalar (.integer n) ∧ n.val > (0 : Int)",
  );
  expect(result.source).toContain(
    "result1 = Datamog.Structural.Value.scalar (.integer n) ∧ n.val > (0 : Int)",
  );
});
test("lookup conjunction preserves scalar input filters", () => {
  const result = exported(
    lookupFiltered(
      'I >= 0, as_integer(V["rows"][I]["n"]) > 0, as_integer(V["rows"][I]["n"]) <= 10',
    ),
  );
  expect(result.source).toContain("(i1.val ≥ (0 : Int)) →");
  expect(result.source).toContain("∧ n.val > (0 : Int) ∧ n.val ≤ (10 : Int)");
});

test("interleaved lookup comparisons stay attached to the correct output", () => {
  const program = `input predicate items(v: {n: integer, m: integer}).
    picked(V["n"], V["m"]) :- items(V), as_integer(V["m"]) > 0, as_integer(V["n"]) < 5, as_integer(V["m"]) <= 10.`;
  const result = exported(program);
  expect(result.source).toContain(
    "result1 = Datamog.Structural.Value.scalar (.integer n) ∧ n.val > (0 : Int) ∧ n.val ≤ (10 : Int)",
  );
  expect(result.source).toContain(
    "result0 = Datamog.Structural.Value.scalar (.integer n) ∧ n.val < (5 : Int)",
  );
});

const comparedLookups = (
  operator = "<=",
  right = 'as_integer(V["m"])',
) => `input predicate items(v: {n: integer, m: integer}).
  picked(V["n"], V["m"]) :- items(V), as_integer(V["n"]) ${operator} ${right}.`;
for (const [operator, lean] of [
  ["<", "<"],
  ["<=", "≤"],
  [">", ">"],
  [">=", "≥"],
  ["=", "="],
  ["!=", "≠"],
  ["<>", "≠"],
])
  test(`field comparison preserves ${operator} and operand identities`, () => {
    const result = exported(comparedLookups(operator));
    expect(result.source).toContain(
      `result0 = Datamog.Structural.Value.scalar (.integer n) ∧ result1 = Datamog.Structural.Value.scalar (.integer m) ∧ n.val ${lean} m.val`,
    );
    expect(result.source).toContain("∀ (n m : Datamog.SafeInt), Datamog.Structural.lookupPath");
  });
test("field comparison rejects nullable or unprojected right operands", () => {
  expect(() => exported(comparedLookups().replace("m: integer", "m: integer?"))).toThrow();
  expect(() =>
    exported(comparedLookups().replace('picked(V["n"], V["m"])', 'picked(V["n"])')),
  ).toThrow();
});

test("pair and literal premises retain source order and both value properties", () => {
  const result = exported(
    comparedLookups().replace(
      ' <= as_integer(V["m"]).',
      ' <= as_integer(V["m"]), as_integer(V["n"]) > 0.',
    ),
  );
  const coverage = (
    result.nodes.find((node) => node.id === "Picked_coverage")!.statement as { lean: string }
  ).lean;
  expect(coverage.indexOf("n.val ≤ m.val")).toBeLessThan(coverage.indexOf("n.val > (0 : Int)"));
  const soundness = (
    result.nodes.find((node) => node.id === "Picked_soundness")!.statement as { lean: string }
  ).lean;
  expect(soundness).toContain("n.val ≤ m.val");
  expect(soundness).toContain("n.val > (0 : Int)");
});
test("swapping field operands changes the exported identity", async () => {
  const first = exported(comparedLookups());
  const second = exported(
    comparedLookups().replace(
      'as_integer(V["n"]) <= as_integer(V["m"])',
      'as_integer(V["m"]) <= as_integer(V["n"])',
    ),
  );
  expect(await verificationDigest(canonicalVerificationJson(first.nodes))).not.toBe(
    await verificationDigest(canonicalVerificationJson(second.nodes)),
  );
});
