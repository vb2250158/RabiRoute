<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "../i18n/index";
import { userFacingError } from "../userFacingError";

type Provider = { id: string; label: string; credentialMode?: string; modes?: { id:string; label:string; endpoint:string }[]; defaults: { endpoint?: string; model?: string; resourceId?: string; voice?: string; recognitionMode?: string } };
type Service = { id?: string; kind: string; provider: string; name: string; model: string; endpoint: string; voice?: string; resourceId?: string; recognitionMode?: string; configured?: boolean; credentialMode?: string };
type Catalog = { services: Service[]; providers: Record<string, Provider[]> };

const props = defineProps<{ kind: string; search: string }>();
const { isEnglish } = useI18n();
const label = (zh: string, en: string) => isEnglish.value ? en : zh;
const catalog = ref<Catalog>();
const draft = ref<Service>();
const original = ref<Service>();
const key = ref("");
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const formError = ref("");
const controller = new AbortController();
const providers = computed(() => catalog.value?.providers[props.kind] || []);
const provider = computed(() => providers.value.find(item => item.id === draft.value?.provider));
const rows = computed(() => {
  const query = props.search.trim().toLocaleLowerCase();
  return (catalog.value?.services || []).filter(row => row.kind === props.kind
    && [row.name, row.model, providerLabel(row.provider)].some(value => value.toLocaleLowerCase().includes(query)));
});
const hasKey = computed(() => Boolean(original.value?.configured && original.value.provider === draft.value?.provider && original.value.endpoint === draft.value?.endpoint));
const usesKey = computed(() => Boolean(provider.value && !provider.value.credentialMode));
const generic = computed(() => providers.value.some(item => item.id === "http-api"));

function providerLabel(id: string) { return providers.value.find(item => item.id === id)?.label || id; }
function serviceError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  const messages: Record<string, string> = {
    MODEL_SERVICE_ACCESS_DENIED: label("当前连接不能管理 API 模型服务。", "This connection cannot manage API model services."),
    MODEL_SERVICE_IN_USE: label("此服务正在使用中。结束实时语音后再保存。", "End the live voice session before editing this service."),
    MODEL_SERVICE_MANAGER_CHANGED: label("服务已换代，请刷新页面后重试。", "The Manager changed. Reload the page and retry."),
    MODEL_SERVICE_INVALID: label("请检查服务名称、模型和连接参数。", "Check the service name, model, and connection details."),
    ASSISTANT_MODEL_ENDPOINT_INVALID: label("请输入完整的 HTTPS 接口地址。本机环回地址也可使用 HTTP。", "Enter the full HTTPS endpoint. Loopback endpoints can also use HTTP."),
    SPEECH_ENDPOINT_REQUIRES_WSS: label("火山语音服务需要 WSS 接口地址。", "Volcengine speech services require a WSS endpoint."),
    SPEECH_ENDPOINT_REQUIRES_TLS: label("请输入 HTTPS 接口地址。本机环回地址也可使用 HTTP。", "Use an HTTPS endpoint. Loopback endpoints can also use HTTP."),
    HTTP_404: label("当前运行版本尚未提供 API 模型服务。", "API model services are unavailable in the running version.")
  };
  return messages[code] || userFacingError(cause);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { signal: controller.signal, ...init });
  if (!response.ok && response.status === 404) throw Error("HTTP_404");
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw Error(body.message || `HTTP_${response.status}`);
  return body.data as T;
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try { catalog.value = await request<Catalog>("/api/model-services/api-models"); }
  catch (cause) { if (!controller.signal.aborted) error.value = serviceError(cause); }
  finally { loading.value = false; }
}

function chooseProvider(id: string) {
  if (!draft.value) return;
  const selected = providers.value.find(item => item.id === id);
  if (!selected) return;
  const defaults = selected.defaults;
  draft.value = { id: draft.value.id, kind: props.kind, provider: id, name: draft.value.name,
    endpoint: defaults.endpoint || "", model: defaults.model || "", voice: defaults.voice || "", resourceId: defaults.resourceId || "", recognitionMode: defaults.recognitionMode };
  key.value = "";
}

function applyRecognitionMode(mode: string) {
  if (draft.value?.kind !== "asr" || draft.value.provider !== "volcengine") return;
  const modes=provider.value?.modes || [];
  const next=modes.find(item=>item.id===mode);
  if (!next) return;
  if (modes.some(item=>item.endpoint===draft.value?.endpoint)) draft.value.endpoint = next.endpoint;
  draft.value.recognitionMode = mode;
}

function edit(row?: Service) {
  if (row) {
    original.value = row;
    draft.value = { ...row };
  } else {
    original.value = undefined;
    draft.value = { kind: props.kind, provider: "", name: "", endpoint: "", model: "" };
    chooseProvider(props.kind === "search" ? "tavily" : providers.value.find(item => !item.credentialMode)?.id || providers.value[0]?.id || "");
  }
  key.value = "";
  formError.value = "";
}

function cancel() {
  if (saving.value) return;
  draft.value = undefined;
  original.value = undefined;
  key.value = "";
}

