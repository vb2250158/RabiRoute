import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeAgentAdapters, parseAgentAdapterType, type AgentAdapterType } from "../agentAdapters/types.js";
import { handleAgentThreadRequest, type AgentThreadRequest } from "../agentThreads.js";
import {
  deployAstrbotAdapter,
  getCopilotStatus,
  openMarvis,
  scanAgentAdapters,
  testAstrbotLogin as testAstrbotLoginEndpoint,
  type AgentManagerApiContext,
  type AstrbotLoginTestRequest,
  type MarvisOpenRequest
} from "../agentAdapters/managerApi.js";
import type { MessageAdapterType } from "../adapters/messageAdapter.js";
import type { ForwardRouteKind } from "../forwarding.js";
import { listDeliveryReplayAttempts } from "../deliveryReplayLedger.js";
import {
  configureNapcatOneBot,
  launchNapcatInstance as launchNapcatInstanceEndpoint,
  nextFreeLocalPort,
  prepareManagedNapcatInstance,
  restartNapcatInstance as restartNapcatInstanceEndpoint,
  scanNapcatEndpoint,
  stopNapcatInstance as stopNapcatInstanceEndpoint,
  testNapcatHealth as testNapcatHealthEndpoint
} from "../messageEndpoints/napcatManager.js";
import {
  scanFenneNoteEndpoint,
  scanRabiLinkEndpoint,
  scanWebhookEndpoint,
  scanXiaoAiEndpoint
} from "../messageEndpoints/webhookLikeScans.js";
import { scanWeComEndpoint } from "../messageEndpoints/wecomManager.js";
import { RemoteAgentHub, type RemoteAgentTask, type RemoteAgentTaskEvent, type RemoteAgentTaskRequest } from "../messageEndpoints/remoteAgentManager.js";
import { handleAgentReply, type AgentReplyRequest } from "../outbox.js";
import { normalizePipelineDefinition, type PipelineDefinition } from "../pipelines.js";
import {
  appendRolePanelTimelineMessage,
  createRolePanelMessageId,
  normalizeRolePanelAttachments,
  readRolePanelTimeline,
  type RolePanelAttachment
} from "../rolePanelTimeline.js";
import {
  autoAssignGatewayPorts as sharedAutoAssignGatewayPorts,
  definitionUsesNapcat as sharedDefinitionUsesNapcat,
  gatewayAdapterTypes as sharedGatewayAdapterTypes,
  normalizeGatewayDefinition as sharedNormalizeGatewayDefinition,
  validateGatewayPortConflicts as sharedValidateGatewayPortConflicts,
  type MessageAdapterPolicies
} from "../shared/gatewayConfigModel.js";
import {
  routeRuntimeParts,
  sanitizeConfigName,
  sanitizeRoleId
} from "../shared/routeIdentity.js";
import {
  adapterConfigPath as resolveAdapterConfigPath,
  roleFilePath,
  roleFolderPath,
  routeFolderPath,
  personaConfigPath as resolvePersonaConfigPath
} from "../shared/routePaths.js";
import { ManagerConfigRepository } from "./configRepository.js";
import { RabiGlobalConfigStore, type RabiLinkRelayGlobalConfig } from "./globalConfig.js";
import { handleRabiApi } from "./rabiApi.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { standaloneGatewayPayload as buildStandaloneGatewayPayload } from "./statusPayload.js";
import {
  applyMemoryConsolidationResult,
  createPlan,
  createRecentMemory,
  getConsolidatedMemory,
  getRecentMemory,
  getRoleSkill,
  listConsolidatedMemories,
  listConsolidationRuns,
  listPlans,
  listRecentMemories,
  listRoleSkills,
  pendingMemoryConsolidation,
  updatePlan,
  updateRecentMemory
} from "../roleKnowledge.js";

type GatewayDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  messageAdapterType?: MessageAdapterType;
  messageAdapters?: MessageAdapterType[];
  messageAdaptersDisabled?: MessageAdapterType[];
  messageInputsDisabled?: boolean;
  messageAdapterPolicies?: MessageAdapterPolicies;
  gatewayPort: number;
  webhookPort?: number;
  webhookPath?: string;
  fenneNoteWebhookPort?: number;
  fenneNoteWebhookPath?: string;
  xiaoaiWebhookPort?: number;
  xiaoaiWebhookPath?: string;
  rabiLinkWebhookPort?: number;
  rabiLinkWebhookPath?: string;
  rabiLinkWebhookHost?: string;
  rabiLinkRelayEnabled?: boolean;
  rabiLinkRelayUrl?: string;
  rabiLinkRelayToken?: string;
  rabiLinkRelayDeviceId?: string;
  rabiLinkRelayClaimWaitMs?: number;
  rabiLinkRelayReplyIdleTimeoutMs?: number;
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomWsUrl?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
  heartbeatSkipWhenAgentBusy?: boolean;
  remoteAgentDefaultDeviceId?: string;
  remoteAgentDefaultCwd?: string;
  remoteAgentDefaultThreadName?: string;
  napcatHttpUrl?: string;
  napcatWebuiUrl?: string;
  napcatAccessToken?: string;
  napcatWebuiToken?: string;
  napcatInstances?: NapCatInstanceDefinition[];
  ignoredNapcatInstanceIds?: string[];
  targetGroupId?: string;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  routeVariables?: Record<string, string>;
  routeName?: string;
  agentModel?: string;
  codexThreadName?: string;
  codexCwd?: string;
  copilotCwd?: string;
  copilotCliBin?: string;
  marvisAppId?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
  rolesDir?: string;
  routesDir?: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleFile?: string;
  agentAdapters?: AgentAdapterType[];
  routeProfiles?: RouteProfileDefinition[];
  dataDir?: string;
  groupNotificationTemplate?: string;
  groupAtNotificationTemplate?: string;
  groupDirectReplyNotificationTemplate?: string;
  groupIndirectReplyNotificationTemplate?: string;
  groupReplyNotificationTemplate?: string;
  groupNicknameNotificationTemplate?: string;
  privateNotificationTemplate?: string;
  heartbeatNotificationTemplate?: string;
  voiceTranscriptNotificationTemplate?: string;
  recentMessageLimit?: number;
  notificationRules?: NotificationRuleDefinition[];
  roleNotificationRules?: Record<string, NotificationRuleDefinition[]>;
  roleRouteNames?: Record<string, string>;
};

type RouteProfileDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  recentMessageLimit?: number;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  agentRoleId?: string;
  agentRoleFile?: string;
  rolesDir?: string;
  dataDir?: string;
  routeVariables?: Record<string, string>;
  notificationRules?: NotificationRuleDefinition[];
};

type NotificationRuleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  routeKinds?: string[];
  targetGroupId?: string;
  allowedSpeakerNames?: string[];
  regex?: string;
  schedules?: NotificationScheduleDefinition[];
  template: string;
};

type NotificationScheduleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  type: "interval" | "daily_time" | "once_at";
  intervalSeconds?: number;
  windowStartTime?: string;
  windowEndTime?: string;
  timeOfDay?: string;
  onceAt?: string;
};

type GatewayConfigFile = {
  gateways: GatewayDefinition[];
};

type GatewayRuntime = {
  definition: GatewayDefinition;
  process: ChildProcessWithoutNullStreams | null;
  needsRestart: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  lastExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  } | null;
  log: string[];
};

type AgentRuntimeState = Record<string, unknown> & {
  agentAdapterType: AgentAdapterType;
};

type AgentStateReportRequest = {
  gatewayId?: string;
  adapterType?: AgentAdapterType;
  state?: Record<string, unknown>;
};

type NapCatInstanceDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  gatewayPort: number;
  httpUrl: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
};

type AgentMaturity = "verified" | "experimental" | "stub";

type AgentScanSession = {
  id?: string;
  name: string;
  projectPath?: string;
  projectId?: string;
  updatedAt?: string;
  userNamed?: boolean;
};

type AgentScanProject = {
  id?: string;
  label: string;
  path: string;
  exists: boolean;
};

type AgentScanResult = {
  type: AgentAdapterType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  auth?: { required: boolean; loggedIn?: boolean; loginUrl?: string; message?: string };
  endpoints?: Array<{ label: string; url: string; healthy?: boolean }>;
  projects?: AgentScanProject[];
  sessions?: AgentScanSession[];
  plugins?: Array<{ id: string; name: string; installed: boolean; version?: string; healthy?: boolean }>;
  warnings?: string[];
};

type AdapterRequirement = {
  id: string;
  label: string;
  required?: boolean;
  ok?: boolean;
  detail?: string;
  actionLabel?: string;
  url?: string;
  path?: string;
};

type AdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

type MessageAdapterScanResult = {
  type: Exclude<MessageAdapterType, "disabled">;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  endpoints?: AdapterEndpoint[];
  requirements?: AdapterRequirement[];
  warnings?: string[];
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const managerPort = Number(process.env.GATEWAY_MANAGER_PORT ?? "8790");
const managerHost = process.env.GATEWAY_MANAGER_HOST ?? "127.0.0.1";
const remoteAgentPublicHost = process.env.REMOTE_AGENT_PUBLIC_HOST || process.env.GATEWAY_MANAGER_PUBLIC_HOST || "";
const remoteAgentDiscoverable = process.env.REMOTE_AGENT_DISCOVERABLE !== "0";
const configRepository = new ManagerConfigRepository({ rootDir, managerPort });
const rabiGlobalConfig = new RabiGlobalConfigStore(rootDir);

type ManagerConfig = { routeDir?: string; rolesDir?: string };

function readManagerConfig(): ManagerConfig {
  return configRepository.readManagerConfig();
}

function writeManagerConfig(cfg: ManagerConfig): void {
  configRepository.writeManagerConfig(cfg);
  routeRoot = configRepository.routeRoot;
  rolesRoot = configRepository.rolesRoot;
}

let rolesRoot = configRepository.rolesRoot;
let routeRoot = configRepository.routeRoot;
const fenneNotePlaybackUrl = process.env.FENNOTE_PLAYBACK_URL ?? "http://127.0.0.1:8793/api/fennenote/playback";
const fenneNoteReplyUrl = process.env.FENNOTE_REPLY_URL ?? "http://127.0.0.1:8793/api/fennenote/reply";
const fenneNotePlaybackToken = process.env.FENNOTE_PLAYBACK_TOKEN ?? "";
const fenneNoteReplyToken = process.env.FENNOTE_REPLY_TOKEN ?? fenneNotePlaybackToken;
const packageJsonPath = path.join(rootDir, "package.json");
const webuiDistPath = path.join(rootDir, "ribiwebgui", "dist");
const runtimes = new RuntimeRegistry();
const agentStateByGateway = new Map<string, Partial<Record<AgentAdapterType, AgentRuntimeState>>>();
const remoteAgentToken = process.env.REMOTE_AGENT_TOKEN?.trim() || "";
const remoteAgentHub = new RemoteAgentHub({
  managerPort,
  managerHost,
  publicHost: remoteAgentPublicHost,
  discoveryPort: Number(process.env.REMOTE_AGENT_DISCOVERY_PORT ?? "8798"),
  passwordStorePath: path.join(rootDir, "data", "remote-agent-connections.json"),
  fileStoreDir: path.join(rootDir, "data", "remote-agent-files"),
  getDefaultGatewayId: () => [...runtimes.values()][0]?.definition.id,
  onTaskEvent: handleRemoteAgentTaskEvent
});
let watchedConfigSnapshot = "";

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  const address = (value || "").replace(/^::ffff:/, "");
  return address === "::1" || address === "localhost" || address === "127.0.0.1" || address.startsWith("127.");
}

function remoteAgentRequestToken(request: http.IncomingMessage, requestUrl: URL): string {
  const bearer = headerValue(request.headers.authorization).match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  return requestUrl.searchParams.get("token")?.trim()
    || headerValue(request.headers["x-remote-agent-token"]).trim()
    || bearer;
}

function isRemoteAgentRequestAuthorized(request: http.IncomingMessage, requestUrl: URL): boolean {
  if (isLoopbackRemoteAddress(request.socket.remoteAddress)) return true;
  if (!remoteAgentToken) return false;
  return remoteAgentRequestToken(request, requestUrl) === remoteAgentToken;
}

function definitionFingerprint(definition: GatewayDefinition): string {
  return JSON.stringify(definition);
}

function ensureDataDirs(): void {
  configRepository.ensureDataDirs();
  routeRoot = configRepository.routeRoot;
  rolesRoot = configRepository.rolesRoot;
}

function readConfig(): GatewayConfigFile {
  ensureDataDirs();
  const gateways: GatewayDefinition[] = [];
  for (const routeEntry of fs.readdirSync(routeRoot, { withFileTypes: true })) {
    if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) {
      continue;
    }
    const configName = sanitizeRoleId(routeEntry.name);
    const configPath = adapterConfigPath(configName);
    if (!fs.existsSync(configPath)) {
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GatewayDefinition>;
    const personaConfig = readRoleMessageConfigItem(raw.agentRoleId, configName);
    gateways.push({
      ...raw,
      ...personaConfig,
      id: configName,
      configName,
      agentRoleId: raw.agentRoleId,
      rolesDir: raw.rolesDir,
      agentRoleFile: raw.agentRoleFile
    } as GatewayDefinition & { configName: string });
  }
  return { gateways };
}

function removeConfigFilesMissingFrom(activeConfigNames: Set<string>): void {
  ensureDataDirs();
  for (const routeEntry of fs.readdirSync(routeRoot, { withFileTypes: true })) {
    if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) {
      continue;
    }
    const configName = sanitizeRoleId(routeEntry.name);
    if (!configName || activeConfigNames.has(configName)) {
      continue;
    }
    const configPath = adapterConfigPath(configName);
    if (fs.existsSync(configPath)) {
      try { fs.unlinkSync(configPath); } catch { /* non-fatal */ }
    }
  }
}

