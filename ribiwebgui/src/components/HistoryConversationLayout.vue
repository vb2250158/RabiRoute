<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type VNodeRef } from 'vue';
import type { HistoryConversationItem } from '../historyConversationPresentation';
import { useI18n } from '../i18n';
import AgentAvatar from './AgentAvatar.vue';
const props=defineProps<{items:HistoryConversationItem[];selected:string;search:string;loading?:boolean;detailsTitle?:string;hasDetails?:boolean}>();
const emit=defineEmits<{select:[string];'update:search':[string]}>();
const {t,locale}=useI18n();
const detailOpen=ref(false),infoOpen=ref(false),width=ref(240),dragging=ref(false);
const root=ref<HTMLElement>();
const style=computed(()=>({'--history-list-width':`${width.value}px`}));
let pointer:HTMLElement|undefined;
function resize(event:PointerEvent){if(!dragging.value||!root.value)return;width.value=Math.max(200,Math.min(380,event.clientX-root.value.getBoundingClientRect().left));}
function stop(){dragging.value=false;pointer?.removeEventListener('pointermove',resize);pointer=undefined;}
function start(event:PointerEvent){stop();dragging.value=true;pointer=event.currentTarget as HTMLElement;pointer.setPointerCapture(event.pointerId);pointer.addEventListener('pointermove',resize);}
function choose(key:string){detailOpen.value=true;emit('select',key);}
function date(value:string){const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleDateString(locale.value,{month:'numeric',day:'numeric'})+' '+date.toLocaleTimeString(locale.value,{hour:'2-digit',minute:'2-digit'}):'';}
watch(()=>props.selected,(_key,previous)=>{if(previous)detailOpen.value=true;infoOpen.value=false;});
onBeforeUnmount(stop);
</script>
<template>
  <div ref="root" class="history-conversations" :class="{'history-with-details':hasDetails,'history-detail-open':detailOpen,'history-dragging':dragging}" :style="style">
    <aside class="history-list" :aria-label="t('会话列表')">
      <div class="history-search"><v-text-field :model-value="search" @update:model-value="emit('update:search',$event||'')" :placeholder="t('搜索会话或任务')" :aria-label="t('搜索会话或任务')" prepend-inner-icon="mdi-magnify" density="compact" variant="solo-filled" flat clearable hide-details /><slot name="list-actions" /></div>
      <v-progress-linear v-if="loading" indeterminate :aria-label="t('正在加载历史记录')" />
      <slot name="list-notice" />
      <v-list class="history-session-scroll" bg-color="transparent">
        <v-virtual-scroll :items="items" :item-height="72" :renderless="true"><template #default="{item,itemRef}: {item:HistoryConversationItem;itemRef?:VNodeRef}">
        <v-list-item :ref="itemRef" :key="item.key" :active="item.key===selected" @click="choose(item.key)">
          <template #prepend><AgentAvatar v-if="item.agentProvider" :provider="item.agentProvider" :size="44" /><span v-else class="history-avatar" aria-hidden="true">{{ item.title.slice(0,1) }}</span></template>
          <v-list-item-title class="history-row-title"><span :title="item.title" data-no-i18n>{{item.title}}</span><time :datetime="item.time" :title="date(item.time)">{{date(item.time)}}</time></v-list-item-title>
          <v-list-item-subtitle v-if="item.subtitle" data-no-i18n>{{item.subtitle}}</v-list-item-subtitle>
          <v-list-item-subtitle data-no-i18n>{{item.preview}}</v-list-item-subtitle>
        </v-list-item>
        </template></v-virtual-scroll>
        <div v-if="!items.length&&!loading" class="pa-3 text-body-2 text-medium-emphasis">{{t('暂无匹配会话。')}}</div>
        <slot name="list-footer" />
      </v-list>
    </aside>
    <div class="history-splitter" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="t('调整会话列表宽度')" :aria-valuenow="width" :aria-valuemin="200" :aria-valuemax="380" @pointerdown="start" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop" @keydown.left.prevent="width=Math.max(200,width-10)" @keydown.right.prevent="width=Math.min(380,width+10)" @dblclick="width=240" />
    <section class="history-detail">
      <div class="history-mobile-actions"><v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('返回会话')" @click="detailOpen=false" /><v-spacer /><v-btn v-if="hasDetails" icon="mdi-information-outline" variant="text" :aria-label="t(detailsTitle||'详细信息')" @click="infoOpen=true" /></div>
      <slot />
    </section>
    <aside v-if="hasDetails" class="history-info"><slot name="details" /></aside>
    <v-dialog v-if="hasDetails" v-model="infoOpen" max-width="360" scrollable :aria-label="t(detailsTitle||'详细信息')"><v-card><v-card-text><slot name="details" /></v-card-text><v-card-actions><v-spacer /><v-btn @click="infoOpen=false">{{t('关闭')}}</v-btn></v-card-actions></v-card></v-dialog>
  </div>
