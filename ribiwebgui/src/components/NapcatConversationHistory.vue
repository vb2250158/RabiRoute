<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import type { HistoryQqRoute, QqConversation, QqDirectoryContact, QqGroupMember } from '@shared/qqConversationHistory';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../i18n';
import { userFacingError } from '../userFacingError';
import MessageEndpointHistory from './MessageEndpointHistory.vue';
import QqAvatar from './QqAvatar.vue';
import { mergeQqConversations, qqConversationIdentity, qqMessagePreview } from '../qqMessagePresentation';

const props = defineProps<{roleId:string;version:number;active:boolean;routes:HistoryQqRoute[]}>();
const {fetch} = usePersonaService(), {t} = useI18n();
const display = useDisplay();
const narrow = computed(()=>display.width.value<760);
const conversations = ref<QqConversation[]>([]), selectedKey = ref('');
const directoryConversations = ref<QqConversation[]>([]);
const search = ref(''), cursor = ref<string|null>(null), loading = ref(false), error = ref(''), directoryWarning = ref('');
const contacts = ref(new Map<string,QqDirectoryContact>()), members = ref<QqGroupMember[]>([]), membersLoading = ref(false), memberError = ref(''), memberLimit = ref(40);
const accountIds=ref(new Map<string,string>());
const detailOpen = ref(false);
const layout = ref<HTMLElement>(), layoutWidth=ref(1000), listWidth = ref(240), dragging = ref(false);
const widthKey = 'rabiroute.qq.conversation-list-width';
const maxListWidth = computed(()=>Math.max(200,Math.min(440,layoutWidth.value-312-(display.width.value>1200&&selected.value?.kind==='group'?222:0))));
let layoutObserver:ResizeObserver|undefined;
let drag: { pointerId:number; element:HTMLElement; x:number; width:number } | undefined;
function resizeList(width:number) { listWidth.value=Math.round(Math.max(200,Math.min(maxListWidth.value,width))); }
function saveWidth() { try { localStorage.setItem(widthKey,String(listWidth.value)); } catch { /* Layout remains usable without local storage. */ } }
function stopDrag() {
  if(!drag)return;
  const previous=drag;drag=undefined;dragging.value=false;
  if(previous.element.hasPointerCapture(previous.pointerId))previous.element.releasePointerCapture(previous.pointerId);
  saveWidth();
}
function startDrag(event:PointerEvent) {
  if(event.button!==0||narrow.value)return;
  event.preventDefault();const element=event.currentTarget as HTMLElement;
  drag={pointerId:event.pointerId,element,x:event.clientX,width:listWidth.value};dragging.value=true;element.setPointerCapture(event.pointerId);
}
function moveDrag(event:PointerEvent) { if(drag?.pointerId===event.pointerId)resizeList(drag.width+event.clientX-drag.x); }
function resizeKey(event:KeyboardEvent) {
  const delta=event.key==='ArrowLeft'?-16:event.key==='ArrowRight'?16:0;
  if(!delta&&event.key!=='Home'&&event.key!=='End')return;
  event.preventDefault();resizeList(event.key==='Home'?200:event.key==='End'?maxListWidth.value:listWidth.value+delta);saveWidth();
}
onMounted(()=>{
  if(layout.value){layoutWidth.value=layout.value.clientWidth;layoutObserver=new ResizeObserver(entries=>{layoutWidth.value=entries[0]?.contentRect.width??layoutWidth.value;});layoutObserver.observe(layout.value);}
  try { const saved=Number(localStorage.getItem(widthKey));if(saved>=200)resizeList(saved); }catch { /* Optional layout preference. */ }
});
let request:AbortController|undefined, memberRequest:AbortController|undefined, directoryRequest:AbortController|undefined;
const selected = computed(()=>conversations.value.find(item=>item.conversationKey===selectedKey.value));
watch(maxListWidth,()=>resizeList(listWidth.value));
const senderNames = computed(()=>Object.fromEntries(members.value.map(member=>[member.id,member.name]).concat(selected.value?.kind==='private'?[[selected.value.target,nameFor(selected.value)]]:[])));
const senderAvatars=computed(()=>{
  const names=new Map<string,string|null>();
  for(const member of members.value)names.set(member.name,names.has(member.name)?null:member.id);
  return Object.fromEntries([...[...names].filter((entry):entry is [string,string]=>entry[1]!==null),...members.value.map(member=>[member.id,member.id])]);
});
const ownQqId=computed(()=>selected.value?accountIds.value.get(JSON.stringify([selected.value.gatewayId,selected.value.instanceId])):undefined);
const routeFor = (conversation:QqConversation) => props.routes.find(route=>route.routeId===conversation.gatewayId && (!conversation.instanceId || route.instanceId===conversation.instanceId));
const contactKey = (routeId:string,instanceId:string|undefined,kind:string,target:string)=>JSON.stringify([routeId,instanceId??'',kind,target]);
const nameFor = (conversation:QqConversation) => contacts.value.get(contactKey(conversation.gatewayId??'',conversation.instanceId,conversation.kind,conversation.target))?.name || `${t(conversation.kind==='group'?'群聊':conversation.kind==='private'?'私聊':'历史会话')} ${conversation.target}`;
const visible = computed(()=>conversations.value.filter(item=>!(search.value||'').trim() || (nameFor(item)+' '+item.target).toLowerCase().includes((search.value||'').trim().toLowerCase())).sort((a,b)=>b.time-a.time));
async function json(url:string,signal:AbortSignal) {
  const response=await fetch(url,{signal}),result=await response.json();
  if(!response.ok||result.code!==0)throw new Error(result.message||result.errorCode||t('消息记录读取失败'));
  return result.data;
}
async function loadContacts() {
  directoryRequest?.abort();const controller=new AbortController();directoryRequest=controller;
  const collected=new Map(contacts.value);let failed=false;
  const accounts=new Map<string,string>();
  // Keep account reads bounded while allowing an unavailable account to fail locally.
  for(let start=0;start<props.routes.length;start+=2) {
    const batch=props.routes.slice(start,start+2);
    const results=await Promise.allSettled(batch.map(route=>json(`/api/agent/qq/contacts?${new URLSearchParams({routeId:route.routeId})}`,controller.signal)));
    if(controller.signal.aborted)return;
    for(const [index,result] of results.entries()) {
      if(result.status==='rejected'){failed=true;continue;}
      // Refresh successful directories while retaining already-read names for an offline directory.
      const route=batch[index]!,instance=result.value.instanceId;
      if(result.value.account?.userId)accounts.set(JSON.stringify([route.routeId,instance]),result.value.account.userId);
      const warnings:string[]=result.value.warnings??[];
      for(const kind of ['group','private']) {
        if(warnings.includes(kind==='group'?'QQ_GROUP_LIST_UNAVAILABLE':'QQ_FRIEND_LIST_UNAVAILABLE'))continue;
        const prefix=JSON.stringify([route.routeId,instance??'',kind]).slice(0,-1)+',';
        for(const key of collected.keys())if(key.startsWith(prefix))collected.delete(key);
      }
      for(const contact of result.value.entries as QqDirectoryContact[]) collected.set(contactKey(batch[index]!.routeId,result.value.instanceId,contact.kind,contact.target),contact);
      if(result.value.warnings?.length)failed=true;
    }
  }
  if(!controller.signal.aborted){
    contacts.value=collected;accountIds.value=accounts;directoryWarning.value=failed?t('部分 QQ 名称暂不可用，仍可查看消息记录。'):'';
    directoryConversations.value=[...collected].map(([key,contact])=>{
      const [gatewayId,instanceId]=JSON.parse(key) as [string,string];
      return {conversationKey:`qq-live:${key}`,gatewayId,instanceId,kind:contact.kind,target:contact.target,time:contact.time??0,preview:contact.preview??''};
    });
    const retained=selected.value;
    conversations.value=mergeQqConversations(directoryConversations.value,conversations.value);
    const same=retained&&conversations.value.find(row=>qqConversationIdentity(row)===qqConversationIdentity(retained));
    if(same)selectedKey.value=same.conversationKey;
    else if(!selected.value&&visible.value[0])selectedKey.value=visible.value[0].conversationKey;
  }
}
async function load(older=false) {
  if(request)return;
  const controller=new AbortController();request=controller;loading.value=true;error.value='';
  try {
    const query=new URLSearchParams();if(older&&cursor.value)query.set('cursor',cursor.value);
    const data=await json(`/api/roles/${encodeURIComponent(props.roleId)}/message-history-conversations?${query}`,controller.signal);
    if(controller.signal.aborted)return;
    const retained=selected.value;
    const incoming=(data.conversations as QqConversation[]).map(row=>({...row,preview:qqMessagePreview(row.preview)}));
    conversations.value=older?mergeQqConversations(conversations.value,incoming):mergeQqConversations(retained?[retained]:[],mergeQqConversations(incoming,directoryConversations.value));
    cursor.value=data.nextConversationCursor;
    if(!selected.value&&conversations.value.length){const first=conversations.value.slice().sort((a,b)=>b.time-a.time)[0]!;selectedKey.value=first.conversationKey;}
  }catch(cause){if(!controller.signal.aborted)error.value=userFacingError(cause);}
  finally{if(request===controller){request=undefined;loading.value=false;}}
}
function choose(conversation:QqConversation){selectedKey.value=conversation.conversationKey;detailOpen.value=true;}
async function loadMembers() {
  memberRequest?.abort();members.value=[];memberError.value='';memberLimit.value=40;membersLoading.value=false;
  const conversation=selected.value;
  if(!props.active||conversation?.kind!=='group')return;
  const route=routeFor(conversation);
  if(!route){memberError.value=t('此会话的 QQ 连接不可用，仍可浏览已有记录。');return;}
  const controller=new AbortController();memberRequest=controller;membersLoading.value=true;
  try {
    const data=await json(`/api/agent/qq/group-members?${new URLSearchParams({routeId:route.routeId,kind:'group',target:conversation.target})}`,controller.signal);
    if(!controller.signal.aborted&&selectedKey.value===conversation.conversationKey)members.value=data.entries;
  }catch(cause){if(!controller.signal.aborted)memberError.value=userFacingError(cause);}
  finally{if(memberRequest===controller)membersLoading.value=false;}
}
watch([selectedKey,()=>props.active],()=>void loadMembers());
watch(()=>props.routes,()=>{if(props.active){void loadContacts();void loadMembers();}});
watch(()=>props.active,active=>{if(active){if(!conversations.value.length)void load();void loadContacts();}else{request?.abort();memberRequest?.abort();directoryRequest?.abort();}},{immediate:true});
watch(()=>props.version,()=>{if(props.active)void load();});
onBeforeUnmount(()=>{stopDrag();layoutObserver?.disconnect();request?.abort();memberRequest?.abort();directoryRequest?.abort();});
</script>