function removeGatewayConfig(id: string): void {
  ensureDataDirs();
  const decodedId = decodeURIComponent(id);
  const runtime = runtimes.get(decodedId);
  const configName = runtime
    ? sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName
    : routeRuntimeParts(decodedId).configName || sanitizeConfigName(decodedId);
  if (!configName) {
    throw new Error(`Invalid gateway id: ${decodedId}`);
  }
  const configPath = adapterConfigPath(configName);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Gateway config not found: ${decodedId}`);
  }
  fs.unlinkSync(configPath);
}

function writeConfig(config: GatewayConfigFile): GatewayConfigFile {
  if (!Array.isArray(config.gateways)) {
    throw new Error("routes must be an array");
  }

  const normalized = { gateways: config.gateways.map(normalizeDefinition) };
  sharedAutoAssignGatewayPorts(normalized.gateways, managerPort);
  sharedValidateGatewayPortConflicts(normalized.gateways);
  const grouped = new Map<string, GatewayDefinition[]>();
  const activeConfigNames = new Set<string>();
  for (let i = 0; i < normalized.gateways.length; i++) {
    const item = normalized.gateways[i];
    const rawItem = config.gateways[i];
    const roleId = sanitizeRoleId(item.agentRoleId) || routeRuntimeParts(item.id).roleId;
    const configName = sanitizeConfigName(item.configName) || routeRuntimeParts(item.id).configName;
    activeConfigNames.add(configName);
    grouped.set(roleId, [...(grouped.get(roleId) ?? []), item]);
    // Rename data dir if configName changed (look up existing runtime by original/raw id)
    const existingRuntime = runtimes.get(rawItem.id) ?? runtimes.get(item.id);
    if (existingRuntime) {
      const oldDataDir = dataDirFor(existingRuntime.definition);
      const newDataDir = dataDirFor(item);
      if (oldDataDir !== newDataDir && fs.existsSync(oldDataDir)) {
        try {
          fs.mkdirSync(path.dirname(newDataDir), { recursive: true });
          fs.renameSync(oldDataDir, newDataDir);
        } catch {
          // Non-fatal: folder rename failed (e.g. cross-drive), data stays at old location
        }
      }
      // Remove old config file if id (configName) changed
      const oldConfigName = routeRuntimeParts(existingRuntime.definition.id).configName;
      if (oldConfigName !== configName) {
        const oldConfigPath = adapterConfigPath(oldConfigName);
        if (fs.existsSync(oldConfigPath)) {
          try { fs.unlinkSync(oldConfigPath); } catch { /* non-fatal */ }
        }
      }
    }
    writeAdapterConfigFile(item);
  }
  for (const [roleId, items] of grouped.entries()) {
    if (roleId) {
      writePersonaConfigFile(roleId, items);
    }
  }
  removeConfigFilesMissingFrom(activeConfigNames);
  return normalized;
}

function normalizeDefinition(definition: GatewayDefinition): GatewayDefinition {
  return sharedNormalizeGatewayDefinition(definition, {
    managerPort,
    routeDataDir: (configName) => path.relative(rootDir, routeFolderPath(routeRoot, configName)).replace(/\\/g, "/"),
    rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/"),
    normalizeAgentAdapters: (adapters) => normalizeAgentAdapters(adapters ?? []),
    normalizePipeline: (pipeline) => normalizePipelineDefinition(pipeline) as GatewayDefinition["pipeline"]
  }) as GatewayDefinition;
}

function normalizeMessageAdapters(items: unknown[]): MessageAdapterType[] {
  const adapters = items
    .map((item) => item == null ? "" : String(item))
    .filter((item): item is MessageAdapterType => item === "napcat" || item === "remoteAgent" || item === "fennenote" || item === "xiaoai" || item === "rabilink" || item === "webhook" || item === "wecom" || item === "heartbeat" || item === "rolePanel" || item === "disabled");
  const unique = [...new Set(adapters)].filter((item) => item !== "disabled");
  return unique.length > 0 ? unique : ["napcat"];
}

function sanitizeInstanceId(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  return raw.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

function normalizeNapCatInstances(definition: GatewayDefinition): NapCatInstanceDefinition[] {
  const source = Array.isArray(definition.napcatInstances) ? definition.napcatInstances : [];

  const used = new Set<string>();
  return source.map((item, index) => {
    const baseId = sanitizeInstanceId(item.id, `napcat-${index + 1}`);
    let id = baseId;
    let suffix = 2;
    while (used.has(id)) {
      id = `${baseId}-${suffix++}`;
    }
    used.add(id);
    const gatewayPort = Number(item.gatewayPort || definition.gatewayPort || 8790 + index);
    assertValidPort(gatewayPort, `NapCat instance port for ${definition.id}/${id}`);
    return {
      id,
      name: item.name?.trim() || id,
      enabled: item.enabled !== false,
      gatewayPort,
      httpUrl: item.httpUrl?.trim() || definition.napcatHttpUrl || "http://127.0.0.1:3000",
      webuiUrl: item.webuiUrl?.trim() || definition.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
      accessToken: item.accessToken ?? definition.napcatAccessToken ?? "",
      webuiToken: item.webuiToken ?? definition.napcatWebuiToken ?? "",
      launchCommand: item.launchCommand?.trim() || undefined,
      workingDir: item.workingDir?.trim() || undefined
    };
  });
}

function normalizeCodexCwd(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  const compact = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  if (!trimmed || compact === "c:/path/to/your/project") {
    return undefined;
  }

  return path.isAbsolute(trimmed) ? trimmed : path.resolve(rootDir, trimmed);
}

function resolveCodexThreadName(definition: GatewayDefinition): string {
  return definition.codexThreadName?.trim()
    || definition.routeName?.trim()
    || definition.name?.trim()
    || routeRuntimeParts(definition.id).configName
    || definition.id;
}

function normalizeIgnoredNapcatInstanceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(item => String(item || "").trim()).filter(Boolean))];
}

function assertValidPort(value: unknown, label: string): void {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}. Port must be an integer from 1 to 65535.`);
  }
}

function personaConfigPath(roleId: string): string {
  return resolvePersonaConfigPath(rolesRoot, roleId);
}

function adapterConfigPath(configName: string): string {
  return resolveAdapterConfigPath(routeRoot, configName);
}

function definitionUsesNapcat(definition: GatewayDefinition): boolean {
  return sharedDefinitionUsesNapcat(definition);
}

function adapterConfigItem(definition: GatewayDefinition): Record<string, unknown> {
  const usesNapcat = definitionUsesNapcat(definition);
  return {
    configName: sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName,
    name: definition.name,
    routeName: definition.routeName,
    enabled: definition.enabled !== false,
    messageAdapters: definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"],
    messageAdaptersDisabled: definition.messageAdaptersDisabled,
    messageInputsDisabled: definition.messageInputsDisabled,
    messageAdapterPolicies: definition.messageAdapterPolicies,
    pipelinePreset: definition.pipelinePreset,
    pipeline: definition.pipeline,
    gatewayPort: definition.gatewayPort,
    webhookPort: definition.webhookPort,
    webhookPath: definition.webhookPath,
    fenneNoteWebhookPort: definition.fenneNoteWebhookPort,
    fenneNoteWebhookPath: definition.fenneNoteWebhookPath,
    xiaoaiWebhookPort: definition.xiaoaiWebhookPort,
    xiaoaiWebhookPath: definition.xiaoaiWebhookPath,
    rabiLinkWebhookPort: definition.rabiLinkWebhookPort,
    rabiLinkWebhookPath: definition.rabiLinkWebhookPath,
    rabiLinkWebhookHost: definition.rabiLinkWebhookHost,
    napcatHttpUrl: definition.napcatHttpUrl,
    napcatWebuiUrl: definition.napcatWebuiUrl,
    napcatAccessToken: definition.napcatAccessToken,
    napcatWebuiToken: definition.napcatWebuiToken,
    napcatInstances: usesNapcat ? definition.napcatInstances : undefined,
    ignoredNapcatInstanceIds: normalizeIgnoredNapcatInstanceIds(definition.ignoredNapcatInstanceIds),
    heartbeatIntervalSeconds: definition.heartbeatIntervalSeconds,
    heartbeatMessage: definition.heartbeatMessage,
    heartbeatSkipWhenAgentBusy: definition.heartbeatSkipWhenAgentBusy,
    remoteAgentDefaultDeviceId: definition.remoteAgentDefaultDeviceId,
    remoteAgentDefaultCwd: definition.remoteAgentDefaultCwd,
    remoteAgentDefaultThreadName: definition.remoteAgentDefaultThreadName,
    agentModel: definition.agentModel,
    codexThreadName: definition.codexThreadName,
    codexCwd: definition.codexCwd,
    copilotCwd: definition.copilotCwd,
    copilotCliBin: definition.copilotCliBin,
    marvisAppId: definition.marvisAppId,
    astrbotUrl: definition.astrbotUrl,
    astrbotUsername: definition.astrbotUsername,
    astrbotPassword: definition.astrbotPassword,
    astrbotProjectId: definition.astrbotProjectId,
    astrbotSessionId: definition.astrbotSessionId,
    rolesDir: definition.rolesDir,
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile,
    agentAdapters: definition.agentAdapters,
    routeVariables: definition.routeVariables
  };
}

function hasGlobalRabiLinkRelayConfig(config = rabiGlobalConfig.read().rabiLinkRelay): boolean {
  return Boolean(config.url || config.token);
}

function rabiLinkRelayConfigFor(definition: GatewayDefinition): RabiLinkRelayGlobalConfig {
  const globalConfig = rabiGlobalConfig.read();
  const globalRelay = globalConfig.rabiLinkRelay;
  if (hasGlobalRabiLinkRelayConfig(globalRelay)) {
    return globalRelay;
  }
  const url = definition.rabiLinkRelayUrl?.trim() || "";
  const token = definition.rabiLinkRelayToken?.trim() || "";
  return {
    enabled: Boolean(url && token),
    url,
    token,
    deviceId: definition.rabiLinkRelayDeviceId?.trim() || globalRelay.deviceId || globalConfig.rabiName || definition.id,
    claimWaitMs: definition.rabiLinkRelayClaimWaitMs ?? globalRelay.claimWaitMs,
    replyIdleTimeoutMs: definition.rabiLinkRelayReplyIdleTimeoutMs ?? globalRelay.replyIdleTimeoutMs
  };
}

function firstRouteLevelRabiLinkRelayConfig(): RabiLinkRelayGlobalConfig | null {
  const globalConfig = rabiGlobalConfig.read();
  for (const definition of readConfig().gateways) {
    if (!definition.rabiLinkRelayUrl?.trim() && !definition.rabiLinkRelayToken?.trim()) continue;
    const url = definition.rabiLinkRelayUrl?.trim() || "";
    const token = definition.rabiLinkRelayToken?.trim() || "";
    return {
      enabled: Boolean(url && token),
      url,
      token,
      deviceId: definition.rabiLinkRelayDeviceId?.trim() || globalConfig.rabiLinkRelay.deviceId || globalConfig.rabiName || definition.id,
      claimWaitMs: definition.rabiLinkRelayClaimWaitMs ?? globalConfig.rabiLinkRelay.claimWaitMs,
      replyIdleTimeoutMs: definition.rabiLinkRelayReplyIdleTimeoutMs ?? globalConfig.rabiLinkRelay.replyIdleTimeoutMs
    };
  }
  return null;
}

function rabiLinkRelayConfigForMeta(): RabiLinkRelayGlobalConfig {
  const globalRelay = rabiGlobalConfig.read().rabiLinkRelay;
  if (hasGlobalRabiLinkRelayConfig(globalRelay)) return globalRelay;
  return firstRouteLevelRabiLinkRelayConfig() || globalRelay;
}

function writeAdapterConfigFile(definition: GatewayDefinition): void {
  const configName = sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName;
  const configPath = adapterConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(adapterConfigItem(definition), null, 2), "utf8");
}

function backfillNapcatInstanceWebuiToken(definition: GatewayDefinition, instanceId: string, token: unknown): string | null {
  const value = String(token || "").trim();
  if (!value) return null;
  const instances = normalizeNapCatInstances(definition);
  const target = instances.find((item) => item.id === instanceId);
  if (!target) return null;
  let changed = false;
  if (target.webuiToken !== value) {
    target.webuiToken = value;
    changed = true;
  }
  if (target.accessToken === value) {
    target.accessToken = "";
    changed = true;
  }
  if (!changed) return null;
  definition.napcatInstances = instances;
  const primary = instances.find((item) => item.enabled !== false) ?? instances[0];
  if (primary) {
    definition.napcatAccessToken = primary.accessToken ?? "";
    definition.napcatWebuiToken = primary.webuiToken ?? "";
  }
  writeAdapterConfigFile(definition);
  return value;
}

function backfillNapcatInstanceWebuiUrl(definition: GatewayDefinition, instanceId: string, webuiUrl: unknown): string | null {
  const value = String(webuiUrl || "").trim();
  if (!value) return null;
  const instances = normalizeNapCatInstances(definition);
  const target = instances.find((item) => item.id === instanceId);
  if (!target || target.webuiUrl === value) return null;
  target.webuiUrl = value;
  definition.napcatInstances = instances;
  const primary = instances.find((item) => item.enabled !== false) ?? instances[0];
  if (primary) {
    definition.napcatWebuiUrl = primary.webuiUrl;
    definition.napcatWebuiToken = primary.webuiToken ?? "";
  }
  writeAdapterConfigFile(definition);
  return value;
}

function correctedNapcatWebuiUrlFromHealth(health: Record<string, unknown>): string {
  const webui = (health.webui ?? {}) as Record<string, unknown>;
  return String(webui.correctedUrl || webui.correctedWebuiUrl || "").trim();
}

function addHealthDiagnostic(health: Record<string, unknown>, message: string): Record<string, unknown> {
  const diagnostics = Array.isArray(health.diagnostics) ? health.diagnostics : [];
  return {
    ...health,
    diagnostics: [
      ...diagnostics,
      message
    ]
  };
}

function napcatInstanceIgnoreKeys(instance: Partial<NapCatInstanceDefinition> & { botUserId?: unknown }): string[] {
  const keys = new Set<string>();
  const add = (prefix: string, value: unknown): void => {
    const text = String(value ?? "").trim();
    if (text) keys.add(`${prefix}:${text}`);
  };
  add("id", instance.id);
  add("ws", instance.gatewayPort);
  add("http", instance.httpUrl);
  add("webui", instance.webuiUrl);
  add("qq", instance.botUserId);
  return [...keys];
}

function ignoreNapcatInstance(definition: GatewayDefinition, instance: Partial<NapCatInstanceDefinition> & { botUserId?: unknown }): void {
  const next = new Set(normalizeIgnoredNapcatInstanceIds(definition.ignoredNapcatInstanceIds));
  for (const key of napcatInstanceIgnoreKeys(instance)) next.add(key);
  definition.ignoredNapcatInstanceIds = [...next];
}

async function addManagedNapcatInstance(request: NapcatAddRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  if (!gatewayId) throw new Error("缺少 gatewayId。");
  const runtime = runtimes.get(gatewayId);
  if (!runtime) throw new Error(`未找到路由：${gatewayId}`);
  const definition = runtime.definition;
  const instances = normalizeNapCatInstances(definition);
  const index = instances.length + 1;
  const usedIds = new Set(instances.map((item) => item.id));
  let id = sanitizeInstanceId(`napcat-${index}`, `napcat-${index}`);
  let idSuffix = index + 1;
  while (usedIds.has(id)) {
    id = sanitizeInstanceId(`napcat-${idSuffix}`, `napcat-${idSuffix}`);
    idSuffix += 1;
  }
  const used = new Set<number>();
  for (const runtimeItem of runtimes.values()) {
    for (const item of normalizeNapCatInstances(runtimeItem.definition)) {
      used.add(Number(item.gatewayPort || 0));
      try { used.add(Number(new URL(item.httpUrl).port || 0)); } catch { /* ignore */ }
      try { used.add(Number(new URL(item.webuiUrl || "").port || 0)); } catch { /* ignore */ }
    }
  }

  const steps = ["正在准备 NapCat 实例...", "正在查找合适端口..."];
  const webuiPort = await nextFreeLocalPort(6099 + instances.length, used);
  const httpPort = await nextFreeLocalPort(3000 + instances.length, used);
  const wsPort = await nextFreeLocalPort(Number(definition.gatewayPort || 8789) + instances.length, used);
  steps.push(`已分配端口：WebUI ${webuiPort} / HTTP ${httpPort} / WS ${wsPort}`);

  const prepared = prepareManagedNapcatInstance(napcatManagerCtx(), {
    id,
    name: `QQ ${index}`,
    gatewayPort: wsPort,
    httpPort,
    webuiPort,
    index
  });
  const instance = prepared.instance;
  steps.push(...prepared.steps);

  definition.napcatInstances = [...instances, instance];
  const primary = definition.napcatInstances.find((item) => item.enabled !== false) ?? instance;
  definition.gatewayPort = primary.gatewayPort;
  definition.napcatHttpUrl = primary.httpUrl;
  definition.napcatWebuiUrl = primary.webuiUrl;
  definition.napcatAccessToken = primary.accessToken ?? "";
  definition.napcatWebuiToken = primary.webuiToken ?? "";
  writeAdapterConfigFile(definition);
  loadRuntimes();

  steps.push("正在执行启动命令...");
  const launchResult = await launchNapcatInstanceEndpoint(napcatManagerCtx(), { gatewayId, instanceId: id });
  steps.push(String(launchResult.message || "已尝试启动 NapCat 后台。"));
  return {
    ok: launchResult.ok !== false,
    message: launchResult.ok !== false
      ? "已创建并启动 NapCat，请在自动打开的 WebUI 中登录 QQ。"
      : "已创建 NapCat 实例，但后台未在超时时间内可达；请检查启动命令或手动打开 WebUI。",
    steps,
    launch: launchResult,
    instance,
    webuiUrl: instance.webuiUrl,
    loginUrl: prepared.loginUrl || instance.webuiUrl
  };
}

