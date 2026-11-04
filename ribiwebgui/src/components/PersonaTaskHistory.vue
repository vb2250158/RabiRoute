<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ChatHistoryCategory } from '@shared/personaHistoryChannels';
import type { PersonaHistoryTask, PersonaHistoryTaskPage } from '@shared/personaChatHistory';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../i18n';
import { userFacingError } from '../userFacingError';
import HistoryConversationLayout from './HistoryConversationLayout.vue';
import PersonaChatHistory from './PersonaChatHistory.vue';
import QqReadNotice from './QqReadNotice.vue';
import { mergeHistoryTaskPage } from '../historyConversationPresentation';
const props=defineProps<{roleId:string;category:ChatHistoryCategory;version:number;active:boolean}>();
const {fetch}=usePersonaService(),{t}=useI18n();
const tasks=ref<PersonaHistoryTask[]>([]),peers=ref<PersonaHistoryTask[]>([]),selectedKey=ref(''),search=ref('');
const cursor=ref<string|null>(null),peerCursor=ref<string|null>(null),loading=ref(false),peerLoading=ref(false),error=ref(''),peerError=ref('');
const selected=computed(()=>tasks.value.find(task=>task.key===selectedKey.value));
const subtitle=(task:PersonaHistoryTask)=>(task.owner?.nodeName||task.owner?.nodeId||t('本机'))+' · '+task.sessionId.slice(0,8);
const items=computed(()=>tasks.value.map(task=>({key:task.key,title:task.title,preview:task.preview,time:task.receivedAt,subtitle:subtitle(task)})));
const positions=new Map<string,number>();
let request:AbortController|undefined,peerRequest:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined,catalogQuery='';
let catalogPages:PersonaHistoryTask[]=[];
async function read(query:URLSearchParams,signal:AbortSignal){
  const response=await fetch(`/api/roles/${encodeURIComponent(props.roleId)}/chat-history/tasks?${query}`,{signal});
  const result=await response.json();if(!response.ok||result.code!==0)throw new Error(result.message||t('消息记录读取失败'));
  return result.data as PersonaHistoryTaskPage;
}
async function load(more=false){
  request?.abort();const controller=new AbortController();request=controller;loading.value=true;
  try{
    const query=new URLSearchParams({category:props.category,limit:'50'});if(search.value.trim())query.set('query',search.value.trim());if(more&&cursor.value)query.set('cursor',cursor.value);
    const data=await read(query,controller.signal);if(controller.signal.aborted)return;
    const sameQuery=catalogQuery===search.value.trim();
    const pageItems=more?mergeHistoryTaskPage(catalogPages,data.items,true):data.items.slice();
    const values=more||sameQuery?mergeHistoryTaskPage(tasks.value,pageItems,false):pageItems.slice();
    // A search may hide the open task; keep its identity until the user chooses another task.
    if(selected.value&&!values.some(task=>task.key===selectedKey.value))values.push(selected.value);
    tasks.value=values;
    // The cursor follows the continuous API prefix, not the retained display-only tail.
    catalogPages=pageItems;cursor.value=data.nextCursor;
    catalogQuery=search.value.trim();error.value='';
    if(!selectedKey.value&&tasks.value.length)selectedKey.value=tasks.value[0]!.key;
  }catch(cause){if(!controller.signal.aborted)error.value=userFacingError(cause);}
  finally{if(request===controller){request=undefined;loading.value=false;}}
}
async function loadPeers(more=false){
  peerRequest?.abort();if(!selectedKey.value)return;const controller=new AbortController();peerRequest=controller;peerLoading.value=true;
  const key=selectedKey.value;
  try{
    const query=new URLSearchParams({category:props.category,peerOf:key,limit:'50'});if(more&&peerCursor.value)query.set('cursor',peerCursor.value);
    const data=await read(query,controller.signal);if(controller.signal.aborted||key!==selectedKey.value)return;
    peers.value=[...new Map((more?[...peers.value,...data.items]:data.items).map(task=>[task.key,task])).values()];peerCursor.value=data.nextCursor;peerError.value='';
  }catch(cause){if(!controller.signal.aborted)peerError.value=userFacingError(cause);}
  finally{if(peerRequest===controller){peerRequest=undefined;peerLoading.value=false;}}
}
async function choose(key:string){
  if(key===selectedKey.value)return;positions.set(selectedKey.value,window.scrollY);
  selectedKey.value=key;await nextTick();window.scrollTo(0,positions.get(key)??0);
}
function choosePeer(task:PersonaHistoryTask){if(!tasks.value.some(item=>item.key===task.key))tasks.value.push(task);void choose(task.key);}
watch(selectedKey,()=>{peers.value=[];peerCursor.value=null;peerError.value='';if(props.active)void loadPeers();});
watch(search,()=>{clearTimeout(timer);request?.abort();timer=setTimeout(()=>{if(props.active)void load();},180);});
watch(()=>[props.version,props.active] as const,()=>{if(props.active){void load();void loadPeers();}else{request?.abort();peerRequest?.abort();}},{immediate:true});
onBeforeUnmount(()=>{clearTimeout(timer);request?.abort();peerRequest?.abort();});
</script>
<template>
  <HistoryConversationLayout :items="items.filter(item=>!search||item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))" :selected="selectedKey" v-model:search="search" :loading="loading" :has-details="category==='agent'||Boolean(selected)" :details-title="category==='agent'?'往来任务':'任务详情'" @select="choose">
    <template #list-actions><v-btn icon="mdi-refresh" size="small" variant="text" :aria-label="t('刷新会话')" @click="load();loadPeers()" /></template>
    <template #list-notice><QqReadNotice v-if="error" summary="会话暂时无法更新，已有记录仍可查看。" :detail="error" @retry="load()" /></template>
    <template #list-footer><v-btn v-if="cursor" variant="text" :disabled="loading" @click="load(true)">{{t('更多会话')}}</v-btn></template>
    <KeepAlive :max="12"><PersonaChatHistory v-if="selected" :key="selected.key" :role-id="roleId" :category="category" :task-key="selected.key" :title="selected.title" :version="version" :active="active" conversation /></KeepAlive>
    <div v-if="!selected&&!loading" class="pa-4 text-medium-emphasis">{{t('选择会话查看消息记录。')}}</div>
    <template #details>
      <template v-if="category==='agent'">
        <div class="text-subtitle-2 mb-3">{{t('往来任务')}}</div>
        <QqReadNotice v-if="peerError" summary="往来任务暂时无法更新，已有记录仍可查看。" :detail="peerError" @retry="loadPeers()" />
        <v-progress-linear v-if="peerLoading" indeterminate />
        <v-list bg-color="transparent" density="compact"><v-list-item v-for="task in peers" :key="task.key" @click="choosePeer(task)" :title="task.title" :subtitle="subtitle(task)" prepend-icon="mdi-console-line" /></v-list>
        <div v-if="!peers.length&&!peerLoading&&!peerError" class="text-caption text-medium-emphasis">{{t('暂无往来任务。')}}</div>
        <v-btn v-if="peerCursor" variant="text" :disabled="peerLoading" @click="loadPeers(true)">{{t('更多任务')}}</v-btn>
      </template>
      <template v-else-if="selected"><div class="text-subtitle-2 mb-3">{{t('任务详情')}}</div><div class="task-description" data-no-i18n>{{selected.title}}</div><div class="text-caption mt-2" data-no-i18n>{{selected.owner?.nodeName||selected.owner?.nodeId}}</div><v-btn v-if="selected.taskUrl" :href="selected.taskUrl" variant="text" prepend-icon="mdi-open-in-new">{{t('查看原任务')}}</v-btn><details class="mt-3 text-caption"><summary>ID</summary><div data-no-i18n>{{selected.sessionId}}</div></details></template>
    </template>
  </HistoryConversationLayout>
</template>
<style scoped>
.task-description,details{overflow-wrap:anywhere;}
</style>
