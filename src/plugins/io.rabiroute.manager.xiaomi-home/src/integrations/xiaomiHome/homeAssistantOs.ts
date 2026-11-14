import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import type { XiaomiHomeRequestAuthority } from "./requestAuthority.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { xiaomiHomeInstallScriptPath } from "./pluginResources.js";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { HomeAssistantInstallProgress, HomeAssistantOsDiagnostics } from "@rabiroute/host-api/shared/homeAssistantDeploymentContract";

export type HomeAssistantOsStatus = Readonly<{
  state: "not_installed" | "installing" | "reboot_required" | "installed" | "error";
  message: string;
  version?: string;
  root?: string;
  progress?: HomeAssistantInstallProgress;
  installed?: boolean;
  endpoint?: Readonly<{ address: string; port: 80 | 8123; vmId: string; legacyBindingVerified: boolean }>;
  operationResult?: Readonly<{ operationId: string; action: "Install" | "Start" | "Recover"; startedAt: string; completedAt: string; outcome: string; code: string }>;
  deferred?: Readonly<{ reason: "host_memory" | "core_starting"; vmStarted: boolean; requiredMemoryBytes?: number; availableMemoryBytes?: number; nativeCode?: string }>;
}>;

export interface HomeAssistantOsDriver {
  readonly installationPath?: string;
  readonly diagnostics?: HomeAssistantOsDiagnostics;
  inspect(authority?: XiaomiHomeRequestAuthority): Promise<HomeAssistantOsStatus>;
  subscribe?(changed: () => void): () => void;
  run(operation: "Install" | "Start" | "Recover", autoStart: boolean, authority?: XiaomiHomeRequestAuthority, signal?: AbortSignal): Promise<HomeAssistantOsStatus>;
  /** Observe an owned running VM without starting, stopping, or modifying it. */
  observe?(signal?: AbortSignal): Promise<NonNullable<HomeAssistantOsStatus["endpoint"]> | undefined>;
}

const execute = promisify(execFile);
type OperationIdentity = Readonly<{ operationId: string; action: "Install" | "Start" | "Recover"; startedAt: string }>;

/** Only this completed child may classify a wait; global status.json is UI history. */
export function parseManagedHaOperation(stdout: string, expected: OperationIdentity): HomeAssistantOsStatus {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith("RABIROUTE_HA_RESULT:"));
  if (lines.length !== 1) throw new Error("Managed HA operation result is missing or ambiguous.");
  const value = JSON.parse(lines[0]!.slice("RABIROUTE_HA_RESULT:".length));
  if (!/^[0-9a-f-]{36}$/i.test(expected.operationId) || !Number.isFinite(Date.parse(expected.startedAt)) || !["Install", "Start", "Recover"].includes(expected.action)
    || !value || value.schemaVersion !== 1 || value.operationId !== expected.operationId || value.action !== expected.action || value.startedAt !== expected.startedAt
    || typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt)) || Date.parse(value.completedAt) < Date.parse(expected.startedAt)
    || Date.parse(value.completedAt) > Date.now() + 5000 || typeof value.message !== "string" || !value.message || value.message.length > 8192 || typeof value.installed !== "boolean") {
    throw new Error("Managed HA operation identity or time is invalid.");
  }
  const operationResult = { operationId: expected.operationId, action: expected.action, startedAt: expected.startedAt, completedAt: value.completedAt, outcome: value.outcome, code: value.code };
  const endpointLines = stdout.split(/\r?\n/).filter(line => line.startsWith("RABIROUTE_HA_ENDPOINT:"));
  if (value.outcome === "ready" && value.code === "core_ready" && value.installed === true && value.deferred === undefined) {
    return { state: "installed", installed: true, message: value.message, operationResult, endpoint: parseManagedHaEndpoint(stdout) };
  }
  if (endpointLines.length) throw new Error("An unready HA operation cannot publish an endpoint.");
  if (value.outcome === "deferred" && value.installed === true) {
    const deferred = value.deferred;
    if (!deferred || typeof deferred !== "object" || Array.isArray(deferred) || typeof deferred.vmStarted !== "boolean"
      || Object.keys(deferred).some(key => !["reason", "vmStarted", "requiredMemoryBytes", "availableMemoryBytes", "nativeCode"].includes(key))) throw new Error("Managed HA deferred result is invalid.");
    if (value.code === "host_memory_wait" && deferred.reason === "host_memory" && deferred.vmStarted === false
      && Number.isSafeInteger(deferred.requiredMemoryBytes) && deferred.requiredMemoryBytes > 0 && Number.isSafeInteger(deferred.availableMemoryBytes) && deferred.availableMemoryBytes >= 0
      && (deferred.nativeCode === undefined || deferred.nativeCode === "0x800705AA")) {
      return { state: "installed", installed: true, message: value.message, operationResult, deferred };
    }
    if (value.code === "core_starting" && deferred.reason === "core_starting" && Object.keys(deferred).every(key => ["reason", "vmStarted"].includes(key))) {
      return { state: "installed", installed: true, message: value.message, operationResult, deferred };
    }
    throw new Error("Managed HA deferred reason is invalid.");
  }
  if (value.deferred !== undefined) throw new Error("Unexpected HA deferred classification.");
  if (value.outcome === "failed" && value.code === "operation_failed") return { state: "error", installed: value.installed, message: value.message, operationResult };
  if (value.outcome === "reboot_required" && value.code === "hyperv_reboot_required") return { state: "reboot_required", installed: false, message: value.message, operationResult };
  throw new Error("Managed HA operation outcome is invalid.");
}

