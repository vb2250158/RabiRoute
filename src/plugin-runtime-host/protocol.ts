import { PLUGIN_HOSTS, type PluginContribution, type PluginIdentity } from "../plugin-kernel/types.js";

export const ISOLATED_PLUGIN_PROTOCOL_VERSION = 1;
export const ISOLATED_PLUGIN_SECURITY_MODEL = "fault-and-lifecycle-isolation-not-a-security-sandbox" as const;

export type IsolatedPluginService = Readonly<{ capability: string; value: unknown }>;
export type IsolatedPluginCommand = "prepare" | "commit" | "dispose" | "ping";
export type IsolatedPluginState = "prepared" | "committed" | "disposed";
export type IsolatedPluginPreparePayload = Readonly<{
  entryPath: string;
  config: unknown;
  permissions: readonly string[];
  services: readonly IsolatedPluginService[];
}>;

export type IsolatedPluginRequest = Readonly<{
  protocolVersion: 1;
  requestId: string;
  nonce: string;
  sequence: number;
  identity: PluginIdentity;
  command: IsolatedPluginCommand;
  payload?: IsolatedPluginPreparePayload;
}>;

export type IsolatedPluginResponse = Readonly<{
  protocolVersion: 1;
  requestId: string;
  nonce: string;
  sequence: number;
  identity: PluginIdentity;
  ok: boolean;
  state?: IsolatedPluginState;
  services?: readonly IsolatedPluginService[];
  contributions?: readonly PluginContribution[];
  error?: Readonly<{ code: string; message: string }>;
}>;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`${field} contains unsupported fields: ${extra.join(", ")}.`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) throw new Error(`${field} must be a non-empty bounded string.`);
  return value;
}

function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("Isolated plugin sequence must be a positive safe integer.");
  return value as number;
}

function parseIdentity(value: unknown): PluginIdentity {
  const raw = record(value, "Isolated plugin identity");
  const fields = ["applicationGenerationId", "managerInstanceId", "activationId", "instanceId", "pluginId", "version", "revision", "host"] as const;
  exactKeys(raw, fields, "Isolated plugin identity");
  const host = text(raw.host, "identity.host");
  if (!(PLUGIN_HOSTS as readonly string[]).includes(host)) throw new Error("identity.host is unsupported.");
  return Object.freeze({
    applicationGenerationId: text(raw.applicationGenerationId, "identity.applicationGenerationId"),
    managerInstanceId: text(raw.managerInstanceId, "identity.managerInstanceId"),
    activationId: text(raw.activationId, "identity.activationId"),
    instanceId: text(raw.instanceId, "identity.instanceId"),
    pluginId: text(raw.pluginId, "identity.pluginId"),
    version: text(raw.version, "identity.version"),
    revision: text(raw.revision, "identity.revision"),
    host: host as PluginIdentity["host"]
  });
}

function parseServices(value: unknown): readonly IsolatedPluginService[] {
  if (!Array.isArray(value) || value.length > 1_024) throw new Error("Isolated plugin services must be a bounded array.");
  return Object.freeze(value.map((item, index) => {
    const raw = record(item, `services[${index}]`);
    exactKeys(raw, ["capability", "value"], `services[${index}]`);
    return Object.freeze({ capability: text(raw.capability, `services[${index}].capability`), value: raw.value });
  }));
}

function parseContributions(value: unknown): readonly PluginContribution[] {
  if (!Array.isArray(value) || value.length > 4_096) throw new Error("Isolated plugin contributions must be a bounded array.");
  return Object.freeze(value.map((item, index) => {
    const raw = record(item, `contributions[${index}]`);
    exactKeys(raw, ["kind", "id", "value"], `contributions[${index}]`);
    return Object.freeze({
      kind: text(raw.kind, `contributions[${index}].kind`),
      id: text(raw.id, `contributions[${index}].id`),
      value: raw.value
    });
  }));
}

