<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { translateText } from "../i18n";
import { useGatewayStore } from "../stores/gatewayStore";
import { registerPageSaveAction } from "../pageSaveAction";
import { rabiLinkDraftFromMeta, rabiLinkIdentityPatch } from "../rabiLinkPresentation";
import { userFacingError } from "../userFacingError";
import { InstanceIdentityResetClient, readResetIdentity } from "../instanceIdentityResetClient";
import KnowledgeBridgeSettings from "./KnowledgeBridgeSettings.vue";

const props = defineProps<{ ready: boolean }>();
const emit = defineEmits<{ saving: [value: boolean] }>();
const store = useGatewayStore();
const draft = ref(rabiLinkDraftFromMeta(store.meta));
const baseline = ref(JSON.stringify(draft.value));
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value);
const saving = ref(false);
const reset = reactive(new InstanceIdentityResetClient());
const resetting = ref(false);
const resetSupported = ref(false);
const resetAvailability = ref<"loading" | "ready" | "error">("loading");
let identityRequest: AbortController | undefined;
let disposed = false;
const busy = computed(() => saving.value || resetting.value);
const error = ref("");
const ready = computed(() => props.ready);
function hydrate() {
  draft.value = rabiLinkDraftFromMeta(store.meta);
  baseline.value = JSON.stringify(draft.value);
}
watch(() => [props.ready, store.meta.rabiName, store.meta.rabiGuid, store.meta.agentUploads, store.meta.rabiLinkRelay], () => {
  if (props.ready && !dirty.value && !busy.value) hydrate();
});
watch(() => [props.ready, store.meta.rabiGuid], async () => {
  if (!props.ready || resetting.value || reset.state === "pending") return;
  identityRequest?.abort();
  const request = new AbortController();
  identityRequest = request;
  resetAvailability.value = "loading";
  resetSupported.value = false;
  try {
    const identity = await readResetIdentity(AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]));
    if (disposed || request !== identityRequest || request.signal.aborted) return;
    resetSupported.value = identity.canResetInstanceId && identity.guid === store.meta.rabiGuid;
    resetAvailability.value = identity.guid === store.meta.rabiGuid ? "ready" : "error";
  } catch {
    if (!disposed && request === identityRequest && !request.signal.aborted) resetAvailability.value = "error";
  }
}, { immediate: true });
onBeforeRouteLeave(() => !dirty.value || window.confirm(translateText("RabiLink 配置尚未保存，确定离开并放弃修改吗？")));
const claimWaitSeconds = computed({ get: () => draft.value.claimWaitMs / 1000, set: (value: number) => { draft.value.claimWaitMs = Number(value) * 1000; } });
const replyIdleSeconds = computed({ get: () => draft.value.replyIdleTimeoutMs / 1000, set: (value: number) => { draft.value.replyIdleTimeoutMs = Number(value) * 1000; } });

async function save() {
  if (!ready.value || busy.value || !dirty.value) return;
  saving.value = true;
  emit("saving", true);
  error.value = "";
  try {
    const response = await fetch("/api/rabi/identity", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify(rabiLinkIdentityPatch(draft.value))
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.data) throw new Error(body.message || "保存失败");
    // Only the identity snapshot changes; unrelated Route drafts remain untouched.
    const { token: _token, ...relay } = body.data.rabiLinkRelay || {};
    store.meta.rabiName = body.data.rabiName;
    store.meta.rabiGuid = body.data.rabiGuid;
    store.meta.agentUploads = body.data.agentUploads;
    store.meta.rabiLinkRelay = relay;
    hydrate();

  } catch (reason) {
    error.value = userFacingError(reason);
    throw reason;
  } finally { saving.value = false; emit("saving", false); }
}
async function confirmReset() {
  if (!reset.dialogOpen || !resetSupported.value || busy.value) return;
  resetting.value = true;
  identityRequest?.abort();
  emit("saving", true);
  try {
    await reset.confirm();
    if (!disposed && reset.state === "committed") store.meta.rabiGuid = reset.newGuid;
  } finally {
    resetting.value = false;
    if (!disposed) emit("saving", false);
  }
}
const unregister = registerPageSaveAction({ dirty, ready, saving: busy, save });
onBeforeUnmount(() => { disposed = true; identityRequest?.abort(); reset.dispose(); unregister(); });
</script>

