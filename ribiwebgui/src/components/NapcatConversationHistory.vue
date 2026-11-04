<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import type { HistoryQqRoute, QqConversation, QqDirectoryContact, QqGroupMember } from '@shared/qqConversationHistory';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../i18n';
import { userFacingError } from '../userFacingError';
import MessageEndpointHistory from './MessageEndpointHistory.vue';
import QqAvatar from './QqAvatar.vue';
import QqGroupMembers from './QqGroupMembers.vue';
import QqReadNotice from './QqReadNotice.vue';
import { qqConversationTime } from '../qqChatLayout';
import { waitForChatHistoryFrame } from '../personaChatHistoryLayout';
import {qqNavigationRead} from '../qqPreviewQueue';
import { mergeQqConversations, qqConversationIdentity, qqConfiguredRoute, qqMessagePreview,qqPartsPreview,qqDisplayParts,type QqHistoryRecord } from '../qqMessagePresentation';

const props = defineProps<{roleId:string;version:number;messageVersion?:number;active:boolean;routes:HistoryQqRoute[]}>();
const {fetch} = usePersonaService(), {t,locale} = useI18n();
const display = useDisplay();
const narrow = computed(()=>display.width.value<=760);
const conversations = ref<QqConversation[]>([]), selectedKey = ref('');
const directoryConversations = ref<QqConversation[]>([]);
const search = ref(''), cursor = ref<string|null>(null), loading = ref(false), error = ref(''), directoryWarning = ref('');
const contacts = ref(new Map<string,QqDirectoryContact>()), members = ref<QqGroupMember[]>([]), membersLoading = ref(false), memberError = ref('');
const membersOpen=ref(false);
const accountIds=ref(new Map<string,string>());
const availableAccounts=ref(new Set<string>());
const memberSnapshots=new Map<string,QqGroupMember[]>();
let memberRequestKey='';
const detailOpen = ref(false);
let detailPosition:{key:string;y:number}|undefined, restorePosition:AbortController|undefined;
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
let pendingRefresh=false;
const selected = computed(()=>conversations.value.find(item=>item.conversationKey===selectedKey.value));
watch(maxListWidth,()=>resizeList(listWidth.value));
const senderNames = computed(()=>Object.fromEntries(members.value.map(member=>[member.id,member.name]).concat(selected.value?.kind==='private'?[[selected.value.target,nameFor(selected.value)]]:[])));
const senderAvatars=computed(()=>{
  const names=new Map<string,string|null>();
  for(const member of members.value)names.set(member.name,names.has(member.name)?null:member.id);
  return Object.fromEntries([...[...names].filter((entry):entry is [string,string]=>entry[1]!==null),...members.value.map(member=>[member.id,member.id])]);
});
const ownQqId=computed(()=>selected.value?accountIds.value.get(JSON.stringify([selected.value.gatewayId,selected.value.instanceId])):undefined);
const qqLive=computed(()=>Boolean(selected.value&&availableAccounts.value.has(JSON.stringify([selected.value.gatewayId,selected.value.instanceId]))));
const routeFor = (conversation:QqConversation) => qqConfiguredRoute(conversation,props.routes);
const contactKey = (routeId:string,instanceId:string|undefined,kind:string,target:string)=>JSON.stringify([routeId,instanceId??'',kind,target]);
const groupNames=computed(()=>new Map([...contacts.value.values()].filter(row=>row.kind==='group').map(row=>[row.target,row.name])));
const nameFor = (conversation:QqConversation) => contacts.value.get(contactKey(conversation.gatewayId??'',conversation.instanceId,conversation.kind,conversation.target))?.name || (conversation.kind==='group'?groupNames.value.get(conversation.target):undefined) || `${t(conversation.kind==='group'?'群聊':conversation.kind==='private'?'私聊':'历史会话')} ${conversation.target}`;
const visible = computed(()=>conversations.value.filter(item=>!(search.value||'').trim() || (nameFor(item)+' '+item.target).toLowerCase().includes((search.value||'').trim().toLowerCase())).sort((a,b)=>b.time-a.time));
const historyOpen=ref(false);
const conversationSections=computed(()=>[
  {id:'current',historical:false,rows:visible.value.filter(row=>routeFor(row))},
  {id:'historical',historical:true,rows:visible.value.filter(row=>!routeFor(row))}
]);
watch([search,()=>selectedKey.value,()=>Boolean(selected.value&&!routeFor(selected.value))],()=>{if(search.value?.trim()||(selected.value&&!routeFor(selected.value)))historyOpen.value=true;});
const firstConversation=()=>conversationSections.value.find(section=>section.rows.length)?.rows[0];
function latestMessage(record:QqHistoryRecord){
  const row=selected.value;if(!row||record.time<row.time)return;
  const prefix=row.kind==='group'?(record.qqSenderName||senderNames.value[record.sender??'']||record.sender||''):'';
  row.time=record.time;row.preview=(prefix?prefix+': ':'')+qqPartsPreview(qqDisplayParts(record.text,record.qqParts,record.attachments)).slice(0,120);row.previewFormat='plain';
}
async function json(url:string,signal:AbortSignal) {
  const response=await (url.startsWith('/api/agent/qq/')?qqNavigationRead(signal,()=>fetch(url,{signal})):fetch(url,{signal})),result=await response.json();
  if(!response.ok||result.code!==0)throw new Error(result.message||result.errorCode||t('消息记录读取失败'));
  return result.data;
}
async function loadContacts() {
  if(directoryRequest&&!directoryRequest.signal.aborted)return;
  const controller=new AbortController();directoryRequest=controller;
  const collected=new Map(contacts.value);let failed=false;
  const accounts=new Map(accountIds.value),available=new Set<string>();
  // Keep account reads bounded while allowing an unavailable account to fail locally.
  for(let start=0;start<props.routes.length;start+=2) {
    const batch=props.routes.slice(start,start+2);
    const results=await Promise.allSettled(batch.map(route=>json(`/api/agent/qq/contacts?${new URLSearchParams({routeId:route.routeId})}`,controller.signal)));
    if(controller.signal.aborted)return;
    for(const [index,result] of results.entries()) {
      if(result.status==='rejected'){failed=true;continue;}
      // Refresh successful directories while retaining already-read names for an offline directory.
      const route=batch[index]!,instance=result.value.instanceId;
      const accountKey=JSON.stringify([route.routeId,instance]);
      if(result.value.account?.userId){
        const id=result.value.account.userId;
        if(accounts.has(accountKey)&&accounts.get(accountKey)!==id){
          const prefix=JSON.stringify([route.routeId,instance]).slice(0,-1)+',';
          for(const key of collected.keys())if(key.startsWith(prefix))collected.delete(key);
          for(const key of memberSnapshots.keys())if(key.startsWith(prefix))memberSnapshots.delete(key);
        }
        accounts.set(accountKey,id);available.add(accountKey);
      }else{failed=true;continue;}
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
    contacts.value=collected;accountIds.value=accounts;availableAccounts.value=available;
    directoryWarning.value=failed?t('QQ 联系人暂时无法更新，已有名称仍可查看。'):'';
    directoryConversations.value=[...collected].map(([key,contact])=>{
      const [gatewayId,instanceId]=JSON.parse(key) as [string,string];
      return {conversationKey:`qq-live:${key}`,gatewayId,instanceId,kind:contact.kind,target:contact.target,time:contact.time??0,preview:contact.preview??'',previewFormat:'plain' as const};
    });
    const retained=selected.value;
    conversations.value=mergeQqConversations(directoryConversations.value,conversations.value);
    const same=retained&&conversations.value.find(row=>qqConversationIdentity(row)===qqConversationIdentity(retained));
    if(same)selectedKey.value=same.conversationKey;
    else if(!selected.value&&firstConversation())selectedKey.value=firstConversation()!.conversationKey;
  }
  if(directoryRequest===controller)directoryRequest=undefined;
}
async function load(older=false) {
  if(request){if(!older)pendingRefresh=true;return;}
  const controller=new AbortController();request=controller;loading.value=true;error.value='';
  try {
    const query=new URLSearchParams();if(older&&cursor.value)query.set('cursor',cursor.value);
    const data=await json(`/api/roles/${encodeURIComponent(props.roleId)}/message-history-conversations?${query}`,controller.signal);
    if(controller.signal.aborted)return;
    const retained=selected.value;
    const incoming=(data.conversations as QqConversation[]).map(row=>({...row,preview:row.previewFormat==='plain'?row.preview:qqMessagePreview(row.preview)}));
    conversations.value=older?mergeQqConversations(conversations.value,incoming):mergeQqConversations(retained?[retained]:[],mergeQqConversations(incoming,directoryConversations.value));
    cursor.value=data.nextConversationCursor;
    if(!selected.value&&firstConversation())selectedKey.value=firstConversation()!.conversationKey;
  }catch(cause){if(!controller.signal.aborted)error.value=userFacingError(cause);}
  finally{if(request===controller){request=undefined;loading.value=false;if(pendingRefresh&&props.active){pendingRefresh=false;void load();}}}
}
function showList(){restorePosition?.abort();detailPosition={key:selectedKey.value,y:window.scrollY};detailOpen.value=false;}
async function choose(conversation:QqConversation){
  restorePosition?.abort();
  const position=narrow.value&&!detailOpen.value&&selectedKey.value===conversation.conversationKey&&detailPosition?.key===conversation.conversationKey?detailPosition.y:undefined;
  selectedKey.value=conversation.conversationKey;detailOpen.value=true;
  if(position===undefined)return;
  const controller=new AbortController();restorePosition=controller;
  const interrupt=()=>controller.abort(),events=['wheel','touchstart','pointerdown','keydown'] as const;
  for(const event of events)window.addEventListener(event,interrupt,{passive:true});
  try{await nextTick();for(let frame=0;frame<8;frame++){if(!await waitForChatHistoryFrame(controller.signal))break;window.scrollTo(0,position);}}
  finally{for(const event of events)window.removeEventListener(event,interrupt);}
}
async function loadMembers() {
  const conversation=selected.value;
  const cacheKey=JSON.stringify([conversation?.gatewayId,conversation?.instanceId,ownQqId.value,conversation?.target]);
  if(memberRequest&&!memberRequest.signal.aborted&&memberRequestKey===cacheKey)return;
  memberRequest?.abort();memberRequest=undefined;memberRequestKey=cacheKey;
  members.value=memberSnapshots.get(cacheKey)??[];memberError.value='';membersLoading.value=false;
  if(!props.active||conversation?.kind!=='group')return;
  const route=routeFor(conversation);
  if(!route){memberError.value=t('此会话的 QQ 连接不可用，仍可浏览已有记录。');return;}
  const controller=new AbortController();memberRequest=controller;membersLoading.value=true;
  try {
    const data=await json(`/api/agent/qq/group-members?${new URLSearchParams({routeId:route.routeId,kind:'group',target:conversation.target})}`,controller.signal);
    if(!controller.signal.aborted&&memberRequestKey===cacheKey){
      memberSnapshots.delete(cacheKey);memberSnapshots.set(cacheKey,data.entries);
      while(memberSnapshots.size>8)memberSnapshots.delete(memberSnapshots.keys().next().value!);
      members.value=data.entries;
    }
  }catch(cause){if(!controller.signal.aborted&&memberRequestKey===cacheKey)memberError.value=userFacingError(cause);}
  finally{if(memberRequest===controller){membersLoading.value=false;memberRequest=undefined;}}
}
watch([selectedKey,ownQqId,()=>props.active],()=>{membersOpen.value=false;void loadMembers();});
watch(()=>props.routes,()=>{directoryRequest?.abort();directoryRequest=undefined;if(props.active){void loadContacts();void loadMembers();}});
watch(()=>props.active,active=>{if(active){pendingRefresh=false;void load();void loadContacts();}else{restorePosition?.abort();request?.abort();memberRequest?.abort();directoryRequest?.abort();}},{immediate:true});
watch(()=>props.version,()=>{if(props.active)void load();});
watch(()=>props.messageVersion,()=>{if(props.active)void load();});
onBeforeUnmount(()=>{restorePosition?.abort();stopDrag();layoutObserver?.disconnect();request?.abort();memberRequest?.abort();directoryRequest?.abort();});
</script>

<template>
  <div ref="layout" class="qq-conversations" :style="{'--qq-list-width':`${listWidth}px`}" :class="{'qq-has-selection':detailOpen,'qq-is-group':selected?.kind==='group','qq-resizing':dragging}">
    <v-card class="qq-conversation-list app-card glass-card" :aria-label="t('QQ 会话')">
      <div class="qq-list-search"><v-text-field v-model="search" :placeholder="t('搜索会话')" :aria-label="t('搜索会话')" prepend-inner-icon="mdi-magnify" density="compact" variant="solo-filled" flat clearable hide-details /><v-btn icon="mdi-refresh" size="small" variant="text" :aria-label="t('刷新会话')" @click="load();loadContacts()" /></div>
      <v-progress-linear v-if="loading" indeterminate />
      <QqReadNotice v-if="error" summary="会话暂时无法更新，已有记录仍可查看。" :detail="error" @retry="load()" />
      <QqReadNotice v-if="directoryWarning" :summary="directoryWarning" @retry="loadContacts();loadMembers()" />
      <v-list class="qq-session-scroll" bg-color="transparent" aria-label="QQ conversations">
        <component :is="section.historical?'details':'div'" v-for="section in conversationSections" v-show="section.rows.length" :key="section.id" :class="{'qq-historical-conversations':section.historical}" :open="section.historical?historyOpen:undefined" @toggle="section.historical&&(historyOpen=($event.target as HTMLDetailsElement).open)">
          <summary v-if="section.historical&&section.rows.length" class="qq-history-summary">{{ t('历史记录') }} · {{ section.rows.length }}</summary>
        <v-list-item v-for="conversation in section.rows" :key="conversation.conversationKey" :active="selectedKey===conversation.conversationKey" @click="choose(conversation)">
          <template #prepend><QqAvatar :id="conversation.kind==='unknown'?undefined:conversation.target" :kind="conversation.kind==='group'?'group':'private'" :name="nameFor(conversation)" :size="44" /></template>
          <v-list-item-title class="qq-conversation-title" data-no-i18n><span :title="nameFor(conversation)">{{ nameFor(conversation) }}</span><small v-if="!routeFor(conversation)" class="qq-source-badge" :title="`${conversation.gatewayId??''} ${conversation.instanceId??''}`">{{ t('历史记录') }}</small><small v-else-if="routes.length>1" class="qq-source-badge" :title="routeFor(conversation)?.name">{{ routeFor(conversation)?.name }}</small><time v-if="conversation.time" :title="new Date(conversation.time*1000).toLocaleString(locale)">{{ qqConversationTime(conversation.time,undefined,locale) }}</time></v-list-item-title>
          <v-list-item-subtitle data-no-i18n>{{ conversation.preview }}</v-list-item-subtitle>
        </v-list-item>
        </component>
      <div v-if="!visible.length&&!loading" class="text-body-2 text-medium-emphasis pa-3">{{ t('暂无匹配会话。') }}</div>
      <v-btn v-if="cursor" :disabled="loading" variant="text" @click="load(true)">{{ t('更多会话') }}</v-btn>
      </v-list>
    </v-card>
    <div class="qq-splitter" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="t('调整会话列表宽度')" :aria-valuenow="listWidth" :aria-valuemin="200" :aria-valuemax="maxListWidth" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="stopDrag" @pointercancel="stopDrag" @lostpointercapture="stopDrag" @keydown="resizeKey" @dblclick="resizeList(240);saveWidth()" />
    <div class="qq-conversation-detail">
      <MessageEndpointHistory v-if="selected" :key="qqConversationIdentity(selected)" :role-id="roleId" adapter="napcat" :title="nameFor(selected)" :conversation-key="selected.storedConversationKey??selected.conversationKey" :qq-selection="routeFor(selected)&&selected.kind!=='unknown'?{routeId:routeFor(selected)!.routeId,kind:selected.kind,target:selected.target}:undefined" :qq-live="qqLive" :sender-names="senderNames" :sender-avatars="senderAvatars" :own-qq-id="ownQqId" :member-count="selected.kind==='group'&&!membersLoading&&!memberError?members.length:undefined" :version="version" :message-version="messageVersion" :active="active&&(!narrow||detailOpen)" @latest="latestMessage" bubble>
        <template #back><v-btn class="qq-back" icon="mdi-arrow-left" size="small" variant="text" :aria-label="t('返回会话')" @click="showList" /></template>
        <template #actions><v-btn v-if="selected.kind==='group'" class="qq-members-toggle" icon="mdi-account-group-outline" size="small" variant="text" :aria-label="t('群成员')" @click="membersOpen=true" /></template>
      </MessageEndpointHistory>
      <v-alert v-else type="info" variant="tonal">{{ t('选择群聊或私聊查看消息记录。') }}</v-alert>
    </div>
    <aside v-if="selected?.kind==='group'" class="qq-members"><QqGroupMembers :key="selectedKey" :members="members" :loading="membersLoading" :error="memberError" @refresh="loadMembers" /></aside>
    <v-dialog v-if="selected?.kind==='group'" v-model="membersOpen" max-width="360" scrollable><v-card><QqGroupMembers :key="selectedKey" class="qq-members-dialog" :members="members" :loading="membersLoading" :error="memberError" @refresh="loadMembers" /><v-card-actions><v-spacer /><v-btn @click="membersOpen=false">{{ t('关闭') }}</v-btn></v-card-actions></v-card></v-dialog>
  </div>
</template>

<style scoped>
.qq-conversation-title {display:flex;align-items:center;gap:8px;min-width:0;font-size:14px;line-height:22px;}
.qq-conversation-title>span {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qq-conversation-title>time {flex-shrink:0;margin-left:auto;font-size:11px;opacity:.6;}
.qq-source-badge {flex:none;max-width:48px;font-size:9px;line-height:16px;padding:0 3px;background:rgba(var(--v-theme-on-surface),.07);color:rgba(var(--v-theme-on-surface),.55);border-radius:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qq-conversation-list :deep(.v-list-item-subtitle) {display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:20px;line-height:20px;}
.qq-conversation-list :deep(.v-list-item) {min-height:72px;padding:8px 10px;border-radius:5px;margin:2px 4px;}
.qq-conversation-list :deep(.v-list-item__prepend .v-list-item__spacer) {width:12px;}
.qq-conversation-list :deep(.v-list-item__content) {min-width:0;}
.qq-conversation-list :deep(.v-list-item-subtitle) {font-size:12px;}
.qq-conversation-list {display:flex;flex-direction:column;overflow:hidden!important;max-height:calc(100dvh - 140px);padding:0!important;border:0!important;background:rgba(var(--v-theme-on-surface),.025)!important;border-radius:0!important;box-shadow:none!important;}
.qq-list-search {display:flex;align-items:center;gap:4px;padding:10px 8px;flex:none;}
.qq-list-search :deep(.v-field) {font-size:12px;border-radius:7px;}
.qq-session-scroll {min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding-top:0;}
.qq-history-summary {cursor:pointer;padding:12px 10px;font-size:12px;color:rgba(var(--v-theme-on-surface),.65);border-top:1px solid rgba(var(--v-theme-on-surface),.08);}
.qq-conversations { display:grid; grid-template-columns:var(--qq-list-width,240px) 12px minmax(0,1fr); column-gap:0; row-gap:16px; align-items:start; }
.qq-conversations.qq-is-group { grid-template-columns:var(--qq-list-width,240px) 12px minmax(0,1fr) 222px; }
.qq-splitter { align-self:stretch; min-height:240px; cursor:col-resize; touch-action:none; position:relative; outline:none; }
.qq-splitter::after { content:''; position:absolute; top:0; bottom:0; left:5px; width:2px; border-radius:2px; background:rgba(var(--v-theme-on-surface),.12); }
.qq-splitter:hover::after,.qq-splitter:focus-visible::after,.qq-resizing .qq-splitter::after { background:rgb(var(--v-theme-secondary)); }
.qq-resizing { user-select:none; cursor:col-resize; }
.qq-members {height:calc(100dvh - 140px);max-height:calc(100dvh - 140px);overflow:hidden;border-left:1px solid rgba(var(--v-theme-on-surface),.08);}
.qq-conversation-list,.qq-members { position:sticky; top:120px; min-width:0; }
.qq-conversation-detail { min-width:0; }
.qq-members-dialog {height:65dvh;}
.qq-members-toggle {display:none;}
.qq-back { display:none; }
@media(max-width:1200px) { .qq-conversations.qq-is-group {grid-template-columns:var(--qq-list-width,240px) 12px minmax(0,1fr);} .qq-members {display:none;} .qq-members-toggle {display:inline-flex;} }
@media(max-width:760px) { .qq-conversations,.qq-conversations.qq-is-group {display:flex;flex-direction:column;gap:12px;} .qq-splitter{display:none;} .qq-conversation-list {position:static;width:100%;order:0;max-height:calc(100dvh - 180px);} .qq-conversation-detail {display:none;width:100%;} .qq-has-selection .qq-conversation-list {display:none;} .qq-has-selection .qq-conversation-detail {display:block;} .qq-back {display:inline-flex;} .qq-conversation-detail{order:2;} }
</style>
