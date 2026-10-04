import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkProject,
  exportProject,
  inspectProject,
  parseSelection,
  planProject,
} from "../../../scripts/lean-project.ts";

async function fixture(run: (config: string, output: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "datamog-project-test-"));
  try {
    const config = join(dir, "plan.json");
    await Bun.write(
      join(dir, "source.dl"),
      'input predicate items(v: {n: integer}). picked(V["n"]) :- items(V).',
    );
    await Bun.write(
      config,
      JSON.stringify({ source: "source.dl", projections: [{ id: "Picked", predicate: "picked" }] }),
    );
    await run(config, join(dir, "project"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("selection rejects unknown fields, empty goals and invalid descriptors", () => {
  for (const selection of [
    {},
    { source: "x", projections: [] },
    { source: "x", projections: [{ id: "X", predicate: "x", coverage: "false" }] },
    { source: "x", projections: [{ id: "X", predicate: "x", typo: true }] },
    { source: "x", projections: [], typo: true },
  ])
    expect(() => parseSelection(selection)).toThrow();
});
test("export is reproducible and preserves proofs while invalidating old reports", async () =>
  fixture(async (config, output) => {
    const first = await exportProject(config, output);
    expect(first.goals).toEqual(["Picked_coverage", "Picked_soundness"]);
    expect((await exportProject(config, output)).manifest).toEqual(first.manifest);
    const proof = "-- maintained proof content\n";
    await Bun.write(join(output, "Datamog/Proofs.lean"), proof);
    await Bun.write(join(output, "verification-result.json"), "stale success");
    const next = await exportProject(config, output);
    expect(await Bun.file(join(output, "Datamog/Proofs.lean")).text()).toBe(proof);
    expect(next.manifest.digest).not.toBe(first.manifest.digest);
    expect(await Bun.file(join(output, "verification-result.json")).exists()).toBe(false);
  }));
test("check rejects altered generated files before invoking Lean and removes old reports", async () =>
  fixture(async (config, output) => {
    await exportProject(config, output);
    await Bun.write(join(output, "Datamog/Generated.lean"), "altered");
    await Bun.write(join(output, "verification-result.json"), "old report");
    await expect(checkProject(config, output)).rejects.toThrow("Stale or altered");
    expect(await Bun.file(join(output, "verification-result.json")).exists()).toBe(false);
  }));
test("source edits invalidate a project; required definitions cannot satisfy goal requests", async () =>
  fixture(async (config, output, dir) => {
    await exportProject(config, output);
    await expect(checkProject(config, output, ["PickedSchema"])).rejects.toThrow("Unknown");
    await Bun.write(
      join(dir, "source.dl"),
      'input predicate items(v: {n: integer, m: integer}). picked(V["m"]) :- items(V).',
    );
    await expect(checkProject(config, output)).rejects.toThrow("Stale or altered");
  }));
test("duplicate identities and bound sources fail without output mutation", async () =>
  fixture(async (config, output, dir) => {
    const selection = {
      source: "source.dl",
      projections: [
        { id: "Picked", predicate: "picked" },
        { id: "Picked", predicate: "picked" },
      ],
    };
    await Bun.write(config, JSON.stringify(selection));
    await expect(exportProject(config, output)).rejects.toThrow("Duplicate");
    expect(await Bun.file(join(output, "manifest.json")).exists()).toBe(false);
    await Bun.write(
      join(dir, "source.dl"),
      'input predicate items(v: {n: integer}) := "input.jsonl". picked(V["n"]) :- items(V).',
    );
    await expect(planProject(config, output)).rejects.toThrow("entry-file checks only");
  }));
test("export refuses unrelated directories and symlinked managed files", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(join(output, "unrelated.txt"), "keep");
    await expect(exportProject(config, output)).rejects.toThrow("empty");
    await rm(output, { recursive: true });
    await exportProject(config, output);
    const target = join(dir, "target");
    await Bun.write(target, "keep");
    await rm(join(output, "Datamog/Generated.lean"));
    await symlink(target, join(output, "Datamog/Generated.lean"));
    await expect(exportProject(config, output)).rejects.toThrow("regular");
    expect(await Bun.file(target).text()).toBe("keep");
  }));

const integerClaims = [
  {
    kind: "coverage",
    id: "SuccessorCoverage",
    predicate: "succ",
    relationName: "Successor",
    inputPredicate: "sample",
    outputToInput: [0, null],
    bounds: [{ column: 0, op: "<", value: 9007199254740991 }],
  },
  {
    kind: "coverage",
    id: "SuccessorTotal",
    predicate: "succ",
    relationName: "Successor",
    inputPredicate: "sample",
    outputToInput: [0, null],
    bounds: [],
    polarity: "refute",
  },
];
test("selected integer claims share definitions and register exact refutation signatures", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate sample(n: integer). succ(X, X + 1) :- sample(X).",
    );
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims: integerClaims }));
    const plan = await exportProject(config, output);
    expect(plan.goals).toEqual(["SuccessorCoverage", "SuccessorTotal_refuted"]);
    expect(plan.files["Datamog/Generated.lean"]!.match(/inductive Successor /g)).toHaveLength(1);
    expect(plan.files["Datamog/Proofs.lean"]).toContain(
      "SuccessorTotal_refuted : ¬ Generated.SuccessorTotal",
    );
    await expect(checkProject(config, output, ["SuccessorTotal"])).rejects.toThrow("Unknown");
  }));
test("claim descriptors reject unknown kinds, fields, and malformed bounds", () => {
  for (const claim of [
    { ...integerClaims[0], kind: "equivalence" },
    { ...integerClaims[0], polarity: "skip" },
    { ...integerClaims[0], bounds: [null] },
    { ...integerClaims[0], bounds: [{ column: 0, op: "<", value: "10" }] },
    { ...integerClaims[0], outputToInput: "all" },
    { ...integerClaims[0], typo: true },
  ])
    expect(() => parseSelection({ source: "x", claims: [claim] })).toThrow();
});

test("mixed projections and integer claims export together and reject shared names", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      `${await Bun.file(join(dir, "source.dl")).text()}\ninput predicate sample(n: integer). identity(X, X) :- sample(X).`,
    );
    const selection = {
      source: "source.dl",
      projections: [{ id: "Picked", predicate: "picked" }],
      claims: [
        {
          kind: "uniqueness",
          id: "uniqueIdentity",
          predicate: "identity",
          relationName: "Identity",
          keyColumns: [0],
          outputColumns: [1],
        },
      ],
    };
    await Bun.write(config, JSON.stringify(selection));
    const plan = await exportProject(config, output);
    expect(plan.goals).toEqual(["Picked_coverage", "Picked_soundness", "uniqueIdentity"]);
    expect(plan.manifest.context.profile).toBe("datamog-integer-v1+datamog-structural-integer-v1");
    selection.claims[0]!.relationName = "Picked";
    await Bun.write(config, JSON.stringify(selection));
    await expect(exportProject(config, output)).rejects.toThrow("Duplicate");
  }));

test("local selections bind exact obligations and register refutations separately", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate sample(n: integer). bad(X, _: X > 0, _: X >= 0) :- sample(X).",
    );
    const claim = {
      kind: "local",
      id: "localGoal",
      predicate: "bad",
      rule: 1,
      refinement: 2,
      polarity: "refute",
    };
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims: [claim] }));
    const plan = await exportProject(config, output);
    expect(plan.goals).toEqual(["localGoal_refuted"]);
    expect(plan.files["Datamog/Proofs.lean"]).toContain("¬ Generated.localGoal");
    expect(JSON.stringify(plan.manifest)).toContain("head-refinement");
    await expect(checkProject(config, output, ["localGoal"])).rejects.toThrow("Unknown");
    await Bun.write(
      config,
      JSON.stringify({ source: "source.dl", claims: [{ ...claim, refinement: 1 }] }),
    );
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    for (const refinement of [0, -1, 1.5])
      expect(() =>
        parseSelection({ source: "source.dl", claims: [{ ...claim, refinement }] }),
      ).toThrow();
    await Bun.write(
      config,
      JSON.stringify({ source: "source.dl", claims: [{ ...claim, refinement: 3 }] }),
    );
    await expect(planProject(config, output)).rejects.toThrow("No local obligation");
  }));

test("local goals reject unresolved contract dependencies and unsupported statements", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "local", id: "goal", predicate: "result", rule: 1, refinement: 1 }],
      }),
    );
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate sample(n: integer). positive(X, _: X > 0) :- sample(X). result(X, _: X > 0) :- positive(X).",
    );
    await expect(exportProject(config, output)).rejects.toThrow("contract dependencies");
    expect(await Bun.file(join(output, "manifest.json")).exists()).toBe(false);
    await Bun.write(
      join(dir, "source.dl"),
      'input predicate sample(n: string). result(X, _: X = "ok") :- sample(X).',
    );
    await expect(exportProject(config, output)).rejects.toThrow();
    expect(await Bun.file(join(output, "manifest.json")).exists()).toBe(false);
  }));

