import {
  isAgentAdapterType,
  type AgentAdapterType
} from "../shared/agentAdapterCapabilities.js";

export type { AgentAdapterType } from "../shared/agentAdapterCapabilities.js";

export function parseAgentAdapterType(value: string | undefined): AgentAdapterType | null {
  if (value === "codexDesktop" || value === "codexApp") return null;
  return isAgentAdapterType(value) ? value : null;
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
    .map((item) => typeof item === "string" ? migrateConfiguredAgentAdapterType(item) : null)
    .filter((item): item is AgentAdapterType => Boolean(item));
  const unique = [...new Set(adapters)];
  return unique;
}
