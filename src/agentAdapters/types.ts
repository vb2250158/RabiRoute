import type { AgentAdapterType } from "../shared/agentAdapterCapabilities.js";

export type { AgentAdapterType } from "../shared/agentAdapterCapabilities.js";

export function parseAgentAdapterType(value: string | undefined): AgentAdapterType | null {
  return value === "codex" || value === "copilotCli" || value === "marvis" || value === "astrbot" || value === "dsh"
    ? value
    : null;
}

function migrateConfiguredAgentAdapterType(value: string | undefined): AgentAdapterType | null {
  if (value === "codexDesktop" || value === "codexApp") return "codex";
  return parseAgentAdapterType(value);
}

export function normalizeAgentAdapters(items: unknown[] | undefined): AgentAdapterType[] {
  if (items === undefined) {
    return ["codex"];
  }
  const adapters = items
    .map((item) => migrateConfiguredAgentAdapterType(item == null ? undefined : String(item)))
    .filter((item): item is AgentAdapterType => Boolean(item));
  const unique = [...new Set(adapters)];
  return unique;
}