async function removeManagedNapcatInstance(request: NapcatRemoveRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) throw new Error("缺少 gatewayId 或 instanceId。");
  const runtime = runtimes.get(gatewayId);
  if (!runtime) throw new Error(`未找到路由：${gatewayId}`);
  const instances = normalizeNapCatInstances(runtime.definition);
  const existing = instances.find((item) => item.id === instanceId);
  ignoreNapcatInstance(runtime.definition, {
    ...(existing || {}),
    id: instanceId,
    gatewayPort: request.gatewayPort ?? existing?.gatewayPort,
    httpUrl: request.httpUrl ?? existing?.httpUrl,
    webuiUrl: request.webuiUrl ?? existing?.webuiUrl,
    botUserId: request.botUserId
  });
  const stop = await stopNapcatInstanceEndpoint(napcatManagerCtx(), {
    gatewayId,
    instanceId,
    name: request.name,
    gatewayPort: request.gatewayPort,
    httpUrl: request.httpUrl,
    webuiUrl: request.webuiUrl,
    accessToken: request.accessToken,
    webuiToken: request.webuiToken,
    launchCommand: request.launchCommand,
    workingDir: request.workingDir
  });
  if (!existing) {
    writeAdapterConfigFile(runtime.definition);
    loadRuntimes();
    return {
      ok: true,
      message: "已关闭并忽略扫描发现的 NapCat 实例。",
      stop
    };
  }
  runtime.definition.napcatInstances = instances.filter((item) => item.id !== instanceId);
  const primary = runtime.definition.napcatInstances.find((item) => item.enabled !== false);
  if (primary) {
    runtime.definition.gatewayPort = primary.gatewayPort;
    runtime.definition.napcatHttpUrl = primary.httpUrl;
    runtime.definition.napcatWebuiUrl = primary.webuiUrl;
    runtime.definition.napcatAccessToken = primary.accessToken ?? "";
    runtime.definition.napcatWebuiToken = primary.webuiToken ?? "";
  } else {
    runtime.definition.messageAdaptersDisabled = [...new Set([...(runtime.definition.messageAdaptersDisabled ?? []), "napcat" as MessageAdapterType])];
    runtime.definition.messageAdapterPolicies = {
      ...(runtime.definition.messageAdapterPolicies ?? {}),
      napcat: {
        ...(runtime.definition.messageAdapterPolicies?.napcat ?? {}),
        inputEnabled: false
      }
    };
    runtime.definition.napcatAccessToken = "";
    runtime.definition.napcatWebuiToken = "";
  }
  writeAdapterConfigFile(runtime.definition);
  loadRuntimes();
  return {
    ok: true,
    message: "已停止并移除 NapCat 实例。",
    stop
  };
}

function readRoleMessageConfigShared(roleId: string | undefined): Partial<GatewayDefinition> {
  return configRepository.readRoleMessageConfig(roleId) as Partial<GatewayDefinition>;
}

function readRoleMessageConfigItem(roleId: string | undefined, _configName: string): Partial<GatewayDefinition> {
  return readRoleMessageConfigShared(roleId);
}

function writePersonaConfigFile(roleId: string, items: GatewayDefinition[]): void {
  // All gateways sharing this persona use the same rules; pick the first with rules, or fallback to first item
  const source = items.find(item => Array.isArray(item.notificationRules) && item.notificationRules.length > 0) ?? items[0];
  configRepository.writePersonaRules(roleId, source?.notificationRules);
}

function ensurePersonaConfigFile(roleId: string): string {
  const configPath = personaConfigPath(roleId);
  if (!fs.existsSync(configPath)) {
    const safeRoleId = sanitizeRoleId(roleId);
    configRepository.writePersonaRules(safeRoleId, []);
  }

  return configPath;
}

function openFileWithDefaultApp(filePath: string): void {
  const target = path.resolve(filePath);
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === "win32") {
    command = "cmd";
    args = ["/c", "explorer", target];
  } else if (platform === "darwin") {
    command = "open";
    args = [target];
  } else {
    command = "xdg-open";
    args = [target];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function openConfigFilePayload(type: string | null, gatewayId: string | null, roleId: string | null): Record<string, unknown> {
  if (type === "manager") {
    ensureDataDirs();
    openFileWithDefaultApp(routeRoot);
    return { code: 0, data: { path: routeRoot } };
  }

  if (type === "role" || type === "persona") {
    const runtime = gatewayId ? runtimes.get(gatewayId) : null;
    const safeRoleId = sanitizeRoleId(roleId ?? runtime?.definition.agentRoleId);
    if (!safeRoleId) {
      throw new Error("请先选择一个路由人格，再打开 persona.md。");
    }
    const roleFileName = runtime?.definition.agentRoleFile ?? "persona.md";
    const rolePath = roleFilePath(rolesRoot, safeRoleId, roleFileName);
    if (!fs.existsSync(rolePath)) {
      fs.mkdirSync(path.dirname(rolePath), { recursive: true });
      fs.writeFileSync(rolePath, "", "utf8");
    }
    openFileWithDefaultApp(rolePath);
    return { code: 0, data: { path: rolePath } };
  }

  if (type === "role-message-config") {
    const runtime = gatewayId ? runtimes.get(gatewayId) : null;
    const safeRoleId = sanitizeRoleId(roleId ?? runtime?.definition.agentRoleId);
    if (!safeRoleId) {
      throw new Error("请先选择一个路由人格，再打开 personaConfig.json。");
    }
    const configPath = ensurePersonaConfigFile(safeRoleId);
    openFileWithDefaultApp(configPath);
    return { code: 0, data: { path: configPath } };
  }

  if (type !== "routes" && type !== "route-folder") {
    throw new Error(`Unsupported config file type: ${type || ""}`);
  }

  if (!gatewayId) {
    openFileWithDefaultApp(routeRoot);
    return { code: 0, data: { path: routeRoot } };
  }

  const runtime = runtimes.get(gatewayId);
  if (!runtime) {
    // fallback: open routeRoot if runtime not found (e.g. unsaved configName change)
    openFileWithDefaultApp(routeRoot);
    return { code: 0, data: { path: routeRoot } };
  }

  const configName = sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName;
  const configPath = adapterConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    writeAdapterConfigFile(runtime.definition);
  }
  const targetPath = type === "route-folder" ? path.dirname(configPath) : configPath;
  openFileWithDefaultApp(targetPath);
  return { code: 0, data: { path: targetPath } };
}

function loadRuntimes(): void {
  const config = readConfig();
  const seen = new Set<string>();

  for (const rawDefinition of config.gateways) {
    const definition = normalizeDefinition(rawDefinition);
    seen.add(definition.id);
    const existing = runtimes.get(definition.id);
    if (existing) {
      if (definitionFingerprint(existing.definition) !== definitionFingerprint(definition)) {
        existing.needsRestart = true;
      }
      existing.definition = definition;
      continue;
    }

    runtimes.set(definition.id, {
      definition,
      process: null,
      needsRestart: false,
      startedAt: null,
      stoppedAt: null,
      lastExit: null,
      log: []
    });
  }

  for (const id of [...runtimes.keys()]) {
    if (!seen.has(id)) {
      const runtime = runtimes.get(id);
      if (runtime?.process) {
        runtime.process.kill();
      }
      runtimes.delete(id);
    }
  }
}

function syncRunningGateways(): void {
  for (const runtime of runtimes.values()) {
    if (runtime.definition.enabled && runtime.process && runtime.needsRestart) {
      appendLog(runtime, "restarting because gateway config changed");
      runtime.process.kill();
      continue;
    }
    if (runtime.definition.enabled && !runtime.process) {
      startGateway(runtime.definition.id);
    }
    if (!runtime.definition.enabled && runtime.process) {
      stopGateway(runtime.definition.id);
    }
  }
}

function watchedRouteFiles(): string[] {
  ensureDataDirs();
  const files = new Set<string>();
  for (const entry of fs.readdirSync(routeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) {
      continue;
    }
    files.add(adapterConfigPath(entry.name));
  }
  for (const entry of fs.readdirSync(rolesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) {
      continue;
    }
    const roleConfig = personaConfigPath(entry.name);
    if (fs.existsSync(roleConfig)) {
      files.add(roleConfig);
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

function configSnapshot(): string {
  return watchedRouteFiles().map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${file}|${stat.mtimeMs}|${stat.size}`;
    } catch {
      return `${file}|missing`;
    }
  }).join("\n");
}

function reloadChangedConfig(reason: string): void {
  try {
    loadRuntimes();
    syncRunningGateways();
    console.log(`gateway-manager reloaded ${reason}`);
  } catch (error) {
    console.error(`Failed to reload gateway config ${reason}`, error);
  }
}

function startConfigWatcher(): NodeJS.Timeout {
  watchedConfigSnapshot = configSnapshot();
  return setInterval(() => {
    const nextSnapshot = configSnapshot();
    if (nextSnapshot === watchedConfigSnapshot) {
      return;
    }
    watchedConfigSnapshot = nextSnapshot;
    reloadChangedConfig("after config file change");
  }, 2000);
}

function appendLog(runtime: GatewayRuntime, line: string): void {
  runtimes.appendLog(runtime, line);
  console.log(`[${runtime.definition.id}] ${line}`);
}

function childCommand(extraArgs: string[] = []): { command: string; args: string[]; shell: boolean } {
  const distEntry = path.join(rootDir, "dist", "index.js");
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry, ...extraArgs], shell: false };
  }

  return { command: "npm", args: ["run", "dev", "--", ...extraArgs], shell: true };
}

function resolveWingetCopilot(): string | null {
  if (!process.env.LOCALAPPDATA) return null;
  const wingetBase = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of fs.readdirSync(wingetBase)) {
      if (entry.startsWith("GitHub.Copilot")) {
        const exe = path.join(wingetBase, entry, "copilot.exe");
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* skip */ }
  return null;
}

function envFor(definition: GatewayDefinition): NodeJS.ProcessEnv {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeConfigName(definition.configName) || parts.configName;
  const routeDataDir = path.relative(rootDir, routeFolderPath(routeRoot, configName)).replace(/\\/g, "/");
  const routeRolesDir = path.relative(rootDir, rolesRoot).replace(/\\/g, "/");
  const activeAdapters = sharedGatewayAdapterTypes(definition);
  const runtimeAdapters = activeAdapters.length > 0 ? activeAdapters : ["disabled" as MessageAdapterType];
  const rabiLinkRelay = rabiLinkRelayConfigFor(definition);
  const globalConfig = rabiGlobalConfig.read();
  return {
    ...process.env,
    GATEWAY_ID: definition.id,
    RABI_GUID: globalConfig.rabiGuid,
    GATEWAY_MANAGER_PORT: String(managerPort),
    GATEWAY_MANAGER_URL: `http://127.0.0.1:${managerPort}`,
    MESSAGE_ADAPTER_TYPE: runtimeAdapters[0] ?? "napcat",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(runtimeAdapters),
    AGENT_MODEL: definition.agentModel?.trim() || "",
    PIPELINE_PRESET: definition.pipelinePreset ?? "",
    PIPELINE: definition.pipeline ? JSON.stringify(definition.pipeline) : "",
    HEARTBEAT_INTERVAL_SECONDS: String(definition.heartbeatIntervalSeconds ?? 900),
    HEARTBEAT_MESSAGE: definition.heartbeatMessage ?? "定时心跳巡检：请检查最近消息和角色相关上下文。",
    HEARTBEAT_SKIP_WHEN_AGENT_BUSY: definition.heartbeatSkipWhenAgentBusy ? "1" : "0",
    REMOTE_AGENT_DEFAULT_DEVICE_ID: definition.remoteAgentDefaultDeviceId?.trim() || "",
    REMOTE_AGENT_DEFAULT_CWD: definition.remoteAgentDefaultCwd?.trim() || "",
    REMOTE_AGENT_DEFAULT_THREAD_NAME: definition.remoteAgentDefaultThreadName?.trim() || "",
    NAPCAT_HTTP_URL: definition.napcatHttpUrl ?? process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
    NAPCAT_WEBUI_URL: definition.napcatWebuiUrl ?? process.env.NAPCAT_WEBUI_URL ?? "http://127.0.0.1:6099/webui",
    NAPCAT_ACCESS_TOKEN: definition.napcatAccessToken ?? process.env.NAPCAT_ACCESS_TOKEN ?? "",
    NAPCAT_WEBUI_TOKEN: definition.napcatWebuiToken ?? process.env.NAPCAT_WEBUI_TOKEN ?? "",
    NAPCAT_INSTANCES: JSON.stringify(definition.napcatInstances ?? normalizeNapCatInstances(definition)),
    GATEWAY_PORT: String(definition.gatewayPort),
    WEBHOOK_PORT: String(definition.webhookPort ?? definition.gatewayPort),
    WEBHOOK_PATH: definition.webhookPath ?? "/webhook",
    FENNENOTE_WEBHOOK_PORT: String(definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    FENNENOTE_WEBHOOK_PATH: definition.fenneNoteWebhookPath ?? "/fennenote",
    FENNOTE_WEBHOOK_PORT: String(definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    FENNOTE_WEBHOOK_PATH: definition.fenneNoteWebhookPath ?? "/fennenote",
    XIAOAI_WEBHOOK_PORT: String(definition.xiaoaiWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    XIAOAI_WEBHOOK_PATH: definition.xiaoaiWebhookPath ?? "/xiaoai",
    RABILINK_WEBHOOK_PORT: String(definition.rabiLinkWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    RABILINK_WEBHOOK_PATH: definition.rabiLinkWebhookPath ?? "/rabilink",
    RABILINK_WEBHOOK_HOST: definition.rabiLinkWebhookHost?.trim() || "0.0.0.0",
    RABILINK_RELAY_ENABLED: rabiLinkRelay.url && rabiLinkRelay.token ? "1" : "",
    RABILINK_RELAY_URL: rabiLinkRelay.url,
    RABILINK_RELAY_APP_TOKEN: rabiLinkRelay.token,
    RABILINK_RELAY_DEVICE_ID: rabiLinkRelay.deviceId || definition.id,
    RABILINK_RELAY_DEVICE_GUID: globalConfig.rabiGuid,
    RABILINK_RELAY_WEBGUI_URL: `http://127.0.0.1:${managerPort}`,
    RABILINK_RELAY_CLAIM_WAIT_MS: String(rabiLinkRelay.claimWaitMs),
    RABILINK_RELAY_REPLY_IDLE_TIMEOUT_MS: String(rabiLinkRelay.replyIdleTimeoutMs),
    WECOM_BOT_ID: definition.wecomBotId?.trim() || process.env.WECOM_BOT_ID || "",
    WECOM_BOT_SECRET: definition.wecomBotSecret?.trim() || process.env.WECOM_BOT_SECRET || "",
    WECOM_WS_URL: definition.wecomWsUrl?.trim() || process.env.WECOM_WS_URL || "",
    CODEX_THREAD_NAME: resolveCodexThreadName(definition),
    CODEX_CWD: normalizeCodexCwd(definition.codexCwd) ?? process.env.CODEX_CWD ?? rootDir,
    COPILOT_CLI_BIN: definition.copilotCliBin?.trim() || process.env.COPILOT_CLI_BIN || resolveWingetCopilot() || (process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "copilot.cmd") : "") || "copilot",
    COPILOT_CWD: definition.copilotCwd?.trim() || process.env.COPILOT_CWD || rootDir,
    MARVIS_APP_ID: definition.marvisAppId?.trim() || process.env.MARVIS_APP_ID || "Tencent.Marvis",
    ASTRBOT_URL: definition.astrbotUrl?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185",
    ASTRBOT_USERNAME: definition.astrbotUsername?.trim() || process.env.ASTRBOT_USERNAME || "",
    ASTRBOT_PASSWORD: definition.astrbotPassword?.trim() || process.env.ASTRBOT_PASSWORD || "",
    ASTRBOT_PROJECT_ID: definition.astrbotProjectId?.trim() || process.env.ASTRBOT_PROJECT_ID || "",
    ASTRBOT_SESSION_ID: definition.astrbotSessionId?.trim() || process.env.ASTRBOT_SESSION_ID || "",
    ROLES_DIR: routeRolesDir,
    AGENT_ROLE_ID: sanitizeRoleId(definition.agentRoleId),
    AGENT_ROLE_FILE: definition.agentRoleFile ?? "persona.md",
    AGENT_ADAPTERS: Array.isArray(definition.agentAdapters) ? definition.agentAdapters.join(",") : process.env.AGENT_ADAPTERS ?? "",
    TARGET_GROUP_ID: definition.targetGroupId ?? "",
    BOT_NICKNAME: process.env.BOT_NICKNAME ?? "QQ小助手",
    ROUTE_VARIABLES: definition.routeVariables ? JSON.stringify(definition.routeVariables) : "",
    ROUTE_PROFILES: Array.isArray(definition.routeProfiles) ? JSON.stringify(definition.routeProfiles) : "",
    DATA_DIR: routeDataDir,
    GROUP_NOTIFICATION_TEMPLATE: definition.groupNotificationTemplate ?? "",
    GROUP_AT_NOTIFICATION_TEMPLATE: definition.groupAtNotificationTemplate ?? "",
    GROUP_DIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupDirectReplyNotificationTemplate ?? definition.groupReplyNotificationTemplate ?? "",
    GROUP_INDIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupIndirectReplyNotificationTemplate ?? definition.groupNicknameNotificationTemplate ?? "",
    PRIVATE_NOTIFICATION_TEMPLATE: definition.privateNotificationTemplate ?? "",
    VOICE_TRANSCRIPT_NOTIFICATION_TEMPLATE: definition.voiceTranscriptNotificationTemplate ?? "",
    NOTIFICATION_RULES: Array.isArray(definition.notificationRules) ? JSON.stringify(definition.notificationRules) : "",
  };
}

function startGateway(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  if (!runtime.definition.enabled) {
    appendLog(runtime, "skip start because gateway is disabled");
    return;
  }
  if (runtime.process && !runtime.process.killed) {
    return;
  }

  const command = childCommand();
  const child = spawn(command.command, command.args, {
    cwd: rootDir,
    env: envFor(runtime.definition),
    shell: command.shell,
    windowsHide: true
  });

  runtime.log = [];
  runtime.process = child;
  runtime.needsRestart = false;
  runtime.startedAt = new Date().toISOString();
  runtime.stoppedAt = null;
  appendLog(runtime, `started pid=${child.pid ?? "unknown"} port=${runtime.definition.gatewayPort}`);

  child.stdout.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(runtime, line);
    }
  });

  child.stderr.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(runtime, `ERR ${line}`);
    }
  });

  child.on("exit", (code, signal) => {
    runtime.process = null;
    runtime.stoppedAt = new Date().toISOString();
    runtime.lastExit = {
      code,
      signal,
      at: runtime.stoppedAt
    };
    appendLog(runtime, `exited code=${code ?? ""} signal=${signal ?? ""}`);
    if (runtime.needsRestart && runtime.definition.enabled) {
      startGateway(runtime.definition.id);
    }
  });
}