test("local contract closure requires every defining proof and rejects cycles", async () =>
  fixture(async (config, output, dir) => {
    const select = (predicate: string, rule = 1) => ({
      kind: "local",
      id: `${predicate}${rule}`,
      predicate,
      rule,
      refinement: 1,
    });
    const source =
      "input predicate sample(n: integer). positive(X, _: X > 0) :- sample(X), X > 0. positive(X, _: X > 0) :- sample(X), X > 1. forwarded(X, _: X > 0) :- positive(X). result(X, _: X >= 0) :- forwarded(X).";
    await Bun.write(join(dir, "source.dl"), source);
    const claims = [
      select("result"),
      select("forwarded"),
      select("positive"),
      select("positive", 2),
    ];
    const write = (selected: unknown[]) =>
      Bun.write(config, JSON.stringify({ source: "source.dl", claims: selected }));
    await write(claims);
    const plan = await planProject(config, output);
    expect(plan.manifest.entries.find((entry) => entry.id === "result1")!.closure).toEqual([
      "IntegerSemantics",
      "forwarded1",
      "positive1",
      "positive2",
      "result1",
    ]);
    for (const incomplete of [
      claims.slice(0, 3),
      [claims[0], ...claims.slice(2)],
      [...claims.slice(0, 3), { ...claims[3], polarity: "refute" }],
    ]) {
      await write(incomplete);
      await expect(exportProject(config, output)).rejects.toThrow("require selected proofs");
    }
    await write([...claims, { ...claims[2], id: "alias" }]);
    await expect(exportProject(config, output)).rejects.toThrow("Duplicate local obligation");
    for (const recursive of [
      "input predicate sample(n: integer). loop(X, _: X > 0) :- sample(X), X > 0. loop(X, _: X > 0) :- loop(X).",
      "input predicate sample(n: integer). loop(X, _: X > 0) :- sample(X), X > 0. loop(X, _: X > 0) :- other(X). other(X, _: X > 0) :- loop(X).",
    ]) {
      await Bun.write(join(dir, "source.dl"), recursive);
      await write([
        select("loop"),
        select("loop", 2),
        ...(recursive.includes("other") ? [select("other")] : []),
      ]);
      await expect(exportProject(config, output)).rejects.toThrow("Recursive local contract");
    }
    expect(await Bun.file(join(output, "manifest.json")).exists()).toBe(false);
  }));

test("recursive invariant exports actual constructors and the sibling-disjunction contract", async () =>
  fixture(async (config, output, dir) => {
    const claim = { kind: "invariant", id: "growSafe", predicate: "grow", relationName: "Grow" };
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims: [claim] }));
    const write = (source: string) =>
      Bun.write(join(dir, "source.dl"), `input predicate sample(n: integer). ${source}`);
    await write("grow(X, _: X > 0) :- sample(X), X > 0. grow(X + 1 as Y, _: Y > 1) :- grow(X).");
    const plan = await planProject(config, output);
    const generated = plan.files["Datamog/Generated.lean"]!;
    expect(generated).toContain("inductive Grow");
    expect(generated).toContain(
      "(Grow input0 v0) → (w0.val = v0.val + (1 : Int)) → Grow input0 w0",
    );
    expect(generated).toContain("((x0.val > (0 : Int))) ∨ ((x0.val > (1 : Int)))");
    expect(plan.goals).toEqual(["growSafe"]);
    expect(plan.manifest.entries.find((entry) => entry.id === "growSafe")!.closure).toEqual([
      "Grow",
      "IntegerSemantics",
      "growSafe",
    ]);
    for (const source of [
      "grow(X) :- sample(X). grow(X, _: X > 0) :- grow(X).",
      "grow(X, _: X > 0) :- other(X). other(X) :- grow(X).",
      "grow(X, _: X + 1 > 0) :- sample(X).",
      "grow(X, _: X > 0) :- sample(X). !- grow(X), X < 0.",
    ]) {
      await write(source);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    expect(() =>
      parseSelection({ source: "x", claims: [{ ...claim, polarity: "unknown" }] }),
    ).toThrow();
    expect(() => parseSelection({ source: "x", claims: [{ ...claim, rule: 1 }] })).toThrow();
    expect(await Bun.file(join(output, "manifest.json")).exists()).toBe(false);
  }));

test("mutual invariant requires a complete unary component and binds every member", async () =>
  fixture(async (config, output, dir) => {
    const claim = { kind: "mutual-invariant", id: "bothSafe", predicates: ["left", "right"] };
    const writePlan = (predicates: string[]) =>
      Bun.write(
        config,
        JSON.stringify({ source: "source.dl", claims: [{ ...claim, predicates }] }),
      );
    const source =
      "input predicate seed(n: integer). left(X, _: X > 0) :- seed(X), X > 0. left(X, _: X > 0) :- right(X). right(X, _: X > 0) :- left(X).";
    await Bun.write(join(dir, "source.dl"), source);
    await writePlan(claim.predicates);
    const plan = await planProject(config, output);
    expect(plan.goals).toEqual(["bothSafe"]);
    expect(plan.files["Datamog/Generated.lean"]).toContain("Nat → Datamog.SafeInt → Prop");
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "bothSafeFamily input0 1 v0) → bothSafeFamily input0 0 v0",
    );
    expect(plan.manifest.entries.find((e) => e.id === "bothSafe")!.closure).toEqual([
      "IntegerSemantics",
      "bothSafe",
      "bothSafeFamily",
    ]);
    for (const predicates of [["left"], ["left", "left"], ["left", "absent"]]) {
      await writePlan(predicates);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await writePlan(claim.predicates);
    for (const changed of [
      source.replace("right(X, _: X > 0) :- left(X)", "right(X, _: X > 0) :- seed(X)"),
      source.replace("right(X, _: X > 0) :- left(X)", "right(X * 2 as Y, _: Y > 0) :- left(X)"),
      `${source}!- left(X), X < 0.`,
      source.replace("right(X, _: X > 0)", "right(X)"),
      source.replace("seed(n: integer)", "seed(n: integer?)"),
      source.replace("left(X).", "left(X), not seed(X)."),
    ]) {
      await Bun.write(join(dir, "source.dl"), changed);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    expect(() =>
      parseSelection({ source: "x", claims: [{ ...claim, polarity: "unknown" }] }),
    ).toThrow();
    expect(await Bun.file(join(output, "manifest.json")).exists()).toBe(false);
  }));

test("mutual computed heads require a bounded output witness", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "mutual-invariant", id: "bothSafe", predicates: ["left", "right"] }],
      }),
    );
    const source = (head: string) =>
      `input predicate seed(n: integer). left(X, _: X > 0) :- seed(X), X > 0. left(X, _: X > 0) :- right(X). right(${head} as Y, _: Y > 1) :- left(X).`;
    await Bun.write(join(dir, "source.dl"), source("X + 1"));
    const plan = await planProject(config, output);
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "(w0 : Datamog.SafeInt) : (bothSafeFamily input0 0 v0) → (w0.val = v0.val + (1 : Int)) → bothSafeFamily input0 1 w0",
    );
    await Bun.write(join(dir, "source.dl"), source("X + 0"));
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    for (const head of ["X * 2", "X + 0.5", "X + X", "1 + X", "(X + 1) + 1"]) {
      await Bun.write(join(dir, "source.dl"), source(head));
      await expect(exportProject(config, output)).rejects.toThrow();
    }
  }));

test("mutual tuples preserve column order and independent computed witnesses", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "mutual-invariant", id: "bothSafe", predicates: ["left", "right"] }],
      }),
    );
    const source =
      "input predicate seed(x: integer, y: integer). left(X, Y, _: Y > X) :- seed(X, Y), Y > X. left(X, Y, _: Y > X) :- right(X, Y). right(X + 1 as A, Y + 1 as B, _: B > A) :- left(X, Y).";
    await Bun.write(join(dir, "source.dl"), source);
    const plan = await planProject(config, output);
    const generated = plan.files["Datamog/Generated.lean"]!;
    expect(generated).toContain("Nat → Datamog.SafeInt → Datamog.SafeInt → Prop");
    expect(generated).toContain(
      "(w0.val = v0.val + (1 : Int)) → (w1.val = v1.val + (1 : Int)) → bothSafeFamily input0 1 w0 w1",
    );
    expect(generated).toContain("bothSafeFamily input0 1 x0 x1 → (((x1.val > x0.val)))");
    await Bun.write(
      join(dir, "source.dl"),
      source.replace("X + 1 as A, Y + 1 as B", "Y + 1 as A, X + 1 as B"),
    );
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate seed(x: integer, y: integer). left(X, Y, _: Y > X) :- seed(X, Y). left(X, X, _: X > 0) :- right(X). right(X, _: X > 0) :- left(X, Y).",
    );
    expect((await planProject(config, output)).files["Datamog/Generated.lean"]).toContain(
      "bothSafeFamily input0 1 x0 (⟨0, by decide⟩ : Datamog.SafeInt)",
    );
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate seed(x: integer). left(X, X, _: X > 0) :- seed(X). left(X, Y, _: Y > X) :- right(X, Y). right(X, Y, _: Y > X) :- left(X, Y).",
    );
    expect((await planProject(config, output)).files["Datamog/Generated.lean"]).toContain(
      "input0 : Datamog.SafeInt → Prop",
    );
  }));

