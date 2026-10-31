import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import { projectDirectoryLayout } from "../shared/projectDirectoryLayout.js";

export interface AgentRequestPersistence {
  read(): unknown;
  write(state: unknown): void;
}

export class JsonFileAgentRequestPersistence implements AgentRequestPersistence {
  constructor(readonly statePath: string) {}

  read(): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Agent request evidence could not be read.", { cause: error });
    }
  }

  write(state: unknown): void {
    let replaced = false;
    try {
      atomicWriteFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { renameSync(source, destination) {
        fs.renameSync(source, destination);
        replaced = true;
      } });
    } catch (error) {
      if (replaced) throw Object.assign(new Error("Agent request state replacement completed but its acknowledgement failed.", { cause: error }), {
        code: "AGENT_REQUEST_COMMIT_UNKNOWN", commitState: "unknown", retryable: false
      });
      throw error;
    }
  }
}

export function agentRequestStatePath(rootDir: string): string {
  return path.join(projectDirectoryLayout(rootDir).runtimeStateRoot, "agent-requests.json");
}
