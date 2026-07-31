export type MessageAdapterType = "napcat" | "remoteAgent" | "speech" | "fennenote" | "xiaoai" | "rabilink" | "wearable" | "webhook" | "wecom" | "weixin" | "feishu" | "heartbeat" | "rolePanel" | "disabled";

export type MessageAdapter = {
  type: MessageAdapterType;
  start(): void | Promise<void>;
};
