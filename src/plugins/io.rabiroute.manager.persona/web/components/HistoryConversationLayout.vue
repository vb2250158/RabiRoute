<script setup lang="ts">
import { computed, ref, watch, type VNodeRef } from 'vue';
import type { HistoryConversationItem } from '../../../../../ribiwebgui/src/historyConversationPresentation';
import { useHistoryConversationLayout } from '../../../../../ribiwebgui/src/historyConversationLayout';
import { qqConversationTime } from '../../../../../ribiwebgui/src/qqChatLayout';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import AgentAvatar from '../../../../../ribiwebgui/src/components/AgentAvatar.vue';
const props = defineProps<{items:HistoryConversationItem[];selected:string;search:string;loading?:boolean;detailsTitle?:string;hasDetails?:boolean;detailOpen?:boolean;infoOpen?:boolean}>();
const emit = defineEmits<{select:[string];'update:search':[string];'update:detailOpen':[boolean];'update:infoOpen':[boolean];back:[]}>();
const {t,locale} = useI18n();
const localDetail = ref(false), localInfo = ref(false), root = ref<HTMLElement>();
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
  <div ref="root" class="history-conversations" :class="{'history-with-details':hasDetails,'history-detail-open':detailOpen,'history-dragging':dragging||details.dragging.value}" :style="style">
    <aside class="history-list" :aria-label="t('会话列表')">
      <div class="history-search"><v-text-field :model-value="search" @update:model-value="emit('update:search',$event||'')" :placeholder="t('搜索会话或任务')" :aria-label="t('搜索会话或任务')" prepend-inner-icon="mdi-magnify" density="compact" variant="solo-filled" flat clearable hide-details /><slot name="list-actions" /></div>
      <v-progress-linear v-if="loading" indeterminate :aria-label="t('正在加载历史记录')" />
      <slot name="list-notice" />
      <v-list class="history-session-scroll" bg-color="transparent">
        <slot name="list">
        <v-virtual-scroll :items="items" :item-height="72" :renderless="true"><template #default="{item,itemRef}: {item:HistoryConversationItem;itemRef?:VNodeRef}">
        <v-list-item :ref="itemRef" :key="item.key" :active="item.key===selected" @click="choose(item.key)">
          <template #prepend><AgentAvatar v-if="item.agentProvider" :provider="item.agentProvider" :size="44" /><span v-else class="history-avatar" aria-hidden="true">{{ item.title.slice(0,1) }}</span></template>
          <v-list-item-title class="history-row-title"><span :title="[item.title,item.subtitle].filter(Boolean).join(' · ')" data-no-i18n>{{item.title}}</span><time :datetime="item.time" :title="fullDate(item.time)">{{date(item.time)}}</time></v-list-item-title>

          <v-list-item-subtitle data-no-i18n>{{item.preview}}</v-list-item-subtitle>
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
      <slot />
    </section>
    <div v-if="hasDetails" class="history-splitter history-info-splitter" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="t('调整右侧列表宽度')" :aria-valuenow="detailsWidth" :aria-valuemin="180" :aria-valuemax="detailsMaximum" @pointerdown="details.start" @pointermove="details.move" @pointerup="details.stop" @pointercancel="details.stop" @lostpointercapture="details.stop" @keydown="details.key" @dblclick="details.reset" />
    <aside v-if="hasDetails" class="history-info"><slot name="details" /></aside>
    <v-dialog v-if="hasDetails" v-model="infoOpen" max-width="360" scrollable :aria-label="t(detailsTitle||'详细信息')"><v-card><v-card-text><slot name="details" /></v-card-text><v-card-actions><v-spacer /><v-btn @click="infoOpen=false">{{t('关闭')}}</v-btn></v-card-actions></v-card></v-dialog>
  </div>
</template>
<style scoped>
.history-conversations{display:grid;grid-template-columns:var(--history-list-width) 12px minmax(0,1fr);align-items:start;min-width:0;}
.history-conversations.history-with-details{grid-template-columns:var(--history-list-width) 12px minmax(0,1fr) 12px var(--history-details-width);}
.history-list{position:sticky;top:120px;display:flex;flex-direction:column;min-width:0;max-height:calc(100dvh - 140px);background:rgba(var(--v-theme-on-surface),.025);}
.history-search{display:flex;align-items:center;gap:4px;padding:10px 8px;}
.history-search :deep(.v-field){font-size:12px;border-radius:7px;}
.history-session-scroll{min-height:0;overflow-y:auto;overflow-x:hidden;padding:0;overscroll-behavior:contain;}
.history-session-scroll :deep(.v-list-item){min-height:72px;padding:8px 10px;border-radius:5px;margin:2px 4px;}
.history-session-scroll :deep(.v-list-item__content){min-width:0;}
.history-session-scroll :deep(.v-list-item-subtitle){font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;line-height:20px;}
.history-row-title{display:flex;align-items:baseline;gap:6px;font-size:14px;}
.history-row-title>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.history-row-title>time{font-size:10px;opacity:.6;flex-shrink:0;max-width:64px;overflow:hidden;text-overflow:ellipsis;}
.history-avatar{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;margin-right:12px;background:rgba(var(--v-theme-on-surface),.08);font-size:14px;}
.history-list :deep(.agent-avatar){margin-right:12px;}
.history-splitter{align-self:stretch;min-height:240px;cursor:col-resize;touch-action:none;position:relative;}
.history-splitter::after{content:'';position:absolute;top:0;bottom:0;left:5px;width:1px;background:var(--rr-border-faint);}
.history-splitter:hover::after,.history-splitter:focus-visible::after{background:rgb(var(--v-theme-secondary));}
.history-dragging{user-select:none;}
.history-detail{min-width:0;}
.history-info{position:sticky;top:120px;height:calc(100dvh - 140px);max-height:calc(100dvh - 140px);overflow-y:auto;overflow-x:hidden;min-width:0;padding:0 0 0 8px;}
.history-mobile-actions{display:none;}
@media(max-width:1200px){.history-conversations.history-with-details{grid-template-columns:var(--history-list-width) 12px minmax(0,1fr);}.history-info,.history-info-splitter{display:none;}.history-mobile-actions{display:flex;align-items:center;position:sticky;top:112px;z-index:4;background:rgb(var(--v-theme-background));}}
@media(min-width:761px){.history-mobile-actions>:first-child{display:none;}}
@media(max-width:760px){.history-conversations,.history-conversations.history-with-details{display:flex;flex-direction:column;}.history-splitter{display:none;}.history-list{width:100%;position:static;max-height:calc(100dvh - 180px);}.history-detail{display:none;width:100%;}.history-detail-open .history-list{display:none;}.history-detail-open .history-detail{display:block;}}
</style>
