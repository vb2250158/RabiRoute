import { ContributionRegistry, type RabiUiContribution } from "./contributionRegistry.js";
import type { RabiPluginManifest } from "./pluginCatalog.js";

export type { RabiUiContribution } from "./contributionRegistry.js";

export const PROCESS_PLUGIN_PROTOCOL = "rabiroute.process-plugin" as const;
export const PROCESS_PLUGIN_PROTOCOL_VERSION = 1 as const;
export const PROCESS_PLUGIN_CAPABILITIES = ["ui.contributions"] as const;

export type ProcessPluginCapability = typeof PROCESS_PLUGIN_CAPABILITIES[number];

type ProcessPluginEnvelope = {
  protocol: typeof PROCESS_PLUGIN_PROTOCOL;
  version: typeof PROCESS_PLUGIN_PROTOCOL_VERSION;
};

export type ProcessPluginManifestMessage = ProcessPluginEnvelope & {
  type: "manifest";
  manifest: RabiPluginManifest & { kind: "external-process" };
  contributions: readonly RabiUiContribution[];
};

export type ProcessPluginHandshakeMessage = ProcessPluginEnvelope & {
  type: "handshake";
  instanceId: string;
  grantedCapabilities: readonly ProcessPluginCapability[];
};

export type ProcessPluginHandshakeAckMessage = ProcessPluginEnvelope & {
  type: "handshake_ack";
  instanceId: string;
};

export type ProcessPluginRequestMessage = ProcessPluginEnvelope & {
  type: "request";
  id: string;
  method: string;
  params?: unknown;
};

export type ProcessPluginResponseMessage = ProcessPluginEnvelope & {
  type: "response";
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
};

export type ProcessPluginHealthMessage = ProcessPluginEnvelope & { type: "health"; id: string };
export type ProcessPluginHealthResultMessage = ProcessPluginEnvelope & {
  type: "health_result";
  id: string;
  status: "ok" | "degraded";
  detail?: unknown;
};
export type ProcessPluginStopMessage = ProcessPluginEnvelope & { type: "stop"; reason?: string };
export type ProcessPluginStoppedMessage = ProcessPluginEnvelope & { type: "stopped" };

export type ProcessPluginMessage =
  | ProcessPluginManifestMessage
  | ProcessPluginHandshakeMessage
  | ProcessPluginHandshakeAckMessage
  | ProcessPluginRequestMessage
  | ProcessPluginResponseMessage
  | ProcessPluginHealthMessage
  | ProcessPluginHealthResultMessage
  | ProcessPluginStopMessage
  | ProcessPluginStoppedMessage;

export type ValidatedProcessPluginManifest = {
  manifest: ProcessPluginManifestMessage["manifest"];
  grantedCapabilities: ProcessPluginCapability[];
  contributions: RabiUiContribution[];
};

const MESSAGE_TYPES = new Set<ProcessPluginMessage["type"]>([
  "manifest", "handshake", "handshake_ack", "request", "response",
  "health", "health_result", "stop", "stopped"
]);
const KNOWN_CAPABILITIES = new Set<string>(PROCESS_PLUGIN_CAPABILITIES);
const PLUGIN_HOSTS = new Set(["manager", "gateway", "web", "desktop", "worker"]);
const CONTRIBUTION_HOSTS = new Set(["web", "desktop"]);
const CONTRIBUTION_KINDS = new Set([
  "page", "navigation", "settings-section", "status-card",
  "command", "tray-menu", "hotkey", "theme"
]);
const BASE_CONTRIBUTION_FIELDS = [
  "kind", "id", "label", "hosts", "surface", "slot",
  "order", "icon", "requiredCapabilities"
] as const;
const KIND_CONTRIBUTION_FIELDS: Record<RabiUiContribution["kind"], readonly string[]> = {
  page: ["routeId", "rendererId"],
  navigation: ["routeId"],
  "settings-section": ["rendererId", "schemaId", "readCommandId", "writeCommandId"],
  "status-card": ["queryId", "rendererId"],
  command: ["handlerId", "dangerLevel"],
  "tray-menu": ["commandId"],
  hotkey: ["commandId", "defaultBinding"],
  theme: ["themeId", "webResourceId", "desktopResourceId"]
};

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be an object.");
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedFields = new Set(allowed);
  const unsupported = Object.keys(value).find(key => !allowedFields.has(key));
  if (unsupported) throw new Error(field + " contains unsupported field: " + unsupported);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " is required.");
  if (/[\r\n\0]/.test(value)) throw new Error(field + " contains unsupported characters.");
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(field + " must be an array.");
  return value.map((item, index) => requiredString(item, field + "[" + index + "]"));
}