function stopGateway(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  if (!runtime.process) {
    return;
  }

  appendLog(runtime, "stopping");
  runtime.process.kill();
}

function stopAllGateways(): void {
  for (const runtime of runtimes.values()) {
    runtime.needsRestart = false;
    if (runtime.process) {
      appendLog(runtime, "stopping because manager is shutting down");
      runtime.process.kill();
    }
  }
}

function dataDirFor(definition: GatewayDefinition): string {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeConfigName(definition.configName) || parts.configName;
  return routeFolderPath(routeRoot, configName);
}

function roleInfoFor(definition: GatewayDefinition): Record<string, unknown> {
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleFileName = definition.agentRoleFile ?? "persona.md";
  const selectedRoleId = sanitizeRoleId(definition.agentRoleId);
  const options: Array<Record<string, string>> = [];

  if (fs.existsSync(rolesDir)) {
    for (const entry of fs.readdirSync(rolesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) {
        continue;
      }

      const roleDir = roleFolderPath(rolesDir, entry.name);
      const markdownFiles = fs.readdirSync(roleDir)
        .filter((file) => file.toLowerCase().endsWith(".md"))
        .sort((left, right) => left.localeCompare(right));
      const preferredFile = markdownFiles.includes(roleFileName) ? roleFileName : markdownFiles[0] ?? roleFileName;
      const rolePath = roleFilePath(rolesDir, entry.name, preferredFile);
      let roleContent = "";
      let roleError = "";
      try {
        roleContent = fs.readFileSync(rolePath, "utf8");
      } catch (error) {
        roleError = error instanceof Error ? error.message : String(error);
      }
      options.push({
        label: entry.name,
        value: entry.name,
        rolePath,
        roleContent,
        roleError,
        dataDir: roleDir
      });
    }
  }

  const selectedDir = selectedRoleId ? roleFolderPath(rolesDir, selectedRoleId) : "";
  const selectedRolePath = selectedRoleId ? roleFilePath(rolesDir, selectedRoleId, roleFileName) : "";
  let selectedRoleContent = "";
  let selectedRoleError = "";
  if (selectedRolePath) {
    try {
      selectedRoleContent = fs.readFileSync(selectedRolePath, "utf8");
    } catch (error) {
      selectedRoleError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    rolesDir,
    selectedRoleId,
    selectedRolePath,
    selectedRoleContent,
    selectedRoleError,
    selectedRoleDataDir: selectedDir,
    options
  };
}

function readCodexState(definition: GatewayDefinition): Record<string, unknown> {
  const agentAdapters = definition.agentAdapters ?? ["codex"];
  const hasCodexAdapter = agentAdapters.includes("codex");
  if (agentAdapters.includes("copilotCli") && !hasCodexAdapter) {
    return readAgentState(definition, "copilotCli");
  }
  if (agentAdapters.includes("marvis") && !hasCodexAdapter) {
    return readAgentState(definition, "marvis");
  }
  if (agentAdapters.includes("astrbot") && !hasCodexAdapter) {
    return readAgentState(definition, "astrbot");
  }

  return readAgentState(definition, "codex");
}

function readAgentStates(definition: GatewayDefinition): Record<string, unknown> {
  const adapters = definition.agentAdapters ?? ["codex"];
  const states: Record<string, unknown> = {};
  for (const adapter of adapters) {
    states[adapter] = readAgentState(definition, adapter);
  }
  return states;
}

function readAgentState(definition: GatewayDefinition, adapterType: AgentAdapterType): Record<string, unknown> {
  const reported: Record<string, unknown> = agentStateByGateway.get(definition.id)?.[adapterType] ?? {};
  const base = defaultAgentState(definition, adapterType);
  if (adapterType === "codex") {
    const merged: Record<string, unknown> = {
      ...base,
      ...reported,
      ...codexBindingState(definition, adapterType)
    };
    const lastNotificationError = String(merged.lastNotificationError ?? "").trim();
    const lastDeliveryVisibility = String(merged.lastDeliveryVisibility ?? "").trim();
    if (lastDeliveryVisibility === "desktop-client-not-loaded") {
      const visibilityError = String(merged.lastCodexAppVisibilityError ?? "").trim();
      return {
        ...merged,
        bound: Boolean(merged.monitorThreadId),
        deliveryHealthy: false,
        message: visibilityError
          ? `Codex app-server fallback 已接受最近投递，但 Codex App 可见性保障失败：${visibilityError}`
          : "Codex app-server fallback 已接受最近投递；RabiRoute 已尝试启动/聚焦 Codex App，但目标 Desktop 会话当前没有确认加载。"
      };
    }
    if (!lastNotificationError) {
      return merged;
    }

    return {
      ...merged,
      bound: false,
      deliveryHealthy: false,
      message: codexDeliveryErrorSummary(
        lastNotificationError,
        Number(merged.retryPendingCount ?? 0),
        String(merged.nextRetryAt ?? "")
      )
    };
  }
  const merged: Record<string, unknown> = {
    ...base,
    ...reported,
    agentAdapterType: adapterType
  };
  return {
    ...merged,
    bound: adapterType === "marvis"
      ? false
      : Boolean(merged.lastNotificationAt && !merged.lastNotificationError)
  };
}

function codexDeliveryErrorSummary(error: string, retryPendingCount = 0, nextRetryAt = ""): string {
  if (error.includes("no-client-found")) {
    const lines = [
      "Codex Desktop 线程已在 session index 中找到，但当前没有加载成可投递客户端。",
      "需要打开/唤醒目标线程，或迁移到常驻 worker。"
    ];
    if (retryPendingCount > 0) {
      lines.push(`RabiRoute 已暂存 ${retryPendingCount} 条待补投消息${nextRetryAt ? `，下一次重试：${nextRetryAt}` : ""}。`);
    }
    return lines.join(" ");
  }

  return `Codex delivery failed: ${error}`;
}

function defaultAgentState(definition: GatewayDefinition, adapterType: AgentAdapterType): Record<string, unknown> {
  if (adapterType === "copilotCli") {
    return {
      agentAdapterType: adapterType,
      bound: false,
      monitorThreadName: definition.codexThreadName || "Copilot CLI",
      monitorThreadSource: definition.copilotCliBin || process.env.COPILOT_CLI_BIN || "copilot",
      monitorProjectPath: definition.copilotCwd || rootDir,
      message: "Copilot CLI 已配置；等待当前 Manager 进程收到成功投递上报。"
    };
  }

  if (adapterType === "marvis") {
    return {
      agentAdapterType: adapterType,
      bound: false,
      handoffOnly: true,
      monitorThreadName: "Marvis",
      monitorThreadSource: definition.marvisAppId?.trim() || process.env.MARVIS_APP_ID || "Tencent.Marvis",
      message: "Marvis 当前是打开桌面端并复制 prompt 的人工接力，不做线程绑定。"
    };
  }

  if (adapterType === "astrbot") {
    const astrbotUrl = definition.astrbotUrl?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185";
    return {
      agentAdapterType: adapterType,
      bound: false,
      monitorThreadName: "AstrBot Agent",
      monitorThreadSource: astrbotUrl,
      message: "AstrBot 已配置；等待当前 Manager 进程收到成功投递上报。"
    };
  }

  return codexBindingState(definition, adapterType);
}

function codexBindingState(definition: GatewayDefinition, adapterType: Extract<AgentAdapterType, "codex">): Record<string, unknown> {
  const targetName = resolveCodexThreadName(definition);
  const indexPath = sessionIndexPath();
  const best = readLatestSessionThreads(indexPath)
    .filter((record) => record.threadName === targetName)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];

  return {
    agentAdapterType: adapterType,
    bound: Boolean(best),
    monitorThreadId: best?.id,
    monitorThreadName: best?.threadName ?? targetName,
    monitorThreadUpdatedAt: best?.updatedAt,
    monitorThreadSource: indexPath,
    lastAutoDiscoveryAt: best ? new Date().toISOString() : undefined,
    message: best ? undefined : `No Codex thread named "${targetName}" was found in ${indexPath}. It will be auto-created on first delivery when Codex auto-create is enabled.`
  };
}

function sessionIndexPath(): string {
  return path.join(os.homedir(), ".codex", "session_index.jsonl");
}

type SessionThreadRecord = {
  id: string;
  threadName: string;
  updatedAt: string;
};