export async function completeManagedHaOperation(run: () => Promise<{ stdout: string }>, expected: OperationIdentity, signal?: AbortSignal): Promise<HomeAssistantOsStatus> {
  signal?.throwIfAborted();
  const result = await run();
  signal?.throwIfAborted();
  return parseManagedHaOperation(result.stdout, expected);
}

/** The endpoint is accepted only from the completed, fixed-path privileged child, never from the status file. */
export function parseManagedHaEndpoint(stdout: string): NonNullable<HomeAssistantOsStatus["endpoint"]> {
  const prefix = "RABIROUTE_HA_ENDPOINT:";
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error("Managed Home Assistant endpoint is missing or ambiguous.");
  const value = JSON.parse(lines[0].slice(prefix.length)) as Record<string, unknown>;
  if (typeof value.address !== "string" || isIP(value.address) !== 4 || (value.port !== 80 && value.port !== 8123)
      || typeof value.vmId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.vmId)
      || typeof value.legacyBindingVerified !== "boolean") {
    throw new Error("Managed Home Assistant endpoint is invalid.");
  }
  return { address: value.address, port: value.port, vmId: value.vmId, legacyBindingVerified: value.legacyBindingVerified };
}

export function parseManagedHaObservationStatus(stdout: string): Readonly<{ endpoint?: NonNullable<HomeAssistantOsStatus["endpoint"]>; diagnostics?: HomeAssistantOsDiagnostics }> {
  const prefix = "RABIROUTE_HA_OBSERVATION:";
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error("Managed Home Assistant observation is missing or ambiguous.");
  const value = JSON.parse(lines[0].slice(prefix.length)) as Record<string, unknown>;
  let diagnostics: HomeAssistantOsDiagnostics | undefined;
  if (value.diagnostics !== undefined) {
    const candidate = value.diagnostics as Record<string, unknown>;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).some(key => !["checkedAt", "reason", "vmState", "guestAddresses"].includes(key))
      || typeof candidate.checkedAt !== "string" || candidate.checkedAt.length > 40 || !Number.isFinite(Date.parse(candidate.checkedAt))
      || !["vm_not_found", "vm_not_running", "no_guest_address", "core_unready", "ready"].includes(String(candidate.reason))
      || (candidate.vmState !== undefined && (typeof candidate.vmState !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(candidate.vmState)))
      || !Array.isArray(candidate.guestAddresses) || candidate.guestAddresses.length > 8
      || candidate.guestAddresses.some(address => typeof address !== "string" || isIP(address) !== 4)
      || (candidate.reason === "ready") !== (value.ready === true)) {
      throw new Error("Managed Home Assistant observation diagnostics are invalid.");
    }
    diagnostics = Object.freeze({ checkedAt: candidate.checkedAt, reason: candidate.reason as HomeAssistantOsDiagnostics["reason"],
      vmState: candidate.vmState as string | undefined, guestAddresses: Object.freeze([...candidate.guestAddresses]) });
  }
  if (value.ready === false && Object.keys(value).every(key => key === "ready" || key === "diagnostics")) return { diagnostics };
  if (value.ready !== true) throw new Error("Managed Home Assistant observation is invalid.");
  return { endpoint: parseManagedHaEndpoint(`RABIROUTE_HA_ENDPOINT:${JSON.stringify(value)}`), diagnostics };
}

