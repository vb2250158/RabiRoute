import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { sanitizePluginErrorMessage } from "./pluginCatalog.js";
import {
  PROCESS_PLUGIN_PROTOCOL,
  PROCESS_PLUGIN_PROTOCOL_VERSION,
  encodeProcessPluginMessage,
  parseProcessPluginMessage,
  validateProcessPluginManifest,
  type ProcessPluginCapability,
  type ProcessPluginHealthResultMessage,
  type ProcessPluginManifestMessage,
  type ProcessPluginMessage,
  type ProcessPluginResponseMessage,
  type RabiUiContribution
} from "./processPluginProtocol.js";

export type ProcessPluginChild = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: any[]) => void): ProcessPluginChild;
  once(event: string, listener: (...args: any[]) => void): ProcessPluginChild;
  removeListener(event: string, listener: (...args: any[]) => void): ProcessPluginChild;
};

export type ProcessPluginSpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
  stdio: ["pipe", "pipe", "pipe"];
};

export type ProcessPluginSpawn = (
  command: string,
  args: readonly string[],
  options: ProcessPluginSpawnOptions
) => ProcessPluginChild;

export type ProcessPluginKillTree = (pid: number) => Promise<void>;
export type ProcessPluginHostState = "idle" | "starting" | "active" | "stopping" | "stopped" | "failed";

export type ProcessPluginHostSnapshot = {
  state: ProcessPluginHostState;
  instanceId: string;
  manifest?: ProcessPluginManifestMessage["manifest"];
  grantedCapabilities: ProcessPluginCapability[];
  contributions: RabiUiContribution[];
  error?: { code: string; message: string };
};

export type ProcessPluginHostOptions = {
  instanceId: string;
  expectedPluginId: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowedCapabilities?: readonly ProcessPluginCapability[];
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  platform?: NodeJS.Platform;
  spawn?: ProcessPluginSpawn;
  killTree?: ProcessPluginKillTree;
};

type PendingRequest = {
  expectedType: "response" | "health_result";
  resolve: (message: ProcessPluginResponseMessage | ProcessPluginHealthResultMessage) => void;
  reject: (error: ProcessPluginHostError) => void;
  timer: NodeJS.Timeout;
};

type ControlMessageType = "manifest" | "handshake_ack" | "stopped";
type ControlMessage = Extract<ProcessPluginMessage, { type: ControlMessageType }>;
type PendingControl = {
  resolve: (message: ControlMessage) => void;
  reject: (error: ProcessPluginHostError) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const STDERR_LIMIT = 4_096;

function normalizeIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(field + " is required.");
  return normalized;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneValue(item)])
    ) as T;
  }
  return value;
}

function errorMessage(value: unknown): string {
  return sanitizePluginErrorMessage(value instanceof Error ? value.message : value);
}

function defaultSpawn(command: string, args: readonly string[], options: ProcessPluginSpawnOptions): ProcessPluginChild {
  return nodeSpawn(command, [...args], options) as ChildProcessWithoutNullStreams;
}

function defaultKillTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

export class ProcessPluginHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(sanitizePluginErrorMessage(message));
    this.name = "ProcessPluginHostError";
  }
}

export class ProcessPluginHost {
  private readonly spawnProcess: ProcessPluginSpawn;
  private readonly killTree: ProcessPluginKillTree;
  private readonly platform: NodeJS.Platform;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private state: ProcessPluginHostState = "idle";
  private child: ProcessPluginChild | null = null;
  private lines: readline.Interface | null = null;
  private stderr = "";
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly controls = new Map<ControlMessageType, PendingControl>();
  private startPromise: Promise<ProcessPluginHostSnapshot> | null = null;
  private activeManifest: ProcessPluginManifestMessage["manifest"] | undefined;
  private activeCapabilities: ProcessPluginCapability[] = [];
  private activeContributions: RabiUiContribution[] = [];
  private lastError: ProcessPluginHostError | undefined;

