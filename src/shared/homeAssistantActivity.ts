/** Activity records are independent of the Agent's significant-event policy. */
export type HomeAssistantActivityRecord = {
  id: string;
  occurredAt: number;
  entityId?: string;
  domain?: string;
  name: string;
  text: string;
  state?: string;
};
export type HomeAssistantActivityRequest = { roleId: string; startedAt: number };
export type HomeAssistantActivityPort = {
  subscribe(listener: (request: HomeAssistantActivityRequest | null) => void): () => void;
  receive(roleId: string, record: HomeAssistantActivityRecord): Promise<boolean>;
  report(roleId: string, error: string): void;
};
