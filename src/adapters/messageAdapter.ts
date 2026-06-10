export type MessageAdapterType = "napcat" | "fennenote" | "xiaoai" | "webhook" | "heartbeat" | "rolePanel" | "disabled";

export type MessageAdapter = {
  type: MessageAdapterType;
  start(): void | Promise<void>;
};
