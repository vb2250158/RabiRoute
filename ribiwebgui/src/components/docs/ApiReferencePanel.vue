<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "../../i18n";
import { userFacingError } from "../../userFacingError";
import { API_REFERENCE_CHANGED, apiRequestTemplate, readApiReference, type ApiReferenceCatalog } from "../../docs/apiReferenceClient";

const { locale } = useI18n();
const labels = computed(() => locale.value === "zh-CN" ? {
  title: "接口参考", subtitle: "从当前运行服务的接口合同自动读取，供接入开发者使用。",
  search: "搜索名称、路径或说明", module: "所属模块", method: "HTTP 方法", all: "全部",
  refresh: "刷新目录", loading: "正在读取接口目录…", empty: "没有匹配的接口。", unavailable: "接口目录尚不可用。",
  operations: "项操作", gaps: "处注册范围缺口", scope: "当前运行目录；全项目覆盖尚未证明。",
  gapHelp: "每处注册范围可能包含多个接口。此处列出目录报告的缺口，不推算接口总数。",
  lastRead: "上次成功读取", request: "请求合同", response: "响应合同", behavior: "执行与恢复", validators: "业务校验",
  template: "Bash 请求模板", templateHelp: "先动态发现 MANAGER_BASE_URL，再补齐路径、查询、正文和当前连接的鉴权。模板不会自动执行。",
  protocol: "该操作使用原生传输，请按下方合同连接。", copy: "复制", copied: "已复制", copyFailed: "复制失败，可选中文本复制。",
  export: "下载 OpenAPI", contract: "完整合同", details: "选择接口查看详情", schemas: "Schema 描述已声明的结构，开放字段与原生透传按业务接口解释。"
} : locale.value === "ja" ? {
  title: "API リファレンス", subtitle: "実行中のサービスに登録された API 契約を表示します。開発者向けの資料です。",
  search: "名前、パス、説明を検索", module: "モジュール", method: "HTTP メソッド", all: "すべて",
  refresh: "更新", loading: "API 一覧を読み込み中…", empty: "一致する API はありません。", unavailable: "API 一覧を利用できません。",
  operations: "操作", gaps: "未登録の範囲", scope: "実行中の一覧です。プロジェクト全体の網羅性は未確認です。",
  gapHelp: "各範囲に複数の API が含まれる場合があります。API の総数を示すものではありません。",
  lastRead: "最終取得", request: "リクエスト契約", response: "レスポンス契約", behavior: "実行と復旧", validators: "業務検証",
  template: "Bash リクエストテンプレート", templateHelp: "MANAGER_BASE_URL を検出し、パス、クエリ、本文、接続の認証を補完してください。自動実行はしません。",
  protocol: "この操作はネイティブ通信を使います。以下の契約に従って接続してください。", copy: "コピー", copied: "コピー済み", copyFailed: "コピーできません。テキストを選択してください。",
  export: "OpenAPI を保存", contract: "完全な契約", details: "API を選択してください", schemas: "Schema は宣言された構造を表します。公開フィールドと透過通信は業務 API の規則に従います。"
} : {
  title: "API reference", subtitle: "Read executable contracts from the running service. Reference for integration developers.",
  search: "Search names, paths, or descriptions", module: "Module", method: "HTTP method", all: "All",
  refresh: "Refresh catalog", loading: "Reading API catalog…", empty: "No matching operations.", unavailable: "The API catalog is unavailable.",
  operations: "operations", gaps: "registration-scope gaps", scope: "Running catalog; project-wide coverage remains unproven.",
  gapHelp: "Each registration scope may contain multiple APIs. These are reported gaps, not a count of all missing endpoints.",
  lastRead: "Last successful read", request: "Request contract", response: "Response contract", behavior: "Execution and recovery", validators: "Business validation",
  template: "Bash request template", templateHelp: "Discover MANAGER_BASE_URL, then supply path, query, body, and current connection authentication. Templates are never executed automatically.",
  protocol: "This operation uses a native transport. Connect according to its contract below.", copy: "Copy", copied: "Copied", copyFailed: "Copy failed; select and copy the text.",
  export: "Download OpenAPI", contract: "Full contract", details: "Select an operation", schemas: "Schemas describe declared structure. Open fields and native passthrough retain their business API semantics."
});

const catalog = ref<ApiReferenceCatalog | null>(null);
const loading = ref(false);
const error = ref("");
const downloaded = ref(false);
const copied = ref("");
const lastRead = ref("");
const query = ref("");
const moduleId = ref("");
const method = ref("");
const selectedId = ref("");
let request: AbortController | null = null;
let refreshPending = false;
let disposed = false;

