import fs from "node:fs";
import path from "node:path";
import { sendGroupMessage, sendPrivateMessage, type NapCatEndpoint, type OneBotMessage } from "./napcat.js";
import { resolvePipeline, type OutputAdapterType, type PipelineDefinition, type ResolvedPipeline } from "./pipelines.js";
import { normalizeWeComError, sendWeComMessage, type WeComEndpoint } from "./wecom.js";
import {
  appendRolePanelTimelineMessage,
  createRolePanelMessageId,
  normalizeRolePanelAttachments,
  type RolePanelAttachment
} from "./rolePanelTimeline.js";
import {
  messageAdapterPolicyFor,
  type MessageAdapterType,
  type MessageAdapterPolicies,
  type MessageAdapterPolicy,
  type MessagePayloadKind
} from "./shared/gatewayConfigModel.js";

export type AgentReplyRequest = {
  text?: unknown;
  message?: unknown;
  content?: unknown;
  payload?: unknown;
  payloadType?: unknown;
  imageUrl?: unknown;
  imagePath?: unknown;
  voiceUrl?: unknown;
  voicePath?: unknown;
  audioUrl?: unknown;
  audioPath?: unknown;
  fileUrl?: unknown;
  filePath?: unknown;
  fileName?: unknown;
  routeProfileId?: unknown;
  messageId?: unknown;
  targetType?: unknown;
  groupId?: unknown;
  userId?: unknown;
  instanceId?: unknown;
  adapterType?: unknown;
  botUserId?: unknown;
  roleId?: unknown;
  replyContext?: unknown;
  wecomReqId?: unknown;
  wecomConversationId?: unknown;
  wecomChatId?: unknown;
  wecomSenderId?: unknown;
  wecomMessageType?: unknown;
};

export type AgentReplyNapCatInstance = NapCatEndpoint & {
  id: string;
  name?: string;
  enabled?: boolean;
};

export type AgentReplyRouteProfile = {
  id: string;
  name?: string;
  enabled?: boolean;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  dataDir?: string;
  agentRoleId?: string;
  rolesDir?: string;
};

export type AgentReplyRuntime = {
  id: string;
  name?: string;
  configName?: string;
  enabled?: boolean;
  targetGroupId?: string;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  dataDir?: string;
  agentRoleId?: string;
  rolesDir?: string;
  napcatInstances?: AgentReplyNapCatInstance[];
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomWsUrl?: string;
  routeProfiles?: AgentReplyRouteProfile[];
  messageAdapterPolicies?: MessageAdapterPolicies;
};

export type AgentReplyOptions = {
  rootDir: string;
  routeRoot: string;
  rolesRoot: string;
  runtimes: AgentReplyRuntime[];
  fenneNotePlaybackUrl?: string;
  fenneNotePlaybackToken?: string;
  fenneNoteReplyUrl?: string;
  fenneNoteReplyToken?: string;
};

export type AgentReplyResult = {
  ok: boolean;
  status: "sent" | "draft" | "blocked" | "failed";
  reason?: string;
  routeProfileId?: string;
  messageId?: string;
  targetType?: "group" | "private" | "role_panel" | "voice_transcript";
  groupId?: string;
  userId?: string;
  instanceId?: string;
  sentMessageId?: string;
  draft?: {
    text: string;
    targetType?: string;
    groupId?: string;
    userId?: string;
  };
};

type SourceRecord = {
  messageId?: string;
  targetType?: "group" | "private" | "role_panel" | "voice_transcript";
  groupId?: string;
  userId?: string;
  instanceId?: string;
  adapterType?: string;
  botUserId?: string;
  roleId?: string;
  reqId?: string;
  conversationId?: string;
  chatId?: string;
  messageType?: string;
  raw?: Record<string, unknown>;
};

type ResolvedRoute = {
  runtime: AgentReplyRuntime;
  profile?: AgentReplyRouteProfile;
};

type ResolvedReplyRoute = ResolvedRoute & {
  sourceRecord?: SourceRecord;
};

type ReplyContent = {
  text: string;
  kind: MessagePayloadKind;
  message: OneBotMessage;
};

function valueString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function isOutputAdapterType(value: string | undefined): value is OutputAdapterType {
  return value === "qq"
    || value === "codex"
    || value === "file"
    || value === "console"
    || value === "tts"
    || value === "webhook"
    || value === "fennenote"
    || value === "wecom"
    || value === "none";
}

