<script setup lang="ts">
import { getTimeoutMs } from "../../../../../ribiwebgui/src/timeoutSettingsClient";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { translateText } from "../../../../../ribiwebgui/src/i18n/index";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { registerPageSaveAction } from "../../../../../ribiwebgui/src/pageSaveAction";
import { rabiLinkDraftFromMeta, rabiLinkIdentityPatch, saveRabiLinkIdentity } from "../../../../../ribiwebgui/src/rabiLinkPresentation";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { InstanceIdentityResetClient, readResetIdentity } from "../../../../../ribiwebgui/src/instanceIdentityResetClient";
import ModelServiceScope from "./ModelServiceScope.vue";

const props = defineProps<{ ready: boolean; active: boolean }>();
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
const sections = [
  { id: "instance", label: "本机实例", icon: "mdi-monitor" },
  { id: "connection", label: "服务器连接", icon: "mdi-lan-connect" },
  { id: "models", label: "模型服务", icon: "mdi-cube-outline" },
  { id: "uploads", label: "远端智能体上传", icon: "mdi-upload-outline" }
];
const section = ref("instance");
const route = useRoute();
watch(() => route.query.section, value => {
  if (sections.some(item => item.id === value)) section.value = String(value);
}, { immediate: true });
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
    const identity = await readResetIdentity(AbortSignal.any([request.signal, AbortSignal.timeout(getTimeoutMs("webgui.identity.read", 5000))]));
    if (disposed || request !== identityRequest || request.signal.aborted) return;
    resetSupported.value = identity.canResetInstanceId && identity.guid === store.meta.rabiGuid;
    resetAvailability.value = identity.guid === store.meta.rabiGuid ? "ready" : "error";
  } catch {
    if (!disposed && request === identityRequest && !request.signal.aborted) resetAvailability.value = "error";
  }
}, { immediate: true });
const claimWaitSeconds = computed({ get: () => draft.value.claimWaitMs / 1000, set: (value: number) => { draft.value.claimWaitMs = Number(value) * 1000; } });
const replyIdleSeconds = computed({ get: () => draft.value.replyIdleTimeoutMs / 1000, set: (value: number) => { draft.value.replyIdleTimeoutMs = Number(value) * 1000; } });

