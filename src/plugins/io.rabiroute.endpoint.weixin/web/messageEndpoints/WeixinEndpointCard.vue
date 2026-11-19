<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import type { MessageEndpointCardContext } from "../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCardContext";

const props = defineProps<{ context?: MessageEndpointCardContext }>();
const store = useGatewayStore();
const routeId = computed(() => props.context?.routeId ?? store.selectedGateway?.id);
const active = computed(() => props.context?.active !== false);
const loginRequested = computed(() => props.context?.loginRequested === true);
const state = computed(() => store.selectedRuntime.gatewayStatus?.messageAdapters?.weixin);
const qr = computed<string | undefined>(() => state.value?.qrCodeDataUrl || undefined);
const status = computed<string>(() => state.value?.qrStatus || "");
const needsPin = computed(() => status.value.includes("need_verifycode") && !!state.value?.loginAttemptId);
const authorized = computed(() => state.value?.loggedIn || state.value?.credentialsRetained);
const busy = ref(false);
const error = ref("");
const mode = ref<"owner" | "other">("owner");
const pin = ref("");
const pending = ref<"login" | "logout">();
const qrHint = computed(() => {
  if (needsPin.value) return "输入手机微信显示的验证码";
  if (status.value === "real_name_required") return "用本人微信扫码完成实名授权";
  if (status.value === "scaned" || status.value === "scanned" || status.value === "scaned_but_redirect") {
    return "已扫码，请在手机微信确认";
  }
  return "用手机微信扫码并确认";
});

watch(routeId, () => {
  error.value = "";
  mode.value = "owner";
  pin.value = "";
  pending.value = undefined;
});

watch([routeId, active, loginRequested], async ([id, visible, requested], _, cleanup) => {
  if (!id || !visible || !requested) return;
  let current = true;
  cleanup(() => { current = false; });
  await store.ensureDiagnostics(true);
  if (current && !authorized.value && !qr.value && !pending.value) {
    mode.value = "owner";
    await request("login");
  }
}, { immediate: true });

watch([routeId, active, pending, qr], ([id, visible], _, cleanup) => {
  if (!id || !visible) return;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const startedAt = Date.now();
  async function refresh() {
    await store.ensureDiagnostics(true);
    if (stopped) return;
    if (pending.value) {
      if ((pending.value === "login" && (qr.value || authorized.value))
        || (pending.value === "logout" && !authorized.value && state.value?.loginRequired)) {
        pending.value = undefined;
      } else if (Date.now() - startedAt >= 30_000) {
        error.value = pending.value === "login" ? "暂未获取二维码，请重试。" : "暂未确认退出登录。";
        pending.value = undefined;
      }
    }
    if (pending.value || qr.value) timer = setTimeout(refresh, 2500);
  }
  void refresh();
  cleanup(() => { stopped = true; clearTimeout(timer); });
}, { immediate: true });

async function request(action: "login" | "pin" | "logout"): Promise<void> {
  const id = routeId.value;
  if (!id || busy.value || pending.value) return;
  busy.value = true;
  error.value = "";
  try {
    const body = action === "login" ? { mode: mode.value }
      : action === "pin" ? { pin: pin.value.trim(), attemptId: state.value?.loginAttemptId } : {};
    const response = await fetch(`/api/message/weixin/routes/${encodeURIComponent(id)}/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    if (routeId.value !== id) return;
    pin.value = "";
    if (action !== "pin") pending.value = action;
  } catch (cause) {
    if (routeId.value === id) error.value = userFacingError(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="routeId" class="weixin-login">
    <div v-if="authorized" class="d-flex align-center flex-wrap ga-3">
      <span class="text-body-2">{{ state?.loggedIn ? "已登录" : "已授权" }}</span>
      <v-btn size="small" variant="text" :loading="busy || pending === 'logout'" @click="request('logout')">退出登录</v-btn>
    </div>

    <div v-else-if="qr" class="weixin-scan">
      <p role="status" class="text-body-2 mb-0">{{ qrHint }}</p>
      <img :src="qr" width="192" height="192" alt="微信机器人登录二维码" />
      <div v-if="needsPin" class="weixin-scan-content">
        <form class="d-flex align-start flex-wrap ga-2" @submit.prevent="request('pin')">
          <v-text-field v-model="pin" label="验证码" type="password" inputmode="numeric" maxlength="16"
            autocomplete="one-time-code" density="compact" hide-details />
          <v-btn type="submit" color="primary" variant="tonal" :loading="busy" :disabled="!pin.trim()">确认</v-btn>
        </form>
      </div>
      <v-btn v-if="loginRequested && mode === 'owner' && !needsPin && status !== 'real_name_required'"
        variant="text" size="small" :disabled="busy || !!pending" @click="mode = 'other'; request('login')">邀请他人绑定</v-btn>
    </div>

    <div v-else-if="loginRequested && (busy || pending)" class="weixin-scan" role="status">
      <v-progress-circular indeterminate color="primary" size="28" />
      <span class="text-body-2">正在获取二维码</span>
    </div>
    <div v-else class="d-flex align-center justify-center flex-wrap ga-2">
      <v-btn color="primary" variant="tonal" prepend-icon="mdi-qrcode-scan" size="small"
        :loading="mode === 'owner' && (busy || pending === 'login')" :disabled="busy || !!pending"
        @click="mode = 'owner'; request('login')">微信扫码登录</v-btn>
      <v-btn variant="text" size="small" :loading="mode === 'other' && (busy || pending === 'login')"
        :disabled="busy || !!pending" @click="mode = 'other'; request('login')">邀请他人绑定</v-btn>
    </div>

    <p v-if="error" role="alert" class="text-error text-body-2 mt-2 mb-0">{{ error }}</p>
    <p v-else-if="!authorized && status === 'expired'" role="status" class="text-body-2 mt-2 mb-0">二维码已过期</p>
    <p v-else-if="!authorized && !qr && state?.lastError" role="alert" class="text-error text-body-2 mt-2 mb-0">{{ state.lastError }}</p>
  </div>
</template>

<style scoped>
.weixin-scan {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-block: 24px;
  gap: 16px;
}

.weixin-scan img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  background: white;
}

.weixin-scan-content {
  width: 100%;
  min-width: 0;
}
</style>
