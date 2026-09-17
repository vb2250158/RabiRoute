<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { translateText } from "../i18n";
import { useGatewayStore } from "../stores/gatewayStore";
import { registerPageSaveAction } from "../pageSaveAction";
import { rabiLinkDraftFromMeta, rabiLinkIdentityPatch } from "../rabiLinkPresentation";
import { userFacingError } from "../userFacingError";

const props = defineProps<{ ready: boolean }>();
const emit = defineEmits<{ saving: [value: boolean] }>();
const store = useGatewayStore();
const draft = ref(rabiLinkDraftFromMeta(store.meta));
const baseline = ref(JSON.stringify(draft.value));
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value);
const saving = ref(false);
const error = ref("");
const ready = computed(() => props.ready);
function hydrate() {
  draft.value = rabiLinkDraftFromMeta(store.meta);
  baseline.value = JSON.stringify(draft.value);
}
watch(() => [props.ready, store.meta.rabiName, store.meta.rabiGuid, store.meta.agentUploads, store.meta.rabiLinkRelay], () => {
  if (props.ready && !dirty.value && !saving.value) hydrate();
});
onBeforeRouteLeave(() => !dirty.value || window.confirm(translateText("RabiLink 配置尚未保存，确定离开并放弃修改吗？")));
const claimWaitSeconds = computed({ get: () => draft.value.claimWaitMs / 1000, set: (value: number) => { draft.value.claimWaitMs = Number(value) * 1000; } });
const replyIdleSeconds = computed({ get: () => draft.value.replyIdleTimeoutMs / 1000, set: (value: number) => { draft.value.replyIdleTimeoutMs = Number(value) * 1000; } });

async function save() {
  if (!ready.value || saving.value || !dirty.value) return;
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
const unregister = registerPageSaveAction({ dirty, ready, saving, save });
onBeforeUnmount(unregister);
</script>

<template>
  <v-card class="app-card glass-card pa-4 rabilink-settings">
    <div class="section-title">本机实例</div>
    <p class="section-note mb-3">配置这台电脑的身份与连接。修改后使用顶部保存按钮应用。</p>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-progress-linear v-if="!ready" indeterminate class="mb-3" />
    <fieldset :disabled="!ready || saving" class="rabilink-fields">
      <div class="form-grid">
        <v-text-field v-model="draft.rabiName" label="RabiRoute 实例名称" density="compact" hide-details="auto" />
        <v-text-field :model-value="store.meta.rabiGuid || '—'" label="实例标识" readonly density="compact" hint="系统生成的唯一标识（GUID），不可修改。" hide-details="auto" />
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
  </v-card>
</template>

<style scoped>
.rabilink-fields { border: 0; padding: 0; min-width: 0; }
.rabilink-settings .form-grid { gap: 12px; }
</style>
