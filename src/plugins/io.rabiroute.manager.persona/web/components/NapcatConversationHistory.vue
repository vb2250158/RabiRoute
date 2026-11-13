<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import type { HistoryQqRoute, QqConversation, QqDirectoryContact, QqGroupMember } from '@shared/qqConversationHistory';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { userFacingError } from '../../../../../ribiwebgui/src/userFacingError';
import MessageEndpointHistory from './MessageEndpointHistory.vue';
import QqAvatar from './QqAvatar.vue';
import QqGroupMembers from './QqGroupMembers.vue';
import QqReadNotice from './QqReadNotice.vue';
import HistoryConversationLayout from './HistoryConversationLayout.vue';
import { qqConversationTime } from '../../../../../ribiwebgui/src/qqChatLayout';
import { waitForChatHistoryFrame } from '../../../../../ribiwebgui/src/personaChatHistoryLayout';
import {qqNavigationRead} from '../../../../../ribiwebgui/src/qqPreviewQueue';
import { mergeQqConversations, qqConversationIdentity, qqConfiguredRoute, qqMessagePreview,qqPartsPreview,qqDisplayParts,type QqHistoryRecord } from '../../../../../ribiwebgui/src/qqMessagePresentation';

const props = defineProps<{roleId:string;version:number;messageVersion?:number;active:boolean;routes:HistoryQqRoute[]}>();
const {fetch} = usePersonaService(), {t,locale} = useI18n();
const display = useDisplay();
const narrow = computed(()=>display.width.value<=760);
const conversations = ref<QqConversation[]>([]), selectedKey = ref('');
const directoryConversations = ref<QqConversation[]>([]);
const search = ref(''), cursor = ref<string|null>(null), loading = ref(false), error = ref(''), directoryWarning = ref(''), directoryDetail = ref('');
const contacts = ref(new Map<string,QqDirectoryContact>()), members = ref<QqGroupMember[]>([]), membersLoading = ref(false), memberError = ref('');
const membersOpen=ref(false);
const accountIds=ref(new Map<string,string>());
const availableAccounts=ref(new Set<string>());
const memberSnapshots=new Map<string,QqGroupMember[]>();
let memberRequestKey='';
const detailOpen = ref(false);
let detailPosition:{key:string;y:number}|undefined, restorePosition:AbortController|undefined;
let request:AbortController|undefined, memberRequest:AbortController|undefined, directoryRequest:AbortController|undefined;
let pendingRefresh=false;
const selected = computed(()=>conversations.value.find(item=>item.conversationKey===selectedKey.value));
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
  const collected=new Map(contacts.value);let failed=false;const warnings=new Set<string>(),failures:string[]=[];
  const accounts=new Map(accountIds.value),available=new Set<string>();
  try {
  // Keep account reads bounded while allowing an unavailable account to fail locally.
  for(let start=0;start<props.routes.length;start+=2) {
    const batch=props.routes.slice(start,start+2);
    const results=await Promise.allSettled(batch.map(route=>json(`/api/agent/qq/contacts?${new URLSearchParams({routeId:route.routeId})}`,controller.signal)));
    if(controller.signal.aborted)return;
    for(const [index,result] of results.entries()) {
      if(result.status==='rejected'){failed=true;failures.push(userFacingError(result.reason));continue;}
      try {
      // Refresh successful directories while retaining already-read names for an offline directory.
      const route=batch[index]!,instance=result.value.instanceId;
      const accountKey=JSON.stringify([route.routeId,instance]);
      const id=result.value.account?.userId;
      if(!id){failed=true;failures.push(t('QQ 账号状态暂时无法更新。'));continue;}
      // Prepare this route before replacing its old directory. A presentation
      // failure cannot erase the other routes or the last readable names.
      const incoming=(result.value.entries as QqDirectoryContact[]).map(contact=>[contactKey(route.routeId,instance,contact.kind,contact.target),contact] as const);
      const routeWarnings:string[]=[...(result.value.warnings??[])];
      if(result.value.account?.userId){
        if(accounts.has(accountKey)&&accounts.get(accountKey)!==id){
          const prefix=JSON.stringify([route.routeId,instance]).slice(0,-1)+',';
          for(const key of collected.keys())if(key.startsWith(prefix))collected.delete(key);
          for(const key of memberSnapshots.keys())if(key.startsWith(prefix))memberSnapshots.delete(key);
        }
        accounts.set(accountKey,id);available.add(accountKey);
      }else{failed=true;failures.push(t('QQ 账号状态暂时无法更新。'));continue;}
      for(const warning of routeWarnings)warnings.add(warning);
      for(const kind of ['group','private']) {
        if(routeWarnings.includes(kind==='group'?'QQ_GROUP_LIST_UNAVAILABLE':'QQ_FRIEND_LIST_UNAVAILABLE'))continue;
        const prefix=JSON.stringify([route.routeId,instance??'',kind]).slice(0,-1)+',';
        for(const key of collected.keys())if(key.startsWith(prefix))collected.delete(key);
      }
      for(const [key,contact] of incoming) collected.set(key,contact);
      if(result.value.warnings?.length)failed=true;
      } catch(cause) { failed=true;failures.push(userFacingError(cause)); }
    }
  }
  if(!controller.signal.aborted&&directoryRequest===controller){
    contacts.value=collected;accountIds.value=accounts;availableAccounts.value=available;
    directoryWarning.value=!failed?'':failures.length?t('部分 QQ 连接暂时无法更新，已有会话仍可查看。')
      :[...warnings].every(warning=>warning==='QQ_RECENT_CONTACT_UNAVAILABLE')?t('近期会话摘要暂未更新，群与好友仍可浏览。'):t('部分 QQ 资料暂未更新，已有会话仍可查看。');
    const labels:Record<string,string>={QQ_GROUP_LIST_UNAVAILABLE:t('群资料暂时不可用'),QQ_FRIEND_LIST_UNAVAILABLE:t('好友资料暂时不可用'),QQ_LOGIN_INFO_UNAVAILABLE:t('QQ 账号状态暂时无法更新。'),QQ_RECENT_CONTACT_UNAVAILABLE:t('近期会话摘要暂时不可用')};
    directoryDetail.value=[...failures,...[...warnings].map(warning=>labels[warning]||warning)].join('\n');
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
  } catch(cause) {
    if(!controller.signal.aborted&&directoryRequest===controller){directoryWarning.value=t('部分 QQ 连接暂时无法更新，已有会话仍可查看。');directoryDetail.value=userFacingError(cause);}
  } finally { if(directoryRequest===controller)directoryRequest=undefined; }
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
function showList(){restorePosition?.abort();detailPosition={key:selected.value?qqConversationIdentity(selected.value):selectedKey.value,y:window.scrollY};detailOpen.value=false;}
async function choose(conversation:QqConversation){
  restorePosition?.abort();
  const identity=qqConversationIdentity(conversation);
  const position=narrow.value&&!detailOpen.value&&selected.value&&qqConversationIdentity(selected.value)===identity&&detailPosition?.key===identity?detailPosition.y:undefined;
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
watch([()=>selected.value?qqConversationIdentity(selected.value):'',ownQqId,()=>props.active],([identity,account,active],[previousIdentity,previousAccount])=>{
  if(!active||identity!==previousIdentity||account!==previousAccount)membersOpen.value=false;
  void loadMembers();
});
watch(()=>props.routes,()=>{directoryRequest?.abort();directoryRequest=undefined;if(props.active){void loadContacts();void loadMembers();}});
watch(()=>props.active,active=>{if(active){pendingRefresh=false;void load();void loadContacts();}else{restorePosition?.abort();request?.abort();memberRequest?.abort();directoryRequest?.abort();}},{immediate:true});
watch(()=>props.version,()=>{if(props.active)void load();});
watch(()=>props.messageVersion,()=>{if(props.active)void load();});
onBeforeUnmount(()=>{restorePosition?.abort();request?.abort();memberRequest?.abort();directoryRequest?.abort();});
</script>

<template>
  <HistoryConversationLayout :items="[]" :selected="selectedKey" v-model:search="search" :loading="loading" :has-details="selected?.kind==='group'" details-title="群成员" v-model:detail-open="detailOpen" v-model:info-open="membersOpen" @back="showList">
    <template #list-actions><v-btn icon="mdi-refresh" size="small" variant="text" :aria-label="t('刷新会话')" @click="load();loadContacts()" /></template>
    <template #list-notice>
      <QqReadNotice v-if="error" summary="会话暂时无法更新，已有记录仍可查看。" :detail="error" @retry="load()" />
      <QqReadNotice v-if="directoryWarning" :summary="directoryWarning" :detail="directoryDetail" @retry="loadContacts();loadMembers()" />
    </template>
    <template #list>
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
    </template>
    <div class="qq-conversation-detail">
      <MessageEndpointHistory v-if="selected" :key="qqConversationIdentity(selected)" :role-id="roleId" adapter="napcat" :title="nameFor(selected)" :conversation-key="selected.storedConversationKey??selected.conversationKey" :qq-selection="routeFor(selected)&&selected.kind!=='unknown'?{routeId:routeFor(selected)!.routeId,kind:selected.kind,target:selected.target}:undefined" :qq-live="qqLive" :sender-names="senderNames" :sender-avatars="senderAvatars" :own-qq-id="ownQqId" :member-count="selected.kind==='group'&&!membersLoading&&!memberError?members.length:undefined" :version="version" :message-version="messageVersion" :active="active&&(!narrow||detailOpen)" @latest="latestMessage" bubble>
      </MessageEndpointHistory>
      <v-alert v-else type="info" variant="tonal">{{ t('选择群聊或私聊查看消息记录。') }}</v-alert>
    </div>
    <template #details><QqGroupMembers v-if="selected?.kind==='group'" :key="selectedKey" :members="members" :loading="membersLoading" :error="memberError" @refresh="loadMembers" /></template>
  </HistoryConversationLayout>
</template>

<style scoped>
.qq-conversation-title{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:14px;line-height:22px;}
.qq-conversation-title>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qq-conversation-title>time{flex:none;font-size:10px;opacity:.6;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qq-source-badge{font-size:10px;opacity:.6;max-width:48px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qq-historical-conversations{margin-top:8px;border-top:1px solid rgba(var(--v-theme-on-surface),.08);}
.qq-history-summary{cursor:pointer;padding:10px;font-size:12px;opacity:.65;}
.qq-conversation-detail{min-width:0;}
</style>
