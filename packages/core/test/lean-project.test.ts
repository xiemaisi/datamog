import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkProject,
  exportProject,
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
    await expect(planProject(config, output)).rejects.toThrow("standalone");
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
      parseSelection({ source: "x", claims: [{ ...claim, polarity: "refute" }] }),
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
      source.replace("right(X, _: X > 0) :- left(X)", "right(X + 1 as Y, _: Y > 0) :- left(X)"),
      `${source}!- left(X), X < 0.`,
      source.replace("right(X, _: X > 0)", "right(X)"),
      source.replace("seed(n: integer)", "seed(n: integer?)"),
      source.replace("left(X).", "left(X), not seed(X)."),
    ]) {
      await Bun.write(join(dir, "source.dl"), changed);
      await expect(exportProject(config, output)).rejects.toThrow();
    }
    expect(() =>
      parseSelection({ source: "x", claims: [{ ...claim, polarity: "refute" }] }),
    ).toThrow();
    expect(await Bun.file(join(output, "manifest.json")).exists()).toBe(false);
  }));