function normalizeComparablePath(value: string | undefined): string {
  if (!value) return "";
  const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function checkHttpEndpoint(url: string, timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function runtimeAdapterTypes(definition: GatewayDefinition): MessageAdapterType[] {
  const active = sharedGatewayAdapterTypes(definition);
  return active.length > 0 ? active : ["disabled"];
}

function adapterRuntimes(type: MessageAdapterType): GatewayRuntime[] {
  return [...runtimes.values()].filter((runtime) => runtimeAdapterTypes(runtime.definition).includes(type));
}

function firstLocalIpv4Address(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    const match = (addresses ?? []).find((address) => address.family === "IPv4" && !address.internal);
    if (match?.address) return match.address;
  }
  return "127.0.0.1";
}

function isUnspecifiedHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function callbackUrlForCopy(url: string, type: MessageAdapterType): string {
  if (type !== "rabilink") return url;
  try {
    const parsed = new URL(url);
    if (isUnspecifiedHttpHost(parsed.hostname)) {
      parsed.hostname = firstLocalIpv4Address();
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function routeCallbackEndpoint(runtime: GatewayRuntime, type: MessageAdapterType): AdapterEndpoint | null {
  if (type !== "webhook" && type !== "fennenote" && type !== "xiaoai" && type !== "rabilink") return null;
  const definition = runtime.definition;
  const status = readGatewayStatus(definition) as Record<string, any>;
  const callback = status.httpCallbacks?.[type];
  const port = type === "fennenote"
    ? definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
    : type === "xiaoai"
      ? definition.xiaoaiWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
      : type === "rabilink"
        ? definition.rabiLinkWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
        : definition.webhookPort ?? definition.gatewayPort;
  const pathValue = type === "fennenote"
    ? definition.fenneNoteWebhookPath ?? "/fennenote"
    : type === "xiaoai"
      ? definition.xiaoaiWebhookPath ?? "/xiaoai"
      : type === "rabilink"
        ? definition.rabiLinkWebhookPath ?? "/rabilink"
        : definition.webhookPath ?? "/webhook";
  const normalized = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const host = type === "rabilink" ? definition.rabiLinkWebhookHost?.trim() || "0.0.0.0" : "127.0.0.1";
  const url = callbackUrlForCopy(String(callback?.url || `http://${host}:${port}${normalized}`), type);
  return {
    label: `${sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName} 回调入口`,
    url,
    healthy: Boolean(runtime.process && callback)
  };
}

function routeHasRecentMessages(runtime: GatewayRuntime, type: MessageAdapterType): boolean {
  try {
    const files = readMessageFiles(runtime.definition) as Record<string, { entries?: unknown[] }>;
    return Boolean(files[type]?.entries?.length);
  } catch {
    return false;
  }
}

function napcatManagerCtx() {
  return {
    rootDir,
    getRuntimes: () => [...runtimes.values()].map((runtime) => ({
      ...runtime,
      status: readGatewayStatus(runtime.definition) as Record<string, unknown>
    })),
    normalizeNapCatInstances,
    appendLog,
    checkHttpEndpoint
  };
}

function agentManagerApiCtx(): AgentManagerApiContext {
  return {
    rootDir,
    getRuntimes: () => runtimes.values(),
    sessionIndexPath,
    checkHttpEndpoint,
    resolveWingetCopilot
  };
}

function repairGatewayConfigsForScan(_targetGatewayId?: string): { changed: boolean; messages: string[] } {
  const original = readConfig().gateways;
  const messages: string[] = [];
  const managedNapcatRoot = path.resolve(rootDir, "data", "napcat");
  const normalized = original.map((definition) => {
    if (!definitionUsesNapcat(definition) && Array.isArray(definition.napcatInstances) && definition.napcatInstances.length > 0) {
      messages.push(`已移除 ${definition.id} 中残留的 NapCat 实例配置。`);
    }
    const cleanedDefinition = { ...definition };
    if (Array.isArray(cleanedDefinition.napcatInstances)) {
      const kept = cleanedDefinition.napcatInstances.filter((instance) => {
        const workingDir = instance.workingDir?.trim();
        if (!workingDir) return true;
        const resolved = path.resolve(workingDir);
        const relative = path.relative(managedNapcatRoot, resolved);
        const isManaged = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
        const keep = !isManaged || fs.existsSync(resolved);
        if (!keep) {
          messages.push(`已移除 ${definition.id}/${instance.id} 中已删除的受管 NapCat 实例配置。`);
        }
        return keep;
      });
      cleanedDefinition.napcatInstances = kept;
      if ((definition.napcatInstances?.length ?? 0) > 0 && kept.length === 0) {
        cleanedDefinition.messageAdaptersDisabled = [...new Set([...(cleanedDefinition.messageAdaptersDisabled ?? []), "napcat" as MessageAdapterType])];
        cleanedDefinition.messageAdapterPolicies = {
          ...(cleanedDefinition.messageAdapterPolicies ?? {}),
          napcat: {
            ...(cleanedDefinition.messageAdapterPolicies?.napcat ?? {}),
            inputEnabled: false
          }
        };
      }
    }
    return normalizeDefinition(cleanedDefinition);
  });
  sharedAutoAssignGatewayPorts(normalized, managerPort);
  sharedValidateGatewayPortConflicts(normalized);

  const byId = new Map(original.map((definition) => [definition.id, definition]));
  for (const repaired of normalized) {
    const before = byId.get(repaired.id);
    if (!before) {
      messages.push(`已补齐路由 ${repaired.id} 的标准配置。`);
      continue;
    }
    if (before.gatewayPort !== repaired.gatewayPort) {
      messages.push(`已为 ${repaired.id} 重新分配入口端口：${before.gatewayPort} -> ${repaired.gatewayPort}。`);
    }
    if (before.webhookPort !== repaired.webhookPort && repaired.webhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 Webhook 端口：${before.webhookPort || "-"} -> ${repaired.webhookPort}。`);
    }
    if (before.fenneNoteWebhookPort !== repaired.fenneNoteWebhookPort && repaired.fenneNoteWebhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 FenneNote 端口：${before.fenneNoteWebhookPort || "-"} -> ${repaired.fenneNoteWebhookPort}。`);
    }
    if (before.xiaoaiWebhookPort !== repaired.xiaoaiWebhookPort && repaired.xiaoaiWebhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 XiaoAI 端口：${before.xiaoaiWebhookPort || "-"} -> ${repaired.xiaoaiWebhookPort}。`);
    }
    if (definitionUsesNapcat(repaired)) {
      const beforeInstances = before.napcatInstances ?? [];
      const repairedInstances = repaired.napcatInstances ?? [];
      for (const instance of repairedInstances) {
        const old = beforeInstances.find((item) => item.id === instance.id);
        if (!old) continue;
        if (old.gatewayPort !== instance.gatewayPort) {
          messages.push(`已为 ${repaired.id}/${instance.id} 重新分配 WS 端口：${old.gatewayPort} -> ${instance.gatewayPort}。`);
        }
        if (old.httpUrl !== instance.httpUrl) {
          messages.push(`已为 ${repaired.id}/${instance.id} 重新分配 HTTP 地址：${old.httpUrl || "-"} -> ${instance.httpUrl}。`);
        }
      }
    }
  }

  const changed = messages.length > 0;
  if (changed) {
    writeConfig({ gateways: normalized });
    loadRuntimes();
    syncRunningGateways();
  }
  return { changed, messages };
}

function ensureGatewayRunningForScan(targetGatewayId?: string): string[] {
  const targetId = sanitizeRoleId(targetGatewayId);
  if (!targetId) return [];
  const runtime = runtimes.get(targetId);
  if (!runtime || !definitionUsesNapcat(runtime.definition)) return [];
  if (runtime.definition.enabled === false) return [];
  const messages: string[] = [];
  if (!runtime.process) {
    startGateway(runtime.definition.id);
    messages.push(`已启动当前路由监听进程：${runtime.definition.id}。`);
  }
  return messages;
}

async function messageAdapterScanPayload(): Promise<Record<Exclude<MessageAdapterType, "disabled">, MessageAdapterScanResult>> {
  const webhookLikeScanCtx = {
    rootDir,
    adapterRuntimes,
    routeCallbackEndpoint,
    routeHasRecentMessages,
    checkHttpEndpoint,
    fenneNotePlaybackUrl
  };
  const [napcat, fennenote, xiaoai, rabilink, webhook, wecom] = await Promise.all([
    scanNapcatEndpoint(napcatManagerCtx()),
    scanFenneNoteEndpoint(webhookLikeScanCtx),
    scanXiaoAiEndpoint(webhookLikeScanCtx),
    scanRabiLinkEndpoint(webhookLikeScanCtx),
    scanWebhookEndpoint(webhookLikeScanCtx),
    scanWeComEndpoint({
      rootDir,
      adapterRuntimes,
      routeHasRecentMessages
    })
  ]);

  return {
    napcat,
    remoteAgent: remoteAgentHub.localScanResult(),
    heartbeat: {
      type: "heartbeat",
      label: "定时触发",
      maturity: "verified",
      installed: true,
      requirements: [
        { id: "route", label: "RabiRoute 内部定时器", required: true, ok: true, detail: "无需额外安装。" },
        { id: "agent", label: "Agent 端可接收消息", required: true, ok: undefined, detail: "保存后用“立即触发”或日志页验证投递。" }
      ],
      warnings: ["定时触发不会证明外部平台可用，只能验证路由到 Agent 的链路。"]
    },
    rolePanel: {
      type: "rolePanel",
      label: "角色面板",
      maturity: "verified",
      installed: true,
      requirements: [
        { id: "builtin", label: "RabiRoute 内置角色面板", required: true, ok: true, detail: "无需安装；托盘打开后可作为本地消息端使用。" },
        { id: "timeline", label: "角色聊天记录", required: true, ok: true, detail: "按角色写入 data/roles/<RoleId>/role-panel/messages.jsonl。" }
      ],
      warnings: ["角色面板是固定内置消息端，不能删除或禁用；自由聊天使用 role_panel_message 路由类型。"]
    },
    fennenote,
    xiaoai,
    rabilink,
    wecom,
    webhook
  };
}

async function napcatScanHealthPayload(): Promise<Record<string, { instances: Record<string, unknown> }>> {
  const ctx = napcatManagerCtx();
  const result: Record<string, { instances: Record<string, unknown> }> = {};
  for (const runtime of runtimes.values()) {
    if (!definitionUsesNapcat(runtime.definition)) continue;
    const instances = runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition);
    const rows = await Promise.all(instances.map(async (instance) => {
      let health = await testNapcatHealthEndpoint(ctx, {
        httpUrl: instance.httpUrl,
        webuiUrl: instance.webuiUrl,
        accessToken: instance.accessToken,
        webuiToken: instance.webuiToken,
        gatewayPort: instance.gatewayPort
      }) as Record<string, unknown>;
      const scannedWebui = (health.webui ?? {}) as Record<string, unknown>;
      const scannedCorrectedWebuiUrl = correctedNapcatWebuiUrlFromHealth(health);
      const backfilledWebuiUrl = backfillNapcatInstanceWebuiUrl(runtime.definition, instance.id, scannedCorrectedWebuiUrl);
      if (backfilledWebuiUrl) {
        instance.webuiUrl = backfilledWebuiUrl;
        health = addHealthDiagnostic(health, `已根据 NapCat webui.json 自动修正 WebUI 地址：${backfilledWebuiUrl}`);
      }
      const scannedToken = scannedWebui.token;
      const backfilledToken = backfillNapcatInstanceWebuiToken(runtime.definition, instance.id, scannedToken);
      if (backfilledToken) {
        instance.webuiToken = backfilledToken;
        const diagnostics = Array.isArray(health.diagnostics) ? health.diagnostics : [];
        health = {
          ...health,
          diagnostics: [
            ...diagnostics,
            "已从 NapCat webui.json 读取 WebUI token 并回填到服务器配置。"
          ]
        };
      }
      const webui = (health.webui ?? {}) as Record<string, unknown>;
      if (instance.enabled !== false && instance.launchCommand?.trim() && webui.reachable !== true) {
        const autoLaunchSteps: string[] = [];
        try {
          const launch = await launchNapcatInstanceEndpoint(ctx, {
            gatewayId: runtime.definition.id,
            instanceId: instance.id
          }) as Record<string, unknown>;
          autoLaunchSteps.push(String(launch.message || "已自动尝试后台启动 NapCat。"));
          for (let i = 0; i < 10; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const reachable = await checkHttpEndpoint(instance.webuiUrl || "", 900);
            if (reachable) break;
          }
          const afterLaunch = await testNapcatHealthEndpoint(ctx, {
            httpUrl: instance.httpUrl,
            webuiUrl: instance.webuiUrl,
            accessToken: instance.accessToken,
            webuiToken: instance.webuiToken,
            gatewayPort: instance.gatewayPort
          }) as Record<string, unknown>;
          const diagnostics = Array.isArray(afterLaunch.diagnostics) ? afterLaunch.diagnostics : [];
          const afterWebui = (afterLaunch.webui ?? {}) as Record<string, unknown>;
          const afterBackfilled = backfillNapcatInstanceWebuiToken(runtime.definition, instance.id, afterWebui.token);
          if (afterBackfilled) instance.webuiToken = afterBackfilled;
          health = {
            ...afterLaunch,
            diagnostics: [
              ...autoLaunchSteps,
              ...(afterBackfilled ? ["已从 NapCat webui.json 读取 WebUI token 并回填到服务器配置。"] : []),
              ...diagnostics
            ],
            autoLaunch: {
              ok: ((afterLaunch.webui ?? {}) as Record<string, unknown>).reachable === true,
              steps: autoLaunchSteps
            }
          };
        } catch (error) {
          const diagnostics = Array.isArray(health.diagnostics) ? health.diagnostics : [];
          health = {
            ...health,
            diagnostics: [
              ...diagnostics,
              `自动后台启动 NapCat 失败：${error instanceof Error ? error.message : String(error)}`
            ],
            autoLaunch: {
              ok: false,
              steps: [error instanceof Error ? error.message : String(error)]
            }
          };
        }
      }
      return [instance.id, health] as const;
    }));
    result[runtime.definition.id] = {
      instances: Object.fromEntries(rows)
    };
  }
  return result;
}

type NapcatHealthRequest = {
  gatewayId?: string;
  instanceId?: string;
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  gatewayPort?: number;
};

type NapcatAddRequest = {
  gatewayId?: string;
};

type NapcatRemoveRequest = {
  gatewayId?: string;
  instanceId?: string;
  name?: string;
  gatewayPort?: number;
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
  botUserId?: string | number;
  botNickname?: string;
};

type NapcatLaunchRequest = {
  gatewayId?: string;
  instanceId?: string;
};
function readLatestSessionThreads(indexPath: string): SessionThreadRecord[] {
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  const latestById = new Map<string, SessionThreadRecord>();
  for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
      if (typeof parsed.id !== "string" || typeof parsed.thread_name !== "string" || typeof parsed.updated_at !== "string") {
        continue;
      }
      const record = {
        id: parsed.id,
        threadName: parsed.thread_name,
        updatedAt: parsed.updated_at
      };
      const existing = latestById.get(record.id);
      if (!existing || Date.parse(record.updatedAt) > Date.parse(existing.updatedAt)) {
        latestById.set(record.id, record);
      }
    } catch {
      // Ignore malformed JSONL lines.
    }
  }

  return [...latestById.values()];
}

function readGatewayStatus(definition: GatewayDefinition): Record<string, unknown> {
  const statusPath = path.join(dataDirFor(definition), "gateway-status.json");
  if (!fs.existsSync(statusPath)) {
    return {
      statusPath,
      napcat: {
        connected: false
      }
    };
  }

  try {
    return {
      ...JSON.parse(fs.readFileSync(statusPath, "utf8")) as Record<string, unknown>,
      statusPath
    };
  } catch (error) {
    return {
      statusPath,
      napcat: {
        connected: false,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function napcatStatusRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value)) {
    const rows: Array<Record<string, unknown>> = [];
    for (const [id, item] of Object.entries(value)) {
      if (isRecord(item)) {
        rows.push({
          id,
          ...item
        });
      }
    }
    return rows;
  }
  return [];
}

function collectStartedNapcatInstances(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const runtime of runtimes.values()) {
    if (!runtime.process || !definitionUsesNapcat(runtime.definition)) {
      continue;
    }

    const configName = sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName;
    const configuredInstances = runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition);
    const status = readGatewayStatus(runtime.definition);
    const statusInstances = napcatStatusRows(status.napcatInstances);
    const sourceRows = statusInstances.length > 0
      ? statusInstances
      : napcatStatusRows(status.napcat ? { default: status.napcat } : {});

    for (const row of sourceRows) {
      const rowId = String(row.id || row.instanceId || "default");
      const rowPort = Number(row.gatewayPort || row.port || row.wsPort || 0);
      const configured = configuredInstances.find((instance) =>
        String(instance.id) === rowId || (rowPort > 0 && Number(instance.gatewayPort) === rowPort)
      );
      if (!configured) {
        continue;
      }
      const gatewayPort = Number(row.gatewayPort || configured?.gatewayPort || runtime.definition.gatewayPort || 0);
      const key = [
        runtime.definition.id,
        rowId,
        gatewayPort || "",
        row.httpUrl || configured?.httpUrl || ""
      ].join(":");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        ...configured,
        ...row,
        id: rowId,
        name: row.name || configured?.name || rowId,
        enabled: configured?.enabled !== false,
        gatewayPort,
        httpUrl: row.httpUrl || configured?.httpUrl || runtime.definition.napcatHttpUrl,
        webuiUrl: row.webuiUrl || configured?.webuiUrl || runtime.definition.napcatWebuiUrl,
        routeId: runtime.definition.id,
        routeName: runtime.definition.name || runtime.definition.routeName || configName,
        configName,
        started: true,
        running: true
      });
    }
  }

  return rows;
}

function gatewayStatusForRuntime(runtime: GatewayRuntime, startedNapcatInstances = collectStartedNapcatInstances()): Record<string, unknown> {
  const status = readGatewayStatus(runtime.definition);
  return {
    ...status,
    napcatInstances: startedNapcatInstances,
    napcatInstanceCount: startedNapcatInstances.length,
    napcatStartedInstanceCount: startedNapcatInstances.length
  };
}

function readJsonlTail(filePath: string, limit = 8): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { rawLine: line };
        }
      });
  } catch (error) {
    return [{
      error: error instanceof Error ? error.message : String(error),
      path: filePath
    }];
  }
}

function messageFileCandidateDirs(definition: GatewayDefinition): string[] {
  const dirs = new Set<string>();
  dirs.add(dataDirFor(definition));
  const roleId = sanitizeRoleId(definition.agentRoleId);
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  if (roleId) {
    dirs.add(roleFolderPath(rolesDir, roleId));
  }
  for (const profile of definition.routeProfiles ?? []) {
    if (profile.dataDir) {
      dirs.add(path.resolve(rootDir, profile.dataDir));
    }
    const profileRole = sanitizeRoleId(profile.agentRoleId);
    if (profileRole) {
      dirs.add(roleFolderPath(rolesDir, profileRole));
    }
  }
  return [...dirs];
}

function recordTimeMs(record: Record<string, unknown>): number {
  const time = record.time;
  if (typeof time === "number") {
    return time < 10_000_000_000 ? time * 1000 : time;
  }
  for (const key of ["createdAt", "lastEventAt", "startedAt", "endedAt"]) {
    const value = record[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function messageFileEntry(source: string, filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const groupId = record.groupId ?? record.group_id;
  const userId = record.userId ?? record.user_id;
  const text = record.rawMessage ?? record.message ?? record.text ?? record.content ?? record.rawLine ?? "";
  return {
    source,
    path: filePath,
    time: record.time,
    timeMs: recordTimeMs(record),
    messageId: record.messageId ?? record.message_id,
    instanceId: record.instanceId,
    adapterType: record.adapterType,
    sender: record.senderName ?? record.sender ?? record.source,
    target: groupId ? `群 ${String(groupId)}` : userId ? `私聊 ${String(userId)}` : record.source ?? source,
    text: typeof text === "string" ? text : JSON.stringify(text),
    raw: record
  };
}

function adapterLogEntry(filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const text = record.message ?? data.text ?? data.rawMessage ?? data.eventType ?? record.rawLine ?? "";
  return {
    adapter: record.adapter,
    event: record.event ?? "log",
    level: record.level ?? "info",
    instanceId: record.instanceId,
    path: filePath,
    time: record.time,
    timeMs: recordTimeMs(record),
    messageId: data.messageId ?? data.message_id,
    sender: data.senderName ?? data.sender ?? data.source,
    target: data.groupId ? `群 ${String(data.groupId)}` : data.userId ? `私聊 ${String(data.userId)}` : data.path ?? data.name,
    text: typeof text === "string" ? text : JSON.stringify(text),
    raw: record
  };
}

function readMessageFiles(definition: GatewayDefinition): Record<string, unknown> {
  const dirs = messageFileCandidateDirs(definition);
  const readEntries = (source: string, fileName: string) => dirs.flatMap((dir) => {
    const filePath = path.join(dir, fileName);
    return readJsonlTail(filePath, 8).map((record) => messageFileEntry(source, filePath, record));
  });
  const sortTail = (items: Array<Record<string, unknown>>) => items
    .sort((left, right) => Number(left.timeMs || 0) - Number(right.timeMs || 0))
    .slice(-8)
    .reverse();

  const napcatEntries = sortTail([
    ...readEntries("群聊", "group-messages.jsonl"),
    ...readEntries("私聊", "private-messages.jsonl")
  ]);
  const heartbeatEntries = sortTail(readEntries("定时触发", "heartbeat-events.jsonl"));
  const rolePanelEntries = sortTail(dirs.flatMap((dir) => {
    const filePath = path.join(dir, "role-panel", "messages.jsonl");
    return readJsonlTail(filePath, 8).map((record) => messageFileEntry("角色面板", filePath, record));
  }));
  const fenneNoteEntries = sortTail([
    ...readEntries("FenneNote / 芬妮笔记", "fennenote-voice-transcripts.jsonl"),
    ...readEntries("FenneNote / 芬妮笔记", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "fennenote")
  ]);
  const xiaoaiEntries = sortTail([
    ...readEntries("小米音箱 / 小爱", "xiaoai-voice-transcripts.jsonl"),
    ...readEntries("小米音箱 / 小爱", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "xiaoai")
  ]);
  const rabiLinkEntries = sortTail([
    ...readEntries("RabiLink / Relay", "rabilink-voice-transcripts.jsonl"),
    ...readEntries("RabiLink / Relay", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "rabilink")
  ]);
  const webhookEntries = sortTail(readEntries("通用 Webhook", "voice-transcripts.jsonl")
    .filter((entry) => {
      const adapterType = String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase();
      return !adapterType || adapterType === "webhook";
    }));
  const wecomEntries = sortTail(readEntries("企业微信 / WeCom", "wecom-messages.jsonl"));

  return {
    napcat: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "group-messages.jsonl"),
        path.join(dir, "private-messages.jsonl")
      ]),
      entries: napcatEntries
    },
    heartbeat: {
      paths: dirs.map((dir) => path.join(dir, "heartbeat-events.jsonl")),
      entries: heartbeatEntries
    },
    rolePanel: {
      paths: dirs.map((dir) => path.join(dir, "role-panel", "messages.jsonl")),
      entries: rolePanelEntries
    },
    fennenote: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "fennenote-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: fenneNoteEntries
    },
    xiaoai: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "xiaoai-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: xiaoaiEntries
    },
    rabilink: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "rabilink-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: rabiLinkEntries
    },
    wecom: {
      paths: dirs.map((dir) => path.join(dir, "wecom-messages.jsonl")),
      entries: wecomEntries
    },
    webhook: {
      paths: dirs.map((dir) => path.join(dir, "voice-transcripts.jsonl")),
      entries: webhookEntries
    }
  };
}

function readAdapterLogs(definition: GatewayDefinition): Record<string, unknown> {
  const dir = dataDirFor(definition);
  const readEntries = (adapter: MessageAdapterType | "outbox") => {
    const filePath = path.join(dir, `${adapter}-adapter.log.jsonl`);
    return readJsonlTail(filePath, 12)
      .map((record) => adapterLogEntry(filePath, record))
      .sort((left, right) => Number(left.timeMs || 0) - Number(right.timeMs || 0))
      .reverse();
  };

  return {
    napcat: {
      paths: [path.join(dir, "napcat-adapter.log.jsonl")],
      entries: readEntries("napcat")
    },
    heartbeat: {
      paths: [path.join(dir, "heartbeat-adapter.log.jsonl")],
      entries: readEntries("heartbeat")
    },
    rolePanel: {
      paths: [path.join(dir, "rolePanel-adapter.log.jsonl")],
      entries: readEntries("rolePanel")
    },
    fennenote: {
      paths: [path.join(dir, "fennenote-adapter.log.jsonl")],
      entries: readEntries("fennenote")
    },
    xiaoai: {
      paths: [path.join(dir, "xiaoai-adapter.log.jsonl")],
      entries: readEntries("xiaoai")
    },
    rabilink: {
      paths: [path.join(dir, "rabilink-adapter.log.jsonl")],
      entries: readEntries("rabilink")
    },
    wecom: {
      paths: [path.join(dir, "wecom-adapter.log.jsonl")],
      entries: readEntries("wecom")
    },
    webhook: {
      paths: [path.join(dir, "webhook-adapter.log.jsonl")],
      entries: readEntries("webhook")
    },
    outbox: {
      paths: [path.join(dir, "outbox-adapter.log.jsonl")],
      entries: readEntries("outbox")
    }
  };
}

function runtimeStatus(runtime: GatewayRuntime): Record<string, unknown> {
  const usesNapcat = definitionUsesNapcat(runtime.definition);
  const gatewayStatus = gatewayStatusForRuntime(runtime);
  const rabiLinkRelay = rabiLinkRelayConfigFor(runtime.definition);
  return {
    id: runtime.definition.id,
    name: runtime.definition.name,
    configName: sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName,
    enabled: runtime.definition.enabled,
    messageAdapterType: runtime.definition.messageAdapterType ?? "napcat",
    messageAdapters: runtime.definition.messageAdapters ?? [runtime.definition.messageAdapterType ?? "napcat"],
    messageAdaptersDisabled: runtime.definition.messageAdaptersDisabled ?? [],
    messageInputsDisabled: runtime.definition.messageInputsDisabled === true,
    messageAdapterPolicies: runtime.definition.messageAdapterPolicies ?? {},
    agentAdapters: runtime.definition.agentAdapters ?? ["codex"],
    pipelinePreset: runtime.definition.pipelinePreset,
    pipeline: runtime.definition.pipeline,
    gatewayPort: runtime.definition.gatewayPort,
    webhookPort: runtime.definition.webhookPort,
    webhookPath: runtime.definition.webhookPath,
    fenneNoteWebhookPort: runtime.definition.fenneNoteWebhookPort,
    fenneNoteWebhookPath: runtime.definition.fenneNoteWebhookPath,
    xiaoaiWebhookPort: runtime.definition.xiaoaiWebhookPort,
    xiaoaiWebhookPath: runtime.definition.xiaoaiWebhookPath,
    rabiLinkWebhookPort: runtime.definition.rabiLinkWebhookPort,
    rabiLinkWebhookPath: runtime.definition.rabiLinkWebhookPath,
    rabiLinkWebhookHost: runtime.definition.rabiLinkWebhookHost,
    rabiLinkRelayEnabled: rabiLinkRelay.enabled,
    rabiLinkRelayUrl: rabiLinkRelay.url,
    rabiLinkRelayToken: rabiLinkRelay.token ? "********" : "",
    rabiLinkRelayDeviceId: rabiLinkRelay.deviceId,
    rabiLinkRelayClaimWaitMs: rabiLinkRelay.claimWaitMs,
    rabiLinkRelayReplyIdleTimeoutMs: rabiLinkRelay.replyIdleTimeoutMs,
    rabiLinkRelayConfigScope: hasGlobalRabiLinkRelayConfig() ? "global" : "route-fallback",
    wecomBotId: runtime.definition.wecomBotId,
    wecomBotSecret: runtime.definition.wecomBotSecret,
    wecomWsUrl: runtime.definition.wecomWsUrl,
    heartbeatIntervalSeconds: runtime.definition.heartbeatIntervalSeconds ?? 900,
    heartbeatMessage: runtime.definition.heartbeatMessage ?? "",
    remoteAgentDefaultDeviceId: runtime.definition.remoteAgentDefaultDeviceId ?? "",
    remoteAgentDefaultCwd: runtime.definition.remoteAgentDefaultCwd ?? "",
    remoteAgentDefaultThreadName: runtime.definition.remoteAgentDefaultThreadName ?? "",
    napcatHttpUrl: runtime.definition.napcatHttpUrl ?? "http://127.0.0.1:3000",
    napcatWebuiUrl: runtime.definition.napcatWebuiUrl ?? "http://127.0.0.1:6099/webui",
    napcatAccessToken: runtime.definition.napcatAccessToken ?? "",
    napcatWebuiToken: runtime.definition.napcatWebuiToken ?? "",
    napcatInstances: usesNapcat ? (runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition)) : [],
    targetGroupId: runtime.definition.targetGroupId ?? "",
    routeVariables: runtime.definition.routeVariables,
    routeName: runtime.definition.routeName,
    routeProfiles: runtime.definition.routeProfiles ?? [],
    codexThreadName: resolveCodexThreadName(runtime.definition),
    codexCwd: runtime.definition.codexCwd,
    copilotCwd: runtime.definition.copilotCwd,
    copilotCliBin: runtime.definition.copilotCliBin,
    marvisAppId: runtime.definition.marvisAppId,
    astrbotUrl: runtime.definition.astrbotUrl,
    astrbotUsername: runtime.definition.astrbotUsername,
    astrbotPassword: runtime.definition.astrbotPassword,
    astrbotProjectId: runtime.definition.astrbotProjectId,
    astrbotSessionId: runtime.definition.astrbotSessionId,
    rolesDir: runtime.definition.rolesDir,
    routesDir: runtime.definition.routesDir,
    agentRoleId: runtime.definition.agentRoleId,
    agentRoleFile: runtime.definition.agentRoleFile,
    roleInfo: roleInfoFor(runtime.definition),
    dataDir: runtime.definition.dataDir,
    groupNotificationTemplate: runtime.definition.groupNotificationTemplate,
    groupAtNotificationTemplate: runtime.definition.groupAtNotificationTemplate,
    groupDirectReplyNotificationTemplate: runtime.definition.groupDirectReplyNotificationTemplate,
    groupIndirectReplyNotificationTemplate: runtime.definition.groupIndirectReplyNotificationTemplate,
    groupReplyNotificationTemplate: runtime.definition.groupReplyNotificationTemplate,
    groupNicknameNotificationTemplate: runtime.definition.groupNicknameNotificationTemplate,
    privateNotificationTemplate: runtime.definition.privateNotificationTemplate,
    notificationRules: runtime.definition.notificationRules,
    roleNotificationRules: runtime.definition.roleNotificationRules,
    roleRouteNames: runtime.definition.roleRouteNames,
    running: Boolean(runtime.process),
    pid: runtime.process?.pid ?? null,
    startedAt: runtime.startedAt,
    stoppedAt: runtime.stoppedAt,
    lastExit: runtime.lastExit,
    gatewayStatus,
    adapterLogs: readAdapterLogs(runtime.definition),
    messageFiles: readMessageFiles(runtime.definition),
    agentStates: readAgentStates(runtime.definition),
    codexState: readCodexState(runtime.definition),
    log: runtime.log.slice(-30)
  };
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

type ManualTriggerRequest = {
  triggerId?: string;
  triggerName?: string;
  message?: string;
  routeKind?: string;
  ruleId?: string;
};

type DeliveryReplayRequest = {
  attemptId?: string;
  attemptIds?: string[];
  routeKind?: string;
  messageId?: string;
  mode?: "single" | "merge";
};

type RolePanelMessageRequest = {
  gatewayId?: string;
  text?: string;
  attachments?: RolePanelAttachment[];
};

function triggerGatewayManualRule(id: string, request: ManualTriggerRequest = {}): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }

  const triggerId = sanitizeRoleId(request.triggerId) || "manual";
  const triggerName = request.triggerName?.trim() || triggerId;
  const message = request.message?.trim() || triggerName;
  const routeKind = normalizeManualRouteKind(request.routeKind);
  const ruleId = sanitizeRoleId(request.ruleId) || (routeKind === "heartbeat" ? "" : triggerId);
  const args = [
    `--manual-trigger=${triggerId}`,
    `--manual-name=${encodeURIComponent(triggerName)}`,
    `--manual-message=${encodeURIComponent(message)}`,
    `--manual-route-kind=${routeKind}`
  ];
  if (ruleId) {
    args.push(`--manual-rule=${ruleId}`);
  }
  const command = childCommand(args);
  appendLog(runtime, `manual trigger requested: ${triggerName}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });

    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `manual trigger: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `manual trigger error: ${line}`);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, `manual trigger completed: ${triggerName}`);
        resolve();
        return;
      }
      reject(new Error(`manual trigger failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function normalizeManualRouteKind(value: unknown): ForwardRouteKind {
  return value === "heartbeat" ? "heartbeat" : "manual_trigger";
}

function routeDataDirForDefinition(definition: GatewayDefinition): string {
  const configName = routeRuntimeParts(definition.id).configName || sanitizeConfigName(definition.name ?? definition.id);
  return routeFolderPath(routeRoot, configName);
}

function listGatewayDeliveryReplayAttempts(id: string, limit: number, status: string | null): Record<string, unknown> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const dataDir = routeDataDirForDefinition(runtime.definition);
  return {
    gatewayId: id,
    dataDir: path.relative(rootDir, dataDir).replace(/\\/g, "/"),
    attempts: listDeliveryReplayAttempts(dataDir, {
      status: status === "failed" || status === "delivered" || status === "missed" || status === "routed" || status === "skipped" ? status : undefined,
      limit
    }).map((attempt) => ({
      attemptId: attempt.attemptId,
      time: attempt.time,
      routeKind: attempt.routeKind,
      messageId: attempt.messageId,
      status: attempt.result.status,
      matchedRuleCount: attempt.result.matchedRuleCount,
      sentPacketCount: attempt.result.sentPacketCount,
      failedAdapterCount: attempt.result.adapterOutcomes.filter((outcome) => outcome.status === "failed").length,
      packetCount: attempt.packets.length,
      replayOfAttemptId: attempt.replayOfAttemptId
    }))
  };
}

function replayGatewayDelivery(id: string, request: DeliveryReplayRequest = {}): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const attemptIds = (request.attemptIds?.length ? request.attemptIds : request.attemptId ? [request.attemptId] : [])
    .map((item) => String(item).trim())
    .filter(Boolean);
  const routeKind = parseReplayRouteKind(request.routeKind);
  const messageId = request.messageId?.trim();
  if (attemptIds.length === 0 && (!routeKind || !messageId)) {
    throw new Error("No delivery replay attempt id was provided.");
  }

  const mode = request.mode === "merge" || attemptIds.length > 1 ? "merge" : "single";
  const args = [
    `--delivery-replay-mode=${mode}`
  ];
  if (attemptIds.length > 0) {
    args.push(`--delivery-replay=${encodeURIComponent(attemptIds.join(","))}`);
  }
  if (routeKind && messageId) {
    args.push(`--delivery-replay-route-kind=${routeKind}`, `--delivery-replay-message=${encodeURIComponent(messageId)}`);
  }
  const command = childCommand(args);
  appendLog(runtime, `delivery replay requested: mode=${mode} attempts=${attemptIds.join(",") || "none"} message=${routeKind && messageId ? `${routeKind}:${messageId}` : "none"}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });

    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `delivery replay: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `delivery replay error: ${line}`);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, `delivery replay completed: mode=${mode} attempts=${attemptIds.length}`);
        resolve();
        return;
      }
      reject(new Error(`delivery replay failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function parseReplayRouteKind(value: unknown): ForwardRouteKind | undefined {
  return value === "private"
    || value === "group_message"
    || value === "direct_at"
    || value === "direct_reply"
    || value === "indirect_reply"
    || value === "heartbeat"
    || value === "manual_trigger"
    || value === "role_panel_message"
    || value === "voice_transcript"
    ? value
    : undefined;
}

function roleDirForDefinition(definition: GatewayDefinition): string {
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleId = sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
  return roleFolderPath(rolesDir, roleId);
}

function roleIdForDefinition(definition: GatewayDefinition): string {
  return sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
}

function triggerGatewayRolePanelMessage(runtime: GatewayRuntime, messageId: string, text: string, attachments: RolePanelAttachment[]): Promise<void> {
  const roleId = roleIdForDefinition(runtime.definition);
  const routeProfileId = runtime.definition.routeProfiles?.[0]?.id ?? runtime.definition.id;
  const command = childCommand([
    `--role-panel-message=${encodeURIComponent(messageId)}`,
    `--role-panel-text=${encodeURIComponent(text)}`,
    `--role-panel-role=${encodeURIComponent(roleId)}`,
    `--role-panel-gateway=${encodeURIComponent(runtime.definition.id)}`,
    `--role-panel-route-profile=${encodeURIComponent(routeProfileId)}`,
    `--role-panel-attachments=${encodeURIComponent(JSON.stringify(attachments))}`
  ]);
  appendLog(runtime, `role panel message requested: ${messageId}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });

    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `role panel: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `role panel error: ${line}`);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, `role panel message completed: ${messageId}`);
        resolve();
        return;
      }
      reject(new Error(`role panel message failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function triggerGatewayDirectAgentMessage(id: string, message: string): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const args = [`--direct-agent-message=${encodeURIComponent(message)}`];
  const command = childCommand(args);
  appendLog(runtime, "remote agent result requested direct delivery");
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });
    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `remote agent result: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `remote agent result error: ${line}`);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, "remote agent result delivered to local agent");
        resolve();
        return;
      }
      reject(new Error(`remote agent result delivery failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function remoteAgentResultMessage(task: RemoteAgentTask, event: RemoteAgentTaskEvent): string {
  const lines = [
    "[远端 Agent 任务结果]",
    `任务 ID：${task.taskId}`,
    `远端设备：${task.deviceId}`,
    `任务类型：${task.taskKind}`,
    `状态：${event.status ?? task.status}`,
    event.summary ? `摘要：${event.summary}` : "",
    event.message ? `消息：${event.message}` : "",
    event.artifactPath ? `产物路径：${event.artifactPath}` : "",
    event.logPath ? `日志路径：${event.logPath}` : "",
    event.error ? `错误：${event.error}` : "",
    "",
    "原始任务：",
    task.message
  ].filter(Boolean);
  return lines.join("\n");
}

