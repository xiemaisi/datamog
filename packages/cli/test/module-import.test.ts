import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "main.ts");

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { DATABASE_URL: _omit, ...env } = process.env;
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode ?? 0, stdout, stderr };
}

async function withTempDir<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "datamog-mod-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REACH = `input predicate edge(src: integer, dst: integer).
output predicate reach(X, Y) :- edge(X, Y).
output predicate reach(X, Z) :- reach(X, Y), edge(Y, Z).
`;

describe("CLI module imports", () => {
  test("resolves a `from` import from disk and runs the merged program", async () => {
    const result = await withTempDir(
      {
        "reach.dl": REACH,
        "main.dl": `input predicate road(src: integer, dst: integer).
input predicate road_reach(a: integer, b: integer) := reach from "reach.dl"(edge = road).
?- road_reach(1, X).
`,
        "road.csv": "src,dst\n1,2\n2,3\n",
      },
      (dir) => runCli(["--backend", "native", "--output-format", "jsonl", join(dir, "main.dl")]),
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const rows = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { X: number });
    expect(rows.map((r) => r.X).sort()).toEqual([2, 3]);
  });

  test('loads an `input predicate := "file" as csv` data binding', async () => {
    const result = await withTempDir(
      {
        "asc.dl": "input predicate p(a: integer, b: integer).\n?- p(X, Y), X < Y.\n",
        "main.dl": `input predicate road(src: integer, dst: integer) := "edges.txt" as csv.
input predicate ordered(lo: integer, hi: integer) := from "asc.dl"(p = road).
?- ordered(L, H).
`,
        "edges.txt": "src,dst\n1,2\n5,3\n",
      },
      (dir) => runCli(["--backend", "native", "--output-format", "jsonl", join(dir, "main.dl")]),
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    // Only the ascending row (1,2) survives asc.dl's default output.
    expect(result.stdout.trim()).toBe('{"L":1,"H":2}');
  });

  test("an actual overrides a module input's `:=` default", async () => {
    // order.dl's `lt` defaults to the closure of `cover`; the override wires a
    // different (still lawful) order, so the two runs must disagree.
    const files = {
      "reach.dl": REACH,
      "order.dl": `input predicate cover(a: integer, b: integer).
input predicate lt(a: integer, b: integer) := reach from "reach.dl"(edge = cover).
!- lt(X, X).
elem(X) :- cover(X, _).
elem(X) :- cover(_, X).
output predicate minimal(X) :- elem(X), not lt(_, X).
`,
      "default.dl": `cover(1, 2). cover(2, 3).
input predicate bottom(x: integer) := minimal from "order.dl"(cover = cover).
?- bottom(X).
`,
      "override.dl": `cover(1, 2). cover(2, 3).
known(2, 1).
input predicate bottom(x: integer) := minimal from "order.dl"(cover = cover, lt = known).
?- bottom(X).
`,
    };
    const run = async (dir: string, entry: string): Promise<number[]> => {
      const r = await runCli(["--backend", "native", "--output-format", "jsonl", join(dir, entry)]);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      return r.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { X: number }).X)
        .sort();
    };
    await withTempDir(files, async (dir) => {
      expect(await run(dir, "default.dl")).toEqual([1]);
      expect(await run(dir, "override.dl")).toEqual([2, 3]);
    });
  });

  test("instantiates a data-carrying module twice, without colliding with the importer", async () => {
    // leaky.dl binds its own `extra` input to a file. Both instances keep that
    // data, and neither clashes with the other or with the importer's own
    // `extra` predicate.
    const result = await withTempDir(
      {
        "leaky.dl": `input predicate cover(a: integer, b: integer).
input predicate extra(a: integer, b: integer) := "extra.csv".
output predicate all_edges(X, Y) :- cover(X, Y).
output predicate all_edges(X, Y) :- extra(X, Y).
`,
        "extra.csv": "a,b\n7,8\n",
        "main.dl": `cover(1, 2).
other(3, 4).
extra(99, 99).
input predicate e1(x: integer, y: integer) := all_edges from "leaky.dl"(cover = cover).
input predicate e2(x: integer, y: integer) := all_edges from "leaky.dl"(cover = other).
?- e1(X, Y), e2(P, Q).
`,
      },
      (dir) => runCli(["--backend", "native", "--output-format", "jsonl", join(dir, "main.dl")]),
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const rows = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, number>);
    // Each instance is its own actual plus its own copy of extra.csv; the
    // importer's `extra(99, 99)` stays out of both.
    const pairs = (a: string, b: string) => [...new Set(rows.map((r) => `${r[a]},${r[b]}`))].sort();
    expect(pairs("X", "Y")).toEqual(["1,2", "7,8"]);
    expect(pairs("P", "Q")).toEqual(["3,4", "7,8"]);
  });

  test("shares one instance between two outputs of the same interface", async () => {
    const result = await withTempDir(
      {
        "reach.dl": REACH,
        "order.dl": `input predicate cover(a: integer, b: integer).
input predicate lt(a: integer, b: integer) := reach from "reach.dl"(edge = cover).
elem(X) :- cover(X, _).
elem(X) :- cover(_, X).
output predicate minimal(X) :- elem(X), not lt(_, X).
output predicate maximal(X) :- elem(X), not lt(X, _).
`,
        "main.dl": `cover(1, 2). cover(2, 3).
input predicate lo(x: integer) := minimal from "order.dl"(cover = cover).
input predicate hi(x: integer) := maximal from "order.dl"(cover = cover).
?- lo(L), hi(H).
`,
      },
      async (dir) => {
        const run = await runCli([
          "--backend",
          "native",
          "--output-format",
          "jsonl",
          join(dir, "main.dl"),
        ]);
        const dry = await runCli(["--dry-run", join(dir, "main.dl")]);
        return { run, dry };
      },
    );
    expect(result.run.stderr).toBe("");
    expect(result.run.stdout.trim()).toBe('{"L":1,"H":3}');
    // Both bindings wire `cover` the same way, so the closure and the element
    // domain are expanded once and each binding is a thin alias over its output.
    const views = [...result.dry.stdout.matchAll(/CREATE VIEW[^"]*"([^"]+)"/g)].map((m) => m[1]);
    expect(views.filter((v) => v?.endsWith("$elem"))).toHaveLength(1);
    expect(views.filter((v) => v?.endsWith("$reach"))).toHaveLength(1);
    expect(views).toContain("lo");
    expect(views).toContain("hi");
  });

  test("rejects an import whose declared output type is wrong", async () => {
    const result = await withTempDir(
      {
        "reach.dl": REACH,
        "main.dl": `input predicate road(src: integer, dst: integer).
input predicate best(a: string, b: string) := reach from "reach.dl"(edge = road).
?- best(X, Y).
`,
        "road.csv": "src,dst\n1,2\n",
      },
      (dir) => runCli(["--backend", "native", join(dir, "main.dl")]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/column 1 has type 'integer' but 'string'/);
  });

  test("reports a missing module clearly", async () => {
    const result = await withTempDir(
      {
        "m.dl":
          'input predicate x(a: integer, b: integer) := r from "nope.dl"(e = x).\n?- x(A, B).\n',
      },
      (dir) => runCli(["--backend", "native", join(dir, "m.dl")]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot read module 'nope.dl'");
  });
});
