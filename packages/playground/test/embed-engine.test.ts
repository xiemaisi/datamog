import { describe, expect, test } from "bun:test";
import type { IterationCapInfo } from "datamog-backend-native";
import { collectCompletionCandidates, lintSource, runProgram } from "../src/embed/engine.ts";

const REACHABILITY = `input predicate edge(src: string, dst: string).

reachable(X) :- edge("a", X).
reachable(X) :- edge(Y, X), reachable(Y).

?- reachable(X).`;

const EDGES = "src,dst\na,b\nb,c\nc,d\nx,y";

describe("embed engine", () => {
  test("runProgram evaluates against pre-baked CSV data", async () => {
    const results = await runProgram(REACHABILITY, { csv: { edge: EDGES } });
    expect(results).toHaveLength(1);
    const values = results[0]!.rows.map((r) => Object.values(r)[0]).sort();
    expect(values).toEqual(["b", "c", "d"]);
  });

  test("ground query collapses to yes (one empty-record row)", async () => {
    const yes = REACHABILITY.replace("?- reachable(X).", '?- reachable("d").');
    const results = await runProgram(yes, { csv: { edge: EDGES } });
    expect(results[0]!.rows).toHaveLength(1);
    expect(Object.keys(results[0]!.rows[0]!)).toHaveLength(0);
  });

  test("ground query with no match collapses to no (zero rows)", async () => {
    const no = REACHABILITY.replace("?- reachable(X).", '?- reachable("zzz").');
    const results = await runProgram(no, { csv: { edge: EDGES } });
    expect(results[0]!.rows).toHaveLength(0);
  });

  test("runProgram caps a non-terminating program and reports it", async () => {
    // Without the default cap this counts up forever and freezes the tab.
    const runaway = `seed(0).
      s(X) :- seed(X).
      s(Y) :- s(X), Y = X + 1.
      ?- s(N).`;
    let capInfo: IterationCapInfo | undefined;
    const results = await runProgram(runaway, {}, "native", {
      maxIterations: 20,
      onIterationCap: (info) => {
        capInfo = info;
      },
    });
    expect(capInfo).toBeDefined();
    expect(capInfo?.predicates).toContain("s");
    // Partial prefix returned, not a hang and not empty.
    expect(results[0]!.rows).toHaveLength(20);
  });

  test("lintSource: valid program has no errors and reports a query", () => {
    const { diagnostics, hasQueries } = lintSource(REACHABILITY);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(hasQueries).toBe(true);
  });

  test("lintSource: parse error becomes a positioned error diagnostic", () => {
    const { diagnostics, hasQueries } = lintSource("input predicate edge(");
    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.from).toBeGreaterThanOrEqual(0);
    expect(hasQueries).toBe(false);
  });

  test("collectCompletionCandidates includes declared predicates", () => {
    const candidates = collectCompletionCandidates(REACHABILITY, REACHABILITY.length);
    const edge = candidates.find((c) => c.label === "edge");
    const reachable = candidates.find((c) => c.label === "reachable");
    expect(edge?.kind).toBe("predicate-ext");
    expect(reachable?.kind).toBe("predicate-idb");
  });
});
