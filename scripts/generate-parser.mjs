import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parserRequire = createRequire(resolve(root, "packages/parser/package.json"));
const cliRoot = resolve(dirname(fileURLToPath(import.meta.resolve("langium-cli"))), "..");
let runtimeRoot;
for (const path of parserRequire.resolve.paths("langium")) {
  try {
    runtimeRoot = await realpath(resolve(path, "langium"));
    break;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (!runtimeRoot) throw new Error("Langium runtime missing. Run bun install --frozen-lockfile.");
const version = async (dir) =>
  JSON.parse(await readFile(resolve(dir, "package.json"), "utf8")).version;
const cliVersion = await version(cliRoot);
const runtimeVersion = await version(runtimeRoot);
if (
  cliVersion.split(".").slice(0, 2).join(".") !== runtimeVersion.split(".").slice(0, 2).join(".")
) {
  throw new Error(
    `Langium generator ${cliVersion} and runtime ${runtimeVersion} differ. Run bun install --frozen-lockfile to restore the locked dependencies.`,
  );
}
const { schema } = await import(pathToFileURL(resolve(cliRoot, "lib/generator/node-util.js")));
const { generate } = await import(pathToFileURL(resolve(cliRoot, "lib/generate.js")));
// The 4.2 CLI schema lacks a base URI for its local $refs. Supply one in
// memory so jsonschema can resolve them while retaining config validation.
(await schema).$id ??= "https://langium.org/config-schema.json";
if (!(await generate({ file: resolve(root, "packages/parser/langium-config.json") })))
  process.exitCode = 1;
