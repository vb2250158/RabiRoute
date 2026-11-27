<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { managerAccessToken } from "../../../../../ribiwebgui/src/managerApi";
import { requestPhoneScreenOperation, requestDeviceScreenOperation, type AndroidDisplayTarget, type PhoneControlAction } from "../../../../../ribiwebgui/src/rabiLinkHomeClient";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import type { PhoneDevice } from "./phoneDevice";
import { phonePreviewPointer, phoneRecord as record, readPhoneScreenFeedback, type PhoneScreenFeedback } from "./phoneScreenFeedback";

const props = defineProps<{ phone?: PhoneDevice; display?: AndroidDisplayTarget }>();
const { t } = useI18n();
const state = ref<"sharing" | "consent-required" | "closed">();
const image = ref<string>();
const source = ref<Record<string, unknown>>();
const busy = ref(false);
const message = ref("");
const canTouch = computed(() => Boolean(props.display || props.phone?.capabilities.includes("phone-input-v1")));
const canOpenApps = computed(() => Boolean(props.display || props.phone?.capabilities.includes("phone-apps-v1")));
type AppEntry = { appId: string; name: string; packageName: string };
const apps = ref<AppEntry[]>([]);
const selectedApp = ref<string>();
const tapping = ref(false);
const originalInput = ref("");
const inputRunning = ref(false);
const inputUnconfirmed = ref(false);
const feedback = ref<PhoneScreenFeedback>();
const pointer = computed(() => phonePreviewPointer(feedback.value, source.value));
const outsideOperation = computed(() => {
  const operation = feedback.value?.operation;
  return operation && (!inputRunning.value || operation.requestId !== originalInput.value) ? operation : undefined;
});
const stoppingRemote = ref<string>();
let active: AbortController | undefined;
let recovery: AbortController | undefined;
let probe: AbortController | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let markerTimer: ReturnType<typeof setTimeout> | undefined;
let supportsFeedback = false;
let disposed = false;

function request(input: PhoneControlAction, signal: AbortSignal) {
  const token = managerAccessToken();
  return props.display ? requestDeviceScreenOperation(props.display, input, signal, token)
    : requestPhoneScreenOperation(props.phone!, input, signal, token);
}

function clearFeedback() {
  clearTimeout(markerTimer);
  feedback.value = undefined;
}

function watchVisibility() {
  if (document.hidden) {
    probe?.abort();
    probe = undefined;
    clearTimeout(statusTimer);
    clearFeedback();
  } else void refreshStatus();
}

onMounted(() => {
  document.addEventListener("visibilitychange", watchVisibility);
  watchVisibility();
});
onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener("visibilitychange", watchVisibility);
  clearTimeout(statusTimer);
  clearFeedback();
  active?.abort(); recovery?.abort(); probe?.abort();
});

function clearFrame() {
  image.value = undefined;
  source.value = undefined;
  tapping.value = false;
}

async function refreshStatus(manual = false) {
  if (probe || disposed || document.hidden) return;
  clearTimeout(statusTimer);
  const controller = new AbortController();
  probe = controller;
  const originalFrame = source.value;
  const originalState = state.value;
  const requestedAt = performance.now();
  let failed = false;
  try {
    const result = await request({ action: "screen.status" }, controller.signal);
    if (controller.signal.aborted) return;
    if (props.display && result.state === "closed") {
      state.value = "closed";
      supportsFeedback = false;
      clearFrame();
      clearFeedback();
      return;
    }
    if (result.state !== "sharing" && result.state !== "consent-required") throw new Error("PHONE_SCREEN_INVALID_RESPONSE");
    if (source.value === originalFrame && state.value === originalState) {
      state.value = result.state;
      if (result.state !== "sharing" || (typeof result.layoutRevision === "string" &&
          originalFrame && originalFrame.layoutRevision !== result.layoutRevision)) clearFrame();
    }
    const next = readPhoneScreenFeedback(result);
    // Older phones continue to respond to manual refresh without a monitoring loop.
    if (record(result.activity)) supportsFeedback = true;
    clearFeedback();
    if (next) {
      const remaining = (next.pointer?.remainingMs ?? 0) - (performance.now() - requestedAt);
      if (remaining <= 0) next.pointer = undefined;
      feedback.value = next;
      if (next.pointer) markerTimer = setTimeout(() => {
        if (feedback.value?.pointer?.requestId === next.pointer?.requestId) feedback.value = { ...next, pointer: undefined };
      }, remaining);
    }
    if (manual) message.value = "";
  } catch {
    failed = true;
    if (!controller.signal.aborted) {
      clearFeedback();
      if (manual || state.value === undefined) message.value = "无法读取手机画面，请刷新状态。";
    }
  } finally {
    if (probe === controller) {
      probe = undefined;
      if (!disposed && !document.hidden && supportsFeedback) statusTimer = setTimeout(() => void refreshStatus(),
        !failed && (source.value || feedback.value?.operation) ? 300 : 1000);
    }
  }
}

