import { markdownImageSettings, checkMarkdownQuota } from "./markdownImage.js";
import { AGENT_SEND_CHANNEL_HELP, AGENT_SEND_FIELD_NAMES, AGENT_SEND_LIMITS, AGENT_SEND_PAYLOAD_TYPES, agentSendQuotaSettings } from "./agentSendContracts.js";
import type { AgentSendChannel, AgentSendChannelHelp } from "./agentSendContracts.js";
import type { AGENT_SEND_WIRE_SCHEMA } from "./agentSendContracts.js";
export { AGENT_SEND_CHANNEL_HELP, AGENT_SEND_REQUEST_CONTRACT } from "./agentSendContracts.js";
export type { AgentSendChannel, AgentSendChannelHelp } from "./agentSendContracts.js";

import {
  handleAgentReply,
  inspectAgentReplyDelivery,
  type AgentReplyOptions,
  type AgentReplyDeliveryInspection,
  type AgentReplyRequest,
  type AgentReplyResult
} from "./outbox.js";
import {
  archiveReplyImageDescriptions,
  prepareReplyImageDescriptions,
  type ReviewedReplySourceEvidence,
  type ReplyImageDescriptionArchive,
  type ReplyImageDescriptionPlan
} from "./replyImageDescriptions.js";
import { normalizeStyleValidationMode, type StyleValidationMode } from "./shared/languageStyle.js";
import type { LanguageStyleValidationResult } from "./languageStyleValidation.js";

export type AgentSendSender = {
  agentType: string;
  sessionId: string;
};

export type AgentSendRequest = { -readonly [Field in keyof typeof AGENT_SEND_WIRE_SCHEMA.properties]?: unknown };

export type AgentSendResult = AgentReplyResult & {
  conversationContext?: import("./agentSendConversationContext.js").AgentSendConversationContext;
  conversationContextError?: string;
  deliveryId?: string;
  sender?: AgentSendSender;
  channel?: AgentSendChannel;
  routeId?: string;
  target?: Record<string, unknown>;
  replyImageDescriptionArchive?: ReplyImageDescriptionArchive;
  languageStyleValidation?: {
    mode: StyleValidationMode;
    bypassed: boolean;
    styleSkillUrl: string;
    result?: LanguageStyleValidationResult;
  };
  messageLengthValidation?: {
    characterCount: number;
    threshold: number;
    confirmed: boolean;
    confirmationToken?: string;
    expiresAt?: string;
  };
};

export type AgentSendDeliveryInspection =
  | { state: "completed"; result: AgentSendResult }
  | Exclude<AgentReplyDeliveryInspection, { state: "completed" }>;

/** Confirmation is a transient review proof, not part of the durable message identity. */
export function agentSendIdempotencyPayload(request: AgentSendRequest): Omit<AgentSendRequest, "deliveryId" | "messageLengthConfirmation"> {
  const { deliveryId: _deliveryId, messageLengthConfirmation: _confirmation, conversationContext: _context, ...payload } = request;
  return payload;
}

type NormalizedAgentSend = {
  deliveryId: string;
  sender: AgentSendSender;
  routeId: string;
  channel: AgentSendChannel;
  allowAdditionalReply: boolean;
  replyImageDescriptions: string[];
  target: Record<string, unknown>;
  styleValidation: StyleValidationMode;
  messageLengthConfirmation?: string;
  conversationContext?: { lastReadMessageIndex?: string; confirmationToken?: string };
  internal: AgentReplyRequest;
};

export function agentSendChannelHelp(channel?: string): AgentSendChannelHelp | undefined {
  return AGENT_SEND_CHANNEL_HELP.find(item => item.channel === channel);
}

function assertOnlyFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`${field} contains unsupported fields: ${unexpected.join(", ")}.`);
}

function objectValue(value: unknown, field: string, required = true): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (!required && value == null) return {};
  throw new Error(`${field} must be an object.`);
}

function textValue(value: unknown, field: string, required = true): string | undefined {
  const text = value == null ? "" : String(value).trim();
  if (text) return text;
  if (!required) return undefined;
  throw new Error(`Missing ${field}.`);
}

