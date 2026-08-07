import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import { projectDirectoryLayout } from "../shared/projectDirectoryLayout.js";

export interface MessageProcessingBoardPersistence {
  read(): unknown;
  write(state: unknown): void;
}

export class JsonFileMessageProcessingBoardPersistence implements MessageProcessingBoardPersistence {
  constructor(readonly statePath: string) {}

  read(): unknown {
    if (!fs.existsSync(this.statePath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch {
      return undefined;
    }
  }

  write(state: unknown): void {
    atomicWriteFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export function messageProcessingBoardStatePath(rootDir: string): string {
  return path.join(projectDirectoryLayout(rootDir).runtimeStateRoot, "message-processing-board.json");
}
