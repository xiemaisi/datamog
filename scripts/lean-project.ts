import { existsSync } from "node:fs";
/** Local, source-built Lean projects. Reports are never imported as certificates. */
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { analyze, generateLogicalObligations, inferTypes } from "../packages/core/src/index.ts";
import {
  type CoverageClaim,
  type UniquenessClaim,
  assembleLeanClaims,
  exportLeanCoverage,
  exportLeanObligation,
  exportLeanUniqueness,
} from "../packages/core/src/obligation-lean.ts";
import { exportLeanStructuralProjection } from "../packages/core/src/structural-projection-lean.ts";
import {
  type VerificationNode,
  assertCurrentVerificationManifest,
  createVerificationManifest,
  verificationDigest,
} from "../packages/core/src/verification-manifest.ts";
import { createLeanVerificationResult } from "../packages/core/src/verification-result.ts";
import { parse, parseRaw } from "../packages/parser/src/index.ts";

import {
  type ConstraintClaim,
  type ErrorPredicateClaim,
  exportConstraint,
  exportErrorPredicate,
} from "./lean-constraint.ts";
import { type InvariantClaim, exportInvariant } from "./lean-invariant.ts";

import {
  type MutualClaim,
  type ProgramCoverageClaim,
  type ProgramEmptinessClaim,
  type ProgramEquivalenceClaim,
  type ProgramInvariantClaim,
  type ProgramUniquenessClaim,
  exportMutual,
  exportProgramClaim,
} from "./lean-mutual.ts";

import { type InputFile, assertInputDataUnchanged, validateInputData } from "./lean-input-data.ts";
import { loadLeanModules } from "./lean-modules.ts";

