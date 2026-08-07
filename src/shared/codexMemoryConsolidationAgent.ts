import { codexThreadTitleMaxLength, normalizeCodexThreadTitle } from "./codexThreadTitle.js";

export const DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL = "gpt-5.6-terra";

export function normalizeCodexMemoryConsolidationAgentModel(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL;
}

function trimDanglingHighSurrogate(value: string): string {
  if (!value) return value;
  const lastCodeUnit = value.charCodeAt(value.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? value.slice(0, -1) : value;
}

export function codexMemoryConsolidationAgentTitle(primaryTitle: unknown): string {
  const suffix = " 记忆整理";
  const fallback = "RabiRoute";
  const rawBase = String(primaryTitle || fallback).trim() || fallback;
  const maximumBaseLength = Math.max(1, codexThreadTitleMaxLength - suffix.length);
  const base = trimDanglingHighSurrogate(rawBase.slice(0, maximumBaseLength)).trimEnd() || fallback;
  return normalizeCodexThreadTitle(`${base}${suffix}`);
}
