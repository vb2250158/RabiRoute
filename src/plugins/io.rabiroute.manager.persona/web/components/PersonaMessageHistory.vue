<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { MessageHistoryChannelCatalog } from '@shared/personaHistoryChannels';
import { historyChannels } from '../../../../../ribiwebgui/src/personaHistoryChannels';
import { messageEndpointCatalog } from '../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCatalog';
import { pluginCatalogStore } from '../../../../../ribiwebgui/src/pluginCatalogStore';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { userFacingError } from '../../../../../ribiwebgui/src/userFacingError';
import { previewAccessDenied, readPreview, writePreview } from '../../../../../ribiwebgui/src/readPreviewCache';
import EndpointConversationHistory from './EndpointConversationHistory.vue';
import PersonaTaskHistory from './PersonaTaskHistory.vue';
import NapcatConversationHistory from './NapcatConversationHistory.vue';
import PersonaAgentSessions from './PersonaAgentSessions.vue';
import PersonaSearchTestDialog from './PersonaSearchTestDialog.vue';
import PersonaRoleTimeline from './PersonaRoleTimeline.vue';

const props = defineProps<{ roleId: string; version: number; messageVersion: number; catalogVersion: number; captureVersion: number }>();
const { fetch, deviceId } = usePersonaService(), { t } = useI18n();
const route = useRoute(), router = useRouter();
const recordingOpen = computed(() => route.query.tab === 'all-day-recording');
const recordingLocation = computed(() => ({ query: { ...route.query, tab: 'all-day-recording' } }));
function selectChannel(channelId: string) {
  selected.value = channelId;
  if (!recordingOpen.value) return;
  const query = { ...route.query };
  delete query.tab;
  void router.push({ query });
}
const catalog = ref<MessageHistoryChannelCatalog>({ adapters: [], chatCategories: [] });
const channels = computed(() => historyChannels(catalog.value,messageEndpointCatalog(pluginCatalogStore.settingsRenderers.value)));
const selected = ref(''), visited = ref(new Set<string>());
const timelineSource = ref('all');
const timelineFilters = computed(() => [
  { value: 'all', title: t('全部'), source: undefined },
  ...channels.value.filter(channel => channel.adapter || channel.category)
    .map(channel => ({ value: channel.id, title: t(channel.label), source: channel })),
  { value: 'capture', title: t('画面采集'), source: 'capture' as const },
]);
const timelineFilter = computed(() => timelineFilters.value.find(option => option.value === timelineSource.value) ?? timelineFilters.value[0]!);
const searchTestOpen = ref(false);
const error = ref(''), warnings = ref<string[]>([]), catalogLoading=ref(true);
const catalogPreview = ref(false);
const previewKey = () => ['message-channels', deviceId, props.roleId];
let request: AbortController | undefined;
async function refreshCatalog() {
  request?.abort(); const controller = new AbortController(); request = controller;catalogLoading.value=true;
  const key = previewKey();
  try {
    const response = await fetch(`/api/roles/${encodeURIComponent(props.roleId)}/message-history-channels`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (previewAccessDenied(response.status)) {
      catalog.value = { adapters: [], chatCategories: [] };
      catalogPreview.value = false;
      writePreview(key, undefined);
    }
    const result = await response.json();
    if (controller.signal.aborted) return;
    if (!response.ok || result.code !== 0) throw new Error(result.message || t('消息记录读取失败'));
    catalog.value = result.data; warnings.value = result.data.warnings ?? []; error.value = '';
    catalogPreview.value = false;
    writePreview(key, { adapters: catalog.value.adapters, chatCategories: catalog.value.chatCategories });
  } catch (cause) { if (!controller.signal.aborted) error.value = userFacingError(cause); }
  finally {if(request===controller)catalogLoading.value=false;}
}
watch(() => props.catalogVersion, refreshCatalog);
watch(() => props.roleId, () => {
  const cached = readPreview<MessageHistoryChannelCatalog>(previewKey());
  catalog.value = cached ?? { adapters: [], chatCategories: [] };
  catalogPreview.value = Boolean(cached);
  visited.value = new Set<string>();
  selected.value = '';
  void refreshCatalog();
}, { immediate: true });
watch(channels,list=>{
  const available=new Set(list.map(channel=>channel.id));
  visited.value=new Set([...visited.value].filter(id=>available.has(id)));
  if(!available.has(selected.value))selected.value=list[0]?.id??'';
});
watch(timelineFilter, option => { timelineSource.value = option.value; });
watch(selected, id => { visited.value.add(id); });
onBeforeUnmount(() => { request?.abort(); });
</script>

<template>
  <div class="persona-message-history">
    <div class="history-channel-header">
      <v-tabs :model-value="recordingOpen ? null : selected" :mandatory="recordingOpen ? false : 'force'" @update:model-value="value => { if (typeof value === 'string') selectChannel(value); }" color="secondary" show-arrows class="history-channel-tabs" :aria-label="t('消息渠道')">
        <v-tab v-for="channel in channels" :key="channel.id" :value="channel.id" :prepend-icon="channel.icon">{{ t(channel.label) }}</v-tab>
      </v-tabs>
      <div class="history-channel-toolbar">
        <v-btn variant="text" prepend-icon="mdi-magnify" :aria-label="t('搜索接口测试')" :title="t('搜索接口测试')" @click="searchTestOpen = true">
          <span class="history-channel-action-label">{{ t('搜索接口测试') }}</span>
        </v-btn>
        <v-btn v-if="!recordingOpen" variant="text" prepend-icon="mdi-timeline-clock-outline" :aria-label="t('全天记录')" :title="t('全天记录')" :to="recordingLocation">
          <span class="history-channel-action-label">{{ t('全天记录') }}</span>
        </v-btn>
        <v-select v-else v-model="timelineSource" :items="timelineFilters" :label="t('来源')" variant="outlined"
          density="compact" hide-details class="history-timeline-filter" />
      </div>
    </div>
    <p v-if="catalogPreview" class="text-caption text-medium-emphasis">{{ t('上次读取') }}</p>
    <PersonaSearchTestDialog v-model="searchTestOpen" :role-id="roleId" />
    <div v-if="recordingOpen" class="history-recording-panel">
      <PersonaRoleTimeline :key="timelineFilter.value" :role-id="roleId" :version="version" :message-version="messageVersion" :capture-version="captureVersion" :source-filter="timelineFilter.source" :channels="channels" />
    </div>
    <v-alert v-if="!recordingOpen && error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="!recordingOpen&&!catalogLoading&&!channels.length&&!error" type="info" variant="tonal" class="mb-3">{{ t('请先在角色配置中添加消息端。') }}</v-alert>
    <v-alert v-for="warning in recordingOpen ? [] : warnings" :key="warning" type="warning" variant="tonal" class="mb-3">{{ t(warning) }}</v-alert>
    <template v-for="channel in channels" :key="channel.id">
      <div v-if="visited.has(channel.id)" v-show="!recordingOpen && selected === channel.id" class="history-channel-panel" :data-history-channel="channel.id" role="tabpanel" :aria-label="t(channel.label)">
        <PersonaAgentSessions v-if="channel.agentSessions" :role-id="roleId" :active="!recordingOpen && selected === channel.id" />
        <PersonaTaskHistory v-else-if="channel.category" :role-id="roleId" :version="version" :active="!recordingOpen && selected === channel.id" :category="channel.category" />
        <NapcatConversationHistory v-else-if="channel.adapter==='napcat'" :role-id="roleId" :version="catalogVersion" :active="!recordingOpen && selected === channel.id" :routes="catalog.qqRoutes??[]" :message-version="messageVersion" />
        <EndpointConversationHistory v-else-if="channel.adapter" :role-id="roleId" :adapter="channel.adapter" :title="channel.label" :version="catalogVersion" :message-version="messageVersion" :active="!recordingOpen && selected === channel.id" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.persona-message-history{display:flex;flex-direction:column;min-height:0;min-width:0;height:100%;}
.history-channel-header{display:flex;align-items:center;gap:8px;flex:none;min-width:0;margin-bottom:16px;position:sticky;top:var(--v-layout-top, 0px);z-index:5;background:rgb(var(--v-theme-background));}
.history-channel-tabs{flex:1;min-width:0;}
.history-channel-toolbar{display:flex;align-items:center;gap:8px;flex:none;}
.history-timeline-filter{width:clamp(115px,20vw,210px);}
.history-channel-panel{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;}
.history-recording-panel{flex:1;min-height:0;min-width:0;overflow:auto;}
.history-channel-tabs :deep(.v-tab) {text-transform:none;letter-spacing:normal;}
@media(max-width:760px){
  .history-channel-header,.history-channel-toolbar{gap:4px;}
  .history-channel-action-label{display:none;}
  .history-channel-toolbar :deep(.v-btn){min-width:36px;width:36px;padding:6px;}
  .history-channel-toolbar :deep(.v-btn__prepend){margin-inline:0;}
}
</style>
