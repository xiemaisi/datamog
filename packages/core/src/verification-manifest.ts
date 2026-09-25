/** Content identities, not proof certificates. No filesystem or prover dependency. */
export interface VerificationNode {
  id: string;
  kind: "goal" | "definition";
  theorem?: string;
  statement: unknown;
  assumptions: readonly string[];
  dependencies: readonly string[];
}

export interface VerificationContext {
  profile: string;
  toolchain: string;
  method: "lean-kernel-checked";
  /** Content hashes of source, exporter, semantics, proof and trust-policy files. */
  artifacts: Record<string, string>;
}

/** Canonical JSON: sort object keys, preserve array order, reject lossy values. */
export function canonicalVerificationJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalVerificationJson).join(",")}]`;
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalVerificationJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("Verification identity requires plain JSON data");
}

export async function verificationDigest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash each complete dependency closure, including cycles without recursive hashing. */
export async function createVerificationManifest(
  nodes: readonly VerificationNode[],
  context: VerificationContext,
) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error("Duplicate verification identity");
  const contextDigest = await verificationDigest(canonicalVerificationJson(context));
  const entries = await Promise.all(
    [...byId.keys()].sort().map(async (id) => {
      const closure = new Set<string>();
      const visit = (key: string) => {
        if (closure.has(key)) return;
        const node = byId.get(key);
        if (!node) throw new Error(`Missing verification dependency: ${key}`);
        closure.add(key);
        node.dependencies.forEach(visit);
      };
      visit(id);
      const definitions = [...closure].sort().map((key) => {
        const node = byId.get(key)!;
        return { ...node, dependencies: [...new Set(node.dependencies)].sort() };
      });
      return {
        ...byId.get(id)!,
        dependencies: [...new Set(byId.get(id)!.dependencies)].sort(),
        closure: [...closure].sort(),
        digest: await verificationDigest(
          canonicalVerificationJson({ id, contextDigest, definitions }),
        ),
      };
    }),
  );
  const contents = {
    purpose: "verification-plan",
    schema: "datamog-verification-manifest-v1",
    context,
    contextDigest,
    entries,
  };
  return { ...contents, digest: await verificationDigest(canonicalVerificationJson(contents)) };
}

/** Compare freshly generated content, never just an artifact's claimed digest. */
export function assertCurrentVerificationManifest(
  expected: Awaited<ReturnType<typeof createVerificationManifest>>,
  artifact: unknown,
): void {
  if (canonicalVerificationJson(expected) !== canonicalVerificationJson(artifact)) {
    throw new Error("Stale or mismatched verification manifest");
  }
}