test("mixed family padding is fixed and inputs keep their own arities", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "mutual-invariant", id: "bothSafe", predicates: ["left", "right"] }],
      }),
    );
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate seed(a: integer, b: integer, c: integer, d: integer). left(X, _: X > 0) :- seed(X, Y, Z, W), X > 0. left(Z, _: Z > 0) :- right(X, Y, Z). right(X, X, X, _: X > 0) :- left(X).",
    );
    const plan = await planProject(config, output);
    const generated = plan.files["Datamog/Generated.lean"]!;
    expect(generated).toContain(
      "input0 : Datamog.SafeInt → Datamog.SafeInt → Datamog.SafeInt → Datamog.SafeInt → Prop",
    );
    expect(generated).toContain("(input0 v0 v1 v2 v3)");
    expect(generated).toContain(
      "bothSafeFamily input0 0 x0 (⟨0, by decide⟩ : Datamog.SafeInt) (⟨0, by decide⟩ : Datamog.SafeInt)",
    );
    expect(generated).toContain("bothSafeFamily input0 1 v0 v0 v0");
    const family = plan.manifest.entries.find((entry) => entry.id === "bothSafeFamily")!;
    expect(family.statement).toMatchObject({
      memberArities: [1, 3],
      width: 3,
      padding: "bounded-zero",
      inputs: [{ predicate: "seed", index: 0, arity: 4 }],
    });
  }));

test("nullary mutual members have no phantom quantified output", async () =>
  fixture(async (config, output, dir) => {
    const planPath = "verification/lean/examples/selected-mutual-flags/plan.json";
    const original = JSON.parse(await Bun.file(planPath).text());
    await Bun.write(config, JSON.stringify({ ...original, source: "source.dl" }));
    await Bun.write(
      join(dir, "source.dl"),
      await Bun.file("verification/lean/examples/selected-mutual-flags/program.dl").text(),
    );
    const plan = await planProject(config, output);
    expect(plan.goals).toEqual(["flagsSafe", "emptySafe"]);
    const generated = plan.files["Datamog/Generated.lean"]!;
    expect(generated).toContain("inductive emptySafeFamily  : Nat → Prop");
    expect(generated).not.toContain("∀ ,");
    expect(generated.split("def emptySafe")[1]).not.toContain("SafeInt");
    expect(plan.manifest.entries.find((e) => e.id === "emptySafeFamily")!.statement).toMatchObject({
      memberArities: [0, 0],
      width: 0,
      inputs: [],
    });
    expect(plan.manifest.entries.find((e) => e.id === "flagsSafeFamily")!.statement).toMatchObject({
      memberArities: [0, 1],
      width: 1,
    });
  }));

test("mutual subtraction preserves the operator and bounded witness", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "mutual-invariant", id: "bothSafe", predicates: ["left", "right"] }],
      }),
    );
    const source = await Bun.file(
      "verification/lean/examples/selected-mutual-descent/program.dl",
    ).text();
    await Bun.write(join(dir, "source.dl"), source);
    const plan = await planProject(config, output);
    expect(plan.files["Datamog/Generated.lean"]).toContain("(w0 : Datamog.SafeInt)");
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "(w0.val = v0.val - (1 : Int)) → bothSafeFamily input0 1 w0",
    );
    for (const replacement of ["X - 0", "X - 9007199254740991", "X + 1"]) {
      await Bun.write(join(dir, "source.dl"), source.replace("X - 1", replacement));
      expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    }
    for (const replacement of ["X - X", "X - 0.5", "1 - X", "(X - 1) - 1"]) {
      await Bun.write(join(dir, "source.dl"), source.replace("X - 1", replacement));
      await expect(exportProject(config, output)).rejects.toThrow();
    }
  }));

test("mutual refutations register only the exact negative theorem", async () =>
  fixture(async (config, output, dir) => {
    const source = await Bun.file(
      "verification/lean/examples/selected-mutual-refutation/program.dl",
    ).text();
    await Bun.write(join(dir, "source.dl"), source);
    const claim = {
      kind: "mutual-invariant",
      id: "bothSafe",
      predicates: ["left", "right"],
      polarity: "refute",
    };
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims: [claim] }));
    const plan = await exportProject(config, output);
    expect(plan.goals).toEqual(["bothSafe_refuted"]);
    expect(plan.files["Datamog/Proofs.lean"]).toContain(
      "theorem bothSafe_refuted : ¬ Generated.bothSafe := by ...",
    );
    expect(plan.manifest.entries.find((e) => e.id === "bothSafe")!.kind).toBe("definition");
    expect(plan.manifest.entries.find((e) => e.id === "bothSafe_refuted")!.closure).toEqual([
      "IntegerSemantics",
      "bothSafe",
      "bothSafeFamily",
      "bothSafe_refuted",
    ]);
    await expect(checkProject(config, output, ["bothSafe"])).rejects.toThrow("Unknown");
    await Bun.write(
      config,
      JSON.stringify({ source: "source.dl", claims: [{ ...claim, polarity: "prove" }] }),
    );
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [claim, { ...claim, id: "bothSafe_refuted", polarity: "prove" }],
      }),
    );
    await expect(exportProject(config, output)).rejects.toThrow("Duplicate verification identity");
  }));

test("single-relation invariant refutations preserve polarity and reject name collisions", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      await Bun.file("verification/lean/examples/selected-recursive-refutation/program.dl").text(),
    );
    const claim = {
      kind: "invariant",
      id: "growSafe",
      predicate: "grow",
      relationName: "Grow",
      polarity: "refute",
    };
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims: [claim] }));
    const plan = await exportProject(config, output);
    expect(plan.goals).toEqual(["growSafe_refuted"]);
    expect(plan.files["Datamog/Proofs.lean"]).toContain(
      "theorem growSafe_refuted : ¬ Generated.growSafe := by ...",
    );
    expect(plan.manifest.entries.find((e) => e.id === "growSafe")!.kind).toBe("definition");
    await expect(checkProject(config, output, ["growSafe"])).rejects.toThrow("Unknown");
    await Bun.write(
      config,
      JSON.stringify({ source: "source.dl", claims: [{ ...claim, polarity: "prove" }] }),
    );
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ ...claim, relationName: "growSafe_refuted" }],
      }),
    );
    await expect(exportProject(config, output)).rejects.toThrow("Conflicting invariant proof name");
  }));

test("invariant junctions retain nesting and reject unsupported leaves", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "invariant", id: "safe", predicate: "p", relationName: "P" }],
      }),
    );
    const source = (formula: string) =>
      `input predicate seed(n: integer). p(X, _: ${formula}, _: X <= 3) :- seed(X). p(X, _: X = 4) :- p(X).`;
    await Bun.write(join(dir, "source.dl"), source("X = 0 || (X > 0 && X <= 3)"));
    const plan = await planProject(config, output);
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "(((x0.val = (0 : Int)) ∨ ((x0.val > (0 : Int)) ∧ (x0.val ≤ (3 : Int)))) ∧ (x0.val ≤ (3 : Int))) ∨ ((x0.val = (4 : Int)))",
    );
    await Bun.write(join(dir, "source.dl"), source("X = 0 && (X > 0 || X <= 3)"));
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    for (const formula of ["X = 0 || X + 1 > 0", "X = 0 || X > 0.5", "!(X + 1 = 0)"]) {
      await Bun.write(join(dir, "source.dl"), source(formula));
      await expect(exportProject(config, output)).rejects.toThrow();
    }
  }));

test("invariant negation preserves nesting and rejects partial or nullable leaves", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "invariant", id: "safe", predicate: "p", relationName: "P" }],
      }),
    );
    const source = (formula: string, type = "integer") =>
      `input predicate seed(n: ${type}). p(X, _: ${formula}) :- seed(X).`;
    await Bun.write(join(dir, "source.dl"), source("!!(X >= 0 && !(X > 3))"));
    const plan = await planProject(config, output);
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "(¬ (¬ ((x0.val ≥ (0 : Int)) ∧ (¬ (x0.val > (3 : Int))))))",
    );
    await Bun.write(join(dir, "source.dl"), source("!(X >= 0 && !(X > 3))"));
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    for (const text of [
      source("!(X + 1 > 0)"),
      source("!(X / 0 = 0)"),
      source("!(X < 0 || X > 3)", "integer?"),
    ]) {
      await Bun.write(join(dir, "source.dl"), text);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
  }));

