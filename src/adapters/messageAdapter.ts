export type MessageAdapterType = "napcat" | "webhook" | "disabled";

export type MessageAdapter = {
  type: MessageAdapterType;
  start(): void | Promise<void>;
};
