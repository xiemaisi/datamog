import { expect, test } from "bun:test";
import { collectCompletionCandidates } from "../src/lib/completion-candidates.ts";

test("type aliases remain completion candidates in an unfinished type annotation", () => {
  const source = "type Person = {name: string}. input predicate p(x: Per";
  expect(collectCompletionCandidates(source, source.length)).toContainEqual({
    label: "Person",
    kind: "type",
    detail: "type alias",
  });
});

test("proof producers are type completion candidates", () => {
  const source = "nat(0) :: Zero. out(P: na";
  expect(collectCompletionCandidates(source, source.length)).toContainEqual({
    label: "nat",
    kind: "type",
    detail: "nominal proof type",
  });
});