async function save() {
  if (!ready.value || busy.value || !dirty.value) return;
  saving.value = true;
  emit("saving", true);
  error.value = "";
  try {
    const submitted = JSON.stringify(draft.value);
    await saveRabiLinkIdentity(store.meta, rabiLinkIdentityPatch(draft.value, JSON.parse(baseline.value)));
    if (JSON.stringify(draft.value) === submitted) hydrate();
    else baseline.value = JSON.stringify(rabiLinkDraftFromMeta(store.meta));
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
watch(() => props.active, (active, _previous, onCleanup) => {
  if (active) onCleanup(registerPageSaveAction({ dirty, ready, saving: busy, save }, 350, computed(() => JSON.stringify(draft.value))));
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; identityRequest?.abort(); reset.dispose(); });
</script>

<template>
  <div class="rabilink-settings">
    <v-card class="app-card glass-card pa-2">
      <nav class="rabilink-config-nav" aria-label="RabiLink 配置分组">
        <v-btn v-for="item in sections" :key="item.id" :prepend-icon="item.icon"
          :variant="section === item.id ? 'tonal' : 'text'" :color="section === item.id ? 'primary' : undefined"
          :aria-current="section === item.id ? 'true' : undefined" @click="section = item.id">{{ translateText(item.label) }}</v-btn>
      </nav>
    </v-card>
    <v-card class="app-card glass-card pa-4">
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="reset.message" :type="reset.state === 'committed' ? 'success' : ['failed', 'rolled_back'].includes(reset.state) ? 'error' : 'info'" variant="tonal" density="compact" class="mb-3" role="status">
      {{ translateText(reset.message) }}
      <template v-if="resetting" #append><v-btn size="small" variant="text" @click="reset.stopWaiting()">停止等待</v-btn></template>
    </v-alert>
    <v-progress-linear v-if="!ready" indeterminate class="mb-3" />
    <fieldset :disabled="!ready || busy" class="rabilink-fields">
      <section v-show="section === 'instance'">
      <h2 class="section-title">本机实例</h2>
      <p class="section-note mb-3">配置这台电脑的身份。修改后使用顶部保存按钮应用。</p>
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
      </section>
      <section v-show="section === 'connection'">
      <h2 class="section-title">RabiLink 服务器连接</h2>
      <p class="section-note">保存服务器地址后，登录同一账号的电脑会自动连接。</p>
      <v-switch v-model="draft.enabled" label="连接服务器" color="success" inset density="compact" hide-details />
      <div class="form-grid">
        <v-text-field v-model="draft.url" label="服务器地址" placeholder="https://relay.example.com" density="compact" hide-details="auto" />
      </div>
      <v-expansion-panels variant="accordion" class="mt-4">
        <v-expansion-panel title="高级连接参数">
          <v-expansion-panel-text>
            <div class="form-grid">
              <v-text-field v-model="draft.token" label="旧版应用令牌" :placeholder="store.meta.rabiLinkRelay?.tokenConfigured ? '已保存，留空保持不变' : '用于已有应用连接'" type="password" autocomplete="new-password" density="compact" hide-details="auto" />
              <v-text-field v-model="draft.deviceId" label="本机连接标识" density="compact" hide-details="auto" />
              <v-select v-model="draft.speechServiceMode" label="语音服务连接" :items="[{ title: 'Rabi 自动管理', value: 'managed' }, { title: '指定服务地址', value: 'configured' }]" density="compact" hide-details="auto" />
              <v-text-field v-if="draft.speechServiceMode === 'configured'" v-model="draft.speechServiceUrl" label="语音服务地址（本机或远端）" density="compact" hide-details="auto" />
              <v-text-field v-model.number="claimWaitSeconds" label="领取任务等待（秒）" type="number" min="0" max="60" step="1" density="compact" hide-details="auto" />
              <v-text-field v-model.number="replyIdleSeconds" label="回复空闲超时（秒）" type="number" min="1" max="120" step="1" density="compact" hide-details="auto" />
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      </section>
      <section v-show="section === 'models'">
        <h2 class="section-title">模型服务</h2>
        <p class="section-note mb-3">让已授权设备使用这台电脑提供的模型。</p>
        <v-switch v-model="draft.provideModelServices" label="提供模型服务" color="success" inset density="compact" hide-details />
        <v-divider class="my-3" />
        <ModelServiceScope v-model="draft.modelScope" :providing="draft.provideModelServices" />
      </section>
      <section v-show="section === 'uploads'">
        <h2 class="section-title mb-2">远端智能体上传</h2>
        <v-text-field v-model.number="draft.maxFileMiB" label="单文件上传上限（MiB）" type="number" min="1" :max="Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2)" step="1" density="compact" hint="正整数 MiB，可高于 2048；保存后重启 RabiRoute 生效。实际发送仍取决于目标平台支持的文件大小。" persistent-hint />
      </section>
    </fieldset>
    <v-dialog :model-value="reset.dialogOpen" max-width="560" @update:model-value="value => { if (!value) reset.cancel(); }">
      <v-card class="pa-4">
        <v-card-title class="px-0">重置实例 ID？</v-card-title>
        <v-card-text class="px-0">此操作会生成新的实例 ID 和连接密钥，保留实例名称、角色、记录及连接配置。旧连接可能需要重新建立。</v-card-text>
        <v-card-actions class="px-0">
          <v-spacer />
          <v-btn variant="text" @click="reset.cancel()">取消</v-btn>
          <v-btn color="warning" variant="tonal" @click="confirmReset">确认重置</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    </v-card>
  </div>
</template>

<style scoped>
.rabilink-fields { border: 0; padding: 0; min-width: 0; }
.rabilink-settings { display: grid; grid-template-columns: minmax(190px, 1fr) minmax(0, 4fr); gap: 12px; align-items: start; }
.rabilink-config-nav { display: grid; gap: 4px; }
.rabilink-config-nav .v-btn { justify-content: start; }
.rabilink-settings .form-grid { gap: 12px; }
@media (max-width: 720px) {
  .rabilink-settings { grid-template-columns: minmax(0, 1fr); }
  .rabilink-config-nav { display: flex; flex-wrap: wrap; }
}
</style>
