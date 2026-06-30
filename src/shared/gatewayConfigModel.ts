import {
  resolveRouteIdentity,
  sanitizeRoleId
} from "./routeIdentity.js";

export {
  routeRuntimeId,
  routeRuntimeParts,
  sanitizeConfigName,
  sanitizeRoleId
} from "./routeIdentity.js";

import {
  createBuiltinRolePanelRule,
  ensureBuiltinPersonaRules,
  isBuiltinRolePanelRule as sharedIsBuiltinRolePanelRule
} from "./personaRulePolicy.js";

export {
  builtinRolePanelRouteKind,
  builtinRolePanelRuleId,
  builtinRolePanelRuleName,
  canonicalizeBuiltinRolePanelRule,
  createBuiltinRolePanelRule,
  ensureBuiltinPersonaRules,
  isBuiltinRolePanelRule,
  rolePanelPersonaRulePolicy,
  type BuiltinPersonaRulePolicy
} from "./personaRulePolicy.js";

export type MessageAdapterType = "napcat" | "remoteAgent" | "heartbeat" | "rolePanel" | "fennenote" | "xiaoai" | "webhook" | "wecom" | "disabled";
export type AgentAdapterType = "codex" | "copilotCli" | "marvis" | "astrbot";
export type OutputAdapterType = "qq" | "codex" | "file" | "console" | "tts" | "webhook" | "fennenote" | "wecom" | "none";
export type PromptOutputMode = "qq_text" | "voice_short" | "markdown" | "json" | "plain_text";
export type MessagePayloadKind = "text" | "image" | "voice" | "file";

export type MessageAdapterPolicy = {
  inputEnabled?: boolean;
  outputEnabled?: boolean;
  supportedOutputs?: MessagePayloadKind[];
};

export type MessageAdapterPolicies = Partial<Record<Exclude<MessageAdapterType, "disabled">, MessageAdapterPolicy>>;

export type PipelineDefinition = {
  id?: string;
  name?: string;
  inputAdapter?: MessageAdapterType;
  outputAdapter?: OutputAdapterType;
  outputPipeline?: string;
  promptOutputMode?: PromptOutputMode;
  ttsProvider?: string;
  ttsVoice?: string;
  ttsWorkerUrl?: string;
  ttsPlay?: boolean;
  preventFeedbackLoop?: boolean;
  replyToSource?: boolean;
};

export type NotificationRuleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  routeKinds?: string[];
  targetGroupId?: string;
  regex?: string;
  schedules?: NotificationScheduleDefinition[];
  template: string;
};

export type NotificationScheduleType = "interval" | "daily_time" | "once_at";

export type NotificationScheduleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  type: NotificationScheduleType;
  intervalSeconds?: number;
  windowStartTime?: string;
  windowEndTime?: string;
  timeOfDay?: string;
  onceAt?: string;
};

export type RouteProfileDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  agentRoleId?: string;
  agentRoleFile?: string;
  rolesDir?: string;
  dataDir?: string;
  routeVariables?: Record<string, string>;
  notificationRules?: NotificationRuleDefinition[];
};

export type NapCatInstanceDefinition = {
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
  botUserId?: string | number;
  botNickname?: string;
  connected?: boolean;
  remoteAddress?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  loginInfoError?: string;
};

export type ResolvedNapCatInstances = {
  instances: NapCatInstanceDefinition[];
  primary?: NapCatInstanceDefinition;
  primaryIndex: number;
};

export type GatewayDefinition = {
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
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomWsUrl?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
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
  notificationRules?: NotificationRuleDefinition[];
  roleNotificationRules?: Record<string, NotificationRuleDefinition[]>;
  roleRouteNames?: Record<string, string>;
};

export type GatewayConfigFile = {
  gateways: GatewayDefinition[];
};

export type GatewayPortClaimKind =
  | "manager"
  | "gateway-ws"
  | "napcat-ws"
  | "napcat-http"
  | "webhook"
  | "fennenote-webhook"
  | "xiaoai-webhook";

export type GatewayPortClaim = {
  port: number;
  label: string;
  kind: GatewayPortClaimKind;
  gatewayId?: string;
  instanceId?: string;
};

