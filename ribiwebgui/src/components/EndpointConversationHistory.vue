<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { QqConversation } from '@shared/qqConversationHistory';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../i18n';
import { userFacingError } from '../userFacingError';
import HistoryConversationLayout from './HistoryConversationLayout.vue';
import { endpointHistoryTime } from '../historyConversationPresentation';
import MessageEndpointHistory from './MessageEndpointHistory.vue';
import QqReadNotice from './QqReadNotice.vue';
const props=defineProps<{roleId:string;adapter:string;title:string;version:number;messageVersion?:number;active:boolean}>();
const {fetch}=usePersonaService(),{t}=useI18n();
const conversations=ref<QqConversation[]>([]),selectedKey=ref(''),search=ref(''),cursor=ref<string|null>(null),loading=ref(false),error=ref('');
const selected=computed(()=>conversations.value.find(item=>item.conversationKey===selectedKey.value));
const items=computed(()=>conversations.value.filter(item=>!search.value||(item.title||item.target).toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).map(item=>({key:item.conversationKey,title:item.title||item.target,preview:item.preview,time:endpointHistoryTime(item.time),subtitle:item.instanceId})));
let request:AbortController|undefined;
async function load(more=false){
  request?.abort();const controller=new AbortController();request=controller;loading.value=true;
  try{
    const query=new URLSearchParams({adapter:props.adapter});if(more&&cursor.value)query.set('cursor',cursor.value);
    const response=await fetch(`/api/roles/${encodeURIComponent(props.roleId)}/message-history-conversations?${query}`,{signal:controller.signal});
    const result=await response.json();if(!response.ok||result.code!==0)throw new Error(result.message||t('消息记录读取失败'));if(controller.signal.aborted)return;
    const rows=result.data.conversations as QqConversation[];
    conversations.value=[...new Map([...conversations.value,...rows].map(row=>[row.conversationKey,row])).values()].sort((a,b)=>b.time-a.time);
    cursor.value=result.data.nextConversationCursor;error.value='';
    if(!selectedKey.value&&conversations.value.length)selectedKey.value=conversations.value[0]!.conversationKey;
  }catch(cause){if(!controller.signal.aborted)error.value=userFacingError(cause);}
  finally{if(request===controller){request=undefined;loading.value=false;}}
}
watch(()=>[props.version,props.messageVersion,props.active] as const,()=>{if(props.active)void load();else request?.abort();},{immediate:true});
onBeforeUnmount(()=>request?.abort());
</script>
<template>
  <HistoryConversationLayout :items="items" v-model:search="search" :selected="selectedKey" :loading="loading" :has-details="Boolean(selected)" details-title="会话与来源" @select="selectedKey=$event">
    <template #list-actions><v-btn icon="mdi-refresh" size="small" variant="text" :aria-label="t('刷新会话')" @click="load()" /></template>
    <template #list-notice><QqReadNotice v-if="error" summary="会话暂时无法更新，已有记录仍可查看。" :detail="error" @retry="load()" /></template>
    <template #list-footer><v-btn v-if="cursor" variant="text" :disabled="loading" @click="load(true)">{{t('更多会话')}}</v-btn></template>
    <KeepAlive :max="12"><MessageEndpointHistory v-if="selected" :key="selected.conversationKey" :role-id="roleId" :adapter="adapter" :title="selected.title||selected.target" :conversation-key="selected.conversationKey" :version="version" :message-version="messageVersion" :active="active" bubble /></KeepAlive>
    <div v-if="!selected&&!loading" class="pa-4 text-medium-emphasis">{{t('选择会话查看消息记录。')}}</div>
    <template #details><div class="text-subtitle-2 mb-3">{{t('会话与来源')}}</div><div data-no-i18n>{{title}}</div><div class="mt-3 text-caption" data-no-i18n>{{selected?.gatewayId}}</div><div class="mt-2 text-caption" data-no-i18n>{{selected?.instanceId}}</div><details class="mt-3 text-caption"><summary>ID</summary><div class="endpoint-identity" data-no-i18n>{{selected?.conversationKey}}</div></details></template>
  </HistoryConversationLayout>
</template>
<style scoped>.endpoint-identity{overflow-wrap:anywhere;}</style>
