<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { requestPhoneFileOperation, type RabiLinkHomeDevice } from "../../../../../ribiwebgui/src/rabiLinkHomeClient";
import RabiPhoneFilesDialog from "./RabiPhoneFilesDialog.vue";

type Phone = RabiLinkHomeDevice & { displayName: string };
const props = defineProps<{ phones: Phone[]; selectedId: string; loading: boolean }>();
const emit = defineEmits<{ select: [string] }>();
const { t } = useI18n();
const status = ref<{ enabled: boolean; permissionGranted: boolean }>();
const busy = ref(false);
const error = ref(false);
const showFiles = ref(false);
const selected = computed(() => props.phones.find(phone => phone.id === props.selectedId));
const supportsFiles = (phone: Phone) => phone.capabilities.includes("phone-file-control-v1");
let active: AbortController | undefined;
onBeforeUnmount(() => active?.abort());

async function updateStatus(enabled?: boolean) {
  const phone = selected.value;
  if (!phone?.online || !supportsFiles(phone)) return;
  active?.abort();
  const controller = new AbortController();
  active = controller;
  busy.value = true;
  error.value = false;
  try {
    const result = await requestPhoneFileOperation(phone, enabled === undefined
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
  const phone = selected.value;
  return phone ? JSON.stringify([phone.id, phone.guid, phone.online, supportsFiles(phone)]) : "";
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
  <section :aria-label="t('手机控制')">
    <div class="d-flex align-center justify-space-between mb-3">
      <h2 class="section-title">{{ t('手机控制') }}</h2>
      <v-btn v-if="selected?.online && supportsFiles(selected)" variant="tonal" size="small"
        prepend-icon="mdi-refresh" :loading="busy" @click="updateStatus()">{{ t('刷新状态') }}</v-btn>
    </div>
    <v-progress-linear v-if="loading" indeterminate />
    <p v-else-if="!phones.length" class="section-note">{{ t('暂无已连接的手机') }}</p>
    <div v-for="phone in phones" :key="phone.id" class="phone-control-row">
      <button type="button" class="phone-heading" :aria-expanded="selectedId === phone.id"
        @click="emit('select', selectedId === phone.id ? '' : phone.id)">
        <v-icon size="18" :icon="selectedId === phone.id ? 'mdi-chevron-down' : 'mdi-chevron-right'" />
        <v-icon size="18" icon="mdi-cellphone" />
        <strong data-no-i18n>{{ phone.displayName }}</strong>
        <v-chip size="x-small" variant="tonal" :color="phone.online ? 'success' : 'default'">
          {{ t(phone.online ? '在线' : '离线') }}
        </v-chip>
      </button>
      <div v-if="selectedId === phone.id" class="phone-body">
        <p v-if="!phone.online" class="section-note">{{ t('手机当前离线。') }}</p>
        <p v-else-if="!supportsFiles(phone)" class="section-note">{{ t('更新手机端后即可使用文件操作。') }}</p>
        <v-alert v-else-if="error" type="error" variant="tonal" class="mb-3">
          {{ t('无法确认手机文件操作状态，请刷新。') }}
        </v-alert>
        <div v-else class="phone-file-row">
          <div class="phone-file-description">
            <strong><v-icon icon="mdi-folder-outline" size="18" class="me-2" />{{ t('文件操作') }}</strong>
            <span v-if="status && !status.permissionGranted" class="section-note">
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
      </div>
    </div>
    <RabiPhoneFilesDialog v-if="showFiles && selected" :device="selected" :title="selected.displayName" @close="showFiles = false" />
  </section>
</template>

<style scoped>
.phone-control-row { border-top: 1px solid var(--rr-border); }
.phone-heading { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 52px; text-align: start; }
.phone-heading strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.phone-body { padding: 0 12px 12px 32px; }
.phone-file-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; min-height: 62px; }
.phone-file-description { flex: 1 1 210px; display: grid; gap: 4px; }
</style>
