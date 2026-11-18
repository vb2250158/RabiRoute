import { AsyncLocalStorage } from "node:async_hooks";
import type { MessageEndpointEgressProvider, MessageEndpointSendVariant, MessageEndpointVariantSendInput, MessageEndpointVariantSendResult } from "@rabiroute/plugin-sdk";
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
}>;

export type AgentSendVariant = Readonly<{
  channel: string;
  deliveryId: string;
  text: string;
  receipt: VariantReceipt;
  send(input: Omit<MessageEndpointVariantSendInput, "data">): Promise<MessageEndpointVariantSendResult>;
}>;

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
  if (typeof text !== "string" || !text.trim()) throw new Error(`Send variant ${type} returned empty text.`);
  const { pluginId: packageId, version, revision: packageHash, activationId } = provider.identity;
  const receipt = Object.freeze({ type, contractVersion: definition.contractVersion, packageId, version, packageHash, activationId });
  const lease = provider.acquire({ deliveryId, channel, type });
  const variant: AgentSendVariant = Object.freeze({ channel, deliveryId, text, receipt,
    send: input => lease.call<MessageEndpointVariantSendResult>(definition.operation, [{ ...input, data }]) });
  try { return await sendScope.run(variant, () => operation(variant)); }
  finally { lease.release(); }
}

export function agentSendVariantDescriptions(channel: string, provider?: MessageEndpointEgressProvider) {
  if (!provider?.inspect().accepting) return [];
  return Object.values(provider.sendVariants ?? {}).map(({ type, contractVersion, description, dataSchema, paramsSchema }) =>
    ({ channel, type, contractVersion, description, dataSchema, paramsSchema }));
}
