import type {
  GatewayMessageAdapterType,
  LegacyMessageAdapterType,
  MessageEndpointType
} from "../shared/messageEndpointTypes.js";

export type MessageAdapterEnvironment = {
  MESSAGE_ADAPTER_TYPE: LegacyMessageAdapterType;
  MESSAGE_ADAPTER_TYPES: string;
};

function serializeMessageAdapterEnvironment(
  activeAdapters: readonly MessageEndpointType[]
): MessageAdapterEnvironment {
  const adapters: readonly LegacyMessageAdapterType[] = activeAdapters.length > 0
    ? activeAdapters
    : ["disabled"];
  return {
    MESSAGE_ADAPTER_TYPE: adapters[0] ?? "disabled",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(adapters)
  };
}

export function routeMessageAdapterEnvironment(
  activeEndpoints: readonly MessageEndpointType[]
): MessageAdapterEnvironment {
  return serializeMessageAdapterEnvironment(activeEndpoints);
}

export function gatewayMessageAdapterEnvironment(
  activeAdapters: readonly GatewayMessageAdapterType[]
): MessageAdapterEnvironment {
  return serializeMessageAdapterEnvironment(activeAdapters);
}
