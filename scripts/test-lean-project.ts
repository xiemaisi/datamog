/** Optional end-to-end tests; ordinary bun test does not require Lean. */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationDigest } from "../packages/core/src/verification-manifest.ts";
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
  const savedReport = await Bun.file(reportPath).json();
  if (
    JSON.stringify(savedReport) !== JSON.stringify(report) ||
    report.verificationPlan.digest !== report.manifestDigest ||
    report.sourceSnapshot.text !== (await Bun.file(join(temp, "input/program.dl")).text()) ||
    report.selectionSnapshot.text !== (await Bun.file(config).text()) ||
    (await verificationDigest(report.sourceSnapshot.text)) !==
      report.verificationPlan.context.artifacts.source ||
    (await verificationDigest(report.selectionSnapshot.text)) !==
      report.verificationPlan.context.artifacts.selection
  )
    throw new Error("Fresh report lost its exact source, selection, or checked plan");
  for (const result of report.entries) {
    const goal = report.verificationPlan.entries.find((entry) => entry.id === result.id);
    if (
      !goal ||
      goal.kind !== "goal" ||
      goal.digest !== result.digest ||
      !goal.statement ||
      goal.closure.some((id) => !report.verificationPlan.entries.some((entry) => entry.id === id))
    )
      throw new Error("Fresh report lacks an exact checked goal or dependency");
  }
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
  const tupleFixture = new URL(
    "../verification/lean/examples/selected-mutual-tuples/",
    import.meta.url,
  ).pathname;
  await cp(tupleFixture, join(temp, "mutual-tuple-input"), { recursive: true });
  const tupleConfig = join(temp, "mutual-tuple-input/plan.json");
  const tupleOutput = join(temp, "mutual-tuple-project");
  await exportProject(tupleConfig, tupleOutput);
  await Bun.write(
    join(tupleOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(tupleFixture, "Proofs.lean")).text(),
  );
  await exportProject(tupleConfig, tupleOutput);
  await checkProject(tupleConfig, tupleOutput, ["bothSafe"]);
  const tupleSource = join(temp, "mutual-tuple-input/program.dl");
  await Bun.write(
    tupleSource,
    (await Bun.file(tupleSource).text()).replace(
      "X + 1 as A, Y + 1 as B",
      "Y + 1 as A, X + 1 as B",
    ),
  );
  await exportProject(tupleConfig, tupleOutput);
  await Bun.write(join(tupleOutput, "verification-result.json"), "old success");
  let tupleRejected = false;
  try {
    await checkProject(tupleConfig, tupleOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    tupleRejected = true;
  }
  if (!tupleRejected || (await Bun.file(join(tupleOutput, "verification-result.json")).exists()))
    throw new Error("Swapped computed columns were accepted");
  console.log(
    "Selected project: mutual tuple order invariant passed; swapped computed outputs rejected.",
  );
  const mixedFixture = new URL(
    "../verification/lean/examples/selected-mutual-mixed/",
    import.meta.url,
  ).pathname;
  await cp(mixedFixture, join(temp, "mutual-mixed-input"), { recursive: true });
  const mixedConfig = join(temp, "mutual-mixed-input/plan.json");
  const mixedOutput = join(temp, "mutual-mixed-project");
  await exportProject(mixedConfig, mixedOutput);
  await Bun.write(
    join(mixedOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(mixedFixture, "Proofs.lean")).text(),
  );
  await exportProject(mixedConfig, mixedOutput);
  await checkProject(mixedConfig, mixedOutput, ["bothSafe"]);
  const mixedSource = join(temp, "mutual-mixed-input/program.dl");
  await Bun.write(mixedSource, (await Bun.file(mixedSource).text()).replace("X + 1", "X + 0"));
  await exportProject(mixedConfig, mixedOutput);
  await Bun.write(join(mixedOutput, "verification-result.json"), "old success");
  let mixedRejected = false;
  try {
    await checkProject(mixedConfig, mixedOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    mixedRejected = true;
  }
  if (!mixedRejected || (await Bun.file(join(mixedOutput, "verification-result.json")).exists()))
    throw new Error("Invalid mixed-arity step was accepted");
  console.log(
    "Selected project: mixed arities and canonical padding checked; invalid step rejected.",
  );
  const flagsFixture = new URL(
    "../verification/lean/examples/selected-mutual-flags/",
    import.meta.url,
  ).pathname;
  await cp(flagsFixture, join(temp, "mutual-flags-input"), { recursive: true });
  const flagsConfig = join(temp, "mutual-flags-input/plan.json");
  const flagsOutput = join(temp, "mutual-flags-project");
  await exportProject(flagsConfig, flagsOutput);
  await Bun.write(
    join(flagsOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(flagsFixture, "Proofs.lean")).text(),
  );
  await exportProject(flagsConfig, flagsOutput);
  const flagsReport = await checkProject(flagsConfig, flagsOutput);
  if (flagsReport.entries.length !== 2 || flagsReport.entries.some((e) => e.status !== "proved"))
    throw new Error("Expected both nullary goals");
  const flagsSource = join(temp, "mutual-flags-input/program.dl");
  await Bun.write(flagsSource, `${await Bun.file(flagsSource).text()}\nemptyA(_: 0 > 0).\n`);
  await exportProject(flagsConfig, flagsOutput);
  await Bun.write(join(flagsOutput, "verification-result.json"), "old success");
  let flagsRejected = false;
  try {
    await checkProject(flagsConfig, flagsOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("assumption")) throw error;
    flagsRejected = true;
  }
  if (!flagsRejected || (await Bun.file(join(flagsOutput, "verification-result.json")).exists()))
    throw new Error("Added nullary base fact was accepted");
  console.log(
    "Selected project: nullary members and empty-cycle induction passed; new base fact rejected.",
  );
  const descentFixture = new URL(
    "../verification/lean/examples/selected-mutual-descent/",
    import.meta.url,
  ).pathname;
  await cp(descentFixture, join(temp, "mutual-descent-input"), { recursive: true });
  const descentConfig = join(temp, "mutual-descent-input/plan.json");
  const descentOutput = join(temp, "mutual-descent-project");
  await exportProject(descentConfig, descentOutput);
  await Bun.write(
    join(descentOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(descentFixture, "Proofs.lean")).text(),
  );
  await exportProject(descentConfig, descentOutput);
  await checkProject(descentConfig, descentOutput, ["bothSafe"]);
  const descentSource = join(temp, "mutual-descent-input/program.dl");
  await Bun.write(descentSource, (await Bun.file(descentSource).text()).replace("X > 0", "X >= 0"));
  await exportProject(descentConfig, descentOutput);
  await Bun.write(join(descentOutput, "verification-result.json"), "old success");
  let descentRejected = false;
  try {
    await checkProject(descentConfig, descentOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    descentRejected = true;
  }
  if (
    !descentRejected ||
    (await Bun.file(join(descentOutput, "verification-result.json")).exists())
  )
    throw new Error("Unsafe decrement guard was accepted");
  console.log(
    "Selected project: mutual descent and lower bounds checked; unsafe zero step rejected.",
  );
  const refutationFixture = new URL(
    "../verification/lean/examples/selected-mutual-refutation/",
    import.meta.url,
  ).pathname;
  await cp(refutationFixture, join(temp, "mutual-refutation-input"), { recursive: true });
  const refutationConfig = join(temp, "mutual-refutation-input/plan.json");
  const refutationOutput = join(temp, "mutual-refutation-project");
  await exportProject(refutationConfig, refutationOutput);
  await Bun.write(
    join(refutationOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(refutationFixture, "Proofs.lean")).text(),
  );
  await exportProject(refutationConfig, refutationOutput);
  const refutationReport = await checkProject(refutationConfig, refutationOutput, [
    "bothSafe_refuted",
  ]);
  if (
    refutationReport.entries.length !== 1 ||
    refutationReport.entries[0]!.id !== "bothSafe_refuted" ||
    refutationReport.entries[0]!.status !== "proved"
  )
    throw new Error("False mutual claim reported as proved");
  if (
    refutationReport.verificationPlan.entries.find((entry) => entry.id === "bothSafe")?.kind !==
      "definition" ||
    refutationReport.verificationPlan.entries.find((entry) => entry.id === "bothSafe_refuted")
      ?.kind !== "goal" ||
    JSON.parse(refutationReport.selectionSnapshot.text).claims[0].polarity !== "refute"
  )
    throw new Error("Self-contained report lost refutation polarity");
  const refutationSource = join(temp, "mutual-refutation-input/program.dl");
  await Bun.write(
    refutationSource,
    (await Bun.file(refutationSource).text()).replace("X + 0", "X + 1"),
  );
  await exportProject(refutationConfig, refutationOutput);
  await Bun.write(join(refutationOutput, "verification-result.json"), "old success");
  let repairedRejected = false;
  try {
    await checkProject(refutationConfig, refutationOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("rfl")) throw error;
    repairedRejected = true;
  }
  if (
    !repairedRejected ||
    (await Bun.file(join(refutationOutput, "verification-result.json")).exists())
  )
    throw new Error("Obsolete mutual counterexample was accepted");
  console.log(
    "Selected project: exact mutual refutation passed; repaired rule invalidates counterexample.",
  );
  const singleRefutationFixture = new URL(
    "../verification/lean/examples/selected-recursive-refutation/",
    import.meta.url,
  ).pathname;
  await cp(singleRefutationFixture, join(temp, "single-refutation-input"), { recursive: true });
  const singleRefutationConfig = join(temp, "single-refutation-input/plan.json");
  const singleRefutationOutput = join(temp, "single-refutation-project");
  await exportProject(singleRefutationConfig, singleRefutationOutput);
  await Bun.write(
    join(singleRefutationOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(singleRefutationFixture, "Proofs.lean")).text(),
  );
  await exportProject(singleRefutationConfig, singleRefutationOutput);
  const singleRefutationReport = await checkProject(
    singleRefutationConfig,
    singleRefutationOutput,
    ["growSafe_refuted"],
  );
  if (
    singleRefutationReport.entries.length !== 1 ||
    singleRefutationReport.entries[0]!.id !== "growSafe_refuted" ||
    singleRefutationReport.entries[0]!.status !== "proved"
  )
    throw new Error("False recursive invariant reported as proved");
  const singleRefutationSource = join(temp, "single-refutation-input/program.dl");
  await Bun.write(
    singleRefutationSource,
    (await Bun.file(singleRefutationSource).text()).replace("X + 1", "X + 0"),
  );
  await exportProject(singleRefutationConfig, singleRefutationOutput);
  await Bun.write(join(singleRefutationOutput, "verification-result.json"), "old success");
  let singleRepairedRejected = false;
  try {
    await checkProject(singleRefutationConfig, singleRefutationOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("rfl")) throw error;
    singleRepairedRejected = true;
  }
  if (
    !singleRepairedRejected ||
    (await Bun.file(join(singleRefutationOutput, "verification-result.json")).exists())
  )
    throw new Error("Obsolete recursive counterexample was accepted");
  console.log(
    "Selected project: recursive invariant refutation passed; repaired step rejects the counterexample.",
  );
  const booleanFixture = new URL(
    "../verification/lean/examples/selected-boolean-contracts/",
    import.meta.url,
  ).pathname;
  await cp(booleanFixture, join(temp, "boolean-input"), { recursive: true });
  const booleanConfig = join(temp, "boolean-input/plan.json");
  const booleanOutput = join(temp, "boolean-project");
  await exportProject(booleanConfig, booleanOutput);
  await Bun.write(
    join(booleanOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(booleanFixture, "Proofs.lean")).text(),
  );
  await exportProject(booleanConfig, booleanOutput);
  const booleanReport = await checkProject(booleanConfig, booleanOutput);
  if (
    booleanReport.entries.length !== 2 ||
    booleanReport.entries.some((e) => e.status !== "proved")
  )
    throw new Error("Expected both Boolean contract goals");
  const booleanSource = join(temp, "boolean-input/program.dl");
  await Bun.write(
    booleanSource,
    (await Bun.file(booleanSource).text()).replaceAll("X < 3", "X <= 3"),
  );
  await exportProject(booleanConfig, booleanOutput);
  await Bun.write(join(booleanOutput, "verification-result.json"), "old success");
  let booleanRejected = false;
  try {
    await checkProject(booleanConfig, booleanOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    booleanRejected = true;
  }
  if (
    !booleanRejected ||
    (await Bun.file(join(booleanOutput, "verification-result.json")).exists())
  )
    throw new Error("Invalid Boolean contract boundary was accepted");
  console.log(
    "Selected project: Boolean invariant junctions passed; out-of-interval step rejected.",
  );
  const negatedFixture = new URL(
    "../verification/lean/examples/selected-negated-contracts/",
    import.meta.url,
  ).pathname;
  await cp(negatedFixture, join(temp, "negated-input"), { recursive: true });
  const negatedConfig = join(temp, "negated-input/plan.json");
  const negatedOutput = join(temp, "negated-project");
  await exportProject(negatedConfig, negatedOutput);
  await Bun.write(
    join(negatedOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(negatedFixture, "Proofs.lean")).text(),
  );
  await exportProject(negatedConfig, negatedOutput);
  const negatedReport = await checkProject(negatedConfig, negatedOutput);
  if (
    negatedReport.entries.length !== 2 ||
    negatedReport.entries.some((e) => e.status !== "proved")
  )
    throw new Error("Expected both negated contract goals");
  const negatedSource = join(temp, "negated-input/program.dl");
  await Bun.write(negatedSource, (await Bun.file(negatedSource).text()).replaceAll("> 3", "> 2"));
  await exportProject(negatedConfig, negatedOutput);
  await Bun.write(join(negatedOutput, "verification-result.json"), "old success");
  let negatedRejected = false;
  try {
    await checkProject(negatedConfig, negatedOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    negatedRejected = true;
  }
  if (
    !negatedRejected ||
    (await Bun.file(join(negatedOutput, "verification-result.json")).exists())
  )
    throw new Error("False tightened negated contract was accepted");
  console.log(
    "Selected project: negated invariant contracts passed; false tightened bound rejected.",
  );
  const pipelineFixture = new URL(
    "../verification/lean/examples/selected-program-invariant/",
    import.meta.url,
  ).pathname;
  await cp(pipelineFixture, join(temp, "pipeline-input"), { recursive: true });
  const pipelineConfig = join(temp, "pipeline-input/plan.json");
  const pipelineOutput = join(temp, "pipeline-project");
  await exportProject(pipelineConfig, pipelineOutput);
  await Bun.write(
    join(pipelineOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(pipelineFixture, "Proofs.lean")).text(),
  );
  await exportProject(pipelineConfig, pipelineOutput);
  const pipelineReport = await checkProject(pipelineConfig, pipelineOutput);
  if (pipelineReport.entries.length !== 1 || pipelineReport.entries[0]?.status !== "proved")
    throw new Error("Expected composed program invariant proof");
  const pipelineSource = join(temp, "pipeline-input/program.dl");
  const originalPipeline = await Bun.file(pipelineSource).text();
  for (const changed of [
    originalPipeline.replace(", X > 0.", "."),
    `${originalPipeline}\nvalidated(X) :- seed(X).`,
  ]) {
    await Bun.write(pipelineSource, changed);
    await exportProject(pipelineConfig, pipelineOutput);
    await Bun.write(join(pipelineOutput, "verification-result.json"), "old success");
    let rejected = false;
    try {
      await checkProject(pipelineConfig, pipelineOutput);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
      rejected = true;
    }
    if (!rejected || (await Bun.file(join(pipelineOutput, "verification-result.json")).exists()))
      throw new Error("Unsafe upstream rule accepted by downstream proof");
  }
  console.log(
    "Selected project: composed invariant passed; weakened upstream guard and extra unsafe sibling rejected.",
  );
  const uniqueFixture = new URL(
    "../verification/lean/examples/selected-program-uniqueness/",
    import.meta.url,
  ).pathname;
  await cp(uniqueFixture, join(temp, "unique-input"), { recursive: true });
  const uniqueConfig = join(temp, "unique-input/plan.json");
  const uniqueOutput = join(temp, "unique-project");
  await exportProject(uniqueConfig, uniqueOutput);
  await Bun.write(
    join(uniqueOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(uniqueFixture, "Proofs.lean")).text(),
  );
  await exportProject(uniqueConfig, uniqueOutput);
  const uniqueReport = await checkProject(uniqueConfig, uniqueOutput);
  if (uniqueReport.entries.length !== 1 || uniqueReport.entries[0]?.status !== "proved")
    throw new Error("Expected composed uniqueness proof");
  const uniqueSource = join(temp, "unique-input/program.dl");
  await Bun.write(
    uniqueSource,
    `${await Bun.file(uniqueSource).text()}\nidentity(X, X + 1) :- seed(X).`,
  );
  await exportProject(uniqueConfig, uniqueOutput);
  await Bun.write(join(uniqueOutput, "verification-result.json"), "old success");
  let uniqueRejected = false;
  try {
    await checkProject(uniqueConfig, uniqueOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("simp_all made no progress"))
      throw error;
    uniqueRejected = true;
  }
  if (!uniqueRejected || (await Bun.file(join(uniqueOutput, "verification-result.json")).exists()))
    throw new Error("Nonunique upstream sibling accepted by downstream uniqueness proof");
  console.log("Selected project: composed uniqueness passed; upstream second output rejected.");
  const coverageFixture = new URL(
    "../verification/lean/examples/selected-program-coverage/",
    import.meta.url,
  ).pathname;
  await cp(coverageFixture, join(temp, "coverage-input"), { recursive: true });
  const coverageConfig = join(temp, "coverage-input/plan.json");
  const coverageOutput = join(temp, "coverage-project");
  await exportProject(coverageConfig, coverageOutput);
  await Bun.write(
    join(coverageOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(coverageFixture, "Proofs.lean")).text(),
  );
  await exportProject(coverageConfig, coverageOutput);
  const coverageReport = await checkProject(coverageConfig, coverageOutput);
  if (
    coverageReport.entries.length !== 2 ||
    coverageReport.entries.some((e) => e.status !== "proved")
  )
    throw new Error("Expected composed coverage and totality refutation");
  const coverageSource = join(temp, "coverage-input/program.dl");
  const coverageOriginal = await Bun.file(coverageSource).text();
  const coveragePlanOriginal = await Bun.file(coverageConfig).text();
  for (const mutation of ["guard", "bound"] as const) {
    await Bun.write(
      coverageSource,
      mutation === "guard" ? coverageOriginal.replace("X >= 0", "X > 0") : coverageOriginal,
    );
    const plan = JSON.parse(coveragePlanOriginal);
    if (mutation === "bound") plan.claims[0].bounds[1].op = "<=";
    await Bun.write(coverageConfig, JSON.stringify(plan));
    await exportProject(coverageConfig, coverageOutput);
    await Bun.write(join(coverageOutput, "verification-result.json"), "old success");
    let rejected = false;
    try {
      await checkProject(coverageConfig, coverageOutput);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes(mutation === "guard" ? "type mismatch" : "omega")
      )
        throw error;
      rejected = true;
    }
    if (!rejected || (await Bun.file(join(coverageOutput, "verification-result.json")).exists()))
      throw new Error("Invalid composed coverage admitted by fresh check");
  }
  console.log(
    "Selected project: composed coverage and refutation passed; stricter upstream guard and overflowing input bound rejected.",
  );
  const equivalenceFixture = new URL(
    "../verification/lean/examples/selected-program-equivalence/",
    import.meta.url,
  ).pathname;
  await cp(equivalenceFixture, join(temp, "equivalence-input"), { recursive: true });
  const equivalenceConfig = join(temp, "equivalence-input/plan.json");
  const equivalenceOutput = join(temp, "equivalence-project");
  await exportProject(equivalenceConfig, equivalenceOutput);
  await Bun.write(
    join(equivalenceOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(equivalenceFixture, "Proofs.lean")).text(),
  );
  await exportProject(equivalenceConfig, equivalenceOutput);
  const equivalenceReport = await checkProject(equivalenceConfig, equivalenceOutput);
  if (
    equivalenceReport.entries.length !== 2 ||
    equivalenceReport.entries.some((e) => e.status !== "proved")
  )
    throw new Error("Expected composed equivalence and filtered refutation");
  const equivalenceSource = join(temp, "equivalence-input/program.dl");
  const equivalenceOriginal = await Bun.file(equivalenceSource).text();
  for (const predicate of ["first", "helper"]) {
    await Bun.write(
      equivalenceSource,
      equivalenceOriginal.replace(
        `${predicate}(X) :- seed(X).`,
        `${predicate}(X) :- seed(X), X > 0.`,
      ),
    );
    await exportProject(equivalenceConfig, equivalenceOutput);
    await Bun.write(join(equivalenceOutput, "verification-result.json"), "old success");
    let rejected = false;
    try {
      await checkProject(equivalenceConfig, equivalenceOutput);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("error: Datamog/Proofs.lean"))
        throw error;
      rejected = true;
    }
    if (!rejected || (await Bun.file(join(equivalenceOutput, "verification-result.json")).exists()))
      throw new Error("One-sided inclusion accepted as equivalence");
  }
  console.log(
    "Selected project: composed equivalence and refutation passed; losses on either side rejected.",
  );
  const emptinessFixture = new URL(
    "../verification/lean/examples/selected-program-emptiness/",
    import.meta.url,
  ).pathname;
  await cp(emptinessFixture, join(temp, "emptiness-input"), { recursive: true });
  const emptinessConfig = join(temp, "emptiness-input/plan.json");
  const emptinessOutput = join(temp, "emptiness-project");
  await exportProject(emptinessConfig, emptinessOutput);
  await Bun.write(
    join(emptinessOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(emptinessFixture, "Proofs.lean")).text(),
  );
  await exportProject(emptinessConfig, emptinessOutput);
  const emptinessReport = await checkProject(emptinessConfig, emptinessOutput);
  if (
    emptinessReport.entries.length !== 3 ||
    emptinessReport.entries.some((e) => e.status !== "proved")
  )
    throw new Error("Expected violation and base-free cycle emptiness plus nonempty refutation");
  const emptinessSource = join(temp, "emptiness-input/program.dl");
  const emptinessOriginal = await Bun.file(emptinessSource).text();
  for (const changed of [
    emptinessOriginal.replace("X > 0", "X >= 0"),
    `${emptinessOriginal}\nviolation(X) :- seed(X).`,
  ]) {
    await Bun.write(emptinessSource, changed);
    await exportProject(emptinessConfig, emptinessOutput);
    await Bun.write(join(emptinessOutput, "verification-result.json"), "old success");
    let rejected = false;
    try {
      await checkProject(emptinessConfig, emptinessOutput);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("error: Datamog/Proofs.lean"))
        throw error;
      rejected = true;
    }
    if (!rejected || (await Bun.file(join(emptinessOutput, "verification-result.json")).exists()))
      throw new Error("Reachable violation accepted as empty");
  }
  console.log(
    "Selected project: violation and base-free cycle emptiness plus refutation passed; reachable violations rejected.",
  );
  const constraintFixture = new URL(
    "../verification/lean/examples/selected-constraints/",
    import.meta.url,
  ).pathname;
  await cp(constraintFixture, join(temp, "constraint-input"), { recursive: true });
  const constraintConfig = join(temp, "constraint-input/plan.json");
  const constraintOutput = join(temp, "constraint-project");
  await exportProject(constraintConfig, constraintOutput);
  await Bun.write(
    join(constraintOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(constraintFixture, "Proofs.lean")).text(),
  );
  await exportProject(constraintConfig, constraintOutput);
  const constraintReport = await checkProject(constraintConfig, constraintOutput);
  if (
    constraintReport.entries.length !== 2 ||
    constraintReport.entries.some((e) => e.status !== "proved")
  )
    throw new Error("Expected explicit constraint proof and input-law refutation");
  const constraintSource = join(temp, "constraint-input/program.dl");
  const constraintOriginal = await Bun.file(constraintSource).text();
  for (const changed of [
    constraintOriginal.replace("X > 0", "X >= 0"),
    constraintOriginal.replace("X <= 0", "X <= 1"),
  ]) {
    await Bun.write(constraintSource, changed);
    await exportProject(constraintConfig, constraintOutput);
    await Bun.write(join(constraintOutput, "verification-result.json"), "old success");
    let rejected = false;
    try {
      await checkProject(constraintConfig, constraintOutput);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("error: Datamog/Proofs.lean"))
        throw error;
      rejected = true;
    }
    if (!rejected || (await Bun.file(join(constraintOutput, "verification-result.json")).exists()))
      throw new Error("Reachable constraint violation accepted as impossible");
  }
  console.log(
    "Selected project: explicit constraint proof and refutation passed; changed source guard and constraint body rejected.",
  );
  const errorFixture = new URL(
    "../verification/lean/examples/selected-error-predicates/",
    import.meta.url,
  ).pathname;
  await cp(errorFixture, join(temp, "error-input"), { recursive: true });
  const errorConfig = join(temp, "error-input/plan.json");
  const errorOutput = join(temp, "error-project");
  await exportProject(errorConfig, errorOutput);
  await Bun.write(
    join(errorOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(errorFixture, "Proofs.lean")).text(),
  );
  await exportProject(errorConfig, errorOutput);
  const errorReport = await checkProject(errorConfig, errorOutput);
  if (errorReport.entries.length !== 3 || errorReport.entries.some((e) => e.status !== "proved"))
    throw new Error("Expected named error proof and independent error/constraint refutations");
  const errorSource = join(temp, "error-input/program.dl");
  const errorOriginal = await Bun.file(errorSource).text();
  for (const changed of [
    errorOriginal.replace("X > 0", "X >= 0"),
    `${errorOriginal}\nbad(X) :- seed(X).`,
  ]) {
    await Bun.write(errorSource, changed);
    await exportProject(errorConfig, errorOutput);
    await Bun.write(join(errorOutput, "verification-result.json"), "old success");
    let rejected = false;
    try {
      await checkProject(errorConfig, errorOutput);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("error: Datamog/Proofs.lean"))
        throw error;
      rejected = true;
    }
    if (!rejected || (await Bun.file(join(errorOutput, "verification-result.json")).exists()))
      throw new Error("Reachable named error accepted as impossible");
  }
  console.log(
    "Selected project: named error proof and mixed refutations passed; unsafe guard and unmarked sibling rejected.",
  );
  const lawsFixture = new URL(
    "../verification/lean/examples/selected-laws-and-checks/",
    import.meta.url,
  ).pathname;
  await cp(lawsFixture, join(temp, "laws-input"), { recursive: true });
  const lawsConfig = join(temp, "laws-input/plan.json");
  const lawsOutput = join(temp, "laws-project");
  const lawsProof = await Bun.file(join(lawsFixture, "Proofs.lean")).text();
  await exportProject(lawsConfig, lawsOutput);
  await Bun.write(join(lawsOutput, "Datamog/Proofs.lean"), lawsProof);
  await exportProject(lawsConfig, lawsOutput);
  const lawsReport = await checkProject(lawsConfig, lawsOutput);
  if (lawsReport.entries.length !== 4 || lawsReport.entries.some((e) => e.status !== "proved"))
    throw new Error("Expected combined program laws and selected checks");
  const lawsSource = join(temp, "laws-input/program.dl");
  await Bun.write(
    lawsSource,
    (await Bun.file(lawsSource).text()).replace("seed(X), X > 0", "seed(X)"),
  );
  const unsafeConfig = join(temp, "laws-input/unsafe-plan.json");
  await Bun.write(
    unsafeConfig,
    JSON.stringify({
      source: "program.dl",
      claims: [{ kind: "program-invariant", id: "safe", predicates: ["output"] }],
    }),
  );
  const unsafeOutput = join(temp, "laws-unsafe-project");
  await exportProject(unsafeConfig, unsafeOutput);
  await Bun.write(
    join(unsafeOutput, "Datamog/Proofs.lean"),
    `${lawsProof.split("\ntheorem covered")[0]}\nend Datamog.Proofs\n`,
  );
  await exportProject(unsafeConfig, unsafeOutput);
  await Bun.write(join(unsafeOutput, "verification-result.json"), "old success");
  let unsafeRejected = false;
  try {
    await checkProject(unsafeConfig, unsafeOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    unsafeRejected = true;
  }
  if (!unsafeRejected || (await Bun.file(join(unsafeOutput, "verification-result.json")).exists()))
    throw new Error("Runtime checks were assumed to prove an unsafe invariant");
  console.log(
    "Selected project: composed laws and checks coexist; checks cannot discharge an unsafe invariant.",
  );
  const modulesFixture = new URL("../verification/lean/examples/selected-modules/", import.meta.url)
    .pathname;
  await cp(modulesFixture, join(temp, "modules-input"), { recursive: true });
  const modulesConfig = join(temp, "modules-input/plan.json");
  const modulesOutput = join(temp, "modules-project");
  await exportProject(modulesConfig, modulesOutput);
  await Bun.write(
    join(modulesOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(modulesFixture, "Proofs.lean")).text(),
  );
  await exportProject(modulesConfig, modulesOutput);
  const modulesReport = await checkProject(modulesConfig, modulesOutput);
  if (
    modulesReport.entries.length !== 1 ||
    modulesReport.entries[0]?.status !== "proved" ||
    modulesReport.moduleSources?.length !== 3
  )
    throw new Error("Expected nested-module proof and complete source snapshots");
  const importedSource = join(temp, "modules-input/filter.dl");
  await Bun.write(
    importedSource,
    (await Bun.file(importedSource).text()).replace("X > 0", "X >= 0"),
  );
  await exportProject(modulesConfig, modulesOutput);
  await Bun.write(join(modulesOutput, "verification-result.json"), "old success");
  let modulesRejected = false;
  try {
    await checkProject(modulesConfig, modulesOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    modulesRejected = true;
  }
  if (
    !modulesRejected ||
    (await Bun.file(join(modulesOutput, "verification-result.json")).exists())
  )
    throw new Error("Unsafe imported definition accepted by the final invariant");
  console.log(
    "Selected project: nested modules and source snapshots checked; unsafe imported guard rejected.",
  );
  const moduleChecksFixture = new URL(
    "../verification/lean/examples/selected-module-checks/",
    import.meta.url,
  ).pathname;
  await cp(moduleChecksFixture, join(temp, "module-checks-input"), { recursive: true });
  const moduleChecksConfig = join(temp, "module-checks-input/plan.json");
  const moduleChecksOutput = join(temp, "module-checks-project");
  await exportProject(moduleChecksConfig, moduleChecksOutput);
  await Bun.write(
    join(moduleChecksOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(moduleChecksFixture, "Proofs.lean")).text(),
  );
  await exportProject(moduleChecksConfig, moduleChecksOutput);
  const moduleChecksReport = await checkProject(moduleChecksConfig, moduleChecksOutput);
  if (
    moduleChecksReport.entries.length !== 4 ||
    moduleChecksReport.entries.some((e) => e.status !== "proved")
  )
    throw new Error("Expected entry checks and laws over imported definitions");
  const checkedImport = join(temp, "module-checks-input/filter.dl");
  await Bun.write(checkedImport, (await Bun.file(checkedImport).text()).replace("X > 0", "X >= 0"));
  await exportProject(moduleChecksConfig, moduleChecksOutput);
  await Bun.write(join(moduleChecksOutput, "verification-result.json"), "old success");
  let moduleChecksRejected = false;
  try {
    await checkProject(moduleChecksConfig, moduleChecksOutput);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("omega")) throw error;
    moduleChecksRejected = true;
  }
  if (
    !moduleChecksRejected ||
    (await Bun.file(join(moduleChecksOutput, "verification-result.json")).exists())
  )
    throw new Error("Imported checks were assumed to exclude reachable entry violations");
  console.log(
    "Selected project: entry checks over modules passed; imported checks remain unassumed.",
  );
  for (const fixtureName of ["selected-instance-checks", "selected-nested-instance-checks"]) {
    const instanceFixture = new URL(
      `../verification/lean/examples/${fixtureName}/`,
      import.meta.url,
    ).pathname;
    const instanceInput = join(temp, `${fixtureName}-input`);
    await cp(instanceFixture, instanceInput, { recursive: true });
    const instanceConfig = join(instanceInput, "plan.json");
    const instanceOutput = join(temp, `${fixtureName}-project`);
    await exportProject(instanceConfig, instanceOutput);
    await Bun.write(
      join(instanceOutput, "Datamog/Proofs.lean"),
      await Bun.file(join(instanceFixture, "Proofs.lean")).text(),
    );
    await exportProject(instanceConfig, instanceOutput);
    const instanceReport = await checkProject(instanceConfig, instanceOutput);
    if (
      instanceReport.entries.length !== 4 ||
      instanceReport.entries.some((e) => e.status !== "proved")
    )
      throw new Error("Expected proofs and refutations for separately selected instances");
    const instanceSource = join(instanceInput, "program.dl");
    await Bun.write(
      instanceSource,
      (await Bun.file(instanceSource).text()).replaceAll("item = positive", "item = seed"),
    );
    await exportProject(instanceConfig, instanceOutput);
    await Bun.write(join(instanceOutput, "verification-result.json"), "old success");
    let rewiredRejected = false;
    try {
      await checkProject(instanceConfig, instanceOutput);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("error: Datamog/Proofs.lean"))
        throw error;
      rewiredRejected = true;
    }
    if (
      !rewiredRejected ||
      (await Bun.file(join(instanceOutput, "verification-result.json")).exists())
    )
      throw new Error("A proof for one module wiring discharged a different instance");
    console.log(`Selected project: ${fixtureName} passed; changed wiring rejected.`);
  }
  const inputLawsFixture = new URL(
    "../verification/lean/examples/selected-input-laws/",
    import.meta.url,
  ).pathname;
  const inputLawsInput = join(temp, "inputLaws-input");
  const inputLawsOutput = join(temp, "inputLaws-project");
  await cp(inputLawsFixture, inputLawsInput, { recursive: true });
  const inputLawsConfig = join(inputLawsInput, "plan.json");
  await exportProject(inputLawsConfig, inputLawsOutput);
  await Bun.write(
    join(inputLawsOutput, "Datamog/Proofs.lean"),
    await Bun.file(join(inputLawsFixture, "Proofs.lean")).text(),
  );
  await exportProject(inputLawsConfig, inputLawsOutput);
  const inputLawsReport = await checkProject(inputLawsConfig, inputLawsOutput, undefined, true);
  if (
    inputLawsReport.entries.find((e) => e.id === "positive")?.status !== "conditional" ||
    inputLawsReport.entries.find((e) => e.id === "unrestricted_refuted")?.status !== "proved"
  )
    throw new Error("Input-law premise was lost from fresh assurance");
  for (const required of [undefined, ["positive"]]) {
    let rejected = false;
    try {
      await checkProject(inputLawsConfig, inputLawsOutput, required, required !== undefined);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("remains conditional")) throw error;
      rejected = true;
    }
    if (!rejected || (await Bun.file(join(inputLawsOutput, "verification-result.json")).exists()))
      throw new Error("Conditional input law bypassed unconditional goal gate");
  }
  const weaker = JSON.parse(await Bun.file(inputLawsConfig).text());
  weaker.claims[0].inputLaws[0].value = -1;
  await Bun.write(inputLawsConfig, JSON.stringify(weaker));
  await exportProject(inputLawsConfig, inputLawsOutput);
  let weakerRejected = false;
  try {
    await checkProject(inputLawsConfig, inputLawsOutput, undefined, true);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("error: Datamog/Proofs.lean"))
      throw error;
    weakerRejected = true;
  }
  if (!weakerRejected) throw new Error("Weakened input law retained an invalid proof");
  console.log(
    "Selected project: explicit input law checked conditionally; strict gates and weakened premise rejected.",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
