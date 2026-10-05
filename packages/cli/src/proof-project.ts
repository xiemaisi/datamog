/** User-facing entry for source-selected Lean verification projects. */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const help =
  "Usage: datamog proof <inspect|export|check> PLAN.json OUTPUT [--allow-conditional] [--require-goal ID ...]";

function checkoutRoot() {
  const configured = process.env.DATAMOG_VERIFICATION_ROOT;
  const candidates = configured
    ? [resolve(configured)]
    : [new URL("../../../", import.meta.url).pathname, process.cwd(), dirname(process.execPath)];
  for (const candidate of candidates) {
    let path = resolve(candidate);
    while (true) {
      if (
        existsSync(join(path, "scripts/lean-project.ts")) &&
        existsSync(join(path, "verification/lean/lean-toolchain")) &&
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

async function runner(args: string[]) {
  const script = join(checkoutRoot(), "scripts/lean-project.ts");
  const child = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`${stdout}${stderr}`.trim() || `Proof project exited ${exitCode}`);
  return stdout;
}

export async function runProofProject(args: string[]) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(help);
    return;
  }
  const [command, config, output, ...rest] = args;
  if (!config || !output || !["inspect", "export", "check"].includes(command ?? ""))
    throw new Error(help);
  const required: string[] = [];
  let allowConditional = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--allow-conditional" && !allowConditional) {
      allowConditional = true;
    } else if (rest[i] === "--require-goal" && rest[i + 1] && !rest[i + 1]!.startsWith("--")) {
      required.push(rest[++i]!);
    } else {
      throw new Error(help);
    }
  }
  if (command !== "check" && (allowConditional || required.length)) throw new Error(help);
  const stdout = await runner([command!, config, output, ...rest]);
  if (command !== "check") {
    process.stdout.write(stdout);
    return;
  }
  const path = join(resolve(output), "verification-result.json");
  const report = (await Bun.file(path).json()) as {
    entries: { id: string; status: string; assumptions: string[] }[];
    verificationPlan: { entries: { id: string; statement: unknown }[] };
  };
  for (const entry of report.entries) {
    const node = report.verificationPlan.entries.find((node) => node.id === entry.id);
    const statement = node?.statement;
    const polarity =
      statement && typeof statement === "object" && "negationOf" in statement
        ? "refutation"
        : "claim";
    console.log(`${entry.id}: ${entry.status} ${polarity}`);
    for (const assumption of entry.assumptions) console.log(`  assumes ${assumption}`);
  }
  console.log(`Fresh report: ${path}`);
}