export type GatewayConfigModelOptions = {
  managerPort?: number;
  routeDataDir?: (configName: string) => string;
  rolesDir?: string;
  normalizePipeline?: (pipeline: PipelineDefinition | undefined) => PipelineDefinition | undefined;
  normalizeAgentAdapters?: (adapters: AgentAdapterType[] | undefined) => AgentAdapterType[];
};

const messageAdapterValues = new Set<MessageAdapterType>(["napcat", "remoteAgent", "heartbeat", "rolePanel", "fennenote", "xiaoai", "webhook", "wecom", "disabled"]);
const agentAdapterValues = new Set<AgentAdapterType>(["codex", "copilotCli", "marvis", "astrbot"]);
const messagePayloadKindValues = new Set<MessagePayloadKind>(["text", "image", "voice", "file"]);
const defaultSupportedOutputs: MessagePayloadKind[] = ["text", "image", "voice", "file"];

export function normalizeTemplateText(value: unknown): string {
  return String(value || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
}

export function normalizeOptionalTemplate(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeTemplateText(value) : undefined;
}

export function normalizeRuleDefinitions(rules: unknown): NotificationRuleDefinition[] | undefined {
  if (!Array.isArray(rules)) {
    return undefined;
  }

  return rules.map((rule, index) => {
    const raw = rule && typeof rule === "object" ? rule as Partial<NotificationRuleDefinition> : {};
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `rule-${index + 1}`,
      name: raw.name,
      enabled: raw.enabled !== false,
      routeKinds: Array.isArray(raw.routeKinds) ? raw.routeKinds.map(String) : [],
      targetGroupId: typeof raw.targetGroupId === "string" ? raw.targetGroupId : "",
      regex: typeof raw.regex === "string" ? raw.regex : "",
      schedules: normalizeScheduleDefinitions(raw.schedules),
      template: normalizeTemplateText(typeof raw.template === "string" && raw.template.trim() ? raw.template : "")
    };
  });
}

export function defaultRolePanelNotificationRule(): NotificationRuleDefinition {
  return createBuiltinRolePanelRule();
}

export function ensureDefaultPersonaRules(rules: NotificationRuleDefinition[] | undefined): NotificationRuleDefinition[] {
  const normalized = normalizeRuleDefinitions(rules) ?? [];
  return ensureBuiltinPersonaRules(normalized);
}

export function isBuiltinRolePanelNotificationRule(rule: NotificationRuleDefinition | null | undefined): boolean {
  return sharedIsBuiltinRolePanelRule(rule);
}

function normalizeScheduleType(value: unknown): NotificationScheduleType {
  return value === "daily_time" || value === "once_at" || value === "interval" ? value : "interval";
}

function normalizeOptionalTimeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeScheduleDefinitions(schedules: unknown): NotificationScheduleDefinition[] | undefined {
  if (!Array.isArray(schedules)) {
    return undefined;
  }

  return schedules.map((schedule, index) => {
    const raw = schedule && typeof schedule === "object" ? schedule as Partial<NotificationScheduleDefinition> : {};
    const type = normalizeScheduleType(raw.type);
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `schedule-${index + 1}`,
      name: typeof raw.name === "string" ? raw.name : undefined,
      enabled: raw.enabled !== false,
      type,
      intervalSeconds: type === "interval" ? normalizePositiveNumber(raw.intervalSeconds, 900) : undefined,
      windowStartTime: type === "interval" ? normalizeOptionalTimeString(raw.windowStartTime) : undefined,
      windowEndTime: type === "interval" ? normalizeOptionalTimeString(raw.windowEndTime) : undefined,
      timeOfDay: type === "daily_time" ? normalizeOptionalTimeString(raw.timeOfDay) : undefined,
      onceAt: type === "once_at" ? normalizeOptionalTimeString(raw.onceAt) : undefined
    };
  });
}

export function normalizeMessageAdapters(items: unknown[]): MessageAdapterType[] {
  const adapters = items
    .map((item) => item == null ? "" : String(item))
    .filter((item): item is MessageAdapterType => messageAdapterValues.has(item as MessageAdapterType));
  const unique = [...new Set(adapters)].filter((item) => item !== "disabled");
  return unique.length > 0 ? unique : ["napcat"];
}

