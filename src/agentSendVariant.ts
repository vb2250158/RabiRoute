import { AsyncLocalStorage } from "node:async_hooks";
import type {
  MessageEndpointEgressProvider, MessageEndpointSendVariant, MessageEndpointVariantSendInput, MessageEndpointVariantSendOutcome,
  MessageEndpointVariantMedia, MessageEndpointVariantMediaKind, MessageEndpointVariantAttachment, MessageEndpointVariantReceiptMode
} from "@rabiroute/plugin-sdk";
import type { AgentSendRequest } from "./agentSend.js";
import { AGENT_SEND_VARIANT_TYPE } from "./agentSendContracts.js";
import { compilePluginDataSchema } from "./manager/apiOperationContract.js";

const variantType = new RegExp(AGENT_SEND_VARIANT_TYPE);
const validators = new WeakMap<MessageEndpointSendVariant, Readonly<{
  data: ReturnType<typeof compilePluginDataSchema>;
  params: ReturnType<typeof compilePluginDataSchema>;
}>>();

type VariantReceipt = Readonly<{
  type: string;
  contractVersion: number;
  packageId: string;
  version: string;
  packageHash: string;
  activationId: string;
  receiptMode: MessageEndpointVariantReceiptMode;
}>;

export type AgentSendVariant = Readonly<{
  channel: string;
  deliveryId: string;
  text: string;
  mediaKinds: readonly MessageEndpointVariantMediaKind[];
  attachments: readonly MessageEndpointVariantAttachment[];
  receipt: VariantReceipt;
  send(input: Omit<MessageEndpointVariantSendInput, "data">): Promise<MessageEndpointVariantSendOutcome>;
}>;

const mediaKind = { enum: ["image", "voice", "file"] } as const;
const managedFile = { type: "object", additionalProperties: false, required: ["kind", "fileId", "fileSha256"], properties: {
  kind: mediaKind, fileId: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" },
  fileSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }
} } as const;
const planAttachment = { type: "object", additionalProperties: false, required: ["kind", "planAttachment"], properties: {
  kind: { enum: ["image", "file"] }, planAttachment: { type: "object", additionalProperties: false,
    required: ["planId", "attachmentId"], properties: {
      planId: { type: "string", pattern: "\\S" }, attachmentId: { type: "string", pattern: "\\S" }, roleId: { type: "string", pattern: "\\S" }
    } }
} } as const;
const validateMedia = compilePluginDataSchema({ type: "object", additionalProperties: false, properties: {
  kinds: { type: "array", items: mediaKind }, attachments: { type: "array", items: { oneOf: [managedFile, planAttachment] } }
} });

/** Validate positive evidence, after external execution and before writing a terminal receipt. */
export function variantNativeMessageId(value: unknown): string | undefined {
  const id = typeof value === "string" || Number.isSafeInteger(value) ? String(value).trim() : "";
  return id && !/^[-+]?0+$/.test(id) ? id : undefined;
}

function requireVariantOutcome(result: unknown, mode: MessageEndpointVariantReceiptMode): MessageEndpointVariantSendOutcome {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const value = result as Partial<MessageEndpointVariantSendOutcome> & { acknowledged?: unknown };
    if (mode === "ack-only" && value.acknowledged === true && !Object.hasOwn(value, "messageId")) {
      return { acknowledged: true, target: value.target };
    }
    const messageId = variantNativeMessageId(value.messageId);
    if (mode === "message" && !Object.hasOwn(value, "acknowledged") && messageId) {
      return { messageId, target: value.target, conversationKey: "conversationKey" in value ? value.conversationKey : undefined };
    }
  }
  throw new Error(mode === "ack-only"
    ? "The endpoint returned no valid native acknowledgement."
    : "The endpoint returned no valid native message ID.");
}

const sendScope = new AsyncLocalStorage<AgentSendVariant>();

