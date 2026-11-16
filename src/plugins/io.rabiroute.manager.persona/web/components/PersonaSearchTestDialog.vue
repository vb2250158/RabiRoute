<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { usePersonaService } from '../persona/personaServiceClient';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { peerManagerPath } from '../../../../../ribiwebgui/src/peerManagerTarget';
import { pluginCatalogStore } from '../../../../../ribiwebgui/src/pluginCatalogStore';
import { userFacingError } from '../../../../../ribiwebgui/src/userFacingError';
import { runSearchTest, searchTestIdentities, type SearchTestIdentity, type SearchTestReceipt } from '../persona/searchTestClient';

const props = defineProps<{ modelValue: boolean; roleId: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const service = usePersonaService(), { t } = useI18n();
const identities = ref<SearchTestIdentity[]>([]), identityKey = ref('role');
const callerType = ref(''), callerId = ref(''), parameters = ref('');
const loadingIdentities = ref(false), busy = ref(false), error = ref(''), bindingError = ref('');
const warnings = ref<string[]>([]), receipt = ref<SearchTestReceipt>();
const showRaw = ref(false);
const identityItems = computed(() => identities.value.map(item => ({ value: item.key,
  title: (item.key === 'role' ? t('当前角色') : t('绑定的主 Agent')) + ' · ' + item.label })));
const items = computed(() => receipt.value?.body?.data?.items || []);
const failed = computed(() => receipt.value && (receipt.value.status >= 400 || receipt.value.body?.code === -1));
const incompleteIdentity = computed(() => identityKey.value !== 'role' && (!callerType.value.trim() || !callerId.value.trim()));
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
let bindingRequest: AbortController | undefined, searchRequest: AbortController | undefined;

function selectIdentity() {
  const identity = identities.value.find(item => item.key === identityKey.value);
  callerType.value = identity?.agentType || '';
  callerId.value = identity?.sessionId || '';
}
async function loadIdentities() {
  bindingRequest?.abort(); const controller = new AbortController(); bindingRequest = controller;
  identities.value = searchTestIdentities(props.roleId, [], []).identities;
  identityKey.value = 'role'; selectIdentity();
  loadingIdentities.value = true; bindingError.value = ''; warnings.value = [];
  try {
    const response = await service.fetch(peerManagerPath(service.deviceId, '/gateways?summary=1&includeConfig=1'), { signal: controller.signal });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.config?.gateways)) throw new Error(body.message || t('角色 Agent 端配置读取失败。'));
    if (controller.signal.aborted) return;
    const result = searchTestIdentities(props.roleId, body.data.config.gateways, pluginCatalogStore.settingsRenderers.value);
    identities.value = result.identities; warnings.value = result.warnings;
  } catch (cause) { if (!controller.signal.aborted) bindingError.value = userFacingError(cause); }
  finally { if (bindingRequest === controller) loadingIdentities.value = false; }
}
async function search() {
  searchRequest?.abort(); const controller = new AbortController(); searchRequest = controller;
  busy.value = true; error.value = ''; receipt.value = undefined; showRaw.value = false;
  try {
    const result = await runSearchTest(service.fetch, parameters.value, { agentType: callerType.value, sessionId: callerId.value }, controller.signal);
    if (!controller.signal.aborted) receipt.value = result;
  } catch (cause) { if (!controller.signal.aborted) error.value = userFacingError(cause); }
  finally { if (searchRequest === controller) busy.value = false; }
}
function cancel() {
  searchRequest?.abort(); busy.value = false; error.value = t('已取消本次测试。');
}
watch(identityKey, () => {
  searchRequest?.abort(); busy.value = false; receipt.value = undefined; error.value = '';
  selectIdentity();
});
watch(() => [props.modelValue, props.roleId], () => {
  searchRequest?.abort(); bindingRequest?.abort(); busy.value = false;
  if (!props.modelValue) return;
  parameters.value = pretty({ q: '', agent: props.roleId, scope: 'all', limit: 20, budgetMs: 3000 });
  receipt.value = undefined; error.value = ''; showRaw.value = false;
  void loadIdentities();
}, { immediate: true });
onBeforeUnmount(() => { bindingRequest?.abort(); searchRequest?.abort(); });
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="1180" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card class="search-test-dialog">
      <v-card-title class="d-flex align-center justify-space-between">
        <span>{{ t('搜索接口测试') }}</span>
        <v-btn icon="mdi-close" variant="text" :aria-label="t('关闭')" @click="emit('update:modelValue', false)" />
      </v-card-title>
      <v-card-text>
        <div class="search-test-grid">
          <section class="search-test-input">
            <v-select v-model="identityKey" :items="identityItems" :label="t('测试身份')" :loading="loadingIdentities" class="mb-3" />
            <v-alert v-if="bindingError" type="warning" variant="tonal" class="mb-3">{{ bindingError }}</v-alert>
            <v-alert v-for="warning in warnings" :key="warning" type="warning" variant="tonal" class="mb-3">{{ warning }}</v-alert>
            <p v-if="!loadingIdentities && identities.length === 1 && !bindingError" class="text-medium-emphasis mb-3">{{ t('当前角色尚未配置主 Agent。') }}</p>
            <v-text-field v-model="callerType" :label="t('调用方类型')" class="mb-3" data-no-i18n />
            <v-text-field v-model="callerId" :label="t('调用方完整 ID')" class="mb-3" data-no-i18n />
            <v-alert v-if="incompleteIdentity" type="info" variant="tonal" class="mb-3">{{ t('主 Agent 身份未完整，可补充会话 ID；搜索仍可执行并显示身份警告。') }}</v-alert>
            <p class="text-medium-emphasis mb-3">{{ t('调用方身份用于记录，检索范围由 agent 参数决定。') }}</p>
            <v-textarea v-model="parameters" :label="t('查询参数（JSON）')" rows="9" class="search-test-parameters" spellcheck="false" data-no-i18n />
            <p class="text-medium-emphasis mb-3">{{ t('q 为搜索词。可填写 scope、kind、agent、match、sort、limit、budgetMs 等接口参数。') }}</p>
            <div class="d-flex ga-2 flex-wrap">
              <v-btn color="primary" :loading="busy" prepend-icon="mdi-magnify" @click="search">{{ t('执行搜索') }}</v-btn>
              <v-btn v-if="busy" variant="text" @click="cancel">{{ t('取消') }}</v-btn>
            </div>
            <v-alert v-if="error" type="error" variant="tonal" class="mt-3">{{ error }}</v-alert>
          </section>
          <section class="search-test-output" aria-live="polite">
            <p v-if="!receipt" class="text-medium-emphasis">{{ busy ? t('正在调用搜索接口…') : t('执行搜索后查看实际请求、结果和覆盖范围。') }}</p>
            <template v-else>
              <div class="d-flex ga-3 flex-wrap mb-3" data-no-i18n><span>HTTP {{ receipt.status }}</span><span>{{ receipt.durationMs }} ms</span><span>{{ t('结果数') }} {{ items.length }}</span></div>
              <p v-if="receipt.body?.requestId" class="search-test-request-id mb-3" data-no-i18n>requestId {{ receipt.body.requestId }}</p>
              <v-alert v-if="failed" type="error" variant="tonal" class="mb-3">{{ receipt.body?.message || t('搜索接口返回错误，请查看完整返回。') }}</v-alert>
              <v-alert v-if="receipt.body?.data?.coverage?.state === 'partial'" type="warning" variant="tonal" class="mb-3">{{ t('部分来源未完成，请查看覆盖范围。') }}</v-alert>
              <p v-if="!failed && !items.length" class="mb-3">{{ t('没有匹配结果。') }}</p>
              <article v-for="(item, index) in items" :key="index" class="search-test-result" data-no-i18n>
                <h3>{{ item.label }}</h3><small>{{ item.source }} · {{ item.kind }}</small>
                <pre>{{ item.excerpt }}</pre>
                <details v-if="item.handle"><summary>{{ t('真实调用入口') }}</summary><pre>{{ pretty(item.handle) }}</pre></details>
              </article>
              <details class="search-test-details"><summary>{{ t('实际请求') }}</summary><pre data-no-i18n>{{ pretty(receipt.request) }}</pre></details>
              <details v-if="receipt.body?.data" class="search-test-details"><summary>{{ t('覆盖范围与警告') }}</summary><pre data-no-i18n>{{ pretty({ coverage: receipt.body.data.coverage, degraded: receipt.body.data.degraded, warnings: receipt.body.data.warnings }) }}</pre></details>
              <details class="search-test-details" @toggle="showRaw = ($event.target as HTMLDetailsElement).open"><summary>{{ t('完整返回（JSON）') }}</summary><pre v-if="showRaw" data-no-i18n>{{ pretty(receipt.body) }}</pre></details>
            </template>
          </section>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.search-test-grid { display: grid; grid-template-columns: minmax(260px, 360px) minmax(0, 1fr); gap: 24px; }
.search-test-input, .search-test-output { min-width: 0; }
.search-test-parameters :deep(textarea) { font-family: monospace; }
.search-test-request-id { overflow-wrap: anywhere; font-size: 12px; }
.search-test-result { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .16); }
.search-test-result h3 { font-size: 15px; overflow-wrap: anywhere; }
.search-test-result pre { max-height: 180px; overflow: auto; margin-top: 8px; }
.search-test-details { margin-top: 16px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
summary { cursor: pointer; padding-block: 8px; }
@media (max-width: 760px) { .search-test-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
