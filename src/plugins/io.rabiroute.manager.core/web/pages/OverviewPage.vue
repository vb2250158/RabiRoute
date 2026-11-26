<script setup lang="ts">
import { translateText, useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { useRoleStore, type RoleSummary } from "../../../../../ribiwebgui/src/stores/roleStore";
import PersonaAvatar from "../../../../../ribiwebgui/src/components/PersonaAvatar.vue";
import MessageConnectorIcon from "../../../io.rabiroute.manager.message-adapter-control/web/components/MessageConnectorIcon.vue";
import { messageEndpointCatalog } from "../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCatalog";
import { registerPageSaveAction } from "../../../../../ribiwebgui/src/pageSaveAction";
import { pluginCatalogStore } from "../../../../../ribiwebgui/src/pluginCatalogStore";
import { roleConfigPath } from "../../../../../ribiwebgui/src/roleScopedNavigation";
import { routeScopedAdaptersPath } from "../../../../../ribiwebgui/src/routeScopedNavigation";
import type { GatewayDefinition } from "../../../../../ribiwebgui/src/types";
import { adapterLabel, gatewayAdapterTypes } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { personaSourceKey } from "../../../io.rabiroute.manager.persona/web/persona/personaSourcePresentation";
import { RemotePersonaReadError, remotePersonaClient, type PersonaSourceDevice } from "../../../io.rabiroute.manager.persona/web/persona/remotePersonaReference";
import { getTimeoutMs } from "../../../../../ribiwebgui/src/timeoutSettingsClient";
import { readPreview, writePreview } from "../../../../../ribiwebgui/src/readPreviewCache";

const store = useGatewayStore();
const roles = useRoleStore();
const { t } = useI18n();
const devicePreviewKey = ["role-catalog-computers"];
const cachedDevices = ref<Pick<PersonaSourceDevice, "deviceId" | "name">[]>(readPreview(devicePreviewKey) ?? []);
const devices = ref<PersonaSourceDevice[]>([]);
const devicesLoading = ref(false);
const devicesError = ref("");
let discovery: AbortController | undefined;
const gatewayActionId = ref("");
const gatewayActionError = ref("");
const deletingGatewayId = ref("");

type RoleCard = { key: string; role?: RoleSummary; routes: GatewayDefinition[] };

const computers = computed(() => {
  const name = store.meta.rabiName?.trim() || store.meta.computerName?.trim();
  return [
    { source: "", title: name ? `${t("本机")} · ${name}` : t("本机"), unavailable: "", trusted: true },
    ...devices.value
      .filter(device => personaSourceKey(store.meta, device.deviceId))
      .map(device => ({
        source: device.deviceId,
        title: device.name,
        trusted: device.trusted,
        unavailable: !device.online ? "离线" : !device.trusted ? "未连接" : !device.supported ? "在线 · 需要更新" : ""
      })),
    ...cachedDevices.value
      .filter(device => personaSourceKey(store.meta, device.deviceId))
      .map(device => ({ source: device.deviceId, title: device.name, unavailable: "上次读取", trusted: true }))
  ];
});

const groups = computed(() => {
  const computerGroups = computers.value.map(computer => {
    const catalog = roles.catalogFor(computer.source);
    const cards: RoleCard[] = computer.trusted ? catalog.items.map(role => ({ key: role.roleId, role, routes: [] })) : [];
    return { ...computer, catalog, cards, byRoleId: new Map(cards.map(card => [card.key, card])) };
  });
  const bySource = new Map(computerGroups.map(group => [group.source, group]));
  const otherRoutes: RoleCard[] = [];
  for (const gateway of store.gateways) {
    const source = personaSourceKey(store.meta, gateway.agentRoleDeviceId || "");
    const group = bySource.get(source);
    const card = group?.byRoleId.get(gateway.agentRoleId || "");
    if (card) card.routes.push(gateway);
    else if (!gateway.agentRoleId || (group ? group.catalog.loaded || group.catalog.error || group.unavailable : !devicesLoading.value)) {
      otherRoutes.push({ key: gateway.id, routes: [gateway] });
    }
  }
  return [...computerGroups, ...(otherRoutes.length ? [{
    source: null, title: t("其他路由"), unavailable: "", catalog: null, cards: otherRoutes
  }] : [])];
});

const endpointCatalog = computed(() => new Map(
  messageEndpointCatalog(pluginCatalogStore.settingsRenderers.value).map(item => [item.type, item])
));
const fallbackIcons: Readonly<Record<string, string>> = {
  heartbeat: "mdi-clock-outline",
  remoteAgent: "mdi-robot-outline",
  speech: "mdi-microphone-outline",
  wearable: "mdi-watch"
};

function loadComputer(source: string, force: boolean, signal?: AbortSignal): Promise<void> {
  const remoteSignal = signal && AbortSignal.any([signal, AbortSignal.timeout(getTimeoutMs("webgui.persona.remote", 25000))]);
  const options = { signal: source ? remoteSignal : undefined, connect: false };
  const read = force ? roles.loadCatalog(source, options) : roles.ensureCatalog(source, options);
  // Each catalog has its own status and retry. One failure does not affect the other computers.
  return read.catch(() => {});
}

async function loadComputers(force = false): Promise<void> {
  discovery?.abort();
  const controller = new AbortController();
  discovery = controller;
  const { signal } = controller;
  void loadComputer("", force);
  devicesLoading.value = true;
  devicesError.value = "";
  try {
    const peers = await remotePersonaClient.catalogDevices(signal);
    signal.throwIfAborted();
    const trustedPeers = peers.filter(peer => peer.trusted && personaSourceKey(store.meta, peer.deviceId));
    const trustedIds = new Set(trustedPeers.map(peer => peer.deviceId));
    for (const device of [...cachedDevices.value, ...devices.value]) {
      if (!trustedIds.has(device.deviceId)) roles.forgetCatalogPreview(device.deviceId);
    }
    devices.value = peers;
    cachedDevices.value = [];
    writePreview(devicePreviewKey, trustedPeers.map(({ deviceId, name }) => ({ deviceId, name })));
  } catch (error) {
    if (!signal.aborted) {
      if (error instanceof RemotePersonaReadError && error.state === "unauthorized") {
        for (const device of [...cachedDevices.value, ...devices.value]) roles.forgetCatalogPreview(device.deviceId);
        cachedDevices.value = [];
        devices.value = [];
        writePreview(devicePreviewKey, undefined);
      }
      devicesError.value = userFacingError(error);
    }
    return;
  } finally {
    if (!signal.aborted) devicesLoading.value = false;
  }

  const sources = computers.value.filter(computer => computer.source && !computer.unavailable);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
    while (!signal.aborted && next < sources.length) {
      const source = sources[next++].source;
      await loadComputer(source, force, signal);
    }
  }));
}