test("project evidence preserves exact source and selection text with manifest identities", async () =>
  fixture(async (config, output, dir) => {
    const source = await Bun.file(join(dir, "source.dl")).text();
    const selection = await Bun.file(config).text();
    const plan = await planProject(config, output);
    expect(plan.sourceSnapshot).toEqual({
      path: "source.dl",
      text: source,
      digest: plan.manifest.context.artifacts.source,
    });
    expect(plan.selectionSnapshot).toEqual({
      text: selection,
      digest: plan.manifest.context.artifacts.selection,
    });
    await Bun.write(join(dir, "source.dl"), `${source}\n\n`);
    const changed = await planProject(config, output);
    expect(changed.sourceSnapshot.text).toBe(`${source}\n\n`);
    expect(changed.sourceSnapshot.digest).not.toBe(plan.sourceSnapshot.digest);
    expect(changed.selectionSnapshot).toEqual(plan.selectionSnapshot);
  }));

test("inspection previews exact goals without creating files or invoking Lean", async () =>
  fixture(async (config, output) => {
    const child = Bun.spawn(
      [process.execPath, "scripts/lean-project.ts", "inspect", config, output],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: "" } },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const preview = JSON.parse(stdout);
    expect(preview.purpose).toBe("inspection-only");
    expect(preview.goals.map((g: { id: string }) => g.id)).toEqual([
      "Picked_coverage",
      "Picked_soundness",
    ]);
    expect(preview.generated.checker).toContain(
      "theorem Picked_coverage : Generated.Picked_coverage := Proofs.Picked_coverage",
    );
    expect(
      preview.goals.every(
        (g: Record<string, unknown>) => g.status === undefined && g.assurance === undefined,
      ),
    ).toBe(true);
    await expect(readdir(output)).rejects.toThrow();
  }));

test("inspection leaves maintained files and reports untouched and exposes refutations", async () =>
  fixture(async (config, output, dir) => {
    const claim = {
      kind: "invariant",
      id: "growSafe",
      predicate: "grow",
      relationName: "Grow",
      polarity: "refute",
    };
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims: [claim] }));
    await Bun.write(
      join(dir, "source.dl"),
      await Bun.file("verification/lean/examples/selected-recursive-refutation/program.dl").text(),
    );
    await exportProject(config, output);
    const before = await Bun.file(join(output, "manifest.json")).text();
    await Bun.write(join(output, "Datamog/Proofs.lean"), "-- user work\n");
    await Bun.write(join(output, "verification-result.json"), "previous report\n");
    await Bun.write(join(output, "Datamog/Generated.lean"), "stale generated file\n");
    const preview = await inspectProject(config, output);
    expect(preview.goals.map((g) => g.id)).toEqual(["growSafe_refuted"]);
    expect(preview.generated.checker).toContain("theorem growSafe_refuted : ¬ Generated.growSafe");
    expect(preview.generated.definitions).toContain("inductive Grow");
    expect(preview.goals[0]!.closure).toEqual([
      "Grow",
      "IntegerSemantics",
      "growSafe",
      "growSafe_refuted",
    ]);
    expect(await Bun.file(join(output, "manifest.json")).text()).toBe(before);
    expect(await Bun.file(join(output, "Datamog/Proofs.lean")).text()).toBe("-- user work\n");
    expect(await Bun.file(join(output, "verification-result.json")).text()).toBe(
      "previous report\n",
    );
    expect(await Bun.file(join(output, "Datamog/Generated.lean")).text()).toBe(
      "stale generated file\n",
    );
  }));

test("program invariants close over unrefined helpers and multiple recursive components", async () =>
  fixture(async (config, output, dir) => {
    const source = await Bun.file(
      "verification/lean/examples/selected-program-invariant/program.dl",
    ).text();
    const claim = { kind: "program-invariant", id: "pipelineSafe", predicates: ["output"] };
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims: [claim] }));
    await Bun.write(join(dir, "source.dl"), source);
    const plan = await planProject(config, output);
    const goal = plan.manifest.entries.find((e) => e.id === "pipelineSafe")!;
    expect(goal.closure).toEqual([
      "IntegerSemantics",
      "pipelineSafe",
      "pipelineSafeFamily",
      ...[0, 1, 2, 3, 4].map((i) => `pipelineSafeRules${i}`),
    ]);
    const family = plan.manifest.entries.find((e) => e.id === "pipelineSafeFamily")!;
    expect(family.statement).toMatchObject({
      predicates: ["output", "left", "forwarded", "right", "validated"],
      selectedPredicates: ["output"],
      components: [["output"], ["left", "right"], ["forwarded"], ["validated"]],
      inputs: [{ predicate: "seed", index: 0, arity: 1 }],
    });
    expect(plan.manifest.entries.find((e) => e.id === "pipelineSafeRules1")!.dependencies).toEqual([
      "pipelineSafeRules2",
      "pipelineSafeRules3",
    ]);
    expect(plan.manifest.entries.find((e) => e.id === "pipelineSafeRules3")!.dependencies).toEqual([
      "pipelineSafeRules1",
    ]);
    expect(plan.manifest.entries.every((e) => e.assumptions.length === 0)).toBe(true);
    expect((await inspectProject(config, output)).goals[0]!.closure).toEqual(goal.closure);
    for (const changed of [
      source.replace(", X > 0.", "."),
      `${source}\nvalidated(X) :- seed(X).`,
    ]) {
      await Bun.write(join(dir, "source.dl"), changed);
      const next = await planProject(config, output);
      expect(next.manifest.entries.find((e) => e.id === "pipelineSafe")!.digest).not.toBe(
        goal.digest,
      );
      expect(next.files["Datamog/Generated.lean"]).not.toBe(plan.files["Datamog/Generated.lean"]);
    }
    await Bun.write(join(dir, "source.dl"), source);
    await Bun.write(
      config,
      JSON.stringify({ source: "source.dl", claims: [{ ...claim, polarity: "refute" }] }),
    );
    const refutation = await planProject(config, output);
    expect(refutation.goals).toEqual(["pipelineSafe_refuted"]);
    expect(refutation.files["Datamog/Checked.lean"]).toContain(
      "theorem pipelineSafe_refuted : ¬ Generated.pipelineSafe",
    );
  }));

test("program invariants reject unsupported upstream rules and invalid root selections", async () =>
  fixture(async (config, output, dir) => {
    const source = await Bun.file(
      "verification/lean/examples/selected-program-invariant/program.dl",
    ).text();
    const writePlan = (predicates: string[]) =>
      Bun.write(
        config,
        JSON.stringify({
          source: "source.dl",
          claims: [{ kind: "program-invariant", id: "pipelineSafe", predicates }],
        }),
      );
    await Bun.write(join(dir, "source.dl"), source);
    for (const roots of [[], ["output", "output"], ["missing"], ["seed"], ["validated"]]) {
      await writePlan(roots);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await writePlan(["output"]);
    for (const changed of [
      source.replace("validated(X) :- seed(X), X > 0", "validated(X * 2) :- seed(X), X > 0"),
      source.replace("forwarded(X) :- validated(X)", "forwarded(X) :- seed(X), not validated(X)"),
      source.replace("seed(n: integer)", "seed(n: integer?)"),
    ]) {
      await Bun.write(join(dir, "source.dl"), changed);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await expect(readdir(output)).rejects.toThrow();
  }));

test("program uniqueness varies every non-key column and binds upstream definitions", async () =>
  fixture(async (config, output, dir) => {
    const source =
      "input predicate seed(a: integer, b: integer, c: integer). helper(X,Y,Z) :- seed(X,Y,Z). result(X,Y,Z) :- helper(X,Y,Z).";
    const claim = {
      kind: "program-uniqueness",
      id: "unique",
      predicate: "result",
      keyColumns: [0],
      outputColumns: [1],
    };
    const writePlan = (change: object = {}) =>
      Bun.write(config, JSON.stringify({ source: "source.dl", claims: [{ ...claim, ...change }] }));
    await Bun.write(join(dir, "source.dl"), source);
    await writePlan();
    const plan = await planProject(config, output);
    const generated = plan.files["Datamog/Generated.lean"]!;
    expect(generated).toContain(
      "uniqueFamily input0 0 x0 x1 x2 → uniqueFamily input0 0 x0 y1 y2 → (x1 = y1)",
    );
    expect(plan.manifest.entries.find((e) => e.id === "unique")!.closure).toEqual([
      "IntegerSemantics",
      "unique",
      "uniqueFamily",
      "uniqueRules0",
      "uniqueRules1",
    ]);
    await writePlan({ keyColumns: [], outputColumns: [0, 2] });
    const global = await planProject(config, output);
    expect(global.files["Datamog/Generated.lean"]).toContain(
      "uniqueFamily input0 0 x0 x1 x2 → uniqueFamily input0 0 y0 y1 y2 → (x0 = y0 ∧ x2 = y2)",
    );
    expect(global.manifest.digest).not.toBe(plan.manifest.digest);
    await writePlan({ polarity: "refute" });
    const refutation = await planProject(config, output);
    expect(refutation.goals).toEqual(["unique_refuted"]);
    expect(refutation.files["Datamog/Checked.lean"]).toContain(
      "theorem unique_refuted : ¬ Generated.unique",
    );
    for (const change of [
      { outputColumns: [] },
      { keyColumns: [0, 0] },
      { outputColumns: [1, 1] },
      { outputColumns: [0] },
      { outputColumns: [3] },
      { keyColumns: [-1] },
      { keyColumns: [0.5] },
      { predicate: "missing" },
      { predicate: "seed" },
      { outputColumns: "1" },
      { outputColumns: ["1"] },
      { polarity: "unknown" },
      { typo: true },
    ]) {
      await writePlan(change);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await expect(readdir(output)).rejects.toThrow();
  }));

test("composed uniqueness pads tuples to helper width without quantifying padding", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate seed(a: integer, b: integer, c: integer). helper(X,Y,Z) :- seed(X,Y,Z). result(X,Y) :- helper(X,Y,Z).",
    );
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [
          {
            kind: "program-uniqueness",
            id: "unique",
            predicate: "result",
            keyColumns: [0],
            outputColumns: [1],
          },
        ],
      }),
    );
    const plan = await planProject(config, output);
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "uniqueFamily input0 0 x0 x1 (⟨0, by decide⟩ : Datamog.SafeInt) → uniqueFamily input0 0 x0 y1 (⟨0, by decide⟩ : Datamog.SafeInt)",
    );
    expect(plan.files["Datamog/Generated.lean"]).not.toContain("(x2 : Datamog.SafeInt)");
  }));