function contextObject(request: AgentReplyRequest): Record<string, unknown> {
  if (request.replyContext && typeof request.replyContext === "object" && !Array.isArray(request.replyContext)) {
    return request.replyContext as Record<string, unknown>;
  }
  if (typeof request.replyContext === "string" && request.replyContext.trim()) {
    try {
      const parsed = JSON.parse(request.replyContext) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function payloadObject(request: AgentReplyRequest): Record<string, unknown> {
  const raw = request.payload;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function payloadValue(request: AgentReplyRequest, payload: Record<string, unknown>, ...keys: Array<keyof AgentReplyRequest | string>): string | undefined {
  for (const key of keys) {
    const value = (request as Record<string, unknown>)[key] ?? payload[key];
    const text = valueString(value);
    if (text) return text;
  }
  return undefined;
}

function rolePanelAttachmentsForRequest(request: AgentReplyRequest, content: ReplyContent): RolePanelAttachment[] {
  const payload = payloadObject(request);
  const rawAttachments = normalizeRolePanelAttachments(payload.attachments ?? (request as Record<string, unknown>).attachments);
  if (rawAttachments.length > 0) return rawAttachments;
  if (content.kind === "text") return [];
  const filePath = payloadValue(request, payload, "filePath", "imagePath", "voicePath", "audioPath", "path", "file");
  const url = payloadValue(request, payload, "fileUrl", "imageUrl", "voiceUrl", "audioUrl", "url");
  const name = payloadValue(request, payload, "fileName", "name") ?? filePath?.split(/[\\/]/).pop() ?? url?.split("/").pop();
  return normalizeRolePanelAttachments([{ kind: content.kind, name, path: filePath, url }]);
}

function requestContent(request: AgentReplyRequest): ReplyContent {
  const payload = payloadObject(request);
  const text = valueString(request.text ?? request.message ?? request.content ?? payload.text ?? payload.message ?? payload.content) ?? "";
  const kind = valueString(request.payloadType ?? payload.type ?? payload.payloadType) as MessagePayloadKind | undefined;
  if (kind === "image") {
    const file = payloadValue(request, payload, "imageUrl", "imagePath", "url", "file", "path");
    if (!file) throw new Error("Missing image url/path.");
    return { text, kind: "image", message: [...(text ? [{ type: "text" as const, data: { text } }] : []), { type: "image" as const, data: { file } }] };
  }
  if (kind === "voice") {
    const file = payloadValue(request, payload, "voiceUrl", "voicePath", "audioUrl", "audioPath", "url", "file", "path");
    if (!file) throw new Error("Missing voice url/path.");
    return { text: text || "[voice]", kind: "voice", message: [...(text ? [{ type: "text" as const, data: { text } }] : []), { type: "record" as const, data: { file } }] };
  }
  if (kind === "file") {
    const file = payloadValue(request, payload, "fileUrl", "filePath", "url", "file", "path");
    if (!file) throw new Error("Missing file url/path.");
    const name = payloadValue(request, payload, "fileName", "name");
    return { text: text || name || "[file]", kind: "file", message: [...(text ? [{ type: "text" as const, data: { text } }] : []), { type: "file" as const, data: { file, name } }] };
  }
  if (!text) {
    throw new Error("Missing reply text.");
  }
  return { text, kind: "text", message: text };
}

function requestField(request: AgentReplyRequest, key: keyof AgentReplyRequest): string | undefined {
  const ctx = contextObject(request);
  return valueString(request[key] ?? ctx[key]);
}

function routeConfigName(runtimeId: string): string {
  const parts = runtimeId.split("__");
  return parts[1] || runtimeId;
}

function resolvePath(rootDir: string, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  return path.resolve(rootDir, filePath);
}

function roleDirFor(rootDir: string, rolesRoot: string, item: { rolesDir?: string; agentRoleId?: string }): string | undefined {
  const roleId = valueString(item.agentRoleId);
  if (!roleId) return undefined;
  const base = path.resolve(rootDir, item.rolesDir ?? rolesRoot);
  return path.join(base, roleId);
}

function dataDirsForRoute(options: AgentReplyOptions, route: ResolvedRoute): string[] {
  const dirs = new Set<string>();
  dirs.add(path.resolve(options.routeRoot, routeConfigName(route.runtime.id)));
  const runtimeDataDir = resolvePath(options.rootDir, route.runtime.dataDir);
  if (runtimeDataDir) dirs.add(runtimeDataDir);
  const runtimeRoleDir = roleDirFor(options.rootDir, options.rolesRoot, route.runtime);
  if (runtimeRoleDir) dirs.add(runtimeRoleDir);
  if (route.profile) {
    const profileDataDir = resolvePath(options.rootDir, route.profile.dataDir);
    if (profileDataDir) dirs.add(profileDataDir);
    const profileRoleDir = roleDirFor(options.rootDir, options.rolesRoot, {
      rolesDir: route.profile.rolesDir ?? route.runtime.rolesDir,
      agentRoleId: route.profile.agentRoleId ?? route.runtime.agentRoleId
    });
    if (profileRoleDir) dirs.add(profileRoleDir);
  }
  return [...dirs];
}

function idMatches(value: unknown, expected?: string): boolean {
  return Boolean(expected && value != null && String(value) === expected);
}

function routeCandidates(options: AgentReplyOptions): ResolvedRoute[] {
  return options.runtimes.flatMap((runtime) => {
    const profiles = runtime.routeProfiles ?? [];
    if (profiles.length === 0) {
      return [{ runtime }];
    }
    return profiles.map((profile) => ({ runtime, profile }));
  });
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function sourceRecordFromLog(record: Record<string, unknown>, targetType: "group" | "private" | "voice_transcript", adapterType?: string): SourceRecord {
  return {
    messageId: valueString(record.messageId ?? record.message_id),
    targetType,
    groupId: valueString(record.groupId ?? record.group_id ?? record.chatId ?? record.chatid ?? record.conversationId),
    userId: valueString(record.userId ?? record.user_id ?? record.senderId),
    instanceId: valueString(record.instanceId),
    adapterType: valueString(record.adapterType) ?? adapterType,
    botUserId: valueString(record.botUserId),
    reqId: valueString(record.reqId),
    conversationId: valueString(record.conversationId),
    chatId: valueString(record.chatId ?? record.chatid),
    messageType: valueString(record.messageType ?? record.msgtype),
    raw: record
  };
}

function findSourceRecord(options: AgentReplyOptions, route: ResolvedRoute, messageId?: string): SourceRecord | undefined {
  if (!messageId) return undefined;
  for (const dir of dataDirsForRoute(options, route)) {
    for (const [fileName, targetType] of [
      ["group-messages.jsonl", "group"],
      ["private-messages.jsonl", "private"],
      ["voice-transcripts.jsonl", "voice_transcript"],
      ["fennenote-voice-transcripts.jsonl", "voice_transcript"],
      ["rabilink-voice-transcripts.jsonl", "voice_transcript"],
      ["wecom-messages.jsonl", "group"]
    ] as const) {
      const found = readJsonl(path.join(dir, fileName))
        .reverse()
        .find((record) => String(record.messageId ?? record.message_id ?? "") === messageId);
      if (found) {
        return sourceRecordFromLog(found, targetType, fileName === "wecom-messages.jsonl" ? "wecom" : undefined);
      }
    }
  }
  return undefined;
}

function findSourceRoute(options: AgentReplyOptions, messageId?: string, contextTarget?: SourceRecord): ResolvedReplyRoute | undefined {
  if (messageId) {
    for (const route of routeCandidates(options)) {
      const sourceRecord = findSourceRecord(options, route, messageId);
      if (sourceRecord) {
        return { ...route, sourceRecord };
      }
    }
  }

  if (contextTarget?.instanceId) {
    const runtime = options.runtimes.find((item) =>
      (item.napcatInstances ?? []).some((instance) => instance.id === contextTarget.instanceId && instance.enabled !== false)
    );
    if (runtime) {
      return { runtime, profile: runtime.routeProfiles?.[0] };
    }
  }

  return undefined;
}

function runtimeCanUseNapCat(runtime: AgentReplyRuntime): boolean {
  return (runtime.napcatInstances ?? []).some((instance) => instance.enabled !== false);
}

function runtimeCanUseWeCom(runtime: AgentReplyRuntime): boolean {
  return Boolean(runtime.wecomBotId?.trim() || process.env.WECOM_BOT_ID?.trim());
}

function resolveExplicitTargetRoute(options: AgentReplyOptions, contextTarget?: SourceRecord): ResolvedReplyRoute | undefined {
  if (!contextTarget?.targetType || (!contextTarget.groupId && !contextTarget.userId)) {
    return undefined;
  }

  if (contextTarget.adapterType === "wecom") {
    const runtime = options.runtimes.find(runtimeCanUseWeCom) ?? options.runtimes[0];
    return runtime ? { runtime, profile: runtime.routeProfiles?.[0] } : undefined;
  }

  if (contextTarget.targetType === "group" && contextTarget.groupId) {
    const matched = options.runtimes.find((runtime) => runtime.targetGroupId && String(runtime.targetGroupId) === String(contextTarget.groupId));
    if (matched) return { runtime: matched, profile: matched.routeProfiles?.[0] };
  }

  const runtime = options.runtimes.find(runtimeCanUseNapCat) ?? options.runtimes[0];
  return runtime ? { runtime, profile: runtime.routeProfiles?.[0] } : undefined;
}

function resolveRouteById(options: AgentReplyOptions, routeProfileId?: string, runtimeRouteId?: string): ResolvedRoute | undefined {
  if (routeProfileId || runtimeRouteId) {
    for (const runtime of options.runtimes) {
      const runtimeMatched = idMatches(runtime.id, runtimeRouteId)
        || idMatches(runtime.configName, runtimeRouteId)
        || idMatches(runtime.name, runtimeRouteId)
        || idMatches(runtime.id, routeProfileId)
        || idMatches(runtime.configName, routeProfileId)
        || idMatches(runtime.name, routeProfileId)
        || idMatches(runtime.agentRoleId, routeProfileId);
      const profile = runtime.routeProfiles?.find((item) =>
        idMatches(item.id, routeProfileId)
        || idMatches(item.name, routeProfileId)
        || idMatches(item.agentRoleId, routeProfileId)
      );
      if (profile) return { runtime, profile };
      if (runtimeMatched) return { runtime, profile: runtime.routeProfiles?.[0] };
    }
  }
  if (options.runtimes.length === 1) {
    return { runtime: options.runtimes[0], profile: options.runtimes[0].routeProfiles?.[0] };
  }
  return undefined;
}

function resolveRoute(options: AgentReplyOptions, routeProfileId?: string, messageId?: string, contextTarget?: SourceRecord, runtimeRouteId?: string): ResolvedReplyRoute | undefined {
  const sourceRoute = findSourceRoute(options, messageId, contextTarget);
  if (sourceRoute) return sourceRoute;
  const explicitTargetRoute = resolveExplicitTargetRoute(options, contextTarget);
  if (explicitTargetRoute) return explicitTargetRoute;
  const routeById = resolveRouteById(options, routeProfileId, runtimeRouteId);
  if (routeById) return routeById;
  return undefined;
}

function appendOutboxLog(options: AgentReplyOptions, route: ResolvedRoute | undefined, level: "info" | "warning" | "error", event: string, message: string, data: unknown): void {
  const dir = route ? dataDirsForRoute(options, route)[0] : path.join(options.rootDir, "data", "route", "default");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "outbox-adapter.log.jsonl"), `${JSON.stringify({
    time: Math.floor(Date.now() / 1000),
    adapter: "outbox",
    level,
    event,
    message,
    data
  })}\n`, "utf8");
}

function endpointFor(route: ResolvedRoute, instanceId?: string): AgentReplyNapCatInstance | undefined {
  const instances = route.runtime.napcatInstances ?? [];
  if (instanceId) {
    return instances.find((item) => item.id === instanceId && item.enabled !== false);
  }
  return instances.find((item) => item.enabled !== false) ?? instances[0];
}

function routePipeline(route: ResolvedRoute): ResolvedPipeline {
  return resolvePipeline(
    route.profile?.pipelinePreset ?? route.runtime.pipelinePreset,
    route.profile?.pipeline ?? route.runtime.pipeline
  );
}

function replyPipeline(route: ResolvedRoute, request: AgentReplyRequest): ResolvedPipeline {
  const pipeline = routePipeline(route);
  const context = contextObject(request);
  const outputAdapter = valueString(context.outputAdapter);
  return {
    ...pipeline,
    outputAdapter: isOutputAdapterType(outputAdapter) ? outputAdapter : pipeline.outputAdapter,
    outputPipeline: valueString(context.outputPipeline) ?? pipeline.outputPipeline,
    replyToSource: typeof context.replyToSource === "boolean" ? context.replyToSource : pipeline.replyToSource
  };
}

function napcatPolicy(route: ResolvedRoute): Required<MessageAdapterPolicy> {
  return messageAdapterPolicyFor({
    id: route.runtime.id,
    gatewayPort: 0,
    messageAdapters: ["napcat"],
    messageAdapterPolicies: route.runtime.messageAdapterPolicies
  }, "napcat");
}

function fenneNotePolicy(route: ResolvedRoute): Required<MessageAdapterPolicy> {
  return messageAdapterPolicyFor({
    id: route.runtime.id,
    gatewayPort: 0,
    messageAdapters: ["fennenote"],
    messageAdapterPolicies: route.runtime.messageAdapterPolicies
  }, "fennenote");
}

function wecomPolicy(route: ResolvedRoute): Required<MessageAdapterPolicy> {
  return messageAdapterPolicyFor({
    id: route.runtime.id,
    gatewayPort: 0,
    messageAdapters: ["wecom"],
    messageAdapterPolicies: route.runtime.messageAdapterPolicies
  }, "wecom");
}

function rabiLinkPolicy(route: ResolvedRoute): Required<MessageAdapterPolicy> {
  return messageAdapterPolicyFor({
    id: route.runtime.id,
    gatewayPort: 0,
    messageAdapters: ["rabilink"],
    messageAdapterPolicies: route.runtime.messageAdapterPolicies
  }, "rabilink");
}
function wecomEndpoint(route: ResolvedRoute): WeComEndpoint | undefined {
  const botId = route.runtime.wecomBotId?.trim() || process.env.WECOM_BOT_ID?.trim() || "";
  const secret = route.runtime.wecomBotSecret?.trim() || process.env.WECOM_BOT_SECRET?.trim() || "";
  if (!botId || !secret) return undefined;
  return {
    botId,
    secret,
    wsUrl: route.runtime.wecomWsUrl?.trim() || process.env.WECOM_WS_URL?.trim() || undefined
  };
}

function appendAdapterReply(
  options: AgentReplyOptions,
  route: ResolvedRoute,
  adapterType: MessageAdapterType,
  target: SourceRecord,
  content: ReplyContent,
  request: AgentReplyRequest
): AgentReplyResult {
  const dir = dataDirsForRoute(options, route)[0];
  fs.mkdirSync(dir, { recursive: true });
  const id = `${adapterType}-reply-${Date.now()}`;
  fs.appendFileSync(path.join(dir, `${adapterType}-replies.jsonl`), `${JSON.stringify({
    time: Math.floor(Date.now() / 1000),
    id,
    messageId: target.messageId,
    targetType: target.targetType,
    adapterType,
    text: content.text,
    payloadType: content.kind,
    replyContext: contextObject(request),
    payload: payloadObject(request)
  })}\n`, "utf8");
  return {
    ok: true,
    status: "sent",
    reason: `Queued for ${adapterType} output.`,
    routeProfileId: route.profile?.id ?? route.runtime.id,
    messageId: target.messageId,
    targetType: target.targetType,
    groupId: target.groupId,
    userId: target.userId,
    instanceId: target.instanceId,
    sentMessageId: id
  };
}

function draft(reason: string, text: string, target: SourceRecord, routeProfileId?: string): AgentReplyResult {
  return {
    ok: false,
    status: "draft",
    reason,
    routeProfileId,
    messageId: target.messageId,
    targetType: target.targetType,
    groupId: target.groupId,
    userId: target.userId,
    instanceId: target.instanceId,
    draft: {
      text,
      targetType: target.targetType,
      groupId: target.groupId,
      userId: target.userId
    }
  };
}

function appendRolePanelReply(
  options: AgentReplyOptions,
  route: ResolvedRoute,
  target: SourceRecord,
  text: string,
  attachments: RolePanelAttachment[],
  request: AgentReplyRequest
): AgentReplyResult {
  const roleDir = roleDirFor(options.rootDir, options.rolesRoot, {
    rolesDir: route.profile?.rolesDir ?? route.runtime.rolesDir,
    agentRoleId: target.roleId ?? route.profile?.agentRoleId ?? route.runtime.agentRoleId
  });
  if (!roleDir) {
    return { ok: false, status: "blocked", reason: "Role panel reply requires a role id.", routeProfileId: route.profile?.id ?? route.runtime.id, messageId: target.messageId };
  }
  const roleId = valueString(target.roleId ?? route.profile?.agentRoleId ?? route.runtime.agentRoleId) ?? path.basename(roleDir);
  appendRolePanelTimelineMessage(roleDir, {
    id: createRolePanelMessageId("role-panel-assistant"),
    time: Math.floor(Date.now() / 1000),
    roleId,
    gatewayId: route.runtime.id,
    routeProfileId: route.profile?.id ?? route.runtime.id,
    direction: "assistant",
    sender: "Agent",
    text,
    attachments,
    status: "sent",
    replyContext: contextObject(request)
  });
  return {
    ok: true,
    status: "sent",
    reason: "Sent to role panel timeline.",
    routeProfileId: route.profile?.id ?? route.runtime.id,
    messageId: target.messageId,
    targetType: "role_panel"
  };
}

function stripRouteSuffix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s*路由\s*$/, "").trim();
  return text || value;
}

function personaNameForFenneNote(options: AgentReplyOptions, route: ResolvedRoute): string | undefined {
  const roleId = valueString(route.profile?.agentRoleId ?? route.runtime.agentRoleId);
  const rolesDir = valueString(route.profile?.rolesDir ?? route.runtime.rolesDir) ?? options.rolesRoot;
  if (roleId && rolesDir) {
    const rolePath = path.join(path.isAbsolute(rolesDir) ? rolesDir : path.resolve(options.rootDir, rolesDir), roleId, "persona.md");
    try {
      const firstHeading = fs.readFileSync(rolePath, "utf8").split(/\r?\n/).find((line) => line.trim().startsWith("# "));
      const name = firstHeading?.replace(/^#\s+/, "").trim();
      if (name) return name;
    } catch {
      // Best-effort display name only; route ids remain the durable identity.
    }
  }
  return stripRouteSuffix(route.profile?.name ?? route.runtime.name ?? roleId);
}

function fenneNoteReplyPayload(
  options: AgentReplyOptions,
  request: AgentReplyRequest,
  route: ResolvedRoute,
  target: SourceRecord,
  content: ReplyContent
): Record<string, unknown> {
  const context = contextObject(request);
  const payload = payloadObject(request);
  const requestFields = request as Record<string, unknown>;
  return {
    ...payload,
    ...requestFields,
    text: content.text,
    message: requestFields.message ?? payload.message ?? content.text,
    content: requestFields.content ?? payload.content ?? content.text,
    payloadType: requestFields.payloadType ?? payload.payloadType ?? payload.type ?? content.kind,
    routeProfileId: route.profile?.id ?? route.runtime.id,
    routeProfileName: route.profile?.name ?? route.runtime.name,
    agentRoleId: route.profile?.agentRoleId ?? route.runtime.agentRoleId,
    agentRoleName: personaNameForFenneNote(options, route),
    messageId: target.messageId ?? valueString(context.messageId),
    targetType: target.targetType ?? valueString(context.targetType) ?? "voice_transcript",
    adapterType: "fennenote",
    speakerId: context.speakerId,
    speakerName: context.speakerName,
    speakerKind: context.speakerKind,
    speakerConfidence: context.speakerConfidence,
    speakerDecision: context.speakerDecision,
    replyContext: context,
    payload
  };
}

function shouldUseFenneNotePlayback(
  request: AgentReplyRequest,
  target: SourceRecord,
  pipeline: ResolvedPipeline
): boolean {
  const context = contextObject(request);
  const payload = payloadObject(request);
  return target.targetType === "voice_transcript"
    || valueString(context.routeKind) === "voice_transcript"
    || pipeline.ttsPlay
    || typeof payload.play === "boolean"
    || Boolean(valueString(payload.character_id))
    || Boolean(valueString(payload.worker_url))
    || Array.isArray(payload.emotion_vector);
}

async function postFenneNoteOutput(
  options: AgentReplyOptions,
  body: Record<string, unknown>,
  mode: "reply" | "playback"
): Promise<Record<string, unknown>> {
  const targetUrl = mode === "playback"
    ? options.fenneNotePlaybackUrl ?? process.env.FENNOTE_PLAYBACK_URL ?? "http://127.0.0.1:8793/api/fennenote/playback"
    : options.fenneNoteReplyUrl ?? process.env.FENNOTE_REPLY_URL ?? "http://127.0.0.1:8793/api/fennenote/reply";
  const token = mode === "playback"
    ? options.fenneNotePlaybackToken ?? process.env.FENNOTE_PLAYBACK_TOKEN ?? ""
    : options.fenneNoteReplyToken ?? process.env.FENNOTE_REPLY_TOKEN ?? process.env.FENNOTE_PLAYBACK_TOKEN ?? "";
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "RabiRoute"
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) as unknown : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`FenneNote reply endpoint returned ${response.status}: ${text || response.statusText}`);
  }
  return {
    mode,
    status: response.status,
    target: targetUrl,
    response: parsed
  };
}

