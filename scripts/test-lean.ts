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

import {
  assertCurrentVerificationManifest,
  canonicalVerificationJson,
} from "../packages/core/src/verification-manifest.ts";
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
  const arrayInputs: Scalar[][] = [[]];
  const arrayScalars: Scalar[] = [null, false, true, 0, -1, -9007199254740991, 9007199254740991];
  for (const first of arrayScalars) {
    arrayInputs.push([first]);
    for (const second of arrayScalars) arrayInputs.push([first, second]);
  }
  const arrayCases = [false, true].flatMap((nullable) =>
    arrayInputs.map((values) => ({ values, nullable })),
  );
  const arrayIndices = [-9007199254740991, -1, 0, 1, 2, 9007199254740991];
  const arraySources = await Promise.all(
    ["integer-array.dl", "nullable-integer-array.dl"].map((fixture) =>
      Bun.file(join(project, "fixtures", fixture)).text(),
    ),
  );
  type ArrayValue = Scalar | ArrayValue[];
  const leanArray = (value: ArrayValue): string =>
    Array.isArray(value)
      ? `(.array [${value.map(leanArray).join(", ")}])`
      : `(.scalar ${leanScalar(value)})`;
  const arrayAccepts = (flags: boolean[], nullable: boolean, value: ArrayValue): boolean => {
    if (value === null) return nullable;
    if (!flags.length) return typeof value === "number";
    return (
      Array.isArray(value) && value.every((child) => arrayAccepts(flags.slice(1), flags[0]!, child))
    );
  };
  const arrayLookup = (value: ArrayValue, path: number[]): ArrayValue | undefined => {
    let result: ArrayValue | undefined = value;
    for (const index of path)
      result = Array.isArray(result) && index >= 0 ? result[index] : undefined;
    return result;
  };
  const innerArrays: ArrayValue[] = [
    null,
    [],
    [null],
    [0],
    [-9007199254740991, 9007199254740991],
    [false],
    0,
    false,
    [[0]],
  ];
  const nestedArrayInputs: ArrayValue[] = [null, 0, false, []];
  for (const first of innerArrays) {
    nestedArrayInputs.push([first]);
    for (const second of innerArrays) nestedArrayInputs.push([first, second]);
  }
  const nestedArraySpecs = [
    { id: "NestedArray", fixture: "nested-array.dl", flags: [false, false] },
    { id: "NullableNestedArray", fixture: "nullable-nested-array.dl", flags: [true, true] },
    { id: "DeepArray", fixture: "deep-array.dl", flags: [true, true, false] },
  ];
  const nestedArrayCases = (
    await Promise.all(
      nestedArraySpecs.map(async (spec) => ({
        ...spec,
        source: await Bun.file(join(project, "fixtures", spec.fixture)).text(),
      })),
    )
  ).flatMap((spec) =>
    (spec.flags.length === 2
      ? nestedArrayInputs
      : [...nestedArrayInputs, ...nestedArrayInputs.map((value) => [value])]
    ).map((value) => ({ ...spec, value })),
  );
  type MixedValue = Scalar | MixedValue[] | { [key: string]: MixedValue };
  const isRecord = (value: MixedValue): value is { [key: string]: MixedValue } =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const integer = (value: MixedValue) => typeof value === "number" && Number.isSafeInteger(value);
  const nullable = (check: (value: MixedValue) => boolean) => (value: MixedValue) =>
    value === null || check(value);
  const arrayOf = (check: (value: MixedValue) => boolean) => (value: MixedValue) =>
    Array.isArray(value) && value.every(check);
  const recordOf =
    (
      required: Record<string, (value: MixedValue) => boolean>,
      optional: Record<string, (value: MixedValue) => boolean> = {},
    ) =>
    (value: MixedValue): boolean =>
      isRecord(value) &&
      Object.entries(required).every(
        ([key, check]) => Object.hasOwn(value, key) && check(value[key]!),
      ) &&
      Object.entries(value).every(
        ([key, child]) => (required[key] ?? optional[key])?.(child) === true,
      );
  const personCheck = recordOf(
    { age: integer, rating: nullable(integer) },
    { score: nullable(integer) },
  );
  const teamCheck = recordOf({ members: arrayOf(personCheck) });
  const mixedCheck = recordOf(
    { teams: arrayOf(teamCheck), nullable: nullable(recordOf({ age: integer })) },
    { optional: recordOf({ age: integer }) },
  );
  const mixedArrayCheck = arrayOf(recordOf({ rows: arrayOf(arrayOf(recordOf({ n: integer }))) }));
  const replaceMixed = (
    value: MixedValue,
    path: (string | number)[],
    replacement: MixedValue | undefined,
  ): MixedValue => {
    if (!path.length) {
      if (replacement === undefined) throw new Error("Cannot delete a fixture root");
      return replacement;
    }
    const [part, ...rest] = path;
    if (Array.isArray(value) && typeof part === "number")
      return value.map((child, index) =>
        index === part ? replaceMixed(child, rest, replacement) : child,
      );
    if (isRecord(value) && typeof part === "string") {
      const result = { ...value };
      if (!rest.length && replacement === undefined) delete result[part];
      else result[part] = replaceMixed(result[part]!, rest, replacement);
      return result;
    }
    throw new Error("Invalid fixture mutation path");
  };
  const mixedInputs: MixedValue[] = [];
  const baseMixed: MixedValue = {
    teams: [
      {
        members: [
          { age: 0, rating: null },
          { age: 9007199254740991, rating: -9007199254740991, score: null },
        ],
      },
      { members: [] },
    ],
    nullable: null,
  };
  const replacements: (MixedValue | undefined)[] = [undefined, null, false, 0, [], {}, [null]];
  for (const path of [
    [],
    ["teams"],
    ["teams", 0],
    ["teams", 0, "members"],
    ["teams", 0, "members", 0],
    ["teams", 0, "members", 0, "age"],
    ["teams", 0, "members", 0, "rating"],
    ["teams", 0, "members", 0, "score"],
    ["optional"],
    ["nullable"],
  ] as (string | number)[][]) {
    for (const replacement of replacements) {
      if (!path.length) {
        if (replacement !== undefined) mixedInputs.push(replacement);
        continue;
      }
      // Deleting an array slot would create a JS sparse array, outside the JSON model.
      if (replacement === undefined && typeof path.at(-1) === "number") continue;
      mixedInputs.push(replaceMixed(baseMixed, path, replacement));
    }
  }
  mixedInputs.push(
    baseMixed,
    { teams: [], nullable: null },
    {
      teams: [{ members: [{ age: -9007199254740991, rating: 9007199254740991, score: 0 }] }],
      nullable: { age: 1 },
      optional: { age: 2 },
    },
  );
  for (const path of [[], ["teams", 0], ["teams", 0, "members", 0]] as (string | number)[][]) {
    mixedInputs.push(replaceMixed(baseMixed, [...path, "extra"], 0));
  }
  const mixedArrayInputs: MixedValue[] = [
    [],
    [{ rows: [] }],
    [{ rows: [[]] }],
    [{ rows: [[{ n: -9007199254740991 }, { n: 9007199254740991 }]] }],
    [{ rows: [[{ n: 0 }], []] }, { rows: [[{ n: 1 }]] }],
  ];
  for (const value of [
    null,
    false,
    0,
    {},
    [],
    [null],
    [{ n: null }],
    [{ n: false }],
    [{ n: 0, extra: 1 }],
    [{}],
  ] as MixedValue[]) {
    mixedArrayInputs.push(value, [value], [{ rows: value }], [{ rows: [value] }]);
  }
  const mixedOptionalInputs: MixedValue[] = [{}, null, false, [], { extra: 0 }];
  for (const rows of [
    null,
    false,
    0,
    {},
    [],
    [null],
    [{}],
    [{ n: null }],
    [{ n: 0 }],
    [{ n: -9007199254740991 }, null, { n: 9007199254740991 }],
    [{ n: false }],
    [{ n: [] }],
    [{ n: 0, extra: 1 }],
    [[{ n: 0 }]],
  ] as MixedValue[])
    mixedOptionalInputs.push({ rows });
  const mixedSpecs = [
    {
      id: "MixedOptionalSchema",
      fixture: "mixed-optional-schema.dl",
      values: mixedOptionalInputs,
      check: recordOf(
        {},
        { rows: nullable(arrayOf(nullable(recordOf({}, { n: nullable(integer) })))) },
      ),
      dimensions: 1,
      paths: [
        ["rows", 0, "n"],
        ["rows", 0],
      ],
    },
    {
      id: "MixedSchema",
      fixture: "mixed-schema.dl",
      values: mixedInputs,
      check: mixedCheck,
      dimensions: 2,
      paths: [
        ["teams", 0, "members", 1, "age"],
        ["teams", 0, "members", 1, "rating"],
        ["teams", 0, "members", 1, "score"],
        ["optional", "age"],
        ["nullable", "age"],
      ],
    },
    {
      id: "MixedArraySchema",
      fixture: "mixed-array-schema.dl",
      values: mixedArrayInputs,
      check: mixedArrayCheck,
      dimensions: 3,
      paths: [[0, "rows", 1, 2, "n"]],
    },
  ];
  const mixedCases = (
    await Promise.all(
      mixedSpecs.map(async (spec) => ({
        ...spec,
        source: await Bun.file(join(project, "fixtures", spec.fixture)).text(),
      })),
    )
  ).flatMap((spec) => spec.values.map((value) => ({ ...spec, value })));
  const leanMixed = (value: MixedValue): string =>
    Array.isArray(value)
      ? `(.array [${value.map(leanMixed).join(", ")}])`
      : isRecord(value)
        ? `(.record [${Object.entries(value)
            .map(([key, child]) => `(${JSON.stringify(key)}, ${leanMixed(child)})`)
            .join(", ")}])`
        : `(.scalar ${leanScalar(value)})`;
  const mixedLookup = (value: MixedValue, path: (string | number)[]): MixedValue | undefined => {
    let result: MixedValue | undefined = value;
    for (const part of path)
      result =
        typeof part === "number"
          ? Array.isArray(result) && part >= 0
            ? result[part]
            : undefined
          : result !== undefined && isRecord(result)
            ? result[part]
            : undefined;
    return result;
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
    for (const [i, { values, nullable }] of arrayCases.entries()) {
      const accepts = values.every(
        (value) => typeof value === "number" || (value === null && nullable),
      );
      const source = arraySources[nullable ? 1 : 0]!.replaceAll("items", `arrayItems${i}`)
        .replaceAll("indices", `arrayIndices${i}`)
        .replaceAll("project", `arrayOutput${i}`);
      const expected = arrayIndices.flatMap((index) =>
        index >= 0 && index < values.length ? [{ I: index, X: values[index] }] : [],
      );
      for (const [name, backend] of backends) {
        const executor = new DatamogExecutor(backend, [
          {
            name: "array-schema-fixture",
            async canLoad() {
              return true;
            },
            async load(decl, target) {
              await insertRows(
                target,
                decl,
                decl.predicate === `arrayItems${i}`
                  ? [{ values }]
                  : arrayIndices.map((i) => ({ i })),
              );
              return { rowsLoaded: decl.predicate === `arrayItems${i}` ? 1 : arrayIndices.length };
            },
          },
        ]);
        let rejected = false;
        let rows: Record<string, unknown>[] = [];
        try {
          rows = (await executor.execute(source))[0]!.rows;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("column 'values'")) throw error;
          rejected = true;
        }
        if (rejected === accepts) throw new Error(`${name} array acceptance regression: ${i}`);
        rows.sort((a, b) => Number(a.I) - Number(b.I));
        if (accepts && JSON.stringify(rows) !== JSON.stringify(expected))
          throw new Error(`${name} array indexing regression: ${i}: ${JSON.stringify(rows)}`);
      }
      const leanValues = `[${values.map(leanScalar).join(", ")}]`;
      const schema = nullable ? "NullableIntegerArray" : "IntegerArray";
      checks.push(
        `example : Arrays.accepts Generated.${schema} ${leanValues} = ${accepts} := by decide`,
      );
      for (const index of arrayIndices) {
        const result =
          index >= 0 && index < values.length ? `some ${leanScalar(values[index]!)}` : "none";
        checks.push(
          `example : Arrays.lookupIndex ${leanValues} (${index}) = ${result} := by decide`,
        );
      }
    }
    for (const [caseIndex, spec] of nestedArrayCases.entries()) {
      const { value, flags } = spec;
      const accepts = arrayAccepts(flags, false, value);
      // Exercise each dimension separately, including negative and wide dynamic indices.
      const paths = [[...flags.map(() => 0)], [...flags.map(() => 1)]];
      for (let level = 0; level < flags.length; level++)
        for (const index of arrayIndices) {
          const path = flags.map(() => 0);
          path[level] = index;
          paths.push(path);
        }
      const uniquePaths = [...new Map(paths.map((path) => [JSON.stringify(path), path])).values()];
      const columns = flags.map((_, i) => `i${i}`);
      const variables = flags.map((_, i) => `I${i}`);
      const inputName = `nestedArrayItems${caseIndex}`;
      const indexName = `nestedArrayIndices${caseIndex}`;
      const outputName = `nestedArrayOutput${caseIndex}`;
      const source = `${spec.source.replaceAll("items", inputName)}input predicate ${indexName}(${columns.map((c) => `${c}: integer`).join(", ")}).
${outputName}(${variables.join(", ")}, V${variables.map((v) => `[${v}]`).join("")}) :- ${inputName}(V), ${indexName}(${variables.join(", ")}).
?- ${outputName}(${variables.join(", ")}, X).`;
      const expected = uniquePaths.flatMap((path) => {
        const result = arrayLookup(value, path);
        return result === undefined
          ? []
          : [{ ...Object.fromEntries(variables.map((v, i) => [v, path[i]])), X: result }];
      });
      const sorted = (rows: Record<string, unknown>[]) =>
        rows.map((row) => JSON.stringify(row)).sort();
      for (const [name, backend] of backends) {
        const executor = new DatamogExecutor(backend, [
          {
            name: "nested-array-fixture",
            async canLoad() {
              return true;
            },
            async load(decl, target) {
              const rows =
                decl.predicate === inputName
                  ? [{ values: value }]
                  : uniquePaths.map((path) =>
                      Object.fromEntries(columns.map((c, i) => [c, path[i]])),
                    );
              await insertRows(target, decl, rows);
              return { rowsLoaded: rows.length };
            },
          },
        ]);
        let rejected = false;
        let rows: Record<string, unknown>[] = [];
        try {
          rows = (await executor.execute(source))[0]!.rows;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("column 'values'")) throw error;
          rejected = true;
        }
        if (rejected === accepts) throw new Error(`${name} nested array acceptance: ${caseIndex}`);
        if (accepts && JSON.stringify(sorted(rows)) !== JSON.stringify(sorted(expected)))
          throw new Error(`${name} nested array lookup: ${caseIndex}: ${JSON.stringify(rows)}`);
      }
      const leanValue = leanArray(value);
      checks.push(
        `example : NestedArrays.accepts Generated.${spec.id} false ${leanValue} = ${accepts} := by decide`,
      );
      for (const path of uniquePaths) {
        const found = arrayLookup(value, path);
        const result = found === undefined ? "none" : `some ${leanArray(found)}`;
        // Int-valued lookup checks invalid indices too; theorem paths use Nat.
        const expression = path.reduce(
          (expr, index) =>
            `(${expr}).bind (fun value => NestedArrays.lookupIndex value (${index}))`,
          `(some ${leanValue})`,
        );
        checks.push(`example : ${expression} = ${result} := by rfl`);
        if (path.every((index) => index >= 0))
          checks.push(
            `example : NestedArrays.lookupPath ${leanValue} [${path.join(", ")}] = ${result} := by rfl`,
          );
      }
    }
    for (const [caseIndex, spec] of mixedCases.entries()) {
      const { value, dimensions } = spec;
      const accepted = spec.check(value);
      const tuples = [Array(dimensions).fill(0), Array(dimensions).fill(1)] as number[][];
      for (let level = 0; level < dimensions; level++)
        for (const index of arrayIndices) {
          const tuple = Array(dimensions).fill(0);
          tuple[level] = index;
          tuples.push(tuple);
        }
      const indices = [...new Map(tuples.map((tuple) => [JSON.stringify(tuple), tuple])).values()];
      const columns = Array.from({ length: dimensions }, (_, i) => `i${i}`);
      const variables = columns.map((_, i) => `I${i}`);
      const items = `mixedItems${caseIndex}`;
      const indexName = `mixedIndices${caseIndex}`;
      const source = `${spec.source.replaceAll("items", items)}input predicate ${indexName}(${columns.map((c) => `${c}: integer`).join(", ")}).
${spec.paths.map((path, p) => `output predicate mixedOutput${caseIndex}_${p}(${variables.join(", ")}, X) :- ${items}(V), ${indexName}(${variables.join(", ")}), X = V${path.map((part) => (typeof part === "string" ? `[${JSON.stringify(part)}]` : `[I${part}]`)).join("")}.`).join("\n")}`;
      const expected = spec.paths.map((path) =>
        indices.flatMap((tuple) => {
          const result = mixedLookup(
            value,
            path.map((part) => (typeof part === "number" ? tuple[part]! : part)),
          );
          return result === undefined
            ? []
            : [{ ...Object.fromEntries(variables.map((v, i) => [v, tuple[i]])), X: result }];
        }),
      );
      for (const [name, backend] of backends) {
        const executor = new DatamogExecutor(backend, [
          {
            name: "mixed-schema-fixture",
            async canLoad() {
              return true;
            },
            async load(decl, target) {
              const rows =
                decl.predicate === items
                  ? [{ values: value }]
                  : indices.map((tuple) =>
                      Object.fromEntries(columns.map((c, i) => [c, tuple[i]])),
                    );
              await insertRows(target, decl, rows);
              return { rowsLoaded: rows.length };
            },
          },
        ]);
        let rejected = false;
        let results: { rows: Record<string, unknown>[] }[] = [];
        try {
          results = await executor.execute(source);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("column 'values'")) throw error;
          rejected = true;
        }
        if (rejected === accepted) throw new Error(`${name} mixed schema acceptance ${caseIndex}`);
        if (accepted)
          for (const [p, rows] of expected.entries()) {
            const normalize = (rows: Record<string, unknown>[]) =>
              rows.map(canonicalVerificationJson).sort();
            if (JSON.stringify(normalize(results[p]!.rows)) !== JSON.stringify(normalize(rows)))
              throw new Error(`${name} mixed path ${caseIndex}/${p}`);
          }
      }
      const encoded = leanMixed(value);
      checks.push(
        `example : Structural.accepts Generated.${spec.id} ${encoded} = ${accepted} := by simp [Structural.accepts, Structural.lookup, Generated.${spec.id}]`,
      );
      for (const path of spec.paths)
        for (const tuple of indices) {
          const resolved = path.map((part) => (typeof part === "number" ? tuple[part]! : part));
          if (resolved.some((part) => typeof part === "number" && part < 0)) continue; // Nat theorem paths; negative runtime indices checked above.
          const found = mixedLookup(value, resolved);
          const result = found === undefined ? "none" : `some ${leanMixed(found)}`;
          const segments = resolved
            .map((part) =>
              typeof part === "number" ? `.index ${part}` : `.field ${JSON.stringify(part)}`,
            )
            .join(", ");
          checks.push(
            `example : Structural.lookupPath ${encoded} [${segments}] = ${result} := by rfl`,
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
  // Keep elaborator memory bounded as structural fixtures add many lookup checks.
  // Every batch is checked in the same fresh project; none imports prior examples.
  const caseBatchSize = 500;
  for (let start = 0; start < checks.length; start += caseBatchSize) {
    await Bun.write(
      join(temp, "CrossCheck.lean"),
      `import Datamog.Semantics\nimport Datamog.Records\nimport Datamog.Generated\nopen Datamog\n${checks.slice(start, start + caseBatchSize).join("\n")}\n`,
    );
    await run(["lake", "env", "lean", "CrossCheck.lean"], temp);
  }
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
  console.log(`${arrayCases.length} Lean/${backendNames.join("/")} array schema cases passed.`);
  console.log(
    `${nestedArrayCases.length} Lean/${backendNames.join("/")} nested array schema cases passed.`,
  );
  console.log(
    `${mixedCases.length} Lean/${backendNames.join("/")} mixed structural schema cases passed.`,
  );
  const semanticChecks = {
    scope: "concrete-cases",
    cases: cases.length,
    relationCases: 7,
    recordCases: recordCases.length,
    fieldCases: fieldCases.length,
    schemaCases: schemaCases.length,
    nestedSchemaCases: nestedCases.length,
    arraySchemaCases: arrayCases.length,
    nestedArraySchemaCases: nestedArrayCases.length,
    structuralSchemaCases: mixedCases.length,
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