roles.restoreCatalogPreview("");
for (const device of cachedDevices.value) roles.restoreCatalogPreview(device.deviceId);
onMounted(() => void loadComputers());
watch(() => roles.catalogRefreshRevision, () => void loadComputers(true));
watch(() => store.meta.managerInstanceId, (_id, previous) => {
  if (!previous) return;
  devices.value = [];
  cachedDevices.value = [];
  void loadComputers();
});
onBeforeUnmount(() => discovery?.abort());

onBeforeUnmount(registerPageSaveAction({
  dirty: computed(() => store.dirty),
  ready: computed(() => !store.loading),
  saving: computed(() => store.saving),
  save: () => store.saveChangedRoutes()
}));

async function runGatewayAction(id: string, action: "start" | "stop" | "restart"): Promise<void> {
  if (!id || gatewayActionId.value) return;
  gatewayActionId.value = `${id}:${action}`;
  gatewayActionError.value = "";
  try {
    await store.actionGateway(id, action);
  } catch (error) {
    gatewayActionError.value = userFacingError(error);
  } finally {
    window.setTimeout(() => {
      gatewayActionId.value = "";
    }, action === "restart" ? 1000 : 700);
  }
}

async function deleteGateway(gateway: GatewayDefinition): Promise<void> {
  if (deletingGatewayId.value) return;
  const name = store.configNameFor(gateway);
  const confirmed = window.confirm(translateText(`删除路由配置「${name}」？\n\n只会删除 adapterConfig.json 并停止该路由，历史消息和日志会保留在路由目录里。`));
  if (!confirmed) return;
  deletingGatewayId.value = gateway.id;
  gatewayActionError.value = "";
  try {
    await store.deleteGateway(gateway.id);
  } catch (error) {
    gatewayActionError.value = userFacingError(error);
  } finally {
    deletingGatewayId.value = "";
  }
}