test("program coverage quantifies all input columns and independent bounded witnesses", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate auxiliary(a: integer). input predicate seed(a: integer, b: integer). helper(X,Y,Z) :- auxiliary(X), seed(Y,Z). result(X,Y,Z) :- helper(X,Y,Z).",
    );
    const claim = {
      kind: "program-coverage",
      id: "covered",
      predicate: "result",
      inputPredicate: "seed",
      outputToInput: [null, 0, null],
      bounds: [{ column: 1, op: ">=", value: -2 }],
    };
    const writePlan = (change: object = {}) =>
      Bun.write(config, JSON.stringify({ source: "source.dl", claims: [{ ...claim, ...change }] }));
    await writePlan();
    const plan = await planProject(config, output);
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "∀ (x0 : Datamog.SafeInt) (x1 : Datamog.SafeInt), input1 x0 x1 → x1.val ≥ (-2 : Int) → ∃ (w0 : Datamog.SafeInt) (w2 : Datamog.SafeInt), coveredFamily input0 input1 0 w0 x0 w2",
    );
    expect(plan.manifest.entries.find((e) => e.id === "covered")!.closure).toEqual([
      "IntegerSemantics",
      "covered",
      "coveredFamily",
      "coveredRules0",
      "coveredRules1",
    ]);
    await writePlan({ outputToInput: [0, 1, 0], bounds: [] });
    const direct = await planProject(config, output);
    expect(direct.files["Datamog/Generated.lean"]).toContain(
      "input1 x0 x1 → coveredFamily input0 input1 0 x0 x1 x0",
    );
    expect(direct.files["Datamog/Generated.lean"]).not.toContain("∃");
    expect(direct.manifest.digest).not.toBe(plan.manifest.digest);
    await writePlan({ polarity: "refute" });
    const refutation = await planProject(config, output);
    expect(refutation.goals).toEqual(["covered_refuted"]);
    expect(refutation.files["Datamog/Checked.lean"]).toContain(
      "theorem covered_refuted : ¬ Generated.covered",
    );
    for (const change of [
      { inputPredicate: "helper" },
      { inputPredicate: "missing" },
      { outputToInput: [] },
      { outputToInput: [null, 2, null] },
      { outputToInput: [null, -1, null] },
      { outputToInput: [null, 0.5, null] },
      { outputToInput: [null, "0", null] },
      { bounds: [{ column: 2, op: ">", value: 0 }] },
      { bounds: [{ column: 0, op: "=", value: 0 }] },
      { bounds: [{ column: 0, op: "<", value: 9007199254740992 }] },
      { bounds: [{ column: 0, op: "<", value: 1.5 }] },
      { bounds: [{ column: 0, op: "<", value: 1, typo: true }] },
      { bounds: [null] },
      { bounds: "none" },
      { relationName: "Unexpected" },
    ]) {
      await writePlan(change);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await expect(readdir(output)).rejects.toThrow();
  }));

test("program coverage preserves canonical padding and nullary output existence", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate seed(a: integer, b: integer). helper(X,Y) :- seed(X,Y). result(X) :- helper(X,Y). flag() :- helper(X,Y).",
    );
    for (const [predicate, mapping, expected] of [
      ["result", [0], "coveredFamily input0 0 x0 (⟨0, by decide⟩ : Datamog.SafeInt)"],
      [
        "flag",
        [],
        "coveredFamily input0 0 (⟨0, by decide⟩ : Datamog.SafeInt) (⟨0, by decide⟩ : Datamog.SafeInt)",
      ],
    ] as const) {
      await Bun.write(
        config,
        JSON.stringify({
          source: "source.dl",
          claims: [
            {
              kind: "program-coverage",
              id: "covered",
              predicate,
              inputPredicate: "seed",
              outputToInput: mapping,
              bounds: [],
            },
          ],
        }),
      );
      const plan = await planProject(config, output);
      expect(plan.files["Datamog/Generated.lean"]).toContain(`input0 x0 x1 → ${expected}`);
    }
  }));

test("program equivalence quantifies both input relations and compares the same complete tuple", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate a(x: integer, y: integer). input predicate b(x: integer, y: integer). left(X,Y) :- a(X,Y). helper(X,Y) :- b(X,Y). right(X,Y) :- helper(X,Y).",
    );
    const claim = { kind: "program-equivalence", id: "equivalent", predicates: ["left", "right"] };
    const writePlan = (change: object = {}) =>
      Bun.write(config, JSON.stringify({ source: "source.dl", claims: [{ ...claim, ...change }] }));
    await writePlan();
    const plan = await planProject(config, output);
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "∀ (input0 : Datamog.SafeInt → Datamog.SafeInt → Prop) (input1 : Datamog.SafeInt → Datamog.SafeInt → Prop)",
    );
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "∀ (x0 : Datamog.SafeInt) (x1 : Datamog.SafeInt), equivalentFamily input0 input1 0 x0 x1 ↔ equivalentFamily input0 input1 1 x0 x1",
    );
    expect(plan.manifest.entries.find((e) => e.id === "equivalent")!.closure).toEqual([
      "IntegerSemantics",
      "equivalent",
      "equivalentFamily",
      "equivalentRules0",
      "equivalentRules1",
      "equivalentRules2",
    ]);
    await writePlan({ polarity: "refute" });
    const negative = await planProject(config, output);
    expect(negative.goals).toEqual(["equivalent_refuted"]);
    expect(negative.files["Datamog/Checked.lean"]).toContain(
      "theorem equivalent_refuted : ¬ Generated.equivalent",
    );
    for (const predicates of [
      [],
      ["left"],
      ["left", "left"],
      ["left", "right", "helper"],
      ["left", "missing"],
      ["left", "a"],
    ]) {
      await writePlan({ predicates });
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await writePlan();
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate a(x: integer, y: integer). left(X,Y) :- a(X,Y). right(X) :- a(X,Y).",
    );
    await expect(exportProject(config, output)).rejects.toThrow("equal arity");
    await expect(readdir(output)).rejects.toThrow();
  }));

test("program equivalence uses fixed padding for unary and nullary goals", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate seed(x: integer, y: integer). helper(X,Y) :- seed(X,Y). left(X) :- helper(X,Y). right(X) :- helper(X,Y). flag() :- helper(X,Y). other() :- helper(X,Y).",
    );
    for (const [predicates, args] of [
      [["left", "right"], "x0 (⟨0, by decide⟩ : Datamog.SafeInt)"],
      [["flag", "other"], "(⟨0, by decide⟩ : Datamog.SafeInt) (⟨0, by decide⟩ : Datamog.SafeInt)"],
    ] as const) {
      await Bun.write(
        config,
        JSON.stringify({
          source: "source.dl",
          claims: [{ kind: "program-equivalence", id: "same", predicates }],
        }),
      );
      const plan = await planProject(config, output);
      expect(plan.files["Datamog/Generated.lean"]).toContain(
        `sameFamily input0 0 ${args} ↔ sameFamily input0 1 ${args}`,
      );
      expect(plan.files["Datamog/Generated.lean"]).not.toContain("∀ ,");
    }
  }));

