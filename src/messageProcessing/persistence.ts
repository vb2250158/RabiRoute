import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { recordPerformanceOperation } from "../performance/performanceInstrumentation.js";
import { PERFORMANCE_OPERATIONS } from "../shared/performanceOperations.js";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import { projectDirectoryLayout } from "../shared/projectDirectoryLayout.js";

export interface MessageProcessingBoardPersistence {
  read(): unknown;
  write(state: unknown): void;
}

export type MessageProcessingBoardSnapshotWriter = (statePath: string, state: unknown) => Promise<void>;

export type MessageProcessingBoardPersistenceStatus = {
  state: "idle" | "pending" | "writing" | "retrying";
  flushDelayMs: number;
  lastWriteDurationMs?: number;
  lastCompletedAt?: string;
  lastErrorAt?: string;
  lastError?: string;
};

type CoalescingMessageProcessingBoardPersistenceOptions = {
  flushDelayMs?: number;
  retryDelayMs?: number;
  writer?: MessageProcessingBoardSnapshotWriter;
  onError?: (error: Error) => void;
};

const MESSAGE_PROCESSING_BOARD_WRITE_WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function transientRenameError(error) {
  return new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]).has(String(error && error.code || ""));
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    "." + path.basename(filePath) + "." + process.pid + "." + Date.now() + "." + randomUUID() + ".tmp"
  );
  try {
    const descriptor = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        fs.renameSync(temporary, filePath);
        break;
      } catch (error) {
        if (attempt >= 8 || !transientRenameError(error)) throw error;
        Atomics.wait(waitBuffer, 0, 0, Math.min(250, 25 * (2 ** Math.min(6, attempt - 1))));
      }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

try {
  atomicWrite(workerData.statePath, JSON.stringify(workerData.state) + "\n");
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error && error.name || "Error",
      message: error && error.message || String(error),
      stack: error && error.stack
    }
  });
}
`;

function writeMessageProcessingBoardSnapshotInWorker(statePath: string, state: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(MESSAGE_PROCESSING_BOARD_WRITE_WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: { statePath, state }
    });
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    worker.once("message", (message: { ok?: boolean; error?: { name?: string; message?: string; stack?: string } }) => {
      if (settled) return;
      if (message?.ok) {
        settled = true;
        resolve();
        return;
      }
      const error = new Error(message?.error?.message || "Message-processing board persistence worker failed.");
      error.name = message?.error?.name || error.name;
      if (message?.error?.stack) error.stack = message.error.stack;
      fail(error);
    });
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (!settled && code !== 0) fail(new Error(`Message-processing board persistence worker exited with code ${code}.`));
    });
  });
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

export class CoalescingMessageProcessingBoardPersistence implements MessageProcessingBoardPersistence {
  private readonly flushDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly writer: MessageProcessingBoardSnapshotWriter;
  private readonly onError: (error: Error) => void;
  private pendingState: unknown;
  private hasPendingState = false;
  private flushTimer?: NodeJS.Timeout;
  private activeWrite?: Promise<void>;
  private lastWriteDurationMs?: number;
  private lastCompletedAt?: string;
  private lastErrorAt?: string;
  private lastError?: string;
  private accepting = true;
  private stopped = false;
  private stopPromise?: Promise<void>;

  constructor(
    readonly statePath: string,
    options: CoalescingMessageProcessingBoardPersistenceOptions = {}
  ) {
    this.flushDelayMs = Math.max(0, Math.floor(options.flushDelayMs ?? 250));
    this.retryDelayMs = Math.max(100, Math.floor(options.retryDelayMs ?? 1_000));
    this.writer = options.writer ?? writeMessageProcessingBoardSnapshotInWorker;
    this.onError = options.onError ?? ((error) => console.error("Message-processing board persistence failed:", error));
  }

  read(): unknown {
    if (!fs.existsSync(this.statePath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch {
      return undefined;
    }
  }

  start(): void {
    if (!this.stopped) return;
    if (this.activeWrite || this.flushTimer) {
      throw new Error("Message-processing board persistence cannot restart while a write is active.");
    }
    this.accepting = true;
    this.stopped = false;
    this.stopPromise = undefined;
  }

  write(state: unknown): void {
    if (!this.accepting) {
      throw new Error("Message-processing board persistence is stopped.");
    }
    this.pendingState = state;
    this.hasPendingState = true;
    this.scheduleWrite(this.flushDelayMs);
  }

  status(): MessageProcessingBoardPersistenceStatus {
    return {
      state: this.activeWrite
        ? "writing"
        : this.hasPendingState
          ? (this.lastError ? "retrying" : "pending")
          : "idle",
      flushDelayMs: this.flushDelayMs,
      lastWriteDurationMs: this.lastWriteDurationMs,
      lastCompletedAt: this.lastCompletedAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError
    };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.accepting = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.stopPromise = this.flush().finally(() => {
      this.stopped = true;
    });
    return this.stopPromise;
  }

  async flush(): Promise<void> {
    while (this.hasPendingState || this.activeWrite) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      const active = this.activeWrite ?? this.startWrite();
      if (active) await active;
    }
  }

  private scheduleWrite(delayMs: number): void {
    if (!this.accepting || this.flushTimer || this.activeWrite || !this.hasPendingState) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const active = this.startWrite();
      active?.catch(() => {
        this.scheduleWrite(this.retryDelayMs);
      });
    }, delayMs);
  }

  private startWrite(): Promise<void> | undefined {
    if (this.activeWrite || !this.hasPendingState) return this.activeWrite;
    const state = this.pendingState;
    const startedAt = Date.now();
    this.pendingState = undefined;
    this.hasPendingState = false;
    const operation = this.writer(this.statePath, state)
      .then(() => {
        this.lastWriteDurationMs = Date.now() - startedAt;
        recordPerformanceOperation(
          PERFORMANCE_OPERATIONS.managerMessageBoardPersist,
          this.lastWriteDurationMs
        );
        this.lastCompletedAt = new Date().toISOString();
        this.lastErrorAt = undefined;
        this.lastError = undefined;
      })
      .catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.lastWriteDurationMs = Date.now() - startedAt;
        recordPerformanceOperation(
          PERFORMANCE_OPERATIONS.managerMessageBoardPersist,
          this.lastWriteDurationMs,
          true
        );
        this.lastErrorAt = new Date().toISOString();
        this.lastError = normalized.message;
        if (!this.hasPendingState) {
          this.pendingState = state;
          this.hasPendingState = true;
        }
        this.onError(normalized);
        throw normalized;
      })
      .finally(() => {
        this.activeWrite = undefined;
        if (this.hasPendingState) this.scheduleWrite(this.flushDelayMs);
      });
    this.activeWrite = operation;
    return operation;
  }
}

export function messageProcessingBoardStatePath(rootDir: string): string {
  return path.join(projectDirectoryLayout(rootDir).runtimeStateRoot, "message-processing-board.json");
}
