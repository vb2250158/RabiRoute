import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginIdentity } from "../plugin-kernel/index.js";
import {
  ProcessLeaseRegistry,
  type ProcessLease,
  type ProcessLeaseOwner
} from "../runtime/processLeaseRegistry.js";
import type { WearableCompanionRuntimeIdentity } from "./wearableCompanionRuntimeIdentity.js";

const RETRY_WINDOW_MS = 10 * 60_000;
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_HANDOFF_TIMEOUT_MS = 15_000;
const WORKER_PROCESS_KEY = "wearable-companion-worker";

export type WearableCompanionWorkerConfig = Readonly<{
  roleId: string;
  serial: string;
}>;

export type WearableCompanionWorkerHandle = Readonly<{
  state: "managed" | "degraded";
  pid?: number;
  reason?: string;
  failure: Promise<Error | undefined>;
  dispose(): Promise<void>;
}>;

type WorkerServiceDependencies = Readonly<{
  spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  isFile?: (candidate: string) => boolean;
  startupReady?: Promise<void>;
  handoffTimeoutMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}>;

function required(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function localAbsolute(value: string, field: string): string {
  const normalized = path.resolve(required(value, field));
  if (normalized.startsWith("\\\\")) throw new Error(`${field} must be on a local disk.`);
  return normalized;
}

function localResourceRoot(value: string): string {
  const normalized = required(value, "resourceRoot");
  if (normalized.toLowerCase().startsWith("file:")) {
    try {
      return localAbsolute(fileURLToPath(new URL(normalized)), "resourceRoot");
    } catch {
      throw new Error("resourceRoot must be a valid local file URL or absolute path.");
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) && !/^[a-z]:[\\/]/i.test(normalized)) {
    throw new Error("resourceRoot must be a valid local file URL or absolute path.");
  }
  return localAbsolute(normalized, "resourceRoot");
}

function processOwner(identity: PluginIdentity): ProcessLeaseOwner {
  return Object.freeze({
    applicationGenerationId: identity.applicationGenerationId,
    managerInstanceId: identity.managerInstanceId,
    activationId: identity.activationId,
    instanceId: identity.instanceId,
    revision: identity.revision
  });
}

function cleanText(value: string, fallback: string, maximumLength: number): string {
  return (String(value || "").trim() || fallback).slice(0, maximumLength);
}

export class WearableCompanionWorkerService {
  readonly #spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly #isFile: (candidate: string) => boolean;
  readonly #startupReady?: Promise<void>;
  readonly #handoffTimeoutMs: number;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(
    private readonly runtime: WearableCompanionRuntimeIdentity,
    private readonly leases: ProcessLeaseRegistry,
    dependencies: WorkerServiceDependencies = {}
  ) {
    this.#spawn = dependencies.spawn ?? ((file, args, options) => spawn(file, args, options));
    this.#isFile = dependencies.isFile ?? (candidate => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
    this.#startupReady = dependencies.startupReady;
    this.#handoffTimeoutMs = Math.max(1, Math.floor(dependencies.handoffTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS));
    this.#now = dependencies.now ?? Date.now;
    this.#setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = dependencies.clearTimer ?? (timer => clearTimeout(timer));
  }

  launch(
    identity: PluginIdentity,
    resourceRootValue: string,
    configValue: WearableCompanionWorkerConfig
  ): WearableCompanionWorkerHandle {
    if (identity.applicationGenerationId !== this.runtime.applicationGenerationId
      || identity.managerInstanceId !== this.runtime.managerInstanceId) {
      throw new Error("Wearable companion plugin identity does not belong to the active Manager generation.");
    }
    if (this.runtime.unavailableReason || !this.runtime.pwshPath) {
      return Object.freeze({
        state: "degraded" as const,
        reason: this.runtime.unavailableReason ?? "PowerShell 7 is unavailable.",
        failure: Promise.resolve(undefined),
        async dispose() {}
      });
    }

    const pwshPath = localAbsolute(this.runtime.pwshPath, "pwshPath");
    const runtimeRoot = localAbsolute(this.runtime.runtimeRoot, "runtimeRoot");
    const stateRoot = localAbsolute(this.runtime.stateRoot, "stateRoot");
    const logRoot = localAbsolute(this.runtime.logRoot, "logRoot");
    const resourceRoot = localResourceRoot(resourceRootValue);
    const workerScript = path.resolve(resourceRoot, "Start-RabiLinkWearableCompanion.ps1");
    if (!workerScript.startsWith(`${resourceRoot}${path.sep}`) || !this.#isFile(workerScript)) {
      throw new Error("Wearable companion worker resource is missing from the immutable plugin package.");
    }
    if (path.basename(pwshPath).toLowerCase() !== "pwsh.exe" || !this.#isFile(pwshPath)) {
      throw new Error("pwshPath must identify a verified PowerShell 7 executable.");
    }

    const roleId = cleanText(configValue.roleId, "YeYu", 80);
    const serial = cleanText(configValue.serial, "", 160);
    const args = [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", workerScript,
      "-ManagerUrl", this.runtime.managerBaseUrl,
      "-ApplicationGenerationId", this.runtime.applicationGenerationId,
      "-ManagerInstanceId", this.runtime.managerInstanceId,
      "-RuntimeRoot", runtimeRoot,
      "-StateRoot", stateRoot,
      "-LogRoot", logRoot,
      "-RoleId", roleId
    ];
    if (serial) args.push("-Serial", serial);

    const owner = processOwner(identity);
    let stopping = false;
    let resolved = false;
    let currentLease: ProcessLease | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let handoffTimer: ReturnType<typeof setTimeout> | undefined;
    let disposePromise: Promise<void> | undefined;
    const retryAttempts: number[] = [];
    let resolveFailure = (_error: Error | undefined): void => {};
    const failure = new Promise<Error | undefined>(resolve => { resolveFailure = resolve; });
    const finish = (error?: Error): void => {
      if (resolved) return;
      resolved = true;
      resolveFailure(stopping ? undefined : error);
    };

    const scheduleRetry = (error: Error): void => {
      if (stopping || resolved || retryTimer) return;
      const now = this.#now();
      while (retryAttempts.length > 0 && now - retryAttempts[0]! >= RETRY_WINDOW_MS) retryAttempts.shift();
      if (retryAttempts.length >= MAX_RETRY_ATTEMPTS) {
        finish(new Error(`Wearable companion worker exhausted ${MAX_RETRY_ATTEMPTS} retries: ${error.message}`));
        return;
      }
      retryAttempts.push(now);
      const delayMs = Math.min(
        MAX_RETRY_DELAY_MS,
        INITIAL_RETRY_DELAY_MS * (2 ** (retryAttempts.length - 1))
      );
      retryTimer = this.#setTimer(() => {
        retryTimer = undefined;
        if (!stopping && !resolved) startWorker();
      }, delayMs);
    };

    const startWorker = (): void => {
      if (stopping || resolved) return;
      let lease: ProcessLease;
      try {
        fs.mkdirSync(stateRoot, { recursive: true });
        fs.mkdirSync(logRoot, { recursive: true });
        lease = this.leases.launch(owner, WORKER_PROCESS_KEY, () => this.#spawn(
          pwshPath,
          args,
          {
            cwd: runtimeRoot,
            detached: false,
            windowsHide: true,
            stdio: "ignore",
            env: {
              ...this.runtime.environment,
              RABIROUTE_PLUGIN_APP_GENERATION_ID: this.runtime.applicationGenerationId,
              RABIROUTE_PLUGIN_MANAGER_INSTANCE_ID: this.runtime.managerInstanceId
            }
          }
        ), { maxChildProcesses: 1, exclusiveAcrossOwners: true });
      } catch (error) {
        scheduleRetry(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      currentLease = lease;
      let handled = false;
      let processError: Error | undefined;
      const failed = (error: Error): void => {
        if (handled) return;
        handled = true;
        if (currentLease?.id === lease.id) currentLease = undefined;
        if (!stopping) scheduleRetry(error);
      };
      lease.child.on("error", error => {
        processError = error instanceof Error ? error : new Error(String(error));
        if (lease.child.exitCode !== null) failed(processError);
      });
      lease.child.once("exit", code => failed(processError ?? new Error(
        `Wearable companion worker exited with code ${code ?? "unknown"}.`
      )));
      lease.child.once("close", code => failed(processError ?? new Error(
        `Wearable companion worker closed with code ${code ?? "unknown"}.`
      )));
      if (lease.child.exitCode !== null) {
        failed(processError ?? new Error(`Wearable companion worker exited with code ${lease.child.exitCode}.`));
      }
    };

    const startupGates: Promise<unknown>[] = [];
    if (this.#startupReady) startupGates.push(this.#startupReady);
    const predecessors = this.leases.list().filter(lease => lease.key === WORKER_PROCESS_KEY);
    if (predecessors.length > 0) {
      startupGates.push(new Promise<void>((resolve, reject) => {
        let settled = false;
        const complete = (operation: () => void): void => {
          if (settled) return;
          settled = true;
          if (handoffTimer) {
            this.#clearTimer(handoffTimer);
            handoffTimer = undefined;
          }
          operation();
        };
        void Promise.all(predecessors.map(lease => lease.settled)).then(
          () => complete(resolve),
          error => complete(() => reject(error))
        );
        handoffTimer = this.#setTimer(() => complete(() => reject(new Error(
          `Wearable companion predecessor did not release its process lease within ${this.#handoffTimeoutMs}ms.`
        ))), this.#handoffTimeoutMs);
      }));
    }
    if (startupGates.length > 0) {
      void Promise.all(startupGates).then(() => {
        if (!stopping && !resolved) startWorker();
      }, error => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    } else {
      startWorker();
    }

    return Object.freeze({
      state: "managed" as const,
      get pid() { return currentLease?.child.pid; },
      failure,
      dispose: () => {
        if (disposePromise) return disposePromise;
        stopping = true;
        if (retryTimer) {
          this.#clearTimer(retryTimer);
          retryTimer = undefined;
        }
        if (handoffTimer) {
          this.#clearTimer(handoffTimer);
          handoffTimer = undefined;
        }
        const attempt = (async () => {
          const lease = currentLease;
          if (lease) {
            await this.leases.terminate(lease);
            if (currentLease?.id === lease.id) currentLease = undefined;
          }
          finish();
        })();
        disposePromise = attempt;
        void attempt.catch(() => {
          if (disposePromise === attempt) disposePromise = undefined;
        });
        return attempt;
      }
    });
  }
}