export function agentSendVariantType(request: Pick<AgentSendRequest, "payload">): string | undefined {
  const type = (request.payload as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.length <= 100 && variantType.test(type) ? type : undefined;
}

export function scopedAgentSendVariant(request: AgentSendRequest): AgentSendVariant | undefined {
  const variant = sendScope.getStore();
  if (!variant || variant.receipt.type !== agentSendVariantType(request)
    || variant.channel !== String(request.channel ?? "").trim() || variant.deliveryId !== String(request.deliveryId ?? "").trim()) return undefined;
  return variant;
}

export function prepareAgentSendVariant(definition: MessageEndpointSendVariant): void {
  if (validators.has(definition)) return;
  if (definition.receiptMode !== undefined && definition.receiptMode !== "message" && definition.receiptMode !== "ack-only") {
    throw new Error("Invalid send variant receipt mode.");
  }
  validators.set(definition, { data: compilePluginDataSchema(definition.dataSchema), params: compilePluginDataSchema(definition.paramsSchema) });
}

export async function withAgentSendVariant<T>(request: AgentSendRequest, provider: MessageEndpointEgressProvider | undefined,
  operation: (variant: AgentSendVariant) => Promise<T>): Promise<T> {
  const type = agentSendVariantType(request)!;
  const channel = String(request.channel ?? "").trim();
  const deliveryId = String(request.deliveryId ?? "").trim();
  const definition = provider?.sendVariants?.[type];
  if (!provider || !definition || !type.startsWith(`${channel}.`)) {
    throw Object.assign(new Error(`Send variant ${type} is unavailable on ${channel}. Refresh the send capability directory.`), { code: "AGENT_SEND_VARIANT_UNAVAILABLE" });
  }
  const payload = request.payload as { type: string; data?: unknown };
  if (Object.keys(payload).some(key => key !== "type" && key !== "data")) throw new Error("Plugin send payload requires only type and data.");
  prepareAgentSendVariant(definition);
  const validation = validators.get(definition)!;
  if (!validation.params(request.params)) throw Object.assign(new Error(`Invalid target parameters for ${type}. Read the variant params schema.`), { code: "AGENT_SEND_VARIANT_PARAMS_INVALID" });
  if (!validation.data(payload.data)) throw Object.assign(new Error(`Invalid data for ${type}. Read the variant data schema.`), { code: "AGENT_SEND_VARIANT_DATA_INVALID" });
  const data = structuredClone(payload.data) as Record<string, unknown>;
  const text = definition.readText(structuredClone(data));
  if (typeof text !== "string" || !text.trim() && !definition.allowEmptyText) throw new Error(`Send variant ${type} returned empty text.`);
  const media: MessageEndpointVariantMedia = definition.readMedia ? structuredClone(definition.readMedia(structuredClone(data))) : {};
  if (!validateMedia(media)) throw new Error(`Send variant ${type} returned invalid media kinds or managed attachment references.`);
  const { attachments = [], kinds = [] } = media;
  const mediaKinds = [...new Set([...kinds, ...attachments.map(attachment => attachment.kind)])];
  const { pluginId: packageId, version, revision: packageHash, activationId } = provider.identity;
  const receiptMode = definition.receiptMode ?? "message";
  const receipt = Object.freeze({ type, contractVersion: definition.contractVersion, packageId, version, packageHash, activationId, receiptMode });
  const lease = provider.acquire({ deliveryId, channel, type });
  const variant: AgentSendVariant = Object.freeze({ channel, deliveryId, text, mediaKinds, attachments, receipt,
    send: async input => requireVariantOutcome(await lease.call<unknown>(definition.operation, [{ ...input, data }]), receiptMode) });
  try { return await sendScope.run(variant, () => operation(variant)); }
  finally { lease.release(); }
}

export function agentSendVariantDescriptions(channel: string, provider?: MessageEndpointEgressProvider) {
  if (!provider?.inspect().accepting) return [];
  return Object.values(provider.sendVariants ?? {}).map(({ type, contractVersion, description, dataSchema, paramsSchema, receiptMode, allowEmptyText }) =>
    ({ channel, type, contractVersion, description, dataSchema, paramsSchema, receiptMode: receiptMode ?? "message",
      ...(allowEmptyText ? { allowEmptyText } : {}) }));
}
