import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function checkInstalledDataCompatibility(candidateRoot, stateRoot) {
  if (!path.isAbsolute(candidateRoot) || !path.isAbsolute(stateRoot)) throw new Error("Explicit absolute candidate and state roots are required.");
  const credentialPath = path.join(stateRoot, "data", ".runtime", "lan-agent-authority.json");
  if (!fs.existsSync(credentialPath)) return { ready: true, credentialStorePresent: false };
  const digest = () => createHash("sha256").update(fs.readFileSync(credentialPath)).digest("hex");
  const before = digest();
  const owner = await import(pathToFileURL(path.join(candidateRoot, "dist", "manager", "lanAgentAuthority.js")).href);
  if (typeof owner.inspectLanAgentCredentialState !== "function") throw new Error("Candidate lacks the read-only computer credential compatibility contract.");
  const result = await owner.inspectLanAgentCredentialState(credentialPath);
  if (digest() !== before) throw new Error("Computer credential state changed during preflight; reconcile before activation.");
  return { ready: true, credentialStorePresent: true, schemaVersion: result.schemaVersion, nodeCount: result.nodeCount, snapshotSha256: before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [candidateRoot, stateRoot] = process.argv.slice(2);
    console.log(JSON.stringify(await checkInstalledDataCompatibility(candidateRoot, stateRoot)));
  } catch (error) {
    console.error(`Installed data compatibility failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
