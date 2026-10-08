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
      "ProjectionWeaker",
      "theorem weaker : ∀ (input : Datamog.Structural.Value → Prop), (∀ value, input value → Datamog.Structural.accepts Datamog.Generated.ProfileAgeSchema value = true) → True := by intros; trivial\ntheorem rejected : Datamog.Generated.ProfileAge_soundness := weaker",
      "Type mismatch",
    ],
    [
      "TupleWeaker",
      "theorem weaker : ∀ (input : Datamog.Structural.Value → Datamog.SafeInt → Datamog.SafeInt → Prop) x y, Datamog.Generated.Paired input x y → True := by intros; trivial\ntheorem rejected : Datamog.Generated.Paired_soundness := weaker",
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
  const projectionSource = await Bun.file(
    join(project, "fixtures/structural-projection.dl"),
  ).text();
  const projectionCheck = recordOf({
    teams: arrayOf(
      recordOf({ members: arrayOf(recordOf({ age: integer, rating: nullable(integer) })) }),
    ),
  });
  const requiredProjectionCases: MixedValue[] = [
    { teams: [] },
    { teams: [{ members: [] }] },
    { teams: [{ members: [{ age: 0, rating: null }] }] },
    { teams: [{ members: [{ age: -9007199254740991, rating: 9007199254740991 }] }] },
    {
      teams: [
        {
          members: [
            { age: 9007199254740991, rating: -9007199254740991 },
            { age: 1, rating: 2 },
          ],
        },
      ],
    },
    { teams: [{ members: [] }, { members: [{ age: 1, rating: 2 }] }] },
    { teams: [{ members: [{ age: 1, rating: 2 }] }, { members: [{ age: 3, rating: null }] }] },
    {},
    { teams: null },
    { teams: [null] },
    { teams: [{}] },
    { teams: [{ members: null }] },
    { teams: [{ members: [null] }] },
    { teams: [{ members: [{ age: null, rating: 0 }] }] },
    { teams: [{ members: [{ age: false, rating: 0 }] }] },
    { teams: [{ members: [{ age: 0 }] }] },
    { teams: [{ members: [{ age: 0, rating: false }] }] },
    { teams: [], extra: 1 },
    null,
    [],
  ];
  const optionalProjectionSource = await Bun.file(
    join(project, "fixtures/optional-projection.dl"),
  ).text();
  const optionalProjectionCheck = recordOf(
    {},
    {
      profile: nullable(recordOf({ age: integer }, { rating: nullable(integer) })),
      rows: nullable(arrayOf(nullable(recordOf({}, { age: integer, rating: nullable(integer) })))),
    },
  );
  const optionalProjectionCases: MixedValue[] = [
    {},
    { profile: null },
    { profile: { age: 0 } },
    { profile: { age: -9007199254740991, rating: null } },
    { profile: { age: 9007199254740991, rating: -9007199254740991 } },
    { profile: { age: 1, rating: 9007199254740991 } },
    { rows: null },
    { rows: [] },
    { rows: [null] },
    { rows: [{}] },
    { rows: [{ age: 0 }] },
    { rows: [{ rating: null }] },
    { rows: [{ age: -9007199254740991, rating: 9007199254740991 }] },
    { rows: [{ age: 9007199254740991, rating: -9007199254740991 }] },
    { rows: [null, { age: 2, rating: 3 }] },
    { profile: { age: 0, rating: null }, rows: [{ age: 1, rating: 2 }, null] },
    { profile: {} },
    { profile: { age: null } },
    { profile: { age: false } },
    { profile: { age: 0, rating: false } },
    { profile: { age: 0, extra: 1 } },
    { profile: [] },
    { rows: {} },
    { rows: [false] },
    { rows: [{ age: null }] },
    { rows: [{ rating: false }] },
    { rows: [{ extra: 1 }] },
    { extra: 1 },
    null,
    [],
    false,
  ];
  type ProjectionOutput = {
    usedIndices?: number[];
    orderedOutputs?: [number, number];
    valueChecks?: { output: number; upperBound?: number }[];
    filters?: { holds: boolean; lean: string }[];
    predicate: string;
    relation: string;
    paths: ((string | number)[] | { input: number })[];
  };
  const requiredOutputs: ProjectionOutput[] = [
    { predicate: "firstAge", relation: "FirstAge", paths: [["teams", 0, "members", 0, "age"]] },
    {
      predicate: "firstRating",
      relation: "FirstRating",
      paths: [["teams", 0, "members", 0, "rating"]],
    },
  ];
  const optionalOutputs: ProjectionOutput[] = [
    { predicate: "profileAge", relation: "ProfileAge", paths: [["profile", "age"]] },
    { predicate: "profileRating", relation: "ProfileRating", paths: [["profile", "rating"]] },
    { predicate: "optionalAge", relation: "OptionalAge", paths: [["rows", 0, "age"]] },
    { predicate: "optionalRating", relation: "OptionalRating", paths: [["rows", 0, "rating"]] },
  ];
  const dynamicProjectionSource = await Bun.file(
    join(project, "fixtures/dynamic-projection.dl"),
  ).text();
  const dynamicProjectionCheck = recordOf({
    rows: arrayOf(
      recordOf({
        cells: arrayOf(
          recordOf({ n: integer, rating: nullable(integer) }, { score: nullable(integer) }),
        ),
      }),
    ),
  });
  const dynamicValues: MixedValue[] = [
    { rows: [] },
    { rows: [{ cells: [] }] },
    { rows: [{ cells: [{ n: 0, rating: null }] }] },
    {
      rows: [
        {
          cells: [
            { n: -9007199254740991, rating: 9007199254740991, score: null },
            { n: 9007199254740991, rating: -9007199254740991, score: 0 },
          ],
        },
      ],
    },
    { rows: [{ cells: [] }, { cells: [{ n: 2, rating: 3, score: 4 }] }] },
    {
      rows: [
        {
          cells: [
            { n: 0, rating: 1 },
            { n: 2, rating: 3 },
          ],
        },
        {
          cells: [
            { n: 4, rating: null, score: 5 },
            { n: 6, rating: 7, score: null },
          ],
        },
      ],
    },
  ];
  const dynamicIndices = [-9007199254740991, -1, 0, 1, 2, 2147483648, 9007199254740991];
  const indexPairs = [
    ...dynamicIndices.map((i) => [i, 0]),
    ...dynamicIndices.filter((j) => j !== 0).map((j) => [0, j]),
    [1, 1],
    [1, 2],
    [2, 1],
  ];
  const dynamicInputs = dynamicValues.flatMap((value) =>
    indexPairs.map(([outer, inner]) => ({
      value,
      indices: [outer!, inner!, -9007199254740991],
    })),
  );
  for (const value of [
    {},
    { rows: null },
    { rows: [null] },
    { rows: [{ cells: null }] },
    { rows: [{ cells: [{ n: null, rating: 0 }] }] },
    { rows: [{ cells: [{ n: 0, rating: false }] }] },
    { rows: [{ cells: [{ n: 0, rating: 1, score: false }] }] },
    { rows: [], extra: 0 },
  ] as MixedValue[])
    dynamicInputs.push({ value, indices: [0, 0, 0] });
  const tupleProjectionSource = await Bun.file(
    join(project, "fixtures/tuple-projection.dl"),
  ).text();
  const tupleProjectionCheck = recordOf(
    {
      left: arrayOf(recordOf({ n: integer })),
      right: arrayOf(recordOf({ rating: nullable(integer) })),
    },
    { optional: nullable(integer) },
  );
  const tupleValues: MixedValue[] = [
    { left: [], right: [] },
    { left: [{ n: 0 }], right: [] },
    { left: [], right: [{ rating: null }] },
    { left: [{ n: 0 }], right: [{ rating: null }] },
    { left: [{ n: -9007199254740991 }], right: [{ rating: 9007199254740991 }], optional: null },
    {
      left: [{ n: 9007199254740991 }, { n: 1 }],
      right: [{ rating: 0 }, { rating: -9007199254740991 }],
      optional: 2,
    },
  ];
  const tupleIndexPairs = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [-1, 0],
    [0, -1],
    [2147483648, 0],
    [0, 9007199254740991],
  ];
  const tupleInputs = tupleValues.flatMap((value) =>
    tupleIndexPairs.map(([outer, inner]) => ({
      value,
      indices: [outer!, inner!],
    })),
  );
  for (const value of [
    {},
    { left: [{ n: null }], right: [] },
    { left: [], right: [{ rating: false }] },
    { left: [], right: [], optional: false },
    { left: null, right: [] },
    { left: [], right: [null] },
  ] as MixedValue[])
    tupleInputs.push({ value, indices: [0, 0] });
  const carriedProjectionSource = await Bun.file(
    join(project, "fixtures/carried-projection.dl"),
  ).text();
  const carriedProjectionCheck = recordOf({
    rows: arrayOf(
      recordOf({ n: integer, rating: nullable(integer) }, { score: nullable(integer) }),
    ),
  });
  const carriedValues: MixedValue[] = [
    { rows: [] },
    { rows: [{ n: 0, rating: null }] },
    {
      rows: [
        { n: -9007199254740991, rating: 9007199254740991, score: null },
        { n: 9007199254740991, rating: -9007199254740991, score: 0 },
      ],
    },
    {
      rows: [
        { n: 1, rating: 2, score: 9007199254740991 },
        { n: 3, rating: null },
      ],
    },
  ];
  const carriedInputs = carriedValues.flatMap((value) =>
    dynamicIndices.flatMap((index) =>
      [-9007199254740991, 0, 9007199254740991].map((key) => ({
        value,
        indices: [index, -9007199254740991, key],
      })),
    ),
  );
  for (const value of [
    {},
    { rows: null },
    { rows: [{ n: null, rating: 0 }] },
    { rows: [{ n: 0, rating: false }] },
    { rows: [{ n: 0, rating: 0, score: false }] },
  ] as MixedValue[])
    carriedInputs.push({ value, indices: [0, 0, 0] });
  const filteredProjectionSource = await Bun.file(
    join(project, "fixtures/filtered-projection.dl"),
  ).text();
  const filteredInputs = carriedValues.flatMap((value) =>
    [-1, 0, 1, 9007199254740991].flatMap((index) =>
      [0, 2].flatMap((limit) =>
        [-9007199254740991, 0, 9007199254740991].map((key) => ({
          value,
          indices: [index, limit, key],
        })),
      ),
    ),
  );
  const excludedProjectionSource = await Bun.file(
    join(project, "fixtures/excluded-projection.dl"),
  ).text();
  const excludedInputs = carriedValues.flatMap((value) =>
    [-1, 0, 1, 9007199254740991].flatMap((index) =>
      [-9007199254740991, 0, 9007199254740991].flatMap((blocked) =>
        [-9007199254740991, 0, 9007199254740991].map((key) => ({
          value,
          indices: [index, blocked, key],
        })),
      ),
    ),
  );
  const positiveProjectionSource = await Bun.file(
    join(project, "fixtures/positive-projection.dl"),
  ).text();
  const positiveInputs = carriedValues.flatMap((value) =>
    dynamicIndices.map((index) => ({ value, indices: [index, 0, -9007199254740991] })),
  );
  const rangedProjectionSource = await Bun.file(
    join(project, "fixtures/ranged-projection.dl"),
  ).text();
  const rangedValues: MixedValue[] = [
    { rows: [] },
    ...[-9007199254740991, -1, 0, 1, 10, 11, 9007199254740991].map((n) => ({
      rows: [{ n, rating: null }],
    })),
  ];
  const rangedInputs = rangedValues.flatMap((value) =>
    dynamicIndices.map((index) => ({ value, indices: [index, 0, -9007199254740991] })),
  );
  const bothPositiveSource = await Bun.file(
    join(project, "fixtures/both-positive-projection.dl"),
  ).text();
  const bothPositiveCheck = recordOf({
    left: arrayOf(recordOf({ n: integer })),
    right: arrayOf(recordOf({ n: integer })),
  });
  const bothPositiveInputs: { value: MixedValue; indices: number[] }[] = [
    -9007199254740991, 0, 1, 9007199254740991,
  ].flatMap((left) =>
    [-9007199254740991, 0, 1, 9007199254740991].map((right) => ({
      value: { left: [{ n: left }], right: [{ n: right }] },
      indices: [0, 0],
    })),
  );
  for (const i of dynamicIndices)
    for (const j of dynamicIndices)
      bothPositiveInputs.push({
        value: { left: [{ n: 1 }, { n: 9007199254740991 }], right: [{ n: 2 }, { n: 0 }] },
        indices: [i, j],
      });
  for (const value of [
    { left: [], right: [{ n: 1 }] },
    { left: [{ n: 1 }], right: [] },
    { left: [], right: [] },
    {},
    { left: null, right: [] },
    { left: [{ n: null }], right: [{ n: 1 }] },
    { left: [{ n: 1 }], right: [{ n: false }] },
  ] as MixedValue[])
    bothPositiveInputs.push({ value, indices: [0, 0] });
  const orderedProjectionSource = await Bun.file(
    join(project, "fixtures/ordered-projection.dl"),
  ).text();
  const projectionCases = [
    ...bothPositiveInputs.map(({ value, indices }) => ({
      value,
      indices,
      source: orderedProjectionSource,
      check: bothPositiveCheck,
      outputs: [
        {
          predicate: "ordered",
          relation: "Ordered",
          usedIndices: [0, 1],
          orderedOutputs: [0, 1],
          paths: [
            ["left", indices[0]!, "n"],
            ["right", indices[1]!, "n"],
          ],
        },
      ] as ProjectionOutput[],
    })),
    ...bothPositiveInputs.map(({ value, indices }) => ({
      value,
      indices,
      source: bothPositiveSource,
      check: bothPositiveCheck,
      outputs: [
        {
          predicate: "bothPositive",
          relation: "BothPositive",
          usedIndices: [0, 1],
          valueChecks: [{ output: 0 }, { output: 1 }],
          paths: [
            ["left", indices[0]!, "n"],
            ["right", indices[1]!, "n"],
          ],
        },
      ] as ProjectionOutput[],
    })),
    ...rangedInputs.map(({ value, indices }) => ({
      value,
      indices,
      source: rangedProjectionSource,
      check: carriedProjectionCheck,
      outputs: [
        {
          predicate: "ranged",
          relation: "Ranged",
          usedIndices: [0],
          valueChecks: [{ output: 1, upperBound: 10 }],
          paths: [{ input: 2 }, ["rows", indices[0]!, "n"]],
        },
      ] as ProjectionOutput[],
    })),
    ...positiveInputs.map(({ value, indices }) => ({
      value,
      indices,
      source: positiveProjectionSource,
      check: carriedProjectionCheck,
      outputs: [
        {
          predicate: "positive",
          relation: "Positive",
          usedIndices: [0],
          valueChecks: [{ output: 1 }],
          paths: [{ input: 2 }, ["rows", indices[0]!, "n"]],
        },
      ] as ProjectionOutput[],
    })),
    ...excludedInputs.map(({ value, indices }) => ({
      value,
      indices,
      source:
        indices[2] === 0 ? excludedProjectionSource.replace("!=", "<>") : excludedProjectionSource,
      check: carriedProjectionCheck,
      outputs: [
        {
          predicate: "excluded",
          relation: "Excluded",
          usedIndices: [0],
          paths: [{ input: 2 }, ["rows", indices[0]!, "n"]],
          filters: [
            {
              holds: indices[2] !== indices[1],
              lean: `(${indices[2]} : Int) ≠ (${indices[1]} : Int)`,
            },
          ],
        },
      ] as ProjectionOutput[],
    })),
    ...filteredInputs.map(({ value, indices }) => ({
      value,
      indices,
      source: filteredProjectionSource,
      check: carriedProjectionCheck,
      outputs: [
        {
          predicate: "filtered",
          relation: "Filtered",
          usedIndices: [0],
          paths: [{ input: 2 }, ["rows", indices[0]!, "n"]],
          filters: [
            { holds: indices[2]! >= 0, lean: `(${indices[2]} : Int) ≥ 0` },
            {
              holds: indices[0]! < indices[1]!,
              lean: `(${indices[0]} : Int) < (${indices[1]} : Int)`,
            },
          ],
        },
      ] as ProjectionOutput[],
    })),
    ...requiredProjectionCases.map((value) => ({
      value,
      indices: [] as number[],
      source: projectionSource,
      check: projectionCheck,
      outputs: requiredOutputs,
    })),
    ...optionalProjectionCases.map((value) => ({
      value,
      indices: [] as number[],
      source: optionalProjectionSource,
      check: optionalProjectionCheck,
      outputs: optionalOutputs,
    })),
    ...dynamicInputs.map(({ value, indices }) => ({
      value,
      indices,
      source: dynamicProjectionSource,
      check: dynamicProjectionCheck,
      outputs: [
        {
          predicate: "dynamicAge",
          relation: "DynamicAge",
          paths: [["rows", indices[0]!, "cells", indices[1]!, "n"]],
          usedIndices: [0, 1],
        },
        {
          predicate: "dynamicRating",
          relation: "DynamicRating",
          paths: [["rows", indices[0]!, "cells", indices[1]!, "rating"]],
          usedIndices: [0, 1],
        },
        {
          predicate: "reusedAge",
          relation: "ReusedAge",
          paths: [["rows", indices[0]!, "cells", indices[0]!, "n"]],
          usedIndices: [0],
        },
        {
          predicate: "dynamicScore",
          relation: "DynamicScore",
          paths: [["rows", indices[0]!, "cells", indices[1]!, "score"]],
          usedIndices: [0, 1],
        },
      ] as ProjectionOutput[],
    })),
    ...tupleInputs.map(({ value, indices }) => ({
      value,
      indices,
      source: tupleProjectionSource,
      check: tupleProjectionCheck,
      outputs: [
        {
          predicate: "paired",
          relation: "Paired",
          usedIndices: [0, 1],
          paths: [
            ["left", indices[0]!, "n"],
            ["right", indices[1]!, "rating"],
          ],
        },
        {
          predicate: "optionalPair",
          relation: "OptionalPair",
          usedIndices: [0],
          paths: [["left", indices[0]!, "n"], ["optional"]],
        },
        {
          predicate: "repeatedPair",
          relation: "RepeatedPair",
          usedIndices: [0, 1],
          paths: [
            ["left", indices[0]!, "n"],
            ["left", indices[0]!, "n"],
            ["right", indices[1]!, "rating"],
          ],
        },
      ] as ProjectionOutput[],
    })),
    ...carriedInputs.map(({ value, indices }) => ({
      value,
      indices,
      source: carriedProjectionSource,
      check: carriedProjectionCheck,
      outputs: [
        {
          predicate: "identified",
          relation: "Identified",
          usedIndices: [0],
          paths: [{ input: 2 }, ["rows", indices[0]!, "n"]],
        },
        {
          predicate: "indexed",
          relation: "Indexed",
          usedIndices: [0],
          paths: [{ input: 0 }, ["rows", indices[0]!, "rating"], { input: 2 }, { input: 0 }],
        },
        {
          predicate: "optionalIdentified",
          relation: "OptionalIdentified",
          usedIndices: [0],
          paths: [{ input: 2 }, ["rows", indices[0]!, "score"]],
        },
      ] as ProjectionOutput[],
    })),
  ];
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
    for (const [caseIndex, fixture] of projectionCases.entries()) {
      const { value } = fixture;
      const accepted = fixture.check(value);
      let source = fixture.source.replaceAll("items", `projectionItems${caseIndex}`);
      for (const [index, output] of fixture.outputs.entries()) {
        const predicate = `projectionOutput${caseIndex}_${index}`;
        source = source.replaceAll(output.predicate, predicate);
        const variables = output.paths.map((_, index) => `X${index}`).join(", ");
        source += `\noutput predicate projectionResult${caseIndex}_${index}(${variables}) :- ${predicate}(${variables}).`;
      }
      const outputs = fixture.outputs.map(({ paths }) =>
        paths.map((path) =>
          Array.isArray(path) ? mixedLookup(value, path) : fixture.indices[path.input],
        ),
      );
      for (const [name, backend] of backends) {
        const executor = new DatamogExecutor(backend, [
          {
            name: "structural-projection-fixture",
            async canLoad() {
              return true;
            },
            async load(decl, target) {
              await insertRows(target, decl, [
                {
                  values: value,
                  ...Object.fromEntries(
                    ["outer", "inner", "unused"]
                      .slice(0, fixture.indices.length)
                      .map((key, index) => [key, fixture.indices[index]]),
                  ),
                },
              ]);
              return { rowsLoaded: 1 };
            },
          },
        ]);
        // Release each fixture's views before the final schema drop. Accumulating
        // hundreds of projections can exhaust Postgres's per-transaction locks.
        try {
          let rejected = false;
          let results: { rows: Record<string, unknown>[] }[] = [];
          try {
            results = await executor.execute(source);
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("column 'values'"))
              throw error;
            rejected = true;
          }
          if (rejected === accepted) throw new Error(`${name} projection acceptance ${caseIndex}`);
          if (accepted)
            for (const [index, output] of outputs.entries()) {
              const ordered = fixture.outputs[index]!.orderedOutputs;
              const expected =
                output.some((value) => value === undefined) ||
                (ordered !== undefined &&
                  !(Number(output[ordered[0]]) <= Number(output[ordered[1]]))) ||
                fixture.outputs[index]!.filters?.some((filter) => !filter.holds) ||
                fixture.outputs[index]!.valueChecks?.some(
                  ({ output: column, upperBound }) =>
                    !(Number(output[column]) > 0) ||
                    (upperBound !== undefined && Number(output[column]) > upperBound),
                )
                  ? []
                  : [Object.fromEntries(output.map((value, column) => [`X${column}`, value]))];
              if (
                canonicalVerificationJson(results[index]!.rows) !==
                canonicalVerificationJson(expected)
              )
                throw new Error(`${name} source projection ${caseIndex}/${index}`);
            }
        } finally {
          if (backend.sqlDialect) {
            for (const [index] of fixture.outputs.entries())
              await backend.execute(
                `DROP VIEW IF EXISTS ${ident(`projectionResult${caseIndex}_${index}`)}`,
              );
            for (const [index] of fixture.outputs.entries())
              await backend.execute(
                `DROP VIEW IF EXISTS ${ident(`projectionOutput${caseIndex}_${index}`)}`,
              );
            await backend.execute(`DROP TABLE IF EXISTS ${ident(`projectionItems${caseIndex}`)}`);
          }
        }
      }
      const encoded = leanMixed(value);
      checks.push(
        `example : Structural.accepts Generated.${fixture.outputs[0]!.relation}Schema ${encoded} = ${accepted} := by simp [Structural.accepts, Structural.lookup, Generated.${fixture.outputs[0]!.relation}Schema]`,
      );
      if (accepted)
        for (const [index, output] of outputs.entries()) {
          const {
            relation,
            usedIndices = [],
            filters = [],
            valueChecks = [],
            orderedOutputs,
          } = fixture.outputs[index]!;
          const indexNames = fixture.indices.map((_, index) => `i${index}`);
          const input = `(fun value ${indexNames.join(" ")} => value = ${encoded}${fixture.indices.map((n, index) => ` ∧ i${index} = (⟨(${n}), by decide⟩ : SafeInt)`).join("")})`;
          const member = fixture.indices.length
            ? `⟨${["rfl", ...fixture.indices.map(() => "rfl")].join(", ")}⟩`
            : "rfl";
          const results = output.map((_, index) => `result${index}`).join(" ");
          const foundNames = output.map((_, index) => `found${index}`).join(" ");
          const missing = output.findIndex((value) => value === undefined);
          const rejected = filters.findIndex((filter) => !filter.holds);
          const rejectedProperty = valueChecks.findIndex(
            ({ output: column, upperBound }) =>
              !(Number(output[column]) > 0) ||
              (upperBound !== undefined && Number(output[column]) > upperBound),
          );
          const orderRejected =
            orderedOutputs !== undefined &&
            !(Number(output[orderedOutputs[0]]) <= Number(output[orderedOutputs[1]]));
          const propertyRejected = rejectedProperty >= 0 || orderRejected;
          const { output: positiveOutput, upperBound } = valueChecks[rejectedProperty] ?? {};
          const propertyWitnesses = valueChecks.map(
            ({ output: column, upperBound }) =>
              `⟨⟨(${output[column]}), by decide⟩, rfl, by decide${upperBound === undefined ? "" : ", by decide"}⟩`,
          );
          if (orderedOutputs)
            propertyWitnesses.push(
              `⟨⟨(${output[orderedOutputs[0]]}), by decide⟩, ⟨(${output[orderedOutputs[1]]}), by decide⟩, rfl, rfl, by decide⟩`,
            );
          const propertyProof =
            propertyWitnesses.length === 0
              ? ""
              : `(by exact ${propertyWitnesses.length === 1 ? propertyWitnesses[0] : `⟨${propertyWitnesses.join(", ")}⟩`})`;
          const selectedProperty =
            valueChecks.length === 1
              ? "property"
              : `property${".2".repeat(Math.max(0, rejectedProperty))}${rejectedProperty === valueChecks.length - 1 ? "" : ".1"}`;
          if (missing < 0 && rejected < 0 && !propertyRejected)
            checks.push(
              `example : Generated.${relation} ${input} ${output.map((value) => leanMixed(value!)).join(" ")} := Generated.${relation}.rule (${member}) ${filters.map(() => "(by decide)").join(" ")} ${usedIndices.map(() => "(by decide)").join(" ")} ${output.map(() => "(by rfl)").join(" ")} ${propertyProof}`,
            );
          else {
            const negative = usedIndices.findIndex((index) => fixture.indices[index]! < 0);
            checks.push(`example : ¬ (∃ ${results}, Generated.${relation} ${input} ${results}) := by
  rintro ⟨${output.map((_, index) => `result${index}`).join(", ")}, derived⟩
  cases derived with
  | rule member ${filters.map((_, index) => `filter${index}`).join(" ")} ${usedIndices.map((_, index) => `nonnegative${index}`).join(" ")} ${foundNames} ${propertyWitnesses.length ? "property" : ""} =>
    ${fixture.indices.length ? `rcases member with ${member}` : "subst member"}
    ${
      orderRejected && missing < 0
        ? `rcases property with ⟨n, m, rfl, rfl, ordered⟩
    have equal1 : (⟨(${output[orderedOutputs![0]]}), by decide⟩ : SafeInt) = n := by simpa [Structural.lookupPath, Structural.step, Structural.lookup] using found${orderedOutputs![0]}
    have equal2 : (⟨(${output[orderedOutputs![1]]}), by decide⟩ : SafeInt) = m := by simpa [Structural.lookupPath, Structural.step, Structural.lookup] using found${orderedOutputs![1]}
    subst n
    subst m
    exact (by decide : ¬ ((${output[orderedOutputs![0]]} : Int) ≤ (${output[orderedOutputs![1]]} : Int))) ordered`
        : propertyRejected && missing < 0
          ? `rcases ${selectedProperty} with ⟨n, rfl, greater${upperBound === undefined ? "" : ", atMost"}⟩
    have equal : (⟨(${output[positiveOutput!]}), by decide⟩ : SafeInt) = n := by simpa [Structural.lookupPath, Structural.step, Structural.lookup] using found${positiveOutput}
    subst n
    ${Number(output[positiveOutput!]) <= 0 ? `exact (by decide : ¬ ((${output[positiveOutput!]} : Int) > 0)) greater` : `exact (by decide : ¬ ((${output[positiveOutput!]} : Int) ≤ ${upperBound})) atMost`}`
          : rejected >= 0
            ? `exact (by decide : ¬ (${filters[rejected]!.lean})) filter${rejected}`
            : negative < 0
              ? `simp [Structural.lookupPath, Structural.step, Structural.lookup] at found${missing}`
              : `exact (by decide : ¬ (0 ≤ (${fixture.indices[usedIndices[negative]!]} : Int))) nonnegative${negative}`
    }`);
          }
        }
    }

    // A dataset check catches accidental Cartesian combinations that singleton
    // fixtures cannot expose. Partial rows must not complete one another.
    const tupleDataset = [
      { values: { left: [{ n: 1 }], right: [{ rating: 10 }] }, outer: 0, inner: 0 },
      { values: { left: [{ n: 2 }], right: [{ rating: 20 }], optional: null }, outer: 0, inner: 0 },
      { values: { left: [{ n: 3 }], right: [] }, outer: 0, inner: 0 },
      { values: { left: [], right: [{ rating: 40 }], optional: null }, outer: 0, inner: 0 },
    ];
    const tupleDatasetSource = tupleProjectionSource
      .replaceAll("items", "tupleDatasetItems")
      .replaceAll("paired", "tupleDatasetPaired")
      .replaceAll("optionalPair", "tupleDatasetOptional")
      .replaceAll("repeatedPair", "tupleDatasetRepeated");
    for (const [name, backend] of backends) {
      const executor = new DatamogExecutor(backend, [
        {
          name: "tuple-projection-dataset",
          async canLoad() {
            return true;
          },
          async load(decl, target) {
            await insertRows(target, decl, tupleDataset);
            return { rowsLoaded: tupleDataset.length };
          },
        },
      ]);
      try {
        const results = await executor.execute(`${tupleDatasetSource}
output predicate tupleDatasetResult0(X, Y) :- tupleDatasetPaired(X, Y).
output predicate tupleDatasetResult1(X, Y) :- tupleDatasetOptional(X, Y).
output predicate tupleDatasetResult2(X, Y, Z) :- tupleDatasetRepeated(X, Y, Z).`);
        const expected = [
          [
            { X: 1, Y: 10 },
            { X: 2, Y: 20 },
          ],
          [{ X: 2, Y: null }],
          [
            { X: 1, Y: 1, Z: 10 },
            { X: 2, Y: 2, Z: 20 },
          ],
        ];
        const normalize = (rows: Record<string, unknown>[]) =>
          rows.map(canonicalVerificationJson).sort();
        for (const [index, rows] of expected.entries())
          if (JSON.stringify(normalize(results[index]!.rows)) !== JSON.stringify(normalize(rows)))
            throw new Error(`${name} tuple projection mixed rows: ${index}`);
      } finally {
        if (backend.sqlDialect) {
          for (const predicate of [
            "tupleDatasetResult0",
            "tupleDatasetResult1",
            "tupleDatasetResult2",
            "tupleDatasetPaired",
            "tupleDatasetOptional",
            "tupleDatasetRepeated",
          ])
            await backend.execute(`DROP VIEW IF EXISTS ${ident(predicate)}`);
          await backend.execute(`DROP TABLE IF EXISTS ${ident("tupleDatasetItems")}`);
        }
      }
    }
    // Carried identifiers are data, not a uniqueness premise: repeated IDs may
    // legitimately accompany different results, but must stay with their row.
    const carriedDataset = [
      { values: { rows: [{ n: 1, rating: null }] }, outer: 0, inner: -1, unused: -10 },
      { values: { rows: [{ n: 2, rating: 20, score: null }] }, outer: 0, inner: -1, unused: 20 },
      { values: { rows: [{ n: 3, rating: 30, score: 4 }] }, outer: 0, inner: -1, unused: -10 },
      { values: { rows: [] }, outer: 0, inner: -1, unused: 40 },
      { values: { rows: [{ n: 5, rating: 50, score: 6 }] }, outer: -1, inner: -1, unused: 50 },
    ];
    const carriedDatasetSource = carriedProjectionSource
      .replaceAll("items", "carriedDatasetItems")
      .replaceAll("identified", "carriedDatasetIdentified")
      .replaceAll("indexed", "carriedDatasetIndexed")
      .replaceAll("optionalIdentified", "carriedDatasetOptional");
    for (const [name, backend] of backends) {
      const executor = new DatamogExecutor(backend, [
        {
          name: "carried-projection-dataset",
          async canLoad() {
            return true;
          },
          async load(decl, target) {
            await insertRows(target, decl, carriedDataset);
            return { rowsLoaded: carriedDataset.length };
          },
        },
      ]);
      try {
        const results = await executor.execute(`${carriedDatasetSource}
output predicate carriedDatasetResult0(K, N) :- carriedDatasetIdentified(K, N).
output predicate carriedDatasetResult1(I, R, K, J) :- carriedDatasetIndexed(I, R, K, J).
output predicate carriedDatasetResult2(K, S) :- carriedDatasetOptional(K, S).`);
        const expected = [
          [
            { K: -10, N: 1 },
            { K: 20, N: 2 },
            { K: -10, N: 3 },
          ],
          [
            { I: 0, R: null, K: -10, J: 0 },
            { I: 0, R: 20, K: 20, J: 0 },
            { I: 0, R: 30, K: -10, J: 0 },
          ],
          [
            { K: 20, S: null },
            { K: -10, S: 4 },
          ],
        ];
        const normalize = (rows: Record<string, unknown>[]) =>
          rows.map(canonicalVerificationJson).sort();
        for (const [index, rows] of expected.entries())
          if (JSON.stringify(normalize(results[index]!.rows)) !== JSON.stringify(normalize(rows)))
            throw new Error(`${name} carried projection mixed identifiers: ${index}`);
      } finally {
        if (backend.sqlDialect) {
          for (const predicate of [
            "carriedDatasetResult0",
            "carriedDatasetResult1",
            "carriedDatasetResult2",
            "carriedDatasetIdentified",
            "carriedDatasetIndexed",
            "carriedDatasetOptional",
          ])
            await backend.execute(`DROP VIEW IF EXISTS ${ident(predicate)}`);
          await backend.execute(`DROP TABLE IF EXISTS ${ident("carriedDatasetItems")}`);
        }
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
  console.log(
    `${projectionCases.length} Lean/${backendNames.join("/")} structural projection cases passed.`,
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
    structuralProjectionCases: projectionCases.length,
    dynamicProjectionCases: dynamicInputs.length,
    tupleProjectionCases: tupleInputs.length,
    tupleProjectionDatasets: 1,
    orderedProjectionCases: bothPositiveInputs.length,
    bothPositiveProjectionCases: bothPositiveInputs.length,
    rangedProjectionCases: rangedInputs.length,
    positiveProjectionCases: positiveInputs.length,
    excludedProjectionCases: excludedInputs.length,
    filteredProjectionCases: filteredInputs.length,
    carriedProjectionCases: carriedInputs.length,
    carriedProjectionDatasets: 1,
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
