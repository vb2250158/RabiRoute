<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "../i18n";
import { userFacingError } from "../userFacingError";
import { filterManagedPlugins, pluginDisplayName, readPluginManagementCatalog, updateManagedPlugin, type ManagedPlugin } from "../pluginManagementClient";
import { pluginCatalogStore } from "../pluginCatalogStore";
import { refreshWebPluginModulesSafely } from "../pluginModuleBootstrap";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const plugins = ref<readonly ManagedPlugin[]>([]);
const query = ref("");
const status = ref("all");
const loading = ref(false);
const loaded = ref(false);
const error = ref("");
const revision = ref("");
const saving = ref(new Set<string>());
const rowErrors = ref<Record<string, string>>({});
let controller: AbortController | undefined;
let live = true;
let readSequence = 0;
let saveQueue: Promise<void> = Promise.resolve();
const selected = computed(() => plugins.value.find(plugin => plugin.instanceId === route.query.instance));
const visiblePlugins = computed(() => filterManagedPlugins(plugins.value, query.value || "", status.value));
const activeCount = computed(() => plugins.value.filter(plugin => plugin.status === "active").length);
const statusLabels: Record<string, string> = {
  active: "运行中", inactive: "未运行", failed: "启动失败", waiting_dependency: "等待依赖", activating: "启动中", settings_error: "配置错误", retirement_unconfirmed: "停止未确认"
};
const statusOptions = computed(() => [{ title: t("全部状态"), value: "all" }, { title: t("未启用"), value: "disabled" }, ...Object.entries(statusLabels).map(([value, title]) => ({ title: t(title), value }))]);
function statusLabel(plugin: ManagedPlugin): string { return t(plugin.status === "disabled" ? "未启用" : statusLabels[plugin.status] || plugin.status); }
function statusColor(plugin: ManagedPlugin): string { return plugin.status === "active" ? "success" : ["failed", "settings_error", "retirement_unconfirmed"].includes(plugin.status) ? "error" : "default"; }
function selectPlugin(plugin?: ManagedPlugin): void {
  void router.push({ path: "/plugins", query: plugin ? { instance: plugin.instanceId } : {} });
}
function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) return String(value.message);
  return JSON.stringify(value, null, 2) || "";
}
async function refresh(): Promise<void> {
  if (loading.value) return;
  controller = new AbortController();
  loading.value = true;
  error.value = "";
  const sequence = ++readSequence;
  try {
    const catalog = await readPluginManagementCatalog(controller.signal);
    if (!live || sequence !== readSequence) return;
    plugins.value = catalog.plugins;
    revision.value = catalog.revision;
    loaded.value = true;
  } catch (cause) {
    if (live && sequence === readSequence && !controller.signal.aborted) error.value = userFacingError(cause);
  } finally { loading.value = false; }
}
async function togglePlugin(plugin: ManagedPlugin, enabled: boolean): Promise<void> {
  if (saving.value.has(plugin.instanceId)) return;
  saving.value = new Set([...saving.value, plugin.instanceId]);
  delete rowErrors.value[plugin.instanceId];
  // A profile has one revision. Queue this page's writes so independent rows can
  // remain usable without manufacturing conflicts between its own operations.
  saveQueue = saveQueue.then(async () => {
    if (!live) return;
    try {
      await updateManagedPlugin(plugin.instanceId, revision.value, enabled);
      const catalog = await readPluginManagementCatalog();
      if (!live) return;
      ++readSequence;
      plugins.value = catalog.plugins;
      revision.value = catalog.revision;
      if (catalog.plugins.find(item => item.instanceId === plugin.instanceId)?.enabled !== enabled) {
        rowErrors.value[plugin.instanceId] = t("插件状态未确认，请刷新后查看。");
      }
      void pluginCatalogStore.refresh().then(() => refreshWebPluginModulesSafely());
    } catch (cause) {
      if (live) {
        rowErrors.value[plugin.instanceId] = userFacingError(cause);
        // A failed response does not prove that the owner rejected the write.
        // Read its original state without replaying the mutation.
        try {
          const catalog = await readPluginManagementCatalog();
          if (live) { ++readSequence; plugins.value = catalog.plugins; revision.value = catalog.revision; }
        } catch { /* Keep the original operation error and the last confirmed list. */ }
      }
    } finally {
      saving.value = new Set([...saving.value].filter(id => id !== plugin.instanceId));
    }
  });
  await saveQueue;
}
onMounted(refresh);
onBeforeUnmount(() => { live = false; controller?.abort(); });
</script>