function acceptCapture(capture: unknown): boolean {
  if (!record(capture) || capture.mimeType !== "image/png" || typeof capture.data !== "string"
      || !record(capture.source) || typeof capture.source.instanceId !== "string" || typeof capture.source.frameId !== "string") return false;
  state.value = "sharing";
  image.value = `data:image/png;base64,${capture.data}`;
  source.value = capture.source;
  return true;
}

async function run(action: "screen.capture" | "screen.wait") {
  const baseline = source.value;
  const input = action === "screen.wait" ? (baseline ? { action, source: baseline } as const : undefined) : { action };
  if (!input) return;
  active?.abort();
  const controller = new AbortController();
  active = controller;
  busy.value = true;
  message.value = action === "screen.wait" ? "正在等待画面变化" : "";
  try {
    const result = await request(input, controller.signal);
    if (controller.signal.aborted) return;
    if (action === "screen.capture" && acceptCapture(result)) {
      message.value = "";
    } else if (action === "screen.wait" && result.state === "changed" && acceptCapture(result.capture)) {
      message.value = "";
    } else if (action === "screen.wait" && result.state === "unchanged") {
      message.value = "画面未变化";
    } else if (action === "screen.wait" && result.state === "target-changed") {
      clearFrame();
      message.value = "原画面已失效，请重新截图。";
    } else throw new Error("PHONE_SCREEN_INVALID_RESPONSE");
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error instanceof Error && error.message === "PHONE_SCREEN_CONSENT_REQUIRED") {
      state.value = "consent-required";
      clearFrame();
      message.value = "";
    } else {
      message.value = "无法读取手机画面，请刷新状态。";
    }
  } finally {
    if (active === controller) busy.value = false;
  }
}

function applyInputState(result: Record<string, unknown>): void {
  const key = String(result.state);
  const inputMessages: Record<string, string> = {
    completed: "手机操作已完成", cancelled: "手机操作已停止", "cancel-requested": "正在停止手机操作",
    running: "正在操作手机", "target-changed": "原画面已失效，请重新截图。", "consent-required": "请在手机 RabiLink 设置中开启「共享手机屏幕」。",
    "accessibility-required": "请在手机的无障碍设置中启用「RabiLink 手机触屏」。", busy: "该手机正在执行另一批操作。",
    uncertain: "手机操作结果待确认", absent: "手机未收到该批操作"
  };
  message.value = result.launchState === "requested" ? "已请求打开手机应用"
    : key === "app-unavailable" ? "该应用已不可启动，请刷新应用列表。"
    : inputMessages[key] ?? "手机操作结果待确认";
  inputUnconfirmed.value = ["running", "cancel-requested", "uncertain"].includes(key);
  if (key === "consent-required") { state.value = key; apps.value = []; selectedApp.value = undefined; }
  if (key === "target-changed" || key === "consent-required") clearFrame();
}

type TouchRequest = Extract<PhoneControlAction, { action: "input.perform" }>;
type LaunchRequest = Extract<PhoneControlAction, { action: "apps.open" }>;

function performTouch(step: TouchRequest["actions"][number]) {
  if (!source.value || !canTouch.value) return;
  return performAction({ action: "input.perform", source: source.value, actions: [step], captureAfter: { waitMs: 800 } });
}

function openSelectedApp() {
  if (!canOpenApps.value || state.value !== "sharing" || !selectedApp.value || !apps.value.some(app => app.appId === selectedApp.value)) return;
  const sourceAtStart = source.value;
  return performAction({ action: "apps.open", appId: selectedApp.value,
    ...(sourceAtStart ? { source: sourceAtStart, captureAfter: { waitMs: 1600 } } : { captureAfter: true }) });
}

