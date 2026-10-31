import { ReadSettingsError } from "./shared/readSettingsError.js";
import { markdownImageSettings } from "./markdownImage.js";

// Only trusted built-in descriptors enter this registry; help never grants Route authority.
function freezeChannelHelp<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeChannelHelp(child);
    Object.freeze(value);
  }
  return value;
}

export type AgentSendChannelHelp = Readonly<{
  channel: AgentSendChannel;
  description: string;
  params: Readonly<Record<string, unknown>>;
  example: Readonly<Record<string, unknown>>;
}>;

export const AGENT_SEND_CHANNEL_HELP = freezeChannelHelp([
  { channel: "napcat", description: "QQ 群聊或私聊；支持 Markdown 渲染成图片；QQ 不使用 channel=qq。", params: { target: "group|private", groupId: "群号（group 时必填）", userId: "QQ 号（private 时必填）", instanceId: "NapCat 实例 ID（可选）", replyToMessageId: "来源 QQ 消息 ID；群聊必填，可传空字符串表示不引用", replyImageDescriptions: "引用图片的描述字符串数组（可选；图片引用仍受下游要求约束）", allowAdditionalReply: "是否允许追加回复（可选布尔值，默认 false）" }, example: { channel: "napcat", params: { target: "group", groupId: "example-group-id", replyToMessageId: "example-message-id" }, payload: { type: "text", text: "消息正文" } } },
  { channel: "wecom", description: "企业微信会话。", params: { chatId: "会话 ID", userId: "用户 ID（可选）", reqId: "请求 ID（可选）" }, example: { channel: "wecom", params: { chatId: "chat-id" }, payload: { type: "text", text: "消息正文" } } },
  { channel: "weixin", description: "微信会话。", params: { sessionId: "会话 ID", userId: "用户 ID（可选）" }, example: { channel: "weixin", params: { sessionId: "session-id" }, payload: { type: "text", text: "消息正文" } } },
  { channel: "feishu", description: "飞书会话。", params: { chatId: "会话 ID", userId: "用户 ID（可选）" }, example: { channel: "feishu", params: { chatId: "chat-id" }, payload: { type: "text", text: "消息正文" } } },
  { channel: "rabilink", description: "RabiLink 设备消息。", params: { proactive: "是否主动发送", sourceMessageId: "非主动发送时的来源消息 ID", targetDeviceIds: "设备 ID 数组", targetDeviceKinds: "设备类型数组", source: "来源标识（可选）", presentation: "呈现方式字符串数组（可选）", priority: "优先级（可选）" }, example: { channel: "rabilink", params: { proactive: true, targetDeviceIds: ["device-id"] }, payload: { type: "text", text: "消息正文" } } },
  { channel: "speech", description: "语音消息。", params: { sessionId: "语音会话 ID（可选）" }, example: { channel: "speech", params: { sessionId: "session-id" }, payload: { type: "text", text: "消息正文" } } },
  { channel: "role_panel", description: "人格面板消息。", params: { roleId: "人格 ID", messageId: "消息 ID（可选）" }, example: { channel: "role_panel", params: { roleId: "role-id" }, payload: { type: "text", text: "消息正文" } } },
  { channel: "plan_feedback", description: "计划 guidance 或 approval 反馈。", params: { roleId: "人格 ID", planId: "计划 ID", kind: "guidance|approval", stepId: "步骤 ID（可选）", feedbackId: "反馈 ID（可选）" }, example: { channel: "plan_feedback", params: { roleId: "role-id", planId: "plan-id", kind: "guidance" }, payload: { type: "text", text: "反馈正文" } } }
] as const);

/** @deprecated The fennenote wire alias migrates to speech; remove at the legacy configuration migration milestone. */
export type AgentSendChannel = typeof AGENT_SEND_CHANNEL_HELP[number]["channel"] | "fennenote";

