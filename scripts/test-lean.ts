// Optional integration suite: fresh Lean build, trust-policy failures, and
// concrete agreement with native/SQLite and optional Postgres. Ordinary `bun test` does not run it.
import { cp, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createNative } from "../packages/backend/native/src/index.ts";
import { create as createPostgres } from "../packages/backend/postgres/src/index.ts";
import { create as createSqlite } from "../packages/backend/sqlite/src/index.ts";
import type { Backend } from "../packages/engine/src/backend.ts";
import { ident } from "../packages/engine/src/dialect.ts";
import { DatamogExecutor } from "../packages/engine/src/executor.ts";
import { insertRows } from "../packages/engine/src/loader.ts";

import { assertCurrentVerificationManifest } from "../packages/core/src/verification-manifest.ts";
import { createLeanVerificationResult } from "../packages/core/src/verification-result.ts";

const root = new URL("../", import.meta.url).pathname;
const project = join(root, "verification/lean");
const args = process.argv.slice(2);
const requiredGoals: string[] = [];
let writeReport = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--report" && !writeReport) writeReport = true;
  else if (args[i] === "--require-goal" && args[i + 1] && !args[i + 1]!.startsWith("--"))
    requiredGoals.push(args[++i]!);
  else throw new Error("Usage: bun run test:lean [--report] [--require-goal ID ...]");
}
const reportPath = join(project, "verification-result.json");
// An explicitly requested report must not leave an earlier success after failure.
if (writeReport) await rm(reportPath, { force: true });
const postgresUrl = process.env.DATAMOG_EXAMPLES_DATABASE_URL ?? process.env.DATABASE_URL;
if (process.env.DATAMOG_REQUIRE_POSTGRES && !postgresUrl)
  throw new Error("DATAMOG_REQUIRE_POSTGRES is set but no PostgreSQL test URL is configured");
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
    "manifest.json",
  ]) {
    await cp(join(project, file), join(temp, file), { recursive: true });
  }
  const manifest = await Bun.file(join(temp, "manifest.json")).json();
  const output = await run(["lake", "build"], temp);
  const report = createLeanVerificationResult(
    manifest,
    output,
    requiredGoals.length ? requiredGoals : undefined,
  );
  console.log(
    `Fresh Lean build and registered theorem audits passed for manifest ${manifest.digest}.`,
  );
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
  // Flat record cases retain duplicate entries so construction order is tested.
  type Scalar = number | boolean | null;
  const recordInputs: [string, Scalar][][] = [[], [["a.b", null]], [["", true]]];
  for (const value of [null, false, true, 0, -1, -9007199254740991, 9007199254740991]) {
    recordInputs.push(
      [["x", value]],
      [["other", value]],
      [
        ["x", value],
        ["x", null],
      ],
      [
        ["x", null],
        ["x", value],
      ],
    );
  }
  const recordCases = recordInputs.flatMap((fields) =>
    ["x", "missing", "a.b", ""].map((key) => ({ fields, key })),
  );
  const leanScalar = (value: Scalar) =>
    value === null
      ? "Value.null"
      : typeof value === "boolean"
        ? `(Value.boolean ${value})`
        : `(Value.integer ⟨${value}, by decide⟩)`;
  const fieldInputs: [string, Scalar][][] = [
    [],
    ...[null, false, true, 0, -1, -9007199254740991, 9007199254740991].map(
      (value): [string, Scalar][] => [["x", value]],
    ),
  ];
  const fieldCases = [false, true].flatMap((optional) =>
    [false, true].flatMap((nullable) =>
      fieldInputs.map((fields) => ({ fields, optional, nullable })),
    ),
  );
  const schemaSource = await Bun.file(join(project, "fixtures/record-schema.dl")).text();
  const emptySchemaSource = await Bun.file(join(project, "fixtures/empty-record-schema.dl")).text();
  const schemaCases: { record: Record<string, Scalar>; accepts: boolean; empty?: boolean }[] = [];
  const choices = [undefined, null, 0, false] as const;
  for (const required of choices)
    for (const nullable of choices)
      for (const optional of choices)
        for (const maybe of choices) {
          const record = Object.fromEntries(
            Object.entries({ required, nullable, optional, maybe }).filter(
              ([, value]) => value !== undefined,
            ),
          ) as Record<string, Scalar>;
          schemaCases.push({
            record,
            accepts:
              required === 0 &&
              (nullable === 0 || nullable === null) &&
              (optional === undefined || optional === 0) &&
              maybe !== false,
          });
        }
  for (const value of [-9007199254740991, 9007199254740991])
    schemaCases.push({
      record: { required: value, nullable: value, optional: value, maybe: value },
      accepts: true,
    });
  for (const extra of [null, false, 0])
    schemaCases.push({ record: { required: 0, nullable: null, extra }, accepts: false });
  schemaCases.push({ record: {}, accepts: true, empty: true });
  for (const extra of [null, false, 0])
    schemaCases.push({ record: { extra }, accepts: false, empty: true });
  type NestedValue = Scalar | { [key: string]: NestedValue };
  const nestedSource = await Bun.file(join(project, "fixtures/nested-record-schema.dl")).text();
  const nestedCases: { value: NestedValue; accepts: boolean }[] = [];
  const baseline = (): Record<string, NestedValue> => ({
    required: { inner: { n: 0, nullable: null } },
    nullable: null,
  });
  const variations: (NestedValue | undefined)[] = [
    undefined,
    null,
    false,
    0,
    {},
    { n: null },
    { n: false },
    { n: 0 },
    { n: -9007199254740991 },
    { n: 9007199254740991 },
    { n: 0, extra: null },
  ];
  for (const key of ["optional", "nullable", "maybe"])
    for (const value of variations) {
      const record = baseline();
      if (value === undefined) delete record[key];
      else record[key] = value;
      const accepts =
        value === undefined
          ? key !== "nullable"
          : value === null
            ? key !== "optional"
            : typeof value === "object" &&
              Object.keys(value).length === 1 &&
              typeof value.n === "number";
      nestedCases.push({ value: record, accepts });
    }
  for (const value of [null, false, 0]) nestedCases.push({ value, accepts: false });
  for (const value of [undefined, null, false, 0, {}]) {
    const record = baseline();
    if (value === undefined) Reflect.deleteProperty(record, "required");
    else record.required = value;
    nestedCases.push({ value: record, accepts: false });
    nestedCases.push({
      value: { ...baseline(), required: value === undefined ? {} : { inner: value } },
      accepts: false,
    });
  }
  for (const key of ["n", "nullable"])
    for (const value of [undefined, null, false, 0, -9007199254740991, 9007199254740991]) {
      const inner: Record<string, NestedValue> = { n: 0, nullable: null };
      if (value === undefined) delete inner[key];
      else inner[key] = value;
      nestedCases.push({
        value: { ...baseline(), required: { inner } },
        accepts: typeof value === "number" || (key === "nullable" && value === null),
      });
    }
  nestedCases.push(
    { value: { ...baseline(), extra: null }, accepts: false },
    {
      value: { ...baseline(), required: { inner: { n: 0, nullable: null }, extra: 0 } },
      accepts: false,
    },
    {
      value: { ...baseline(), required: { inner: { n: 0, nullable: null, extra: false } } },
      accepts: false,
    },
  );
  const leanNested = (value: NestedValue): string =>
    value !== null && typeof value === "object"
      ? `(.record [${Object.entries(value)
          .map(([key, child]) => `(${JSON.stringify(key)}, ${leanNested(child)})`)
          .join(", ")}])`
      : `(.scalar ${leanScalar(value)})`;
  const nestedLookup = (value: NestedValue, path: string[]): NestedValue | undefined => {
    let current: NestedValue | undefined = value;
    for (const key of path)
      current = current !== null && typeof current === "object" ? current[key] : undefined;
    return current;
  };
  const backends: [string, Backend][] = [];
  const backendNames: string[] = [];
  const checks: string[] = [];
  try {
    backends.push(["native", await createNative()]);
    backends.push(["SQLite", await createSqlite()]);
    if (postgresUrl) {
      // One connection keeps search_path stable; never reset the public schema.
      const sql = new Bun.SQL(postgresUrl, { max: 1, connectionTimeout: 5 });
      const schema = `lean_semantics_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const backend = await createPostgres(sql);
        backends.push([
          "Postgres",
          {
            ...backend,
            async close() {
              try {
                await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
              } finally {
                await backend.close();
              }
            },
          },
        ]);
      } catch (error) {
        try {
          await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await sql.close();
        }
        throw error;
      }
    } else {
      console.log("Postgres semantic comparisons skipped: no test database URL configured.");
    }
    backendNames.push(...backends.map(([name]) => name));
    for (const [i, [expr, lean]] of cases.entries()) {
      const [left, op, right] = expr.split(" ");
      // The seed establishes integer columns even for a null test row.
      const source = `pair${i}(0, 0). pair${i}(${left}, ${right}).
        result${i}(A ${op} B) :- pair${i}(A, B), A = ${left}, B = ${right}.
        ?- result${i}(X).`;
      const results = [];
      for (const [name, backend] of backends) {
        const rows = (await new DatamogExecutor(backend).execute(source))[0]!.rows;
        if (results.length && JSON.stringify(results[0]) !== JSON.stringify(rows))
          throw new Error(`native/${name} disagree: ${expr}`);
        results.push(rows);
      }
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
    for (const [i, { fields, key }] of recordCases.entries()) {
      const literal = `{${fields.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")}}`;
      const source = `recordCase${i}(${literal}).
        recordResult${i}(R[${JSON.stringify(key)}]) :- recordCase${i}(R).
        ?- recordResult${i}(X).`;
      const found = fields.findLast(([name]) => name === key);
      const expected = found ? [{ X: found[1] }] : [];
      for (const [name, backend] of backends) {
        const rows = (await new DatamogExecutor(backend).execute(source))[0]!.rows;
        if (JSON.stringify(rows) !== JSON.stringify(expected))
          throw new Error(`${name} record lookup regression: ${literal}[${JSON.stringify(key)}]`);
      }
      const leanFields = `[${fields.map(([k, v]) => `(${JSON.stringify(k)}, ${leanScalar(v)})`).join(", ")}]`;
      const result = found ? `some ${leanScalar(found[1])}` : "none";
      checks.push(
        `example : lookupField ${leanFields} ${JSON.stringify(key)} = ${result} := by decide`,
      );
    }
    for (const [i, { fields, optional, nullable }] of fieldCases.entries()) {
      const field = fields[0];
      const accepts = field
        ? field[1] === null
          ? nullable
          : typeof field[1] === "number"
        : optional;
      const record = Object.fromEntries(fields);
      const source = `input predicate fieldCase${i}(r: {x${optional ? "?" : ""}: integer${nullable ? "?" : ""}}).
        fieldResult${i}(R["x"]) :- fieldCase${i}(R).
        ?- fieldResult${i}(X).`;
      for (const [name, backend] of backends) {
        const executor = new DatamogExecutor(backend, [
          {
            name: "field-membership-fixture",
            async canLoad() {
              return true;
            },
            async load(decl, target) {
              await insertRows(target, decl, [{ r: record }]);
              return { rowsLoaded: 1 };
            },
          },
        ]);
        let rejected = false;
        let rows: Record<string, unknown>[] = [];
        try {
          rows = (await executor.execute(source))[0]!.rows;
        } catch (error) {
          // Only structural input rejection counts as an expected mismatch.
          if (!(error instanceof Error) || !error.message.includes("column 'r'")) throw error;
          rejected = true;
        }
        if (rejected === accepts)
          throw new Error(`${name} integer-field acceptance regression: case ${i}`);
        if (accepts && JSON.stringify(rows) !== JSON.stringify(field ? [{ X: field[1] }] : []))
          throw new Error(`${name} integer-field projection regression: case ${i}`);
      }
      const leanFields = `[${fields.map(([k, v]) => `(${JSON.stringify(k)}, ${leanScalar(v)})`).join(", ")}]`;
      checks.push(
        `example : integerFieldMatches ${leanFields} "x" ${optional} ${nullable} = ${accepts} := by decide`,
      );
    }
    for (const [i, { record, accepts, empty }] of schemaCases.entries()) {
      const source = (empty ? emptySchemaSource : schemaSource)
        .replaceAll("document", `schemaInput${i}`)
        .replaceAll("project", `schemaOutput${i}`);
      for (const [name, backend] of backends) {
        const executor = new DatamogExecutor(backend, [
          {
            name: "schema-membership-fixture",
            async canLoad() {
              return true;
            },
            async load(decl, target) {
              await insertRows(target, decl, [{ r: record }]);
              return { rowsLoaded: 1 };
            },
          },
        ]);
        let rejected = false;
        let rows: Record<string, unknown>[] = [];
        try {
          rows = (await executor.execute(source))[0]!.rows;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("column 'r'")) throw error;
          rejected = true;
        }
        if (rejected === accepts)
          throw new Error(`${name} schema acceptance regression: case ${i}`);
        if (
          accepts &&
          JSON.stringify(rows) !==
            JSON.stringify(empty ? [{ R: record }] : [{ X: record.required, Y: record.nullable }])
        )
          throw new Error(`${name} schema projection regression: case ${i}`);
      }
      const fields = `[${Object.entries(record)
        .map(([key, value]) => `(${JSON.stringify(key)}, ${leanScalar(value)})`)
        .join(", ")}]`;
      checks.push(
        `example : integerRecordMatches Generated.${empty ? "EmptySchema" : "DocumentSchema"} ${fields} = ${accepts} := by decide`,
      );
    }
    for (const [i, { value, accepts }] of nestedCases.entries()) {
      const source = [
        nestedSource
          .replaceAll("document", `nestedInput${i}`)
          .replaceAll("project", `nestedOutput${i}`),
        ...["optional", "nullable", "maybe"].map(
          (key, j) =>
            `output predicate nestedPath${i}_${j}(X) :- nestedInput${i}(R), X = R["${key}"]["n"].`,
        ),
      ].join("\n");
      const paths = [
        ["required", "inner", "n"],
        ["required", "inner", "nullable"],
        ["optional", "n"],
        ["nullable", "n"],
        ["maybe", "n"],
      ];
      for (const [name, backend] of backends) {
        const executor = new DatamogExecutor(backend, [
          {
            name: "nested-schema-fixture",
            async canLoad() {
              return true;
            },
            async load(decl, target) {
              await insertRows(target, decl, [{ r: value }]);
              return { rowsLoaded: 1 };
            },
          },
        ]);
        let rejected = false;
        let results: { rows: Record<string, unknown>[] }[] = [];
        try {
          results = await executor.execute(source);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("column 'r'")) throw error;
          rejected = true;
        }
        if (rejected === accepts)
          throw new Error(`${name} nested schema acceptance regression: ${i}`);
        if (accepts) {
          const expected = [
            [{ X: nestedLookup(value, paths[0]!), Y: nestedLookup(value, paths[1]!) }],
            ...paths.slice(2).map((path) => {
              const result = nestedLookup(value, path);
              return result === undefined ? [] : [{ X: result }];
            }),
          ];
          if (JSON.stringify(results.map((result) => result.rows)) !== JSON.stringify(expected))
            throw new Error(`${name} nested schema lookup regression: ${i}`);
        }
      }
      checks.push(
        `example : Nested.accepts Generated.NestedSchema ${leanNested(value)} = ${accepts} := by simp [Nested.accepts, Generated.NestedSchema, Nested.lookup]`,
      );
      for (const path of paths) {
        const result = nestedLookup(value, path);
        checks.push(
          `example : Nested.lookupPath ${leanNested(value)} [${path.map((key) => JSON.stringify(key)).join(", ")}] = ${result === undefined ? "none" : `some ${leanNested(result)}`} := by rfl`,
        );
      }
    }
    // Replay the positive uniqueness fixture and the branching counterexample.
    // These are concrete translation regressions, not universal proof evidence.
    const relationCases = [
      {
        fixture: "identity.dl",
        query: "?- identity(X, Y).",
        input: [-9007199254740991, 0, 9007199254740991].map((n) => ({ n })),
        expected: [-9007199254740991, 0, 9007199254740991].map((n) => ({ X: n, Y: n })),
      },
      {
        fixture: "successor.dl",
        query: "?- succ(X, Y).",
        input: [-9007199254740991, -1, 0, 9007199254740990, 9007199254740991].map((n) => ({ n })),
        expected: [-9007199254740991, -1, 0, 9007199254740990].map((n) => ({ X: n, Y: n + 1 })),
      },
      {
        fixture: "guarded-successor.dl",
        query: "?- guarded(X, Y).",
        input: [-9007199254740991, -1, 0, 9007199254740989, 9007199254740990, 9007199254740991].map(
          (n) => ({ n }),
        ),
        expected: [-9007199254740991, -1, 0, 9007199254740989].map((n) => ({ X: n, Y: n + 1 })),
      },
      {
        fixture: "saturating-successor.dl",
        query: "?- saturating(X, Y).",
        input: [-9007199254740991, -1, 0, 9007199254740989, 9007199254740990, 9007199254740991].map(
          (n) => ({ n }),
        ),
        expected: [
          -9007199254740991, -1, 0, 9007199254740989, 9007199254740990, 9007199254740991,
        ].map((n) => ({ X: n, Y: n === 9007199254740991 ? n : n + 1 })),
      },
      {
        fixture: "overlapping-successor.dl",
        query: "?- overlapping(X, Y).",
        input: [9007199254740989, 9007199254740990, 9007199254740991].map((n) => ({ n })),
        expected: [
          { X: 9007199254740989, Y: 9007199254740990 },
          { X: 9007199254740990, Y: 9007199254740991 },
          { X: 9007199254740990, Y: 9007199254740990 },
          { X: 9007199254740991, Y: 9007199254740991 },
        ],
      },
      {
        fixture: "diagonal.dl",
        query: "?- diagonal(X, Y).",
        input: [
          { left: -9007199254740991, right: -9007199254740991 },
          { left: 0, right: 0 },
          { left: 0, right: 1 },
          { left: 1, right: 0 },
          { left: 9007199254740991, right: 9007199254740991 },
        ],
        expected: [-9007199254740991, 0, 9007199254740991].map((n) => ({ X: n, Y: n })),
      },
      {
        fixture: "reach.dl",
        query: "?- reach(X, Y).",
        input: [
          { source: 0, target: 1 },
          { source: 0, target: 2 },
        ],
        expected: [
          { X: 0, Y: 1 },
          { X: 0, Y: 2 },
        ],
      },
    ];
    const canonicalRows = (rows: Record<string, unknown>[]) =>
      JSON.stringify(rows.map((row) => JSON.stringify([row.X, row.Y])).sort());
    for (const testCase of relationCases) {
      const source = await Bun.file(join(project, "fixtures", testCase.fixture)).text();
      for (const [name, backend] of backends) {
        const executor = new DatamogExecutor(backend, [
          {
            name: "relation-fixture",
            async canLoad() {
              return true;
            },
            async load(decl, target) {
              // SQL input tables outlive an executor. Replace this fixture's
              // data within the isolated test schema, rather than accumulating it.
              if (target.sqlDialect) await target.execute(`DELETE FROM ${ident(decl.predicate)}`);
              await insertRows(target, decl, testCase.input);
              return { rowsLoaded: testCase.input.length };
            },
          },
        ]);
        const rows = (await executor.execute(`${source}\n${testCase.query}`))[0]!.rows;
        if (canonicalRows(rows) !== canonicalRows(testCase.expected))
          throw new Error(`${name} relation regression: ${testCase.fixture}`);
      }
    }
    console.log(`7 relation fixtures passed on ${backendNames.join("/")}.`);
  } finally {
    await Promise.all(backends.map(([, backend]) => backend.close()));
  }
  checks.push(
    "example : Datamog.negationAsFailure none := by simp [Datamog.negationAsFailure, Datamog.Holds]",
  );
  await Bun.write(
    join(temp, "CrossCheck.lean"),
    `import Datamog.Semantics\nimport Datamog.Records\nimport Datamog.Generated\nopen Datamog\n${checks.join("\n")}\n`,
  );
  await run(["lake", "env", "lean", "CrossCheck.lean"], temp);
  console.log(`${cases.length} Lean/${backendNames.join("/")} semantic cases passed.`);
  console.log(
    `${recordCases.length} Lean/${backendNames.join("/")} flat-record lookup cases passed.`,
  );
  console.log(
    `${fieldCases.length} Lean/${backendNames.join("/")} integer-field acceptance cases passed.`,
  );
  console.log(
    `${schemaCases.length} Lean/${backendNames.join("/")} schema acceptance cases passed.`,
  );
  console.log(`${nestedCases.length} Lean/${backendNames.join("/")} nested schema cases passed.`);
  const semanticChecks = {
    scope: "concrete-cases",
    cases: cases.length,
    relationCases: 7,
    recordCases: recordCases.length,
    fieldCases: fieldCases.length,
    schemaCases: schemaCases.length,
    nestedSchemaCases: nestedCases.length,
    backends: backendNames,
    postgres: postgresUrl ? "passed" : "skipped",
  };
  await run([process.execPath, "scripts/generate-lean.ts", "--check"], root);
  assertCurrentVerificationManifest(
    manifest,
    await Bun.file(join(project, "manifest.json")).json(),
  );
  if (writeReport) {
    const pending = `${reportPath}.tmp`;
    try {
      await Bun.write(pending, `${JSON.stringify({ ...report, semanticChecks }, null, 2)}\n`);
      await rename(pending, reportPath);
    } finally {
      await rm(pending, { force: true });
    }
    console.log(`Verification report written to ${reportPath}`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
