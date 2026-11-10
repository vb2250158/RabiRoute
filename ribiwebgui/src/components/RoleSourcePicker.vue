<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoleStore, roleRequest, type RoleSummary } from "../stores/roleStore";
import { useI18n } from "../i18n/index";
import { RemotePersonaReferenceBrowser, bootstrapRemotePersonaService, remotePersonaServicePath } from "../../../src/plugins/io.rabiroute.manager.persona/web/persona/remotePersonaReference";
import { personaSourceOptions as buildPersonaSourceOptions, personaSourceKey } from "../../../src/plugins/io.rabiroute.manager.persona/web/persona/personaSourcePresentation";
import { userFacingError } from "../userFacingError";
import PersonaAvatar from "./PersonaAvatar.vue";

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
const selectedSource = computed(() => personaSourceKey(store.meta, store.sourceDeviceId));
const selectedRole = computed(() => {
  const browsed = source.value === selectedSource.value ? items.value.find(role => role.roleId === store.selectedRoleId) : undefined;
  return browsed || store.catalog.find(role => role.roleId === store.selectedRoleId);
});
const selectedTitle = computed(() => selectedRole.value?.title || store.selectedRoleId || t("选择角色"));
const selectedPc = computed(() => sources.value.find(pc => pc.value === selectedSource.value)?.title || selectedSource.value || t("本机"));
const browsingPc = computed(() => sources.value.find(pc => pc.value === source.value)?.title || source.value);
const label = computed(() => `${selectedPc.value} → ${selectedTitle.value}`);

