<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, type VNodeRef } from 'vue';
import { historyConversationRows, type HistoryConversationItem, type HistoryConversationRow } from '../../../../../ribiwebgui/src/historyConversationPresentation';
import { useHistoryConversationLayout } from '../../../../../ribiwebgui/src/historyConversationLayout';
import { bindChatHistoryScroll } from '../../../../../ribiwebgui/src/personaChatHistoryLayout';
import { qqConversationTime } from '../../../../../ribiwebgui/src/qqChatLayout';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import AgentAvatar from '../../../../../ribiwebgui/src/components/AgentAvatar.vue';
const props = defineProps<{items:HistoryConversationItem[];grouped?:boolean;projectPreviewLimit?:number;selected:string;search:string;loading?:boolean;detailsTitle?:string;hasDetails?:boolean;detailOpen?:boolean;infoOpen?:boolean}>();
const emit = defineEmits<{select:[string];search:[];'update:search':[string];'update:detailOpen':[boolean];'update:infoOpen':[boolean];back:[]}>();
const {t,locale} = useI18n();
const collapsedGroups = ref(new Set<string>()), expandedGroups = ref(new Set<string>());
const rows = computed(() => historyConversationRows(props.items, Boolean(props.grouped), collapsedGroups.value, props.projectPreviewLimit ? {limit:props.projectPreviewLimit,expanded:expandedGroups.value} : undefined));
function expandGroup(key:string) { expandedGroups.value = new Set([...expandedGroups.value,key]); }
function toggleGroup(key:string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  collapsedGroups.value = next;
}
const localDetail = ref(false), localInfo = ref(false), root = ref<HTMLElement>(), scrollElement = ref<HTMLElement>(), scrollContent = ref<HTMLElement>();
let scrollBinding: ReturnType<typeof bindChatHistoryScroll> | undefined;
onMounted(() => { if (scrollElement.value && scrollContent.value) scrollBinding = bindChatHistoryScroll(scrollElement.value, scrollContent.value); });
onBeforeUnmount(() => { scrollBinding?.dispose(); });
function restoreScroll(top:number) { scrollBinding?.restorePosition(top); }
defineExpose({ scrollElement, restoreScroll });
const detailOpen = computed({ get: () => props.detailOpen ?? localDetail.value, set: value => { localDetail.value = value; emit('update:detailOpen', value); } });
const infoOpen = computed({ get: () => props.infoOpen ?? localInfo.value, set: value => { localInfo.value = value; emit('update:infoOpen', value); } });
const {width,maximum,detailsWidth,detailsMaximum,dragging,start,move,stop,key,reset,details} = useHistoryConversationLayout(root, () => Boolean(props.hasDetails));
const style = computed(() => ({'--history-list-width': `${width.value}px`,'--history-details-width': `${detailsWidth.value}px`}));
function choose(value:string) { emit('select',value); detailOpen.value=true; }
function back() { emit('back'); detailOpen.value=false; }
function date(value:string) { const time=new Date(value).getTime(); return Number.isFinite(time)?qqConversationTime(time/1000,undefined,locale.value):''; }
function fullDate(value:string) { const date=new Date(value); return Number.isFinite(date.getTime())?date.toLocaleString(locale.value):''; }
// Background key aliases do not represent a user opening another conversation.
watch(() => props.selected, () => { if(props.infoOpen===undefined) infoOpen.value=false; });
</script>
<template>
  <div ref="root" class="history-conversations" :class="{'history-project-view':grouped,'history-with-details':hasDetails,'history-detail-open':detailOpen,'history-dragging':dragging||details.dragging.value}" :style="style">
    <aside class="history-list" :aria-label="t('会话列表')">
      <div class="history-search"><v-text-field :model-value="search" @update:model-value="emit('update:search',$event||'')" @keydown.enter.prevent="emit('search')" :placeholder="t('搜索会话或任务')" :aria-label="t('搜索会话或任务')" prepend-inner-icon="mdi-magnify" density="compact" variant="solo-filled" flat clearable hide-details /><slot name="list-actions" /></div>
      <v-progress-linear v-if="loading" indeterminate :aria-label="t('正在加载历史记录')" />
      <slot name="list-notice" />
      <v-list class="history-session-scroll" bg-color="transparent">
        <slot name="list">
        <v-virtual-scroll :items="rows" :item-height="grouped ? 56 : 72" :renderless="true"><template #default="{item:row,itemRef}: {item:HistoryConversationRow;itemRef?:VNodeRef}">
        <v-list-subheader v-if="row.kind==='group'" :ref="itemRef" :key="row.key" class="history-project-heading"><button type="button" class="history-project-toggle" :aria-expanded="!collapsedGroups.has(row.key)" :title="row.path" @click="toggleGroup(row.key)"><v-icon :icon="collapsedGroups.has(row.key) ? 'mdi-chevron-right' : 'mdi-chevron-down'" size="16" /><v-icon icon="mdi-folder-outline" size="18" /><span data-no-i18n>{{row.title}}</span></button></v-list-subheader>
        <v-btn v-else-if="row.kind==='more'" :ref="itemRef" :key="row.key" class="history-project-more" variant="text" size="small" :aria-label="t('展开显示')+' '+row.title" @click="expandGroup(row.groupKey)">{{t('展开显示')}}</v-btn>
        <v-list-item v-else :ref="itemRef" :key="row.conversation.key" :active="row.conversation.key===selected" @click="choose(row.conversation.key)">
          <template v-if="!grouped" #prepend><AgentAvatar v-if="row.conversation.agentProvider" :provider="row.conversation.agentProvider" :size="44" /><span v-else class="history-avatar" aria-hidden="true">{{ row.conversation.title.slice(0,1) }}</span></template>
          <v-list-item-title class="history-row-title"><span :title="[row.conversation.title,row.conversation.subtitle].filter(Boolean).join(' · ')" data-no-i18n>{{row.conversation.title}}</span><time :datetime="row.conversation.time" :title="fullDate(row.conversation.time)">{{date(row.conversation.time)}}</time></v-list-item-title>

          <v-list-item-subtitle data-no-i18n>{{row.conversation.preview}}</v-list-item-subtitle>
        </v-list-item>
        </template></v-virtual-scroll>
        <div v-if="!items.length&&!loading" class="pa-3 text-body-2 text-medium-emphasis">{{t('暂无匹配会话。')}}</div>
        </slot>
        <slot name="list-footer" />
      </v-list>
    </aside>
    <div class="history-splitter" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="t('调整会话列表宽度')" :aria-valuenow="width" :aria-valuemin="200" :aria-valuemax="maximum" @pointerdown="start" @pointermove="move" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop" @keydown="key" @dblclick="reset" />
    <section class="history-detail">
      <div class="history-mobile-actions"><v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('返回会话')" @click="back" /><v-spacer /><v-btn v-if="hasDetails" icon="mdi-information-outline" variant="text" :aria-label="t(detailsTitle||'详细信息')" @click="infoOpen=true" /></div>
      <div ref="scrollElement" class="history-message-scroll" data-history-scroll tabindex="0" :aria-label="t('消息记录')"><div ref="scrollContent" class="history-scroll-content"><slot /></div></div>
    </section>
    <div v-if="hasDetails" class="history-splitter history-info-splitter" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="t('调整右侧列表宽度')" :aria-valuenow="detailsWidth" :aria-valuemin="180" :aria-valuemax="detailsMaximum" @pointerdown="details.start" @pointermove="details.move" @pointerup="details.stop" @pointercancel="details.stop" @lostpointercapture="details.stop" @keydown="details.key" @dblclick="details.reset" />
    <aside v-if="hasDetails" class="history-info"><slot name="details" /></aside>
    <v-dialog v-if="hasDetails" v-model="infoOpen" max-width="360" scrollable :aria-label="t(detailsTitle||'详细信息')"><v-card><v-card-text><slot name="details" /></v-card-text><v-card-actions><v-spacer /><v-btn @click="infoOpen=false">{{t('关闭')}}</v-btn></v-card-actions></v-card></v-dialog>
  </div>
