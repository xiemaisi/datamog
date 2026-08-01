import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Examples opt into the playground by carrying a `playground.json` file in
// their CLI example directory; `src/examples/index.ts` discovers them at build
// time via `import.meta.glob`. Validate every such file here so a malformed
// entry or a renamed `.dl` fails in `bun test` rather than silently dropping
// the example from the dropdown (or only surfacing as a Vite build error).
const CLI_EXAMPLES = join(import.meta.dir, "..", "..", "cli", "examples");

const registered = readdirSync(CLI_EXAMPLES).filter((dir) =>
  existsSync(join(CLI_EXAMPLES, dir, "playground.json")),
);

describe("playground examples", () => {
  test("at least one example is registered", () => {
    expect(registered.length).toBeGreaterThan(0);
  });

  for (const dir of registered) {
    test(`${dir}: playground.json is valid and points to a .dl`, async () => {
      const meta = (await Bun.file(join(CLI_EXAMPLES, dir, "playground.json")).json()) as Record<
        string,
        unknown
      >;
      expect(typeof meta.name).toBe("string");
      expect(typeof meta.description).toBe("string");
      expect(typeof meta.order).toBe("number");
      // index.ts loads `<dir>/<dir>.dl`, so the basename must match the dir.
      expect(existsSync(join(CLI_EXAMPLES, dir, `${dir}.dl`))).toBe(true);
    });
  }
});

// `native-only` marks an example no SQL backend can run (non-linear recursion,
// or parity-stratified recursion). The CLI example suite keys its skips off
// this marker; `src/examples/index.ts` globs the same file so the app can
// switch to an interpreter when one is loaded. That wiring only exists after
// Vite resolves the glob, so it is tested in the browser by
// `e2e/native-only-example.e2e.ts`. What is worth asserting here is that the
// marker is actually in play: with no registered example carrying it, the e2e
// test would pass vacuously.
describe("playground examples: native-only marker", () => {
  test("some registered examples are native-only", () => {
    const nativeOnly = registered.filter((dir) =>
      existsSync(join(CLI_EXAMPLES, dir, "native-only")),
    );
    expect(nativeOnly.length).toBeGreaterThan(0);
  });
});