<template>
  <div ref="layout" class="qq-conversations" :style="{'--qq-list-width':`${listWidth}px`}" :class="{'qq-has-selection':detailOpen,'qq-is-group':selected?.kind==='group','qq-resizing':dragging}">
    <v-card class="qq-conversation-list app-card glass-card pa-3" :aria-label="t('QQ 会话')">
      <div class="d-flex align-center justify-space-between mb-2"><strong>NapCat / QQ</strong><v-btn icon="mdi-refresh" size="small" variant="text" :aria-label="t('刷新会话')" @click="load();loadContacts()" /></div>
      <v-text-field v-model="search" :label="t('搜索会话')" prepend-inner-icon="mdi-magnify" clearable hide-details class="mb-2" />
      <v-progress-linear v-if="loading" indeterminate />
      <v-alert v-if="error" :type="conversations.length?'warning':'error'" variant="tonal" class="mt-2">{{ error }}</v-alert>
      <v-alert v-if="directoryWarning" type="warning" variant="tonal" class="mt-2">{{ directoryWarning }}</v-alert>
      <v-list bg-color="transparent" aria-label="QQ conversations">
        <v-list-item v-for="conversation in visible" :key="conversation.conversationKey" :active="selectedKey===conversation.conversationKey" @click="choose(conversation)">
          <template #prepend><QqAvatar :id="conversation.kind==='unknown'?undefined:conversation.target" :kind="conversation.kind==='group'?'group':'private'" :name="nameFor(conversation)" :size="40" /></template>
          <v-list-item-title class="qq-conversation-title" data-no-i18n><span>{{ nameFor(conversation) }}</span><time v-if="conversation.time">{{ new Date(conversation.time*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) }}</time></v-list-item-title>
          <v-list-item-subtitle data-no-i18n>{{ conversation.preview }}</v-list-item-subtitle>
        </v-list-item>
      </v-list>
      <div v-if="!visible.length&&!loading" class="text-body-2 text-medium-emphasis pa-3">{{ t('暂无匹配会话。') }}</div>
      <v-btn v-if="cursor" :disabled="loading" variant="text" @click="load(true)">{{ t('更多会话') }}</v-btn>
    </v-card>
    <div class="qq-splitter" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="t('调整会话列表宽度')" :aria-valuenow="listWidth" :aria-valuemin="200" :aria-valuemax="maxListWidth" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="stopDrag" @pointercancel="stopDrag" @lostpointercapture="stopDrag" @keydown="resizeKey" @dblclick="resizeList(240);saveWidth()" />
    <div class="qq-conversation-detail">
      <v-btn class="qq-back mb-2" prepend-icon="mdi-arrow-left" variant="text" @click="detailOpen=false">{{ t('返回会话') }}</v-btn>
      <MessageEndpointHistory v-if="selected" :key="selected.conversationKey" :role-id="roleId" adapter="napcat" :title="nameFor(selected)" :conversation-key="selected.storedConversationKey??selected.conversationKey" :qq-selection="routeFor(selected)&&selected.kind!=='unknown'?{routeId:routeFor(selected)!.routeId,kind:selected.kind,target:selected.target}:undefined" :qq-live="Boolean(ownQqId)" :sender-names="senderNames" :sender-avatars="senderAvatars" :own-qq-id="ownQqId" :version="version" :active="active" bubble />
      <v-alert v-else type="info" variant="tonal">{{ t('选择群聊或私聊查看消息记录。') }}</v-alert>
    </div>
    <v-card v-if="selected?.kind==='group'" class="qq-members app-card glass-card pa-3" :aria-label="t('群成员')">
      <details :open="!narrow"><summary class="qq-member-heading"><strong>{{ t('群成员') }}<span v-if="!membersLoading&&!memberError"> · {{ members.length }}</span></strong></summary>
      <v-btn icon="mdi-refresh" size="small" variant="text" :aria-label="t('刷新群成员')" @click="loadMembers" />
      <v-progress-linear v-if="membersLoading" indeterminate />
      <v-alert v-if="memberError" type="warning" variant="tonal" class="mt-2">{{ memberError }}</v-alert>
      <v-list bg-color="transparent" density="compact"><v-list-item v-for="member in members.slice(0,memberLimit)" :key="member.id" :title="member.name" :subtitle="member.id" data-no-i18n><template #prepend><QqAvatar :id="member.id" :name="member.name" :size="28" class="mr-2" /></template><template v-if="member.role==='owner'||member.role==='admin'" #append><v-chip size="x-small" color="secondary">{{ t(member.role==='owner'?'群主':'管理员') }}</v-chip></template></v-list-item></v-list>
      <v-btn v-if="memberLimit<members.length" variant="text" @click="memberLimit+=40">{{ t('更多成员') }}</v-btn>
      </details>
    </v-card>
  </div>