test("program emptiness quantifies every tuple and retains complete rule dependencies", async () =>
  fixture(async (config, output, dir) => {
    const source =
      "input predicate seed(a: integer, b: integer). helper(X,Y) :- seed(X,Y). violation(X,Y) :- helper(X,Y), X < Y, X >= Y.";
    await Bun.write(join(dir, "source.dl"), source);
    const claim = { kind: "program-emptiness", id: "empty", predicate: "violation" };
    const writePlan = (change: object = {}) =>
      Bun.write(config, JSON.stringify({ source: "source.dl", claims: [{ ...claim, ...change }] }));
    await writePlan();
    const plan = await planProject(config, output);
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "∀ (x0 : Datamog.SafeInt) (x1 : Datamog.SafeInt), emptyFamily input0 0 x0 x1 → False",
    );
    expect(plan.manifest.entries.find((e) => e.id === "empty")!.closure).toEqual([
      "IntegerSemantics",
      "empty",
      "emptyFamily",
      "emptyRules0",
      "emptyRules1",
    ]);
    expect(plan.manifest.entries.every((e) => !e.assumptions.length)).toBe(true);
    await writePlan({ polarity: "refute" });
    const negative = await planProject(config, output);
    expect(negative.goals).toEqual(["empty_refuted"]);
    expect(negative.files["Datamog/Checked.lean"]).toContain(
      "theorem empty_refuted : ¬ Generated.empty",
    );
    await writePlan();
    await Bun.write(join(dir, "source.dl"), `${source}\nviolation(X,Y) :- seed(X,Y).`);
    const changed = await planProject(config, output);
    expect(changed.manifest.digest).not.toBe(plan.manifest.digest);
    expect(changed.files["Datamog/Generated.lean"]).toContain("rule0_1");
    for (const change of [
      { predicate: "seed" },
      { predicate: "missing" },
      { polarity: "unknown" },
      { relationName: "Unexpected" },
      { bounds: [] },
    ]) {
      await writePlan(change);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await writePlan();
    await Bun.write(join(dir, "source.dl"), `${source}\n!- violation(X,Y).`);
    const checkedSource = await planProject(config, output);
    expect(checkedSource.manifest.entries.every((e) => !e.assumptions.length)).toBe(true);
    await expect(readdir(output)).rejects.toThrow();
  }));

test("program emptiness supports nullary cycles and fixed padding", async () =>
  fixture(async (config, output, dir) => {
    for (const [source, expected] of [
      ["flag() :- other(). other() :- flag().", "emptyFamily 0  → False"],
      [
        "input predicate seed(n: integer). helper(X) :- seed(X). flag() :- helper(X).",
        "emptyFamily input0 0 (⟨0, by decide⟩ : Datamog.SafeInt) → False",
      ],
    ]) {
      await Bun.write(join(dir, "source.dl"), source!);
      await Bun.write(
        config,
        JSON.stringify({
          source: "source.dl",
          claims: [{ kind: "program-emptiness", id: "empty", predicate: "flag" }],
        }),
      );
      const plan = await planProject(config, output);
      expect(plan.files["Datamog/Generated.lean"]).toContain(expected!);
      expect(plan.files["Datamog/Generated.lean"]).not.toContain("∀ ,");
    }
  }));

test("constraint selection excludes synthesized checks and binds exact source provenance", async () =>
  fixture(async (config, output, dir) => {
    const source =
      "input predicate seed(n: integer).\npositive(X, _: X > 0) :- seed(X), X > 0.\n?- seed(X).\n!- positive(X), X <= 0.\n!- seed(X).\n";
    const writePlan = (change: object = {}) =>
      Bun.write(
        config,
        JSON.stringify({
          source: "source.dl",
          claims: [{ kind: "constraint", id: "safe", constraint: 1, ...change }],
        }),
      );
    await Bun.write(join(dir, "source.dl"), source);
    await writePlan();
    const plan = await planProject(config, output);
    const origin = plan.manifest.entries.find((e) => e.id === "safeConstraint")!;
    expect(origin.statement).toEqual({
      claim: { kind: "constraint", id: "safe", constraint: 1 },
      text: "!- positive(X), X <= 0.",
      span: {
        offset: source.indexOf("!-"),
        end: source.indexOf("!- seed") - 1,
        line: 4,
        column: 1,
      },
    });
    expect(plan.manifest.entries.find((e) => e.id === "safe")!.closure).toContain("safeConstraint");
    expect(plan.manifest.entries.every((e) => e.assumptions.length === 0)).toBe(true);
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "safeFamily input0 0 (⟨0, by decide⟩ : Datamog.SafeInt) → False",
    );
    await writePlan({ constraint: 2, polarity: "refute" });
    const negative = await planProject(config, output);
    expect(negative.goals).toEqual(["safe_refuted"]);
    expect(negative.files["Datamog/Checked.lean"]).toContain(
      "theorem safe_refuted : ¬ Generated.safe",
    );
    expect(
      negative.manifest.entries.find((e) => e.id === "safeConstraint")!.statement,
    ).toMatchObject({ text: "!- seed(X)." });
    await writePlan();
    await Bun.write(join(dir, "source.dl"), `\n${source}`);
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    for (const constraint of [0, -1, 1.5, 3, "1"]) {
      await writePlan({ constraint });
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await writePlan({ predicate: "positive" });
    await expect(exportProject(config, output)).rejects.toThrow();
    await expect(readdir(output)).rejects.toThrow();
  }));

test("constraint export rejects unsupported bodies and generated-name collisions", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "constraint", id: "safe", constraint: 1 }],
      }),
    );
    for (const source of [
      "input predicate seed(n: integer). !- seed(X), not seed(X).",
      "input predicate seed(n: integer). !- seed(X), X + 1 < 0.",
      "input predicate seed(n: integer). !- seed(X), Y = X + 1.",
      "input predicate seed(n: integer?). !- seed(X).",
      "input predicate seed(n: integer). __lean_constraint_safe() :- seed(X). !- seed(X).",
    ]) {
      await Bun.write(join(dir, "source.dl"), source);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await expect(readdir(output)).rejects.toThrow();
  }));

test("named error goals retain every sibling and source declaration without assuming checks", async () =>
  fixture(async (config, output, dir) => {
    const source =
      "input predicate seed(n: integer).\nerror predicate bad(X) :- seed(X), X < 0.\nbad(X) :- seed(X), X > 0.\n!- seed(X).\n";
    await Bun.write(join(dir, "source.dl"), source);
    const claim = { kind: "error-predicate", id: "noBad", predicate: "bad" };
    const writePlan = (change: object = {}) =>
      Bun.write(config, JSON.stringify({ source: "source.dl", claims: [{ ...claim, ...change }] }));
    await writePlan();
    const plan = await planProject(config, output);
    expect(plan.files["Datamog/Generated.lean"]).toContain("rule0_1");
    expect(plan.files["Datamog/Generated.lean"]).toContain("noBadFamily input0 0 x0 → False");
    expect(
      plan.manifest.entries.find((e) => e.id === "noBadErrorPredicate")!.statement,
    ).toMatchObject({
      claim,
      definitions: [
        {
          error: true,
          text: "error predicate bad(X) :- seed(X), X < 0.",
          span: { line: 2, column: 1 },
        },
        { error: false, text: "bad(X) :- seed(X), X > 0.", span: { line: 3, column: 1 } },
      ],
    });
    expect(plan.manifest.entries.find((e) => e.id === "noBad")!.closure).toContain(
      "noBadErrorPredicate",
    );
    expect(plan.manifest.entries.every((e) => e.assumptions.length === 0)).toBe(true);
    await writePlan({ polarity: "refute" });
    const negative = await planProject(config, output);
    expect(negative.goals).toEqual(["noBad_refuted"]);
    expect(negative.files["Datamog/Checked.lean"]).toContain(
      "theorem noBad_refuted : ¬ Generated.noBad",
    );
    await writePlan();
    await Bun.write(join(dir, "source.dl"), source.replace("X > 0", "X >= 0"));
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    await Bun.write(join(dir, "source.dl"), source.replace("error predicate ", ""));
    await expect(exportProject(config, output)).rejects.toThrow("declared error predicate");
    for (const change of [
      { predicate: "seed" },
      { predicate: "missing" },
      { constraint: 1 },
      { relationName: "Bad" },
      { polarity: "unknown" },
    ]) {
      await writePlan(change);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await expect(readdir(output)).rejects.toThrow();
  }));

test("explicit constraints and named errors may be selected together", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate seed(n: integer). error predicate bad() :- seed(X). !- bad().",
    );
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [
          { kind: "error-predicate", id: "noBad", predicate: "bad" },
          { kind: "constraint", id: "checkBad", constraint: 1 },
        ],
      }),
    );
    const plan = await planProject(config, output);
    expect([...plan.goals].sort()).toEqual(["checkBad", "noBad"]);
    expect(plan.files["Datamog/Generated.lean"]).toContain("noBadFamily input0 0  → False");
    expect(plan.manifest.entries.find((e) => e.id === "checkBad")!.closure).toContain(
      "checkBadRules1",
    );
    expect(plan.manifest.entries.every((e) => e.assumptions.length === 0)).toBe(true);
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate seed(n: integer). error predicate bad() :- seed(X), not seed(X). !- bad().",
    );
    await expect(exportProject(config, output)).rejects.toThrow("Unsupported mutual body");
  }));