<template>
  <div class="page-shell plugins-page">
    <header class="plugins-toolbar">
      <div>
        <v-btn v-if="selected" variant="text" size="small" prepend-icon="mdi-chevron-left" class="plugins-back" @click="selectPlugin()">{{ t("返回插件") }}</v-btn>
        <h1 v-else class="page-title">{{ t("插件") }}</h1>
        <p v-if="!selected" class="page-subtitle">{{ t("查看插件的运行状态、能力和版本。") }}</p>
      </div>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="refresh">{{ t("刷新") }}</v-btn>
    </header>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-5" role="alert">{{ error }}</v-alert>
    <v-progress-linear v-if="loading && !loaded" indeterminate color="primary" :aria-label="t('正在读取插件')" />

    <template v-if="selected">
      <section class="plugin-detail-header">
        <div class="plugin-icon plugin-icon-large"><v-icon :icon="selected.manifest.icon || 'mdi-puzzle-outline'" size="30" /></div>
        <div class="plugin-detail-title">
          <div class="plugin-name-line"><h1 class="page-title">{{ t(pluginDisplayName(selected)) }}</h1><v-chip v-if="selected.manifest.version" size="small" variant="tonal">v{{ selected.manifest.version }}</v-chip></div>
          <code class="plugin-identifier">{{ selected.pluginId }}</code>
          <p v-if="selected.manifest.description" class="page-subtitle">{{ t(selected.manifest.description) }}</p>
        </div>
        <div class="plugin-row-state"><v-chip :color="statusColor(selected)" size="small" variant="tonal">{{ statusLabel(selected) }}</v-chip><v-switch :model-value="selected.enabled" :aria-label="`${t('启用插件')} ${pluginDisplayName(selected)}`" color="primary" hide-details density="compact" :loading="saving.has(selected.instanceId)" :disabled="saving.has(selected.instanceId)" @update:model-value="togglePlugin(selected, $event === true)" /></div>
      </section>
      <v-alert v-if="rowErrors[selected.instanceId]" type="error" variant="tonal" class="mb-5">{{ rowErrors[selected.instanceId] }}</v-alert>
      <v-alert v-if="selected.error" :type="selected.status === 'active' ? 'warning' : 'error'" variant="tonal" class="mb-5"><pre class="plugin-error">{{ errorText(selected.error) }}</pre></v-alert>
      <v-alert v-if="selected.missingCapabilities.length" type="warning" variant="tonal" class="mb-5">
        {{ t("缺少依赖") }}: {{ selected.missingCapabilities.join(", ") }}
      </v-alert>
      <section class="plugin-detail-section">
        <h2>{{ t("插件信息") }}</h2>
        <dl class="plugin-facts">
          <div><dt>{{ t("当前版本") }}</dt><dd>{{ selected.manifest.version || "—" }}</dd></div>
          <div><dt>{{ t("实例") }}</dt><dd><code>{{ selected.instanceId }}</code></dd></div>
          <div><dt>{{ t("运行位置") }}</dt><dd>{{ selected.manifest.hosts.join(" · ") || "—" }}</dd></div>
          <div><dt>{{ t("运行状态") }}</dt><dd>{{ statusLabel(selected) }}</dd></div>
        </dl>
      </section>
      <section class="plugin-detail-section">
        <h2>{{ t("提供的能力") }} <span class="plugin-count">{{ selected.manifest.capabilities.length }}</span></h2>
        <div v-if="selected.manifest.capabilities.length" class="plugin-capabilities"><v-chip v-for="capability in selected.manifest.capabilities" :key="capability" variant="tonal" size="small">{{ capability }}</v-chip></div>
        <p v-else class="text-medium-emphasis">{{ t("未声明能力") }}</p>
      </section>
    </template>

    <template v-else-if="loaded">
      <div class="plugin-list-heading"><h2>{{ t("已安装插件") }}</h2><span class="text-medium-emphasis">{{ plugins.length }} · {{ t("运行中") }} {{ activeCount }}</span></div>
      <div class="plugin-filters">
        <v-text-field v-model="query" :label="t('搜索插件')" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable @click:clear="query = ''" />
        <v-select v-model="status" :items="statusOptions" :label="t('运行状态')" variant="outlined" density="compact" hide-details class="plugin-status-filter" />
      </div>
      <ul class="plugin-list">
        <li v-for="plugin in visiblePlugins" :key="plugin.instanceId" class="plugin-list-row" :class="{ 'plugin-row-has-error': rowErrors[plugin.instanceId] || plugin.error }">
          <button class="plugin-open" type="button" :aria-label="`${t('查看插件')} ${pluginDisplayName(plugin)}`" @click="selectPlugin(plugin)">
            <span class="plugin-icon"><v-icon :icon="plugin.manifest.icon || 'mdi-puzzle-outline'" /></span>
            <span class="plugin-row-copy"><span class="plugin-name">{{ t(pluginDisplayName(plugin)) }}</span><span v-if="plugin.manifest.description" class="plugin-description">{{ t(plugin.manifest.description) }}</span></span>
          </button>
          <div class="plugin-row-state"><span v-if="plugin.manifest.version" class="plugin-version">v{{ plugin.manifest.version }}</span><v-chip :color="statusColor(plugin)" size="small" variant="tonal">{{ statusLabel(plugin) }}</v-chip><v-switch :model-value="plugin.enabled" :aria-label="`${t('启用插件')} ${pluginDisplayName(plugin)}`" color="primary" hide-details density="compact" :loading="saving.has(plugin.instanceId)" :disabled="saving.has(plugin.instanceId)" @update:model-value="togglePlugin(plugin, $event === true)" /></div>
          <p v-if="rowErrors[plugin.instanceId] || plugin.error" class="plugin-row-error" :class="plugin.status === 'active' && !rowErrors[plugin.instanceId] ? 'text-warning' : 'text-error'" role="alert">{{ rowErrors[plugin.instanceId] || errorText(plugin.error) }}</p>
        </li>
      </ul>
      <div v-if="!visiblePlugins.length" class="plugin-empty"><v-icon icon="mdi-puzzle-outline" size="36" /><p>{{ t(query || status !== 'all' ? "没有匹配的插件" : "没有可用的插件记录") }}</p></div>
    </template>
  </div>