const operations = computed(() => catalog.value?.operations || []);
const modules = computed(() => [...new Set(operations.value.map(item => item.owner.instanceId))].sort());
const methods = computed(() => [...new Set(operations.value.map(item => item.contract.method))].sort());
const filtered = computed(() => {
  const term = String(query.value || "").trim().toLowerCase();
  return operations.value.filter(item => (!moduleId.value || item.owner.instanceId === moduleId.value)
    && (!method.value || item.contract.method === method.value)
    && (!term || `${item.contract.operationId} ${item.contract.pathTemplate} ${item.contract.description}`.toLowerCase().includes(term)));
});
const selected = computed(() => filtered.value.find(item => item.contract.operationId === selectedId.value) || filtered.value[0]);
const template = computed(() => selected.value ? apiRequestTemplate(selected.value) : "");
const json = (value: unknown) => JSON.stringify(value, null, 2);

watch(operations, () => {
  if (!modules.value.includes(moduleId.value)) moduleId.value = "";
  if (!methods.value.some(value => value === method.value)) method.value = "";
});

async function refresh(): Promise<void> {
  if (request) { refreshPending = true; return; }
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = "";
  try {
    const result = await readApiReference(controller.signal);
    if (!disposed) {
      catalog.value = result;
      lastRead.value = new Date().toLocaleTimeString();
    }
  } catch (cause) {
    if (!disposed) error.value = userFacingError(cause);
  } finally {
    request = null;
    loading.value = false;
    if (refreshPending && !disposed) { refreshPending = false; void refresh(); }
  }
}

async function copy(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); copied.value = labels.value.copied; }
  catch { copied.value = labels.value.copyFailed; }
}

