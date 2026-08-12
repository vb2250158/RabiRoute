import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodexThreadCreateResult } from "./codexRuntime.js";
import { canonicalCodexWorkspacePath } from "./codexTaskIdentity.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { projectDirectoryLayout } from "./shared/projectDirectoryLayout.js";

export type CodexThreadCreationState =
  | "reserved"
  | "creating"
  | "thread_created"
  | "naming"
  | "initial_turn"
  | "completed"
  | "uncertain"
  | "failed_before_create";

export type CodexThreadCreationReservation = {
  version: 1;
  key: string;
  title: string;
  workspace: string;
  state: CodexThreadCreationState;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  result?: CodexThreadCreateResult;
  error?: string;
};

export class CodexThreadCreationBlockedError extends Error {
  constructor(readonly reservation: CodexThreadCreationReservation) {
    super(
      reservation.state === "uncertain"
        ? `Codex Desktop task creation result is uncertain for ${reservation.title}; do not create again automatically.`
        : `Codex Desktop task creation is already ${reservation.state} for ${reservation.title}; query the existing reservation before retrying.`
    );
    this.name = "CodexThreadCreationBlockedError";
  }
}

function creationKey(title: string, workspace: string): string {
  return JSON.stringify(["codex-desktop", canonicalCodexWorkspacePath(workspace), title]);
}

function reservationPath(rootDir: string, key: string): string {
  const fileName = `${createHash("sha256").update(key, "utf8").digest("hex")}.json`;
  return path.join(projectDirectoryLayout(rootDir).runtimeStateRoot, "codex-thread-creations", fileName);
}

function parseReservation(filePath: string): CodexThreadCreationReservation | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CodexThreadCreationReservation>;
    if (
      value.version !== 1
      || typeof value.key !== "string"
      || typeof value.title !== "string"
      || typeof value.workspace !== "string"
      || !["reserved", "creating", "thread_created", "naming", "initial_turn", "completed", "uncertain", "failed_before_create"].includes(String(value.state))
    ) return null;
    return value as CodexThreadCreationReservation;
  } catch {
    return null;
  }
}

function writeReservation(rootDir: string, reservation: CodexThreadCreationReservation): void {
  atomicWriteFileSync(
    reservationPath(rootDir, reservation.key),
    `${JSON.stringify(reservation, null, 2)}\n`
  );
}

function reserveCreation(rootDir: string, title: string, workspace: string): {
  created: boolean;
  reservation: CodexThreadCreationReservation;
} {
  const key = creationKey(title, workspace);
  const filePath = reservationPath(rootDir, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = parseReservation(filePath);
  if (existing && existing.state !== "failed_before_create") return { created: false, reservation: existing };

  const now = new Date().toISOString();
  const reservation: CodexThreadCreationReservation = {
    version: 1,
    key,
    title,
    workspace: canonicalCodexWorkspacePath(workspace),
    state: "reserved",
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  let descriptor: number | undefined;
  try {
    if (existing?.state === "failed_before_create") {
      writeReservation(rootDir, reservation);
      return { created: true, reservation };
    }
    descriptor = fs.openSync(filePath, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify(reservation, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    return { created: true, reservation };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = parseReservation(filePath);
    if (!raced) {
      throw new Error(`Codex Desktop task creation reservation is unreadable: ${filePath}`);
    }
    return { created: false, reservation: raced };
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

export function codexThreadCreationReservationPathForTest(rootDir: string, title: string, workspace: string): string {
  return reservationPath(rootDir, creationKey(title, workspace));
}

export function readCodexThreadCreationReservationForTest(
  rootDir: string,
  title: string,
  workspace: string
): CodexThreadCreationReservation | null {
  return parseReservation(codexThreadCreationReservationPathForTest(rootDir, title, workspace));
}

export async function createCodexThreadWithReservation(
  params: {
    rootDir: string;
    title: string;
    workspace: string;
    create: (onStage: (state: "thread_created" | "naming" | "initial_turn", threadId: string) => void) => Promise<CodexThreadCreateResult>;
  }
): Promise<CodexThreadCreateResult> {
  const reserved = reserveCreation(params.rootDir, params.title, params.workspace);
  if (!reserved.created) {
    if (reserved.reservation.state === "completed" && reserved.reservation.result) {
      return reserved.reservation.result;
    }
    throw new CodexThreadCreationBlockedError(reserved.reservation);
  }

  let current: CodexThreadCreationReservation = {
    ...reserved.reservation,
    state: "creating",
    updatedAt: new Date().toISOString()
  };
  writeReservation(params.rootDir, current);
  try {
    const result = await params.create((state, threadId) => {
      current = {
        ...current,
        state,
        threadId,
        updatedAt: new Date().toISOString()
      };
      writeReservation(params.rootDir, current);
    });
    current = {
      ...current,
      state: "completed",
      threadId: result.id,
      result,
      error: undefined,
      updatedAt: new Date().toISOString()
    };
    writeReservation(params.rootDir, current);
    return result;
  } catch (error) {
    current = {
      ...current,
      state: "uncertain",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    };
    writeReservation(params.rootDir, current);
    throw new CodexThreadCreationBlockedError(current);
  }
}
