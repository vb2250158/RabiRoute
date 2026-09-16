import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

/** Run before exposing any HTTP/WS listener. A failed migration must abort startup. */
export function migrateLanAgentSharedCredential(options: {
  registryPath: string;
  markerPath: string;
  rotateWebguiToken: () => void;
}): void {
  if (fs.existsSync(options.markerPath)) {
    const marker = JSON.parse(fs.readFileSync(options.markerPath, "utf8"));
    if (marker?.schemaVersion !== 1 || marker.completed !== true) throw new Error("Invalid remote Agent credential migration marker.");
    return;
  }
  // Old prompts could be copied without completing enrollment. Rotate whenever a
  // legacy registry exists, including an empty registry, not just online nodes.
  const legacy = fs.existsSync(options.registryPath);
  if (legacy) options.rotateWebguiToken();
  fs.mkdirSync(path.dirname(options.markerPath), { recursive: true });
  atomicWriteFileSync(options.markerPath, JSON.stringify({ schemaVersion: 1, completed: true, legacyCredentialRotated: legacy }), { mode: 0o600 });
  recordDataMutationAudit({ group: "lan-agent", event: "lan_agent_credential_migrated", owner: "lan-agent-authority", action: "retire-shared-credential", target: { type: "authentication", id: "lan-agent" }, dataSource: { kind: "file", id: "lan-agent-credential-migration.json" }, outcome: "committed" });
}
