import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
// @ts-expect-error The formal ESM builder is also the CLI implementation.
import { buildPluginPackages } from "../../scripts/build-plugin-packages.mjs";

let ownedRoot: string | undefined;
let preparation: Promise<string> | undefined;
let preparedPackage: string | undefined;
after(async () => { if (ownedRoot) await fs.rm(ownedRoot, { recursive: true, force: true }); });

/** One formal build per test worker; each test copies it before mutating candidates. */
export function diagnosticsCandidateForTests(packageId: string): Promise<string> {
  const configured = process.env.RABI_PLUGIN_CANDIDATE_ROOT;
  if (configured) return Promise.resolve(path.resolve(configured));
  if (preparedPackage && preparedPackage !== packageId) throw new Error("A test worker can only reuse its original candidate package.");
  preparedPackage = packageId;
  return preparation ??= (async () => {
    ownedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-diagnostics-candidate-"));
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    await buildPluginPackages(repository, { packages: [packageId], outputDirectory: ownedRoot });
    return ownedRoot;
  })();
}
