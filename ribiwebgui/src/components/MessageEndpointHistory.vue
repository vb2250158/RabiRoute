<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch, type VNodeRef } from 'vue';
import HistoryEndpointMessage from './HistoryEndpointMessage.vue';
import type { MessageContextRecord } from '../../../src/messageContextStore';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../i18n';
import { userFacingError } from '../userFacingError';
import { waitForChatHistoryFrame } from '../personaChatHistoryLayout';
import QqHistoryMessage from './QqHistoryMessage.vue';
import QqMessageDetails from './QqMessageDetails.vue';
import QqImagePreview from './QqImagePreview.vue';
import QqMessageContent from './QqMessageContent.vue';
import QqReadNotice from './QqReadNotice.vue';
import { qqTimeBreak, qqMessageTime } from '../qqChatLayout';
import {qqNavigationRead} from '../qqPreviewQueue';
import { historyPageForDisplay,mergeSavedHistoryWindow } from '../historyConversationPresentation';
import { qqHistoryRecord,mergeQqHistoryWindow, type QqHistoryMessage as QqNativeHistoryMessage, type QqHistoryRecord, type QqSelection } from '../qqMessagePresentation';

const props = defineProps<{ roleId: string; adapter: string; title: string; version: number; messageVersion?:number; active: boolean; conversationKey?: string; bubble?: boolean; senderNames?: Record<string,string>; senderAvatars?: Record<string,string>; ownQqId?: string; qqSelection?: QqSelection; qqLive?:boolean; memberCount?:number }>();
const emit=defineEmits<{latest:[QqHistoryRecord]}>();
const { fetch } = usePersonaService();
const { t,locale } = useI18n();
const entries = ref<QqHistoryRecord[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(false), error = ref(''), partial = ref(false);
const connectionLost=ref(false),skippedCount=ref(0),unreadablePage=ref(false);
const showEmptyHistory=computed(()=>!entries.value.length&&!loading.value&&!error.value&&!skippedCount.value);
let nativeWindow=false,confirmedAccount=props.ownQqId;
const expanded = ref(new Set<string>());
const detailsRecord = ref<QqHistoryRecord>();
const imagePreview=ref<{blob:Blob;name:string}>(),quotedMessage=ref<QqNativeHistoryMessage>(),newerAvailable=ref(false);
const listElement = ref<HTMLElement>(), virtualList = ref<{ scrollToIndex(index: number): void }>();
const conversation = ref(props.conversationKey ?? ''), appliedConversation = ref(props.conversationKey ?? '');
let request: AbortController | undefined;
let pending = false;
let pendingUpdate=false;
const key = (record: MessageContextRecord) => record.id || `${record.adapter}:${record.conversationKey}:${record.sequence}:${record.time}`;
const timeBreaks = computed(()=>new Set(entries.value.filter((row,index)=>row.time>0&&qqTimeBreak(row.time,entries.value[index-1]?.time||undefined)).map(key)));
const avatarId=(record:MessageContextRecord)=>record.direction==='outbound'?record.qqSenderId||props.ownQqId:record.qqSenderId||(props.qqSelection?.kind==='private'?props.qqSelection.target:props.senderAvatars?.[record.sender??'']);
async function load(older = false,update=false) {
  if(nativeWindow&&!props.qqLive){connectionLost.value=true;return;}
  if (request) { if (!older){pendingUpdate=pending?pendingUpdate&&update:update;pending=true;} return; }
  const controller = new AbortController(); request = controller; loading.value = true; error.value = '';
  try {
    const live=props.qqLive&&props.qqSelection&&(!older||nativeWindow)?props.qqSelection:undefined;
    const query = new URLSearchParams(live?{...live,limit:'50'}:{ adapter: props.adapter, limit: '50', includeArchives: '1' });
    if (!live&&appliedConversation.value) query.set('conversationKey', appliedConversation.value);
    if (older && cursor.value) query.set('cursor', cursor.value);
    const response = await (live?qqNavigationRead(controller.signal,()=>fetch(`/api/agent/qq/history?${query}`,{signal:controller.signal})):fetch(`/api/roles/${encodeURIComponent(props.roleId)}/message-endpoint-timeline?${query}`, { signal: controller.signal }));
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.message || t('消息记录读取失败'));
    if (controller.signal.aborted) return;
    const page = historyPageForDisplay(live?(result.data.entries as QqNativeHistoryMessage[]).map(row=>qqHistoryRecord(row,live,props.ownQqId)):result.data.entries as MessageContextRecord[],Boolean(props.bubble),Boolean(live));
    const known = new Set(entries.value.map(key));
    if(update&&entries.value.length&&nativeWindow!==Boolean(live)){
      newerAvailable.value=true;if(props.bubble&&page.length)emit('latest',page.at(-1)!);return;
    }
    skippedCount.value=live?result.data.skippedCount??0:0;
    unreadablePage.value=Boolean(skippedCount.value&&!page.length);
    const anchor = [...(listElement.value?.querySelectorAll<HTMLElement>('.history-record') ?? [])].find(element => element.getBoundingClientRect().bottom > 0);
    const anchorId = anchor?.dataset.entryId, anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    const atBottom=Boolean(listElement.value&&listElement.value.getBoundingClientRect().bottom<=window.innerHeight+80);
    const incremental=update&&props.bubble&&entries.value.length>0;
    if (older) {
      const additions=page.filter(record=>!known.has(key(record)));
      if(props.bubble&&entries.value.length+additions.length>200)newerAvailable.value=true;
      entries.value=props.bubble?[...additions,...entries.value].slice(0,200):[...entries.value,...additions].slice(-200);
    }
    else if(incremental){
      const first=entries.value[0]!,merged=live?mergeQqHistoryWindow(entries.value,page,atBottom):mergeSavedHistoryWindow(entries.value,page,atBottom,key);
      const droppedHead=!merged.entries.some(row=>key(row)===key(first));
      entries.value=merged.entries;newerAvailable.value=merged.newerAvailable||(!atBottom&&newerAvailable.value);
      if(droppedHead){
        if(live)cursor.value=String(entries.value[0]!.messageId);
        else{entries.value=page;cursor.value=result.data.nextCursor;}
      }
    }else if(!unreadablePage.value) {
      // An unreadable live page preserves cached messages instead of claiming an empty history.
      // A refresh replaces the bounded window; it never silently bridges a missing page.
      entries.value = page; expanded.value.clear();
      newerAvailable.value=false;
    }
    nativeWindow=Boolean(live);connectionLost.value=false;
    if(!incremental)cursor.value = result.data.nextCursor;
    if(props.bubble&&page.length)emit('latest',page.at(-1)!);
    partial.value = !live&&result.data.coverage.indexCoverage === 'partial';
    const ids = new Set(entries.value.map(key));
    for (const id of expanded.value) if (!ids.has(id)) expanded.value.delete(id);
    await nextTick();
    if(props.bubble&&!older&&!unreadablePage.value&&(!incremental||atBottom)) {
      const interrupt=()=>controller.abort();
      const events=['wheel','touchstart','pointerdown','keydown'] as const;
      for(const event of events)window.addEventListener(event,interrupt,{passive:true});
      try {
        virtualList.value?.scrollToIndex(entries.value.length-1);
        for(let frame=0;frame<12;frame++) {
          if(!await waitForChatHistoryFrame(controller.signal))break;
          if(listElement.value)window.scrollTo(0,window.scrollY+listElement.value.getBoundingClientRect().bottom-window.innerHeight+24);
        }
      }finally{for(const event of events)window.removeEventListener(event,interrupt);}
    }
    if ((older||(incremental&&!atBottom)) && anchorId) {
      const interrupt = () => controller.abort();
      const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
      for (const event of events) window.addEventListener(event, interrupt, { passive: true });
      try {
        let requested = false;
        for (let frame = 0; frame < 12; frame++) {
          if (!await waitForChatHistoryFrame(controller.signal)) break;
          const current = [...(listElement.value?.querySelectorAll<HTMLElement>('.history-record') ?? [])].find(element => element.dataset.entryId === anchorId);
          if (current) window.scrollBy(0, current.getBoundingClientRect().top - anchorTop);
          else if (!requested) { virtualList.value?.scrollToIndex(entries.value.findIndex(record => key(record) === anchorId)); requested = true; }
        }
      } finally { for (const event of events) window.removeEventListener(event, interrupt); }
    }
  } catch (cause) { if (!controller.signal.aborted) error.value = userFacingError(cause); }
  finally {
    if (request === controller) { request = undefined; loading.value = false; if (pending && props.active) { const updateNext=pendingUpdate;pending=false;pendingUpdate=false;void load(false,updateNext); } }
  }
}
function applyConversation() {
  request?.abort(); request = undefined; pending = false; pendingUpdate=false;
  appliedConversation.value = (conversation.value || '').trim(); entries.value = []; cursor.value = null; skippedCount.value=0;unreadablePage.value=false;expanded.value.clear(); void load();
}
watch(() => props.version, () => { if (props.active && !entries.value.length) void load(); });
watch(()=>props.messageVersion,()=>{if(props.active&&props.bubble)void load(false,true);});
watch(()=>[props.qqLive,props.conversationKey] as const,([live,conversationKey],[previousLive])=>{
  if(live&&previousLive)return;
  request?.abort();request=undefined;pending=false;pendingUpdate=false;loading.value=false;appliedConversation.value=conversationKey??'';
  skippedCount.value=0;unreadablePage.value=false;
  connectionLost.value=nativeWindow&&!live;
  if(props.active&&(!entries.value.length||(live&&!previousLive)))void load(false,entries.value.length>0);
});
watch(()=>props.ownQqId,id=>{
  if(!id)return;
  const changed=confirmedAccount&&confirmedAccount!==id;confirmedAccount=id;
  if(!changed)return;
  detailsRecord.value=undefined;skippedCount.value=0;unreadablePage.value=false;
  imagePreview.value=undefined;quotedMessage.value=undefined;
  request?.abort();request=undefined;pending=false;pendingUpdate=false;loading.value=false;entries.value=[];cursor.value=null;nativeWindow=false;connectionLost.value=false;
  if(props.active)void load();
});
watch(() => props.active, active => { if (active) { if(!entries.value.length)void load();else if(props.bubble)void load(false,true); } else { request?.abort(); pending = false; pendingUpdate=false;detailsRecord.value=undefined;imagePreview.value=undefined;quotedMessage.value=undefined; } }, { immediate: true });
onBeforeUnmount(() => { pending = false; request?.abort(); });
onDeactivated(()=>{pending=false;pendingUpdate=false;request?.abort();});
onActivated(()=>{if(entries.value.length&&props.active)void load(false,true);});
</script>

