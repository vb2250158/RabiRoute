import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type Ref } from 'vue';

export const HISTORY_WIDTH_KEY = 'rabiroute.history.conversation-list-width';
export const HISTORY_DETAILS_WIDTH_KEY = 'rabiroute.history.details-width';
export const HISTORY_DEFAULT_WIDTH = 260;
export const HISTORY_DEFAULT_DETAILS_WIDTH = 222;
const preferredWidth = ref(HISTORY_DEFAULT_WIDTH);
const preferredDetailsWidth = ref(HISTORY_DEFAULT_DETAILS_WIDTH);
const clamp = (value: number, min: number, max: number, fallback: number) => Math.round(Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback)));

export function conversationPaneWidths(left: number, right: number, available: number, details: boolean) {
  const total = Math.max(details ? 380 : 200, available - 312 - (details ? 24 : 12));
  const wantedRight = details ? clamp(right, 180, 420, HISTORY_DEFAULT_DETAILS_WIDTH) : 0;
  const list = clamp(left, 200, Math.max(200, Math.min(420, total - wantedRight)), HISTORY_DEFAULT_WIDTH);
  const info = details ? clamp(wantedRight, 180, Math.max(180, Math.min(420, total - list)), HISTORY_DEFAULT_DETAILS_WIDTH) : 0;
  return { list, info, listMaximum: Math.max(200, Math.min(420, total - info)), infoMaximum: Math.max(180, Math.min(420, total - list)) };
}
export function conversationListWidth(requested: number, available: number, details: boolean): number {
  return conversationPaneWidths(requested, HISTORY_DEFAULT_DETAILS_WIDTH, available, details).list;
}

/** Shared widths preserve reading space and the user's preferences across channels. */
export function useHistoryConversationLayout(root: Ref<HTMLElement | undefined>, hasDetails: () => boolean) {
  const available = ref(1000), viewport = ref(1440);
  const detailsVisible = computed(() => hasDetails() && viewport.value > 1200);
  const sizes = computed(() => conversationPaneWidths(preferredWidth.value, preferredDetailsWidth.value, available.value, detailsVisible.value));
  const width = computed(() => sizes.value.list), maximum = computed(() => sizes.value.listMaximum);
  const detailsWidth = computed(() => sizes.value.info), detailsMaximum = computed(() => sizes.value.infoMaximum);
  let observer: ResizeObserver | undefined;
  const measureViewport = () => { viewport.value = window.innerWidth; if (viewport.value <= 760) list.stop(); if (!detailsVisible.value) details.stop(); };
  function resizer(preferred: Ref<number>, visibleWidth: Ref<number>, max: Ref<number>, minimum: number, initial: number, storageKey: string, direction: number, enabled: () => boolean) {
    const dragging = ref(false);
    let drag: { id: number; element: HTMLElement; x: number; width: number } | undefined;
    const persist = () => { try { localStorage.setItem(storageKey, String(preferred.value)); } catch { /* Preference remains available in memory. */ } };
    function save(value: number) { preferred.value = clamp(value, minimum, 420, initial); persist(); }
    function stop() {
      const previous = drag; drag = undefined; dragging.value = false;
      if (previous?.element.hasPointerCapture(previous.id)) previous.element.releasePointerCapture(previous.id);
      if (previous) persist();
    }
    function start(event: PointerEvent) {
      if (event.button !== 0 || !enabled()) return;
      stopAll(); event.preventDefault();
      drag = { id: event.pointerId, element: event.currentTarget as HTMLElement, x: event.clientX, width: visibleWidth.value };
      dragging.value = true; drag.element.setPointerCapture(event.pointerId);
    }
    function move(event: PointerEvent) {
      if (drag?.id !== event.pointerId) return;
      const next = clamp(drag.width + (event.clientX - drag.x) * direction, minimum, max.value, initial);
      if (next !== visibleWidth.value) preferred.value = next;
    }
    function key(event: KeyboardEvent) {
      const delta = event.key === 'ArrowLeft' ? -16 * direction : event.key === 'ArrowRight' ? 16 * direction : 0;
      if (!delta && event.key !== 'Home' && event.key !== 'End') return;
      if (!enabled()) return;
      event.preventDefault();
      const next = clamp(event.key === 'Home' ? minimum : event.key === 'End' ? max.value : visibleWidth.value + delta, minimum, max.value, initial);
      if (!delta || next !== visibleWidth.value) save(next);
    }
    return { dragging, start, move, stop, key, reset: () => save(initial) };
  }
  const list = resizer(preferredWidth, width, maximum, 200, HISTORY_DEFAULT_WIDTH, HISTORY_WIDTH_KEY, 1, () => viewport.value > 760);
  const details = resizer(preferredDetailsWidth, detailsWidth, detailsMaximum, 180, HISTORY_DEFAULT_DETAILS_WIDTH, HISTORY_DETAILS_WIDTH_KEY, -1, () => detailsVisible.value);
  watch(detailsVisible, visible => { if (!visible) details.stop(); });
  function stopAll() { list.stop(); details.stop(); }
  onMounted(() => {
    measureViewport(); window.addEventListener('resize', measureViewport);
    try {
      const stored = localStorage.getItem(HISTORY_WIDTH_KEY) ?? localStorage.getItem('rabiroute.qq.conversation-list-width');
      const left = stored === null ? NaN : Number(stored);
      const rightStored = localStorage.getItem(HISTORY_DETAILS_WIDTH_KEY), right = rightStored === null ? NaN : Number(rightStored);
      if (Number.isFinite(left) && left >= 200) preferredWidth.value = Math.min(420, left);
      if (Number.isFinite(right) && right >= 180) preferredDetailsWidth.value = Math.min(420, right);
    } catch { /* Optional preference storage. */ }
    if (root.value) {
      available.value = root.value.clientWidth;
      observer = new ResizeObserver(entries => { available.value = entries[0]?.contentRect.width ?? available.value; });
      observer.observe(root.value);
    }
  });
  onDeactivated(stopAll);
  onBeforeUnmount(() => { stopAll(); observer?.disconnect(); window.removeEventListener('resize', measureViewport); });
  return { width, maximum, detailsWidth, detailsMaximum, ...list, details };
}
