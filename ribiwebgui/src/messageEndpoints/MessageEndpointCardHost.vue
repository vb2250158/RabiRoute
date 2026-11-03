<script setup lang="ts">
import { computed, nextTick, onErrorCaptured, ref, watch, type ComponentPublicInstance } from "vue";
import type { WebRendererContribution } from "../pluginRenderers";
import type { MessageEndpointCardContext } from "./messageEndpointCardContext";
import { userFacingError } from "../userFacingError";

const props = defineProps<{
  renderers: readonly WebRendererContribution[];
  context: MessageEndpointCardContext;
  active: boolean;
  enabled: boolean;
  lifecycleRevision: number;
}>();
type CardInstance = { onEnabledChange?: (enabled: boolean) => void | Promise<void>; onAdded?: () => void | Promise<void> };
const emit = defineEmits<{ busy: [value: boolean] }>();
const cards = new Map<string, CardInstance>();
const error = ref("");
const busy = ref(false);
const cardContext = computed(() => ({ ...props.context, active: props.active }));
let enabledChange = 0;
const appliedEnabled = new Map<string, number>();
const appliedAdded = new Map<string, string>();
onErrorCaptured(cause => { error.value = userFacingError(cause); return false; });
async function applyLifecycle() {
  if (busy.value) return;
  await nextTick();
  if (busy.value) return;
  const addedKey = `${props.context.routeId}:${props.lifecycleRevision}`;
  if (![...cards].some(([key]) => (props.lifecycleRevision > 0 && appliedAdded.get(key) !== addedKey)
    || (enabledChange > 0 && appliedEnabled.get(key) !== enabledChange))) return;
  error.value = "";
  busy.value = true;
  emit("busy", true);
  try {
    for (const [key, card] of cards) {
      if (props.lifecycleRevision > 0 && appliedAdded.get(key) !== addedKey) {
        appliedAdded.set(key, addedKey);
        await card.onAdded?.();
      }
      if (enabledChange > 0 && appliedEnabled.get(key) !== enabledChange) {
        appliedEnabled.set(key, enabledChange);
        await card.onEnabledChange?.(props.enabled);
      }
    }
  }
  catch (cause) { error.value = userFacingError(cause); }
  finally { busy.value = false; emit("busy", false); }
}
function setCard(key: string, value: Element | ComponentPublicInstance | null) {
  if (value) { cards.set(key, value as CardInstance); void applyLifecycle(); }
  else cards.delete(key);
}
watch(() => props.enabled, () => { enabledChange += 1; void applyLifecycle(); });
watch(() => props.context.routeId, () => { enabledChange = 0; appliedEnabled.clear(); appliedAdded.clear(); });
watch(() => props.lifecycleRevision, revision => { if (revision > 0) void applyLifecycle(); }, { immediate: true });
</script>
<template>
  <v-alert v-if="!renderers.length" type="warning" variant="tonal" density="compact">
    此消息端插件暂不可用，原配置已保留。请在插件页检查安装、启用状态和加载结果。
  </v-alert>
  <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
  <v-progress-linear v-if="busy" indeterminate color="primary" />
  <component :is="renderer.component" v-for="renderer in renderers" :key="renderer.key" :ref="(value: Element | ComponentPublicInstance | null) => setCard(renderer.key, value)" :context="cardContext" />
</template>
