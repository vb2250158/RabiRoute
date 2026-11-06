/** Read-only instance observations shared by endpoint providers and their management UI. */
export type MessageEndpointInstanceHealth = Record<string, unknown> & {
  ok: boolean;
  enabled: boolean;
  scanState: "ok" | "timeout" | "error" | "skipped";
};

export type MessageEndpointHealthPayload<Health extends MessageEndpointInstanceHealth = MessageEndpointInstanceHealth> = Record<string, {
  instances: Record<string, Health>;
}>;
