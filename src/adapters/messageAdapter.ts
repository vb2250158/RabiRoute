export type MessageAdapterType = "napcat" | "remoteAgent" | "speech" | "fennenote" | "xiaoai" | "rabilink" | "webhook" | "wecom" | "heartbeat" | "rolePanel" | "disabled";

export type MessageAdapter = {
  type: MessageAdapterType;
  start(): void | Promise<void>;
};
