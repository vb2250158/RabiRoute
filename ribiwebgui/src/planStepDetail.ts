export type PlanStepDetailBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] };

export type ParsedPlanStepDetail = {
  structured: boolean;
  blocks: PlanStepDetailBlock[];
};

const LEGACY_HEADINGS: Record<string, string> = {
  核验路径: "要看什么",
  核验步骤: "负责人要做什么"
};

function normalizedHeading(value: string): string {
  return LEGACY_HEADINGS[value] || value;
}

export function parsePlanStepDetail(value: string): ParsedPlanStepDetail {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { structured: false, blocks: [] };

  const blocks: PlanStepDetailBlock[] = [];
  let paragraphLines: string[] = [];
  let structured = false;

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
    paragraphLines = [];
  };

  const appendListItem = (type: "unordered-list" | "ordered-list", item: string) => {
    flushParagraph();
    const previous = blocks.at(-1);
    if (previous?.type === type) {
      previous.items.push(item);
      return;
    }
    blocks.push({ type, items: [item] });
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const humanHeading = trimmed.match(/^【([^】]+)】\s*(.*)$/);
    if (humanHeading) {
      flushParagraph();
      structured = true;
      blocks.push({ type: "heading", text: normalizedHeading(humanHeading[1]!.trim()) });
      if (humanHeading[2]!.trim()) blocks.push({ type: "paragraph", text: humanHeading[2]!.trim() });
      continue;
    }

    const legacyHeading = trimmed.match(/^\[(核验路径|核验步骤)(?:\s+\d{4}-\d{2}-\d{2})?\]$/);
    if (legacyHeading) {
      flushParagraph();
      structured = true;
      blocks.push({ type: "heading", text: normalizedHeading(legacyHeading[1]!) });
      continue;
    }

    const legacyPass = trimmed.match(/^通过标准：\s*(.*)$/);
    if (legacyPass) {
      flushParagraph();
      structured = true;
      blocks.push({ type: "heading", text: "怎样算通过" });
      if (legacyPass[1]!.trim()) blocks.push({ type: "paragraph", text: legacyPass[1]!.trim() });
      continue;
    }

    const unordered = trimmed.match(/^-\s+(.+)$/);
    if (unordered) {
      appendListItem("unordered-list", unordered[1]!.trim());
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      appendListItem("ordered-list", ordered[1]!.trim());
      continue;
    }

    const previous = blocks.at(-1);
    if (/^\s+/.test(line) && (previous?.type === "unordered-list" || previous?.type === "ordered-list")) {
      const lastIndex = previous.items.length - 1;
      previous.items[lastIndex] = `${previous.items[lastIndex]}\n${trimmed}`;
      continue;
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();
  if (!structured) return { structured: false, blocks: [{ type: "paragraph", text }] };
  return { structured: true, blocks };
}