function senderValue(value: unknown): AgentSendSender {
  const sender = objectValue(value, "sender");
  assertOnlyFields(sender, AGENT_SEND_FIELD_NAMES.sender, "sender");
  const agentType = textValue(sender.agentType, "sender.agentType") as string;
  const sessionId = textValue(sender.sessionId, "sender.sessionId") as string;
  if (agentType.length > AGENT_SEND_LIMITS.agentType || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(agentType)) {
    throw new Error("sender.agentType must be a stable Agent type identifier.");
  }
  if (sessionId.length > AGENT_SEND_LIMITS.sessionId || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error("sender.sessionId must be a stable session identifier without control characters.");
  }
  return { agentType, sessionId };
}

function booleanValue(value: unknown, field: string, fallback = false): boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${field} must be a boolean.`);
}

function stringList(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item, index) => textValue(item, `${field}[${index}]`) as string);
}

export type AgentSendPlanAttachmentReference = { roleId?: string; planId: string; attachmentId: string };

/**
 * `payload.planAttachment` lets an Agent attach an image that already lives in a managed
 * plan's attachment directory. The Manager resolves the id against real plan storage and
 * re-validates containment there; this parser only checks the request shape.
 */
function planAttachmentReference(
  value: unknown,
  type: string,
  fallback: { path?: string; url?: string }
): AgentSendPlanAttachmentReference | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("payload.planAttachment must be an object.");
  const reference = value as Record<string, unknown>;
  assertOnlyFields(reference, AGENT_SEND_FIELD_NAMES.planAttachment, "payload.planAttachment");
  if (type !== "image" && type !== "file") {
    throw new Error("payload.planAttachment is only supported for image or file payloads.");
  }
  if (!fallback.path && !fallback.url && !Object.prototype.hasOwnProperty.call(reference, "attachmentId")) {
    throw new Error("payload.planAttachment requires payload.planAttachment.attachmentId.");
  }
  const planId = textValue(reference.planId, "payload.planAttachment.planId") as string;
  const attachmentId = textValue(reference.attachmentId, "payload.planAttachment.attachmentId") as string;
  if (planId.length > AGENT_SEND_LIMITS.planId || /[\u0000-\u001f\u007f]/.test(planId)) {
    throw new Error("payload.planAttachment.planId must be a stable plan id.");
  }
  if (attachmentId.length > AGENT_SEND_LIMITS.attachmentId || /[\u0000-\u001f\u007f]/.test(attachmentId)) {
    throw new Error("payload.planAttachment.attachmentId must be a stable attachment id.");
  }
  const roleId = textValue(reference.roleId, "payload.planAttachment.roleId", false);
  return { ...(roleId ? { roleId } : {}), planId, attachmentId };
}

function payloadFields(payload: Record<string, unknown>, channel: AgentSendChannel): Pick<AgentReplyRequest, "payload" | "payloadType" | "text"> {
  assertOnlyFields(payload, AGENT_SEND_FIELD_NAMES.payload, "payload");
  const type = textValue(payload.type, "payload.type") as typeof AGENT_SEND_PAYLOAD_TYPES[number];
  if (!(AGENT_SEND_PAYLOAD_TYPES as readonly string[]).includes(type)) {
    throw new Error("payload.type must be text, image, voice, file, markdown, or sticker.");
  }
  if (type === "sticker") {
    assertOnlyFields(payload, AGENT_SEND_FIELD_NAMES.sticker, "payload");
    if (channel !== "napcat" || typeof payload.stickerId !== "string" || !/^[a-f0-9]{32}$/.test(payload.stickerId)) {
      throw new Error("payload.type=sticker requires channel=napcat and a stickerId from the selected account's sticker list.");
    }
    const text = textValue(payload.text, "payload.text", false);
    return { payloadType: "image", text, payload: { type: "sticker", stickerId: payload.stickerId, ...(text ? { text } : {}) } };
  }
  if (Object.prototype.hasOwnProperty.call(payload, "stickerId")) throw new Error("payload.stickerId requires payload.type=sticker.");
  if (type === "markdown") {
    if (channel !== "napcat" || ["path", "url", "fileName", "fileId", "fileSha256", "planAttachment", "segments"].some(key => Object.prototype.hasOwnProperty.call(payload, key))) {
      throw new Error("payload.type=markdown requires channel=napcat and payload.text only.");
    }
    const validatedText = textValue(payload.text, "payload.text") as string;
    const text = typeof payload.text === "string" ? payload.text : validatedText;
    checkMarkdownQuota("RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES", markdownImageSettings.sourceBytes, Buffer.byteLength(text, "utf8"));
    return { payloadType: "image", text, payload: { type: "markdown", text } };
  }
  if (Object.prototype.hasOwnProperty.call(payload, "segments")) {
    if (channel !== "napcat" || type !== "image") {
      throw new Error("payload.segments requires channel=napcat and payload.type=image.");
    }
    if (["text", "path", "url", "fileName", "fileId", "fileSha256", "planAttachment"].some(key => Object.prototype.hasOwnProperty.call(payload, key))) {
      throw new Error("payload.segments cannot be combined with top-level media or text fields.");
    }
    if (!Array.isArray(payload.segments) || payload.segments.length === 0) {
      throw new Error("payload.segments must contain at least one ordered text/image/markdown segment.");
    }
    checkMarkdownQuota("RABIROUTE_AGENT_SEND_MAX_SEGMENTS", agentSendQuotaSettings.segments, payload.segments.length);
    let imageCount = 0;
    const segments = payload.segments.map((raw, index) => {
      const label = `payload.segments[${index}]`;
      const segment = objectValue(raw, label);
      const segmentType = textValue(segment.type, `${label}.type`);
      if (segmentType === "text") {
        assertOnlyFields(segment, AGENT_SEND_FIELD_NAMES.textSegment, label);
        const segmentText = textValue(segment.text, `${label}.text`) as string;
        return { type: "text" as const, text: typeof segment.text === "string" ? segment.text : segmentText };
      }
      if (segmentType === "markdown") {
        assertOnlyFields(segment, AGENT_SEND_FIELD_NAMES.textSegment, label);
        const segmentText = textValue(segment.text, `${label}.text`) as string;
        const text = typeof segment.text === "string" ? segment.text : segmentText;
        checkMarkdownQuota("RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES", markdownImageSettings.sourceBytes, Buffer.byteLength(text, "utf8"));
        imageCount++;
        return { type: "markdown" as const, text };
      }
      if (segmentType === "image") {
        assertOnlyFields(segment, AGENT_SEND_FIELD_NAMES.imageSegment, label);
        const hasPath = Object.prototype.hasOwnProperty.call(segment, "path");
        const hasUrl = Object.prototype.hasOwnProperty.call(segment, "url");
        if (hasPath === hasUrl) throw new Error(`${label} requires exactly one of path or url.`);
        const file = textValue(hasPath ? segment.path : segment.url, `${label}.${hasPath ? "path" : "url"}`) as string;
        imageCount++;
        return hasPath ? { type: "image" as const, path: file } : { type: "image" as const, url: file };
      }
      throw new Error(`${label}.type must be text, image, or markdown.`);
    });
    if (imageCount === 0) throw new Error("payload.segments requires at least one image or Markdown segment.");
    checkMarkdownQuota("RABIROUTE_AGENT_SEND_MAX_IMAGES", agentSendQuotaSettings.images, imageCount);
    const text = segments.filter((segment): segment is Extract<typeof segment, { type: "text" | "markdown" }> => segment.type === "text" || segment.type === "markdown")
      .map(segment => segment.text).join("\n");
    return { payloadType: "image", text, payload: { type: "image", text, segments } };
  }
  const validatedText = textValue(payload.text, "payload.text", type === "text");
  // Validation rejects empty input; message whitespace belongs to the sender.
  const text = validatedText && typeof payload.text === "string" ? payload.text : validatedText;
  const path = textValue(payload.path, "payload.path", false);
  const url = textValue(payload.url, "payload.url", false);
  const planAttachment = planAttachmentReference(payload.planAttachment, type, { path, url });
  if (planAttachment && (path || url)) {
    throw new Error("payload.planAttachment cannot be combined with payload.path or payload.url.");
  }
  const hasFileId = Object.prototype.hasOwnProperty.call(payload, "fileId");
  const fileId = hasFileId ? payload.fileId : undefined;
  if (hasFileId) {
    if (typeof fileId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId)) {
      throw new Error("payload.fileId must be a UUID.");
    }
    if (type !== "file") throw new Error("payload.fileId is only supported for file payloads.");
    if (planAttachment || ["path", "url", "fileName"].some(key => Object.prototype.hasOwnProperty.call(payload, key))) {
      throw new Error("payload.fileId cannot be combined with payload.path, payload.url, payload.fileName, or payload.planAttachment.");
    }
  }
  const fileSha256 = payload.fileSha256;
  if (hasFileId && (typeof fileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(fileSha256))) {
    throw new Error("payload.fileSha256 must be 64 lowercase hexadecimal characters when payload.fileId is provided.");
  }
  if (!hasFileId && Object.prototype.hasOwnProperty.call(payload, "fileSha256")) {
    throw new Error("payload.fileSha256 requires payload.fileId.");
  }
  if (type !== "text" && !path && !url && !fileId && !planAttachment) {
    throw new Error(`${type} payload requires payload.path or payload.url or payload.fileId or payload.planAttachment.`);
  }
  return {
    payloadType: type,
    text,
    payload: {
      type,
      text,
      path,
      url,
      fileName: textValue(payload.fileName, "payload.fileName", false),
      ...(planAttachment ? { planAttachment } : {}),
      ...(hasFileId ? { fileId, fileSha256 } : {})
    }
  };
}

function normalizeAgentSend(request: AgentSendRequest): NormalizedAgentSend {
  assertOnlyFields(request as Record<string, unknown>, AGENT_SEND_FIELD_NAMES.request, "request");
  const deliveryId = textValue(request.deliveryId, "deliveryId") as string;
  const sender = senderValue(request.sender);
  const routeId = textValue(request.routeId, "routeId") as string;
  const requestedChannel = textValue(request.channel, "channel") as AgentSendChannel;
  // @deprecated Read old serialized sends through speech; remove at the legacy configuration migration milestone.
  const channel = requestedChannel === "fennenote" ? "speech" : requestedChannel;
  const channelHelp = agentSendChannelHelp(channel);
  if (!channelHelp) {
    const supportedChannels = AGENT_SEND_CHANNEL_HELP.map(item => item.channel);
    const error = new Error(`Unsupported send channel: ${channel}. Use one of: ${supportedChannels.join(", ")}. QQ/NapCat uses channel=napcat, not channel=qq.`);
    Object.assign(error, { code: "UNSUPPORTED_SEND_CHANNEL", supportedChannels, help: AGENT_SEND_CHANNEL_HELP, repair: "Use channel=napcat for QQ/NapCat and copy the matching params example. Do not retry with a different deliveryId unless the receipt is confirmed absent." });
    throw error;
  }
  const params = { ...objectValue(request.params, "params") };
  const rawPayload = objectValue(request.payload, "payload");
  const payload = payloadFields(rawPayload, channel);
  if (Object.prototype.hasOwnProperty.call(rawPayload, "fileId") && (channel !== "napcat" || params.target !== "group")) {
    throw new Error("payload.fileId requires channel=napcat and params.target=group.");
  }
  const tracking = objectValue(request.tracking, "tracking", false);
  const styleValidation = normalizeStyleValidationMode(request.styleValidation);
  const messageLengthConfirmation = request.messageLengthConfirmation;
  if (messageLengthConfirmation != null && (typeof messageLengthConfirmation !== "string" || !/^\d{13}\.[a-f0-9]{64}$/.test(messageLengthConfirmation))) {
    throw new Error("messageLengthConfirmation must be the token returned by the length check.");
  }
  const context = request.conversationContext == null ? undefined : objectValue(request.conversationContext, "conversationContext");
  if (context) {
    assertOnlyFields(context, AGENT_SEND_FIELD_NAMES.conversationContext, "conversationContext");
    for (const field of AGENT_SEND_FIELD_NAMES.conversationContext) {
      if (context[field] != null && (typeof context[field] !== "string" || !context[field] || String(context[field]).length > AGENT_SEND_LIMITS.conversationToken)) {
        throw new Error(`conversationContext.${field} must be a non-empty index/token returned by Rabi.`);
      }
    }
  }
  assertOnlyFields(tracking, AGENT_SEND_FIELD_NAMES.tracking, "tracking");
  const requirementId = textValue(tracking.requirementId, "tracking.requirementId", false);
  const replyContext: Record<string, unknown> = requirementId
    ? { messageProcessingRequirementId: requirementId }
    : {};
  const internal: AgentReplyRequest = {
    ...payload,
    deliveryId,
    senderAgentType: sender.agentType,
    senderSessionId: sender.sessionId,
    routeProfileId: routeId,
    explicitTarget: true,
    sendChannel: channel,
    replyContext
  };
  let allowAdditionalReply = false;
  let replyImageDescriptions: string[] = [];
  let target: Record<string, unknown>;

  if (requestedChannel === "fennenote") {
    if (params.mode !== "message" && params.mode !== "playback") throw new Error("params.mode must be message or playback for the retired fennenote alias.");
    delete params.mode;
  }
  assertOnlyFields(params, Object.keys(channelHelp.params), "params");
  if (channel === "napcat") {
    const targetType = textValue(params.target, "params.target") as "group" | "private";
    if (targetType !== "group" && targetType !== "private") throw new Error("params.target must be group or private for napcat.");
    const groupId = targetType === "group" ? textValue(params.groupId, "params.groupId") : undefined;
    const userId = targetType === "private" ? textValue(params.userId, "params.userId") : undefined;
    const hasReplyToMessageId = Object.prototype.hasOwnProperty.call(params, "replyToMessageId");
    if (targetType === "group" && !hasReplyToMessageId) {
      throw new Error(
        "NapCat group sends must include params.replyToMessageId. "
        + "Use the source QQ message ID whenever the message can be quoted, "
        + "or pass an empty string (\"\") for an intentional unquoted group message."
      );
    }
    if (hasReplyToMessageId && typeof params.replyToMessageId !== "string" && typeof params.replyToMessageId !== "number") {
      throw new Error("params.replyToMessageId must be a QQ message ID string/number, or an empty string for an intentional unquoted group message.");
    }
    const replyToMessageId = textValue(params.replyToMessageId, "params.replyToMessageId", false);
    replyImageDescriptions = stringList(params.replyImageDescriptions, "params.replyImageDescriptions");
    allowAdditionalReply = booleanValue(params.allowAdditionalReply, "params.allowAdditionalReply");
    if (targetType === "group" && sender.agentType === "message_processing" && !replyToMessageId) {
      throw new Error("message_processing NapCat group sends require a non-empty params.replyToMessageId so the reply stays attached to its source message.");
    }
    target = { target: targetType, groupId, userId, instanceId: textValue(params.instanceId, "params.instanceId", false), replyToMessageId };
    Object.assign(internal, {
      adapterType: "napcat",
      targetType,
      groupId,
      userId,
      instanceId: target.instanceId,
      messageId: replyToMessageId
    });
    Object.assign(replyContext, { replyToSource: Boolean(replyToMessageId) });
  } else if (channel === "wecom") {
    const chatId = textValue(params.chatId, "params.chatId") as string;
    target = { chatId, userId: textValue(params.userId, "params.userId", false) };
    Object.assign(internal, { adapterType: "wecom", targetType: "group", groupId: chatId, wecomChatId: chatId, userId: target.userId, wecomReqId: textValue(params.reqId, "params.reqId", false) });
  } else if (channel === "feishu") {
    const chatId = textValue(params.chatId, "params.chatId") as string;
    target = { chatId, userId: textValue(params.userId, "params.userId", false) };
    Object.assign(internal, { adapterType: "feishu", targetType: "group", groupId: chatId, feishuChatId: chatId, userId: target.userId });
  } else if (channel === "weixin") {
    const sessionId = textValue(params.sessionId, "params.sessionId") as string;
    target = { sessionId, userId: textValue(params.userId, "params.userId", false) };
    Object.assign(internal, { adapterType: "weixin", targetType: "private", userId: target.userId ?? sessionId, weixinSessionId: sessionId, sessionId });
  } else if (channel === "rabilink") {
    const proactive = booleanValue(params.proactive, "params.proactive");
    const sourceMessageId = textValue(params.sourceMessageId, "params.sourceMessageId", false);
    const targetDeviceIds = stringList(params.targetDeviceIds, "params.targetDeviceIds");
    const targetDeviceKinds = stringList(params.targetDeviceKinds, "params.targetDeviceKinds");
    if (!proactive && !sourceMessageId) throw new Error("RabiLink non-proactive sends require params.sourceMessageId.");
    if (targetDeviceIds.length === 0 && targetDeviceKinds.length === 0) {
      throw new Error("RabiLink sends require params.targetDeviceIds or params.targetDeviceKinds.");
    }
    target = { proactive, sourceMessageId, targetDeviceIds, targetDeviceKinds };
    Object.assign(internal, {
      adapterType: "rabilink",
      targetType: "rabilink",
      messageId: sourceMessageId,
      proactive,
      source: textValue(params.source, "params.source", false),
      targetDeviceIds,
      targetDeviceKinds,
      presentation: stringList(params.presentation, "params.presentation"),
      priority: textValue(params.priority, "params.priority", false)
    });
  } else if (channel === "speech") {
    const sessionId = textValue(params.sessionId, "params.sessionId", false);
    target = { sessionId };
    Object.assign(internal, { adapterType: "speech", targetType: "voice_transcript", sessionId });
    Object.assign(replyContext, { adapterType: "speech", sessionId, characterTtsDialogue: true });
  } else if (channel === "role_panel") {
    const roleId = textValue(params.roleId, "params.roleId") as string;
    target = { roleId, messageId: textValue(params.messageId, "params.messageId", false) };
    Object.assign(internal, { adapterType: "rolePanel", targetType: "role_panel", roleId, messageId: target.messageId });
    Object.assign(replyContext, { targetType: "role_panel", roleId });
  } else if (channel === "plan_feedback") {
    const roleId = textValue(params.roleId, "params.roleId") as string;
    const planId = textValue(params.planId, "params.planId") as string;
    const kind = textValue(params.kind, "params.kind") as "guidance" | "approval";
    if (kind !== "guidance" && kind !== "approval") throw new Error("params.kind must be guidance or approval for plan_feedback.");
    target = { roleId, planId, stepId: textValue(params.stepId, "params.stepId", false), feedbackId: textValue(params.feedbackId, "params.feedbackId", false), kind };
    Object.assign(internal, { adapterType: "planFeedback", targetType: "plan_feedback", roleId });
    Object.assign(replyContext, {
      targetType: "plan_feedback",
      roleId,
      planId,
      stepId: target.stepId,
      planFeedbackId: target.feedbackId,
      planFeedbackKind: kind
    });
  } else {
    const unhandledChannel: never = channel;
    throw new Error(`Send channel has no normalizer: ${unhandledChannel}`);
  }

  return { deliveryId, sender, routeId, channel, allowAdditionalReply, replyImageDescriptions, target, styleValidation, messageLengthConfirmation: messageLengthConfirmation ?? undefined,
    conversationContext: context as NormalizedAgentSend["conversationContext"], internal };
}

export function prepareAgentSendRequest(request: AgentSendRequest): NormalizedAgentSend {
  return normalizeAgentSend(request);
}

/** Shared owner mapping. Extra outer receipt metadata cannot be inferred from history. */
export function mapAgentSendReplyResult(result: AgentReplyResult, request: Readonly<AgentSendRequest>): AgentSendResult {
  const normalized = normalizeAgentSend(request);
  return { ...result, deliveryId: normalized.deliveryId, sender: normalized.sender,
    channel: normalized.channel, routeId: normalized.routeId, target: normalized.target };
}

export async function inspectAgentSendDelivery(
  request: AgentSendRequest,
  options: AgentReplyOptions
): Promise<AgentSendDeliveryInspection> {
  const normalized = normalizeAgentSend(request);
  const inspection = await inspectAgentReplyDelivery(normalized.internal, options);
  if (inspection.state !== "completed") return inspection;
  return { state: "completed", result: mapAgentSendReplyResult(inspection.result, request) };
}

function replyImageDescriptionPlan(
  normalized: NormalizedAgentSend,
  options: AgentReplyOptions,
  reviewedSource?: ReviewedReplySourceEvidence
): ReplyImageDescriptionPlan | undefined {
  return prepareReplyImageDescriptions({
    deliveryId: normalized.deliveryId,
    sender: normalized.sender,
    routeId: normalized.routeId,
    channel: normalized.channel,
    target: normalized.target,
    replyImageDescriptions: normalized.replyImageDescriptions
  }, options, reviewedSource);
}

export function validateAgentSendReplyImageDescriptions(
  request: AgentSendRequest,
  options: AgentReplyOptions,
  reviewedSource?: ReviewedReplySourceEvidence
): void {
  replyImageDescriptionPlan(normalizeAgentSend(request), options, reviewedSource);
}

export async function handleAgentSend(
  request: AgentSendRequest,
  options: AgentReplyOptions,
  reviewedSource?: ReviewedReplySourceEvidence
): Promise<AgentSendResult> {
  const normalized = normalizeAgentSend(request);
  const imageDescriptionPlan = replyImageDescriptionPlan(normalized, options, reviewedSource);
  const result = await handleAgentReply(normalized.internal, options);
  const replyImageDescriptionArchive = result.status === "sent" && imageDescriptionPlan
    ? archiveReplyImageDescriptions(imageDescriptionPlan, {
        rootDir: options.rootDir,
        sentMessageId: result.sentMessageId
      })
    : undefined;
  return {
    ...mapAgentSendReplyResult(result, request),
    replyImageDescriptionArchive
  };
}
