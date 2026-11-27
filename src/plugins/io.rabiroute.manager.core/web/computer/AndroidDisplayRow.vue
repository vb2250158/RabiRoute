<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { managerAccessToken } from "../../../../../ribiwebgui/src/managerApi";
import { requestDeviceScreenOperation, type AndroidDisplayDirectoryEntry } from "../../../../../ribiwebgui/src/rabiLinkHomeClient";
import RabiPhoneScreenControl from "./RabiPhoneScreenControl.vue";

const props = defineProps<{ entry: AndroidDisplayDirectoryEntry; active?: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const { t } = useI18n();
const expanded = ref(false);
const busy = ref(false);
const message = ref("");
let requestController: AbortController | undefined;
let openId: string | undefined;
onBeforeUnmount(() => requestController?.abort());

async function action() {
  if (busy.value || !props.entry.online) return;
  const controller = new AbortController();
  requestController = controller;
  busy.value = true;
  message.value = "";
  const target = props.entry.target;
  try {
    const input = target.surfaceId ? { action: "display.close" as const }
      : { action: "display.open" as const, requestId: openId ??= browserUuid() };
    const value = await requestDeviceScreenOperation(target, input, controller.signal, managerAccessToken());
    if (controller.signal.aborted) return;
    if (value.state !== "opened" && value.state !== "closed") throw new Error("ANDROID_DISPLAY_UNEXPECTED_STATE");
    openId = undefined;
    emit("refresh");
  } catch (error) {
    if (!controller.signal.aborted) {
      if (error instanceof Error && error.message === "ANDROID_DISPLAY_OPEN_FAILED") openId = undefined;
      message.value = "独立屏状态待确认，请刷新状态。";
    }
  } finally { if (requestController === controller) busy.value = false; }
}
</script>

<template>
  <article class="android-display">
    <div class="display-header">
      <v-icon icon="mdi-android" size="18" />
      <strong>{{ entry.name }}</strong>
      <span class="display-kind">{{ t('Android 独立屏') }}</span>
      <v-btn v-if="entry.target.surfaceId" size="small" variant="text" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ t(expanded ? '收起' : '展开') }}
      </v-btn>
      <v-btn size="small" variant="tonal" :loading="busy" :disabled="!entry.online" @click="action">
        {{ t(entry.target.surfaceId ? '关闭独立屏' : '开启独立屏') }}
      </v-btn>
    </div>
    <p v-if="message" role="status">{{ t(message) }}</p>
    <RabiPhoneScreenControl v-if="active !== false && expanded && entry.target.surfaceId && entry.online" :display="entry.target" />
  </article>
</template>

<style scoped>
.android-display { display: grid; gap: 8px; padding: 12px; border-top: 1px solid var(--rr-border); min-width: 0; }
.display-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.display-header strong { flex: 1 1 160px; overflow-wrap: anywhere; }
.display-kind, .android-display p { color: var(--rr-muted); font-size: .85rem; }
</style>
