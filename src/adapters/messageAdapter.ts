export type MessageAdapterType = "napcat" | "fennenote" | "xiaoai" | "webhook" | "heartbeat" | "disabled";

export type MessageAdapter = {
  type: MessageAdapterType;
  start(): void | Promise<void>;
};
