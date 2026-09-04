import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodexThreadCreateResult } from "./codexRuntime.js";
import { canonicalCodexWorkspacePath } from "./codexTaskIdentity.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { projectDirectoryLayout } from "./shared/projectDirectoryLayout.js";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";

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

const DEFAULT_STALE_CREATING_MS = 5 * 60 * 1_000;

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

function creationKey(title: string, workspace: string, replacementForThreadId = ""): string {
  return JSON.stringify(["codex-desktop", canonicalCodexWorkspacePath(workspace), title, replacementForThreadId]);
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
  recordDataMutationAudit({
    group: "agent-session",
    event: "codex_thread_creation_reservation_written",
    owner: "codex-thread-creation",
    action: "update-reservation",
    target: { type: "thread-creation-reservation", id: createHash("sha256").update(reservation.key).digest("hex").slice(0, 24) },
    dataSource: { kind: "file", id: "runtime/codex-thread-creations" },
    outcome: "committed",
    after: { revision: reservation.updatedAt },
    result: reservation.state
  });
}

function reserveCreation(rootDir: string, title: string, workspace: string, replacementForThreadId = ""): {
  created: boolean;
  reservation: CodexThreadCreationReservation;
} {
  const key = creationKey(title, workspace, replacementForThreadId);
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
    recordDataMutationAudit({
      group: "agent-session",
      event: "codex_thread_creation_reserved",
      owner: "codex-thread-creation",
      action: "create-reservation",
      target: { type: "thread-creation-reservation", id: path.basename(filePath, ".json") },
      dataSource: { kind: "file", id: "runtime/codex-thread-creations" },
      outcome: "committed",
      after: { revision: reservation.updatedAt },
      result: reservation.state
    });
    return { created: true, reservation };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = parseReservation(filePath);
    if (!raced) {
      throw new Error(`Codex Desktop task creation reservation is unreadable: ${filePath}`);
    }
    recordDataMutationAudit({
      group: "agent-session",
      event: "codex_thread_creation_reservation_replayed",
      owner: "codex-thread-creation",
      action: "create-reservation",
      target: { type: "thread-creation-reservation", id: path.basename(filePath, ".json") },
      dataSource: { kind: "file", id: "runtime/codex-thread-creations" },
      outcome: "replayed",
      after: { revision: raced.updatedAt },
      result: raced.state
    });
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
    confirmMissing?: () => Promise<boolean>;
    replacementForThreadId?: string;
    staleCreatingMs?: number;
    now?: () => Date;
  }
): Promise<CodexThreadCreateResult> {
  let reserved = reserveCreation(params.rootDir, params.title, params.workspace, params.replacementForThreadId);
  if (!reserved.created) {
    if (reserved.reservation.state === "completed" && reserved.reservation.result) {
      return reserved.reservation.result;
    }
    const now = params.now?.() ?? new Date();
    const lastUpdated = Date.parse(reserved.reservation.updatedAt || reserved.reservation.createdAt);
    const stale = reserved.reservation.state === "creating"
      && Number.isFinite(lastUpdated)
      && now.getTime() - lastUpdated >= (params.staleCreatingMs ?? DEFAULT_STALE_CREATING_MS);
    if (stale) {
      let missingConfirmed = false;
      let evidenceError = "";
      if (!reserved.reservation.threadId && params.confirmMissing) {
        try {
          missingConfirmed = await params.confirmMissing();
        } catch (error) {
          evidenceError = error instanceof Error ? error.message : String(error);
        }
      }
      if (missingConfirmed) {
        writeReservation(params.rootDir, {
          ...reserved.reservation,
          state: "failed_before_create",
          error: "The stale creating reservation had no threadId and the Desktop state database confirmed that no matching task exists.",
          updatedAt: now.toISOString()
        });
        reserved = reserveCreation(params.rootDir, params.title, params.workspace, params.replacementForThreadId);
      } else {
        const uncertain: CodexThreadCreationReservation = {
          ...reserved.reservation,
          state: "uncertain",
          error: reserved.reservation.threadId
            ? "The stale creation reservation already contains a threadId; do not create another task automatically."
            : evidenceError
              ? `The Desktop state database could not confirm that the task is missing: ${evidenceError}`
              : "The Desktop state database did not authoritatively confirm that the task is missing.",
          updatedAt: now.toISOString()
        };
        writeReservation(params.rootDir, uncertain);
        throw new CodexThreadCreationBlockedError(uncertain);
      }
    }
    if (!reserved.created) {
      throw new CodexThreadCreationBlockedError(reserved.reservation);
    }
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
