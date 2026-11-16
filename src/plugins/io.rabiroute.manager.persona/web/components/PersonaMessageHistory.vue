<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { MessageHistoryChannelCatalog } from '@shared/personaHistoryChannels';
import { historyChannels } from '../../../../../ribiwebgui/src/personaHistoryChannels';
import { messageEndpointCatalog } from '../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCatalog';
import { pluginCatalogStore } from '../../../../../ribiwebgui/src/pluginCatalogStore';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { userFacingError } from '../../../../../ribiwebgui/src/userFacingError';
import EndpointConversationHistory from './EndpointConversationHistory.vue';
import PersonaTaskHistory from './PersonaTaskHistory.vue';
import NapcatConversationHistory from './NapcatConversationHistory.vue';
import PersonaAgentSessions from './PersonaAgentSessions.vue';
import PersonaSearchTestDialog from './PersonaSearchTestDialog.vue';

const props = defineProps<{ roleId: string; version: number; messageVersion?:number }>();
const { fetch } = usePersonaService(), { t } = useI18n();
const catalog = ref<MessageHistoryChannelCatalog>({ adapters: [], chatCategories: [] });
const channels = computed(() => historyChannels(catalog.value,messageEndpointCatalog(pluginCatalogStore.settingsRenderers.value)));
const selected = ref(''), visited = ref(new Set<string>());
const searchTestOpen = ref(false);
const error = ref(''), warnings = ref<string[]>([]), catalogLoading=ref(true);
let request: AbortController | undefined;
async function refreshCatalog() {
  request?.abort(); const controller = new AbortController(); request = controller;catalogLoading.value=true;
  try {
    const response = await fetch(`/api/roles/${encodeURIComponent(props.roleId)}/message-history-channels`, { signal: controller.signal });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.message || t('消息记录读取失败'));
    if (controller.signal.aborted) return;
    catalog.value = result.data; warnings.value = result.data.warnings ?? []; error.value = '';
  } catch (cause) { if (!controller.signal.aborted) error.value = userFacingError(cause); }
  finally {if(request===controller)catalogLoading.value=false;}
}
watch(() => props.version, refreshCatalog);
watch(() => props.roleId, () => { catalog.value = { adapters: [], chatCategories: [] }; visited.value = new Set<string>(); selected.value = ''; void refreshCatalog(); }, { immediate: true });
watch(channels,list=>{
  const available=new Set(list.map(channel=>channel.id));
  visited.value=new Set([...visited.value].filter(id=>available.has(id)));
  if(!available.has(selected.value))selected.value=list[0]?.id??'';
});
watch(selected, id => { visited.value.add(id); });
onBeforeUnmount(() => { request?.abort(); });
</script>

<template>
  <div class="persona-message-history">
    <div class="history-channel-toolbar d-flex justify-end flex-wrap ga-2"><v-btn variant="text" prepend-icon="mdi-magnify" @click="searchTestOpen = true">{{ t('搜索接口测试') }}</v-btn><v-btn variant="text" prepend-icon="mdi-refresh" @click="refreshCatalog">{{ t('刷新渠道') }}</v-btn></div>
    <PersonaSearchTestDialog v-model="searchTestOpen" :role-id="roleId" />
    <v-tabs v-model="selected" color="secondary" show-arrows class="history-channel-tabs mb-4" :aria-label="t('消息渠道')">
      <v-tab v-for="channel in channels" :key="channel.id" :value="channel.id" :prepend-icon="channel.icon">{{ t(channel.label) }}</v-tab>
    </v-tabs>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }} <v-btn variant="text" @click="refreshCatalog">{{ t('重试') }}</v-btn></v-alert>
    <v-alert v-if="!catalogLoading&&!channels.length&&!error" type="info" variant="tonal" class="mb-3">{{ t('请先在角色配置中添加消息端。') }}</v-alert>
    <v-alert v-for="warning in warnings" :key="warning" type="warning" variant="tonal" class="mb-3">{{ t(warning) }}</v-alert>
    <template v-for="channel in channels" :key="channel.id">
      <div v-if="visited.has(channel.id)" v-show="selected === channel.id" class="history-channel-panel" :data-history-channel="channel.id" role="tabpanel" :aria-label="t(channel.label)">
        <PersonaAgentSessions v-if="channel.agentSessions" :role-id="roleId" :active="selected===channel.id" />
        <PersonaTaskHistory v-else-if="channel.category" :role-id="roleId" :version="version" :active="selected===channel.id" :category="channel.category" />
        <NapcatConversationHistory v-else-if="channel.adapter==='napcat'" :role-id="roleId" :version="version" :active="selected===channel.id" :routes="catalog.qqRoutes??[]" :message-version="messageVersion" />
        <EndpointConversationHistory v-else-if="channel.adapter" :role-id="roleId" :adapter="channel.adapter" :title="channel.label" :version="version" :message-version="messageVersion" :active="selected === channel.id" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.persona-message-history{display:flex;flex-direction:column;min-height:0;min-width:0;height:100%;}
.history-channel-toolbar,.history-channel-tabs{flex:none;}
.history-channel-panel{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;}
.history-channel-tabs { position:sticky; top:64px; z-index:5; background:rgb(var(--v-theme-background)); }
.history-channel-tabs :deep(.v-tab) {text-transform:none;letter-spacing:normal;}
</style>