async function save() {
  if (!draft.value || saving.value) return;
  const { configured, credentialMode, ...fields } = draft.value;
  const value = { ...fields, ...(key.value ? { apiKey: key.value } : {}) };
  saving.value = true;
  formError.value = "";
  try {
    const response = await fetch("/meta", { signal: controller.signal });
    const identity = await response.json();
    if (!response.ok || !identity.applicationGenerationId || !identity.managerInstanceId) throw Error("MODEL_SERVICE_MANAGER_CHANGED");
    await request<Service>("/api/model-services/api-models", { method: "POST", headers: {
      "content-type": "application/json",
      "x-rabiroute-expected-application-generation-id": identity.applicationGenerationId,
      "x-rabiroute-expected-manager-instance-id": identity.managerInstanceId,
    }, body: JSON.stringify(value) });
    draft.value = undefined;
    original.value = undefined;
    key.value = "";
    await load();
  } catch (cause) { if (!controller.signal.aborted) formError.value = serviceError(cause); }
  finally { saving.value = false; }
}

watch(() => props.kind, cancel);
onMounted(load);
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <section class="api-models" :aria-label="label('API 模型', 'API models')">
    <header>
      <h3>{{ label('API 模型（本地或在线）', 'API models (local or online)') }}</h3>
      <v-btn variant="tonal" color="primary" prepend-icon="mdi-plus" :disabled="!providers.length || saving" @click="edit()">
        {{ label('添加 API 模型', 'Add API model') }}
      </v-btn>
    </header>
    <v-progress-linear v-if="loading" indeterminate />
    <v-alert v-if="error" type="error" variant="tonal" density="compact">
      {{ error }} <v-btn variant="text" size="small" @click="load">{{ label('重试', 'Retry') }}</v-btn>
    </v-alert>
    <div v-else-if="rows.length" class="api-model-list">
      <div v-for="row in rows" :key="row.id" class="api-model-row">
        <div><strong>{{ row.name }}</strong><small>{{ [providerLabel(row.provider), row.model].filter(Boolean).join(' · ') }}</small></div>
        <v-btn variant="text" size="small" :disabled="saving" @click="edit(row)">{{ label('配置', 'Configure') }}</v-btn>
      </div>
    </div>
    <p v-else-if="!loading" class="api-note">{{ label('暂无 API 模型。', 'No API models yet.') }}</p>
    <p v-if="generic" class="api-note">{{ label('可保存连接信息。此类别的 API 调用需由支持对应协议的功能接入。', 'Save connection details here. Calling the API requires a feature that supports its protocol.') }}</p>
    <v-dialog :model-value="Boolean(draft)" :persistent="saving" max-width="660" @update:model-value="open => { if (!open) cancel(); }">
      <v-card v-if="draft" :title="draft.id ? label('配置 API 模型', 'Configure API model') : label('添加 API 模型', 'Add API model')">
        <form @submit.prevent="save">
          <v-card-text class="api-form">
            <v-text-field v-model="draft.name" required :label="label('服务名称', 'Service name')" maxlength="128" :disabled="saving" />
            <v-autocomplete :model-value="draft.provider" :items="providers" item-title="label" item-value="id" :label="label('接口协议', 'API protocol')" :disabled="saving" @update:model-value="chooseProvider" />
            <v-text-field v-if="draft.endpoint || kind !== 'search'" v-model="draft.endpoint" :readonly="kind === 'search' || Boolean(provider?.credentialMode)" :label="label('完整接口地址', 'Full API endpoint')" :disabled="saving" />
            <v-text-field v-if="kind !== 'search'" v-model="draft.model" required maxlength="256" :label="label('模型 ID', 'Model ID')" :disabled="saving" />
            <template v-if="draft.provider === 'volcengine'">
              <v-autocomplete v-if="provider?.modes" :model-value="draft.recognitionMode" :items="provider.modes" item-title="label" item-value="id" :label="label('识别模式', 'Recognition mode')" :disabled="saving" @update:model-value="applyRecognitionMode" />
              <v-text-field v-model="draft.resourceId" required :label="label('资源 ID', 'Resource ID')" :disabled="saving" />
            </template>
            <v-text-field v-if="kind === 'tts'" v-model="draft.voice" required :label="label('音色 ID', 'Voice ID')" :disabled="saving" />
            <v-text-field v-if="usesKey" v-model="key" type="password" autocomplete="new-password" label="API Key" :disabled="saving"
              :placeholder="hasKey ? label('留空保留已保存密钥', 'Leave blank to keep the saved key') : undefined" />
            <v-alert v-if="formError" type="error" variant="tonal" density="compact">{{ formError }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn :disabled="saving" @click="cancel">{{ label('取消', 'Cancel') }}</v-btn>
            <v-btn type="submit" variant="tonal" color="primary" :loading="saving">{{ label('保存', 'Save') }}</v-btn>
          </v-card-actions>
        </form>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.api-models { display: grid; gap: 8px; min-width: 0; }
.api-models header, .api-model-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.api-models h3 { margin: 0; font-size: 16px; }
.api-model-list { border: 1px solid var(--rr-border); border-radius: 8px; background: var(--rr-surface); }
.api-model-row { padding: 8px 12px; overflow-wrap: anywhere; }
.api-model-row + .api-model-row { border-top: 1px solid var(--rr-border); }
.api-model-row small { display: block; color: var(--rr-muted-soft); }
.api-note { margin: 0; color: var(--rr-muted-soft); font-size: 13px; }
.api-form { display: grid; gap: 2px; }
</style>
