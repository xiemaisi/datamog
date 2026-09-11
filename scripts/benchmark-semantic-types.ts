/** Repeatable synthetic workloads; timings are observations, never test thresholds. */
import assert from "node:assert/strict";
import { cpus } from "node:os";
import { analyze, inferTypes } from "../packages/core/src/index.ts";
import { inferSemanticColumns } from "../packages/core/src/semantic-inference.ts";
import {
  NEVER,
  type SemanticType,
  SemanticTypeLimitError,
  intersectTypes,
  isSemanticSubtype,
  scalarType,
  unionType,
} from "../packages/core/src/semantic-type.ts";
import {
  compileStructuralColumnValidator,
  validateStructuralColumn,
} from "../packages/core/src/structural-declarations.ts";
import { parse } from "../packages/parser/src/index.ts";

const samples = Number(process.env.DATAMOG_BENCH_SAMPLES ?? 7);
assert(Number.isSafeInteger(samples) && samples >= 1 && samples <= 100, "samples must be 1–100");
const results: Record<string, unknown>[] = [];

function measure<T>(
  name: string,
  iterations: number,
  run: () => T,
  verify: (result: T) => void,
  dimensions: Record<string, number | string> = {},
): void {
  // Warmup and correctness checks are outside each measured interval. No forced GC:
  // these figures include the allocations and collection caused by repeated work.
  for (let i = 0; i < 2; i++) verify(run());
  const times: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let result: T | undefined;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) result = run();
    times.push((performance.now() - start) / iterations);
    verify(result as T);
  }
  times.sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const median = times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
  results.push({
    name,
    ...dimensions,
    iterations,
    medianMs: median,
    minMs: times[0],
    maxMs: times.at(-1),
  });
}

const integer = scalarType("integer");
const float = scalarType("float");
const string = scalarType("string");
const record = (width: number, type: SemanticType): SemanticType => ({
  kind: "record",
  fields: Array.from({ length: width }, (_, i) => ({ name: `f${i}`, optional: false, type })),
  additional: NEVER,
});

for (const rules of [32, 128, 512]) {
  const source = `${Array.from({ length: rules }, (_, i) => `p${i}(X) :- p${i + 1}(X).`).join("\n")}\np${rules}({"n": 1}).`;
  // Parsing, analysis, primitive/nullness inference and operand lowering are fixture
  // setup here. Each timed call creates a fresh semantic fixed point and registry.
  const typed = inferTypes(analyze(parse(source)));
  const expected = typed.semanticColumnTypes.get("p0");
  assert.equal(expected?.[0]?.kind, "record");
  measure(
    "inference/private-chain",
    3,
    () => inferSemanticColumns(typed),
    (result) => {
      assert.deepEqual(result.semanticColumnTypes.get("p0"), expected);
    },
    { rules: rules + 1 },
  );
  measure(
    "inference/published-chain",
    3,
    () => inferSemanticColumns(typed, typed.semanticColumnTypes),
    (result) => {
      assert.deepEqual(result.semanticColumnTypes.get("p0"), expected);
    },
    { rules: rules + 1 },
  );
}

for (const predicates of [8, 32]) {
  const source = Array.from(
    { length: predicates },
    (_, i) => `p${i}(1). p${i}([X]) :- p${i}(X).`,
  ).join("\n");
  const typed = inferTypes(analyze(parse(source)));
  measure(
    "inference/recursive-shapes",
    3,
    () => inferSemanticColumns(typed),
    (result) => {
      for (const columns of result.semanticColumnTypes.values()) {
        let nested = integer;
        for (let depth = 0; depth < 12; depth++) {
          assert(isSemanticSubtype(nested, columns[0]!));
          nested = { kind: "tuple", elements: [nested] };
        }
      }
    },
    { predicates, rules: predicates * 2 },
  );
}

for (const fields of [8, 64, 256]) {
  const source = record(fields, integer);
  const target = record(fields, float);
  measure(
    "relation/record-subtype",
    30,
    () => isSemanticSubtype(source, target),
    (result) => assert.equal(result, true),
    { fields },
  );
  measure(
    "relation/record-intersection",
    30,
    () => intersectTypes(source, target),
    (result) => assert.deepEqual(result, intersectTypes(source, source)),
    { fields },
  );
}

for (const choices of [2, 4, 6]) {
  const source: SemanticType = {
    kind: "tuple",
    elements: Array.from({ length: choices }, () => unionType(integer, string)),
  };
  const target = unionType(
    ...Array.from(
      { length: 2 ** choices },
      (_, mask): SemanticType => ({
        kind: "tuple",
        elements: Array.from({ length: choices }, (_, bit) =>
          mask & (1 << bit) ? integer : string,
        ),
      }),
    ),
  );
  for (const maxWork of [1_000_000, 16_000_000]) {
    const run = (): "accepted" | "unproven" | "work-limit" => {
      try {
        return isSemanticSubtype(source, target, { maxWork }) ? "accepted" : "unproven";
      } catch (error) {
        if (error instanceof SemanticTypeLimitError) return "work-limit";
        throw error;
      }
    };
    const outcome = run();
    assert.notEqual(outcome, "unproven");
    if (maxWork === 16_000_000) assert.equal(outcome, "accepted");
    measure("relation/collective-coverage", 3, run, (result) => assert.equal(result, outcome), {
      choices,
      alternatives: 2 ** choices,
      maxWork,
      outcome,
    });
  }
}

const column = analyze(
  parse("input predicate p(x: {name: string, age?: integer, scores: [float?]})."),
).extDecls.get("p")!.columns[0]!;
const row = { name: "Ada", age: 37, scores: [1, 2.5, null] };
const rows = Array.from({ length: 10_000 }, (_, i) => ({ ...row, name: `person-${i}` }));
measure(
  "validation/prepare",
  100,
  () => compileStructuralColumnValidator(column),
  (validate) => {
    validate(row, "benchmark");
  },
);
const validate = compileStructuralColumnValidator(column);
measure(
  "validation/prepared-batch",
  1,
  () => {
    for (const row of rows) validate(row, "benchmark");
    return rows.length;
  },
  (count) => assert.equal(count, rows.length),
  { rows: rows.length },
);
measure(
  "validation/prepare-per-cell",
  1,
  () => {
    for (const row of rows) validateStructuralColumn(row, column, "benchmark");
    return rows.length;
  },
  (count) => assert.equal(count, rows.length),
  { rows: rows.length },
);

for (const depth of [4, 12, 32]) {
  let shape = "{n: integer}?";
  let value: unknown = { n: "bad" };
  for (let i = 0; i < depth; i++) {
    shape = `{child: ${shape}}?`;
    value = { child: value };
  }
  const column = analyze(parse(`input predicate p(x: ${shape}).`)).extDecls.get("p")!.columns[0]!;
  const validate = compileStructuralColumnValidator(column);
  const expected = `benchmark, column 'x': $${'["child"]'.repeat(depth)}["n"]: expected integer`;
  measure(
    "validation/nullable-failure",
    100,
    () => {
      try {
        validate(value, "benchmark");
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    },
    (message) => assert.equal(message, expected),
    { depth: depth + 1 },
  );
}

console.log(
  JSON.stringify(
    {
      environment: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
      },
      samples,
      warmupCalls: 2,
      unit: "milliseconds per operation (a validation batch is one operation)",
      results,
    },
    null,
    2,
  ),
);
