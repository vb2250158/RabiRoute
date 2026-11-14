<script setup lang="ts">
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { createComputerControlEvents } from "./computerControlEvents";
import { managerAccessToken, managerEventSource } from "../../../../../ribiwebgui/src/managerApi";
import { ComputerControlClient } from "./computerControlClient";
import { createComputerControlState } from "./computerControlState";
import { computerDeepLink, filterComputers } from "./computerControlPresentation";
import ComputerControlRow from "./ComputerControlRow.vue";
const { t } = useI18n();
const props = defineProps<{ active?: boolean }>();
const events = createComputerControlEvents(managerEventSource);
const route = useRoute(); const client = new ComputerControlClient(undefined, managerAccessToken());
const controller = createComputerControlState(reactive); const state = controller.state;
const query = ref(""); const kind = ref("all"); const status = ref("all");
const rows = computed(() => filterComputers(state.rows, query.value, kind.value, status.value));
const visibleIds = computed(() => new Set(rows.value.map(row => row.id)));
async function refresh() { await controller.refresh(signal => client.list(signal)); const id = computerDeepLink(route.query, state.rows); if (id) state.expanded.add(id); }
watch(() => route.query, () => { const id = computerDeepLink(route.query, state.rows); if (id) state.expanded.add(id); });
function toggle(id: string) { if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id); }
onMounted(() => { void refresh(); }); onBeforeUnmount(() => {events.dispose();controller.dispose();});
</script>
<template>
  <section class="computer-page" aria-labelledby="computer-title">
    <header class="computer-heading"><div><h2 id="computer-title">{{ t('电脑控制') }}</h2><p>{{ t('本机、RabiPC 主机与远端节点平级展示。展开只读取设置，不开始操作。') }}</p></div><v-btn prepend-icon="mdi-refresh" :loading="state.loading" variant="tonal" @click="refresh">{{ t('刷新状态') }}</v-btn></header>
    <div class="computer-filters"><v-text-field v-model="query" :label="t('搜索电脑名称')" prepend-inner-icon="mdi-magnify" clearable hide-details density="compact" /><v-select v-model="kind" :label="t('类型')" :items="[{title:t('全部'),value:'all'},{title:t('主机'),value:'host'},{title:t('远端节点'),value:'node'}]" hide-details density="compact" /><v-select v-model="status" :label="t('在线状态')" :items="[{title:t('全部'),value:'all'},{title:t('在线'),value:'online'},{title:t('离线'),value:'offline'},{title:t('状态未知'),value:'unknown'}]" hide-details density="compact" /></div>
    <v-alert v-if="state.error" type="warning" variant="tonal">{{ state.error }}{{ t(' · 保留最近读取的信息。') }}</v-alert>
    <p v-if="!state.loading && !rows.length" class="computer-empty">{{ t('没有匹配的电脑。') }}</p>
    <ComputerControlRow v-for="target in state.rows" v-show="visibleIds.has(target.id)" :key="target.id" :target="target" :client="client" :events="events" :expanded="state.expanded.has(target.id)" :active="props.active !== false && visibleIds.has(target.id)" @toggle="toggle(target.id)" />
  </section>
</template>
<style scoped>
.computer-page{min-width:0;}.computer-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin:8px 0 20px;}.computer-heading h2{font-size:1.2rem;}.computer-heading p,.computer-empty{color:var(--rr-muted);font-size:.9rem;margin-top:6px;}.computer-filters{display:grid;grid-template-columns:minmax(180px,1fr) 170px 170px;gap:12px;margin-bottom:18px;}.computer-empty{padding:30px 12px;text-align:center;}@media(max-width:650px){.computer-filters{grid-template-columns:1fr 1fr;}.computer-filters>:first-child{grid-column:1/-1;}}
</style>