function normalizeOptionalMessageAdapters(items: unknown): MessageAdapterType[] {
  if (!Array.isArray(items)) return [];
  return [...new Set(items
    .map((item) => item == null ? "" : String(item))
    .filter((item): item is MessageAdapterType => messageAdapterValues.has(item as MessageAdapterType) && item !== "disabled"))];
}

function normalizePayloadKinds(value: unknown): MessagePayloadKind[] {
  if (!Array.isArray(value)) return defaultSupportedOutputs;
  const kinds = [...new Set(value
    .map(item => String(item || "").trim())
    .filter((item): item is MessagePayloadKind => messagePayloadKindValues.has(item as MessagePayloadKind)))];
  return kinds.length > 0 ? kinds : defaultSupportedOutputs;
}

export function normalizeMessageAdapterPolicy(
  value: unknown,
  adapterType: Exclude<MessageAdapterType, "disabled">,
  options: { legacyInputDisabled?: boolean } = {}
): Required<MessageAdapterPolicy> {
  const raw = value && typeof value === "object" ? value as MessageAdapterPolicy : {};
  return {
    inputEnabled: raw.inputEnabled ?? !options.legacyInputDisabled,
    outputEnabled: raw.outputEnabled ?? true,
    supportedOutputs: normalizePayloadKinds(raw.supportedOutputs)
  };
}

export function normalizeMessageAdapterPolicies(
  value: unknown,
  adapters: MessageAdapterType[],
  disabledAdapters: MessageAdapterType[] = []
): MessageAdapterPolicies {
  const raw = value && typeof value === "object" ? value as MessageAdapterPolicies : {};
  const disabled = new Set(disabledAdapters);
  const result: MessageAdapterPolicies = {};
  for (const adapter of adapters) {
    if (adapter === "disabled") continue;
    result[adapter] = normalizeMessageAdapterPolicy(raw[adapter], adapter, { legacyInputDisabled: disabled.has(adapter) });
  }
  return result;
}

export function messageAdapterPolicyFor(gateway: GatewayDefinition, type: MessageAdapterType): Required<MessageAdapterPolicy> {
  if (type === "disabled") {
    return normalizeMessageAdapterPolicy(undefined, "napcat", { legacyInputDisabled: true });
  }
  return normalizeMessageAdapterPolicy(gateway.messageAdapterPolicies?.[type], type, {
    legacyInputDisabled: gateway.messageAdaptersDisabled?.includes(type) === true
  });
}

export function messageAdapterInputEnabled(gateway: GatewayDefinition, type: MessageAdapterType): boolean {
  return !gateway.messageInputsDisabled && type !== "disabled" && messageAdapterPolicyFor(gateway, type).inputEnabled;
}

export function messageAdapterOutputEnabled(gateway: GatewayDefinition, type: MessageAdapterType): boolean {
  return type !== "disabled" && messageAdapterPolicyFor(gateway, type).outputEnabled;
}

export function gatewayAdapterTypes(gateway: GatewayDefinition): MessageAdapterType[] {
  if (gateway.messageInputsDisabled) return [];
  const adapters = Array.isArray(gateway.messageAdapters) && gateway.messageAdapters.length > 0
    ? gateway.messageAdapters
    : [gateway.messageAdapterType || "napcat"];
  const disabled = new Set(gateway.messageAdaptersDisabled ?? []);
  const next = [...new Set(adapters)]
    .filter((type): type is MessageAdapterType => messageAdapterValues.has(type as MessageAdapterType) && type !== "disabled" && !disabled.has(type) && messageAdapterPolicyFor(gateway, type).inputEnabled);
  return next.length > 0 ? next : [];
}

export function setGatewayAdapters(gateway: GatewayDefinition, adapters: MessageAdapterType[]): void {
  const next = [...new Set(adapters.filter(Boolean))].filter((type) => type !== "disabled");
  gateway.messageAdapters = next.length > 0 ? next : ["napcat"];
  gateway.messageAdapterType = gateway.messageAdapters[0];
  if (gateway.messageAdaptersDisabled) {
    gateway.messageAdaptersDisabled = gateway.messageAdaptersDisabled.filter((type) => gateway.messageAdapters!.includes(type));
  }
  gateway.messageAdapterPolicies = normalizeMessageAdapterPolicies(gateway.messageAdapterPolicies, gateway.messageAdapters, gateway.messageAdaptersDisabled);
}