test("all composed laws remain unchanged when explicit and named runtime checks are added", async () =>
  fixture(async (config, output, dir) => {
    const source =
      "input predicate seed(n: integer). output(X, _: X > 0) :- seed(X). pair(X,X) :- seed(X). other(X,Y) :- pair(X,Y). violation(X) :- seed(X), X < 0, X >= 0.";
    const claims = [
      { kind: "program-invariant", id: "safe", predicates: ["output"] },
      {
        kind: "program-coverage",
        id: "covered",
        predicate: "output",
        inputPredicate: "seed",
        outputToInput: [0],
        bounds: [],
      },
      {
        kind: "program-uniqueness",
        id: "unique",
        predicate: "pair",
        keyColumns: [0],
        outputColumns: [1],
      },
      { kind: "program-equivalence", id: "same", predicates: ["pair", "other"] },
      { kind: "program-emptiness", id: "empty", predicate: "violation" },
    ];
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims }));
    await Bun.write(join(dir, "source.dl"), source);
    const before = await planProject(config, output);
    await Bun.write(
      join(dir, "source.dl"),
      `${source}\n!- seed(X), X <= 0.\nerror predicate bad(X) :- violation(X).`,
    );
    const after = await planProject(config, output);
    expect(after.files["Datamog/Generated.lean"]).toBe(before.files["Datamog/Generated.lean"]);
    expect(after.files["Datamog/Checked.lean"].replaceAll(after.manifest.digest, "DIGEST")).toBe(
      before.files["Datamog/Checked.lean"].replaceAll(before.manifest.digest, "DIGEST"),
    );
    expect(after.goals).toEqual(before.goals);
    expect(after.manifest.entries.every((e) => !e.assumptions.length)).toBe(true);
    expect(after.manifest.digest).not.toBe(before.manifest.digest);
    expect(after.goals).not.toContain("bad");
  }));

test("module plans snapshot transitive sources and invalidate imported changes", async () =>
  fixture(async (config, output, dir) => {
    for (const file of ["filter.dl", "pipeline.dl"])
      await Bun.write(
        join(dir, file),
        await Bun.file(`verification/lean/examples/selected-modules/${file}`).text(),
      );
    await Bun.write(
      join(dir, "source.dl"),
      await Bun.file("verification/lean/examples/selected-modules/program.dl").text(),
    );
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "program-invariant", id: "safe", predicates: ["output"] }],
      }),
    );
    const plan = await exportProject(config, output);
    // File comparisons use serialized bytes, not only canonical digests.
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await planProject(config, output)).files["manifest.json"]).toBe(
        plan.files["manifest.json"],
      );
    expect(plan.moduleSources?.map((s) => s.path)).toEqual([
      "filter.dl",
      "pipeline.dl",
      "source.dl",
    ]);
    expect(plan.manifest.entries.find((e) => e.id === "safe")!.closure).toContain("ModuleSources");
    const graph = plan.manifest.entries.find((e) => e.id === "ModuleSources")!.statement;
    expect(graph).toMatchObject({
      imports: [
        { importer: "source.dl", reference: "pipeline.dl", file: "pipeline.dl" },
        { importer: "pipeline.dl", reference: "filter.dl", file: "filter.dl" },
      ],
    });
    const preview = await inspectProject(config, output);
    expect(preview.moduleSources).toEqual(plan.moduleSources);
    for (const file of plan.moduleSources!)
      expect(file.digest).toBe(plan.manifest.context.artifacts[`module-source/${file.path}`]);
    await Bun.write(
      join(dir, "filter.dl"),
      (await Bun.file(join(dir, "filter.dl")).text()).replace("X > 0", "X >= 0"),
    );
    await Bun.write(join(output, "verification-result.json"), "old success");
    await expect(checkProject(config, output)).rejects.toThrow("Stale or altered");
    expect(await Bun.file(join(output, "verification-result.json")).exists()).toBe(false);
    const changed = await planProject(config, output);
    expect(changed.manifest.digest).not.toBe(plan.manifest.digest);
    expect(changed.files["Datamog/Generated.lean"]).not.toBe(plan.files["Datamog/Generated.lean"]);
  }));

test("module instances preserve distinct wiring while sharing source snapshots", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "filter.dl"),
      await Bun.file("verification/lean/examples/selected-modules/filter.dl").text(),
    );
    const source =
      'input predicate a(n: integer). input predicate b(n: integer). input predicate first(n: integer) := positive from "filter.dl"(item = a). input predicate second(n: integer) := positive from "filter.dl"(item = b). input predicate third(n: integer) := positive from "filter.dl"(item = a).';
    await Bun.write(join(dir, "source.dl"), source);
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "program-equivalence", id: "same", predicates: ["first", "second"] }],
      }),
    );
    const plan = await planProject(config, output);
    expect(plan.moduleSources).toHaveLength(2);
    expect(plan.manifest.entries.find((e) => e.id === "sameFamily")!.statement).toMatchObject({
      inputs: [
        { predicate: "a", index: 0, arity: 1 },
        { predicate: "b", index: 1, arity: 1 },
      ],
    });
    expect(plan.files["Datamog/Generated.lean"]).toContain("input1 : Datamog.SafeInt → Prop");
    await Bun.write(join(dir, "source.dl"), source.replace("item = b", "item = a"));
    const shared = await planProject(config, output);
    expect(shared.files["Datamog/Generated.lean"]).not.toContain("input1 :");
    expect(shared.manifest.digest).not.toBe(plan.manifest.digest);
  }));

test("module verification rejects invalid boundaries, cycles, missing files and data bindings", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      config,
      JSON.stringify({
        source: "source.dl",
        claims: [{ kind: "program-emptiness", id: "empty", predicate: "out" }],
      }),
    );
    await Bun.write(
      join(dir, "filter.dl"),
      await Bun.file("verification/lean/examples/selected-modules/filter.dl").text(),
    );
    await Bun.write(
      join(dir, "cycle.dl"),
      'input predicate item(n: integer). input predicate p(n: integer) := result from "cycle.dl"(item = item). output predicate result(X) :- p(X).',
    );
    for (const source of [
      'input predicate seed(n: integer) := "data.jsonl". out(X) :- seed(X).',
      'input predicate seed(n: integer). input predicate out(n: boolean) := positive from "filter.dl"(item = seed).',
      'input predicate seed(n: integer). input predicate out(n: integer) := positive from "missing.dl"(item = seed).',
      'input predicate seed(n: integer). input predicate out(n: integer) := result from "cycle.dl"(item = seed).',
      'input predicate seed(n: integer). input predicate out(n: integer) := positive from "https://example.com/filter.dl"(item = seed).',
    ]) {
      await Bun.write(join(dir, "source.dl"), source);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await expect(readdir(output)).rejects.toThrow();
  }));

test("module check selection numbers only entry constraints and records their file", async () =>
  fixture(async (config, output, dir) => {
    const imported = await Bun.file(
      "verification/lean/examples/selected-module-checks/filter.dl",
    ).text();
    const source = await Bun.file(
      "verification/lean/examples/selected-module-checks/program.dl",
    ).text();
    await Bun.write(join(dir, "filter.dl"), imported);
    await Bun.write(join(dir, "source.dl"), source);
    const claims = [
      { kind: "constraint", id: "check", constraint: 1 },
      { kind: "constraint", id: "nonempty", constraint: 2, polarity: "refute" },
      { kind: "error-predicate", id: "error", predicate: "bad" },
    ];
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims }));
    const plan = await planProject(config, output);
    expect(plan.manifest.entries.find((e) => e.id === "checkConstraint")!.statement).toMatchObject({
      file: "source.dl",
      text: "!- imported(X), X <= 0.",
      span: { line: 5 },
    });
    expect(
      plan.manifest.entries.find((e) => e.id === "nonemptyConstraint")!.statement,
    ).toMatchObject({ file: "source.dl", text: "!- seed(X).", span: { line: 6 } });
    expect(
      plan.manifest.entries.find((e) => e.id === "errorErrorPredicate")!.statement,
    ).toMatchObject({
      file: "source.dl",
      definitions: [{ error: true, text: "error predicate bad(X) :- imported(X), X <= 0." }],
    });
    expect(
      plan.manifest.entries
        .filter((e) => e.kind === "goal")
        .every((e) => e.closure.includes("ModuleSources")),
    ).toBe(true);
    expect(plan.manifest.entries.every((e) => !e.assumptions.length)).toBe(true);
    await Bun.write(join(dir, "filter.dl"), `${imported}\n!- item(X), X > 0.`);
    const extra = await planProject(config, output);
    expect(extra.files["Datamog/Generated.lean"]).toBe(plan.files["Datamog/Generated.lean"]);
    expect(extra.manifest.digest).not.toBe(plan.manifest.digest);
    for (const claim of [
      { kind: "constraint", id: "check", constraint: 3 },
      { kind: "error-predicate", id: "error", predicate: "internalBad" },
    ]) {
      await Bun.write(config, JSON.stringify({ source: "source.dl", claims: [claim] }));
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await expect(readdir(output)).rejects.toThrow();
  }));