function checkoutRoot() {
  const configured = process.env.DATAMOG_VERIFICATION_ROOT;
  const candidates = configured
    ? [resolve(configured)]
    : [new URL("../", import.meta.url).pathname, process.cwd(), dirname(process.execPath)];
  for (const candidate of candidates) {
    let path = resolve(candidate);
    while (true) {
      if (
        existsSync(join(path, "verification/lean/lean-toolchain")) &&
        existsSync(join(path, "packages/core/src")) &&
        existsSync(join(path, "bun.lock"))
      )
        return path;
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }
  throw new Error(
    "Selected Lean verification needs a Datamog source checkout; set DATAMOG_VERIFICATION_ROOT to its root",
  );
}
const root = checkoutRoot();
const library = join(root, "verification/lean");
const marker = "datamog-lean-projection-project-v1\n";
const proofFile = "Datamog/Proofs.lean";
const reportFile = "verification-result.json";
const support = [
  "lean-toolchain",
  "lakefile.toml",
  "lake-manifest.json",
  "Datamog/Semantics.lean",
  "Datamog/Structural.lean",
  "Datamog/Audit.lean",
];
type LocalClaim = {
  kind: "local";
  id: string;
  predicate: string;
  rule: number;
  refinement: number;
};
type Claim = (
  | ConstraintClaim
  | ErrorPredicateClaim
  | LocalClaim
  | InvariantClaim
  | MutualClaim
  | ProgramInvariantClaim
  | ProgramCoverageClaim
  | ProgramEquivalenceClaim
  | ProgramEmptinessClaim
  | ProgramUniquenessClaim
  | ({ kind: "uniqueness" } & UniquenessClaim)
  | ({ kind: "coverage" } & CoverageClaim)
) & { polarity?: "prove" | "refute" };
interface Selection {
  source: string;
  projections: { id: string; predicate: string; coverage?: boolean }[];
  claims: Claim[];
}
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(`Expected an object with only: ${allowed.join(", ")}`);
}
function validateInputLaws(inputLaws: unknown) {
  if (inputLaws !== undefined) {
    if (!Array.isArray(inputLaws) || !inputLaws.length)
      throw new Error("Input laws must be a nonempty array");
    for (const law of inputLaws) {
      if (law && typeof law === "object" && "kind" in law && law.kind === "functional-dependency") {
        keys(law, ["kind", "id", "predicate", "keyColumns", "outputColumns"]);
        if (
          typeof law.id !== "string" ||
          typeof law.predicate !== "string" ||
          !Array.isArray(law.keyColumns) ||
          !Array.isArray(law.outputColumns) ||
          [...law.keyColumns, ...law.outputColumns].some((c) => !Number.isSafeInteger(c))
        )
          throw new Error("Invalid functional-dependency input law");
        continue;
      }
      keys(law, ["id", "predicate", "column", "op", "value"]);
      if (
        typeof law.id !== "string" ||
        typeof law.predicate !== "string" ||
        !Number.isSafeInteger(law.column) ||
        Number(law.column) < 0 ||
        !["<", "<=", ">", ">=", "="].includes(String(law.op)) ||
        !Number.isSafeInteger(law.value)
      )
        throw new Error("Invalid integer input law");
    }
  }
}
export function parseSelection(value: unknown): Selection {
  keys(value, ["source", "projections", "claims"]);
  if (
    typeof value.source !== "string" ||
    !value.source ||
    (value.projections !== undefined && !Array.isArray(value.projections)) ||
    (value.claims !== undefined && !Array.isArray(value.claims))
  )
    throw new Error("A source path and arrays of projections or claims are required");
  const projections = (value.projections ?? []) as unknown[];
  const claims = (value.claims ?? []) as unknown[];
  if (!projections.length && !claims.length)
    throw new Error("A nonempty goal selection is required");
  for (const projection of projections) {
    keys(projection, ["id", "predicate", "coverage"]);
    if (
      typeof projection.id !== "string" ||
      typeof projection.predicate !== "string" ||
      (projection.coverage !== undefined && typeof projection.coverage !== "boolean")
    )
      throw new Error("Each projection requires id, predicate, and optional Boolean coverage");
  }
  for (const claim of claims) {
    if (claim && typeof claim === "object" && "kind" in claim && claim.kind === "constraint") {
      const selected: Record<string, unknown> = claim;
      keys(selected, ["kind", "id", "constraint", "polarity", "instance", "inputLaws"]);
      validateInputLaws(selected.inputLaws);
      if (
        (selected.instance !== undefined &&
          (typeof selected.instance !== "string" || !selected.instance.length)) ||
        typeof selected.id !== "string" ||
        !Number.isSafeInteger(selected.constraint) ||
        Number(selected.constraint) < 1 ||
        (selected.polarity !== undefined &&
          selected.polarity !== "prove" &&
          selected.polarity !== "refute")
      )
        throw new Error(
          "Constraint selection requires id and a positive one-based constraint index",
        );
      continue;
    }
    if (
      claim &&
      typeof claim === "object" &&
      "kind" in claim &&
      claim.kind === "program-uniqueness"
    ) {
      const unique: Record<string, unknown> = claim;
      keys(unique, [
        "kind",
        "id",
        "predicate",
        "keyColumns",
        "outputColumns",
        "polarity",
        "inputLaws",
      ]);
      validateInputLaws(unique.inputLaws);
      if (
        typeof unique.id !== "string" ||
        typeof unique.predicate !== "string" ||
        !Array.isArray(unique.keyColumns) ||
        !Array.isArray(unique.outputColumns) ||
        [...unique.keyColumns, ...unique.outputColumns].some((c) => typeof c !== "number") ||
        (unique.polarity !== undefined &&
          unique.polarity !== "prove" &&
          unique.polarity !== "refute")
      )
        throw new Error("Program uniqueness requires id, predicate and column arrays");
      continue;
    }
    if (
      claim &&
      typeof claim === "object" &&
      "kind" in claim &&
      (claim.kind === "mutual-invariant" ||
        claim.kind === "program-invariant" ||
        claim.kind === "program-equivalence")
    ) {
      const mutual: Record<string, unknown> = claim;
      keys(mutual, [
        "kind",
        "id",
        "predicates",
        "polarity",
        ...(claim.kind !== "mutual-invariant" ? ["inputLaws"] : []),
      ]);
      validateInputLaws(mutual.inputLaws);
      if (
        typeof mutual.id !== "string" ||
        !Array.isArray(mutual.predicates) ||
        mutual.predicates.some((p) => typeof p !== "string") ||
        (mutual.polarity !== undefined &&
          mutual.polarity !== "prove" &&
          mutual.polarity !== "refute")
      )
        throw new Error("Mutual selection requires id and predicate names");
      continue;
    }

    keys(claim, [
      "kind",
      "polarity",
      "id",
      "predicate",
      "relationName",
      "inputPredicate",
      "outputToInput",
      "bounds",
      "keyColumns",
      "outputColumns",
      "rule",
      "refinement",
      "instance",
      "inputLaws",
    ]);
    if (
      claim.kind !== "error-predicate" &&
      claim.kind !== "program-emptiness" &&
      claim.kind !== "coverage" &&
      claim.kind !== "program-coverage" &&
      claim.kind !== "uniqueness" &&
      claim.kind !== "local" &&
      claim.kind !== "invariant"
    )
      throw new Error("Unknown Lean claim kind");
    if (claim.kind === "error-predicate" || claim.kind === "program-emptiness")
      validateInputLaws(claim.inputLaws);
    const fields = ["kind", "polarity", "id", "predicate"];
    keys(claim, [
      ...fields,
      ...(claim.kind === "error-predicate" ? ["instance"] : []),
      ...(claim.kind === "error-predicate" || claim.kind === "program-emptiness"
        ? ["inputLaws"]
        : claim.kind === "local"
          ? ["rule", "refinement"]
          : claim.kind === "program-coverage"
            ? ["inputPredicate", "outputToInput", "bounds", "inputLaws"]
            : claim.kind === "coverage"
              ? ["relationName", "inputPredicate", "outputToInput", "bounds"]
              : claim.kind === "invariant"
                ? ["relationName"]
                : ["relationName", "keyColumns", "outputColumns"]),
    ]);
    if (
      (claim.kind === "error-predicate" &&
        claim.instance !== undefined &&
        (typeof claim.instance !== "string" || !claim.instance.length)) ||
      [claim.id, claim.predicate].some((v) => typeof v !== "string") ||
      (claim.kind !== "error-predicate" &&
        claim.kind !== "program-emptiness" &&
        claim.kind !== "local" &&
        claim.kind !== "program-coverage" &&
        typeof claim.relationName !== "string") ||
      (claim.polarity !== undefined && claim.polarity !== "prove" && claim.polarity !== "refute")
    )
      throw new Error("Claims require names and prove/refute polarity");
    if (claim.kind === "local") {
      if (![claim.rule, claim.refinement].every((v) => Number.isSafeInteger(v) && Number(v) > 0))
        throw new Error("Local selectors require positive one-based rule and refinement indices");
    } else if (claim.kind === "uniqueness") {
      for (const columns of [claim.keyColumns, claim.outputColumns])
        if (!Array.isArray(columns) || columns.some((c) => typeof c !== "number"))
          throw new Error("Uniqueness requires numeric column arrays");
    } else if (claim.kind === "coverage" || claim.kind === "program-coverage") {
      if (claim.kind === "program-coverage") validateInputLaws(claim.inputLaws);
      if (
        typeof claim.inputPredicate !== "string" ||
        !Array.isArray(claim.outputToInput) ||
        claim.outputToInput.some((c) => c !== null && typeof c !== "number") ||
        !Array.isArray(claim.bounds)
      )
        throw new Error("Coverage requires inputPredicate, outputToInput, and bounds");
      for (const bound of claim.bounds) {
        keys(bound, ["column", "op", "value"]);
        if (
          typeof bound.column !== "number" ||
          typeof bound.value !== "number" ||
          !["<", "<=", ">", ">="].includes(String(bound.op))
        )
          throw new Error("Malformed coverage bound");
      }
    }
  }
  return { source: value.source, projections, claims } as Selection;
}
async function optionalText(path: string) {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function regular(path: string, directory = false) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()))
      throw new Error(`Expected a regular ${directory ? "directory" : "file"}: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function owned(output: string, creating = false) {
  await regular(output, true);
  const content = await optionalText(join(output, ".datamog-lean-project"));
  if (content === marker) return;
  if (creating && content === undefined) {
    try {
      if (!(await readdir(output)).length) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  throw new Error("Output must be empty or a generated Datamog Lean project");
}

export async function planProject(configInput: string, outputInput: string) {
  const configPath = resolve(configInput);
  const output = resolve(outputInput);
  const configText = await Bun.file(configPath).text();
  const selection = parseSelection(JSON.parse(configText));
  const sourcePath = resolve(dirname(configPath), selection.source);
  const source = await Bun.file(sourcePath).text();
  const standalone = parseRaw(source, sourcePath);
  const hasBindings = standalone.statements.some(
    (statement) => statement.$type === "ExtDecl" && statement.binding,
  );
  if (
    hasBindings &&
    (selection.projections.length ||
      selection.claims.some(
        (claim) =>
          !claim.kind.startsWith("program-") &&
          claim.kind !== "constraint" &&
          claim.kind !== "error-predicate",
      ))
  )
    throw new Error(
      "Module verification supports composed program-* claims and entry-file checks only",
    );
  const modules = hasBindings ? loadLeanModules(source, sourcePath) : undefined;
  const program = modules?.program ?? parse(source);
  const typed = modules?.typed ?? inferTypes(analyze(program));
  const exports = selection.projections.map((descriptor) =>
    exportLeanStructuralProjection(typed, descriptor),
  );
  const explicitConstraints =
    modules?.entryConstraints ??
    program.statements.filter(
      (statement) => statement.$type === "Query" && statement.isError && !statement.synthetic,
    );
  const selectedInstance = (name: string | undefined) => {
    if (name === undefined) return undefined;
    const instance = modules?.instances.get(name);
    if (!instance) throw new Error(`Unknown module binding path ${name}`);
    return instance;
  };
  const constraintBundles = selection.claims
    .filter((claim) => claim.kind === "constraint")
    .map((claim) => {
      const instance = selectedInstance(claim.instance);
      const query = (instance?.constraints ?? explicitConstraints)[claim.constraint - 1];
      if (!query || query.$type !== "Query")
        throw new Error(`No explicit constraint ${claim.constraint}`);
      return exportConstraint(typed, query, claim, instance?.file ?? modules?.entryPath);
    });
  constraintBundles.push(
    ...selection.claims
      .filter((claim) => claim.kind === "error-predicate")
      .map((claim) => {
        const instance = selectedInstance(claim.instance);
        if (instance) {
          const predicate = instance.predicates[claim.predicate];
          if (!predicate || !instance.errors.has(predicate))
            throw new Error("Selection requires an error declared in the selected module instance");
          if (typed.rules.get(predicate)?.some((rule) => !instance.ruleNodes.has(rule.$cstNode)))
            throw new Error("Module error definitions must belong to the selected instance");
          return exportErrorPredicate(typed, claim, instance.file, predicate);
        }
        if (modules && !modules.entryErrorPredicates.includes(claim.predicate))
          throw new Error("Module error selections require an entry-file error declaration");
        if (
          modules &&
          typed.rules
            .get(claim.predicate)
            ?.some((rule) => !modules.entryRuleNodes.has(rule.$cstNode))
        )
          throw new Error("Module error selections require all defining rules in the entry file");
        return exportErrorPredicate(typed, claim, modules?.entryPath);
      }),
  );
  const mutuals = selection.claims
    .filter(
      (claim) =>
        claim.kind === "mutual-invariant" ||
        claim.kind === "program-invariant" ||
        claim.kind === "program-uniqueness" ||
        claim.kind === "program-coverage" ||
        claim.kind === "program-equivalence" ||
        claim.kind === "program-emptiness",
    )
    .map((claim) =>
      claim.kind === "mutual-invariant"
        ? exportMutual(typed, claim)
        : exportProgramClaim(typed, claim),
    );
  const invariants = selection.claims
    .filter((claim) => claim.kind === "invariant")
    .map((claim) => exportInvariant(typed, claim));
  const localClaims = selection.claims.filter((claim) => claim.kind === "local");
  const obligations = localClaims.length ? generateLogicalObligations(typed) : [];
  const localNodes: VerificationNode[] = [];
  const localSources: string[] = [];
  const localCheckers: string[] = [];
  const selectedLocals = localClaims.map((descriptor) => {
    const { predicate, rule, refinement } = descriptor;
    const goal = obligations.filter((goal) => goal.predicate === predicate && goal.rule === rule)[
      refinement - 1
    ];
    if (!goal) throw new Error(`No local obligation selected by ${descriptor.id}`);
    return { descriptor, goal };
  });
  // Batch IDs identify source obligations only within this generation. Manifest
  // edges use the explicitly selected names, bound to full statements below.
  const localByObligation = new Map<string, (typeof selectedLocals)[number]>();
  for (const selected of selectedLocals) {
    if (localByObligation.has(selected.goal.id))
      throw new Error(`Duplicate local obligation selection: ${selected.goal.id}`);
    localByObligation.set(selected.goal.id, selected);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function checkLocalClosure(selected: (typeof selectedLocals)[number]) {
    const { goal, descriptor } = selected;
    if (visiting.has(goal.id))
      throw new Error(`Recursive local contract dependencies are unsupported: ${descriptor.id}`);
    if (visited.has(goal.id)) return;
    visiting.add(goal.id);
    for (const dependency of goal.dependencies) {
      const target = localByObligation.get(dependency);
      if (!target || target.descriptor.polarity === "refute")
        throw new Error(
          `Local contract dependencies require selected proofs: ${descriptor.id} needs ${dependency}`,
        );
      checkLocalClosure(target);
    }
    visiting.delete(goal.id);
    visited.add(goal.id);
  }
  for (const selected of selectedLocals) checkLocalClosure(selected);
  for (const { descriptor, goal } of selectedLocals) {
    const { id, polarity } = descriptor;
    const source = exportLeanObligation(goal, id);
    const refute = polarity === "refute";
    const proofName = refute ? `${id}_refuted` : id;
    const expected = `${refute ? "¬ " : ""}Generated.${id}`;
    localSources.push(source);
    localCheckers.push(
      `theorem ${proofName} : ${expected} := Proofs.${proofName}\n#audit ${proofName}\n`,
    );
    localNodes.push({
      id,
      kind: refute ? "definition" : "goal",
      ...(refute ? {} : { theorem: `Datamog.Checked.${id}` }),
      statement: { descriptor, obligation: goal, source },
      assumptions: [],
      dependencies: [
        "IntegerSemantics",
        ...goal.dependencies.map((dependency) => localByObligation.get(dependency)!.descriptor.id),
      ],
    });
    if (refute)
      localNodes.push({
        id: proofName,
        kind: "goal",
        theorem: `Datamog.Checked.${proofName}`,
        statement: { negationOf: id, expected },
        assumptions: [],
        dependencies: [id],
      });
  }
  const claimBundles = selection.claims
    .filter(
      (claim) =>
        claim.kind !== "error-predicate" &&
        claim.kind !== "constraint" &&
        claim.kind !== "local" &&
        claim.kind !== "invariant" &&
        claim.kind !== "mutual-invariant" &&
        claim.kind !== "program-invariant" &&
        claim.kind !== "program-uniqueness" &&
        claim.kind !== "program-coverage" &&
        claim.kind !== "program-equivalence" &&
        claim.kind !== "program-emptiness",
    )
    .map(({ kind, polarity, ...descriptor }) =>
      kind === "uniqueness"
        ? exportLeanUniqueness(typed, descriptor as UniquenessClaim, polarity)
        : exportLeanCoverage(typed, descriptor as CoverageClaim, polarity),
    );
  const assembled = claimBundles.length ? assembleLeanClaims(claimBundles) : undefined;
  const relationIds = new Set(claimBundles.map((bundle) => bundle.nodes[0]!.id));
  const claimNodes = (assembled?.nodes ?? []).map((node) =>
    relationIds.has(node.id)
      ? { ...node, dependencies: [...node.dependencies, "IntegerSemantics"] }
      : node,
  );
  const nodes = [
    ...exports.flatMap((bundle) => bundle.nodes),
    ...claimNodes,
    ...localNodes,
    ...invariants.flatMap((bundle) => bundle.nodes),
    ...mutuals.flatMap((bundle) => bundle.nodes),
    ...constraintBundles.flatMap((bundle) => bundle.nodes),
  ];
  const checker = [
    ...exports.map((bundle) => bundle.checker),
    assembled?.checker ?? "",
    ...localCheckers,
    ...invariants.map((bundle) => bundle.checker),
    ...mutuals.map((bundle) => bundle.checker),
    ...constraintBundles.map((bundle) => bundle.checker),
  ].join("\n");
  const goals = nodes.filter((node) => node.kind === "goal");
  const signatures = checker
    .split("\n")
    .filter((line) => line.startsWith("theorem "))
    .map((line) => `-- ${line.replace(/ := Proofs\.[A-Za-z0-9_]+$/, " := by ...")}`);
  const proofTemplate = `import Datamog.Generated\n\nnamespace Datamog.Proofs\n\n-- Supply maintained proofs of these exact generated goals:\n${signatures.join("\n")}\n\nend Datamog.Proofs\n`;
  await regular(join(output, "Datamog"), true);
  await regular(join(output, proofFile));
  const proofs = (await optionalText(join(output, proofFile))) ?? proofTemplate;
  const files: Record<string, string> = {
    ".datamog-lean-project": marker,
    ".gitignore": ".lake/\nverification-result.json\nverification-result.json.tmp\n",
    "Datamog.lean": "import Datamog.Checked\n",
    "Datamog/Generated.lean": `-- Generated; edit the source program and selection instead.\nimport Datamog.Structural\nnamespace Datamog.Generated\n${exports.map((bundle) => bundle.source).join("\n")}\n${assembled?.relations ?? ""}\n${assembled?.statements ?? ""}\n${localSources.join("\n")}\n${invariants.map((bundle) => bundle.source).join("\n")}\n${mutuals.map((bundle) => bundle.source).join("\n")}\n${constraintBundles.map((bundle) => bundle.source).join("\n")}\nend Datamog.Generated\n`,
    [proofFile]: proofs,
  };
  for (const path of support) files[path] = await Bun.file(join(library, path)).text();
  const artifacts: Record<string, string> = {
    selection: await verificationDigest(configText),
    source: await verificationDigest(source),
  };
  const paths = new Set([
    "scripts/lean-project.ts",
    "scripts/lean-invariant.ts",
    "scripts/lean-mutual.ts",
    "scripts/lean-constraint.ts",
    "scripts/lean-modules.ts",
    "scripts/lean-input-data.ts",
    "packages/loader/csv/src/index.ts",
    "packages/loader/csv/src/csv-loader.ts",
    "packages/loader/csv/src/parse-content.ts",
    "packages/engine/src/loader.ts",
    "bun.lock",
  ]);
  for (const directory of ["packages/core/src", "packages/parser/src"])
    for await (const path of new Bun.Glob("**/*").scan({
      cwd: join(root, directory),
      onlyFiles: true,
    }))
      if (/\.(ts|langium)$/.test(path)) paths.add(`${directory}/${path}`);
  const moduleSources = modules
    ? await Promise.all(
        modules.sources.map(async ({ path, text }) => {
          const digest = await verificationDigest(text);
          return { path, text, digest };
        }),
      )
    : undefined;
  // Preserve source order regardless of asynchronous digest completion order.
  for (const file of moduleSources ?? []) artifacts[`module-source/${file.path}`] = file.digest;
  if (modules) {
    nodes.push({
      id: "ModuleSources",
      kind: "definition",
      assumptions: [],
      dependencies: [],
      statement: {
        sources: moduleSources!.map(({ path, digest }) => ({ path, digest })),
        imports: modules.imports,
        boundaries: modules.boundaries,
      },
    });
    for (const node of nodes)
      if (node.kind === "goal") node.dependencies = [...node.dependencies, "ModuleSources"];
  }
  for (const path of [...paths].sort())
    artifacts[path] = await verificationDigest(await Bun.file(join(root, path)).text());
  for (const [path, content] of Object.entries(files))
    artifacts[`project/${path}`] = await verificationDigest(content);
  nodes.push(
    {
      id: "IntegerSemantics",
      kind: "definition",
      statement: files["Datamog/Semantics.lean"],
      assumptions: [],
      dependencies: [],
    },
    {
      id: "StructuralSemantics",
      kind: "definition",
      statement: files["Datamog/Structural.lean"],
      assumptions: [],
      dependencies: ["IntegerSemantics"],
    },
  );
  const manifest = await createVerificationManifest(nodes, {
    profile: selection.claims.length
      ? selection.projections.length
        ? "datamog-integer-v1+datamog-structural-integer-v1"
        : "datamog-integer-v1"
      : "datamog-structural-integer-v1",
    toolchain: files["lean-toolchain"]!.trim(),
    method: "lean-kernel-checked",
    artifacts,
  });
  files["Datamog/Checked.lean"] =
    `-- Verification manifest SHA-256: ${manifest.digest}\nimport Datamog.Proofs\nimport Datamog.Audit\nnamespace Datamog.Checked\n${checker}\nend Datamog.Checked\n`;
  files["manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const path of Object.keys(files)) {
    const target = join(output, path);
    if (
      target === configPath ||
      target === sourcePath ||
      modules?.sources.some(({ file }) => file === target)
    )
      throw new Error("Project output would overwrite the selection or source");
    await regular(target);
  }
  return {
    files,
    moduleSources,
    manifest,
    goals: goals.map((goal) => goal.id),
    inputDeclarations: typed.extDecls,
    sourceSnapshot: { path: selection.source, text: source, digest: artifacts.source! },
    selectionSnapshot: { text: configText, digest: artifacts.selection! },
  };
}

