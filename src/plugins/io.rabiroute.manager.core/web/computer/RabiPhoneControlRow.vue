<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { requestPhoneFileOperation } from "../../../../../ribiwebgui/src/rabiLinkHomeClient";
import RabiPhoneFilesDialog from "../components/RabiPhoneFilesDialog.vue";
import RabiPhoneLocationControl from "./RabiPhoneLocationControl.vue";
import RabiPhoneScreenControl from "./RabiPhoneScreenControl.vue";
import { deviceSystemIcon, deviceSystemName } from "./deviceSystem";
import type { PhoneDevice } from "./phoneDevice";

const props = defineProps<{ phone: PhoneDevice; expanded: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();
const status = ref<{ enabled: boolean; permissionGranted: boolean }>();
const busy = ref(false);
const error = ref(false);
const showFiles = ref(false);
const systemHint = computed(() => ({
  deviceKind: "phone", platform: props.phone.platform, deviceModel: props.phone.deviceModel,
  name: props.phone.displayName, id: props.phone.id
}));
const systemIcon = computed(() => deviceSystemIcon(systemHint.value));
const systemLabel = computed(() => deviceSystemName(systemHint.value) || t("系统未提供"));
const supportsFiles = () => props.phone.capabilities.includes("phone-file-control-v1");
let active: AbortController | undefined;
onBeforeUnmount(() => active?.abort());

async function updateStatus(enabled?: boolean) {
  if (!props.expanded || !props.phone.online || !supportsFiles()) return;
  active?.abort();
  const controller = new AbortController();
  active = controller;
  busy.value = true;
  error.value = false;
  try {
    const result = await requestPhoneFileOperation(props.phone, enabled === undefined
      ? { action: "file.settings.read" } : { action: "file.settings.update", enabled }, controller.signal);
    if (controller.signal.aborted) return;
    if (typeof result.enabled !== "boolean" || typeof result.permissionGranted !== "boolean") throw new Error("Invalid phone status");
    status.value = { enabled: result.enabled, permissionGranted: result.permissionGranted };
  } catch {
    if (!controller.signal.aborted) {
      error.value = true;
      status.value = undefined;
    }
  } finally {
    if (active === controller) busy.value = false;
  }
}

watch(() => {
  const phone = props.phone;
  return props.expanded && phone ? JSON.stringify([phone.id, phone.guid, phone.online, supportsFiles()]) : "";
}, () => {
  active?.abort();
  status.value = undefined;
  busy.value = false;
  error.value = false;
  showFiles.value = false;
  void updateStatus();
}, { immediate: true });
</script>

<template>
  <article class="phone-row" :data-phone-id="phone.id">
    <header class="phone-summary">
      <button type="button" class="phone-expand" :aria-expanded="expanded" @click="emit('toggle')">
        <v-icon :icon="expanded ? 'mdi-chevron-down' : 'mdi-chevron-right'" />
        <v-icon class="phone-system" :icon="systemIcon" :title="systemLabel" />
        <span>{{ phone.displayName }}</span>
      </button>
      <div class="phone-tags">
        <v-chip size="small" variant="outlined">{{ t('手机') }}</v-chip>
        <v-chip size="small" :color="phone.online ? 'success' : 'default'">{{ t(phone.online ? '在线' : '离线') }}</v-chip>
      </div>
      <v-btn v-if="expanded && phone.online && supportsFiles()" size="small" variant="text" prepend-icon="mdi-refresh"
        :loading="busy" @click="updateStatus()">{{ t('刷新状态') }}</v-btn>
    </header>
    <div v-show="expanded" class="phone-details">
      <p v-if="!phone.online" class="phone-note">{{ t('手机当前离线。') }}</p>
      <p v-else-if="!supportsFiles()" class="phone-note">{{ t('更新手机端后即可使用文件操作。') }}</p>
      <v-alert v-else-if="error" type="error" variant="tonal">{{ t('无法确认手机文件操作状态，请刷新。') }}</v-alert>
      <div v-else class="phone-file-row">
        <div class="phone-file-description">
          <strong><v-icon icon="mdi-folder-outline" size="18" class="me-2" />{{ t('文件操作') }}</strong>
          <span v-if="status && !status.permissionGranted" class="phone-note">
            {{ t('请在手机端「设置 → 文件操作」授予 Android 所有文件访问权限。') }}
          </span>
        </div>
        <v-btn v-if="status?.permissionGranted && status.enabled" variant="tonal" size="small" :disabled="busy"
          @click="showFiles = true">{{ t('打开文件管理') }}</v-btn>
        <v-switch v-if="status" :model-value="status.enabled" :disabled="busy" :loading="busy"
          :aria-label="t('文件操作')" color="success" hide-details
          @update:model-value="value => updateStatus(value === true)" />
        <v-progress-circular v-else-if="busy" indeterminate size="20" />
      </div>
      <RabiPhoneLocationControl v-if="expanded && phone.online && phone.capabilities.includes('phone-location-v1')"
        :key="`${phone.id}:${phone.guid}`" :phone="phone" />
      <RabiPhoneScreenControl v-if="expanded && phone.online && phone.capabilities.includes('phone-screen-v1')"
        :key="`screen:${phone.id}:${phone.guid}`" :phone="phone" />
    </div>
    <RabiPhoneFilesDialog v-if="showFiles" :device="phone" :title="phone.displayName" @close="showFiles = false" />
  </article>
</template>

<style scoped>
.phone-row { border-top: 1px solid var(--rr-border); min-width: 0; }
.phone-summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 0; }
.phone-expand { display: flex; align-items: center; gap: 8px; min-width: 0; text-align: left; color: var(--rr-text); font: inherit; font-weight: 600; background: none; border: 0; padding: 4px; cursor: pointer; flex: 1; }
.phone-expand span { overflow-wrap: anywhere; }
.phone-expand:focus-visible { outline: 2px solid var(--rr-accent-strong); outline-offset: 3px; }
.phone-system { color: var(--rr-muted); }
.phone-tags { display: flex; gap: 8px; flex-wrap: wrap; }
.phone-details { padding: 0 12px 24px 32px; min-width: 0; display: grid; gap: 14px; }
.phone-note { color: var(--rr-muted); font-size: .85rem; margin: 4px 0; }
.phone-file-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; min-height: 62px; }
.phone-file-description { flex: 1 1 210px; display: grid; gap: 4px; }
@media (max-width: 650px) { .phone-details { padding-left: 4px; padding-right: 4px; } .phone-tags { width: 100%; padding-left: 32px; } }
</style>