test("imported checks select direct instances, preserve sharing and distinguish wiring", async () =>
  fixture(async (config, output, dir) => {
    const base = "verification/lean/examples/selected-instance-checks/";
    await Bun.write(join(dir, "filter.dl"), await Bun.file(`${base}filter.dl`).text());
    await Bun.write(join(dir, "source.dl"), await Bun.file(`${base}program.dl`).text());
    const selection = JSON.parse(await Bun.file(`${base}plan.json`).text());
    selection.source = "source.dl";
    await Bun.write(config, JSON.stringify(selection));
    const plan = await planProject(config, output);
    const entry = (id: string) => plan.manifest.entries.find((e) => e.id === id)!;
    expect(entry("safeCheckConstraint").statement).toMatchObject({
      file: "filter.dl",
      claim: { instance: "safe", constraint: 1 },
      text: "!- item(X), X <= 0.",
      span: { line: 3 },
    });
    expect(entry("sharedErrorErrorPredicate").statement).toMatchObject({
      file: "filter.dl",
      claim: { instance: "shared", predicate: "bad" },
      resolvedPredicate: "safe$0$bad",
    });
    expect(entry("unsafeErrorErrorPredicate").statement).toMatchObject({
      resolvedPredicate: "unsafe$1$bad",
    });
    expect(plan.manifest.entries.every((e) => e.assumptions.length === 0)).toBe(true);
    expect((await planProject(config, output)).manifest).toEqual(plan.manifest);
    const source = await Bun.file(join(dir, "source.dl")).text();
    await Bun.write(join(dir, "source.dl"), source.replaceAll("item = positive", "item = seed"));
    const changed = await planProject(config, output);
    expect(changed.manifest.digest).not.toBe(plan.manifest.digest);
    expect(changed.files["Datamog/Generated.lean"]).not.toBe(plan.files["Datamog/Generated.lean"]);
    await Bun.write(join(dir, "source.dl"), source);
    for (const claim of [
      { kind: "constraint", id: "bad", instance: "missing", constraint: 1 },
      { kind: "constraint", id: "bad", instance: "safe.nested", constraint: 1 },
      { kind: "constraint", id: "bad", instance: "safe", constraint: 2 },
      { kind: "error-predicate", id: "bad", instance: "safe", predicate: "result" },
      { kind: "error-predicate", id: "bad", instance: "safe", predicate: "unsafe$1$bad" },
    ]) {
      await Bun.write(config, JSON.stringify({ source: "source.dl", claims: [claim] }));
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await expect(readdir(output)).rejects.toThrow();
  }));

test("instance selectors require nonempty strings and check descriptors", () => {
  for (const instance of [null, 1, "", true]) {
    for (const claim of [
      { kind: "constraint", id: "check", constraint: 1, instance },
      { kind: "error-predicate", id: "check", predicate: "bad", instance },
      { kind: "program-emptiness", id: "check", predicate: "bad", instance },
    ])
      expect(() => parseSelection({ source: "source.dl", claims: [claim] })).toThrow();
  }
});

test("nested instance paths preserve sharing, local numbering, and overridden defaults", async () =>
  fixture(async (config, output, dir) => {
    const base = "verification/lean/examples/selected-nested-instance-checks/";
    for (const name of ["filter.dl", "middle.dl", "wrapper.dl"])
      await Bun.write(join(dir, name), await Bun.file(`${base}${name}`).text());
    const source = await Bun.file(`${base}program.dl`).text();
    await Bun.write(join(dir, "source.dl"), source);
    const selection = JSON.parse(await Bun.file(`${base}plan.json`).text());
    selection.source = "source.dl";
    selection.claims.push(
      {
        kind: "error-predicate",
        id: "safeError",
        instance: "safe.pipeline.checked",
        predicate: "bad",
      },
      {
        kind: "constraint",
        id: "parentCheck",
        instance: "safe.pipeline",
        constraint: 1,
        polarity: "refute",
      },
    );
    await Bun.write(config, JSON.stringify(selection));
    const plan = await planProject(config, output);
    const origin = (id: string) => plan.manifest.entries.find((e) => e.id === id)!.statement;
    expect(origin("safeCheckConstraint")).toMatchObject({
      file: "filter.dl",
      text: "!- item(X), X <= 0.",
      claim: { instance: "safe.pipeline.checked" },
    });
    expect(origin("parentCheckConstraint")).toMatchObject({
      file: "middle.dl",
      text: "!- item(X).",
    });
    const predicate = (id: string) =>
      (origin(id) as { resolvedPredicate: string }).resolvedPredicate;
    expect(predicate("safeErrorErrorPredicate")).toBe(predicate("sharedErrorErrorPredicate"));
    expect(predicate("unsafeErrorErrorPredicate")).not.toBe(predicate("safeErrorErrorPredicate"));
    expect((await planProject(config, output)).manifest).toEqual(plan.manifest);
    expect(plan.manifest.entries.every((e) => !e.assumptions.length)).toBe(true);
    await Bun.write(
      join(dir, "source.dl"),
      source.replace(
        'safe(n: integer) := result from "wrapper.dl"(item = positive)',
        'safe(n: integer) := result from "wrapper.dl"(item = positive, pipeline = positive)',
      ),
    );
    await expect(exportProject(config, output)).rejects.toThrow(
      "Unknown module binding path safe.pipeline.checked",
    );
    await Bun.write(config, JSON.stringify({ source: "source.dl", claims: [selection.claims[1]] }));
    const shared = await planProject(config, output);
    expect(shared.goals).toEqual(["sharedError"]);
    for (const instance of [
      "safe.pipeline",
      "shared.checked",
      "shared.pipeline.missing",
      "shared..pipeline",
      "shared.pipeline.checked.bad",
      ".shared",
      "shared.",
    ]) {
      await Bun.write(
        config,
        JSON.stringify({
          source: "source.dl",
          claims: [{ kind: "constraint", id: "check", constraint: 1, instance }],
        }),
      );
      await expect(exportProject(config, output)).rejects.toThrow("Unknown module binding path");
    }
    await expect(readdir(output)).rejects.toThrow();
  }));

test("explicit input laws become named premises and content identities", async () =>
  fixture(async (config, output, dir) => {
    await Bun.write(
      join(dir, "source.dl"),
      "input predicate item(a: integer, b: integer). out(X, _: X > 0) :- item(X, Y).",
    );
    const law = { id: "positive", predicate: "item", column: 0, op: ">", value: 0 };
    const claim = { kind: "program-invariant", id: "safe", predicates: ["out"], inputLaws: [law] };
    const write = (claims: unknown[]) =>
      Bun.write(config, JSON.stringify({ source: "source.dl", claims }));
    await write([claim]);
    const plan = await planProject(config, output);
    const preview = await inspectProject(config, output);
    expect(preview.goals[0]!.assumptions).toHaveLength(1);
    expect(preview.goals[0]!.assumptions[0]).toContain("positive:");
    expect(plan.files["Datamog/Generated.lean"]).toContain(
      "∀ (lawx0 : Datamog.SafeInt) (lawx1 : Datamog.SafeInt), input0 lawx0 lawx1 → lawx0.val > (0 : Int)",
    );
    expect(plan.manifest.entries.find((e) => e.id === "safe")!.closure).toContain("safeInputLaw0");
    await write([{ ...claim, inputLaws: [{ ...law, value: 1 }] }]);
    expect((await planProject(config, output)).manifest.digest).not.toBe(plan.manifest.digest);
    for (const inputLaws of [
      [],
      [law, law],
      [{ ...law, predicate: "out" }],
      [{ ...law, predicate: "absent" }],
      [{ ...law, column: 2 }],
      [{ ...law, column: -1 }],
      [{ ...law, value: 1.5 }],
      [{ ...law, value: 9007199254740992 }],
      [{ ...law, op: "<>" }],
      [{ ...law, typo: true }],
    ]) {
      await write([{ ...claim, inputLaws }]);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    await write([{ ...claim, polarity: "refute" }]);
    await expect(exportProject(config, output)).rejects.toThrow("proofs only");
    await write([{ kind: "program-emptiness", id: "bad", predicate: "out", inputLaws: [law] }]);
    await expect(exportProject(config, output)).rejects.toThrow();
    await expect(readdir(output)).rejects.toThrow();
  }));