function assertId(value: unknown, field: string): string {
  const normalized = requiredString(value, field);
  if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(normalized)) {
    throw new Error(field + " contains unsupported characters.");
  }
  return normalized;
}

function validateLabel(value: unknown, field: string): void {
  const label = record(value, field);
  exactFields(label, ["key", "fallback"], field);
  optionalString(label.key, field + ".key");
  requiredString(label.fallback, field + ".fallback");
}

function validateContributionShape(value: unknown, index: number): asserts value is RabiUiContribution {
  const field = "Contribution[" + index + "]";
  const contribution = record(value, field);
  const kind = requiredString(contribution.kind, field + ".kind") as RabiUiContribution["kind"];
  if (!CONTRIBUTION_KINDS.has(kind)) throw new Error(field + ".kind is unsupported: " + kind);
  exactFields(contribution, [...BASE_CONTRIBUTION_FIELDS, ...KIND_CONTRIBUTION_FIELDS[kind]], field);
  assertId(contribution.id, field + ".id");
  validateLabel(contribution.label, field + ".label");
  const hosts = stringArray(contribution.hosts, field + ".hosts");
  if (!hosts.length || hosts.some(host => !CONTRIBUTION_HOSTS.has(host))) {
    throw new Error(field + ".hosts contains an unsupported host.");
  }
  assertId(contribution.surface, field + ".surface");
  assertId(contribution.slot, field + ".slot");
  if (contribution.order !== undefined &&
      (typeof contribution.order !== "number" || !Number.isFinite(contribution.order))) {
    throw new Error(field + ".order must be a finite number.");
  }
  if (contribution.icon !== undefined) assertId(contribution.icon, field + ".icon");
  if (contribution.requiredCapabilities !== undefined) {
    stringArray(contribution.requiredCapabilities, field + ".requiredCapabilities")
      .forEach((item, capabilityIndex) =>
        assertId(item, field + ".requiredCapabilities[" + capabilityIndex + "]"));
  }
  for (const property of KIND_CONTRIBUTION_FIELDS[kind]) {
    if (property === "dangerLevel") {
      if (contribution[property] !== undefined &&
          !["safe", "confirm", "dangerous"].includes(String(contribution[property]))) {
        throw new Error(field + ".dangerLevel is unsupported.");
      }
      continue;
    }
    if (property === "defaultBinding" || property === "webResourceId" || property === "desktopResourceId") {
      if (contribution[property] !== undefined) requiredString(contribution[property], field + "." + property);
      continue;
    }
    assertId(contribution[property], field + "." + property);
  }
}

function validatePluginManifest(value: unknown): asserts value is ProcessPluginManifestMessage["manifest"] {
  const manifest = record(value, "Process plugin manifest");
  exactFields(manifest, ["id", "name", "version", "kind", "hosts", "capabilities"], "Process plugin manifest");
  assertId(manifest.id, "Process plugin manifest id");
  requiredString(manifest.name, "Process plugin manifest name");
  requiredString(manifest.version, "Process plugin manifest version");
  if (manifest.kind !== "external-process") {
    throw new Error("Process plugin manifest kind must be external-process.");
  }
  const hosts = stringArray(manifest.hosts, "Process plugin manifest hosts");
  if (!hosts.length || hosts.some(host => !PLUGIN_HOSTS.has(host))) {
    throw new Error("Process plugin manifest contains an unsupported host.");
  }
  if (!hosts.includes("manager")) throw new Error("Process plugin manifest must support the manager host.");
  if (manifest.capabilities !== undefined) stringArray(manifest.capabilities, "Process plugin manifest capabilities");
}

function validateError(value: unknown): void {
  const error = record(value, "Process plugin response error");
  exactFields(error, ["code", "message"], "Process plugin response error");
  assertId(error.code, "Process plugin response error code");
  requiredString(error.message, "Process plugin response error message");
}

