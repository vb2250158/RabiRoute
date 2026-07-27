export type PlanViewportRect = Readonly<{
  id: string;
  top: number;
  bottom: number;
}>;

export function activePlanIdAtAnchor(
  rects: readonly PlanViewportRect[],
  anchorTop: number,
  fallbackId = ""
): string {
  if (!rects.length) return "";

  const containingAnchor = rects.find((rect) => rect.top <= anchorTop && rect.bottom > anchorTop);
  if (containingAnchor) return containingAnchor.id;

  const firstAfterAnchor = rects.find((rect) => rect.top > anchorTop);
  if (firstAfterAnchor) return firstAfterAnchor.id;

  return rects.at(-1)?.id || fallbackId;
}

export function directoryScrollTopForItem(input: Readonly<{
  scrollTop: number;
  viewportTop: number;
  viewportBottom: number;
  itemTop: number;
  itemBottom: number;
  padding?: number;
}>): number | null {
  const padding = Math.max(0, input.padding || 0);
  const visibleTop = input.viewportTop + padding;
  const visibleBottom = input.viewportBottom - padding;

  if (input.itemTop < visibleTop) {
    return Math.max(0, input.scrollTop - (visibleTop - input.itemTop));
  }
  if (input.itemBottom > visibleBottom) {
    return Math.max(0, input.scrollTop + (input.itemBottom - visibleBottom));
  }
  return null;
}
