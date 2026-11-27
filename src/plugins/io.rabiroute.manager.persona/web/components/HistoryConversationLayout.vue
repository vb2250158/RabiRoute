<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, type VNodeRef } from 'vue';
import { historyConversationRows, historyDeviceRows, type HistoryConversationDevice, type HistoryConversationItem, type HistoryDeviceRow } from '../../../../../ribiwebgui/src/historyConversationPresentation';
import { useHistoryConversationLayout } from '../../../../../ribiwebgui/src/historyConversationLayout';
import { bindChatHistoryScroll } from '../../../../../ribiwebgui/src/personaChatHistoryLayout';
import { qqConversationTime } from '../../../../../ribiwebgui/src/qqChatLayout';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import AgentAvatar from '../../../../../ribiwebgui/src/components/AgentAvatar.vue';
const props = defineProps<{items:HistoryConversationItem[];grouped?:boolean;compact?:boolean;projectPreviewLimit?:number;selected:string;search:string;loading?:boolean;detailsTitle?:string;hasDetails?:boolean;detailOpen?:boolean;infoOpen?:boolean;
  /** Two-level device tree; omitted keeps the original single-group list. */
  devices?:HistoryConversationDevice[];deviceLoading?:ReadonlySet<string>;deviceError?:ReadonlyMap<string,string>}>();
const emit = defineEmits<{select:[string];search:[];'update:search':[string];'update:detailOpen':[boolean];'update:infoOpen':[boolean];back:[];expandDevice:[string]}>();
const {t,locale} = useI18n();
const collapsedGroups = ref(new Set<string>()), expandedGroups = ref(new Set<string>()), collapsedDevices = ref(new Set<string>());
/** A device without `defaultOpen` starts folded, so one computer's sessions never bury the others. */
const seededDevices = new Set<string>();
watch(() => props.devices, devices => {
  if (!devices) return;
  const next = new Set(collapsedDevices.value);
  let changed = false;
  for (const device of devices) {
    const key = `device:${device.key}`;
    if (seededDevices.has(key)) continue;
    seededDevices.add(key);
    if (device.defaultOpen !== true) { next.add(key); changed = true; }
  }
  if (changed) collapsedDevices.value = next;
}, { immediate: true });
const previewLimit = computed(() => props.projectPreviewLimit ?? 5);
const items = computed(() => props.items);
/** Device and project collapse share one key set so the tree filters both levels. */
const collapsedKeys = computed(() => new Set([...collapsedDevices.value, ...collapsedGroups.value]));
const rows = computed(():HistoryDeviceRow[] => props.devices
  ? historyDeviceRows(items.value, props.devices, collapsedKeys.value, { limit: previewLimit.value, expanded: expandedGroups.value })
  : (historyConversationRows(items.value, Boolean(props.grouped), collapsedGroups.value,
      props.projectPreviewLimit ? { limit: props.projectPreviewLimit, expanded: expandedGroups.value } : undefined) as HistoryDeviceRow[]));
