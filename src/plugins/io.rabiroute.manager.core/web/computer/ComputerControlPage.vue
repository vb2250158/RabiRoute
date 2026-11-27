<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { useRoute } from "vue-router";
import { createComputerControlEvents } from "./computerControlEvents";
import { managerAccessToken, managerEventSource } from "../../../../../ribiwebgui/src/managerApi";
import { ComputerControlClient } from "./computerControlClient";
import { createComputerControlState } from "./computerControlState";
import { computerDeepLink, filterComputers } from "./computerControlPresentation";
import { deviceSystemName } from "./deviceSystem";
import ComputerControlRow from "./ComputerControlRow.vue";
import RabiPhoneControlRow from "./RabiPhoneControlRow.vue";
import AndroidDisplayRow from "./AndroidDisplayRow.vue";
import { readAndroidDisplayDirectory, type AndroidDisplayDirectoryEntry } from "../../../../../ribiwebgui/src/rabiLinkHomeClient";
import type { PhoneDevice } from "./phoneDevice";
const { t } = useI18n();
const props = defineProps<{ active?: boolean; phones?: PhoneDevice[]; phonesLoading?: boolean; phonesError?: string; phoneId?: string }>();
const emit = defineEmits<{ refresh: [] }>();
const events = createComputerControlEvents(managerEventSource);
const route = useRoute(); const client = new ComputerControlClient(undefined, managerAccessToken());
const controller = createComputerControlState(reactive); const state = controller.state;
const query = ref(""); const kind = ref("all"); const status = ref("all");
const section = ref<HTMLElement>();
const expandedPhones = reactive(new Set<string>());
const androidDisplays = ref<AndroidDisplayDirectoryEntry[]>([]);
let displayRead: AbortController | undefined;
const rows = computed(() => filterComputers(state.rows, query.value, "all", status.value));
const showComputers = computed(() => kind.value !== "phone");
const showPhones = computed(() => kind.value !== "computer");
const visibleIds = computed(() => new Set(showComputers.value ? rows.value.map(row => row.id) : []));
const phones = computed(() => (props.phones ?? []).filter(phone => {
  if (!showPhones.value) return false;
  if (status.value !== "all" && status.value !== (phone.online ? "online" : "offline")) return false;
  const text = query.value.trim().toLocaleLowerCase();
  if (!text) return true;
  const system = deviceSystemName({ deviceKind: "phone", platform: phone.platform, deviceModel: phone.deviceModel, name: phone.displayName, id: phone.id });
  return [phone.displayName, phone.id, phone.guid, system].some(value => value?.toLocaleLowerCase().includes(text));
}));
const visibleDisplays = computed(() => androidDisplays.value.filter(entry => showPhones.value &&
  (status.value === "all" || status.value === (entry.online ? "online" : "offline")) &&
  entry.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
async function refreshDisplays() {
  displayRead?.abort();
  const current = new AbortController();
  displayRead = current;
  try {
    const rows = await readAndroidDisplayDirectory(current.signal, managerAccessToken());
    if (!current.signal.aborted) androidDisplays.value = rows;
  } catch { /* The existing computer and phone directories remain usable. */ }
}
function openLinkedComputer() {
  if (props.active === false) return;
  const id = computerDeepLink(route.query, state.rows);
  if (!id) return;
  if (!visibleIds.value.has(id)) {
    query.value = "";
    kind.value = "all";
    status.value = "all";
  }
  state.expanded.add(id);
  void nextTick(() => {
    if (props.active === false || computerDeepLink(route.query, state.rows) !== id) return;
    section.value?.querySelector(`[data-computer-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  });
}
async function openLinkedPhone() {
  const id = props.phoneId;
  if (!id || props.active === false || !(props.phones ?? []).some(phone => phone.id === id)) return;
  if (!showPhones.value) kind.value = "all";
  expandedPhones.add(id);
  await nextTick();
  if (props.phoneId !== id) return;
  section.value?.querySelector(`[data-phone-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
}
async function refresh() {
  emit("refresh");
  await Promise.all([controller.refresh(signal => client.list(signal)), refreshDisplays()]);
  openLinkedComputer();
}
watch([() => props.active, () => route.query], openLinkedComputer);
watch([() => props.active, () => props.phoneId, () => props.phones], () => { void openLinkedPhone(); });
function toggle(id: string) { if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id); }
function togglePhone(id: string) { if (expandedPhones.has(id)) expandedPhones.delete(id); else expandedPhones.add(id); }
onMounted(() => { void refresh(); }); onBeforeUnmount(() => {displayRead?.abort();events.dispose();controller.dispose();});
</script>
<template>
  <section ref="section" class="computer-page" aria-labelledby="computer-title">
    <header class="computer-heading"><div><h2 id="computer-title">{{ t('设备控制') }}</h2><p>{{ t('本机、RabiPC 主机、远端节点与手机会一起展示。展开只读取设置，不开始操作。') }}</p></div><v-btn prepend-icon="mdi-refresh" :loading="state.loading" variant="tonal" @click="refresh">{{ t('刷新状态') }}</v-btn></header>
    <div class="computer-filters"><v-text-field v-model="query" :label="t('搜索设备名称')" prepend-inner-icon="mdi-magnify" clearable hide-details density="compact" /><v-select v-model="kind" :label="t('类型')" :items="[{title:t('全部'),value:'all'},{title:t('电脑'),value:'computer'},{title:t('手机'),value:'phone'}]" hide-details density="compact" /><v-select v-model="status" :label="t('在线状态')" :items="[{title:t('全部'),value:'all'},{title:t('在线'),value:'online'},{title:t('离线'),value:'offline'},{title:t('状态未知'),value:'unknown'}]" hide-details density="compact" /></div>
    <v-alert v-if="state.error" type="warning" variant="tonal">{{ state.error }}{{ t(' · 保留最近读取的信息。') }}</v-alert>
    <v-alert v-if="props.phonesError" type="warning" variant="tonal">{{ props.phonesError }}</v-alert>
    <v-progress-linear v-if="props.phonesLoading" indeterminate :aria-label="t('正在读取已连接设备')" />
    <p v-if="!state.loading && !rows.length && !phones.length && !visibleDisplays.length" class="computer-empty">{{ t('没有匹配的设备。') }}</p>
    <p v-else-if="!state.loading && kind === 'phone' && !phones.length && !visibleDisplays.length" class="computer-empty">{{ t('暂无已连接的手机') }}</p>
    <ComputerControlRow v-for="target in state.rows" v-show="visibleIds.has(target.id)" :key="target.id" :target="target" :client="client" :events="events" :expanded="state.expanded.has(target.id)" :active="props.active !== false && visibleIds.has(target.id)" @toggle="toggle(target.id)" />
    <RabiPhoneControlRow v-for="phone in phones" :key="phone.id" :phone="phone" :expanded="expandedPhones.has(phone.id)" @toggle="togglePhone(phone.id)" />
    <AndroidDisplayRow v-for="display in visibleDisplays" :key="(display.target.ownerDeviceId || '') + ':' + display.target.bridgeId + ':' + (display.target.surfaceId || '')" :entry="display"
      :active="props.active !== false" @refresh="refreshDisplays" />
  </section>
</template>
<style scoped>
.computer-page{min-width:0;}.computer-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin:8px 0 20px;}.computer-heading h2{font-size:1.2rem;}.computer-heading p,.computer-empty{color:var(--rr-muted);font-size:.9rem;margin-top:6px;}.computer-filters{display:grid;grid-template-columns:minmax(180px,1fr) 170px 170px;gap:12px;margin-bottom:18px;}.computer-empty{padding:30px 12px;text-align:center;}@media(max-width:650px){.computer-filters{grid-template-columns:1fr 1fr;}.computer-filters>:first-child{grid-column:1/-1;}}
</style>
