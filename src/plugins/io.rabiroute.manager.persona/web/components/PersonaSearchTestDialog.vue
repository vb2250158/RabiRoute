<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { peerManagerPath } from '../../../../../ribiwebgui/src/peerManagerTarget';
import { pluginCatalogStore } from '../../../../../ribiwebgui/src/pluginCatalogStore';
import { copyTextToClipboard } from '../../../../../ribiwebgui/src/clipboard';
import { userFacingError } from '../../../../../ribiwebgui/src/userFacingError';
import {
  runSearchTest, searchTestIdentities, parseSearchTestParameters, searchTestResultGroups, searchTestHighlights,
  type SearchTestIdentity, type SearchTestReceipt, type SearchTestItem,
} from '../persona/searchTestClient';

const props = defineProps<{ modelValue: boolean; roleId: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const service = usePersonaService();
const { t } = useI18n();
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const identities = ref<SearchTestIdentity[]>([]);
const identityKey = ref('role');
const callerType = ref('');
const callerId = ref('');
const bindingError = ref('');
const bindingWarnings = ref<string[]>([]);
const loadingIdentities = ref(false);
const draft = ref<Record<string, unknown>>({});
const jsonMode = ref(false);
const rawParameters = ref('');
const advanced = ref(false);
const tab = ref('results');
const busy = ref(false);
const loadingMore = ref(false);
const error = ref('');
const copied = ref('');
const receipt = ref<SearchTestReceipt>();
const failedAttempt = ref<SearchTestReceipt>();
const pages = ref<SearchTestReceipt[]>([]);
const resultItems = ref<SearchTestItem[]>([]);
const submitted = ref<{ parameters: Record<string, unknown>; identity: Pick<SearchTestIdentity, 'agentType' | 'sessionId'>; label: string }>();
const expandedText = ref(new Set<number>());
const expandedGroups = ref(new Set<number>());
const detailIndex = ref<number>();
const detailBody = ref<unknown>();
const detailError = ref('');
const detailBusy = ref(false);
let bindingRequest: AbortController | undefined;
let searchRequest: AbortController | undefined;
let detailRequest: AbortController | undefined;

function field(name: string, fallback = '') {
  return computed({ get: () => String(draft.value[name] ?? fallback), set: (value: string) => {
    draft.value = { ...draft.value, [name]: value };
    delete draft.value.cursor;
  } });
}
const words = field('q');
const source = field('scope', 'all');
const match = field('match', 'any');
const sort = field('sort', 'relevance');
const limit = field('limit', '20');
const budget = field('budgetMs', '3000');
const range = computed({
  get: () => String(draft.value.agent || ''),
  set: (value: string) => {
    draft.value = { ...draft.value, agent: value || undefined };
    delete draft.value.cursor;
  },
});
const ranges = computed(() => [
  { title: t('当前角色') + ' · ' + props.roleId, value: props.roleId },
  { title: t('全部角色'), value: '' },
  ...(range.value && range.value !== props.roleId ? [{ title: range.value, value: range.value }] : []),
]);
const sourceLabels: Record<string, string> = { all: '全部来源', knowledge: '计划与记忆', messages: '聊天记录', skills: '技能', operations: '接口', entities: '设备' };
const kindLabels: Record<string, string> = { plan: '计划', recent: '近期记忆', consolidated: '整理记忆', message: '消息', group: '群聊', private: '私聊', operation: '接口', entity: '设备' };
const statusLabels: Record<string, string> = { ok: '已完成', partial: '部分完成', unavailable: '不可用', skipped: '已跳过' };
const sources = computed(() => {
  const active = receipt.value?.body.data?.capabilities;
  return (active?.scopes ? ['all', ...active.scopes] : Object.keys(sourceLabels)).map(value => ({ value,
    title: sourceLabels[value] ? t(sourceLabels[value]) : active?.sources?.find(source => source.scope === value)?.legend || value }));
});
const identityItems = computed(() => identities.value.map(item => ({ value: item.key,
  title: (item.key === 'role' ? t('当前角色') : t('绑定的主 Agent')) + ' · ' + item.label })));
const selectedIdentity = computed(() => identities.value.find(item => item.key === identityKey.value));
const identitySummary = computed(() => [callerType.value, callerId.value || t('未配置会话 ID')].filter(Boolean).join(' · '));
const parameters = computed(() => jsonMode.value ? rawParameters.value : pretty(draft.value));
const groups = computed(() => searchTestResultGroups(resultItems.value));
const stale = computed(() => submitted.value && (parameters.value !== pretty(submitted.value.parameters)
  || callerType.value !== submitted.value.identity.agentType || callerId.value !== submitted.value.identity.sessionId));
const nextCursor = computed(() => receipt.value?.body.data?.nextCursor);
const coverage = computed(() => receipt.value?.body.data?.coverage);
const hasGaps = computed(() => coverage.value?.state === 'partial');
const requestLog = computed(() => failedAttempt.value ? [...pages.value, failedAttempt.value] : pages.value);
const queryWords = computed(() => String(submitted.value?.parameters.q || ''));

function selectIdentity() {
  callerType.value = selectedIdentity.value?.agentType || '';
  callerId.value = selectedIdentity.value?.sessionId || '';
}
async function loadIdentities() {
  bindingRequest?.abort();
  const controller = new AbortController();
  bindingRequest = controller;
  loadingIdentities.value = true;
  bindingError.value = '';
  try {
    const response = await service.fetch(peerManagerPath(service.deviceId, '/gateways?summary=1&includeConfig=1'), { signal: controller.signal });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.config?.gateways)) throw new Error(body.message || t('角色 Agent 端配置读取失败。'));
    if (controller.signal.aborted) return;
    const previous = selectedIdentity.value;
    const autoIdentity = callerType.value === previous?.agentType && callerId.value === previous?.sessionId;
    const result = searchTestIdentities(props.roleId, body.data.config.gateways, pluginCatalogStore.settingsRenderers.value);
    identities.value = result.identities;
    bindingWarnings.value = result.warnings;
    if (!selectedIdentity.value) identityKey.value = 'role';
    else if (autoIdentity) selectIdentity();
  } catch (cause) {
    if (!controller.signal.aborted) bindingError.value = userFacingError(cause);
  } finally {
    if (bindingRequest === controller) loadingIdentities.value = false;
  }
}
function toggleJson(value: boolean | null) {
  try {
    if (value) rawParameters.value = pretty(draft.value);
    else draft.value = parseSearchTestParameters(rawParameters.value);
    jsonMode.value = Boolean(value);
    error.value = '';
  } catch (cause) { error.value = userFacingError(cause); }
}
function clearDetail() {
  detailRequest?.abort();
  detailIndex.value = undefined;
  detailBody.value = undefined;
  detailError.value = '';
  detailBusy.value = false;
}
async function search(more = false) {
  let input: Record<string, unknown>;
  try { input = more ? { ...submitted.value!.parameters, cursor: nextCursor.value } : parseSearchTestParameters(parameters.value); }
  catch (cause) { error.value = userFacingError(cause); return; }
  searchRequest?.abort();
  const controller = new AbortController();
  searchRequest = controller;
  const identity = more ? { ...submitted.value!.identity } : { agentType: callerType.value, sessionId: callerId.value };
  const label = selectedIdentity.value?.label || props.roleId;
  busy.value = true;
  loadingMore.value = more;
  error.value = '';
  failedAttempt.value = undefined;
  try {
    const result = await runSearchTest(service.fetch, pretty(input), identity, controller.signal);
    if (controller.signal.aborted || searchRequest !== controller) return;
    if (result.status >= 400 || result.body.code === -1) {
      failedAttempt.value = result;
      error.value = result.body.message || t('搜索接口返回错误，请查看完整返回。');
      return;
    }
    receipt.value = result;
    if (more) {
      resultItems.value.push(...(result.body.data?.items || []));
      pages.value.push(result);
    } else {
      submitted.value = { parameters: input, identity, label };
      resultItems.value = [...(result.body.data?.items || [])];
      pages.value = [result];
      expandedText.value = new Set();
      expandedGroups.value = new Set();
      clearDetail();
      tab.value = 'results';
    }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = userFacingError(cause);
  } finally {
    if (searchRequest === controller) { busy.value = false; loadingMore.value = false; }
  }
}
function cancel() {
  searchRequest?.abort();
  busy.value = false;
  loadingMore.value = false;
  error.value = t('已取消本次测试。');
}
function toggle(set: Set<number>, index: number) {
  if (set.has(index)) set.delete(index);
  else set.add(index);
}
function detailUrl(item: SearchTestItem) { return item.handle?.detailUrl || item.detailUrl || item.handle?.contractUrl || ''; }
async function loadDetail(index: number) {
  if (detailIndex.value === index) { clearDetail(); return; }
  clearDetail();
  const controller = new AbortController();
  detailRequest = controller;
  detailIndex.value = index;
  detailBusy.value = true;
  try {
    const response = await service.fetch(detailUrl(resultItems.value[index]), { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + ' · ' + text);
    if (controller.signal.aborted) return;
    try { detailBody.value = JSON.parse(text); }
    catch { detailBody.value = text; }
  } catch (cause) {
    if (!controller.signal.aborted) detailError.value = userFacingError(cause);
  } finally {
    if (detailRequest === controller) detailBusy.value = false;
  }
}
async function copy(value: string) {
  try { await copyTextToClipboard(value); copied.value = t('已复制'); }
  catch (cause) { copied.value = userFacingError(cause); }
}
function copyUrl(item: SearchTestItem) {
  return copy(new URL(service.path(detailUrl(item)), window.location.href).href);
}
function itemTime(item: SearchTestItem) {
  const value = item.observedAt == null ? item.updatedAt : item.observedAt * 1000;
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}
function stopRequests() {
  searchRequest?.abort();
  bindingRequest?.abort();
  detailRequest?.abort();
  busy.value = false;
  loadingMore.value = false;
  detailBusy.value = false;
}
watch(identityKey, () => { cancel(); error.value = ''; selectIdentity(); });
watch(() => props.roleId, () => {
  stopRequests();
  draft.value = { q: '', agent: props.roleId, scope: 'all', limit: 20, budgetMs: 3000 };
  jsonMode.value = false;
  rawParameters.value = '';
  identities.value = searchTestIdentities(props.roleId, [], []).identities;
  identityKey.value = 'role';
  selectIdentity();
  receipt.value = undefined;
  failedAttempt.value = undefined;
  submitted.value = undefined;
  resultItems.value = [];
  pages.value = [];
  error.value = '';
  clearDetail();
  if (props.modelValue) void loadIdentities();
}, { immediate: true });
watch(() => props.modelValue, open => {
  if (open) void loadIdentities();
  else { stopRequests(); clearDetail(); }
});
onBeforeUnmount(stopRequests);
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="1240" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card class="search-test-dialog">
      <header class="search-test-header">
        <div class="search-test-title"><h2>{{ t('搜索接口测试') }}</h2><v-btn icon="mdi-close" variant="text" :aria-label="t('关闭')" @click="emit('update:modelValue', false)" /></div>
        <form class="search-test-form" @submit.prevent="search(false)">
          <div class="search-test-context">
            <v-select v-model="identityKey" :items="identityItems" :label="t('调用身份')" :loading="loadingIdentities" hide-details density="compact" />
            <v-select v-if="!jsonMode" v-model="range" :items="ranges" :label="t('搜索范围')" hide-details density="compact" />
            <v-btn variant="text" :aria-expanded="advanced" :append-icon="advanced ? 'mdi-chevron-up' : 'mdi-chevron-down'" @click="advanced = !advanced">{{ t('高级设置') }}</v-btn>
          </div>
          <div class="search-test-query" v-if="!jsonMode">
            <v-text-field v-model="words" :label="t('搜索词')" :placeholder="t('输入关键词，留空浏览')" prepend-inner-icon="mdi-magnify" hide-details clearable density="compact" class="search-test-words" @click:clear="words = ''" />
            <v-select v-model="source" :items="sources" :label="t('搜索来源')" hide-details density="compact" />
            <v-btn type="submit" color="primary" :loading="busy && !loadingMore">{{ t('搜索') }}</v-btn>
            <v-btn v-if="busy" variant="text" @click="cancel">{{ t('取消') }}</v-btn>
          </div>
          <div v-else class="search-test-query">
            <span class="search-test-words">{{ t('正在使用完整 JSON 参数') }}</span>
            <v-btn type="submit" color="primary" :loading="busy && !loadingMore">{{ t('搜索') }}</v-btn>
            <v-btn v-if="busy" variant="text" @click="cancel">{{ t('取消') }}</v-btn>
          </div>
          <p v-if="identityKey !== 'role' && !callerId.trim()" class="search-test-binding-note">{{ t('主 Agent 尚未配置会话 ID，可在高级设置中补充。') }}</p>
          <section v-if="advanced" class="search-test-advanced">
            <v-switch :model-value="jsonMode" :label="t('编辑完整 JSON 参数')" hide-details density="compact" @update:model-value="toggleJson" />
            <p class="search-test-hint">{{ t('调用方身份用于记录，检索范围由 agent 参数决定。') }}</p>
            <div class="search-test-advanced-fields">
              <v-text-field v-model="callerType" :label="t('调用方类型')" hide-details density="compact" />
              <v-text-field v-model="callerId" :label="t('调用方完整 ID')" hide-details density="compact" data-no-i18n />
              <template v-if="!jsonMode">
                <v-select v-model="match" :items="[{title:t('任意关键词'),value:'any'},{title:t('全部关键词'),value:'all'}]" :label="t('匹配方式')" hide-details density="compact" />
                <v-select v-model="sort" :items="[{title:t('相关性'),value:'relevance'},{title:t('最近时间'),value:'recent'}]" :label="t('排序')" hide-details density="compact" />
                <v-text-field v-model="limit" type="number" min="1" max="200" :label="t('每页数量')" hide-details density="compact" />
                <v-text-field v-model="budget" type="number" min="1" :label="t('搜索预算（毫秒）')" hide-details density="compact" />
              </template>
            </div>
            <v-textarea v-if="jsonMode" v-model="rawParameters" :label="t('查询参数（JSON）')" rows="5" hide-details class="search-test-parameters" spellcheck="false" data-no-i18n />
            <v-alert v-if="bindingError" type="warning" variant="tonal">{{ bindingError }}</v-alert>
            <p v-for="warning in bindingWarnings" :key="warning">{{ warning }}</p>
          </section>
        </form>
      </header>
      <div class="search-test-summary" aria-live="polite">
        <template v-if="receipt">
          <span>{{ t('已加载') }} <b>{{ resultItems.length }}</b> {{ t('条') }}</span>
          <span>{{ receipt.durationMs }} ms · HTTP {{ receipt.status }}</span>
          <span class="search-test-applied" :title="identitySummary">{{ submitted?.label }} · {{ submitted?.parameters.agent || t('全部角色') }} · {{ submitted?.parameters.q || t('浏览') }}</span>
          <v-btn v-if="hasGaps" size="small" variant="text" color="warning" @click="tab = 'coverage'">{{ t('部分来源未完成') }}<v-icon icon="mdi-chevron-right" /></v-btn>
          <span v-if="stale" class="search-test-hint">{{ t('条件已修改，当前显示上次搜索结果。') }}</span>
        </template>
        <span v-else>{{ t('选择身份和范围，输入关键词开始搜索。') }}</span>
        <span v-if="busy" role="status">{{ loadingMore ? t('正在加载更多…') : t('正在搜索，上次结果保持可读。') }}</span>
      </div>
      <v-alert v-if="error" type="error" variant="tonal" class="search-test-error" closable @click:close="error = ''">{{ error }}<v-btn v-if="failedAttempt" size="small" variant="text" @click="tab = 'requests'">{{ t('查看请求与返回') }}</v-btn></v-alert>
      <v-tabs v-model="tab" density="compact" class="search-test-tabs">
        <v-tab value="results">{{ t('搜索结果') }}</v-tab><v-tab value="coverage">{{ t('来源状态') }}</v-tab><v-tab value="requests">{{ t('请求与返回') }}</v-tab>
      </v-tabs>
      <main class="search-test-content" :aria-busy="busy">
        <section v-if="tab === 'results'" class="search-test-results">
          <p v-if="!receipt" class="search-test-empty">{{ t('搜索后查看结果，可直接读取详情和复制调用入口。') }}</p>
          <p v-else-if="!resultItems.length" class="search-test-empty">{{ t('没有匹配结果。') }} <span v-if="hasGaps">{{ t('部分来源未完成') }}</span></p>
          <template v-for="group in groups" :key="group.indexes[0]">
            <article v-for="index in (expandedGroups.has(group.indexes[0]) ? group.indexes : group.indexes.slice(0, 1))" :key="index" class="search-test-result" data-no-i18n>
              <h3 :title="resultItems[index].label"><template v-for="(part, partIndex) in searchTestHighlights(resultItems[index].label, queryWords)" :key="partIndex"><mark v-if="part.matched">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></h3>
              <div class="search-test-meta"><span>{{ t(sourceLabels[resultItems[index].source] || resultItems[index].source) }}</span><span>{{ t(kindLabels[resultItems[index].kind] || resultItems[index].kind) }}</span><span v-if="resultItems[index].agent">{{ resultItems[index].agent }}</span><span v-if="itemTime(resultItems[index])">{{ itemTime(resultItems[index]) }}</span><span v-if="resultItems[index].status">{{ resultItems[index].status }}</span></div>
              <p v-if="resultItems[index].excerpt" class="search-test-excerpt" :class="{'search-test-clamped': !expandedText.has(index)}"><template v-for="(part, partIndex) in searchTestHighlights(resultItems[index].excerpt, queryWords)" :key="partIndex"><mark v-if="part.matched">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></p>
              <p v-else class="search-test-hint">{{ t('摘要为空，查看详情获取原文。') }}</p>
              <div class="search-test-result-actions">
                <v-btn v-if="resultItems[index].excerpt.length > 160" size="small" variant="text" @click="toggle(expandedText, index)">{{ expandedText.has(index) ? t('收起正文') : t('展开正文') }}</v-btn>
                <v-btn v-if="detailUrl(resultItems[index])" size="small" variant="text" :loading="detailBusy && detailIndex === index" @click="loadDetail(index)">{{ detailIndex === index ? t('收起详情') : t('查看详情') }}</v-btn>
                <v-btn v-if="detailUrl(resultItems[index])" size="small" variant="text" @click="copyUrl(resultItems[index])">{{ t('复制接口地址') }}</v-btn>
                <v-btn v-if="resultItems[index].handle" size="small" variant="text" @click="copy(pretty(resultItems[index].handle))">{{ t('复制调用参数') }}</v-btn>
                <v-btn v-if="index === group.indexes[0] && group.indexes.length > 1" size="small" variant="tonal" @click="toggle(expandedGroups, index)">{{ expandedGroups.has(index) ? t('收起重复记录') : t('展开同标题记录') }} · {{ group.indexes.length }}</v-btn>
              </div>
              <section v-if="detailIndex === index" class="search-test-detail">
                <p v-if="detailBusy">{{ t('正在读取详情…') }}</p><v-alert v-else-if="detailError" type="error" variant="tonal">{{ detailError }}</v-alert><pre v-else>{{ typeof detailBody === 'string' ? detailBody : pretty(detailBody) }}</pre>
              </section>
            </article>
          </template>
          <div v-if="receipt" class="search-test-pagination"><v-btn v-if="nextCursor" :disabled="!!stale || busy" :loading="loadingMore" variant="tonal" @click="search(true)">{{ t('加载更多结果') }}</v-btn><span>{{ nextCursor ? t('还有更多结果') : t('本次查询已加载完毕') }}</span></div>
        </section>
        <section v-else-if="tab === 'coverage'" class="search-test-coverage">
          <p v-if="!coverage" class="search-test-empty">{{ t('搜索后查看各来源状态。') }}</p>
          <template v-else>
            <article v-for="lane in coverage.sources" :key="lane.source" class="search-test-source">
              <h3>{{ t(sourceLabels[lane.source] || lane.source) }} <small>{{ t(statusLabels[lane.status] || lane.status) }} · {{ lane.returned }} {{ t('条') }}</small></h3>
              <p v-for="(problem, index) in receipt?.body.data?.degraded?.filter(item => item.source === lane.source)" :key="index">{{ problem.errorCode === 'xiaomi_home_authorization_required' ? t('设备来源尚未授权，请在小米 Home 消息端卡片连接 Home Assistant。') : problem.message || problem.errorCode }}</p>
              <details v-if="lane.coverage?.length"><summary>{{ t('查看角色覆盖情况') }}</summary><pre>{{ pretty(lane.coverage) }}</pre></details>
            </article>
            <details><summary>{{ t('完整来源状态与警告') }}</summary><pre>{{ pretty({coverage, degraded: receipt?.body.data?.degraded, warnings: receipt?.body.data?.warnings}) }}</pre></details>
          </template>
        </section>
        <section v-else class="search-test-requests">
          <p v-if="!requestLog.length" class="search-test-empty">{{ t('搜索后查看实际请求与完整返回。') }}</p>
          <article v-for="(page, index) in requestLog" :key="index" class="search-test-request">
            <div class="search-test-request-heading"><h3>{{ t('请求') }} {{ index + 1 }} · HTTP {{ page.status }} · {{ page.durationMs }} ms</h3><v-btn size="small" variant="text" @click="copy(pretty(page))">{{ t('复制请求与返回') }}</v-btn></div>
            <p class="search-test-request-id" data-no-i18n>requestId {{ page.body.requestId }}</p>
            <details open><summary>{{ t('实际请求') }}</summary><pre>{{ pretty(page.request) }}</pre></details>
            <details><summary>{{ t('完整返回（JSON）') }}</summary><pre>{{ pretty(page.body) }}</pre></details>
          </article>
        </section>
      </main>
      <v-snackbar :model-value="!!copied" :timeout="2000" @update:model-value="copied = ''">{{ copied }}</v-snackbar>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.search-test-dialog { height: min(900px, calc(100dvh - 48px)); display: flex; flex-direction: column; }
.search-test-header { padding: 12px 24px 16px; flex: 0 0 auto; }
.search-test-title, .search-test-context, .search-test-query, .search-test-result-actions, .search-test-request-heading { display: flex; align-items: center; gap: 12px; }
.search-test-title { justify-content: space-between; margin-bottom: 12px; }
.search-test-title h2 { font-size: 20px; font-weight: 600; }
.search-test-context { margin-bottom: 14px; }
.search-test-context > .v-input { flex: 1; min-width: 0; }
.search-test-query .search-test-words { flex: 1; min-width: 0; }
.search-test-query > .v-select { flex: 0 0 180px; }
.search-test-advanced { margin-top: 12px; max-height: 32dvh; overflow-y: auto; padding: 0 2px 4px; }
.search-test-advanced-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 12px 0; }
.search-test-parameters :deep(textarea) { font-family: monospace; }
.search-test-binding-note, .search-test-hint { font-size: 13px; color: rgba(var(--v-theme-on-surface), .65); }
.search-test-binding-note { margin-top: 10px; }
.search-test-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 16px; padding: 10px 24px; font-size: 13px; border-block: 1px solid rgba(var(--v-theme-on-surface), .12); }
.search-test-applied { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
.search-test-error { flex: 0 0 auto; margin: 8px 24px; }
.search-test-tabs { flex: 0 0 auto; }
.search-test-content { flex: 1; min-height: 0; overflow-y: auto; padding: 0 24px 24px; overscroll-behavior: contain; }
.search-test-empty { padding: 40px 0; color: rgba(var(--v-theme-on-surface), .65); text-align: center; }
.search-test-result, .search-test-source, .search-test-request { padding: 20px 0; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .12); }
.search-test-result h3 { font-size: 15px; line-height: 1.6; font-weight: 600; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.search-test-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .6); margin: 6px 0; }
.search-test-excerpt { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; font-size: 14px; margin: 8px 0; }
.search-test-clamped { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.search-test-result-actions { flex-wrap: wrap; gap: 4px; margin-top: 10px; }
.search-test-result-actions .v-btn { padding-inline: 8px; }
.search-test-detail { margin-top: 12px; padding: 16px; background: rgba(var(--v-theme-on-surface), .04); border-radius: 6px; }
.search-test-source h3, .search-test-request h3 { font-size: 15px; }
.search-test-source small { font-size: 13px; font-weight: 400; margin-left: 12px; }
.search-test-source p { margin: 12px 0; }
.search-test-pagination { display: flex; justify-content: center; align-items: center; gap: 16px; padding: 24px 0 0; font-size: 13px; }
.search-test-request-heading { flex-wrap: wrap; justify-content: space-between; }
.search-test-request-id { font-size: 12px; overflow-wrap: anywhere; margin-top: 8px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; margin-block: 12px; }
summary { cursor: pointer; padding-block: 12px; font-size: 13px; }
mark { background: rgba(var(--v-theme-primary), .2); color: inherit; border-radius: 2px; }
@media (max-width: 700px) {
  .search-test-dialog { height: calc(100dvh - 24px); }
  .search-test-header { padding: 8px 14px 12px; }
  .search-test-context { flex-wrap: wrap; gap: 12px; }
  .search-test-context > .v-input { flex-basis: calc(50% - 6px); }
  .search-test-context > .v-btn { margin-left: auto; }
  .search-test-query { flex-wrap: wrap; gap: 12px; }
  .search-test-query .search-test-words { flex-basis: 100%; }
  .search-test-query > .v-select { flex: 1; }
  .search-test-advanced-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .search-test-summary { padding: 8px 14px; }
  .search-test-applied { max-width: 100%; }
  .search-test-content { padding: 0 14px 14px; }
}
</style>
