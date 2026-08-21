export type MessageAdapterType = "napcat" | "remoteAgent" | "speech" | "fennenote" | "xiaoai" | "rabilink" | "wearable" | "webhook" | "wecom" | "weixin" | "feishu" | "heartbeat" | "rolePanel" | "disabled";

export type MessageAdapterDispose = () => void | Promise<void>;

export type MessageAdapter = {
  type: MessageAdapterType;
  start(): void | MessageAdapterDispose | Promise<void | MessageAdapterDispose>;
};

export type MessageAdapterManifest = {
  type: MessageAdapterType;
  label: string;
  host: "gateway";
  transport: "http" | "websocket" | "timer" | "internal";
  lifecycle: "fiber";
};

export type MessageAdapterDefinition = {
  manifest: MessageAdapterManifest;
  create(): MessageAdapter;
};
