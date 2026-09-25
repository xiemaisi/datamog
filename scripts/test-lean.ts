// Optional integration suite: fresh Lean build, trust-policy failures, and
// concrete agreement with native/SQLite. Ordinary `bun test` does not run it.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createNative } from "../packages/backend/native/src/index.ts";
import { create as createSqlite } from "../packages/backend/sqlite/src/index.ts";
import { DatamogExecutor } from "../packages/engine/src/executor.ts";

const root = new URL("../", import.meta.url).pathname;
const project = join(root, "verification/lean");
async function run(command: string[], cwd: string, expectedFailure?: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = stdout + stderr;
    if (expectedFailure ? code === 0 || !output.includes(expectedFailure) : code !== 0) {
      throw new Error(`${command.join(" ")} exited ${code}\n${output}`);
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}
await run([process.execPath, "scripts/generate-lean.ts", "--check"], root);
const version = await run(["lake", "env", "lean", "--version"], project);
if (!version.includes("version 4.34.0,")) throw new Error(`Unexpected Lean: ${version}`);
const temp = await mkdtemp(join(tmpdir(), "datamog-lean-"));
try {
  // Never trust pre-existing project .olean files or local build caches.
  for (const file of [
    "lean-toolchain",
    "lakefile.toml",
    "lake-manifest.json",
    "Datamog.lean",
    "Datamog",
  ]) {
    await cp(join(project, file), join(temp, file), { recursive: true });
  }
  const output = await run(["lake", "build"], temp);
  for (const name of ["successor", "reachPreserves", "falseGoal_refuted"]) {
    if (!output.includes(`Audited Datamog.Checked.${name}`))
      throw new Error(`Missing axiom audit: ${name}`);
  }
  console.log("Fresh Lean build and registered theorem audits passed.");
  const negatives: [string, string, string][] = [
    [
      "FalseGoal",
      "theorem rejected : Datamog.Generated.falseGoal := by\n  unfold Datamog.Generated.falseGoal\n  omega",
      "omega could not prove",
    ],
    [
      "Sorry",
      "theorem rejected : Datamog.Generated.successor := by sorry\n#audit rejected",
      "Unapproved axiom sorryAx",
    ],
    [
      "ExtraAxiom",
      "axiom helper : Datamog.Generated.successor\ntheorem rejected : Datamog.Generated.successor := helper\n#audit rejected",
      "Unapproved axiom helper",
    ],
    [
      "Weaker",
      "theorem weaker : True := True.intro\ntheorem rejected : Datamog.Generated.successor := weaker",
      "Type mismatch",
    ],
    [
      "Native",
      "theorem rejected : (1 : Nat) = 1 := by native_decide\n#audit rejected",
      "Unapproved axiom",
    ],
  ];
  for (const [name, body, message] of negatives) {
    await Bun.write(
      join(temp, `${name}.lean`),
      `import Datamog.Generated\nimport Datamog.Audit\n${body}\n`,
    );
    await run(["lake", "env", "lean", `${name}.lean`], temp, message);
  }
  console.log("False goal, sorry, extra axiom, weaker statement, and native computation rejected.");

  // Compare the small semantics library with real evaluation, including absence
  // of a row for undefinedness and a present null for the null value.
  const cases: [string, string][] = [];
  const values = [-9007199254740991, -7, -1, 0, 1, 7, 9007199254740991, null];
  const leanValue = (n: number | null) => (n === null ? "(some Value.null)" : `(bounded (${n}))`);
  for (const a of values)
    for (const b of [-3, 0, 1, 3, null]) {
      for (const [op, name] of [
        ["+", "add"],
        ["/", "divide"],
        ["%", "remainder"],
        ["<", "less"],
        ["=", "equal"],
      ]) {
        // Nullable arithmetic is rejected by the current frontend; equality and
        // ordering still exercise defined null versus an undefined result.
        if ((a === null || b === null) && ["+", "/", "%"].includes(op!)) continue;
        cases.push([`${a} ${op} ${b}`, `${name} ${leanValue(a)} ${leanValue(b)}`]);
      }
    }
  const native = await createNative();
  const sqlite = await createSqlite();
  const checks: string[] = [];
  try {
    for (const [i, [expr, lean]] of cases.entries()) {
      const [left, op, right] = expr.split(" ");
      // The seed establishes integer columns even for a null test row.
      const source = `pair${i}(0, 0). pair${i}(${left}, ${right}).
        result${i}(A ${op} B) :- pair${i}(A, B), A = ${left}, B = ${right}.
        ?- result${i}(X).`;
      const results = [];
      for (const backend of [native, sqlite]) {
        results.push((await new DatamogExecutor(backend).execute(source))[0]!.rows);
      }
      if (JSON.stringify(results[0]) !== JSON.stringify(results[1]))
        throw new Error(`Native/SQLite disagree: ${expr}`);
      const rows = results[0]!;
      const value = rows[0]?.X;
      const expected =
        rows.length === 0
          ? "none"
          : typeof value === "boolean"
            ? `(some (.boolean ${value}))`
            : leanValue(value as number | null);
      checks.push(`example : ${lean} = ${expected} := by decide`);
    }
  } finally {
    await native.close();
    await sqlite.close();
  }
  checks.push(
    "example : Datamog.negationAsFailure none := by simp [Datamog.negationAsFailure, Datamog.Holds]",
  );
  await Bun.write(
    join(temp, "CrossCheck.lean"),
    `import Datamog.Semantics\nopen Datamog\n${checks.join("\n")}\n`,
  );
  await run(["lake", "env", "lean", "CrossCheck.lean"], temp);
  console.log(`${cases.length} Lean/native/SQLite semantic cases passed.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