</template>
<style scoped>
.history-conversations{display:grid;grid-template-columns:var(--history-list-width) 12px minmax(0,1fr);align-items:start;min-width:0;}
.history-conversations.history-with-details{grid-template-columns:var(--history-list-width) 12px minmax(0,1fr) 222px;}
.history-list{position:sticky;top:120px;display:flex;flex-direction:column;min-width:0;max-height:calc(100dvh - 140px);background:rgba(var(--v-theme-on-surface),.025);}
.history-search{display:flex;align-items:center;gap:4px;padding:10px 8px;}
.history-search :deep(.v-field){font-size:12px;border-radius:7px;}
.history-session-scroll{min-height:0;overflow-y:auto;overflow-x:hidden;padding:0;overscroll-behavior:contain;}
.history-session-scroll :deep(.v-list-item){min-height:72px;padding:8px 10px;border-radius:5px;margin:2px 4px;}
.history-session-scroll :deep(.v-list-item__content){min-width:0;}
.history-session-scroll :deep(.v-list-item-subtitle){font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;line-height:20px;}
.history-row-title{display:flex;align-items:baseline;gap:6px;font-size:14px;}
.history-row-title>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.history-row-title>time{font-size:10px;opacity:.6;flex-shrink:0;max-width:74px;overflow:hidden;text-overflow:ellipsis;}
.history-avatar{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;margin-right:10px;background:rgba(var(--v-theme-on-surface),.08);font-size:14px;}
.history-list :deep(.agent-avatar){margin-right:12px;}
.history-splitter{align-self:stretch;min-height:240px;cursor:col-resize;touch-action:none;position:relative;}
.history-splitter::after{content:'';position:absolute;top:0;bottom:0;left:5px;width:2px;background:rgba(var(--v-theme-on-surface),.12);}
.history-splitter:hover::after,.history-splitter:focus-visible::after{background:rgb(var(--v-theme-secondary));}
.history-dragging{user-select:none;}
.history-detail{min-width:0;}
.history-info{position:sticky;top:120px;max-height:calc(100dvh - 140px);overflow-y:auto;min-width:0;padding:12px;border-left:1px solid rgba(var(--v-theme-on-surface),.08);}
.history-mobile-actions{display:none;}
@media(max-width:1200px){.history-conversations.history-with-details{grid-template-columns:var(--history-list-width) 12px minmax(0,1fr);}.history-info{display:none;}.history-mobile-actions{display:flex;align-items:center;}}
@media(min-width:761px){.history-mobile-actions>:first-child{display:none;}}
@media(max-width:760px){.history-conversations,.history-conversations.history-with-details{display:flex;flex-direction:column;}.history-splitter{display:none;}.history-list{width:100%;position:static;max-height:calc(100dvh - 180px);}.history-detail{display:none;width:100%;}.history-detail-open .history-list{display:none;}.history-detail-open .history-detail{display:block;}}
</style>
