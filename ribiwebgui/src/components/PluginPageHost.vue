<script setup lang="ts">
import { nextTick, onActivated, onMounted, onUnmounted, ref, type Component } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { retainMountedTrustedWebPage } from '../pluginPages';
const props = defineProps<{ component: Component; routeId: string }>();
const root = ref<HTMLElement>();
let release: (() => void) | undefined;
let viewState: { positions: Array<{ element: HTMLElement; top: number; left: number }>; focus?: HTMLElement } | undefined;
onMounted(() => { release = retainMountedTrustedWebPage(props.routeId); });
onBeforeRouteLeave(() => {
  const elements = root.value ? [root.value, ...root.value.querySelectorAll<HTMLElement>('*')] : [];
  viewState = {
    positions: elements.filter(element => element.scrollTop || element.scrollLeft)
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft })),
    focus: root.value?.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined
  };
});
onActivated(async () => {
  await nextTick();
  if (!viewState) return;
  for (const { element, top, left } of viewState.positions) {
    if (element.isConnected) { element.scrollTop = top; element.scrollLeft = left; }
  }
  if (viewState.focus?.isConnected) viewState.focus.focus({ preventScroll: true });
});
// KeepAlive deactivation intentionally retains the original bundle and its resources.
onUnmounted(() => { viewState = undefined; release?.(); release = undefined; });
</script>
<template><div ref="root" style="display: contents"><component :is="component" /></div></template>
