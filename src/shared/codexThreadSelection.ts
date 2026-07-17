export type CodexThreadSummary = {
  id: string;
  title: string;
  updatedAt?: string;
  cwd?: string;
};

export type CodexThreadItem = {
  title: string;
  value: string;
};

export function formatCodexThreadTime(value?: string): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

export function codexThreadItems(threads: CodexThreadSummary[]): CodexThreadItem[] {
  return threads
    .filter(thread => thread.id)
    .map(thread => ({
      title: `${thread.title || thread.id} · ${formatCodexThreadTime(thread.updatedAt)}`,
      value: thread.id
    }));
}

export function comboboxValueText(value: unknown): string {
  if (typeof value === "string") return value === "[object Object]" ? "" : value;
  if (value && typeof value === "object") {
    const candidate = value as { value?: unknown; title?: unknown };
    if (typeof candidate.value === "string") return candidate.value === "[object Object]" ? "" : candidate.value;
    if (typeof candidate.title === "string") return candidate.title === "[object Object]" ? "" : candidate.title;
    return "";
  }
  return String(value || "");
}

export function selectCodexThread(
  value: unknown,
  threads: CodexThreadSummary[]
): { threadId: string; threadName: string; selected?: CodexThreadSummary } {
  const selectedValue = comboboxValueText(value);
  const selected = threads.find(thread => thread.id === selectedValue);
  return {
    threadId: selected?.id || "",
    threadName: selected?.title || selectedValue,
    selected
  };
}
