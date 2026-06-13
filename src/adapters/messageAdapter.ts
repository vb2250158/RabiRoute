export type MessageAdapterType = "napcat" | "remoteAgent" | "fennenote" | "xiaoai" | "webhook" | "heartbeat" | "rolePanel" | "disabled";

export type MessageAdapter = {
  type: MessageAdapterType;
  start(): void | Promise<void>;
};
