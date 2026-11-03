/** Legacy public labels retained for callers; installed package declarations own the live catalog. */
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

/** Stable endpoint IDs are declared by installed plugins, not a host enumeration. */
export type MessageEndpointType = string;

/** Legacy compatibility labels. Actual host support comes from each package's entries.gateway. */
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

export type GatewayMessageAdapterType = string;

/** Legacy configuration may still use `disabled` as a sentinel. */
export type LegacyMessageAdapterType = MessageEndpointType | "disabled";

export function isMessageEndpointType(value: unknown): value is MessageEndpointType {
  return typeof value === "string" && value !== "disabled" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
}

/** Host ownership is supplied by the selected immutable package manifests. */
export function gatewayEndpointTypesFromManifests(manifests: Iterable<Readonly<{ entries?: Readonly<{ gateway?: unknown }>; provides: readonly string[] }>>): ReadonlySet<string> {
  const types = new Set<string>();
  for (const manifest of manifests) {
    if (!manifest.entries?.gateway) continue;
    for (const capability of manifest.provides) {
      // The SDK egress provider is a companion service of its declared endpoint,
      // rather than another input type. Dotted endpoint IDs remain supported.
      if (capability.endsWith(".egress@1") && manifest.provides.includes(capability.replace(/\.egress@1$/, "@1"))) continue;
      const match = /^endpoint\.(.+)@1$/.exec(capability);
      if (match && isMessageEndpointType(match[1])) types.add(match[1]);
    }
  }
  return types;
}

export function isGatewayMessageAdapterType(value: unknown, declaredGatewayTypes: ReadonlySet<string>): value is GatewayMessageAdapterType {
  return isMessageEndpointType(value) && declaredGatewayTypes.has(value);
}

export function selectGatewayMessageAdapterTypes(
  endpointTypes: readonly MessageEndpointType[],
  declaredGatewayTypes: ReadonlySet<string>
): GatewayMessageAdapterType[] {
  return endpointTypes.filter(type => isGatewayMessageAdapterType(type, declaredGatewayTypes));
}
