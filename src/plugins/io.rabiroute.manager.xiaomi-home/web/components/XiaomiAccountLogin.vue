<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";

type Login = { sessionId: string; state: "waiting" | "expired" | "connected"; expiresAt: string; imageDataUrl?: string };
type CloudStatus = { connected: boolean; login?: Login };
const props = defineProps<{ autoStart?: boolean }>();
const cloud = "/api/agent/xiaomi-home/vacuum-cloud";
const connected = ref(false);
const login = ref<Login>();
const busy = ref(false);
const error = ref("");
const controller = new AbortController();
let polling = false;

async function request<T>(path: string, body?: object, key?: string): Promise<T> {
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]);
  let headers: Record<string, string> = { accept: "application/json" };
  if (body) {
    const response = await fetch("/meta", { cache: "no-store", signal });
    const meta = await response.json();
    if (!response.ok || !meta.applicationGenerationId || !meta.managerInstanceId) throw new Error("无法确认当前服务，请刷新页面重试。");
    headers = { ...headers, "content-type": "application/json", "x-rabiroute-expected-application-generation-id": meta.applicationGenerationId,
      "x-rabiroute-expected-manager-instance-id": meta.managerInstanceId, ...(key ? { "idempotency-key": key } : {}) };
  }
  const response = await fetch(cloud + path, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok || result.code !== 0 || result.data === undefined) throw new Error(result.error?.message || result.message || "小米账号连接失败。");
  return result.data as T;
}

function waitForNextPoll(): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = controller.signal;
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 400);
    function cancel(): void { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason); }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function poll(current: Login): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    while (!controller.signal.aborted && current.state === "waiting" && Date.now() < Date.parse(current.expiresAt)) {
      current = await request<Login>("/login/poll", { sessionId: current.sessionId });
      login.value = current;
      if (current.state === "waiting" && Date.now() < Date.parse(current.expiresAt)) await waitForNextPoll();
    }
    if (!controller.signal.aborted) await refresh(false);
  } finally { polling = false; }
}

async function refresh(resume = true): Promise<void> {
  try {
    const state = await request<CloudStatus>("/status");
    connected.value = state.connected;
    login.value = state.login;
    error.value = "";
    if (resume && state.login?.state === "waiting" && !state.connected) void poll(state.login).catch(showError);
  } catch (cause) { showError(cause); }
}
function showError(cause: unknown): void {
  if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : "小米账号连接失败。";
}
async function begin(): Promise<void> {
  if (busy.value || connected.value) return;
  busy.value = true;
  error.value = "";
  try {
    const current = await request<Login>("/login", {}, `xiaomi-account-${browserUuid()}`);
    login.value = current;
    await poll(current);
  } catch (cause) {
    showError(cause);
    // A timed-out login may still exist; recover the original session, never start a second one automatically.
    try {
      const state = await request<CloudStatus>("/status");
      connected.value = state.connected; login.value = state.login;
      if (!state.connected && state.login?.state === "waiting") await poll(state.login);
    } catch { /* Preserve the original error. */ }
  } finally { busy.value = false; }
}
onMounted(async () => {
  await refresh();
  if (props.autoStart && !controller.signal.aborted && !error.value && !connected.value && login.value?.state !== "waiting") {
    void begin();
  }
});
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <section aria-label="小米账号" class="pa-3">
    <div class="section-title-row"><div class="section-title small-title">小米账号</div>
      <v-chip size="small" variant="tonal" :color="connected ? 'success' : 'info'">{{ connected ? '已连接' : '未连接' }}</v-chip>
    </div>
    <p class="section-note mt-2">米家云功能使用同一账号连接，账号凭证保存在本机。</p>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{ error }}</v-alert>
    <v-btn v-if="!connected && login?.state !== 'waiting'" class="mt-3" variant="tonal" prepend-icon="mdi-qrcode-scan" :loading="busy" @click="begin">使用小米账号登录</v-btn>
    <div v-if="!connected && login?.state === 'waiting'" class="mt-3">
      <p role="status">请使用米家 App 扫码并确认登录。</p>
      <img v-if="login.imageDataUrl" :src="login.imageDataUrl" alt="小米账号登录二维码" width="220" height="220" />
    </div>
    <p v-if="login?.state === 'expired' && !connected" role="status">二维码已过期，请重新登录。</p>
    <v-btn class="mt-3 ml-2" variant="text" size="small" @click="refresh()">检查连接</v-btn>
  </section>
</template>
