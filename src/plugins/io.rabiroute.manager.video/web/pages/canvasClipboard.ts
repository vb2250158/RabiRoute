// Copy/paste contract for canvas nodes. Presentation state and persistence stay with their owners.
// The page stores a snapshot here, the browser clipboard carries the same JSON for cross-tab paste.
export type ClipboardPoint = { x: number; y: number };
export type ClipboardLayout = ClipboardPoint & { width?: number; height?: number };
export type CanvasClipboardEntry =
  | { type: "media"; data: Record<string, unknown>; draft?: Record<string, unknown>; layout?: ClipboardLayout }
  | { type: "workflow"; data: Record<string, unknown>; layout?: ClipboardLayout };
export const CANVAS_CLIPBOARD_SCOPE = "rabi-video-canvas";
export const CANVAS_CLIPBOARD_LIMIT = 100;
const CLIPBOARD_TEXT_LIMIT = 2 * 1024 * 1024;
const CLIPBOARD_STAGGER = 40;
export const MEDIA_KINDS = ["video", "image", "audio", "text"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type CanvasClipboard = { scope: typeof CANVAS_CLIPBOARD_SCOPE; version: 1; entries: CanvasClipboardEntry[] };

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function finitePoint(value: unknown): ClipboardLayout | undefined {
  if (!isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return undefined;
  const layout: ClipboardLayout = { x: value.x, y: value.y };
  if (Number.isFinite(value.width)) layout.width = value.width;
  if (Number.isFinite(value.height)) layout.height = value.height;
  return layout;
}

export function createCanvasClipboard(entries: readonly CanvasClipboardEntry[]): CanvasClipboard {
  return { scope: CANVAS_CLIPBOARD_SCOPE, version: 1, entries: entries.slice(0, CANVAS_CLIPBOARD_LIMIT) };
}

/** Parses clipboard JSON from this app only; anything else is ignored instead of trusted. */
export function parseCanvasClipboard(text: string | undefined | null): CanvasClipboard | undefined {
  if (typeof text !== "string" || !text || text.length > CLIPBOARD_TEXT_LIMIT) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(parsed) || parsed.scope !== CANVAS_CLIPBOARD_SCOPE || parsed.version !== 1 || !Array.isArray(parsed.entries)) return undefined;
  const entries = parsed.entries.slice(0, CANVAS_CLIPBOARD_LIMIT).flatMap(normalizeEntry);
  return entries.length ? createCanvasClipboard(entries) : undefined;
}

function normalizeEntry(value: unknown): CanvasClipboardEntry[] {
  if (!isRecord(value) || !isRecord(value.data)) return [];
  const data: Record<string, unknown> = value.data;
  const layout = finitePoint(value.layout);
  if (value.type === "workflow") {
    if (typeof data.kind !== "string" || !data.kind || !isRecord(data.config)) return [];
    return [{ type: "workflow", data, ...(layout ? { layout } : {}) }];
  }
  if (value.type === "media") {
    if (!MEDIA_KINDS.includes(data.kind as MediaKind)) return [];
    if (data.text !== undefined && typeof data.text !== "string") return [];
    const draft = isRecord(value.draft) ? value.draft : undefined;
    return [{ type: "media", data, ...(layout ? { layout } : {}), ...(draft ? { draft } : {}) }];
  }
  return [];
}

/** Titles keep one trailing copy suffix, so repeated paste does not chain markers. */
export function copiedNodeTitle(title: string | undefined, fallback = "节点"): string {
  const base = String(title ?? "").replace(/\s*副本\s*$/, "").trim();
  return `${base || fallback} 副本`;
}

/**
 * Target layouts keep the relative shape of a multi-node copy. An anchor (pointer world position)
 * aligns the copied bounds to it; without one the copy steps aside so repeated paste stays visible.
 */
export function pasteLayouts(
  entries: readonly { layout?: ClipboardLayout }[],
  options: { anchor?: ClipboardPoint; offset?: number } = {}
): ClipboardLayout[] {
  const rows = entries.map(entry => finitePoint(entry.layout)).filter((layout): layout is ClipboardLayout => !!layout);
  const base = rows.length
    ? { x: Math.min(...rows.map(row => row.x)), y: Math.min(...rows.map(row => row.y)) }
    : { x: 0, y: 0 };
  const anchor = options.anchor && Number.isFinite(options.anchor.x) && Number.isFinite(options.anchor.y) ? options.anchor : undefined;
  const shift = anchor
    ? { x: anchor.x - base.x, y: anchor.y - base.y }
    : { x: options.offset ?? CLIPBOARD_STAGGER, y: options.offset ?? CLIPBOARD_STAGGER };
  return entries.map((entry, index) => {
    const layout = finitePoint(entry.layout);
    if (layout) return { ...layout, x: layout.x + shift.x, y: layout.y + shift.y };
    return { x: base.x + shift.x + index * CLIPBOARD_STAGGER, y: base.y + shift.y + index * CLIPBOARD_STAGGER };
  });
}