export function definitionUsesNapcat(definition: GatewayDefinition): boolean {
  return gatewayAdapterTypes(definition).includes("napcat");
}

export function normalizeIgnoredNapcatInstanceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(item => String(item || "").trim()).filter(Boolean))];
}

export function assertValidPort(value: unknown, label: string): void {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}. Port must be an integer from 1 to 65535.`);
  }
}

export function portFromUrl(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : 0));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

export function normalizeCodexCwd(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  const compact = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  if (!trimmed || compact === "c:/path/to/your/project") {
    return undefined;
  }

  return trimmed;
}

export function sanitizeInstanceId(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  return raw.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

export function normalizeNapCatInstances(definition: GatewayDefinition): NapCatInstanceDefinition[] {
  const raw = Array.isArray(definition.napcatInstances) ? definition.napcatInstances : [];
  const source = raw.length > 0
    ? raw
    : [{
        id: "default",
        name: "默认 NapCat",
        enabled: true,
        gatewayPort: definition.gatewayPort,
        httpUrl: definition.napcatHttpUrl ?? "http://127.0.0.1:3000",
        webuiUrl: definition.napcatWebuiUrl ?? "http://127.0.0.1:6099/webui",
        accessToken: definition.napcatAccessToken,
        webuiToken: definition.napcatWebuiToken
      }];

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
      ...item,
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

export function resolvePrimaryNapCatInstance(
  definition: GatewayDefinition,
  instances: NapCatInstanceDefinition[] = normalizeNapCatInstances(definition)
): ResolvedNapCatInstances {
  const enabledIndex = instances.findIndex((item) => item.enabled !== false);
  const primaryIndex = enabledIndex >= 0 ? enabledIndex : (instances.length > 0 ? 0 : -1);
  return {
    instances,
    primary: primaryIndex >= 0 ? instances[primaryIndex] : undefined,
    primaryIndex
  };
}

export function normalizeGatewayNapCatConfig(definition: GatewayDefinition): ResolvedNapCatInstances {
  return resolvePrimaryNapCatInstance(definition, normalizeNapCatInstances(definition));
}

export function syncPrimaryNapCatInstanceFields(
  definition: GatewayDefinition,
  instances: NapCatInstanceDefinition[] = normalizeNapCatInstances(definition)
): ResolvedNapCatInstances {
  const resolved = resolvePrimaryNapCatInstance(definition, instances);
  definition.napcatInstances = resolved.instances;
  if (resolved.primary) {
    definition.gatewayPort = resolved.primary.gatewayPort;
    definition.napcatHttpUrl = resolved.primary.httpUrl;
    definition.napcatWebuiUrl = resolved.primary.webuiUrl;
    definition.napcatAccessToken = resolved.primary.accessToken ?? "";
    definition.napcatWebuiToken = resolved.primary.webuiToken ?? "";
  }
  return resolved;
}

function normalizeAgentAdaptersFallback(adapters: AgentAdapterType[] | undefined): AgentAdapterType[] {
  const rawItems = (adapters ?? ["codex"]) as unknown[];
  const next = rawItems
    .map((item) => item === "codexDesktop" || item === "codexApp" ? "codex" : item)
    .filter((item): item is AgentAdapterType => agentAdapterValues.has(item as AgentAdapterType));
  const unique = [...new Set(next)];
  return unique.length ? unique : ["codex"];
}

function normalizePipelineFallback(pipeline: PipelineDefinition | undefined): PipelineDefinition | undefined {
  return pipeline;
}

function normalizeRouteProfile(
  profile: RouteProfileDefinition,
  index: number,
  definition: GatewayDefinition,
  dataDir: string,
  rolesDir: string,
  options: GatewayConfigModelOptions
): RouteProfileDefinition | null {
  const roleId = sanitizeRoleId(profile.agentRoleId);
  const id = sanitizeRoleId(profile.id) || roleId || `route-${index + 1}`;
  const rules = normalizeRuleDefinitions(profile.notificationRules) ?? [];
  if (rules.length === 0) {
    return null;
  }

  const normalizePipeline = options.normalizePipeline ?? normalizePipelineFallback;
  return {
    id,
    name: profile.name?.trim() || id,
    enabled: profile.enabled !== false,
    pipelinePreset: typeof profile.pipelinePreset === "string" && profile.pipelinePreset.trim()
      ? profile.pipelinePreset.trim()
      : definition.pipelinePreset,
    pipeline: normalizePipeline(profile.pipeline) ?? normalizePipeline(definition.pipeline),
    agentRoleId: roleId,
    agentRoleFile: profile.agentRoleFile?.trim() || definition.agentRoleFile || "persona.md",
    rolesDir: profile.rolesDir?.trim() || rolesDir,
    dataDir: profile.dataDir?.trim() || dataDir,
    routeVariables: profile.routeVariables ?? definition.routeVariables ?? {},
    notificationRules: rules
  };
}

export function normalizeGatewayDefinition(definition: GatewayDefinition, options: GatewayConfigModelOptions = {}): GatewayDefinition {
  if (!definition.id || !sanitizeRoleId(definition.id)) {
    throw new Error(`Invalid gateway id: ${definition.id}`);
  }
  assertValidPort(definition.gatewayPort, `gateway port for ${definition.id}`);
  if (definition.webhookPort != null) assertValidPort(definition.webhookPort, `webhook port for ${definition.id}`);
  if (definition.fenneNoteWebhookPort != null) assertValidPort(definition.fenneNoteWebhookPort, `FenneNote webhook port for ${definition.id}`);
  if (definition.xiaoaiWebhookPort != null) assertValidPort(definition.xiaoaiWebhookPort, `XiaoAI webhook port for ${definition.id}`);

  const identity = resolveRouteIdentity(definition);
  const agentRoleId = identity.roleId;
  const configName = identity.configName;
  const runtimeId = identity.runtimeId;
  const dataDir = options.routeDataDir?.(configName) ?? `data/route/${configName}`;
  const rolesDir = options.rolesDir ?? definition.rolesDir ?? "data/roles";
  const routeName = definition.routeName?.trim() || definition.name?.trim() || configName;
  const notificationRules = normalizeRuleDefinitions(definition.notificationRules) ?? [];
  const { botNickname: _legacyBotNickname, ...cleanDefinition } = definition as GatewayDefinition & { botNickname?: string };
  const rawMessageAdapters = definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
  const messageInputsDisabled = definition.messageInputsDisabled === true || rawMessageAdapters.includes("disabled");
  const messageAdapters = normalizeMessageAdapters(rawMessageAdapters);
  const messageAdaptersDisabled = normalizeOptionalMessageAdapters(definition.messageAdaptersDisabled).filter((type) => messageAdapters.includes(type));
  const messageAdapterPolicies = normalizeMessageAdapterPolicies(definition.messageAdapterPolicies, messageAdapters, messageAdaptersDisabled);
  const activeMessageAdapters = gatewayAdapterTypes({
    ...definition,
    messageAdapters,
    messageAdaptersDisabled,
    messageAdapterPolicies,
    messageInputsDisabled
  });
  const usesNapcat = activeMessageAdapters.includes("napcat");
  const napcatConfig = usesNapcat ? normalizeGatewayNapCatConfig(definition) : undefined;
  const napcatInstances = napcatConfig?.instances ?? [];
  const primaryNapcat = napcatConfig?.primary;
  const normalizeAgentAdapters = options.normalizeAgentAdapters ?? normalizeAgentAdaptersFallback;
  const normalizePipeline = options.normalizePipeline ?? normalizePipelineFallback;
  const agentAdapters = normalizeAgentAdapters(definition.agentAdapters);
  const pipelinePreset = typeof definition.pipelinePreset === "string" && definition.pipelinePreset.trim()
    ? definition.pipelinePreset.trim()
    : undefined;
  const pipeline = normalizePipeline(definition.pipeline);
  return {
    ...cleanDefinition,
    id: runtimeId,
    name: definition.name ?? routeName,
    configName,
    enabled: definition.enabled !== false,
    messageAdapterType: messageAdapters[0] ?? "napcat",
    messageAdapters,
    messageAdaptersDisabled,
    messageInputsDisabled,
    messageAdapterPolicies,
    agentAdapters,
    agentModel: definition.agentModel?.trim() || "",
    pipelinePreset,
    pipeline,
    routeName,
    heartbeatIntervalSeconds: normalizePositiveNumber(definition.heartbeatIntervalSeconds, 900),
    heartbeatMessage: definition.heartbeatMessage ?? "定时心跳巡检：请检查最近消息和角色相关上下文。",
    gatewayPort: primaryNapcat?.gatewayPort ?? definition.gatewayPort,
    napcatHttpUrl: primaryNapcat?.httpUrl ?? definition.napcatHttpUrl,
    napcatWebuiUrl: primaryNapcat?.webuiUrl ?? definition.napcatWebuiUrl,
    napcatAccessToken: primaryNapcat?.accessToken ?? definition.napcatAccessToken,
    napcatWebuiToken: primaryNapcat?.webuiToken ?? definition.napcatWebuiToken,
    napcatInstances: usesNapcat ? napcatInstances : undefined,
    ignoredNapcatInstanceIds: normalizeIgnoredNapcatInstanceIds(definition.ignoredNapcatInstanceIds),
    codexCwd: normalizeCodexCwd(definition.codexCwd),
    groupNotificationTemplate: normalizeOptionalTemplate(definition.groupNotificationTemplate),
    groupAtNotificationTemplate: normalizeOptionalTemplate(definition.groupAtNotificationTemplate),
    groupDirectReplyNotificationTemplate: normalizeOptionalTemplate(definition.groupDirectReplyNotificationTemplate),
    groupIndirectReplyNotificationTemplate: normalizeOptionalTemplate(definition.groupIndirectReplyNotificationTemplate),
    groupReplyNotificationTemplate: normalizeOptionalTemplate(definition.groupReplyNotificationTemplate),
    groupNicknameNotificationTemplate: normalizeOptionalTemplate(definition.groupNicknameNotificationTemplate),
    privateNotificationTemplate: normalizeOptionalTemplate(definition.privateNotificationTemplate),
    heartbeatNotificationTemplate: normalizeOptionalTemplate(definition.heartbeatNotificationTemplate),
    voiceTranscriptNotificationTemplate: normalizeOptionalTemplate(definition.voiceTranscriptNotificationTemplate),
    notificationRules,
    dataDir,
    rolesDir,
    agentRoleId,
    agentRoleFile: definition.agentRoleFile ?? "persona.md",
    roleNotificationRules: { [runtimeId]: notificationRules },
    roleRouteNames: { [runtimeId]: routeName },
    routeProfiles: [normalizeRouteProfile({
      id: runtimeId,
      name: routeName,
      enabled: definition.enabled !== false,
      agentRoleId,
      agentRoleFile: definition.agentRoleFile ?? "persona.md",
      rolesDir,
      dataDir,
      pipelinePreset,
      pipeline,
      routeVariables: definition.routeVariables,
      notificationRules
    }, 0, definition, dataDir, rolesDir, options)].filter((profile): profile is RouteProfileDefinition => Boolean(profile))
  };
}

export function collectGatewayPortClaims(
  gateways: GatewayDefinition[],
  options: { managerPort?: number } = {}
): GatewayPortClaim[] {
  const claims: GatewayPortClaim[] = [];
  const claim = (
    port: number | null | undefined,
    label: string,
    kind: GatewayPortClaimKind,
    gatewayId?: string,
    instanceId?: string
  ): void => {
    if (port == null) return;
    assertValidPort(port, label);
    claims.push({ port, label, kind, gatewayId, instanceId });
  };

  if (options.managerPort != null) {
    claim(options.managerPort, "manager", "manager");
  }

  for (const gateway of gateways) {
    const activeAdapters = new Set(gatewayAdapterTypes(gateway));
    const enabledNapcatInstances = activeAdapters.has("napcat")
      ? (gateway.napcatInstances ?? []).filter((instance) => instance.enabled !== false)
      : [];
    if (activeAdapters.has("napcat") && enabledNapcatInstances.length === 0) {
      claim(gateway.gatewayPort, `${gateway.id} gateway WS`, "gateway-ws", gateway.id);
    }
    if (activeAdapters.has("webhook")) claim(gateway.webhookPort ?? gateway.gatewayPort, `${gateway.id} webhook`, "webhook", gateway.id);
    if (activeAdapters.has("fennenote")) claim(gateway.fenneNoteWebhookPort ?? gateway.webhookPort ?? gateway.gatewayPort, `${gateway.id} FenneNote webhook`, "fennenote-webhook", gateway.id);
    if (activeAdapters.has("xiaoai")) claim(gateway.xiaoaiWebhookPort ?? gateway.webhookPort ?? gateway.gatewayPort, `${gateway.id} XiaoAI webhook`, "xiaoai-webhook", gateway.id);
    for (const instance of enabledNapcatInstances) {
      const prefix = `${gateway.id}/${instance.id}`;
      claim(instance.gatewayPort, `${prefix} RabiRoute WS`, "napcat-ws", gateway.id, instance.id);
      claim(portFromUrl(instance.httpUrl), `${prefix} NapCat HTTP`, "napcat-http", gateway.id, instance.id);
    }
  }

  return claims;
}

export function validateGatewayPortConflicts(gateways: GatewayDefinition[]): void {
  const ports = new Map<number, GatewayPortClaim>();
  for (const claim of collectGatewayPortClaims(gateways)) {
    const existing = ports.get(claim.port);
    if (existing) {
      throw new Error(`Port conflict: ${claim.label} uses ${claim.port}, already used by ${existing.label}.`);
    }
    ports.set(claim.port, claim);
  }
}

export function nextAvailablePort(used: Set<number>, preferred: number): number {
  let port = Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535 ? preferred : 8790;
  while (port <= 65535 && used.has(port)) port += 1;
  if (port > 65535) {
    throw new Error("No available port in the 1-65535 range.");
  }
  used.add(port);
  return port;
}

export function autoAssignGatewayPorts(gateways: GatewayDefinition[], managerPort = 8790): void {
  const usedIngress = new Set<number>();
  const usedHttp = new Set<number>();
  if (Number.isInteger(managerPort) && managerPort >= 1 && managerPort <= 65535) {
    usedIngress.add(managerPort);
  }

  const assignIngress = (value: unknown, fallback: number): number => {
    const current = Number(value || 0);
    if (Number.isInteger(current) && current >= 1 && current <= 65535 && !usedIngress.has(current)) {
      usedIngress.add(current);
      return current;
    }
    return nextAvailablePort(usedIngress, Math.max(1, Math.min(65535, Number(fallback) || 8790)));
  };

  const assignHttpUrl = (value: string | undefined, fallbackPort: number): string => {
    let parsed: URL;
    try {
      parsed = new URL(value || `http://127.0.0.1:${fallbackPort}`);
    } catch {
      parsed = new URL(`http://127.0.0.1:${fallbackPort}`);
    }
    const current = portFromUrl(parsed.toString());
    if (current && !usedHttp.has(current)) {
      usedHttp.add(current);
      return parsed.toString().replace(/\/$/, "");
    }
    parsed.port = String(nextAvailablePort(usedHttp, current || fallbackPort));
    return parsed.toString().replace(/\/$/, "");
  };

  for (const gateway of gateways) {
    const activeAdapters = new Set(gatewayAdapterTypes(gateway));
    const enabledNapcatInstances = activeAdapters.has("napcat")
      ? (gateway.napcatInstances ?? []).filter((instance) => instance.enabled !== false)
      : [];

    if (activeAdapters.has("napcat") && enabledNapcatInstances.length > 0) {
      for (const instance of enabledNapcatInstances) {
        instance.gatewayPort = assignIngress(instance.gatewayPort, Number(gateway.gatewayPort || 8790) + 1);
        instance.httpUrl = assignHttpUrl(instance.httpUrl || gateway.napcatHttpUrl, 3000);
      }
      syncPrimaryNapCatInstanceFields(gateway, gateway.napcatInstances ?? enabledNapcatInstances);
    } else if (activeAdapters.has("napcat")) {
      gateway.gatewayPort = assignIngress(gateway.gatewayPort, 8790);
    }

    if (activeAdapters.has("webhook")) {
      gateway.webhookPort = assignIngress(gateway.webhookPort, Number(gateway.gatewayPort || 8790) + 1);
    }
    if (activeAdapters.has("fennenote")) {
      gateway.fenneNoteWebhookPort = assignIngress(gateway.fenneNoteWebhookPort, Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    }
    if (activeAdapters.has("xiaoai")) {
      gateway.xiaoaiWebhookPort = assignIngress(gateway.xiaoaiWebhookPort, Number(gateway.webhookPort || gateway.gatewayPort || 8790) + 1);
    }
  }
}
