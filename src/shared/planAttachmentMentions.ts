export type PlanAttachmentMentionSource = {
  id: string;
  name: string;
};

export type PlanAttachmentMentionCandidate = PlanAttachmentMentionSource & {
  token: string;
  duplicateIndex?: number;
  duplicateCount?: number;
};

export type PlanAttachmentMentionQuery = {
  start: number;
  end: number;
  query: string;
};

function safeMentionName(value: unknown): string {
  return String(value || "")
    .replace(/[\r\n「」]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "attachment";
}

export function planAttachmentMentionCandidates(
  attachments: readonly PlanAttachmentMentionSource[]
): PlanAttachmentMentionCandidate[] {
  const totals = new Map<string, number>();
  for (const attachment of attachments) {
    const name = safeMentionName(attachment.name);
    totals.set(name, (totals.get(name) || 0) + 1);
  }

  const positions = new Map<string, number>();
  return attachments.map((attachment) => {
    const name = safeMentionName(attachment.name);
    const duplicateCount = totals.get(name) || 1;
    const duplicateIndex = (positions.get(name) || 0) + 1;
    positions.set(name, duplicateIndex);
    const label = duplicateCount > 1 ? `${name}（${duplicateIndex}）` : name;
    return {
      id: String(attachment.id || "").trim(),
      name,
      token: `@附件「${label}」`,
      ...(duplicateCount > 1 ? { duplicateIndex, duplicateCount } : {})
    };
  }).filter((candidate) => candidate.id);
}

export function findPlanAttachmentMentionQuery(text: string, caret: number): PlanAttachmentMentionQuery | null {
  const safeCaret = Math.max(0, Math.min(Number.isFinite(caret) ? caret : text.length, text.length));
  const beforeCaret = text.slice(0, safeCaret);
  const start = beforeCaret.lastIndexOf("@");
  if (start < 0) return null;
  const preceding = start > 0 ? beforeCaret[start - 1] || "" : "";
  if (/[A-Za-z0-9._%+-]/u.test(preceding)) return null;
  const query = beforeCaret.slice(start + 1);
  if (/[\s@「」]/u.test(query)) return null;
  return {
    start,
    end: safeCaret,
    query
  };
}

export function insertPlanAttachmentMention(
  text: string,
  mention: Pick<PlanAttachmentMentionQuery, "start" | "end">,
  token: string
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(mention.start, text.length));
  const end = Math.max(start, Math.min(mention.end, text.length));
  const separator = " ";
  const nextText = `${text.slice(0, start)}${token}${separator}${text.slice(end)}`;
  return { text: nextText, caret: start + token.length + separator.length };
}

export function referencedPlanAttachmentIds(
  text: string,
  candidates: readonly PlanAttachmentMentionCandidate[]
): string[] {
  return candidates.filter((candidate) => text.includes(candidate.token)).map((candidate) => candidate.id);
}