<template>
  <v-card class="app-card glass-card pa-4" :class="{'qq-chat-surface':bubble}">
    <div class="d-flex align-center justify-space-between ga-3 mb-3" :class="{'qq-chat-header':bubble}">
      <slot v-if="bubble" name="back" />
      <div class="qq-chat-heading"><div v-if="bubble" class="text-h6" data-no-i18n>{{ title }}<span v-if="memberCount!==undefined" class="qq-member-count"> ({{ memberCount }})</span></div><div v-else class="text-h6">{{ t(title) }}</div><div v-if="!bubble" class="text-body-2 text-medium-emphasis">{{ t('最新消息在前。') }}</div></div>
      <div v-if="bubble" class="d-flex align-center"><slot name="actions" /><v-btn icon="mdi-refresh" size="small" variant="text" :aria-label="t('刷新消息')" :loading="loading" @click="load()" /></div>
      <v-btn v-else variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load()">{{ t('刷新') }}</v-btn>
    </div>
    <form v-if="!bubble" class="d-flex align-center ga-2 mb-3" @submit.prevent="applyConversation">
      <v-text-field v-model="conversation" :label="t('会话标识')" clearable hide-details />
      <v-btn type="submit" variant="tonal">{{ t('筛选') }}</v-btn>
    </form>
    <QqReadNotice v-if="error&&bubble" summary="消息暂时无法更新，已有记录仍可查看。" :detail="error" @retry="load(false,true)" />
    <v-alert v-else-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="partial" type="warning" variant="tonal" class="mb-3">{{ t('部分历史记录未覆盖，当前结果可能不完整。') }}</v-alert>
    <v-alert v-if="connectionLost" type="warning" variant="tonal" class="mb-3">{{ t('QQ 连接已断开，保留已加载的消息。') }}</v-alert>
    <div v-if="skippedCount" class="d-flex align-center ga-2 my-2 text-caption text-medium-emphasis" role="status"><v-icon icon="mdi-information-outline" size="16" /><span>{{ t(unreadablePage?'本页消息无法读取，历史记录可能不完整。':'部分消息无法读取，其他消息仍可查看。') }}</span></div>
    <v-progress-linear v-if="loading" indeterminate :aria-label="t('正在读取消息记录')" />
    <v-btn v-if="bubble&&cursor!==null&&(!nativeWindow||qqLive)" variant="tonal" :disabled="loading" class="mb-3" @click="load(true)">{{ t('加载更早的消息') }}</v-btn>
    <v-alert v-if="showEmptyHistory" type="info" variant="tonal">{{ t('此渠道暂无消息记录。') }}</v-alert>
    <div ref="listElement" class="endpoint-history-list" :class="{'qq-history':bubble}" :aria-busy="loading" aria-live="polite">
      <template v-if="bubble">
        <div v-for="item in entries" :key="key(item)" class="endpoint-history-item">
          <div v-if="timeBreaks.has(key(item))" class="qq-time-divider"><time :datetime="new Date(item.time*1000).toISOString()" :title="new Date(item.time*1000).toLocaleString(locale)">{{ qqMessageTime(item.time,undefined,locale) }}</time></div>
          <QqHistoryMessage v-if="adapter==='napcat'" :record="item" :avatar-id="avatarId(item)" :sender-name="senderNames?.[item.sender??'']||item.qqSenderName||item.sender" :selection="qqSelection" :names="senderNames" :active="active" :expanded="expanded.has(key(item))" @expand="expanded.has(key(item))?expanded.delete(key(item)):expanded.add(key(item))" @details="detailsRecord=item" :readable="qqLive" @image="imagePreview=$event" @quote="quotedMessage=$event" />
          <HistoryEndpointMessage v-else :record="item" :expanded="expanded.has(key(item))" @expand="expanded.has(key(item))?expanded.delete(key(item)):expanded.add(key(item))" />
        </div>
      </template>
      <v-virtual-scroll v-else-if="entries.length" ref="virtualList" :items="entries" item-key="id" :renderless="true" :item-height="180">
        <template #default="{ item, itemRef }: { item: QqHistoryRecord; itemRef?: VNodeRef }">
          <div :ref="itemRef" class="endpoint-history-item">
            <article class="history-record" :class="{outgoing:item.direction==='outbound'}" :data-entry-id="key(item)">
              <div class="text-caption text-medium-emphasis">{{ new Date(item.time * 1000).toLocaleString() }} · {{ t(item.direction === 'inbound' ? '收到' : item.direction === 'outbound' ? '发出' : '系统') }}<span v-if="item.status"> · {{ item.status }}</span></div>
              <div class="text-caption mt-1"><span data-no-i18n>{{ senderNames?.[item.sender??''] || item.qqSenderName || item.sender }}</span><span v-if="item.target&&!bubble"> → <span data-no-i18n>{{ item.target }}</span></span></div>
              <div class="history-text mt-2" :class="{'history-summary':!expanded.has(key(item))&&item.text.length>2000}" data-no-i18n>{{ expanded.has(key(item)) ? item.text : item.text.slice(0, 2000) }}{{ !expanded.has(key(item)) && item.text.length > 2000 ? '…' : '' }}</div>
              <v-btn v-if="item.text.length > 2000" variant="text" @click="expanded.has(key(item)) ? expanded.delete(key(item)) : expanded.add(key(item))">{{ t(expanded.has(key(item)) ? '收起' : '展开全文') }}</v-btn>
              <div v-if="!bubble&&item.attachments?.length" class="d-flex flex-wrap ga-2 mt-2"><v-chip v-for="(attachment,index) in item.attachments" :key="attachment.id || index" size="small" variant="tonal" data-no-i18n>{{ attachment.name || attachment.kind || t('附件') }}</v-chip></div>
              <details class="mt-2 text-caption text-medium-emphasis"><summary>{{ t('会话与来源') }}</summary><div data-no-i18n>{{ item.gatewayId }} · {{ item.instanceId }}</div><div data-no-i18n>{{ item.conversationKey }}</div><div data-no-i18n>{{ item.messageId || item.id }}</div></details>
            </article>
          </div>
        </template>
      </v-virtual-scroll>
    </div>
    <v-btn v-if="!bubble&&cursor !== null" variant="tonal" :disabled="loading" class="mt-3" @click="load(true)">{{ t('加载更早的消息') }}</v-btn>
    <v-btn v-if="newerAvailable" class="qq-new-messages" color="secondary" prepend-icon="mdi-arrow-down" @click="load()">{{ t('回到最新消息') }}</v-btn>
    <QqImagePreview v-if="imagePreview" :image="imagePreview" @close="imagePreview=undefined" />
    <v-dialog v-if="quotedMessage" :model-value="true" max-width="680" @update:model-value="!$event&&(quotedMessage=undefined)"><v-card :title="t('引用消息')"><v-card-text><div class="text-caption text-medium-emphasis mb-2" data-no-i18n>{{ senderNames?.[quotedMessage.sender]||quotedMessage.senderName||quotedMessage.sender }}</div><QqMessageContent :text="quotedMessage.text" :structured-parts="quotedMessage.parts" :message-id="quotedMessage.messageId" :selection="qqSelection" :names="senderNames" :active="active" :readable="qqLive" @image="imagePreview=$event" @quote="quotedMessage=$event" /></v-card-text><v-card-actions><v-spacer /><v-btn @click="quotedMessage=undefined">{{ t('关闭') }}</v-btn></v-card-actions></v-card></v-dialog>
    <QqMessageDetails v-if="detailsRecord" :record="detailsRecord" :sender-name="senderNames?.[detailsRecord.sender??'']||detailsRecord.qqSenderName||detailsRecord.sender" @close="detailsRecord=undefined" />
  </v-card>