  constructor(private readonly options: ProcessPluginHostOptions) {
    normalizeIdentity(options.instanceId, "Process plugin instanceId");
    normalizeIdentity(options.expectedPluginId, "Process plugin expectedPluginId");
    normalizeIdentity(options.command, "Process plugin command");
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.killTree = options.killTree ?? defaultKillTree;
    this.platform = options.platform ?? process.platform;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  snapshot(): ProcessPluginHostSnapshot {
    return {
      state: this.state,
      instanceId: this.options.instanceId,
      ...(this.activeManifest ? { manifest: cloneValue(this.activeManifest) } : {}),
      grantedCapabilities: [...this.activeCapabilities],
      contributions: cloneValue(this.activeContributions),
      ...(this.lastError ? { error: { code: this.lastError.code, message: this.lastError.message } } : {})
    };
  }

  start(): Promise<ProcessPluginHostSnapshot> {
    if (this.state === "active") return Promise.resolve(this.snapshot());
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.assertActive();
    normalizeIdentity(method, "Process plugin request method");
    const id = "request-" + this.nextRequestId++;
    const response = this.waitForRequest(id, "response", this.requestTimeoutMs, "request_timeout");
    this.write({
      protocol: PROCESS_PLUGIN_PROTOCOL,
      version: PROCESS_PLUGIN_PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      ...(params === undefined ? {} : { params })
    });
    const result = await response as ProcessPluginResponseMessage;
    if (result.error) {
      throw new ProcessPluginHostError(
        "remote_error",
        "Process plugin request failed: " + result.error.code + ": " + result.error.message
      );
    }
    return cloneValue(result.result);
  }

  async health(): Promise<{ status: "ok" | "degraded"; detail?: unknown }> {
    this.assertActive();
    const id = "health-" + this.nextRequestId++;
    const response = this.waitForRequest(id, "health_result", this.requestTimeoutMs, "health_timeout");
    this.write({
      protocol: PROCESS_PLUGIN_PROTOCOL,
      version: PROCESS_PLUGIN_PROTOCOL_VERSION,
      type: "health",
      id
    });
    const result = await response as ProcessPluginHealthResultMessage;
    return {
      status: result.status,
      ...(result.detail === undefined ? {} : { detail: cloneValue(result.detail) })
    };
  }

  async stop(reason?: string): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") return;
    const child = this.child;
    this.state = "stopping";
    let stopError: ProcessPluginHostError | undefined;
    if (child && child.exitCode === null) {
      const stopped = this.waitForControl(
        "stopped", this.stopTimeoutMs, "stop_timeout", "Process plugin stop timed out."
      );
      try {
        this.write({
          protocol: PROCESS_PLUGIN_PROTOCOL,
          version: PROCESS_PLUGIN_PROTOCOL_VERSION,
          type: "stop",
          ...(reason === undefined ? {} : { reason })
        });
        await stopped;
      } catch (error) {
        stopError = this.asHostError(error, "stop_failed", "Process plugin stop failed.");
      }
    }
    try {
      await this.terminateChild(child);
    } catch (error) {
      if (!stopError) {
        stopError = this.asHostError(error, "stop_failed", "Process plugin process-tree cleanup failed.");
      }
    }
    this.child = null;
    this.lines?.close();
    this.lines = null;
    this.rejectAll(new ProcessPluginHostError("host_stopped", "Process plugin host stopped."));
    this.state = "stopped";
    if (stopError) {
      this.lastError = stopError;
      throw stopError;
    }
    this.lastError = undefined;
  }

  dispose(): Promise<void> {
    return this.stop("host disposed");
  }

  private async startInternal(): Promise<ProcessPluginHostSnapshot> {
    this.resetForStart();
    this.state = "starting";
    const manifestPromise = this.waitForControl(
      "manifest", this.handshakeTimeoutMs, "handshake_timeout",
      "Process plugin manifest handshake timed out."
    );
    try {
      const child = this.spawnProcess(this.options.command, this.options.args ?? [], {
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.attachChild(child);
      const manifestMessage = await manifestPromise as ProcessPluginManifestMessage;
      let validated;
      try {
        validated = validateProcessPluginManifest(
          manifestMessage, this.options.allowedCapabilities ?? []
        );
        if (validated.manifest.id !== this.options.expectedPluginId) {
          throw new Error("Process plugin manifest id does not match the configured plugin id.");
        }
      } catch (error) {
        throw new ProcessPluginHostError(
          "manifest_rejected", "Process plugin manifest was rejected: " + errorMessage(error)
        );
      }
      const acknowledgement = this.waitForControl(
        "handshake_ack", this.handshakeTimeoutMs, "handshake_timeout",
        "Process plugin handshake acknowledgement timed out."
      );
      this.write({
        protocol: PROCESS_PLUGIN_PROTOCOL,
        version: PROCESS_PLUGIN_PROTOCOL_VERSION,
        type: "handshake",
        instanceId: this.options.instanceId,
        grantedCapabilities: validated.grantedCapabilities
      });
      const ack = await acknowledgement;
      if (ack.type !== "handshake_ack" || ack.instanceId !== this.options.instanceId) {
        throw new ProcessPluginHostError(
          "protocol_error", "Process plugin handshake acknowledgement is invalid."
        );
      }
      this.activeManifest = validated.manifest;
      this.activeCapabilities = validated.grantedCapabilities;
      this.activeContributions = validated.contributions;
      this.lastError = undefined;
      this.state = "active";
      return this.snapshot();
    } catch (error) {
      const hostError = this.asHostError(error, "start_failed", "Process plugin failed to start.");
      this.fail(hostError);
      await this.terminateChild(this.child).catch(() => undefined);
      this.child = null;
      throw hostError;
    }
  }

  private resetForStart(): void {
    this.lines?.close();
    this.lines = null;
    this.child = null;
    this.stderr = "";
    this.activeManifest = undefined;
    this.activeCapabilities = [];
    this.activeContributions = [];
    this.lastError = undefined;
    this.rejectAll(new ProcessPluginHostError("host_restarted", "Process plugin host restarted."));
  }

  private attachChild(child: ProcessPluginChild): void {
    this.child = child;
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      this.stderr = (this.stderr + String(chunk)).slice(-STDERR_LIMIT);
    });
    child.stdin.once("error", error => this.handleChildError(error));
    child.once("error", error => this.handleChildError(error));
    child.once("exit", (code, signal) => this.handleExit(code, signal));
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: ProcessPluginMessage;
    try {
      message = parseProcessPluginMessage(line);
    } catch {
      this.fail(new ProcessPluginHostError(
        "protocol_error", "Process plugin sent an invalid protocol message."
      ));
      return;
    }
    if (message.type === "manifest" || message.type === "handshake_ack" || message.type === "stopped") {
      const waiter = this.controls.get(message.type);
      if (!waiter) {
        this.fail(new ProcessPluginHostError(
          "protocol_error", "Process plugin sent an unexpected control message."
        ));
        return;
      }
      clearTimeout(waiter.timer);
      this.controls.delete(message.type);
      waiter.resolve(message);
      return;
    }
    if (message.type === "response" || message.type === "health_result") {
      const waiter = this.pending.get(message.id);
      if (!waiter || waiter.expectedType !== message.type) {
        this.fail(new ProcessPluginHostError(
          "protocol_error", "Process plugin sent an unexpected response message."
        ));
        return;
      }
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      waiter.resolve(message);
      return;
    }
    this.fail(new ProcessPluginHostError(
      "protocol_error", "Process plugin sent a host-only protocol message."
    ));
  }