async function downloadOpenApi(): Promise<void> {
  downloaded.value = true;
  try {
    const response = await fetch("/api/agent/openapi");
    if (!response.ok) throw new Error(`OpenAPI: HTTP ${response.status}`);
    const specification = await response.json();
    const url = URL.createObjectURL(new Blob([json(specification)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "rabiroute-openapi.json";
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (cause) { error.value = userFacingError(cause); }
  finally { downloaded.value = false; }
}

onMounted(() => { window.addEventListener(API_REFERENCE_CHANGED, refresh); void refresh(); });
onBeforeUnmount(() => {
  disposed = true;
  request?.abort();
  window.removeEventListener(API_REFERENCE_CHANGED, refresh);
});
</script>

<template>
  <section class="api-reference" :aria-label="labels.title">
    <div class="api-toolbar">
      <p class="page-subtitle">{{ labels.subtitle }}</p>
      <div class="api-actions">
        <v-btn variant="tonal" size="small" :loading="loading" @click="refresh">{{ labels.refresh }}</v-btn>
        <v-btn variant="text" size="small" :loading="downloaded" @click="downloadOpenApi">{{ labels.export }}</v-btn>
      </div>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
    <div v-if="catalog" class="api-status app-card">
      <strong>{{ operations.length }} {{ labels.operations }}</strong>
      <span>{{ labels.lastRead }} {{ lastRead }}</span>
      <p>{{ labels.scope }}</p>
      <details v-if="catalog.coverage.gaps.length">
        <summary>{{ catalog.coverage.gaps.length }} {{ labels.gaps }}</summary>
        <p>{{ labels.gapHelp }}</p>
        <ul><li v-for="gap in catalog.coverage.gaps" :key="`${gap.instanceId}:${gap.routeId}`"><code>{{ gap.path || gap.pathPrefix || gap.routeId }}</code> — {{ gap.reason }}</li></ul>
      </details>
    </div>
    <div v-if="catalog" class="api-layout">
      <aside class="api-list app-card">
        <v-text-field v-model="query" :label="labels.search" clearable density="compact" hide-details />
        <label>{{ labels.module }}<select v-model="moduleId"><option value="">{{ labels.all }}</option><option v-for="item in modules" :key="item" :value="item">{{ item }}</option></select></label>
        <label>{{ labels.method }}<select v-model="method"><option value="">{{ labels.all }}</option><option v-for="item in methods" :key="item" :value="item">{{ item }}</option></select></label>
        <p class="api-count">{{ filtered.length }} / {{ operations.length }}</p>
        <div class="api-operation-list">
          <button v-for="item in filtered" :key="item.contract.operationId" type="button" :class="{ active: selected?.contract.operationId === item.contract.operationId }" :aria-pressed="selected?.contract.operationId === item.contract.operationId" @click="selectedId = item.contract.operationId">
            <strong>{{ item.contract.method }} <span>{{ item.contract.pathTemplate }}</span></strong>
            <small>{{ item.contract.operationId }}</small>
          </button>
          <p v-if="!filtered.length">{{ labels.empty }}</p>
        </div>
      </aside>
      <article v-if="selected" class="api-detail app-card">
        <h2>{{ selected.contract.method }} {{ selected.contract.pathTemplate }}</h2>
        <p>{{ selected.contract.description }}</p>
        <div class="api-actions"><code>{{ selected.contract.operationId }}</code><v-btn size="x-small" variant="text" @click="copy(selected.contract.operationId)">{{ labels.copy }}</v-btn></div>
        <p class="api-count">{{ selected.owner.instanceId }} · {{ selected.contract.transport }} · {{ selected.contract.contractVersion }}</p>
        <p>{{ labels.schemas }}</p>
        <h3>{{ labels.behavior }}</h3>
        <p>{{ selected.contract.effects.description }}</p><p>{{ selected.contract.recovery.description }}</p>
        <h3>{{ labels.validators }}</h3>
        <ul><li v-for="rule in selected.contract.validators" :key="rule.id">{{ rule.description }}</li></ul>
        <details open><summary>{{ labels.request }}</summary><pre>{{ json(selected.contract.request) }}</pre></details>
        <details><summary>{{ labels.response }}</summary><pre>{{ json(selected.contract.responses) }}</pre></details>
        <details><summary>{{ labels.contract }}</summary><pre>{{ json(selected.contract) }}</pre></details>
        <template v-if="selected.contract.transport !== 'websocket'">
          <h3>{{ labels.template }}</h3><p>{{ labels.templateHelp }}</p><pre>{{ template }}</pre>
          <v-btn variant="tonal" size="small" @click="copy(template)">{{ labels.copy }}</v-btn>
        </template>
        <p v-else>{{ labels.protocol }}</p>
        <span role="status">{{ copied }}</span>
      </article>
    </div>
    <p v-if="!catalog" role="status">{{ loading ? labels.loading : labels.unavailable }}</p>
  </section>
</template>

<style scoped>
.api-reference { display: grid; gap: 16px; }
.api-toolbar, .api-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.api-toolbar { justify-content: space-between; }
.api-status { padding: 16px 20px; font-size: 13px; }
.api-status > span { margin-left: 16px; color: var(--rr-muted-soft); }
.api-layout { display: grid; grid-template-columns: minmax(240px, 340px) minmax(0, 1fr); gap: 18px; align-items: start; }
.api-list { padding: 16px; position: sticky; top: 82px; }
.api-list label { display: grid; gap: 5px; margin-top: 12px; font-size: 12px; }
.api-list select { padding: 8px; color: var(--rr-text); border: 1px solid var(--rr-border); border-radius: 6px; background: var(--rr-surface); max-width: 100%; }
.api-count { margin: 12px 0; font-size: 12px; color: var(--rr-muted-soft); }
.api-operation-list { max-height: 55vh; overflow: auto; }
.api-operation-list button { display: grid; width: 100%; gap: 5px; padding: 10px; text-align: left; border-radius: 6px; color: var(--rr-text); }
.api-operation-list button:hover, .api-operation-list button.active { background: var(--rr-accent-surface); }
.api-operation-list strong { font-size: 12px; }
.api-operation-list small { font-size: 10px; color: var(--rr-muted-soft); overflow-wrap: anywhere; }
.api-operation-list span, .api-detail h2 { overflow-wrap: anywhere; }
.api-detail { padding: 24px; min-width: 0; }
.api-detail h2 { font-size: 20px; margin-bottom: 12px; }
.api-detail h3 { font-size: 15px; margin: 24px 0 10px; }
.api-detail p, .api-detail li { font-size: 13px; line-height: 1.65; margin-bottom: 12px; }
.api-detail ul, .api-status ul { padding-left: 20px; }
details { margin: 14px 0; }
summary { cursor: pointer; font-weight: 700; }
pre { overflow: auto; max-height: 440px; padding: 16px; margin: 12px 0; border-radius: 8px; background: var(--rr-surface); font-size: 12px; }
button:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--rr-accent); outline-offset: 2px; }
@media (max-width: 850px) { .api-layout { grid-template-columns: minmax(0, 1fr); } .api-list { position: static; } .api-operation-list { max-height: 32vh; } .api-detail { padding: 18px; } }
</style>