function validateMessage(value: unknown): asserts value is ProcessPluginMessage {
  const message = record(value, "Process plugin message");
  if (message.protocol !== PROCESS_PLUGIN_PROTOCOL) throw new Error("Unsupported process plugin protocol.");
  if (message.version !== PROCESS_PLUGIN_PROTOCOL_VERSION) throw new Error("Unsupported protocol version.");
  const type = requiredString(message.type, "Process plugin message type") as ProcessPluginMessage["type"];
  if (!MESSAGE_TYPES.has(type)) throw new Error("Unsupported message type.");
  switch (type) {
    case "manifest":
      exactFields(message, ["protocol", "version", "type", "manifest", "contributions"], "Process plugin manifest message");
      validatePluginManifest(message.manifest);
      if (!Array.isArray(message.contributions)) throw new Error("Process plugin contributions must be an array.");
      message.contributions.forEach(validateContributionShape);
      return;
    case "handshake":
      exactFields(message, ["protocol", "version", "type", "instanceId", "grantedCapabilities"], "Process plugin handshake message");
      assertId(message.instanceId, "Process plugin handshake instanceId");
      stringArray(message.grantedCapabilities, "Process plugin granted capabilities");
      return;
    case "handshake_ack":
      exactFields(message, ["protocol", "version", "type", "instanceId"], "Process plugin handshake acknowledgement");
      assertId(message.instanceId, "Process plugin handshake acknowledgement instanceId");
      return;
    case "request":
      exactFields(message, ["protocol", "version", "type", "id", "method", "params"], "Process plugin request");
      assertId(message.id, "Process plugin request id");
      assertId(message.method, "Process plugin request method");
      return;
    case "response":
      exactFields(message, ["protocol", "version", "type", "id", "result", "error"], "Process plugin response");
      assertId(message.id, "Process plugin response id");
      if (("result" in message) === ("error" in message)) {
        throw new Error("Process plugin response must contain exactly one of result or error.");
      }
      if (message.error !== undefined) validateError(message.error);
      return;
    case "health":
      exactFields(message, ["protocol", "version", "type", "id"], "Process plugin health request");
      assertId(message.id, "Process plugin health id");
      return;
    case "health_result":
      exactFields(message, ["protocol", "version", "type", "id", "status", "detail"], "Process plugin health result");
      assertId(message.id, "Process plugin health result id");
      if (message.status !== "ok" && message.status !== "degraded") {
        throw new Error("Process plugin health status is unsupported.");
      }
      return;
    case "stop":
      exactFields(message, ["protocol", "version", "type", "reason"], "Process plugin stop request");
      optionalString(message.reason, "Process plugin stop reason");
      return;
    case "stopped":
      exactFields(message, ["protocol", "version", "type"], "Process plugin stopped message");
      return;
  }
}

function cloneContributionBatch(
  contributions: readonly RabiUiContribution[],
  pluginId: string
): RabiUiContribution[] {
  const registry = new ContributionRegistry();
  registry.registerMany(pluginId, contributions, "process-plugin-manifest");
  return registry.catalog().contributions.map(
    ({ pluginId: _pluginId, instanceId: _instanceId, ...item }) => item
  );
}

export function validateProcessPluginManifest(
  message: ProcessPluginManifestMessage,
  allowedCapabilities: readonly ProcessPluginCapability[]
): ValidatedProcessPluginManifest {
  validateMessage(message);
  const requested = [...new Set(message.manifest.capabilities ?? [])];
  for (const capability of requested) {
    if (!KNOWN_CAPABILITIES.has(capability)) throw new Error("Unsupported capability: " + capability);
    if (!allowedCapabilities.includes(capability as ProcessPluginCapability)) {
      throw new Error("Capability is not granted: " + capability);
    }
  }
  if (message.contributions.length && !requested.includes("ui.contributions")) {
    throw new Error("Contribution declarations require the ui.contributions capability.");
  }
  return {
    manifest: {
      id: message.manifest.id,
      name: message.manifest.name,
      version: message.manifest.version,
      kind: "external-process",
      hosts: [...message.manifest.hosts],
      capabilities: requested
    },
    grantedCapabilities: requested as ProcessPluginCapability[],
    contributions: cloneContributionBatch(message.contributions, message.manifest.id)
  };
}

export function parseProcessPluginMessage(line: string): ProcessPluginMessage {
  let value: unknown;
  try {
    value = JSON.parse(line.trim());
  } catch {
    throw new Error("Process plugin message contains invalid JSON.");
  }
  validateMessage(value);
  return value;
}

export function encodeProcessPluginMessage(message: ProcessPluginMessage): string {
  validateMessage(message);
  return JSON.stringify(message) + "\n";
}