const rowHeight = computed(() => props.compact ? 30 : 40);
/** A device with no loaded rows asks its owner once, then the caller streams them in. */
function toggleDevice(row: Extract<HistoryDeviceRow,{kind:'device'}>) {
  const next = new Set(collapsedDevices.value);
  if (next.has(row.key)) next.delete(row.key);
  else { next.add(row.key); return; }
  collapsedDevices.value = next;
  if (!row.loaded && row.device.status !== 'offline') emit('expandDevice', row.device.key);
}
function deviceExpanded(key:string) { return !collapsedDevices.value.has(key); }
/** Projects start folded so the device and project overview stays visible without scrolling. */
const seededProjects = new Set<string>();
const OPEN_PROJECTS_PER_DEVICE = 0;
watch(rows, list => {
  const next = new Set(collapsedGroups.value);
  const opened = new Map<string, number>();
  let changed = false;
  for (const row of list) {
    if (row.kind !== 'group' || seededProjects.has(row.key)) continue;
    seededProjects.add(row.key);
    const used = opened.get(row.deviceKey) ?? 0;
    opened.set(row.deviceKey, used + 1);
    if (used >= OPEN_PROJECTS_PER_DEVICE) { next.add(row.key); changed = true; }
  }
  if (changed) collapsedGroups.value = next;
}, { immediate: true });
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
function clearSearch() { emit('update:search',''); emit('search'); }
function date(value:string) { const time=new Date(value).getTime(); return Number.isFinite(time)?qqConversationTime(time/1000,undefined,locale.value):''; }function fullDate(value:string) { const date=new Date(value); return Number.isFinite(date.getTime())?date.toLocaleString(locale.value):''; }
const projectCount = computed(() => new Set(rows.value.filter(row => row.kind === 'group').map(row => (row as Extract<HistoryDeviceRow,{kind:'group'}>).deviceKey)).size);
// Background key aliases do not represent a user opening another conversation.
watch(() => props.selected, () => { if(props.infoOpen===undefined) infoOpen.value=false; });
</script>
<template>
  <div ref="root" class="history-conversations" :class="{'history-project-view':grouped,'history-compact':compact,'history-tree':Boolean(devices),'history-with-details':hasDetails,'history-detail-open':detailOpen,'history-dragging':dragging||details.dragging.value}" :style="style">
    <aside class="history-list" :aria-label="t('会话列表')">
      <div class="history-search"><v-text-field :model-value="search" @update:model-value="emit('update:search',$event||'')" @keydown.enter.prevent="emit('search')" :placeholder="t('搜索会话或任务')" :aria-label="t('搜索会话或任务')" prepend-inner-icon="mdi-magnify" density="compact" variant="solo-filled" flat clearable hide-details /><slot name="list-actions" /></div>
      <div class="history-list-meta">
        <span class="history-list-count">{{ items.length }} {{ t('个会话') }}</span>
        <span v-if="loading" class="history-list-state">{{ t('正在加载') }}</span>
        <span v-else-if="search.trim()" class="history-list-state">{{ t('按搜索词筛选') }}</span>
        <span v-else-if="devices" class="history-list-state">{{ devices.length }} {{ t('个节点') }} · {{ projectCount }} {{ t('个项目') }}</span>
      </div>
      <v-progress-linear v-if="loading" indeterminate :aria-label="t('正在加载历史记录')" />
      <slot name="list-notice" />
      <v-list class="history-session-scroll" bg-color="transparent">
        <slot name="list">
        <template v-if="loading && !items.length">
          <div v-for="index in 6" :key="'history-skeleton:'+index" class="history-skeleton"><v-skeleton-loader type="list-item-one-line" /></div>
        </template>
        <template v-else>
        <v-virtual-scroll :items="rows" :item-height="rowHeight" :renderless="true"><template #default="{item:row,itemRef}:{item:HistoryDeviceRow;itemRef?:VNodeRef}">
        <!-- 设备层：这一台电脑 / 实例，折叠后只剩一行 -->
        <v-list-item v-if="row.kind==='device'" :ref="itemRef" :key="row.key" class="history-device-row" :class="{'is-collapsed':!deviceExpanded(row.key),'is-offline':row.device.status==='offline','is-unknown':row.device.status==='unknown'}"
          :aria-expanded="deviceExpanded(row.key)" @click="toggleDevice(row)">
          <template #prepend><v-icon :icon="row.device.icon || 'mdi-monitor'" size="17" class="history-device-icon" /></template>          <v-list-item-title class="history-device-title">
            <v-icon :icon="deviceExpanded(row.key) ? 'mdi-chevron-down' : 'mdi-chevron-right'" size="15" class="history-chevron" />
            <span class="history-device-name" data-no-i18n>{{ row.device.title }}</span>
          </v-list-item-title>
          <template #append>
            <span v-if="row.device.status==='offline'" class="history-device-state">{{ t('离线') }}</span>
            <span v-else-if="row.device.status==='unknown'" class="history-device-state">{{ t('状态未知') }}</span>
            <template v-else>
              <v-progress-circular v-if="deviceLoading?.has(row.device.key)" indeterminate size="11" width="1.5" class="history-device-busy" />
              <span v-if="row.count" class="history-device-count">{{ row.count }}</span>
              <time v-if="row.latest" class="history-device-time" :datetime="row.latest">{{ date(row.latest) }}</time>
            </template>
          </template>
        </v-list-item>
        <!-- 项目层：设备下的工作目录，再折叠一次 -->
        <v-list-item v-else-if="row.kind==='group'" :ref="itemRef" :key="row.key" class="history-project-heading" :class="{ 'is-collapsed':collapsedGroups.has(row.key) }" @click="toggleGroup(row.key)">
          <template #prepend><v-icon :icon="collapsedGroups.has(row.key) ? 'mdi-chevron-right' : 'mdi-chevron-down'" size="15" class="history-chevron" /><v-icon icon="mdi-folder-outline" size="15" class="history-project-icon" /></template>
          <v-list-item-title class="history-project-name" data-no-i18n>{{ row.title }}</v-list-item-title>
          <template #append><span class="history-project-count">{{ row.count }}</span><time v-if="row.latest" class="history-project-time" :datetime="row.latest">{{ date(row.latest) }}</time></template>
        </v-list-item>
        <v-list-item v-else-if="row.kind==='more'" :ref="itemRef" :key="row.key" class="history-project-more-row" :aria-label="t('展开其余')+' '+row.title" @click="expandGroup(row.groupKey)">
          <v-list-item-title class="history-more-label">{{ t('展开其余') }} {{ row.remaining }}</v-list-item-title>
        </v-list-item>
        <v-list-item v-else :ref="itemRef" :key="row.key" class="history-session-row" :active="row.conversation.key===selected" @click="choose(row.conversation.key)">
          <template #prepend><AgentAvatar v-if="row.conversation.agentProvider" :provider="row.conversation.agentProvider" :size="compact ? 16 : 20" /><span v-else class="history-avatar" aria-hidden="true">{{ row.conversation.title.slice(0,1) }}</span></template>
          <v-list-item-title class="history-row-title"><span data-no-i18n>{{row.conversation.title}}</span>
            <v-progress-circular v-if="row.conversation.running" indeterminate size="11" width="1.5" class="history-row-running" :aria-label="t('运行中')" />
            <time v-else :datetime="row.conversation.time" :title="fullDate(row.conversation.time)">{{date(row.conversation.time)}}</time>
          </v-list-item-title>
        </v-list-item>
        </template></v-virtual-scroll>
        </template>
        <div v-if="!items.length&&!loading&&!devices" class="history-empty">
          <v-icon :icon="search.trim() ? 'mdi-magnify-close' : 'mdi-forum-outline'" size="30" />
          <p>{{ search.trim() ? t('没有匹配的会话。') : t('暂无会话。') }}</p>
          <v-btn v-if="search.trim()" variant="text" size="small" @click="clearSearch">{{ t('清除搜索') }}</v-btn>
        </div>
        </slot>
        <slot name="list-footer" />
      </v-list>
      <slot name="list-empty" />
    </aside>
    <div class="history-splitter" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="t('调整会话列表宽度')" :aria-valuenow="width" :aria-valuemin="200" :aria-valuemax="maximum" @pointerdown="start" @pointermove="move" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop" @keydown="key" @dblclick="reset" />
    <section class="history-detail">
      <div class="history-mobile-actions"><v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('返回会话')" @click="back" /><v-spacer /><v-btn v-if="hasDetails" icon="mdi-information-outline" variant="text" :aria-label="t(detailsTitle||'详细信息')" @click="infoOpen=true" /></div>
      <div ref="scrollElement" class="history-message-scroll" data-history-scroll tabindex="0" :aria-label="t('消息记录')"><div ref="scrollContent" class="history-scroll-content"><slot /></div></div>
      <slot name="composer" />
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
.history-search{display:flex;align-items:center;gap:4px;padding:8px 8px 4px;}
.history-search :deep(.v-field){font-size:12px;border-radius:7px;}
.history-list-meta{display:flex;align-items:center;gap:8px;min-height:18px;padding:0 12px 4px;font-size:11px;color:rgba(var(--v-theme-on-surface),.55);}
.history-list-count{font-variant-numeric:tabular-nums;}
.history-list-state{margin-inline-start:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.history-skeleton{padding:1px 8px;}
.history-skeleton :deep(.v-skeleton-loader){background:transparent;}
.history-skeleton :deep(.v-skeleton-loader__text){height:9px;margin-block:4px;}
.history-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 16px;color:rgba(var(--v-theme-on-surface),.55);text-align:center;}
.history-empty p{margin:0;font-size:13px;}
.history-session-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0;overscroll-behavior:contain;}

