export type AgentAdapterType = "codex" | "copilotCli" | "marvis" | "astrbot";

export function parseAgentAdapterType(value: string | undefined): AgentAdapterType | null {
  if (value === "codex" || value === "codexDesktop" || value === "codexApp") {
    return "codex";
  }
  return value === "copilotCli" || value === "marvis" || value === "astrbot" ? value : null;
}

export function normalizeAgentAdapters(items: unknown[]): AgentAdapterType[] {
  const adapters = items
    .map((item) => parseAgentAdapterType(item == null ? undefined : String(item)))
    .filter((item): item is AgentAdapterType => Boolean(item));
  const unique = [...new Set(adapters)];
  return unique.length ? unique : ["codex"];
}
