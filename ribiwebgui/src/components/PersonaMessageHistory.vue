<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { MessageHistoryChannelCatalog } from '@shared/personaHistoryChannels';
import { historyChannels } from '../personaHistoryChannels';
import { messageEndpointCatalog } from '../messageEndpoints/messageEndpointCatalog';
import { pluginCatalogStore } from '../pluginCatalogStore';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../i18n';
import { userFacingError } from '../userFacingError';
import { waitForChatHistoryFrame } from '../personaChatHistoryLayout';
import MessageEndpointHistory from './MessageEndpointHistory.vue';
import PersonaChatHistory from './PersonaChatHistory.vue';
import NapcatConversationHistory from './NapcatConversationHistory.vue';

const props = defineProps<{ roleId: string; version: number; messageVersion?:number }>();
const { fetch } = usePersonaService(), { t } = useI18n();
const catalog = ref<MessageHistoryChannelCatalog>({ adapters: [], chatCategories: [] });
const channels = computed(() => historyChannels(catalog.value,messageEndpointCatalog(pluginCatalogStore.settingsRenderers.value)));
const selected = ref(''), visited = ref(new Set<string>());
const error = ref(''), warnings = ref<string[]>([]), catalogLoading=ref(true);
const positions = new Map<string, number>();
let request: AbortController | undefined, layout: AbortController | undefined;
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
watch(() => props.roleId, () => { catalog.value = { adapters: [], chatCategories: [] }; positions.clear(); visited.value = new Set<string>(); selected.value = ''; void refreshCatalog(); }, { immediate: true });
watch(channels,list=>{
  const available=new Set(list.map(channel=>channel.id));
  visited.value=new Set([...visited.value].filter(id=>available.has(id)));
  for(const id of positions.keys())if(!available.has(id))positions.delete(id);
  if(!available.has(selected.value))selected.value=list[0]?.id??'';
});
watch(selected, async (id, previous) => {
  positions.set(previous, window.scrollY); visited.value.add(id);
  layout?.abort(); const controller = new AbortController(); layout = controller;
  const interrupt = () => controller.abort();
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  for (const event of events) window.addEventListener(event, interrupt, { passive: true });
  try {
    await nextTick();
    const target = positions.get(id) ?? 0;
    for (let frame = 0; frame < 8 && !controller.signal.aborted; frame++) {
      if (!await waitForChatHistoryFrame(controller.signal)) break;
      window.scrollTo(0, target);
    }
  } finally { for (const event of events) window.removeEventListener(event, interrupt); }
});
onBeforeUnmount(() => { request?.abort(); layout?.abort(); });
</script>

<template>
  <div>
    <div class="d-flex justify-end"><v-btn variant="text" prepend-icon="mdi-refresh" @click="refreshCatalog">{{ t('刷新渠道') }}</v-btn></div>
    <v-tabs v-model="selected" color="secondary" show-arrows class="history-channel-tabs mb-4" :aria-label="t('消息渠道')">
      <v-tab v-for="channel in channels" :key="channel.id" :value="channel.id" :prepend-icon="channel.icon">{{ t(channel.label) }}</v-tab>
    </v-tabs>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }} <v-btn variant="text" @click="refreshCatalog">{{ t('重试') }}</v-btn></v-alert>
    <v-alert v-if="!catalogLoading&&!channels.length&&!error" type="info" variant="tonal" class="mb-3">{{ t('请先在角色配置中添加消息端。') }}</v-alert>
    <v-alert v-for="warning in warnings" :key="warning" type="warning" variant="tonal" class="mb-3">{{ t(warning) }}</v-alert>
    <template v-for="channel in channels" :key="channel.id">
      <div v-if="visited.has(channel.id)" v-show="selected === channel.id" :data-history-channel="channel.id" role="tabpanel" :aria-label="t(channel.label)">
        <PersonaChatHistory v-if="channel.category" :role-id="roleId" :version="version" :active="selected===channel.id" :category="channel.category" />
        <NapcatConversationHistory v-else-if="channel.adapter==='napcat'" :role-id="roleId" :version="version" :active="selected===channel.id" :routes="catalog.qqRoutes??[]" :message-version="messageVersion" />
        <MessageEndpointHistory v-else-if="channel.adapter" :role-id="roleId" :adapter="channel.adapter" :title="channel.label" :version="version" :active="selected === channel.id" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.history-channel-tabs { position:sticky; top:64px; z-index:5; background:rgb(var(--v-theme-background)); }
.history-channel-tabs :deep(.v-tab) {text-transform:none;letter-spacing:normal;}
</style>