</template>
<style scoped>
.history-conversations{display:grid;grid-template-columns:var(--history-list-width) 12px minmax(0,1fr);align-items:stretch;min-width:0;min-height:0;height:100%;flex:1;}
.history-conversations.history-with-details{grid-template-columns:var(--history-list-width) 12px minmax(0,1fr) 12px var(--history-details-width);}
.history-list{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;background:rgba(var(--v-theme-on-surface),.025);}
.history-search{display:flex;align-items:center;gap:4px;padding:10px 8px;}
.history-search :deep(.v-field){font-size:12px;border-radius:7px;}
.history-session-scroll{min-height:0;overflow-y:auto;overflow-x:hidden;padding:0;overscroll-behavior:contain;}
.history-session-scroll :deep(.v-list-item){min-height:72px;padding:8px 10px;border-radius:5px;margin:2px 4px;}
.history-session-scroll :deep(.v-list-item__content){min-width:0;}
.history-session-scroll :deep(.v-list-item-subtitle){font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;line-height:20px;}
.history-project-view .history-session-scroll :deep(.v-list-item){min-height:56px;margin-left:40px;padding:6px 8px 6px 12px;}
.history-project-view .history-session-scroll :deep(.v-list-item-subtitle){font-size:11px;line-height:18px;}
.history-project-view .history-row-title{font-size:13px;line-height:20px;}
.history-project-view .history-row-title>time{display:none;}
.history-project-more{margin:0 12px 10px 44px;text-transform:none;letter-spacing:normal;opacity:.7;}
.history-project-heading{min-height:40px;gap:8px;padding:8px 14px;font-weight:600;}
.history-project-heading :deep(.v-list-subheader__text){width:100%;min-width:0;}
.history-project-toggle{display:flex;align-items:center;gap:6px;width:100%;text-align:left;color:inherit;font:inherit;border:0;background:transparent;cursor:pointer;}
.history-project-heading span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.history-row-title{display:flex;align-items:baseline;gap:6px;font-size:14px;}
.history-row-title>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.history-row-title>time{font-size:10px;opacity:.6;flex-shrink:0;max-width:64px;overflow:hidden;text-overflow:ellipsis;}
.history-avatar{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;margin-right:12px;background:rgba(var(--v-theme-on-surface),.08);font-size:14px;}
.history-list :deep(.agent-avatar){margin-right:12px;}
.history-splitter{align-self:stretch;min-height:0;cursor:col-resize;touch-action:none;position:relative;}
.history-splitter::after{content:'';position:absolute;top:0;bottom:0;left:5px;width:1px;background:var(--rr-border-faint);}
.history-splitter:hover::after,.history-splitter:focus-visible::after{background:rgb(var(--v-theme-secondary));}
.history-dragging{user-select:none;}
.history-detail{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;}
.history-message-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;}
.history-message-scroll,.history-session-scroll,.history-info{overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(var(--v-theme-on-surface),.25) transparent;scrollbar-gutter:stable;}
.history-message-scroll::-webkit-scrollbar,.history-session-scroll::-webkit-scrollbar,.history-info::-webkit-scrollbar{width:6px;}
.history-message-scroll::-webkit-scrollbar-thumb,.history-session-scroll::-webkit-scrollbar-thumb,.history-info::-webkit-scrollbar-thumb{border-radius:8px;background:rgba(var(--v-theme-on-surface),.25);}
.history-message-scroll::-webkit-scrollbar-track,.history-session-scroll::-webkit-scrollbar-track,.history-info::-webkit-scrollbar-track{background:transparent;}
.history-info{height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;min-width:0;padding:0 0 0 8px;}
.history-mobile-actions{display:none;}
@media(max-width:1200px){.history-conversations.history-with-details{grid-template-columns:var(--history-list-width) 12px minmax(0,1fr);}.history-info,.history-info-splitter{display:none;}.history-mobile-actions{display:flex;align-items:center;flex:none;z-index:4;background:rgb(var(--v-theme-background));}}
@media(min-width:761px){.history-mobile-actions>:first-child{display:none;}}
@media(max-width:760px){.history-conversations,.history-conversations.history-with-details{display:flex;flex-direction:column;}.history-splitter{display:none;}.history-list{width:100%;position:static;}.history-detail{display:none;width:100%;}.history-detail-open .history-list{display:none;}.history-detail-open .history-detail{display:flex;}}
</style>
