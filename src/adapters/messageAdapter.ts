export type MessageAdapterType = "napcat" | "webhook" | "heartbeat" | "disabled";

export type MessageAdapter = {
  type: MessageAdapterType;
  start(): void | Promise<void>;
};