</template>

<style scoped>
.endpoint-history-list { overflow-anchor: none; }
.endpoint-history-item { padding-bottom: 16px; }
.history-record { padding: 16px; border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 12px; overflow-wrap: anywhere; }
.history-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
.history-summary { display:-webkit-box; -webkit-line-clamp:8; -webkit-box-orient:vertical; overflow:hidden; }
details { overflow-wrap: anywhere; }
summary { cursor: pointer; }
.qq-chat-surface {overflow:visible!important;border:0!important;border-radius:0!important;background:transparent!important;padding:0 18px 20px!important;box-shadow:none!important;backdrop-filter:none!important;}
.qq-chat-header {position:sticky;top:112px;z-index:4;min-height:58px;margin:0 -18px 16px!important;padding:8px 18px;background:rgb(var(--v-theme-background));border-bottom:1px solid rgba(var(--v-theme-on-surface),.08);}
.qq-chat-heading {min-width:0;flex:1;}
.qq-chat-heading .text-h6 {font-size:17px!important;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qq-member-count {font-weight:400;font-size:14px;color:rgba(var(--v-theme-on-surface),.6);}
.qq-new-messages {position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:6;}
.qq-time-divider {text-align:center;font-size:12px;color:rgba(var(--v-theme-on-surface),.45);margin:8px 0 20px;}
.qq-history .endpoint-history-item {padding-bottom:20px;}
@media(max-width:760px) {.qq-chat-surface {padding:0 10px 12px!important;} .qq-chat-header {margin:0 -10px 16px!important;padding:8px 10px;}}
</style>