/* 三层共用：紧凑行，缩进逐级递进 */
.history-session-scroll :deep(.v-list-item){min-height:40px;padding:2px 8px;border-radius:5px;margin:0 4px;transition:background-color .15s ease,box-shadow .15s ease;}
.history-session-scroll :deep(.v-list-item:hover){background:rgba(var(--v-theme-on-surface),.045);}
.history-session-scroll :deep(.v-list-item__content){min-width:0;}
.history-session-scroll :deep(.v-list-item-title){min-width:0;}
.history-session-scroll :deep(.v-list-item-subtitle){font-size:11.5px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;line-height:16px;opacity:.72;}
.history-session-scroll :deep(.v-list-item__spacer){display:none;}
.history-chevron{flex:none;opacity:.55;margin-inline-end:2px;}
.history-list :deep(.agent-avatar){margin-inline-end:7px;}
.history-avatar{display:grid;place-items:center;width:20px;height:20px;flex:none;margin-inline-end:7px;border-radius:5px;background:rgba(var(--v-theme-on-surface),.08);font-size:10px;}

/* 设备层 */
.history-device-row{font-weight:600;}
.history-device-row :deep(.v-list-item__prepend){margin-inline-end:2px;}
.history-device-icon{opacity:.8;}
.history-device-title{display:flex;align-items:center;gap:2px;font-size:12.5px;font-weight:600;line-height:18px;}
.history-device-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.history-device-count{flex:none;min-width:16px;padding:0 5px;border-radius:8px;background:rgba(var(--v-theme-on-surface),.08);font-size:10px;font-weight:600;line-height:15px;text-align:center;font-variant-numeric:tabular-nums;opacity:.85;}
.history-device-time{flex:none;margin-inline-start:6px;font-size:10px;font-weight:400;opacity:.5;font-variant-numeric:tabular-nums;}
.history-device-state{font-size:10px;opacity:.45;}
.history-device-busy{opacity:.6;}
.history-device-row.is-collapsed .history-device-icon{opacity:.55;}
.history-device-row.is-offline{cursor:default;opacity:.5;}
.history-device-row.is-offline:hover{background:transparent;}
.history-device-row.is-unknown .history-device-icon{opacity:.6;}