async function handleRemoteAgentTaskEvent(task: RemoteAgentTask, event: RemoteAgentTaskEvent): Promise<void> {
  const runtime = runtimes.get(task.originGatewayId);
  if (runtime) {
    appendLog(runtime, `remote agent task ${task.taskId} ${event.status ?? task.status}: ${event.summary || event.message || event.error || ""}`.trim());
  }
  if (event.status === "completed" || event.status === "failed") {
    if (!runtime) {
      console.warn(`Remote Agent task ${task.taskId} finished but origin gateway was not found: ${task.originGatewayId}`);
      return;
    }
    await triggerGatewayDirectAgentMessage(task.originGatewayId, remoteAgentResultMessage(task, event));
  }
}

function remoteAgentTaskWithGatewayDefaults(request: RemoteAgentTaskRequest): RemoteAgentTaskRequest {
  if (request.deviceId && request.cwd && request.threadName) {
    return request;
  }
  const originGatewayId = String(
    request.originGatewayId
    || request.gatewayId
    || request.originReplyContext?.gatewayId
    || [...runtimes.values()][0]?.definition.id
    || ""
  ).trim();
  const definition = originGatewayId ? runtimes.get(originGatewayId)?.definition : undefined;
  if (!definition) {
    return request;
  }
  return {
    ...request,
    deviceId: request.deviceId || definition.remoteAgentDefaultDeviceId,
    cwd: request.cwd || definition.remoteAgentDefaultCwd,
    threadName: request.threadName || definition.remoteAgentDefaultThreadName
  };
}

function handleRemoteAgentApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/api/remote-agent/devices") {
    jsonResponse(response, 200, {
      code: 0,
      devices: remoteAgentHub.listDevices(),
      tasks: remoteAgentHub.listTasks(20)
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/scan") {
    void remoteAgentHub.scanLan()
      .then((devices) => jsonResponse(response, 200, {
        code: 0,
        devices,
        tasks: remoteAgentHub.listTasks(20)
      }))
      .catch((error) => jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/connect") {
    void readJsonBody<{ deviceId?: string; password?: string }>(request)
      .then((body) => remoteAgentHub.connectDevice(body))
      .then((device) => jsonResponse(response, 200, { code: 0, device, devices: remoteAgentHub.listDevices() }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/disconnect") {
    void readJsonBody<{ deviceId?: string }>(request)
      .then((body) => remoteAgentHub.disconnectDevice(String(body.deviceId || "")))
      .then((device) => jsonResponse(response, 200, { code: 0, device, devices: remoteAgentHub.listDevices() }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/remote-agent/tasks") {
    jsonResponse(response, 200, { code: 0, tasks: remoteAgentHub.listTasks(100) });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/tasks") {
    void readJsonBody<RemoteAgentTaskRequest>(request)
      .then((body) => remoteAgentHub.createTask(remoteAgentTaskWithGatewayDefaults(body)))
      .then((task) => jsonResponse(response, 202, { code: 0, task }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/task-events") {
    void readJsonBody<RemoteAgentTaskEvent>(request)
      .then((event) => remoteAgentHub.receiveTaskEvent(event))
      .then((task) => jsonResponse(response, 202, { code: 0, task }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  return false;
}

function handleRolePanelApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
  const messageListMatch = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/role-panel\/messages$/);
  if (request.method === "GET" && messageListMatch) {
    const roleId = sanitizeRoleId(decodeURIComponent(messageListMatch[1]));
    if (!roleId) {
      jsonResponse(response, 400, { code: -1, message: "Missing role id." });
      return true;
    }
    const limit = Number(requestUrl.searchParams.get("limit") || "120");
    const roleDir = roleFolderPath(rolesRoot, roleId);
    jsonResponse(response, 200, {
      code: 0,
      roleId,
      messages: readRolePanelTimeline(roleDir, Number.isFinite(limit) && limit > 0 ? limit : 120)
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/role-panel/messages") {
    void readJsonBody<RolePanelMessageRequest>(request)
      .then(async (body) => {
        const gatewayId = sanitizeRoleId(body.gatewayId);
        const runtime = gatewayId ? runtimes.get(gatewayId) : [...runtimes.values()][0];
        if (!runtime) throw new Error(gatewayId ? `Gateway not found: ${gatewayId}` : "No gateway is configured.");
        const text = String(body.text || "").trim();
        const attachments = normalizeRolePanelAttachments(body.attachments);
        if (!text && attachments.length === 0) throw new Error("Missing role panel message text or attachment.");
        const roleId = roleIdForDefinition(runtime.definition);
        const roleDir = roleDirForDefinition(runtime.definition);
        const messageId = createRolePanelMessageId("role-panel-user");
        const routeProfileId = runtime.definition.routeProfiles?.[0]?.id ?? runtime.definition.id;
        const replyContext = {
          runtimeRouteId: runtime.definition.id,
          gatewayId: runtime.definition.id,
          routeProfileId,
          routeKind: "role_panel_message",
          targetType: "role_panel",
          adapterType: "rolePanel",
          messageId,
          roleId
        };
        const message = appendRolePanelTimelineMessage(roleDir, {
          id: messageId,
          time: Math.floor(Date.now() / 1000),
          roleId,
          gatewayId: runtime.definition.id,
          routeProfileId,
          direction: "user",
          sender: roleId,
          text,
          attachments,
          status: "sent",
          replyContext
        });
        await triggerGatewayRolePanelMessage(runtime, messageId, text, attachments);
        return { roleId, message };
      })
      .then((payload) => jsonResponse(response, 202, { code: 0, ...payload }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  return false;
}

function roleDirForApi(roleId: string): string {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) {
    throw new Error("Missing role id.");
  }
  return roleFolderPath(rolesRoot, safeRoleId);
}

function handleRoleKnowledgeApi(request: http.IncomingMessage, pathname: string, response: http.ServerResponse): boolean {
  const consolidationResultMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/memory\/consolidation-runs\/([^/]+)\/result$/);
  if (consolidationResultMatch) {
    const roleId = decodeURIComponent(consolidationResultMatch[1]);
    const runId = decodeURIComponent(consolidationResultMatch[2]);
    try {
      const roleDir = roleDirForApi(roleId);
      if (request.method === "POST") {
        void readJsonBody<Record<string, unknown>>(request)
          .then((body) => applyMemoryConsolidationResult(roleDir, runId, body))
          .then((data) => jsonResponse(response, 200, { code: 0, data }))
          .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const match = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/(plans|skills|memory\/recent|memory\/consolidated|memory\/consolidation-requests|memory\/consolidation-runs|memory)(?:\/([^/]+))?$/);
  if (!match) {
    return false;
  }

  const roleId = decodeURIComponent(match[1]);
  const resource = match[2];
  const itemId = match[3] ? decodeURIComponent(match[3]) : "";

  try {
    const roleDir = roleDirForApi(roleId);
    if (request.method === "GET" && resource === "plans") {
      const plans = listPlans(roleDir);
      const data = itemId ? plans.find((item) => item.id === itemId) : plans;
      if (itemId && !data) {
        jsonResponse(response, 404, { code: -1, message: `Plan not found: ${itemId}` });
        return true;
      }
      jsonResponse(response, 200, { code: 0, data });
      return true;
    }
    if (request.method === "GET" && resource === "skills") {
      const data = itemId ? getRoleSkill(roleDir, itemId) : listRoleSkills(roleDir);
      if (itemId && !data) {
        jsonResponse(response, 404, { code: -1, message: `Skill not found: ${itemId}` });
        return true;
      }
      jsonResponse(response, 200, { code: 0, data });
      return true;
    }
    if (request.method === "GET" && resource === "memory" && !itemId) {
      jsonResponse(response, 200, {
        code: 0,
        data: {
          recent: listRecentMemories(roleDir),
          consolidated: listConsolidatedMemories(roleDir),
          consolidationRuns: listConsolidationRuns(roleDir)
        }
      });
      return true;
    }
    if (request.method === "POST" && resource === "plans" && !itemId) {
      void readJsonBody<Record<string, unknown>>(request)
        .then((body) => createPlan(roleDir, body))
        .then((data) => jsonResponse(response, 201, { code: 0, data }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "PATCH" && resource === "plans" && itemId) {
      void readJsonBody<Record<string, unknown>>(request)
        .then((body) => updatePlan(roleDir, itemId, body))
        .then((data) => jsonResponse(response, 200, { code: 0, data }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "GET" && resource === "memory/recent") {
      const data = itemId ? getRecentMemory(roleDir, itemId) : listRecentMemories(roleDir);
      if (itemId && !data) {
        jsonResponse(response, 404, { code: -1, message: `Memory not found: ${itemId}` });
        return true;
      }
      jsonResponse(response, 200, { code: 0, data });
      return true;
    }
    if (request.method === "GET" && resource === "memory/consolidated") {
      const data = itemId ? getConsolidatedMemory(roleDir, itemId) : listConsolidatedMemories(roleDir);
      if (itemId && !data) {
        jsonResponse(response, 404, { code: -1, message: `Consolidated memory not found: ${itemId}` });
        return true;
      }
      jsonResponse(response, 200, { code: 0, data });
      return true;
    }
    if (request.method === "POST" && resource === "memory/recent" && !itemId) {
      void readJsonBody<Record<string, unknown>>(request)
        .then((body) => createRecentMemory(roleDir, body))
        .then((data) => jsonResponse(response, 201, { code: 0, data }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "PATCH" && resource === "memory/recent" && itemId) {
      void readJsonBody<Record<string, unknown>>(request)
        .then((body) => updateRecentMemory(roleDir, itemId, body))
        .then((data) => jsonResponse(response, 200, { code: 0, data }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "GET" && resource === "memory/consolidation-runs") {
      const runs = listConsolidationRuns(roleDir);
      const data = itemId ? runs.find((item) => item.id === itemId) : runs;
      if (itemId && !data) {
        jsonResponse(response, 404, { code: -1, message: `Consolidation run not found: ${itemId}` });
        return true;
      }
      jsonResponse(response, 200, { code: 0, data });
      return true;
    }
    if (request.method === "POST" && resource === "memory/consolidation-requests" && !itemId) {
      void readJsonBody<Record<string, unknown>>(request)
        .then((body) => pendingMemoryConsolidation(
          roleDir,
          body.triggerSource === "auto" ? "auto" : "api",
          typeof body.includeOlderThanHours === "number" ? body.includeOlderThanHours : undefined,
          typeof body.triggerOlderThanHours === "number" ? body.triggerOlderThanHours : undefined,
          body.force === true
        ))
        .then((data) => {
          if (!data) {
            jsonResponse(response, 409, { code: -1, message: "No memory consolidation is due." });
            return;
          }
          jsonResponse(response, 201, { code: 0, data });
        })
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  } catch (error) {
    jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

async function forwardFenneNoteRequest(
  body: unknown,
  targetUrl: string,
  token: string
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "RabiRoute"
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const forwarded = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {})
  });
  const text = await forwarded.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return {
    ok: forwarded.ok,
    status: forwarded.status,
    target: targetUrl,
    response: data
  };
}

async function forwardPlaybackRequest(body: unknown): Promise<Record<string, unknown>> {
  return forwardFenneNoteRequest(body, fenneNotePlaybackUrl, fenneNotePlaybackToken);
}

async function forwardFenneNoteReply(body: unknown): Promise<Record<string, unknown>> {
  return forwardFenneNoteRequest(body, fenneNoteReplyUrl, fenneNoteReplyToken);
}

function standaloneGatewayPayload(): Record<string, unknown> {
  return buildStandaloneGatewayPayload({
    runtimes: runtimes.values(),
    runtimeStatus,
    routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"),
    rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/")
  });
}

function networkOptionsPayload(): Record<string, unknown> {
  const localAddresses = Object.entries(os.networkInterfaces())
    .flatMap(([name, addresses]) => (addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => ({
        name,
        address: address.address,
        cidr: address.cidr
      })));
  const adapters = {
    napcat: {
      httpServers: [],
      websocketClients: []
    },
    webhook: {
      listeners: []
    },
    heartbeat: {},
    disabled: {}
  };
  return {
    code: 0,
    data: {
      adapters,
      localAddresses,
      httpServers: [],
      websocketClients: []
    }
  };
}

function metaPayload(): Record<string, unknown> {
  const version = packageVersion();
  const globalConfig = rabiGlobalConfig.read();
  return {
    version,
    githubUrl: "https://github.com/vb2250158/RabiRoute",
    managerPort,
    rabiGuid: globalConfig.rabiGuid,
    rabiName: globalConfig.rabiName,
    rabiLinkRelay: rabiLinkRelayConfigForMeta(),
    computerName: os.hostname()
  };
}

function packageVersion(): string {
  let version = "0.1.0";
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      version = parsed.version;
    }
  } catch {
    // Keep the baked fallback when package metadata is not readable.
  }
  return version;
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml; charset=utf-8";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function staticWebuiResponse(pathname: string, response: http.ServerResponse): boolean {
  const indexPath = path.join(webuiDistPath, "index.html");
  if (!fs.existsSync(indexPath)) {
    return false;
  }

  const decoded = decodeURIComponent(pathname);
  const normalized = path.normalize(decoded === "/" ? "/index.html" : decoded).replace(/^[/\\]+/, "");
  const candidatePath = path.resolve(webuiDistPath, normalized);
  const relativeToDist = path.relative(webuiDistPath, candidatePath);
  if (relativeToDist.startsWith("..") || path.isAbsolute(relativeToDist)) {
    return false;
  }

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    response.writeHead(200, { "content-type": contentTypeFor(candidatePath) });
    response.end(fs.readFileSync(candidatePath));
    return true;
  }

  if (path.extname(candidatePath)) {
    return false;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(fs.readFileSync(indexPath, "utf8"));
  return true;
}

function htmlResponse(pathname: string, response: http.ServerResponse): void {
  if (staticWebuiResponse(pathname, response)) {
    return;
  }

  response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  response.end("RabiRoute WebGUI build is missing. Run `npm run webgui:build` or `npm run build`.");
}

function assetResponse(pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/assets\/([a-zA-Z0-9_.-]+)$/);
  if (!match) {
    return false;
  }

  const assetPath = path.join(rootDir, "assets", match[1]);
  if (!fs.existsSync(assetPath)) {
    return false;
  }

  const extension = path.extname(assetPath).toLowerCase();
  const contentType = extension === ".png"
    ? "image/png"
    : extension === ".svg"
      ? "image/svg+xml; charset=utf-8"
      : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType });
  response.end(fs.readFileSync(assetPath));
  return true;
}

function handleAction(pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/(start|stop|restart|delete)$/);
  if (!match) {
    return false;
  }

  const [, encodedId, action] = match;
  const id = decodeURIComponent(encodedId);
  try {
    if (action === "start") {
      startGateway(id);
    } else if (action === "stop") {
      stopGateway(id);
    } else if (action === "restart") {
      stopGateway(id);
      setTimeout(() => startGateway(id), 1000);
    } else {
      removeGatewayConfig(id);
      loadRuntimes();
      syncRunningGateways();
      jsonResponse(response, 200, standaloneGatewayPayload());
      return true;
    }
  } catch (error) {
    jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    return true;
  }

  jsonResponse(response, 200, { code: 0, message: `requested ${action}`, data: [...runtimes.values()].map(runtimeStatus) });
  return true;
}

function handleTriggerAction(request: http.IncomingMessage, pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/manual-trigger$/);
  if (!match) {
    return false;
  }

  const [, id] = match;
  void readJsonBody<ManualTriggerRequest>(request)
    .then((body) => triggerGatewayManualRule(decodeURIComponent(id), body))
    .then(() => {
      jsonResponse(response, 202, { code: 0, message: "manual trigger completed", data: [...runtimes.values()].map(runtimeStatus) });
    })
    .catch((error) => {
      jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) });
    });
  return true;
}

function handleDeliveryReplayAction(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
  const match = requestUrl.pathname.match(/^\/gateways\/([^/]+)\/delivery-replay$/);
  if (!match) {
    return false;
  }

  const id = decodeURIComponent(match[1]);
  if (request.method === "GET") {
    try {
      const limit = Number(requestUrl.searchParams.get("limit") ?? "50") || 50;
      const status = requestUrl.searchParams.get("status");
      jsonResponse(response, 200, { code: 0, ...listGatewayDeliveryReplayAttempts(id, limit, status) });
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === "POST") {
    void readJsonBody<DeliveryReplayRequest>(request)
      .then((body) => replayGatewayDelivery(id, body))
      .then(() => {
        jsonResponse(response, 202, { code: 0, message: "delivery replay requested", data: [...runtimes.values()].map(runtimeStatus) });
      })
      .catch((error) => {
        jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
  return true;
}

function handleAgentStateReport(request: http.IncomingMessage, pathname: string, response: http.ServerResponse): boolean {
  if (pathname !== "/api/agent-state") {
    return false;
  }

  void readJsonBody<AgentStateReportRequest>(request)
    .then((body) => {
      const gatewayId = sanitizeRoleId(body.gatewayId);
      const adapterType = parseAgentAdapterType(body.adapterType);
      if (!gatewayId || !adapterType || !runtimes.get(gatewayId)) {
        throw new Error("Invalid agent state report target.");
      }
      const previous = agentStateByGateway.get(gatewayId) ?? {};
      previous[adapterType] = {
        ...(previous[adapterType] ?? {}),
        ...(body.state ?? {}),
        agentAdapterType: adapterType,
        updatedAt: new Date().toISOString()
      };
      agentStateByGateway.set(gatewayId, previous);
      jsonResponse(response, 200, { code: 0 });
    })
    .catch((error) => {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    });
  return true;
}

export function startManager(): void {
  loadRuntimes();
  for (const runtime of runtimes.values()) {
    if (runtime.definition.enabled) {
      startGateway(runtime.definition.id);
    }
  }

  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && assetResponse(requestUrl.pathname, response)) {
        return;
      }
      if (request.method === "POST" && handleAction(requestUrl.pathname, response)) {
        return;
      }
      if (request.method === "POST" && handleTriggerAction(request, requestUrl.pathname, response)) {
        return;
      }
      if ((request.method === "GET" || request.method === "POST") && handleDeliveryReplayAction(request, requestUrl, response)) {
        return;
      }
      if (request.method === "POST" && handleAgentStateReport(request, requestUrl.pathname, response)) {
        return;
      }
      if (handleRabiApi(request, requestUrl, response, {
        rootDir,
        routeRoot,
        managerPort,
        managerHost,
        version: packageVersion,
        globalConfig: rabiGlobalConfig,
        runtimes: () => runtimes.values(),
        runtimeStatus,
        readConfig,
        writeConfig,
        loadRuntimes,
        syncRunningGateways,
        agentManagerApiCtx
      })) {
        return;
      }
      if (handleRemoteAgentApi(request, requestUrl, response)) {
        return;
      }
      if (handleRolePanelApi(request, requestUrl, response)) {
        return;
      }
      if ((request.method === "GET" || request.method === "POST" || request.method === "PATCH") && handleRoleKnowledgeApi(request, requestUrl.pathname, response)) {
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/gateways") {
        jsonResponse(response, 200, standaloneGatewayPayload());
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/gateways") {
        void readJsonBody<GatewayConfigFile>(request)
          .then((body) => {
            writeConfig(body);
            loadRuntimes();
            syncRunningGateways();
            jsonResponse(response, 200, standaloneGatewayPayload());
          })
          .catch((error) => {
            jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/network-options") {
        jsonResponse(response, 200, networkOptionsPayload());
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/manager-config") {
        jsonResponse(response, 200, {
          code: 0,
          routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"),
          rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/")
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/manager-config") {
        void readJsonBody<ManagerConfig>(request)
          .then((body) => {
            const cfg = readManagerConfig();
            if (body.routeDir !== undefined) cfg.routeDir = body.routeDir || undefined;
            if (body.rolesDir !== undefined) cfg.rolesDir = body.rolesDir || undefined;
            writeManagerConfig(cfg);
            ensureDataDirs();
            jsonResponse(response, 200, { code: 0, routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"), rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/") });
          })
          .catch((error) => {
            jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/meta") {
        jsonResponse(response, 200, metaPayload());
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/scan/message-adapters") {
        void Promise.resolve()
          .then(async () => {
            const gatewayId = requestUrl.searchParams.get("gatewayId") || undefined;
            const repair = repairGatewayConfigsForScan(gatewayId);
            const startMessages = ensureGatewayRunningForScan(gatewayId);
            if (startMessages.length > 0) {
              repair.changed = true;
              repair.messages.push(...startMessages);
            }
            const adapters = await messageAdapterScanPayload();
            const napcatHealth = await napcatScanHealthPayload();
            return { adapters, repair, napcatHealth, gatewayPayload: standaloneGatewayPayload() };
          })
          .then((payload) => {
            jsonResponse(response, 200, payload);
          })
          .catch((error) => {
            jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "POST" && (requestUrl.pathname === "/api/playback/request" || requestUrl.pathname === "/api/fennenote/playback")) {
        void readJsonBody<unknown>(request)
          .then((body) => forwardPlaybackRequest(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 202 : 502, result);
          })
          .catch((error) => {
            jsonResponse(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error), target: fenneNotePlaybackUrl });
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/fennenote/reply") {
        void readJsonBody<unknown>(request)
          .then((body) => forwardFenneNoteReply(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 202 : 502, result);
          })
          .catch((error) => {
            jsonResponse(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error), target: fenneNoteReplyUrl });
          });
        return;
      }
      if (requestUrl.pathname === "/api/agent/threads" && (request.method === "GET" || request.method === "POST")) {
        const allowedWorkspaces = [...new Set([
          rootDir,
          ...[...runtimes.values()]
            .map((runtime) => runtime.definition.codexCwd?.trim())
            .filter((value): value is string => Boolean(value))
            .map((value) => path.resolve(rootDir, value))
        ])];
        const requestBody = request.method === "GET"
          ? Promise.resolve<AgentThreadRequest>({
              action: "list",
              query: requestUrl.searchParams.get("query") ?? "",
              limit: Number(requestUrl.searchParams.get("limit") ?? "20")
            })
          : readJsonBody<AgentThreadRequest>(request);
        void requestBody
          .then((body) => handleAgentThreadRequest(body, {
            allowedWorkspaces,
            defaultWorkspace: rootDir
          }))
          .then((result) => {
            jsonResponse(response, result.statusCode, { code: 0, ...result.data });
          })
          .catch((error) => {
            jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/agent/replies") {
        void readJsonBody<AgentReplyRequest>(request)
          .then((body) => handleAgentReply(body, {
            rootDir,
            routeRoot,
            rolesRoot,
            runtimes: [...runtimes.values()].map((runtime) => {
              const relay = rabiLinkRelayConfigFor(runtime.definition);
              return {
                ...runtime.definition,
                rabiLinkRelay: relay,
                napcatInstances: (runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition)).map((instance) => ({
                  ...instance,
                  accessToken: instance.accessToken ?? ""
                }))
              };
            })
          }))
          .then((result) => {
            const status = result.status === "sent" ? 202 : result.status === "draft" ? 200 : result.status === "failed" ? 502 : 403;
            jsonResponse(response, status, { code: result.ok ? 0 : -1, ...result });
          })
          .catch((error) => {
            jsonResponse(response, 400, { code: -1, ok: false, status: "blocked", message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/open-config-file") {
        jsonResponse(response, 200, openConfigFilePayload(
          requestUrl.searchParams.get("type"),
          requestUrl.searchParams.get("gatewayId"),
          requestUrl.searchParams.get("roleId")
        ));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/manager/start") {
        jsonResponse(response, 200, { code: 0, message: "manager is already running" });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/manager/shutdown") {
        jsonResponse(response, 200, { code: 0, message: "manager shutdown requested" });
        setTimeout(() => shutdownManager("api"), 20);
        return;
      }
      if (requestUrl.pathname === "/api/gateways") {
        jsonResponse(response, 200, [...runtimes.values()].map(runtimeStatus));
        return;
      }
      if (requestUrl.pathname === "/api/scan/agents" && request.method === "GET") {
        void (async () => {
          jsonResponse(response, 200, await scanAgentAdapters(agentManagerApiCtx()));
        })();
        return;
      }
      if (requestUrl.pathname === "/api/agent/copilot-install" && request.method === "POST") {
        void (async () => {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          try {
            const { stdout, stderr } = await execFileAsync("npm", ["install", "-g", "@github/copilot"], {
              shell: true,
              timeout: 120_000,
              env: { ...process.env }
            });
            jsonResponse(response, 200, { ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
          } catch (err: unknown) {
            const e = err as { message?: string; stdout?: string; stderr?: string };
            jsonResponse(response, 500, { ok: false, error: e.message, stderr: e.stderr });
          }
        })();
        return;
      }

      if (requestUrl.pathname === "/api/agent/copilot-login" && request.method === "POST") {
        void (async () => {
          const { spawn } = await import("node:child_process");
          try {
            // Find copilot bin
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execFileAsync = promisify(execFile);
            let copilotBin = "copilot";
            try {
              const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["copilot"], { timeout: 2000 });
              const first = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
              if (first) copilotBin = first;
            } catch { /* use default */ }

            // Spawn copilot login, capture device code from stdout
            const child = spawn(copilotBin, ["login"], {
              env: { ...process.env },
              shell: process.platform === "win32",
              windowsHide: true
            });

            let output = "";
            let code: string | null = null;
            let url: string | null = null;

            const codeTimer = setTimeout(() => {
              if (!code) {
                child.kill();
                jsonResponse(response, 408, { ok: false, error: "Timeout waiting for device code" });
              }
            }, 15_000);

            child.stdout?.on("data", (d: Buffer) => {
              output += d.toString();
              const codeMatch = output.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
              const urlMatch = output.match(/https:\/\/github\.com\/login\/device/);
              if (codeMatch && !code) {
                code = codeMatch[1];
                url = urlMatch ? "https://github.com/login/device" : null;
                clearTimeout(codeTimer);
                jsonResponse(response, 200, { ok: true, code, url, pid: child.pid });
              }
            });

            child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

            child.on("exit", (exitCode) => {
              clearTimeout(codeTimer);
              if (exitCode === 0 && !code) {
                jsonResponse(response, 200, { ok: true, done: true });
              } else if (exitCode !== 0 && !code) {
                jsonResponse(response, 500, { ok: false, error: output.trim() });
              }
            });
          } catch (err: unknown) {
            jsonResponse(response, 500, { ok: false, error: String(err) });
          }
        })();
        return;
      }

      if (requestUrl.pathname === "/api/agent/copilot-status" && request.method === "GET") {
        void (async () => {
          jsonResponse(response, 200, await getCopilotStatus(agentManagerApiCtx()));
        })();
        return;
      }

      if (requestUrl.pathname === "/api/agent/astrbot-login-test" && request.method === "POST") {
        void readJsonBody<AstrbotLoginTestRequest>(request)
          .then((body) => testAstrbotLoginEndpoint(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-repair-all" && request.method === "POST") {
        void (async () => {
          const scanRepair = repairGatewayConfigsForScan();
          const ctx = napcatManagerCtx();
          const results: Array<Record<string, unknown>> = [];
          for (const runtime of runtimes.values()) {
            if (!definitionUsesNapcat(runtime.definition)) continue;
            for (const instance of runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition)) {
              const health = await testNapcatHealthEndpoint(ctx, {
                httpUrl: instance.httpUrl,
                webuiUrl: instance.webuiUrl,
                accessToken: instance.accessToken,
                webuiToken: instance.webuiToken,
                gatewayPort: instance.gatewayPort
              });
              if (health.fixAvailable) {
                try {
                  const fixed = await configureNapcatOneBot(ctx, {
                    httpUrl: instance.httpUrl,
                    webuiUrl: instance.webuiUrl,
                    accessToken: instance.accessToken,
                    webuiToken: instance.webuiToken,
                    gatewayPort: instance.gatewayPort
                  });
                  results.push({ gatewayId: runtime.definition.id, instanceId: instance.id, ok: true, action: "configure-onebot", ...fixed });
                } catch (error) {
                  results.push({ gatewayId: runtime.definition.id, instanceId: instance.id, ok: false, action: "configure-onebot", message: error instanceof Error ? error.message : String(error) });
                }
              } else {
                results.push({ gatewayId: runtime.definition.id, instanceId: instance.id, ok: Boolean(health.ok), action: "health-check", message: health.ok ? "已连通，无需修复。" : String(health.message || "没有可自动修复项。") });
              }
            }
          }
          jsonResponse(response, 200, {
            ok: true,
            repair: scanRepair,
            results,
            napcatHealth: await napcatScanHealthPayload(),
            gatewayPayload: standaloneGatewayPayload()
          });
        })().catch((error) => {
          jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
        });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-health" && request.method === "POST") {
        void (async () => {
          const body = await readJsonBody<NapcatHealthRequest>(request);
          let result = await testNapcatHealthEndpoint(napcatManagerCtx(), body) as Record<string, unknown>;
          const correctedWebuiUrl = correctedNapcatWebuiUrlFromHealth(result);
          if (correctedWebuiUrl) {
            const runtime = body.gatewayId
              ? runtimes.get(body.gatewayId)
              : [...runtimes.values()].find((item) => {
                  const instances = item.definition.napcatInstances ?? normalizeNapCatInstances(item.definition);
                  return instances.some((instance) =>
                    (body.instanceId && instance.id === body.instanceId)
                    || (body.httpUrl && instance.httpUrl === body.httpUrl)
                    || (body.webuiUrl && instance.webuiUrl === body.webuiUrl)
                  );
                });
            const instances = runtime ? runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition) : [];
            const instance = runtime
              ? instances.find((item) => item.id === body.instanceId)
                ?? instances.find((item) => body.httpUrl && item.httpUrl === body.httpUrl)
                ?? instances.find((item) => body.webuiUrl && item.webuiUrl === body.webuiUrl)
              : undefined;
            if (runtime && instance) {
              const backfilled = backfillNapcatInstanceWebuiUrl(runtime.definition, instance.id, correctedWebuiUrl);
              if (backfilled) {
                instance.webuiUrl = backfilled;
                result = addHealthDiagnostic(result, `已根据 NapCat webui.json 自动修正 WebUI 地址：${backfilled}`);
              }
            }
          }
          jsonResponse(response, 200, result);
        })().catch((error) => {
          jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
        });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-configure-onebot" && request.method === "POST") {
        void readJsonBody<NapcatHealthRequest>(request)
          .then((body) => configureNapcatOneBot(napcatManagerCtx(), body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-add" && request.method === "POST") {
        void readJsonBody<NapcatAddRequest>(request)
          .then((body) => addManagedNapcatInstance(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-launch" && request.method === "POST") {
        void readJsonBody<NapcatLaunchRequest>(request)
          .then((body) => launchNapcatInstanceEndpoint(napcatManagerCtx(), body))
          .then((result) => {
            jsonResponse(response, result.ok !== false ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-restart" && request.method === "POST") {
        void readJsonBody<NapcatLaunchRequest>(request)
          .then((body) => restartNapcatInstanceEndpoint(napcatManagerCtx(), body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-remove" && request.method === "POST") {
        void readJsonBody<NapcatRemoveRequest>(request)
          .then((body) => removeManagedNapcatInstance(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/agent/marvis-open" && request.method === "POST") {
        void readJsonBody<MarvisOpenRequest>(request)
          .then((body) => {
            jsonResponse(response, 200, openMarvis(agentManagerApiCtx(), body));
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/deploy-astrbot-adapter" && request.method === "POST") {
        void (async () => {
          try {
            const result = await deployAstrbotAdapter(agentManagerApiCtx());
            jsonResponse(response, result.status, result.body);
          } catch (err: unknown) {
            jsonResponse(response, 500, { ok: false, error: String(err) });
          }
        })();
        return;
      }

      if (requestUrl.pathname === "/reload") {
        loadRuntimes();
        syncRunningGateways();
        if (request.headers.accept?.includes("application/json")) {
          jsonResponse(response, 200, { ok: true, gateways: [...runtimes.values()].map(runtimeStatus) });
        } else {
          response.writeHead(303, { location: "/" });
          response.end();
        }
        return;
      }
      htmlResponse(requestUrl.pathname, response);
    } catch (error) {
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  remoteAgentHub.attach(server);
  if (remoteAgentDiscoverable) {
    remoteAgentHub.startDiscoveryResponder();
  } else {
    console.log("Remote Agent LAN discovery responder disabled by REMOTE_AGENT_DISCOVERABLE=0");
  }

  server.listen(managerPort, managerHost, () => {
    console.log(`gateway-manager listening on http://${managerHost}:${managerPort}`);
    console.log(`roles: ${rolesRoot}`);
    console.log(`route: ${routeRoot}`);
  });

  const configWatcher = startConfigWatcher();

  let shuttingDown = false;

  function shutdownManager(reason: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`gateway-manager shutting down: ${reason}`);
    clearInterval(configWatcher);
    stopAllGateways();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2500).unref();
  }

  process.on("SIGINT", () => shutdownManager("SIGINT"));
  process.on("SIGTERM", () => shutdownManager("SIGTERM"));
}