export async function handleAgentReply(request: AgentReplyRequest, options: AgentReplyOptions): Promise<AgentReplyResult> {
  const content = requestContent(request);
  const text = content.text;
  const context = contextObject(request);
  const routeProfileId = requestField(request, "routeProfileId");
  const runtimeRouteId = valueString(context.runtimeRouteId ?? context.gatewayId);
  const messageId = requestField(request, "messageId");
  const contextTarget: SourceRecord = {
    messageId,
    targetType: requestField(request, "targetType") === "group"
      ? "group"
      : requestField(request, "targetType") === "private"
        ? "private"
        : requestField(request, "targetType") === "role_panel" || requestField(request, "adapterType") === "rolePanel"
          ? "role_panel"
          : requestField(request, "targetType") === "voice_transcript" || requestField(request, "adapterType") === "fennenote" || requestField(request, "adapterType") === "rabilink"
            ? "voice_transcript"
            : requestField(request, "groupId")
              ? "group"
              : requestField(request, "userId")
                ? "private"
                : undefined,
    groupId: requestField(request, "groupId"),
    userId: requestField(request, "userId"),
    instanceId: requestField(request, "instanceId"),
    adapterType: requestField(request, "adapterType"),
    botUserId: requestField(request, "botUserId"),
    roleId: requestField(request, "roleId"),
    reqId: requestField(request, "wecomReqId"),
    conversationId: requestField(request, "wecomConversationId"),
    chatId: requestField(request, "wecomChatId"),
    messageType: requestField(request, "wecomMessageType")
  };
  const route = resolveRoute(options, routeProfileId, messageId, contextTarget, runtimeRouteId);
  appendOutboxLog(options, route, "info", "reply_requested", text.slice(0, 500), { routeProfileId, messageId, payloadKind: content.kind, request });

  if (!route) {
    const result: AgentReplyResult = { ok: false, status: "blocked", reason: "Route source context is required when multiple routes are configured.", routeProfileId, messageId, draft: { text } };
    appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
    return result;
  }

  const loggedTarget = route.sourceRecord ?? findSourceRecord(options, route, messageId);
  const target = { ...contextTarget, ...loggedTarget };
  if (target.targetType === "group" && !target.groupId && route.runtime.targetGroupId) {
    target.groupId = String(route.runtime.targetGroupId);
  }
  if (target.targetType === "role_panel" || target.adapterType === "rolePanel") {
    const result = appendRolePanelReply(options, route, target, text, rolePanelAttachmentsForRequest(request, content), request);
    appendOutboxLog(options, route, result.ok ? "info" : "warning", result.ok ? "role_panel_reply_sent" : "reply_blocked", result.reason ?? "", result);
    return result;
  }
  if (target.adapterType === "rabilink") {
    const policy = rabiLinkPolicy(route);
    if (!policy.outputEnabled) {
      const result: AgentReplyResult = { ...draft("RabiLink message sending is disabled by this route policy.", text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
      appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
      return result;
    }
    if (!policy.supportedOutputs.includes(content.kind)) {
      const result: AgentReplyResult = { ...draft(`RabiLink route policy does not allow ${content.kind} payloads.`, text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
      appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
      return result;
    }
    const result = appendAdapterReply(options, route, "rabilink", target, content, request);
    appendOutboxLog(options, route, "info", "rabilink_reply_queued", text.slice(0, 500), result);
    return result;
  }
  const pipeline = replyPipeline(route, request);
  const policy = napcatPolicy(route);
  const hasExplicitQqTarget = Boolean(target.targetType && (target.groupId || target.userId));
  const isSourceReply = Boolean(
    target.adapterType === "napcat" ||
    (messageId && loggedTarget) ||
    hasExplicitQqTarget
  );

  if (pipeline.outputAdapter === "codex" && !isSourceReply) {
    const result: AgentReplyResult = {
      ok: true,
      status: "sent",
      reason: "Accepted by Codex output adapter.",
      routeProfileId: route.profile?.id ?? route.runtime.id,
      messageId,
      targetType: target.targetType,
      groupId: target.groupId,
      userId: target.userId,
      instanceId: target.instanceId
    };
    appendOutboxLog(options, route, "info", "codex_reply_accepted", text.slice(0, 500), {
      ...result,
      text
    });
    return result;
  }

  if (pipeline.outputAdapter === "fennenote") {
    const fennePolicy = fenneNotePolicy(route);
    if (!fennePolicy.outputEnabled) {
      const result: AgentReplyResult = { ...draft("FenneNote message sending is disabled by this route policy.", text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
      appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
      return result;
    }
    if (!fennePolicy.supportedOutputs.includes(content.kind)) {
      const result: AgentReplyResult = { ...draft(`FenneNote route policy does not allow ${content.kind} payloads.`, text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
      appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
      return result;
    }

    try {
      const outputMode = shouldUseFenneNotePlayback(request, target, pipeline) ? "playback" : "reply";
      const forwarded = await postFenneNoteOutput(options, fenneNoteReplyPayload(options, request, route, target, content), outputMode);
      const result: AgentReplyResult = {
        ok: true,
        status: "sent",
        reason: outputMode === "playback" ? "Sent to FenneNote playback endpoint." : "Sent to FenneNote reply endpoint.",
        routeProfileId: route.profile?.id ?? route.runtime.id,
        messageId,
        targetType: target.targetType,
        groupId: target.groupId,
        userId: target.userId,
        instanceId: target.instanceId,
        sentMessageId: valueString((forwarded.response as Record<string, unknown>)?.messageId ?? (forwarded.response as Record<string, unknown>)?.id)
      };
      appendOutboxLog(options, route, "info", outputMode === "playback" ? "fennenote_playback_sent" : "fennenote_reply_sent", text.slice(0, 500), { ...result, forwarded });
      return result;
    } catch (error) {
      const result: AgentReplyResult = {
        ok: false,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        routeProfileId: route.profile?.id ?? route.runtime.id,
        messageId,
        targetType: target.targetType,
        groupId: target.groupId,
        userId: target.userId,
        instanceId: target.instanceId,
        draft: { text, targetType: target.targetType, groupId: target.groupId, userId: target.userId }
      };
      appendOutboxLog(options, route, "error", "fennenote_reply_failed", result.reason ?? "failed", result);
      return result;
    }
  }

  const shouldUseWeCom = pipeline.outputAdapter === "wecom" || target.adapterType === "wecom" || contextTarget.adapterType === "wecom";
  if (shouldUseWeCom) {
    const policy = wecomPolicy(route);
    if (!policy.outputEnabled) {
      const result: AgentReplyResult = { ...draft("WeCom message sending is disabled by this route policy.", text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
      appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
      return result;
    }
    if (!policy.supportedOutputs.includes(content.kind)) {
      const result: AgentReplyResult = { ...draft(`WeCom route policy does not allow ${content.kind} payloads.`, text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
      appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
      return result;
    }

    const endpoint = wecomEndpoint(route);
    if (!endpoint) {
      const result: AgentReplyResult = { ...draft("No WeCom bot id/secret is configured for this route.", text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
      appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
      return result;
    }
    const chatId = target.chatId || target.groupId || target.conversationId;
    if (!chatId) {
      const result: AgentReplyResult = { ...draft("Only current WeCom group source replies or explicit WeCom group targets can be sent automatically.", text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
      appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
      return result;
    }
    try {
      const payload = payloadObject(request);
      const sent = await sendWeComMessage(endpoint, {
        chatId,
        text,
        markdown: text,
        payloadType: content.kind === "text" ? "text" : content.kind,
        filePath: payloadValue(request, payload, "filePath", "imagePath", "voicePath", "audioPath", "path", "file"),
        fileUrl: payloadValue(request, payload, "fileUrl", "imageUrl", "voiceUrl", "audioUrl", "url"),
        fileName: payloadValue(request, payload, "fileName", "name")
      });
      const result: AgentReplyResult = {
        ok: true,
        status: "sent",
        reason: target.reqId ? "Sent to WeCom source chat." : "Sent to WeCom chat.",
        routeProfileId: route.profile?.id ?? route.runtime.id,
        messageId,
        targetType: "group",
        groupId: chatId,
        userId: target.userId,
        instanceId: target.instanceId,
        sentMessageId: valueString(sent.messageId ?? sent.reqId)
      };
      appendOutboxLog(options, route, "info", "wecom_reply_sent", text.slice(0, 500), { ...result, sent });
      return result;
    } catch (error) {
      const result: AgentReplyResult = {
        ok: false,
        status: "failed",
        reason: normalizeWeComError(error),
        routeProfileId: route.profile?.id ?? route.runtime.id,
        messageId,
        targetType: "group",
        groupId: chatId,
        userId: target.userId,
        instanceId: target.instanceId,
        draft: { text, targetType: "group", groupId: chatId, userId: target.userId }
      };
      appendOutboxLog(options, route, "error", "wecom_reply_failed", result.reason ?? "failed", result);
      return result;
    }
  }

  if (pipeline.outputAdapter !== "qq" && !isSourceReply) {
    const result = draft(`Pipeline does not use QQ output: outputAdapter=${pipeline.outputAdapter}.`, text, target, route.profile?.id ?? route.runtime.id);
    appendOutboxLog(options, route, "warning", "reply_draft", result.reason ?? "draft", result);
    return result;
  }

  if (!policy.outputEnabled) {
    const result: AgentReplyResult = { ...draft("NapCat message sending is disabled by this route policy.", text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
    appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
    return result;
  }

  if (!policy.supportedOutputs.includes(content.kind)) {
    const result: AgentReplyResult = { ...draft(`NapCat route policy does not allow ${content.kind} payloads.`, text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
    appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
    return result;
  }

  if (target.adapterType && target.adapterType !== "napcat") {
    const result: AgentReplyResult = { ...draft(`Source adapter is not QQ/NapCat: ${target.adapterType}.`, text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
    appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
    return result;
  }

  if (target.botUserId && target.userId && target.botUserId === target.userId) {
    const result: AgentReplyResult = { ...draft("Original source message is from the bot itself.", text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
    appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
    return result;
  }

  const endpoint = endpointFor(route, target.instanceId);
  if (!endpoint) {
    const result: AgentReplyResult = { ...draft("No NapCat HTTP endpoint is configured for this route.", text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
    appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
    return result;
  }

  try {
    if (target.targetType === "group" && target.groupId) {
      const sent = await sendGroupMessage({ groupId: target.groupId, message: content.message }, endpoint);
      const result: AgentReplyResult = { ok: true, status: "sent", routeProfileId: route.profile?.id ?? route.runtime.id, messageId, targetType: "group", groupId: target.groupId, instanceId: endpoint.id, sentMessageId: valueString(sent.messageId) };
      appendOutboxLog(options, route, "info", "reply_sent", text.slice(0, 500), result);
      return result;
    }
    if (target.targetType === "private" && target.userId) {
      const sent = await sendPrivateMessage({ userId: target.userId, message: content.message }, endpoint);
      const result: AgentReplyResult = { ok: true, status: "sent", routeProfileId: route.profile?.id ?? route.runtime.id, messageId, targetType: "private", userId: target.userId, instanceId: endpoint.id, sentMessageId: valueString(sent.messageId) };
      appendOutboxLog(options, route, "info", "reply_sent", text.slice(0, 500), result);
      return result;
    }
    const result: AgentReplyResult = { ...draft("Only current QQ group/private source replies can be sent automatically.", text, target, route.profile?.id ?? route.runtime.id), status: "blocked" };
    appendOutboxLog(options, route, "warning", "reply_blocked", result.reason ?? "blocked", result);
    return result;
  } catch (error) {
    const result: AgentReplyResult = { ok: false, status: "failed", reason: error instanceof Error ? error.message : String(error), routeProfileId: route.profile?.id ?? route.runtime.id, messageId, targetType: target.targetType, groupId: target.groupId, userId: target.userId, instanceId: endpoint.id, draft: { text, targetType: target.targetType, groupId: target.groupId, userId: target.userId } };
    appendOutboxLog(options, route, "error", "reply_failed", result.reason ?? "failed", result);
    return result;
  }
}
