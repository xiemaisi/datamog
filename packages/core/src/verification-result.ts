import type { createVerificationManifest } from "./verification-manifest.ts";

type Manifest = Awaited<ReturnType<typeof createVerificationManifest>>;
const marker = "DATAMOG_AUDIT ";

/** Reporting for a trusted fresh build, never a certificate-import API.
 * The caller must check build success and manifest freshness first. Build tools
 * can emit arbitrary text; these records do not authenticate external proofs.
 */
export function createLeanVerificationResult(
  manifest: Manifest,
  output: string,
  requiredGoals?: readonly string[],
) {
  const goals = manifest.entries.filter((entry) => entry.kind === "goal");
  const expected = new Set(goals.map((goal) => goal.theorem));
  if (!goals.length || expected.has(undefined) || expected.size !== goals.length)
    throw new Error("Expected nonempty, uniquely named Lean goals");
  if (requiredGoals !== undefined) {
    if (!requiredGoals.length) throw new Error("No required Lean goals specified");
    for (const id of requiredGoals) {
      if (!goals.some((goal) => goal.id === id))
        throw new Error(`Unknown required Lean goal: ${id}`);
    }
  }
  const audits = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const start = line.indexOf(marker);
    if (start < 0) continue;
    const record = JSON.parse(line.slice(start + marker.length));
    if (
      !record ||
      typeof record.theorem !== "string" ||
      !Array.isArray(record.axioms) ||
      record.axioms.some((axiom: unknown) => typeof axiom !== "string") ||
      Object.keys(record).sort().join() !== "axioms,theorem"
    )
      throw new Error("Malformed Lean audit record");
    if (!expected.has(record.theorem)) throw new Error(`Unexpected audit: ${record.theorem}`);
    if (audits.has(record.theorem)) throw new Error(`Duplicate audit: ${record.theorem}`);
    audits.set(record.theorem, [...new Set<string>(record.axioms)].sort());
  }
  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const entries = goals.map((goal) => {
    const axioms = audits.get(goal.theorem!);
    if (!axioms) throw new Error(`Missing axiom audit: ${goal.id}`);
    const assumptions = [
      ...new Set(
        goal.closure.flatMap((id) => {
          const dependency = byId.get(id);
          if (!dependency) throw new Error(`Missing verification dependency: ${id}`);
          return dependency.assumptions;
        }),
      ),
    ].sort();
    return {
      id: goal.id,
      digest: goal.digest,
      theorem: goal.theorem!,
      status: assumptions.length ? ("conditional" as const) : ("proved" as const),
      assurance: manifest.context.method,
      assumptions,
      axioms,
    };
  });
  // This gate applies only to this fresh build, never to an imported report.
  for (const id of requiredGoals ?? []) {
    const entry = entries.find((entry) => entry.id === id)!;
    if (entry.status !== "proved")
      throw new Error(
        `Required Lean goal ${id} remains conditional: ${entry.assumptions.join("; ")}`,
      );
  }
  return {
    requiredGoals: [...new Set(requiredGoals ?? [])].sort(),
    schema: "datamog-verification-result-v1",
    purpose: "fresh-check-report",
    scope: "modeled-language",
    manifestDigest: manifest.digest,
    contextDigest: manifest.contextDigest,
    toolchain: manifest.context.toolchain,
    entries,
  };
}