function createAgentSendQuotaSettings(env: NodeJS.ProcessEnv = process.env) {
  const quota = (name: string) => {
    const value = Number(env[name]?.trim() || 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new ReadSettingsError(name, "must be a nonnegative safe integer; 0 removes the application quota.");
    return value;
  };
  return Object.freeze({ get segments() { return quota("RABIROUTE_AGENT_SEND_MAX_SEGMENTS"); }, get images() { return quota("RABIROUTE_AGENT_SEND_MAX_IMAGES"); } });
}
export function readAgentSendQuotaSettings(env: NodeJS.ProcessEnv = process.env) {
  const settings = createAgentSendQuotaSettings(env); Object.values(settings); return settings;
}
export const agentSendQuotaSettings = createAgentSendQuotaSettings();
// Help reports malformed settings without disabling unrelated operations.
function quotaDescription(read: () => number): string {
  try { return String(read()); } catch (error) {
    if (error instanceof ReadSettingsError) return "invalid (repair this environment setting)";
    throw error;
  }
}
export const AGENT_SEND_LIMITS = Object.freeze({
  agentType: 80, sessionId: 500, planId: 200, attachmentId: 200, conversationToken: 512 });
export const AGENT_SEND_PAYLOAD_TYPES = ["text", "image", "voice", "file", "markdown", "sticker"] as const;

// Wire text retains the established String(value).trim() normalization. The owner
// validates normalized identifiers and byte lengths; no client-side coercion is assumed.
const optionalText = { description: "Optional value normalized by the server with String(value).trim(); null and empty text mean absent." } as const;
const requiredText = { anyOf: [{ type: "string", pattern: "\\S" }, { type: "number" }, { type: "boolean" }, { type: "array" }, { type: "object" }],
  description: "Required nonempty server-normalized text; see agent.send.normalize-text." } as const;
const normalizedName = (names: readonly string[]) => ({ anyOf: [{ type: "string", pattern: `^\\s*(?:${names.join("|")})\\s*$` }, { type: "array" }] });
const sender = { type: "object", required: ["agentType", "sessionId"], additionalProperties: false,
  properties: { agentType: requiredText, sessionId: requiredText } } as const;
const planAttachment = { type: "object", required: ["planId", "attachmentId"], additionalProperties: false,
  properties: { roleId: optionalText, planId: requiredText, attachmentId: requiredText } } as const;
const textSegment = { type: "object", required: ["type", "text"], additionalProperties: false,
  properties: { type: normalizedName(["text", "markdown"]), text: requiredText } } as const;
const imageSegment = { type: "object", required: ["type"], additionalProperties: false,
  properties: { type: normalizedName(["image"]), path: requiredText, url: requiredText },
  oneOf: [{ required: ["path"], properties: { path: true } }, { required: ["url"], properties: { url: true } }] } as const;
const stickerPayload = { type: "object", required: ["type", "stickerId"], additionalProperties: false,
  properties: { type: normalizedName(["sticker"]), text: optionalText, stickerId: { type: "string", pattern: "^[a-f0-9]{32}$" } } } as const;
const tracking = { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
  properties: { requirementId: optionalText, sendContextReviewToken: optionalText } }] } as const;