/** Compatibility projection for endpoint-only callers; diagnostics never grant endpoint readiness. */
export function parseManagedHaObservation(stdout: string): NonNullable<HomeAssistantOsStatus["endpoint"]> | undefined {
  return parseManagedHaObservationStatus(stdout).endpoint;
}

/** Fixed local installer; the HTTP caller cannot supply commands, paths or image URLs. */
export class WindowsHomeAssistantOs implements HomeAssistantOsDriver {
  private readonly root: string;
  private readonly script = xiaomiHomeInstallScriptPath();
  private observationDiagnostics?: HomeAssistantOsDiagnostics;

  get diagnostics(): HomeAssistantOsDiagnostics | undefined { return this.observationDiagnostics; }

  constructor(runtimeDir: string) {
    this.root = path.resolve(runtimeDir, "home-assistant-os");
  }

  get installationPath(): string { return this.root; }

  subscribe(changed: () => void): () => void {
    fs.mkdirSync(this.root, { recursive: true });
    const watcher = fs.watch(this.root, (_event, filename) => {
      if (filename?.toString() === "status.json") changed();
    });
    watcher.on("error", changed);
    return () => watcher.close();
  }

  async inspect(authority?: XiaomiHomeRequestAuthority): Promise<HomeAssistantOsStatus> {
    authority?.assert();
    if (process.platform !== "win32") return { state: "error", message: "自动安装 Home Assistant OS 需要 Windows 专业版与 Hyper-V。" };
    const filename = path.join(this.root, "status.json");
    if (!fs.existsSync(filename)) return { state: "not_installed", root: this.root, message: "点击安装将检查 Hyper-V；首次启用可能需要管理员确认和重启。" };
    const value = JSON.parse(await fs.promises.readFile(filename, "utf8")) as HomeAssistantOsStatus;
    authority?.assert();
    if (!["not_installed", "installing", "reboot_required", "installed", "error"].includes(value.state) || typeof value.message !== "string") {
      throw new Error("Home Assistant OS 安装状态无效，请检查本机安装日志。");
    }
    const { endpoint: _untrustedEndpoint, ...status } = value;
    return { ...status, installed: fs.existsSync(path.join(this.root, "image.json")) && fs.existsSync(path.join(this.root, "home-assistant.vhdx")) };
  }

  async run(operation: "Install" | "Start" | "Recover", autoStart: boolean, authority?: XiaomiHomeRequestAuthority, signal?: AbortSignal): Promise<HomeAssistantOsStatus> {
    authority?.assert();
    if (process.platform !== "win32") return this.inspect(authority);
    if (this.root.startsWith("\\\\") || !fs.existsSync(this.script)) throw new Error("Home Assistant OS 安装器必须从本机安装包运行。");
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const identity = { operationId: randomUUID(), action: operation, startedAt: new Date().toISOString() };
    authority?.dispatch();
    const status = await completeManagedHaOperation(() => execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.script,
      "-Operation", operation, "-Root", this.root, "-AutoStart", autoStart ? "yes" : "no", "-OperationId", identity.operationId, "-OperationStartedAt", identity.startedAt],
    { windowsHide: true, timeout: getTimeoutMs("backend.integrations.xiaomiHome.homeAssistantOs.run.execute.timeout", 30 * 60 * 1000), maxBuffer: 1024 * 1024, signal }), identity, signal);
    authority?.assert();
    return status;
  }

  async observe(signal?: AbortSignal): Promise<NonNullable<HomeAssistantOsStatus["endpoint"]> | undefined> {
    this.observationDiagnostics = undefined;
    if (process.platform !== "win32") return undefined;
    if (this.root.startsWith("\\\\") || !fs.existsSync(this.script)) throw new Error("Home Assistant OS 安装器必须从本机安装包运行。");
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.script,
      "-Operation", "Observe", "-Root", this.root, "-AutoStart", "no"],
    { windowsHide: true, timeout: getTimeoutMs("backend.integrations.xiaomiHome.homeAssistantOs.observe.execute.timeout", 60000), maxBuffer: 1024 * 1024, signal });
    const observation = parseManagedHaObservationStatus(result.stdout);
    signal?.throwIfAborted();
    this.observationDiagnostics = observation.diagnostics;
    return observation.endpoint;
  }
}