async function loadApps() {
  if (busy.value || !canOpenApps.value || state.value !== "sharing") return;
  const controller = new AbortController();
  active = controller;
  busy.value = true;
  message.value = "";
  try {
    const result = await request({ action: "apps.list" }, controller.signal);
    if (controller.signal.aborted) return;
    if (result.state !== "ready" || !Array.isArray(result.apps)) { applyInputState(result); return; }
    apps.value = result.apps.filter((value): value is AppEntry => record(value) && typeof value.appId === "string" &&
      typeof value.name === "string" && typeof value.packageName === "string");
    if (!apps.value.some(app => app.appId === selectedApp.value)) selectedApp.value = undefined;
    if (!apps.value.length) message.value = "手机没有可启动的应用。";
  } catch {
    if (!controller.signal.aborted) message.value = "无法读取手机应用列表。";
  } finally { if (active === controller) busy.value = false; }
}

async function performAction(intent: Omit<TouchRequest, "requestId"> | Omit<LaunchRequest, "requestId">) {
  if (busy.value || inputUnconfirmed.value) return;
  const controller = new AbortController();
  active = controller;
  const requestId = browserUuid();
  originalInput.value = requestId;
  inputUnconfirmed.value = false;
  inputRunning.value = true;
  busy.value = true;
  let refresh = false;
  message.value = "正在操作手机";
  try {
    const result = await request({ ...intent, requestId }, controller.signal);
    if (!controller.signal.aborted) {
      applyInputState(result);
      if (result.state === "completed") {
        const capture = result.capture;
        if (!record(capture)) refresh = true;
        else if (capture.state === "captured") refresh = !acceptCapture(capture);
        else if (capture.state === "target-changed" || capture.state === "unavailable") {
          clearFrame();
          message.value = "手机操作已完成，请重新截图。";
        }
      }
    }
  } catch {
    if (!controller.signal.aborted) { inputUnconfirmed.value = true; message.value = "手机操作结果待确认"; }
  } finally {
    if (active === controller) { busy.value = false; inputRunning.value = false; }
  }
  if (refresh) void run("screen.capture");
}

