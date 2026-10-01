/** Optional end-to-end tests; ordinary bun test does not require Lean. */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProject, exportProject } from "./lean-project.ts";

const fixture = new URL("../verification/lean/examples/selected-projections/", import.meta.url)
  .pathname;
const temp = await mkdtemp(join(tmpdir(), "datamog-lean-project-e2e-"));
try {
  await cp(fixture, join(temp, "input"), { recursive: true });
  const config = join(temp, "input/plan.json");
  const output = join(temp, "project");
  const proofPath = join(output, "Datamog/Proofs.lean");
  const reportPath = join(output, "verification-result.json");
  const proofs = await Bun.file(join(fixture, "Proofs.lean")).text();
  await exportProject(config, output);
  await Bun.write(proofPath, proofs);
  await exportProject(config, output);
  // A pre-existing cache or report must not constitute verification evidence.
  await Bun.write(join(output, ".lake/build/lib/lean/Datamog/Checked.olean"), "poisoned cache");
  await Bun.write(reportPath, '{"status":"proved"}');
  const report = await checkProject(config, output);
  if (report.entries.length !== 3 || report.entries.some((entry) => entry.status !== "proved"))
    throw new Error("Expected three fresh unconditional goals");
  console.log(
    "Selected project: fresh coverage and optional-path soundness passed; local cache ignored.",
  );
  for (const [name, bad, expected] of [
    [
      "sorry",
      proofs.replace(
        /theorem Picked_coverage[\s\S]*?theorem Picked_soundness/,
        "theorem Picked_coverage : Generated.Picked_coverage := by sorry\n\ntheorem Picked_soundness",
      ),
      "sorryAx",
    ],
    [
      "weaker",
      proofs.replace(
        /theorem Picked_coverage[\s\S]*?theorem Picked_soundness/,
        "theorem Picked_coverage : True := True.intro\n\ntheorem Picked_soundness",
      ),
      "Type mismatch",
    ],
    [
      "axiom",
      proofs.replace(
        /theorem Picked_coverage[\s\S]*?theorem Picked_soundness/,
        "axiom unchecked : Generated.Picked_coverage\ntheorem Picked_coverage : Generated.Picked_coverage := unchecked\n\ntheorem Picked_soundness",
      ),
      "Unapproved axiom",
    ],
  ]) {
    await Bun.write(proofPath, bad!);
    await exportProject(config, output);
    await Bun.write(reportPath, "old success");
    let rejected = false;
    try {
      await checkProject(config, output);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(expected!)) throw error;
      rejected = true;
    }
    if (!rejected || (await Bun.file(reportPath).exists()))
      throw new Error(`Failed ${name} rejection or stale report cleanup`);
    console.log(`Selected project: ${name} rejected and previous report removed.`);
  }
  // Deterministically change the input during compilation, after the source
  // snapshot was captured. A completed build must still fail the freshness gate.
  const sourcePath = join(temp, "input/program.dl");
  const changedSource = `${await Bun.file(sourcePath).text()}\n\n`;
  await Bun.write(
    proofPath,
    `${proofs}\n#eval IO.FS.writeFile ${JSON.stringify(sourcePath)} ${JSON.stringify(changedSource)}\n`,
  );
  await exportProject(config, output);
  let changedRejected = false;
  try {
    await checkProject(config, output);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Stale or mismatched")) throw error;
    changedRejected = true;
  }
  if (!changedRejected || (await Bun.file(reportPath).exists()))
    throw new Error("A source change during checking produced a report");
  console.log("Selected project: source mutation during build rejected before report publication.");
  const integerFixture = new URL("../verification/lean/examples/selected-integer/", import.meta.url)
    .pathname;
  await cp(integerFixture, join(temp, "integer-input"), { recursive: true });
  const integerConfig = join(temp, "integer-input/plan.json");
  const integerOutput = join(temp, "integer-project");
  await exportProject(integerConfig, integerOutput);
  await Bun.write(
    join(integerOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(integerFixture, "Proofs.lean")).text(),
  );
  await exportProject(integerConfig, integerOutput);
  const integerReport = await checkProject(integerConfig, integerOutput, [
    "identityUnique",
    "successorCoverage",
    "successorTotal_refuted",
  ]);
  if (
    integerReport.entries.length !== 3 ||
    integerReport.entries.some(
      (entry) => entry.id === "successorTotal" || entry.status !== "proved",
    )
  )
    throw new Error("Integer claims did not register the exact proof/refutation goals");
  console.log(
    "Selected project: integer uniqueness, bounded coverage, and unbounded-coverage refutation passed.",
  );
  const localFixture = new URL("../verification/lean/examples/selected-local/", import.meta.url)
    .pathname;
  const localConfig = join(localFixture, "plan.json");
  const localOutput = join(temp, "local-project");
  await exportProject(localConfig, localOutput);
  await Bun.write(
    join(localOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(localFixture, "Proofs.lean")).text(),
  );
  await exportProject(localConfig, localOutput);
  const localReport = await checkProject(localConfig, localOutput, [
    "successor",
    "falseGoal_refuted",
  ]);
  if (
    localReport.entries.length !== 2 ||
    localReport.entries.some((entry) => entry.id === "falseGoal" || entry.status !== "proved")
  )
    throw new Error("Local proof/refutation registration failed");
  console.log("Selected project: independent local refinement proof and refutation passed.");
  const dependencyFixture = new URL(
    "../verification/lean/examples/selected-dependencies/",
    import.meta.url,
  ).pathname;
  const dependencyConfig = join(dependencyFixture, "plan.json");
  const dependencyOutput = join(temp, "dependency-project");
  await exportProject(dependencyConfig, dependencyOutput);
  const dependencyProofs = await Bun.file(join(dependencyFixture, "Proofs.lean")).text();
  const dependencyProofPath = join(dependencyOutput, "Datamog/Proofs.lean");
  await Bun.write(dependencyProofPath, dependencyProofs);
  await exportProject(dependencyConfig, dependencyOutput);
  const dependencyReport = await checkProject(dependencyConfig, dependencyOutput, ["resultSafe"]);
  if (
    dependencyReport.entries.length !== 3 ||
    dependencyReport.entries.some((entry) => entry.status !== "proved")
  )
    throw new Error("Expected all dependency proofs in the fresh report");
  await Bun.write(
    dependencyProofPath,
    dependencyProofs.replace(
      /theorem positiveSafe[\s\S]*?theorem forwardedSafe/,
      "theorem positiveSafe : Generated.positiveSafe := by sorry\n\ntheorem forwardedSafe",
    ),
  );
  await exportProject(dependencyConfig, dependencyOutput);
  await Bun.write(join(dependencyOutput, "verification-result.json"), "old success");
  let dependencyRejected = false;
  try {
    await checkProject(dependencyConfig, dependencyOutput, ["resultSafe"]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("sorryAx")) throw error;
    dependencyRejected = true;
  }
  if (
    !dependencyRejected ||
    (await Bun.file(join(dependencyOutput, "verification-result.json")).exists())
  )
    throw new Error("Unchecked dependency survived the consumer-only goal gate");
  console.log(
    "Selected project: complete acyclic dependencies checked; invalid prerequisite rejected with consumer-only gate.",
  );
  const recursiveFixture = new URL(
    "../verification/lean/examples/selected-recursive/",
    import.meta.url,
  ).pathname;
  await cp(recursiveFixture, join(temp, "recursive-input"), { recursive: true });
  const recursiveConfig = join(temp, "recursive-input/plan.json");
  const recursiveOutput = join(temp, "recursive-project");
  await exportProject(recursiveConfig, recursiveOutput);
  await Bun.write(
    join(recursiveOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(recursiveFixture, "Proofs.lean")).text(),
  );
  await exportProject(recursiveConfig, recursiveOutput);
  const recursiveReport = await checkProject(recursiveConfig, recursiveOutput, ["growSafe"]);
  if (recursiveReport.entries.length !== 1 || recursiveReport.entries[0]!.status !== "proved")
    throw new Error("Expected the exact derivation invariant");
  const recursiveSource = join(temp, "recursive-input/program.dl");
  await Bun.write(
    recursiveSource,
    (await Bun.file(recursiveSource).text()).replace("sample(X), X > 0", "sample(X)"),
  );
  await exportProject(recursiveConfig, recursiveOutput);
  await Bun.write(join(recursiveOutput, "verification-result.json"), "old success");
  let badBaseRejected = false;
  try {
    await checkProject(recursiveConfig, recursiveOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    badBaseRejected = true;
  }
  if (
    !badBaseRejected ||
    (await Bun.file(join(recursiveOutput, "verification-result.json")).exists())
  )
    throw new Error("Invalid recursive base case was accepted");
  console.log("Selected project: derivation induction passed; removing the base guard rejected.");
  const mutualFixture = new URL("../verification/lean/examples/selected-mutual/", import.meta.url)
    .pathname;
  await cp(mutualFixture, join(temp, "mutual-input"), { recursive: true });
  const mutualConfig = join(temp, "mutual-input/plan.json");
  const mutualOutput = join(temp, "mutual-project");
  await exportProject(mutualConfig, mutualOutput);
  await Bun.write(
    join(mutualOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(mutualFixture, "Proofs.lean")).text(),
  );
  await exportProject(mutualConfig, mutualOutput);
  const mutualReport = await checkProject(mutualConfig, mutualOutput, ["bothSafe"]);
  if (mutualReport.entries.length !== 1 || mutualReport.entries[0]!.status !== "proved")
    throw new Error("Expected joint mutual invariant");
  const mutualSource = join(temp, "mutual-input/program.dl");
  await Bun.write(
    mutualSource,
    `${await Bun.file(mutualSource).text()}\nright(X, _: X > 0) :- seed(X).\n`,
  );
  await exportProject(mutualConfig, mutualOutput);
  await Bun.write(join(mutualOutput, "verification-result.json"), "old success");
  let mutualRejected = false;
  try {
    await checkProject(mutualConfig, mutualOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("unsolved goals")) throw error;
    mutualRejected = true;
  }
  if (!mutualRejected || (await Bun.file(join(mutualOutput, "verification-result.json")).exists()))
    throw new Error("Unchecked second-member base rule accepted");
  console.log(
    "Selected project: mutual family induction passed; unsafe second-member base rejected.",
  );
  const successorFixture = new URL(
    "../verification/lean/examples/selected-mutual-successor/",
    import.meta.url,
  ).pathname;
  await cp(successorFixture, join(temp, "mutual-successor-input"), { recursive: true });
  const successorConfig = join(temp, "mutual-successor-input/plan.json");
  const successorOutput = join(temp, "mutual-successor-project");
  await exportProject(successorConfig, successorOutput);
  await Bun.write(
    join(successorOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(successorFixture, "Proofs.lean")).text(),
  );
  await exportProject(successorConfig, successorOutput);
  await checkProject(successorConfig, successorOutput, ["bothSafe"]);
  const successorSource = join(temp, "mutual-successor-input/program.dl");
  await Bun.write(
    successorSource,
    (await Bun.file(successorSource).text()).replace("X + 1", "X + 0"),
  );
  await exportProject(successorConfig, successorOutput);
  await Bun.write(join(successorOutput, "verification-result.json"), "old success");
  let stepRejected = false;
  try {
    await checkProject(successorConfig, successorOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    stepRejected = true;
  }
  if (!stepRejected || (await Bun.file(join(successorOutput, "verification-result.json")).exists()))
    throw new Error("Incorrect computed step was accepted");
  console.log(
    "Selected project: bounded mutual successor and integer boundaries passed; incorrect step rejected.",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
