import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

type Point = { x: number; y: number };
export type NodeLayout = Point & { width?: number; height?: number };
type CardSize = { width: number; height: number };
const CARD_LEFT = 130;
const CARD_HEADER = 34;
const MIN_SCALE = 0.05;
const MAX_SCALE = 2;
const HISTORY_LIMIT = 50;

type SelectionMode = "replace" | "add" | "toggle";
type LayoutChange = { before: Record<string, NodeLayout>; after: Record<string, NodeLayout> };

function selectionWith(existing: string[], ids: string[], mode: SelectionMode): string[] {
  if (mode === "replace") return ids;
  const selection = new Set(existing);
  for (const id of ids) {
    if (mode === "toggle" && selection.has(id)) selection.delete(id);
    else selection.add(id);
  }
  return [...selection];
}

/** Minimums follow the prototype: a card never shrinks below 140x80. */
function resizedCard(width: number, height: number): CardSize {
  return { width: Math.round(Math.max(140, Math.min(1600, width))), height: Math.round(Math.max(80, Math.min(1200, height))) };
}
type SelectionCard = { id: string; left: number; top: number; right: number; bottom: number };

function measureSelectionCards(element: HTMLElement): SelectionCard[] {
  return Array.from(element.querySelectorAll<HTMLElement>("[data-canvas-node]")).flatMap(node => {
    const id = node.dataset.canvasNode;
    const body = node.querySelector(":scope > [data-canvas-card-body]")?.getBoundingClientRect();
    if (!id || !body?.width || !body.height) return [];
    const header = node.querySelector(":scope > .canvas-drag-handle")?.getBoundingClientRect() ?? body;
    return [{
      id,
      left: Math.min(body.left, header.left),
      top: Math.min(body.top, header.top),
      right: Math.max(body.right, header.right),
      bottom: Math.max(body.bottom, header.bottom),
    }];
  });
}
type Gesture = {
  pointer: number;
  start: Point;
  origin: NodeLayout;
  threshold: number;
  kind: "card" | "pan" | "selection" | "resize";
  id?: string;
  select?: () => void;
  selectionMode?: SelectionMode;
  started: boolean;
  size?: CardSize;
  selection?: { viewport: DOMRect; cards: SelectionCard[] };
};
export function useVideoCanvas(defaultHeight: (id: string) => number = () => 214) {
  const viewport = ref<HTMLElement>();
  const scale = ref(1);
  const viewportSize = ref({ x: 1200, y: 900 });
  const offset = ref<Point>({ x: 0, y: 0 });
  const positions = ref<Record<string, NodeLayout>>({});
  const handMode = ref(false);
  const spacePan = ref(false);
  const canPan = computed(() => handMode.value || spacePan.value);
  const dragging = ref(false);
  const changingLayout = ref(false);
  const selectedIds = ref<string[]>(["draft-1"]);
  const marquee = ref<{ x: number; y: number; width: number; height: number }>();
  const undoStack = ref<LayoutChange[]>([]), redoStack = ref<LayoutChange[]>([]);
  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);
  let origins: Record<string, NodeLayout> = {};
  let gesture: Gesture | undefined;
  let suppressClick = false;
  let selectionBeforeDrag: string[] = [];
  let observer: ResizeObserver | undefined;
  let previousSize: Point | undefined;
  const transform = computed(() => ({ transform: `translate(${offset.value.x}px, ${offset.value.y}px) scale(${scale.value})` }));
  const grid = computed(() => ({ backgroundSize: `${24 * scale.value}px ${24 * scale.value}px`, backgroundPosition: `${offset.value.x}px ${offset.value.y}px` }));
  const visibleBounds = computed(() => {
    const margin = 180;
    return {
      left: (-offset.value.x - margin) / scale.value,
      top: (-offset.value.y - margin) / scale.value,
      right: (viewportSize.value.x - offset.value.x + margin) / scale.value,
      bottom: (viewportSize.value.y - offset.value.y + margin) / scale.value,
    };
  });

  function cardSize(id: string): CardSize {
    const layout = positions.value[id];
    return resizedCard(Number.isFinite(layout?.width) ? layout!.width! : 206,
      Number.isFinite(layout?.height) ? layout!.height! : defaultHeight(id));
  }
  function cardBounds(id: string, point: Point) {
    return { id, x: point.x + CARD_LEFT, y: point.y + CARD_HEADER, ...cardSize(id) };
  }
  function cardRect(id: string) {
    const point = positions.value[id];
    return point ? cardBounds(id, point) : undefined;
  }
  const visibleCardIds = computed(() => {
    const view = visibleBounds.value;
    const visible = new Set<string>();
    for (const [id, point] of Object.entries(positions.value)) {
      const card = cardBounds(id, point);
      if (card.x <= view.right && card.x + card.width >= view.left && card.y - CARD_HEADER <= view.bottom && card.y + card.height >= view.top) visible.add(id);
    }
    if (selectedIds.value.length === 1) visible.add(selectedIds.value[0]!);
    return visible;
  });
  // Every card exposes exactly one input and one output port. The edge type is
  // decided when the drop lands, so the geometry must not vary by node kind.
  function portOffsets(id: string) {
    return { io: Math.round(CARD_HEADER + cardSize(id).height / 2) };
  }

  const minimap = computed(() => {
    const view = { x: -offset.value.x / scale.value, y: -offset.value.y / scale.value, width: viewportSize.value.x / scale.value, height: viewportSize.value.y / scale.value };
    const cards = Object.entries(positions.value).map(([id, point]) => cardBounds(id, point));
    const left = Math.min(view.x, ...cards.map(p => p.x)) - 100;
    const top = Math.min(view.y, ...cards.map(p => p.y)) - 100;
    const width = Math.max(view.x + view.width, ...cards.map(p => p.x + p.width)) + 100 - left;
    const height = Math.max(view.y + view.height, ...cards.map(p => p.y + p.height)) + 100 - top;
    const factor = Math.min(180 / width, 110 / height);
    const project = (p: { x: number; y: number; width: number; height: number }) => ({ x: (p.x - left) * factor + (180 - width * factor) / 2, y: (p.y - top) * factor + (110 - height * factor) / 2, width: p.width * factor, height: p.height * factor });
    return { cards: cards.map(p => ({ id: p.id, ...project(p) })), view: project(view), left, top, width, height, factor };
  });
  function locateMinimap(x: number, y: number, map = minimap.value) {
    const point = { x: map.left + (x - (180 - map.width * map.factor) / 2) / map.factor, y: map.top + (y - (110 - map.height * map.factor) / 2) / map.factor };
    offset.value = { x: viewportSize.value.x / 2 - point.x * scale.value, y: viewportSize.value.y / 2 - point.y * scale.value };
  }
  function add(id: string) {
    if (positions.value[id]) return;
    const rows = Object.values(positions.value);
    positions.value[id] = { x: rows.length ? Math.max(...rows.map(row => row.x)) + 720 : 0, y: 0 };
  }
  function position(id: string) {
    const point: NodeLayout = positions.value[id] || { x: 0, y: 0 };
    const { width, height } = cardSize(id);
    const ports = portOffsets(id);
    return { left: `${point.x}px`, top: `${point.y}px`, "--canvas-card-width": point.width === undefined ? undefined : `${width}px`,
      "--canvas-card-height": point.height === undefined ? undefined : `${height}px`,
      "--canvas-port": `${ports.io}px` };
  }
  function zoom(value: number, anchor?: Point) {
    const element = viewport.value;
    if (!element) return;
    const pivot = anchor || { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
    offset.value = { x: pivot.x - (pivot.x - offset.value.x) * next / scale.value, y: pivot.y - (pivot.y - offset.value.y) * next / scale.value };
    scale.value = next;
  }
  function center(id: string) {
    const element = viewport.value, point = positions.value[id];
    if (!element || !point || !rememberViewportSize(element)) return;
    const card = cardBounds(id, point);
    offset.value = { x: element.clientWidth / 2 - (card.x + card.width / 2) * scale.value, y: Math.max(30, (element.clientHeight - Math.max(620, card.height + CARD_HEADER) * scale.value) / 2) - point.y * scale.value };
  }
  function fit() {
    const element = viewport.value, rows = Object.entries(positions.value).map(([id, point]) => cardBounds(id, point));
    if (!element || !rememberViewportSize(element) || !rows.length) return;
    const left = Math.min(...rows.map(row => row.x)), top = Math.min(...rows.map(row => row.y)) - CARD_HEADER;
    const width = Math.max(...rows.map(row => row.x + row.width)) - left;
    const height = Math.max(...rows.map(row => row.y + row.height)) - top;
    scale.value = Math.max(MIN_SCALE, Math.min(1, (element.clientWidth - 100) / width, (element.clientHeight - 100) / height));
    offset.value = { x: (element.clientWidth - width * scale.value) / 2 - left * scale.value, y: (element.clientHeight - height * scale.value) / 2 - top * scale.value };
  }
  function rememberViewportSize(element: HTMLElement) {
    const size = { x: element.clientWidth, y: element.clientHeight };
    if (!size.x || !size.y) return false;
    viewportSize.value = size;
    previousSize = size;
    return true;
  }
  function begin(event: PointerEvent, id?: string, select?: () => void) {
    if (event.isPrimary === false || gesture || (event.button !== 0 && event.button !== 1)) return;
    if (id) add(id);
    const pan = canPan.value || event.button === 1;
    const kind = pan ? "pan" : id ? "card" : "selection";
    event.preventDefault();
    viewport.value?.focus?.({ preventScroll: true });
    gesture = {
      pointer: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: { ...(kind === "card" ? positions.value[id!]! : offset.value) },
      threshold: event.pointerType === "touch" ? 10 : 5,
      kind, id, select, started: false,
      selectionMode: event.metaKey || event.ctrlKey ? "toggle" : event.shiftKey ? "add" : "replace",
    };
  }
  function beginResize(event: PointerEvent, id: string) {
    if (event.isPrimary === false || gesture || event.button !== 0) return;
    const node = (event.currentTarget as HTMLElement).closest("[data-canvas-node]");
    const body = node?.querySelector<HTMLElement>(":scope > [data-canvas-card-body]");
    if (!body) return;
    add(id);
    event.preventDefault();
    viewport.value?.focus?.({ preventScroll: true });
    gesture = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { ...positions.value[id]! },
      threshold: event.pointerType === "touch" ? 10 : 4, kind: "resize", id, started: false,
      size: { width: body.offsetWidth, height: body.offsetHeight } };
  }
  function resizeWithKeyboard(event: KeyboardEvent, id: string) {
    const horizontal = Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft");
    const vertical = Number(event.key === "ArrowDown") - Number(event.key === "ArrowUp");
    if (!horizontal && !vertical) return false;
    event.preventDefault();
    add(id);
    const before = { [id]: { ...positions.value[id]! } };
    const { width, height } = cardSize(id), step = event.shiftKey ? 50 : 10;
    positions.value[id] = { ...positions.value[id]!, ...resizedCard(width + horizontal * step, height + vertical * step) };
    return recordLayout(before);
  }
  function backgroundDown(event: PointerEvent) {
    const target = event.target as HTMLElement;
    if (target.closest(".canvas-minimap,.canvas-tools,.workspace-tools,.output-library,.canvas-menu,.v-overlay")) return;
    if (target.closest(".canvas-object") && event.button !== 1) return;
    begin(event);
  }
  function move(event: PointerEvent) {
    const current = gesture;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.start.x, dy = event.clientY - current.start.y;
    if (!current.started) {
      if (Math.hypot(dx, dy) < current.threshold) return;
      current.started = true;
      viewport.value?.setPointerCapture(event.pointerId);
      selectionBeforeDrag = selectedIds.value.slice();
      if (current.kind === "card") {
        const id = current.id!;
        if (!selectedIds.value.includes(id)) {
          if (current.selectionMode === "replace") current.select?.();
          selectedIds.value = selectionWith(selectionBeforeDrag, [id], current.selectionMode ?? "replace");
        }
        const ids = selectedIds.value.filter(selected => positions.value[selected]);
        origins = Object.fromEntries(ids.map(id => [id, { ...positions.value[id]! }]));
      }
      if (current.kind === "selection" && viewport.value) {
        current.selection = { viewport: viewport.value.getBoundingClientRect(), cards: measureSelectionCards(viewport.value) };
      }
      dragging.value = current.kind === "card" || current.kind === "pan";
      changingLayout.value = current.kind === "card" || current.kind === "resize";
    }
    if (current.kind === "selection") {
      const selection = current.selection;
      if (!selection) return;
      const left = Math.min(current.start.x, event.clientX), top = Math.min(current.start.y, event.clientY);
      const right = Math.max(current.start.x, event.clientX), bottom = Math.max(current.start.y, event.clientY);
      marquee.value = { x: left - selection.viewport.left, y: top - selection.viewport.top, width: right - left, height: bottom - top };
      const hits = selection.cards
        .filter(card => card.left < right && card.right > left && card.top < bottom && card.bottom > top)
        .map(card => card.id);
      const next = selectionWith(selectionBeforeDrag, hits, current.selectionMode ?? "replace");
      if (next.length !== selectedIds.value.length || next.some((id, index) => id !== selectedIds.value[index])) selectedIds.value = next;
    } else if (current.kind === "card") {
      for (const [id, origin] of Object.entries(origins)) positions.value[id] = { ...origin, x: origin.x + dx / scale.value, y: origin.y + dy / scale.value };
    } else if (current.kind === "resize") {
      const { width, height } = current.size!;
      positions.value[current.id!] = dx || dy
        ? { ...current.origin, ...resizedCard(width + dx / scale.value, height + dy / scale.value) }
        : current.origin;
    } else {
      offset.value = { x: current.origin.x + dx, y: current.origin.y + dy };
    }
  }
  function finish(event: PointerEvent) {
    const current = gesture;
    if (!current || current.pointer !== event.pointerId) return;
    gesture = undefined;
    marquee.value = undefined;
    dragging.value = false;
    changingLayout.value = false;
    if (viewport.value?.hasPointerCapture(event.pointerId)) viewport.value.releasePointerCapture(event.pointerId);
    return current;
  }
  function end(event: PointerEvent) {
    move(event);
    const current = finish(event);
    if (!current) return false;
    if (current.started) suppressClick = true;
    else if (current.kind === "card") {
      if (current.selectionMode === "replace") current.select?.();
      selectedIds.value = selectionWith(selectedIds.value, [current.id!], current.selectionMode ?? "replace");
    } else if (current.kind === "selection" && current.selectionMode === "replace") selectedIds.value = [];
    const changed = current.started && (current.kind === "card" ? recordLayout(origins)
      : current.kind === "resize" && recordLayout({ [current.id!]: current.origin }));
    origins = {};
    selectionBeforeDrag = [];
    return changed;
  }
  function cancel(event: PointerEvent) {
    const current = finish(event);
    if (!current?.started) return;
    if (current.kind === "card") Object.assign(positions.value, origins);
    if (current.kind === "resize") positions.value[current.id!] = current.origin;
    if (current.kind === "pan") offset.value = current.origin;
    if (current.kind !== "pan") selectedIds.value = selectionBeforeDrag;
    origins = {};
    selectionBeforeDrag = [];
  }
  function leave(event: PointerEvent) {
    if (!gesture?.started) cancel(event);
  }
  function clearDragClick() { suppressClick = false; }
  function preventDragClick(event: MouseEvent) {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }
  function wheel(event: WheelEvent) {
    const target = event.target as HTMLElement;
    if (target.closest(".composer,.output-library,.canvas-minimap,.canvas-tools,.workspace-tools,.canvas-menu,textarea,.v-overlay")) return;
    event.preventDefault();
    if (gesture || !viewport.value) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.value.clientHeight : 1;
    if (!event.ctrlKey && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
      offset.value = { x: offset.value.x - (event.deltaX || event.deltaY) * unit, y: offset.value.y };
      return;
    }
    const bounds = viewport.value!.getBoundingClientRect();
    zoom(scale.value * Math.exp(-event.deltaY * unit * 0.0015), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }
  function applyLayout(after: Record<string, NodeLayout>) {
    const before: Record<string, NodeLayout> = {};
    for (const [id, next] of Object.entries(after)) {
      const current = positions.value[id];
      if (!current) continue;
      if (current.x === next.x && current.y === next.y && current.width === next.width && current.height === next.height) continue;
      before[id] = { ...current };
      positions.value[id] = { ...current, ...next };
    }
    return recordLayout(before);
  }
  function recordLayout(before: Record<string, NodeLayout>) {
    const after: Record<string, NodeLayout> = {};
    const changed: Record<string, NodeLayout> = {};
    for (const [id, old] of Object.entries(before)) {
      const next = positions.value[id];
      if (!next || (next.x === old.x && next.y === old.y && next.width === old.width && next.height === old.height)) continue;
      changed[id] = old;
      after[id] = { ...next };
    }
    if (!Object.keys(after).length) return false;
    undoStack.value = [...undoStack.value.slice(1 - HISTORY_LIMIT), { before: changed, after }];
    redoStack.value = [];
    return true;
  }
  function restoreLayout(reverse: boolean) {
    if (gesture) return false;
    const source = reverse ? undoStack : redoStack, target = reverse ? redoStack : undoStack;
    const change = source.value.pop();
    if (!change) return false;
    for (const [id, layout] of Object.entries(reverse ? change.before : change.after)) {
      if (positions.value[id]) positions.value[id] = { ...layout };
    }
    target.value.push(change);
    return true;
  }
  function clearHistory() { undoStack.value = []; redoStack.value = []; }
  function nudge(event: KeyboardEvent, id?: string) {
    const steps: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const step = steps[event.key];
    const ids = id && !selectedIds.value.includes(id) ? [id] : selectedIds.value;
    if (gesture || !step || !ids.length || event.altKey || event.metaKey || event.ctrlKey) return false;
    event.preventDefault();
    const amount = event.shiftKey ? 50 : 10;
    const before: Record<string, NodeLayout> = {};
    for (const selected of ids) {
      const point = positions.value[selected];
      if (!point) continue;
      before[selected] = { ...point };
      positions.value[selected] = { ...point, x: point.x + step.x * amount, y: point.y + step.y * amount };
    }
    return recordLayout(before);
  }
  onMounted(() => {
    observer = new ResizeObserver(() => {
      const element = viewport.value;
      if (!element) return;
      const before = previousSize;
      if (!rememberViewportSize(element)) return;
      if (!before) fit();
      else {
        const size = viewportSize.value;
        if (size.x !== before.x || size.y !== before.y) {
          offset.value = { x: offset.value.x + (size.x - before.x) / 2, y: offset.value.y + (size.y - before.y) / 2 };
        }
      }
    });
    if (viewport.value) observer.observe(viewport.value);
  });
  watch(viewport, (element, previous) => {
    if (previous) observer?.unobserve(previous);
    previousSize = undefined;
    if (element) observer?.observe(element);
  }, { flush: "post" });
  onBeforeUnmount(() => observer?.disconnect());
  function world(point: Point) { return { x: (point.x - offset.value.x) / scale.value, y: (point.y - offset.value.y) / scale.value }; }
  function moving(pointerId: number) { return gesture?.pointer === pointerId && gesture.started; }
  return { selectedIds, marquee, minimap, locateMinimap, viewport, scale, offset, handMode, spacePan, canPan, dragging, changingLayout, positions, transform, grid, visibleBounds, visibleCardIds, add, position, cardSize, cardRect, portOffsets, zoom, center, fit, begin, beginResize, resizeWithKeyboard, backgroundDown, move, moving, end, cancel, leave, clearDragClick, preventDragClick, wheel, nudge, world, canUndo, canRedo, restoreLayout, clearHistory, applyLayout };
}