function tapPreview(event: MouseEvent) {
  if (!tapping.value || !source.value || event.detail < 1) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const width = Number(source.value.width), height = Number(source.value.height);
  if (rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return;
  const x = Math.min(width - 1, Math.max(0, (event.clientX - rect.left) * width / rect.width));
  const y = Math.min(height - 1, Math.max(0, (event.clientY - rect.top) * height / rect.height));
  void performTouch({ type: "click", x, y });
}

async function readInput(action: "input.status" | "input.cancel", requestId = originalInput.value) {
  if (!requestId) return;
  const remote = requestId !== originalInput.value;
  if (remote) stoppingRemote.value = requestId;
  recovery?.abort();
  const controller = new AbortController();
  recovery = controller;
  try {
    const result = await request({ action, requestId }, controller.signal);
    if (!controller.signal.aborted && requestId === originalInput.value && (inputRunning.value || inputUnconfirmed.value)) applyInputState(result);
    if (!controller.signal.aborted && remote) void refreshStatus();
  } catch {
    if (!controller.signal.aborted && requestId === originalInput.value) { inputUnconfirmed.value = true; message.value = "手机操作结果待确认"; }
    if (!controller.signal.aborted && remote) message.value = "手机操作结果待确认";
  } finally {
    if (remote && stoppingRemote.value === requestId) stoppingRemote.value = undefined;
  }
}
</script>

<template>
  <section class="phone-screen">
    <div class="phone-screen-actions">
      <strong>{{ t(display ? 'Android 独立屏' : '手机屏幕共享') }}</strong>
      <v-btn size="small" variant="text" @click="refreshStatus(true)">{{ t('刷新状态') }}</v-btn>
      <v-btn size="small" variant="tonal" :disabled="busy || state !== 'sharing'" @click="run('screen.capture')">{{ t(display ? '截取独立屏画面' : '截取手机画面') }}</v-btn>
      <v-btn v-if="source" size="small" variant="text" :disabled="busy" @click="run('screen.wait')">{{ t('等待画面变化') }}</v-btn>
      <v-btn v-if="canTouch && source" size="small" variant="text" :disabled="busy || inputUnconfirmed" :aria-pressed="tapping" @click="tapping = !tapping">{{ t(tapping ? '退出预览点按' : '在预览上点按') }}</v-btn>
      <v-btn v-if="!display && canTouch && source" size="small" variant="text" :disabled="busy || inputUnconfirmed" @click="performTouch({ type: 'back' })">{{ t('返回') }}</v-btn>
      <v-btn v-if="inputRunning" size="small" variant="tonal" @click="readInput('input.cancel')">{{ t('停止本次操作') }}</v-btn>
      <v-btn v-if="inputUnconfirmed" size="small" variant="text" @click="readInput('input.status')">{{ t('查询原批次') }}</v-btn>
    </div>
    <ul v-if="feedback?.observations.length || feedback?.operation" class="phone-activity">
      <li v-for="viewer in feedback?.observations" :key="viewer.id">{{ viewer.label }} {{ t('正在看你的屏幕') }}</li>
      <li v-if="feedback?.operation">
        {{ feedback.operation.label }} {{ t(display ? '正在操作独立屏' : '正在操作你的手机') }}
        <v-btn v-if="outsideOperation" size="small" variant="text" :loading="stoppingRemote === outsideOperation.requestId"
          @click="readInput('input.cancel', outsideOperation.requestId)">{{ t('停止本次操作') }}</v-btn>
      </li>
    </ul>
    <div v-if="canOpenApps && state === 'sharing'" class="phone-app-actions">
      <v-btn size="small" variant="text" :disabled="busy" @click="loadApps">{{ t('读取手机应用') }}</v-btn>
      <v-autocomplete v-if="apps.length" v-model="selectedApp" :items="apps" item-title="name" item-value="appId"
        :label="t('选择手机应用')" density="compact" hide-details :disabled="busy" />
      <v-btn v-if="apps.length" size="small" variant="tonal" :disabled="busy || inputUnconfirmed || !selectedApp" @click="openSelectedApp">{{ t('打开应用') }}</v-btn>
    </div>
    <p v-if="message" role="status">{{ t(message) }}</p>
    <p v-else-if="state === 'consent-required'" role="status">{{ t('请在手机 RabiLink 设置中开启「共享手机屏幕」。') }}</p>
    <p v-else-if="state === 'closed'" role="status">{{ t('独立屏已关闭。') }}</p>
    <p v-else-if="state === 'sharing' && !display" role="status">{{ t('手机已开启屏幕共享。') }}</p>
    <div v-if="image" class="phone-preview">
      <img :src="image" :alt="t(display ? '独立屏截图' : '手机截图')" :class="{ tapping }" draggable="false" @click="tapPreview" />
      <div v-if="pointer" class="phone-preview-feedback" aria-hidden="true">
        <svg v-if="pointer.kind === 'swipe'" viewBox="0 0 100 100" preserveAspectRatio="none">
          <line :x1="pointer.startX * 100" :y1="pointer.startY * 100" :x2="pointer.x * 100" :y2="pointer.y * 100" vector-effect="non-scaling-stroke" />
        </svg>
        <span class="phone-touch-point" :class="{ 'near-right': pointer.x > 0.55 }"
          :style="{ left: pointer.x * 100 + '%', top: pointer.y * 100 + '%' }"><span>{{ pointer.label }}</span></span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.phone-screen { display: grid; gap: 8px; min-width: 0; }
.phone-screen-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.phone-screen-actions strong { flex: 1 1 160px; }
.phone-app-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.phone-app-actions .v-input { flex: 1 1 190px; }
.phone-screen p { color: var(--rr-muted); font-size: .85rem; }
.phone-activity { margin: 0; padding-inline-start: 1.2em; font-size: .85rem; }
.phone-preview { position: relative; width: fit-content; max-width: 100%; }
.phone-screen img { display: block; max-width: 100%; max-height: 480px; width: auto; height: auto; border-radius: 8px; }
.phone-screen img.tapping { cursor: crosshair; }
.phone-preview-feedback, .phone-preview-feedback svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.phone-preview-feedback line { stroke: #37dfc5; stroke-width: 3px; stroke-linecap: round; }
.phone-touch-point { position: absolute; width: 14px; height: 14px; transform: translate(-50%, -50%);
  border: 3px solid #37dfc5; border-radius: 50%; background: #0f1c25; }
.phone-touch-point span { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); white-space: nowrap;
  max-width: min(12rem, 56vw); overflow: hidden; text-overflow: ellipsis; padding: 3px 5px;
  border-radius: 4px; background: #0f1c25; color: #fff; font: 600 12px/1.2 system-ui, sans-serif; }
.phone-touch-point.near-right span { left: auto; right: 12px; }
</style>