async function browse(value: string): Promise<void> {
  value = personaSourceKey(store.meta, value);
  const current = ++epoch;
  source.value = value;
  items.value = [];
  error.value = "";
  loading.value = true;
  try {
    if (value) await bootstrapRemotePersonaService(value);
    let cursor = "";
    do {
      const path = `/api/roles?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await roleRequest<{ roles: RoleSummary[]; nextCursor: string | null }>(value ? remotePersonaServicePath(value, path) : path);
      if (current !== epoch) return;
      items.value.push(...page.roles.map(role => ({
        ...role,
        avatarUrl: value && role.avatarUrl?.startsWith("/api/") ? remotePersonaServicePath(value, role.avatarUrl) : role.avatarUrl
      })));
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
  <v-menu :model-value="open" :close-on-content-click="false" location="bottom start" :offset="8" @update:model-value="toggle">
    <template #activator="{ props }">
      <v-btn v-bind="props" class="topbar-route-picker role-source-trigger" variant="tonal" :title="label" :aria-label="`${t('选择角色')} · ${label}`">
        <PersonaAvatar :role-id="store.selectedRoleId" :avatar-url="selectedRole?.avatarUrl" :size="30" />
        <span class="role-source-selection" data-no-i18n>
          <span class="role-source-selection__title">{{ selectedTitle }}</span>
          <span class="role-source-selection__pc">{{ selectedPc }}</span>
        </span>
        <v-icon size="18" class="role-source-chevron" :class="{ 'role-source-chevron--open': open }">mdi-chevron-down</v-icon>
      </v-btn>
    </template>
    <v-card class="role-source-menu" rounded="lg" elevation="12">
      <div class="role-source-columns">
        <section class="role-source-pane role-source-pane--computers">
          <div class="role-source-heading">{{ t('角色来源 PC') }}</div>
          <v-list class="role-source-level" :aria-label="t('角色来源 PC')" bg-color="transparent">
            <v-list-item v-for="pc in sources" :key="pc.value" class="role-source-computer" :title="pc.title" :subtitle="pc.subtitle" :active="source === pc.value" :disabled="pc.props.disabled" color="secondary" rounded="lg" append-icon="mdi-chevron-right" @click="browse(pc.value)">
              <template #prepend><v-icon :icon="pc.value ? 'mdi-laptop' : 'mdi-monitor'" size="20" /></template>
            </v-list-item>
          </v-list>
          <v-btn class="role-source-refresh" variant="text" prepend-icon="mdi-refresh" :loading="remotePersona.devicesLoading" @click="remotePersona.refreshDevices()">{{ t('刷新远端 PC') }}</v-btn>
          <v-alert v-if="remotePersona.devicesError" type="error" variant="tonal" density="compact">{{ remotePersona.devicesError }}</v-alert>
        </section>
        <section class="role-source-pane role-source-pane--roles">
          <div class="role-source-heading">
            <span>{{ t('选择角色') }}</span>
            <span class="role-source-heading__source" data-no-i18n>{{ browsingPc }}</span>
          </div>
          <v-progress-linear v-if="loading" indeterminate color="secondary" :aria-label="t('加载中')" />
          <v-list class="role-source-level" :aria-label="t('选择角色')" bg-color="transparent">
            <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}<v-btn variant="text" @click="browse(source)">{{ t('重试') }}</v-btn></v-alert>
            <v-list-item v-for="role in items" :key="role.roleId" class="role-source-role" :title="role.title || role.roleId" :subtitle="role.error || (role.title !== role.roleId ? role.roleId : undefined)" :disabled="!!role.error" :active="source === selectedSource && role.roleId === store.selectedRoleId" color="secondary" rounded="lg" @click="choose(role.roleId)">
              <template #prepend><PersonaAvatar :role-id="role.roleId" :avatar-url="role.avatarUrl" :size="38" /></template>
              <template #append><v-icon v-if="source === selectedSource && role.roleId === store.selectedRoleId" icon="mdi-check" size="20" color="secondary" /></template>
            </v-list-item>
            <v-list-item v-if="!loading && !error && !items.length" class="role-source-empty" :title="t('暂无角色')" />
          </v-list>
        </section>
      </div>
    </v-card>
  </v-menu>
</template>

<style scoped>
.role-source-trigger { height: 44px; padding-inline: 10px; text-transform: none; }
.role-source-trigger :deep(.v-btn__content) { min-width: 0; width: 100%; gap: 10px; }
.role-source-selection { display: grid; min-width: 0; text-align: start; line-height: 1.35; }
.role-source-selection__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 700; }
.role-source-selection__pc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; opacity: .68; }
.role-source-chevron { flex: 0 0 auto; margin-inline-start: auto; transition: transform .16s ease; }
.role-source-chevron--open { transform: rotate(180deg); }
.role-source-menu { width: 700px; max-width: calc(100vw - 24px); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.role-source-columns { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); }
.role-source-pane { display: flex; flex-direction: column; min-width: 0; }
.role-source-pane--computers { background: rgba(var(--v-theme-on-surface), .025); }
.role-source-pane--roles { border-inline-start: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.role-source-heading { display: flex; align-items: center; gap: 12px; padding: 16px 16px 8px; font-size: 12px; font-weight: 700; opacity: .75; }
.role-source-heading__source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-inline-start: auto; font-size: 11px; font-weight: 400; }
.role-source-level { min-width: 0; max-height: min(440px, 60vh); overflow-y: auto; padding: 4px 8px 8px; }
.role-source-level :deep(.v-list-item) { min-height: 62px; padding: 10px 12px; margin-block: 2px; }
.role-source-level :deep(.v-list-item__prepend > .v-icon) { margin-inline-end: 12px; }
.role-source-role :deep(.v-list-item__prepend) { margin-inline-end: 12px; }
.role-source-level :deep(.v-list-item-title) { font-size: 13px; font-weight: 600; white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
.role-source-level :deep(.v-list-item-subtitle) { font-size: 11px; margin-block-start: 3px; line-height: 1.4; }
.role-source-refresh { align-self: flex-start; margin: 4px 8px 8px; font-size: 12px; }
.role-source-empty { opacity: .65; }
@media (max-width: 560px) {
  .role-source-columns { grid-template-columns: 1fr; }
  .role-source-pane--roles { border-inline-start: 0; border-block-start: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
  .role-source-pane--computers .role-source-level { max-height: 160px; }
  .role-source-pane--roles .role-source-level { max-height: 36vh; }
  .role-source-heading { padding-block-start: 10px; }
}
@media (prefers-reduced-motion: reduce) { .role-source-chevron { transition: none; } }
</style>