/* 项目层 */
.history-project-heading{font-weight:500;}
.history-project-heading :deep(.v-list-item__prepend){margin-inline-start:14px;margin-inline-end:0;}
.history-project-icon{opacity:.5;margin-inline-end:4px;}
.history-project-name{font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.history-project-count{flex:none;font-size:10px;opacity:.5;font-variant-numeric:tabular-nums;}
.history-project-time{flex:none;margin-inline-start:6px;font-size:10px;opacity:.42;font-variant-numeric:tabular-nums;}

/* 会话层 */
.history-session-row :deep(.v-list-item__prepend){margin-inline-start:26px;margin-inline-end:0;}
.history-session-row :deep(.v-list-item--active),.history-session-row.v-list-item--active{background:rgba(var(--v-theme-secondary),.10);box-shadow:inset 2px 0 0 rgb(var(--v-theme-secondary));}
.history-session-row.v-list-item--active:hover{background:rgba(var(--v-theme-secondary),.14);}
.history-row-title{display:flex;align-items:baseline;gap:6px;font-size:12.5px;line-height:18px;font-weight:400;}
.history-row-title>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.history-row-title>time{flex:none;font-size:10px;opacity:.5;font-variant-numeric:tabular-nums;}
/* A running session shows motion instead of a stale timestamp. */
.history-row-running{flex:none;opacity:.85;}
.history-project-more-row{font-size:11px;}
.history-project-more-row :deep(.v-list-item__content){margin-inline-start:26px;}
.history-more-label{font-size:11px;color:rgb(var(--v-theme-secondary));opacity:.85;}
.history-project-more-row:hover .history-more-label{opacity:1;text-decoration:underline;}

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