</script>

<template>
  <div class="page-shell role-list-page">
    <div class="page-header">
      <h1 class="page-title">{{ t("角色列表") }}</h1>
    </div>

    <v-alert v-if="gatewayActionError" type="error" variant="tonal">{{ gatewayActionError }}</v-alert>
    <section v-for="group in groups" :key="group.source ?? 'other-routes'" class="role-computer-group">
        <header class="role-computer-heading">
          <h2 data-no-i18n>{{ group.title }}</h2>
          <span v-if="group.unavailable || group.catalog?.cached">{{ t(group.unavailable || "上次读取") }}</span>
        </header>
        <v-progress-linear v-if="group.catalog && !group.cards.length && !group.unavailable && (group.catalog.loading || (!group.catalog.loaded && !group.catalog.error))" indeterminate color="secondary" :aria-label="t('加载中')" />
        <v-alert v-if="group.catalog?.error && !group.unavailable" :type="group.catalog.partial ? 'warning' : 'error'" variant="tonal" density="compact">
          {{ group.catalog.error }}
          <v-btn variant="text" size="small" @click="loadComputer(group.source ?? '', true, discovery?.signal)">{{ t("重试") }}</v-btn>
        </v-alert>
        <div v-if="group.catalog?.loaded && !group.cards.length && !group.unavailable" class="role-computer-empty">{{ t("暂无角色") }}</div>
        <div v-if="group.cards.length" class="route-card-grid">
          <v-card
            v-for="card in group.cards"
            :key="card.key"
            class="app-card glass-card route-card"
          >
            <component
              :is="card.role && !card.role.error && !group.unavailable ? 'RouterLink' : 'div'"
              :to="card.role && !card.role.error && !group.unavailable ? { path: roleConfigPath(card.role.roleId), query: group.source ? { source: group.source } : {} } : undefined"
              class="route-card-identity"
            >
              <PersonaAvatar :role-id="card.role?.roleId || card.routes[0]?.agentRoleId || ''" :avatar-url="card.role?.avatarUrl" :size="42" />
              <div class="route-card-copy">
                <div class="route-card-title" data-no-i18n :title="card.role?.title || card.role?.roleId || store.configNameFor(card.routes[0])">{{ card.role?.title || card.role?.roleId || store.configNameFor(card.routes[0]) }}</div>
                <div v-if="card.role?.error" class="route-card-subtitle" :title="card.role.error">{{ card.role.error }}</div>
                <div v-else-if="card.role && card.role.title !== card.role.roleId" class="route-card-subtitle" data-no-i18n>{{ card.role.roleId }}</div>
                <div v-else-if="!card.role && card.routes[0]?.agentRoleId" class="route-card-subtitle" data-no-i18n>{{ card.routes[0].agentRoleId }}</div>
              </div>
              <v-icon v-if="!card.routes.length && card.role && !card.role.error && !group.unavailable" class="ms-auto" icon="mdi-chevron-right" size="20" aria-hidden="true" />
            </component>
            <div v-if="card.routes.length" class="route-card-tools">
              <div class="route-card-connector-summary">
                <span
                  v-for="type in new Set(card.routes.flatMap(gatewayAdapterTypes))"
                  :key="type"
                  :title="t(endpointCatalog.get(type)?.title || adapterLabel(type))"
                  :aria-label="t(endpointCatalog.get(type)?.title || adapterLabel(type))"
                  role="img"
                >
                  <MessageConnectorIcon :endpoint="type" :fallback="endpointCatalog.get(type)?.icon || fallbackIcons[type] || 'mdi-connection'" :size="20" />
                </span>
              </div>
              <v-menu location="bottom end" :close-on-content-click="false">
                <template #activator="{ props }">
                  <v-btn
                    v-bind="props"
                    icon="mdi-dots-horizontal"
                    variant="text"
                    size="small"
                    :title="t('路由操作')"
                    :aria-label="t('路由操作')"
                  />
                </template>
                <v-card class="route-card-menu">
                  <div v-for="gw in card.routes" :key="gw.id" class="route-card-route">
                    <div class="route-card-subtitle route-card-route-name" data-no-i18n>{{ store.configNameFor(gw) }}</div>
                    <div v-if="gatewayAdapterTypes(gw).length" class="route-card-connectors">
                      <span
                        v-for="type in gatewayAdapterTypes(gw)"
                        :key="type"
                        :title="t(endpointCatalog.get(type)?.title || adapterLabel(type))"
                        :aria-label="t(endpointCatalog.get(type)?.title || adapterLabel(type))"
                        role="img"
                      >
                        <MessageConnectorIcon :endpoint="type" :fallback="endpointCatalog.get(type)?.icon || fallbackIcons[type] || 'mdi-connection'" :size="26" />
                      </span>
                    </div>
                    <div class="route-card-actions">
                      <v-btn
                        icon="mdi-restart"
                        size="small"
                        variant="text"
                        :title="t('重启此路由')"
                        :aria-label="t('重启此路由')"
                        :loading="gatewayActionId === `${gw.id}:restart`"
                        :disabled="Boolean(gatewayActionId)"
                        @click="runGatewayAction(gw.id, 'restart')"
                      />
                      <v-btn
                        icon="mdi-connection"
                        size="small"
                        variant="text"
                        :title="t('打开消息连接器配置')"
                        :aria-label="t('打开消息连接器配置')"
                        :to="routeScopedAdaptersPath(store.configNameFor(gw))"
                      />
                      <v-btn
                        icon="mdi-delete"
                        size="small"
                        variant="text"
                        color="error"
                        :title="t('删除路由配置')"
                        :aria-label="t('删除路由配置')"
                        :loading="deletingGatewayId === gw.id"
                        :disabled="Boolean(deletingGatewayId)"
                        @click="deleteGateway(gw)"
                      />
                    </div>
                  </div>
                </v-card>
              </v-menu>
            </div>
          </v-card>
        </div>
    </section>
    <v-progress-linear v-if="devicesLoading && !devices.length" indeterminate color="secondary" :aria-label="t('加载中')" />
    <v-alert v-if="devicesError" type="warning" variant="tonal" density="compact">
      {{ devicesError }}
      <v-btn variant="text" size="small" @click="loadComputers(true)">{{ t("重试") }}</v-btn>
    </v-alert>
  </div>