export function samePluginIdentity(left: PluginIdentity, right: PluginIdentity): boolean {
  return left.applicationGenerationId === right.applicationGenerationId
    && left.managerInstanceId === right.managerInstanceId
    && left.activationId === right.activationId
    && left.instanceId === right.instanceId
    && left.pluginId === right.pluginId
    && left.version === right.version
    && left.revision === right.revision
    && left.host === right.host;
}

export function parseIsolatedPluginRequest(value: unknown): IsolatedPluginRequest {
  const raw = record(value, "Isolated plugin request");
  exactKeys(raw, ["protocolVersion", "requestId", "nonce", "sequence", "identity", "command", "payload"], "Isolated plugin request");
  if (raw.protocolVersion !== ISOLATED_PLUGIN_PROTOCOL_VERSION) throw new Error("Isolated plugin protocol version mismatch.");
  const command = text(raw.command, "request.command");
  if (!["prepare", "commit", "dispose", "ping"].includes(command)) throw new Error("Isolated plugin command is unsupported.");
  let payload: IsolatedPluginPreparePayload | undefined;
  if (command === "prepare") {
    const input = record(raw.payload, "prepare payload");
    exactKeys(input, ["entryPath", "config", "permissions", "services"], "prepare payload");
    if (!Array.isArray(input.permissions) || input.permissions.some(item => typeof item !== "string") || input.permissions.length > 1_024) {
      throw new Error("prepare permissions must be a bounded string array.");
    }
    payload = Object.freeze({
      entryPath: text(input.entryPath, "prepare.entryPath"),
      config: input.config,
      permissions: Object.freeze([...input.permissions] as string[]),
      services: parseServices(input.services)
    });
  } else if (raw.payload !== undefined) {
    throw new Error(`Isolated plugin ${command} request must not include payload.`);
  }
  return Object.freeze({
    protocolVersion: ISOLATED_PLUGIN_PROTOCOL_VERSION,
    requestId: text(raw.requestId, "request.requestId"),
    nonce: text(raw.nonce, "request.nonce"),
    sequence: sequence(raw.sequence),
    identity: parseIdentity(raw.identity),
    command: command as IsolatedPluginCommand,
    ...(payload ? { payload } : {})
  });
}

export function parseIsolatedPluginResponse(value: unknown): IsolatedPluginResponse {
  const raw = record(value, "Isolated plugin response");
  exactKeys(raw, ["protocolVersion", "requestId", "nonce", "sequence", "identity", "ok", "state", "services", "contributions", "error"], "Isolated plugin response");
  if (raw.protocolVersion !== ISOLATED_PLUGIN_PROTOCOL_VERSION) throw new Error("Isolated plugin protocol version mismatch.");
  if (typeof raw.ok !== "boolean") throw new Error("response.ok must be boolean.");
  const state = raw.state === undefined ? undefined : text(raw.state, "response.state");
  if (state !== undefined && !["prepared", "committed", "disposed"].includes(state)) throw new Error("response.state is unsupported.");
  let error: Readonly<{ code: string; message: string }> | undefined;
  if (raw.error !== undefined) {
    const input = record(raw.error, "response.error");
    exactKeys(input, ["code", "message"], "response.error");
    error = Object.freeze({ code: text(input.code, "response.error.code"), message: text(input.message, "response.error.message") });
  }
  if (raw.ok && error) throw new Error("Successful isolated plugin response must not contain error.");
  if (!raw.ok && !error) throw new Error("Failed isolated plugin response must contain error.");
  return Object.freeze({
    protocolVersion: ISOLATED_PLUGIN_PROTOCOL_VERSION,
    requestId: text(raw.requestId, "response.requestId"),
    nonce: text(raw.nonce, "response.nonce"),
    sequence: sequence(raw.sequence),
    identity: parseIdentity(raw.identity),
    ok: raw.ok,
    ...(state ? { state: state as IsolatedPluginState } : {}),
    ...(raw.services === undefined ? {} : { services: parseServices(raw.services) }),
    ...(raw.contributions === undefined ? {} : { contributions: parseContributions(raw.contributions) }),
    ...(error ? { error } : {})
  });
}