</template>

<style scoped>
.plugins-page { max-width: 1140px; margin-inline: auto; }
.plugins-toolbar, .plugin-list-heading, .plugin-name-line { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.plugins-toolbar { margin-bottom: 28px; min-height: 64px; }
.plugins-back { margin-inline-start: -12px; }
.plugin-list-heading { justify-content: flex-start; margin-bottom: 16px; }
.plugin-list-heading h2, .plugin-detail-section h2 { font-size: 1rem; font-weight: 600; }
.plugin-filters { display: flex; gap: 12px; margin-bottom: 14px; }
.plugin-status-filter { max-width: 190px; }
.plugin-list { padding: 0; list-style: none; }
.plugin-list-row { display: flex; align-items: center; gap: 18px; padding-block: 18px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .1); }
.plugin-row-has-error { flex-wrap: wrap; }
.plugin-row-error { flex-basis: 100%; font-size: .85rem; }
.plugin-open { display: flex; flex: 1; align-items: center; gap: 16px; text-align: start; min-width: 0; border-radius: 8px; padding: 6px; margin: -6px; }
.plugin-open:hover { background: rgba(var(--v-theme-on-surface), .035); }
.plugin-open:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
.plugin-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 42px; height: 42px; border: 1px solid rgba(var(--v-theme-on-surface), .15); border-radius: 10px; color: rgb(var(--v-theme-primary)); }
.plugin-icon-large { flex-basis: 56px; height: 56px; border-radius: 14px; }
.plugin-row-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.plugin-name { font-weight: 600; overflow-wrap: anywhere; }
.plugin-description, .plugin-identifier, .plugin-version, .plugin-count { font-size: .8rem; color: rgba(var(--v-theme-on-surface), .6); }
.plugin-description, .plugin-identifier { overflow-wrap: anywhere; }
.plugin-row-state { display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
.plugin-detail-header { display: flex; align-items: flex-start; gap: 20px; margin-block: 14px 40px; }
.plugin-detail-title { flex: 1; min-width: 0; }
.plugin-name-line { justify-content: flex-start; flex-wrap: wrap; margin-bottom: 10px; }
.plugin-detail-title .page-title { overflow-wrap: anywhere; }
.plugin-detail-title .page-subtitle { margin-top: 12px; }
.plugin-detail-section { margin-bottom: 36px; }
.plugin-detail-section h2 { margin-bottom: 20px; }
.plugin-facts > div { display: flex; justify-content: space-between; gap: 20px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .12); padding-block: 18px; }
.plugin-facts dt { color: rgba(var(--v-theme-on-surface), .65); flex-shrink: 0; }
.plugin-facts dd { margin: 0; text-align: end; overflow-wrap: anywhere; }
.plugin-capabilities { display: flex; flex-wrap: wrap; gap: 8px; }
.plugin-count { margin-left: 8px; }
.plugin-error { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.plugin-empty { text-align: center; color: rgba(var(--v-theme-on-surface), .6); padding: 60px 16px; }
@media (max-width: 600px) {
  .plugin-filters { flex-direction: column; }
  .plugin-status-filter { max-width: none; }
  .plugin-list-row { align-items: flex-start; gap: 8px; }
  .plugin-row-state { flex-direction: column; align-items: flex-end; gap: 6px; }
  .plugin-detail-header { flex-wrap: wrap; gap: 12px; }
  .plugin-detail-title { flex-basis: calc(100% - 80px); }
}
</style>
