import type {
  GatewayMessageAdapterType,
  LegacyMessageAdapterType,
  MessageEndpointType
} from "../shared/messageEndpointTypes.js";

export type {
  GatewayMessageAdapterType,
  LegacyMessageAdapterType,
  MessageEndpointType
} from "../shared/messageEndpointTypes.js";

/** @deprecated Use MessageEndpointType or GatewayMessageAdapterType according to the owning host. */
export type MessageAdapterType = LegacyMessageAdapterType;

export type MessageAdapterDispose = () => void | Promise<void>;

export type MessageAdapter = {
  type: GatewayMessageAdapterType;
  start(): void | MessageAdapterDispose | Promise<void | MessageAdapterDispose>;
};

export type MessageAdapterManifest = {
  type: GatewayMessageAdapterType;
  label: string;
  host: "gateway";
  transport: "http" | "websocket" | "timer" | "internal";
  lifecycle: "fiber";
};

export type MessageAdapterDefinition = {
  manifest: MessageAdapterManifest;
  create(): MessageAdapter;
};
