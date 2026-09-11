import { expect, test } from "bun:test";
import { collectAliasReferences } from "../src/lib/alias-references.ts";

test("alias navigation survives expansion and unrelated validation errors", () => {
  for (const prefix of ["", "type Broken = Unknown. "]) {
    const source = `${prefix}type Age = integer. input predicate p(x: Age).`;
    expect(collectAliasReferences(source)).toEqual([
      {
        start: source.lastIndexOf("Age"),
        end: source.lastIndexOf("Age") + 3,
        target: source.indexOf("Age"),
      },
    ]);
  }
});
