export type AgentAdapterType = "codexDesktop" | "codexApp";

export function parseAgentAdapterType(value: string | undefined): AgentAdapterType | null {
  return value === "codexDesktop" || value === "codexApp" ? value : null;
}

export function normalizeAgentAdapters(items: unknown[]): AgentAdapterType[] {
  const adapters = items
    .map((item) => parseAgentAdapterType(item == null ? undefined : String(item)))
    .filter((item): item is AgentAdapterType => Boolean(item));
  return [...new Set(adapters)];
}