const conversationContext = { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, properties: {
  lastReadMessageIndex: { anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: AGENT_SEND_LIMITS.conversationToken }] },
  confirmationToken: { anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: AGENT_SEND_LIMITS.conversationToken }] }
} }] } as const;
const hasPayload = (field: string) => ({ properties: { payload: { type: "object", required: [field], properties: { [field]: true } } }, required: ["payload"] });
const rawName = (name: string) => ({ type: "string", pattern: `^\\s*${name}\\s*$` });
const payloadType = (name: string) => ({ properties: { payload: { type: "object", required: ["type"], properties: { type: rawName(name) } } }, required: ["payload"] });
const payload = {
  type: "object", required: ["type"], additionalProperties: false,
  properties: {
    type: normalizedName(AGENT_SEND_PAYLOAD_TYPES), text: optionalText, path: optionalText, url: optionalText, fileName: optionalText,
    fileId: { type: "string", pattern: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$" },
    fileSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, planAttachment: { anyOf: [{ type: "null" }, planAttachment] },
    segments: { type: "array", minItems: 1, items: { oneOf: [textSegment, imageSegment] },
      allOf: [{ if: { items: { type: "object", required: ["type"], properties: { type: { type: "string" } } } },
        then: { contains: { type: "object", required: ["type"], properties: { type: rawName("(?:image|markdown)") } }, minContains: 1 } }] },
    stickerId: stickerPayload.properties.stickerId
  },
  dependentRequired: { fileId: ["fileSha256"], fileSha256: ["fileId"] }
} as const;

function channelParams(channel: AgentSendChannel) {
  const definition = AGENT_SEND_CHANNEL_HELP.find(value => value.channel === channel)!;
  const properties = Object.fromEntries(Object.entries(definition.params).map(([name, description]) => [name,
    ["proactive", "allowAdditionalReply"].includes(name) ? { anyOf: [{ type: "boolean" }, { type: "null" }], description }
      : ["replyImageDescriptions", "targetDeviceIds", "targetDeviceKinds", "presentation"].includes(name)
        ? { anyOf: [{ type: "null" }, { type: "array", items: requiredText }], description }
        : { ...optionalText, description }]));
  return { type: "object", properties, additionalProperties: false };
}

export const AGENT_SEND_WIRE_SCHEMA = freezeChannelHelp({
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  required: ["deliveryId", "sender", "routeId", "channel", "params", "payload"],
  properties: { deliveryId: requiredText, sender, routeId: requiredText, channel: normalizedName([...AGENT_SEND_CHANNEL_HELP.map(value => value.channel), "fennenote"]),
    params: { type: "object" }, payload, tracking, styleValidation: { anyOf: [{ type: "null" }, { enum: [0, 1] }] },
    messageLengthConfirmation: { anyOf: [{ type: "null" }, { type: "string", pattern: "^[0-9]{13}\\.[a-f0-9]{64}$" }] }, conversationContext },
  allOf: [
    // @deprecated Wire-only migration alias; remove at the legacy configuration migration milestone.
    { if: { required: ["channel"], properties: { channel: rawName("fennenote") } },
      then: { properties: { params: { type: "object", additionalProperties: false, required: ["sessionId", "mode"],
        properties: { sessionId: requiredText, mode: normalizedName(["message", "playback"]) } } } } },
    ...AGENT_SEND_CHANNEL_HELP.map(definition => ({
      if: { required: ["channel"], properties: { channel: rawName(definition.channel) } },
      then: { properties: { params: channelParams(definition.channel) } }
    })),
    { if: hasPayload("fileId"), then: { properties: { channel: normalizedName(["napcat"]),
      params: { type: "object", required: ["target"], properties: { target: { const: "group" } } },
      payload: { type: "object", properties: { type: normalizedName(["file"]), path: false, url: false, fileName: false, planAttachment: { type: "null" } } } } } },
    { if: payloadType("sticker"), then: { properties: { channel: normalizedName(["napcat"]), payload: stickerPayload } },
      else: { properties: { payload: { type: "object", properties: { stickerId: false } } } } },
    { if: payloadType("markdown"), then: { properties: { channel: normalizedName(["napcat"]), payload: { type: "object", required: ["text"], properties: {
      text: requiredText, path: false, url: false, fileName: false, fileId: false, fileSha256: false, planAttachment: false, segments: false
    } } } } },
    { if: hasPayload("segments"), then: { properties: { channel: normalizedName(["napcat"]), payload: { type: "object", properties: {
      type: normalizedName(["image"]), text: false, path: false, url: false, fileName: false, fileId: false, fileSha256: false, planAttachment: false
    } } } } }
  ]
} as const);

export const AGENT_SEND_FIELD_NAMES = freezeChannelHelp({
  request: Object.keys(AGENT_SEND_WIRE_SCHEMA.properties), sender: Object.keys(sender.properties), payload: Object.keys(payload.properties),
  planAttachment: Object.keys(planAttachment.properties), tracking: Object.keys(tracking.anyOf[1].properties),
  conversationContext: Object.keys(conversationContext.anyOf[1].properties), textSegment: Object.keys(textSegment.properties),
  imageSegment: Object.keys(imageSegment.properties), sticker: Object.keys(stickerPayload.properties)
});

export const AGENT_SEND_BUSINESS_VALIDATORS = freezeChannelHelp([
  { id: "agent.send.normalize-text", description: "The send owner normalizes established text values with String(value).trim(); it then checks required values, stable sender/session identifiers, plan attachment identifiers, and nonempty device lists. Null/empty optional text means absent." },
  { id: "agent.send.channel-target", description: "NapCat requires target=group|private, the matching groupId/userId, and an explicit replyToMessageId for groups. message_processing group replies require a nonempty quote. WeCom/Feishu require chatId; Weixin requires sessionId. The deprecated fennenote wire alias is migrated to speech. role_panel requires roleId; plan_feedback requires roleId/planId and kind=guidance|approval. RabiLink requires target devices and, unless proactive=true, sourceMessageId." },
  { id: "agent.send.media", description: "Text requires nonempty text. Other media require a path, URL or supported managed reference. planAttachment applies only to image/file and cannot coexist with a nonempty path/URL. Managed fileId requires NapCat target=group and lowercase SHA-256; private managed-file upload is not implemented. Markdown is NapCat-only. Ordered segments require at least one item and one image/markdown item, without top-level text/media. Quotas are enforced by the send owner so errors identify the configured Manager environment setting; the wire schema validates only protocol shape." },
  { id: "agent.send.quotas", description: `Current Manager quotas: RABIROUTE_AGENT_SEND_MAX_SEGMENTS=${quotaDescription(() => agentSendQuotaSettings.segments)} (ordered items); RABIROUTE_AGENT_SEND_MAX_IMAGES=${quotaDescription(() => agentSendQuotaSettings.images)} (image/markdown items); RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES=${quotaDescription(() => markdownImageSettings.sourceBytes)} (UTF-8 bytes per Markdown source, shared with the renderer). All default to 0, meaning unlimited by the application. Change or remove the environment setting and reload Manager to update; provider/runtime limits remain visible.` },
  { id: "agent.send.identity-and-state", description: "The existing owner verifies request source, Route/provider configuration, file ownership and integrity, platform support, message policy, and current delivery state. These are execution correctness checks on the authenticated connection, not another feature grant." },
  { id: "agent.send.idempotency", description: "The durable delivery owner requires a stable deliveryId of at most 200 ASCII letters/digits/._:-. Keep the complete original request and ID; after timeout, failure, generation change or uncertainty read the original receipt before any further send." }
] as const);

/** The public projection is the same executable wire schema, with owner-only rules named explicitly. */
export const AGENT_SEND_REQUEST_CONTRACT = freezeChannelHelp({ version: 2, kind: "runtime-json-schema",
  schema: AGENT_SEND_WIRE_SCHEMA, validators: AGENT_SEND_BUSINESS_VALIDATORS
} as const);
