<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoleStore, roleRequest, type RoleSummary } from "../stores/roleStore";
import { useI18n } from "../i18n";
import { RemotePersonaReferenceBrowser, bootstrapRemotePersonaService, remotePersonaServicePath } from "../persona/remotePersonaReference";
import { personaSourceOptions as buildPersonaSourceOptions } from "../persona/personaSourcePresentation";
import { userFacingError } from "../userFacingError";

const emit = defineEmits<{ select: [roleId: string, source: string] }>();
const store = useRoleStore();
const { t } = useI18n();
const remotePersona = reactive(new RemotePersonaReferenceBrowser());
const open = ref(false);
const source = ref("");
const items = ref<RoleSummary[]>([]);
const loading = ref(false);
const error = ref("");
let epoch = 0;
const sources = computed(() => buildPersonaSourceOptions(store.meta, remotePersona.devices, store.sourceDeviceId, t));
const label = computed(() => {
  const pc = store.sourceDeviceId ? sources.value.find(item => item.value === store.sourceDeviceId)?.title || store.sourceDeviceId : t("本机");
  const role = store.catalog.find(item => item.roleId === store.selectedRoleId);
  return `${pc} → ${role?.title || store.selectedRoleId || t("选择角色")}`;
});

async function browse(value: string): Promise<void> {
  const current = ++epoch;
  source.value = value;
  items.value = [];
  error.value = "";
  loading.value = true;
  try {
    if (value) await bootstrapRemotePersonaService(value);
    let cursor = "";
    do {
      const path = `/api/roles?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await roleRequest<{ roles: RoleSummary[]; nextCursor: string | null }>(value ? remotePersonaServicePath(value, path) : path);
      if (current !== epoch) return;
      items.value.push(...page.roles);
      cursor = page.nextCursor || "";
    } while (cursor);
  } catch (failure) {
    if (current === epoch) error.value = userFacingError(failure);
  } finally {
    if (current === epoch) loading.value = false;
  }
}
function toggle(value: boolean): void {
  open.value = value;
  if (value) {
    void remotePersona.refreshDevices();
    void browse(store.sourceDeviceId);
  } else ++epoch;
}
function choose(roleId: string): void {
  emit("select", roleId, source.value);
  toggle(false);
}
onMounted(() => { void remotePersona.refreshDevices(); });
onBeforeUnmount(() => { ++epoch; remotePersona.invalidate(); });
</script>

<template>
  <v-menu :model-value="open" :close-on-content-click="false" @update:model-value="toggle">
    <template #activator="{ props }">
      <v-btn v-bind="props" class="topbar-route-picker role-source-trigger" variant="tonal" append-icon="mdi-chevron-down" :title="label" :aria-label="t('选择角色')">
        <span class="text-truncate" data-no-i18n>{{ label }}</span>
      </v-btn>
    </template>
    <v-card class="role-source-menu">
      <div class="role-source-columns">
        <v-list class="role-source-level" :aria-label="t('角色来源 PC')">
          <v-list-item v-for="pc in sources" :key="pc.value" :title="pc.title" :subtitle="pc.subtitle" :active="source === pc.value" :disabled="pc.props.disabled" append-icon="mdi-chevron-right" @click="browse(pc.value)" />
          <v-list-item :title="t('刷新远端 PC')" prepend-icon="mdi-refresh" :disabled="remotePersona.devicesLoading" @click="remotePersona.refreshDevices()" />
          <v-alert v-if="remotePersona.devicesError" type="error" variant="tonal">{{ remotePersona.devicesError }}</v-alert>
        </v-list>
        <v-list class="role-source-level" :aria-label="t('选择角色')">
          <v-progress-linear v-if="loading" indeterminate :aria-label="t('加载中')" />
          <v-alert v-if="error" type="error" variant="tonal">{{ error }}<v-btn variant="text" @click="browse(source)">{{ t('重试') }}</v-btn></v-alert>
          <v-list-item v-for="role in items" :key="role.roleId" :title="role.title" :subtitle="role.error || (role.title !== role.roleId ? role.roleId : undefined)" :disabled="!!role.error" :active="source === store.sourceDeviceId && role.roleId === store.selectedRoleId" @click="choose(role.roleId)" />
          <v-list-item v-if="!loading && !error && !items.length" :title="t('暂无角色')" />
        </v-list>
      </div>
    </v-card>
  </v-menu>
</template>

<style scoped>
.role-source-trigger :deep(.v-btn__content) { min-width: 0; }
.role-source-menu { width: 620px; max-width: calc(100vw - 24px); }
.role-source-columns { display: grid; grid-template-columns: 1fr 1fr; }
.role-source-level { min-width: 0; max-height: 420px; overflow-y: auto; }
.role-source-level + .role-source-level { border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
@media (max-width: 480px) { .role-source-columns { grid-template-columns: 1fr; } .role-source-level { max-height: 220px; } }
</style>