<template>
  <v-card class="app-card glass-card pa-4 rabilink-settings">
    <div class="section-title">本机实例</div>
    <p class="section-note mb-3">配置这台电脑的身份与连接。修改后使用顶部保存按钮应用。</p>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="reset.message" :type="reset.state === 'committed' ? 'success' : ['failed', 'rolled_back'].includes(reset.state) ? 'error' : 'info'" variant="tonal" density="compact" class="mb-3" role="status">
      {{ translateText(reset.message) }}
      <template v-if="resetting" #append><v-btn size="small" variant="text" @click="reset.stopWaiting()">停止等待</v-btn></template>
    </v-alert>
    <v-progress-linear v-if="!ready" indeterminate class="mb-3" />
    <fieldset :disabled="!ready || busy" class="rabilink-fields">
      <div class="form-grid">
        <v-text-field v-model="draft.rabiName" label="RabiRoute 实例名称" density="compact" hide-details="auto" />
        <div>
          <v-text-field :model-value="store.meta.rabiGuid || '—'" label="实例标识" readonly density="compact" hint="系统生成的唯一标识（GUID），由本机 Host 管理。" hide-details="auto" />
          <div class="d-flex align-center flex-wrap ga-2 mt-2">
            <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" :loading="resetting" :disabled="!resetSupported || busy || reset.state === 'pending'" @click="reset.open(store.meta.rabiGuid || '')">重置实例 ID</v-btn>
            <span class="section-note">实例 ID 与连接密钥属于本机。</span>
          </div>
          <p v-if="resetAvailability === 'loading'" class="section-note mt-2">正在核对重置能力…</p>
          <p v-else-if="resetAvailability === 'error'" class="section-note mt-2">无法核对当前实例，请刷新后重试。</p>
          <p v-else-if="!resetSupported" class="section-note mt-2">当前 Host 不支持从页面重置实例 ID。</p>
        </div>
      </div>
      <v-divider class="my-3" />
      <div class="section-title">RabiLink 服务器连接</div>
      <p class="section-note">连接后，手机、眼镜和其他电脑可通过服务器与本机通信。</p>
      <v-switch v-model="draft.enabled" label="连接服务器" color="success" inset density="compact" hide-details />
      <div class="form-grid">
        <v-text-field v-model="draft.url" label="服务器地址" placeholder="https://relay.example.com" density="compact" hide-details="auto" />
        <v-text-field v-model="draft.token" label="应用令牌" :placeholder="store.meta.rabiLinkRelay?.tokenConfigured ? '已安全保存；留空保持不变' : '填写已有应用的令牌'" type="password" autocomplete="new-password" density="compact" hide-details="auto" />
        <v-text-field v-model="draft.deviceId" label="本机连接标识" density="compact" hide-details="auto" />
      </div>
      <v-divider class="my-3" />
      <div class="section-title">语音服务转接</div>
      <p class="section-note">允许持有应用令牌的客户端通过服务器调用本机语音合成与识别服务；本机服务仍仅限本地访问。</p>
      <v-switch v-model="draft.speechProxyEnabled" label="允许语音转接" color="success" inset density="compact" hide-details />
      <v-text-field v-if="draft.speechProxyEnabled" v-model="draft.speechServiceUrl" label="本机语音服务地址" density="compact" hide-details="auto" />
      <v-divider class="my-3" />
      <div class="section-title mb-2">远端智能体上传</div>
      <v-text-field v-model.number="draft.maxFileMiB" label="单文件上传上限（MiB）" type="number" min="1" max="2048" step="1" density="compact" hint="允许 1–2048 MiB；保存后重启 RabiRoute 生效。QQ 群文件仍受平台限制。" persistent-hint />
      <v-expansion-panels variant="accordion" class="mt-3">
        <v-expansion-panel title="高级设置">
          <v-expansion-panel-text>
            <div class="form-grid">
              <v-text-field v-model.number="claimWaitSeconds" label="领取任务等待（秒）" type="number" min="0" max="60" step="1" density="compact" hide-details="auto" />
              <v-text-field v-model.number="replyIdleSeconds" label="回复空闲超时（秒）" type="number" min="1" max="120" step="1" density="compact" hide-details="auto" />
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </fieldset>
    <KnowledgeBridgeSettings v-if="ready" />
    <v-dialog :model-value="reset.dialogOpen" max-width="560" @update:model-value="value => { if (!value) reset.cancel(); }">
      <v-card class="pa-4">
        <v-card-title class="px-0">重置实例 ID？</v-card-title>
        <v-card-text class="px-0">此操作会生成新的实例 ID 和连接密钥，保留实例名称、人格、记录及连接配置。旧连接可能需要重新建立。</v-card-text>
        <v-card-actions class="px-0">
          <v-spacer />
          <v-btn variant="text" @click="reset.cancel()">取消</v-btn>
          <v-btn color="warning" variant="tonal" @click="confirmReset">确认重置</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.rabilink-fields { border: 0; padding: 0; min-width: 0; }
.rabilink-settings .form-grid { gap: 12px; }
</style>