  private handleChildError(error: unknown): void {
    if (this.state === "stopping" || this.state === "stopped") return;
    this.fail(new ProcessPluginHostError(
      "process_error", "Process plugin process error: " + errorMessage(error)
    ), false);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.state === "stopping") {
      const waiter = this.controls.get("stopped");
      if (waiter) {
        clearTimeout(waiter.timer);
        this.controls.delete("stopped");
        waiter.resolve({
          protocol: PROCESS_PLUGIN_PROTOCOL,
          version: PROCESS_PLUGIN_PROTOCOL_VERSION,
          type: "stopped"
        });
      }
      return;
    }
    if (this.state === "stopped" || this.state === "idle") return;
    const stderr = errorMessage(this.stderr);
    const suffix = stderr && stderr !== "Plugin activation failed." ? " " + stderr : "";
    this.fail(new ProcessPluginHostError(
      "unexpected_exit",
      "Process plugin exited unexpectedly (code=" + String(code) +
        ", signal=" + String(signal) + ")." + suffix
    ), false);
  }

  private fail(error: ProcessPluginHostError, terminate = true): void {
    if (this.state === "stopped") return;
    this.state = "failed";
    this.lastError = error;
    this.rejectAll(error);
    if (terminate) void this.terminateChild(this.child).catch(() => undefined);
  }

  private waitForControl(
    type: ControlMessageType,
    timeoutMs: number,
    timeoutCode: string,
    timeoutMessage: string
  ): Promise<ControlMessage> {
    if (this.controls.has(type)) {
      return Promise.reject(new ProcessPluginHostError(
        "protocol_error", "Duplicate process plugin control waiter."
      ));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(type);
        reject(new ProcessPluginHostError(timeoutCode, timeoutMessage));
      }, timeoutMs);
      this.controls.set(type, { resolve, reject, timer });
    });
  }

  private waitForRequest(
    id: string,
    expectedType: PendingRequest["expectedType"],
    timeoutMs: number,
    timeoutCode: string
  ): Promise<ProcessPluginResponseMessage | ProcessPluginHealthResultMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProcessPluginHostError(timeoutCode, "Process plugin request timed out."));
      }, timeoutMs);
      this.pending.set(id, { expectedType, resolve, reject, timer });
    });
  }

  private write(message: ProcessPluginMessage): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) {
      throw this.lastError ?? new ProcessPluginHostError(
        "process_unavailable", "Process plugin process is unavailable."
      );
    }
    child.stdin.write(encodeProcessPluginMessage(message));
  }

  private assertActive(): void {
    if (this.state === "failed" && this.lastError) throw this.lastError;
    if (this.state !== "active") {
      throw new ProcessPluginHostError("not_active", "Process plugin host is not active.");
    }
  }

  private rejectAll(error: ProcessPluginHostError): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.controls.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.controls.clear();
  }

  private async terminateChild(child: ProcessPluginChild | null): Promise<void> {
    if (!child) return;
    if (this.platform === "win32" && child.pid) {
      await this.killTree(child.pid);
      return;
    }
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  private asHostError(error: unknown, code: string, fallback: string): ProcessPluginHostError {
    if (error instanceof ProcessPluginHostError) return error;
    const detail = errorMessage(error);
    return new ProcessPluginHostError(code, detail ? fallback + " " + detail : fallback);
  }
}
