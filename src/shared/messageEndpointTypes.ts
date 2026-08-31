export const MESSAGE_ENDPOINT_TYPES = [
  "napcat",
  "remoteAgent",
  "heartbeat",
  "rolePanel",
  "speech",
  "fennenote",
  "xiaoai",
  "rabilink",
  "wearable",
  "webhook",
  "wecom",
  "weixin",
  "feishu",
  "xiaomiHome"
] as const;

export type MessageEndpointType = typeof MESSAGE_ENDPOINT_TYPES[number];

export const GATEWAY_MESSAGE_ADAPTER_TYPES = [
  "napcat",
  "heartbeat",
  "fennenote",
  "xiaoai",
  "rabilink",
  "webhook",
  "wecom",
  "weixin",
  "feishu"
] as const satisfies readonly MessageEndpointType[];

export type GatewayMessageAdapterType = typeof GATEWAY_MESSAGE_ADAPTER_TYPES[number];

/** Legacy configuration may still use `disabled` as a sentinel. */
export type LegacyMessageAdapterType = MessageEndpointType | "disabled";

const messageEndpointTypeValues: ReadonlySet<string> = new Set(MESSAGE_ENDPOINT_TYPES);
const gatewayMessageAdapterTypeValues: ReadonlySet<string> = new Set(GATEWAY_MESSAGE_ADAPTER_TYPES);

export function isMessageEndpointType(value: unknown): value is MessageEndpointType {
  return typeof value === "string" && messageEndpointTypeValues.has(value);
}

export function isGatewayMessageAdapterType(value: unknown): value is GatewayMessageAdapterType {
  return typeof value === "string" && gatewayMessageAdapterTypeValues.has(value);
}

export function selectGatewayMessageAdapterTypes(
  endpointTypes: readonly MessageEndpointType[]
): GatewayMessageAdapterType[] {
  return endpointTypes.filter(isGatewayMessageAdapterType);
}