/** Read-only preview of the current source-derived plan; never proof evidence. */
export async function inspectProject(configPath: string, outputInput: string) {
  const plan = await planProject(configPath, outputInput);
  const byId = new Map(plan.manifest.entries.map((entry) => [entry.id, entry]));
  return {
    schema: "datamog-selected-inspection-v1",
    purpose: "inspection-only",
    ...(plan.moduleSources ? { moduleSources: plan.moduleSources } : {}),
    sourceSnapshot: plan.sourceSnapshot,
    selectionSnapshot: plan.selectionSnapshot,
    verificationPlan: plan.manifest,
    generated: {
      definitions: plan.files["Datamog/Generated.lean"],
      checker: plan.files["Datamog/Checked.lean"],
    },
    goals: plan.manifest.entries
      .filter((entry) => entry.kind === "goal")
      .map((entry) => ({
        id: entry.id,
        theorem: entry.theorem,
        statement: entry.statement,
        dependencies: entry.dependencies,
        closure: entry.closure,
        assumptions: [...new Set(entry.closure.flatMap((id) => byId.get(id)!.assumptions))].sort(),
      })),
  };
}

export async function exportProject(configPath: string, outputInput: string) {
  const output = resolve(outputInput);
  await owned(output, true);
  const plan = await planProject(configPath, output);
  await mkdir(join(output, "Datamog"), { recursive: true });
  // Invalid requests never touch an existing project. Regeneration invalidates
  // a previous success and preserves maintained proofs byte for byte.
  await rm(join(output, reportFile), { force: true });
  for (const [path, content] of Object.entries(plan.files)) {
    if (path === proofFile && (await optionalText(join(output, path))) !== undefined) continue;
    await Bun.write(join(output, path), content);
  }
  return plan;
}
async function assertFiles(output: string, plan: Awaited<ReturnType<typeof planProject>>) {
  for (const [path, content] of Object.entries(plan.files)) {
    await regular(join(output, path));
    if ((await optionalText(join(output, path))) !== content)
      throw new Error(`Stale or altered project file: ${path}; run export again`);
  }
}
async function run(command: string[], cwd: string) {
  const env = { ...process.env };
  env.LEAN_PATH = undefined;
  env.LEAN_SRC_PATH = undefined;
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}\n${stdout}${stderr}`);
    return stdout + stderr;
  } finally {
    clearTimeout(timer);
  }
}
export async function checkProject(
  configPath: string,
  outputInput: string,
  requiredGoals?: string[],
  allowConditional = false,
  inputFiles: InputFile[] = [],
) {
  const output = resolve(outputInput);
  await owned(output);
  await rm(join(output, reportFile), { force: true });
  const plan = await planProject(configPath, output);
  await assertFiles(output, plan);
  const required = requiredGoals ?? (allowConditional ? undefined : plan.goals);
  if (required && (!required.length || required.some((id) => !plan.goals.includes(id))))
    throw new Error("Unknown or empty required goal selection");
  const temp = await mkdtemp(join(tmpdir(), "datamog-selected-lean-"));
  try {
    // Write only the validated source snapshot, never local .olean files,
    // Lake caches, alternate build scripts, or imported reports.
    for (const [path, content] of Object.entries(plan.files))
      await Bun.write(join(temp, path), content);
    const version = await run(["lake", "env", "lean", "--version"], temp);
    if (!version.includes("version 4.34.0,"))
      throw new Error(`Unexpected Lean toolchain: ${version}`);
    const build = await run(["lake", "build"], temp);
    const report = {
      ...createLeanVerificationResult(plan.manifest, build, required),
      workflow: "selected-lean-claims-v1" as const,
      evidenceSchema: "datamog-selected-evidence-v1" as const,
      ...(plan.moduleSources ? { moduleSources: plan.moduleSources } : {}),
      sourceSnapshot: plan.sourceSnapshot,
      selectionSnapshot: plan.selectionSnapshot,
      verificationPlan: plan.manifest,
    };
    const dataset = inputFiles.length
      ? await validateInputData(plan.manifest, plan.inputDeclarations, inputFiles)
      : undefined;
    const current = await planProject(configPath, output);
    assertCurrentVerificationManifest(plan.manifest, current.manifest);
    await assertFiles(output, current);
    if (dataset) await assertInputDataUnchanged(dataset.inputs);
    const result = { ...report, ...(dataset ? { dataset } : {}) };
    const path = join(output, reportFile);
    await regular(path);
    await regular(`${path}.tmp`);
    await Bun.write(`${path}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
    await rename(`${path}.tmp`, path);
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    const [command, config, output, ...rest] = process.argv.slice(2);
    const required: string[] = [];
    const inputFiles: InputFile[] = [];
    let allowConditional = false;
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] === "--allow-conditional" && !allowConditional) {
        allowConditional = true;
        i--;
        continue;
      }
      if (rest[i] === "--input-file" && rest[i + 1]) {
        const binding = rest[i + 1]!;
        const equal = binding.indexOf("=");
        if (equal < 1 || equal === binding.length - 1)
          throw new Error("Expected --input-file predicate=path.csv");
        inputFiles.push({ predicate: binding.slice(0, equal), file: binding.slice(equal + 1) });
        continue;
      }
      if (rest[i] !== "--require-goal" || !rest[i + 1] || rest[i + 1]!.startsWith("--"))
        throw new Error("Invalid required goal option");
      required.push(rest[i + 1]!);
    }
    if (
      !config ||
      !output ||
      !["inspect", "export", "check"].includes(command!) ||
      (command !== "check" && rest.length)
    )
      throw new Error(
        "Usage: bun run lean:project <inspect|export|check> PLAN.json OUTPUT [--allow-conditional] [--require-goal ID ...] [--input-file PREDICATE=PATH.csv ...]",
      );
    if (command === "inspect") {
      console.log(JSON.stringify(await inspectProject(config, output), null, 2));
    } else if (command === "export") {
      const plan = await exportProject(config, output);
      console.log(
        `Exported ${plan.goals.length} goals to ${resolve(output)}. Maintain Datamog/Proofs.lean, then export again and check.`,
      );
    } else {
      const report = await checkProject(
        config,
        output,
        required.length ? required : undefined,
        allowConditional,
        inputFiles,
      );
      console.log(
        `Checked ${report.entries.length} goals. Fresh report: ${join(resolve(output), reportFile)}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