</template>

<style scoped>
.qq-conversation-title {display:flex;align-items:center;gap:8px;min-width:0;}
.qq-conversation-title>span {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qq-conversation-title>time {flex-shrink:0;margin-left:auto;font-size:11px;opacity:.6;}
.qq-conversation-list :deep(.v-list-item-subtitle) {display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:20px;line-height:20px;}
.qq-conversation-list :deep(.v-list-item) {min-height:64px;}
@media(min-width:760px) {
  .qq-conversation-list,.qq-members {position:sticky;top:128px;max-height:calc(100dvh - 152px);overflow-y:auto;}
}
.qq-conversations { display:grid; grid-template-columns:var(--qq-list-width,240px) 12px minmax(0,1fr); column-gap:0; row-gap:16px; align-items:start; }
.qq-conversations.qq-is-group { grid-template-columns:var(--qq-list-width,240px) 12px minmax(0,1fr) 210px; }
.qq-splitter { align-self:stretch; min-height:240px; cursor:col-resize; touch-action:none; position:relative; outline:none; }
.qq-splitter::after { content:''; position:absolute; top:0; bottom:0; left:5px; width:2px; border-radius:2px; background:rgba(var(--v-theme-on-surface),.12); }
.qq-splitter:hover::after,.qq-splitter:focus-visible::after,.qq-resizing .qq-splitter::after { background:rgb(var(--v-theme-secondary)); }
.qq-resizing { user-select:none; cursor:col-resize; }
.qq-members { margin-left:12px; }
.qq-conversation-list,.qq-members { position:sticky; top:128px; min-width:0; }
.qq-conversation-detail { min-width:0; }
.qq-conversation-list :deep(.v-list) { max-height:calc(100vh - 330px); overflow-y:auto; }
.qq-members :deep(.v-list) { max-height:calc(100vh - 240px); overflow-y:auto; }
.qq-member-heading { cursor:pointer; }
.qq-back { display:none; }
@media(max-width:1200px) { .qq-conversations.qq-is-group {grid-template-columns:var(--qq-list-width,240px) 12px minmax(0,1fr);} .qq-members {position:static;grid-column:3;margin-left:0;} }
@media(max-width:760px) { .qq-conversations,.qq-conversations.qq-is-group {display:flex;flex-direction:column;gap:12px;} .qq-splitter{display:none;} .qq-conversation-list {position:static;width:100%;order:0;} .qq-conversation-detail,.qq-members {display:none;width:100%;} .qq-has-selection .qq-conversation-list {display:none;} .qq-has-selection .qq-conversation-detail,.qq-has-selection .qq-members {display:block;} .qq-back {display:inline-flex;} .qq-members {order:1;position:static;margin-left:0;} .qq-conversation-detail{order:2;} }
</style>
