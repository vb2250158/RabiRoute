export const codexThreadTitleMaxLength = 240;

function trimWithoutDanglingHighSurrogate(value: string): string {
  if (!value) return value;
  const lastCodeUnit = value.charCodeAt(value.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ? value.slice(0, -1)
    : value;
}

/** Keep task metadata within the Codex thread/name/set contract. */
export function normalizeCodexThreadTitle(value: unknown, fallback = "Rabi"): string {
  const fallbackTitle = typeof fallback === "string" && fallback.trim() ? fallback.trim() : "Rabi";
  const title = typeof value === "string" && value.trim() ? value.trim() : fallbackTitle;
  if (title.length <= codexThreadTitleMaxLength) return title;

  const prefix = trimWithoutDanglingHighSurrogate(title.slice(0, codexThreadTitleMaxLength - 1)).trimEnd();
  return `${prefix || fallbackTitle.slice(0, codexThreadTitleMaxLength - 1)}…`;
}