</template>

<style scoped>
.role-list-page {
  container-type: inline-size;
}

.route-card-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}

@container (min-width: 620px) {
  .route-card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@container (min-width: 940px) {
  .route-card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

.role-computer-group {
  display: grid;
  gap: 10px;
}

.role-computer-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  color: var(--rr-muted-soft);
  font-size: 12px;
}

.role-computer-heading h2 {
  margin: 0;
  font-size: 16px;
  color: var(--rr-heading);
  overflow-wrap: anywhere;
}

.role-computer-empty {
  color: var(--rr-muted-soft);
  font-size: 13px;
}

.route-card,
.route-card-identity,
.route-card-tools,
.route-card-connector-summary,
.route-card-connectors,
.route-card-actions {
  display: flex;
  align-items: center;
  min-width: 0;
}

.route-card {
  gap: 8px;
  min-height: 76px;
  padding: 16px !important;
}

.route-card-identity {
  flex: 1 1 0;
  gap: 12px;
  color: inherit;
  text-decoration: none;
}

a.route-card-identity:hover .route-card-title,
a.route-card-identity:focus-visible .route-card-title {
  color: rgb(var(--v-theme-secondary));
}

.route-card-title,
.route-card-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.route-card-copy {
  min-width: 0;
}

.route-card-title {
  color: var(--rr-heading);
  font-size: 16px;
  font-weight: 600;
  line-height: 20px;
}

.route-card-subtitle {
  margin-top: 3px;
  color: var(--rr-muted-soft);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}

.route-card-tools {
  flex: 0 1 auto;
  gap: 4px;
}

.route-card-connector-summary {
  max-width: 68px;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}

.route-card-connector-summary > span {
  flex: 0 0 auto;
}

.route-card-menu {
  width: min(270px, calc(100vw - 32px));
  max-height: 60vh;
  overflow: auto;
}

.route-card-route {
  display: grid;
  gap: 6px;
  padding: 12px;
}

.route-card-route + .route-card-route {
  border-top: 1px solid rgba(var(--v-theme-on-surface), .12);
}

.route-card-route-name {
  white-space: normal;
  overflow-wrap: anywhere;
}

.route-card-connectors {
  gap: 6px;
  flex-wrap: wrap;
}

.route-card-actions {
  gap: 4px;
}
</style>
