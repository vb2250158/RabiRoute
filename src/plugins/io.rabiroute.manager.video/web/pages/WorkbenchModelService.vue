<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { managerEventSource } from "../../../../../ribiwebgui/src/managerApi";
import PeerServerSelect from "../../../../../ribiwebgui/src/components/PeerServerSelect.vue";
import { peerManagerPath } from "../../../../../ribiwebgui/src/peerManagerTarget";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { createMediaServiceClient, MediaServiceChangedError } from "./mediaServiceClient";

const serviceDeviceId = ref("");
const route = useRoute();
const client = createMediaServiceClient(() => serviceDeviceId.value);
const request = client.request;
const busy = ref(false);
const error = ref("");
const snapshot = ref<{ online: boolean; computeError?: string }>();
let events: EventSource | undefined;

type ModelFile = { name: string; bytes: number; installed: boolean; state: string };
type ModelManagement = { runtimeInstalled: boolean; models: { id: string; label: string; bytes: number; installed: boolean; files: ModelFile[]; workflows?: { id: string; label: string; installed: boolean; missingFiles: string[] }[] }[]; job: { kind: string; state: string; bytes: number; total: number; message?: string; currentFile?: string } | null };
type Directories = { revision: number; modelRoot: string | null; effectiveModelRoot: string; defaultModelRoot: string; layout: string };
type InitializationPlan = { revision: number; modelRoot: string; downloadBytes: number; additionalBytes: number; availableBytes: number; canDownload: boolean; errors: string[]; files: (ModelFile & { relative: string })[] };
const initialization = ref<InitializationPlan>();
const directoryChanged = computed(() => modelDirectory.value.trim() !== (directories.value?.modelRoot || ""));
const sizeLabel = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
const management = ref<ModelManagement>();
const directories = ref<Directories>();
const modelDirectory = ref("");
const installing = computed(() => management.value?.job?.state === "running");
async function refreshModels() { management.value = await request<ModelManagement>("/models"); }
async function loadDirectory() {
  directories.value = await request<Directories>("/models/settings");
  modelDirectory.value = directories.value.modelRoot || "";
}
async function loadModelService() {
  const requests = [refreshModels(), refreshStatus()];
  if (!directories.value) requests.push(loadDirectory());
  const results = await Promise.allSettled(requests);
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}
async function saveDirectory() {
  initialization.value = undefined;
  directories.value = await request<Directories>("/models/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelRoot: modelDirectory.value.trim() || null, layout: "categorized", expectedRevision: directories.value?.revision }) });
  await refreshModels();
}
async function previewInitialization() {
  initialization.value = undefined;
  initialization.value = await request<InitializationPlan>("/models/initialization");
}
async function initializeModels() {
  await request("/models/initialize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: initialization.value?.revision }) });
  initialization.value = undefined;
  await refreshModels();
}
async function install(route: string) { await request(route, { method: "POST" }); await refreshModels(); }

async function refreshStatus() {
  snapshot.value = await request("/status");
}
async function action(operation: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try { await operation(); }
  catch (cause) {
    if (!(cause instanceof MediaServiceChangedError)) error.value = userFacingError(cause);
  } finally { busy.value = false; }
}
async function connect(deviceId: string) {
  client.invalidate();
  serviceDeviceId.value = deviceId;
  management.value = undefined;
  directories.value = undefined;
  initialization.value = undefined;
  modelDirectory.value = "";
  snapshot.value = undefined;
  events?.close();
  const revision = client.selectionRevision();
  const update = (name: string) => {
    if (revision !== client.selectionRevision()) return;
    const refresh = name === "video.models" ? refreshModels : name === "video.changed" ? refreshStatus : undefined;
    void refresh?.().catch(cause => {
      if (!(cause instanceof MediaServiceChangedError)) error.value = userFacingError(cause);
    });
  };
  events = managerEventSource(deviceId ? peerManagerPath(deviceId, "/api/video/compute/events") : "/api/events");
  if (deviceId) {
    events.addEventListener("compute", event => {
      try { update(JSON.parse((event as MessageEvent).data).name); }
      catch { /* Ignore malformed notifications. */ }
    });
  } else {
    events.addEventListener("plugin_event", event => {
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        const value = payload.data?.instanceId ? payload.data : payload;
        if (value.instanceId === "manager:video") update(value.name);
      } catch { /* Ignore malformed notifications. */ }
    });
  }
  await action(loadModelService);
}
async function setRuntime(online: boolean) {
  await request(online ? "/runtime/start" : "/runtime/stop", { method: "POST" });
  await refreshStatus();
}
onMounted(() => connect(typeof route.query.deviceId === "string" ? route.query.deviceId : ""));
onBeforeUnmount(() => { client.invalidate(); events?.close(); });
</script>

<template>
  <v-card class="app-card glass-card pa-4">
    <div class="model-service-heading mb-3">
      <div>
        <h2 class="section-title">图像与视频模型</h2>
        <p class="section-note mt-1">安装模型并管理生成服务。</p>
      </div>
      <PeerServerSelect :model-value="serviceDeviceId" :disabled="busy" @changed="connect" />
    </div>
    <v-alert v-if="error || snapshot?.computeError" type="error" variant="tonal" density="compact" class="mb-3">
      {{ error || snapshot?.computeError }}
    </v-alert>
    <v-progress-linear v-if="busy && !snapshot" indeterminate />
    <div v-if="snapshot && !snapshot.computeError" class="model-service-heading mb-4">
      <div>
        <strong>视频生成服务</strong>
        <p class="section-note">{{ snapshot.online ? '服务已就绪' : '服务未启动' }}</p>
      </div>
      <v-btn :loading="busy" :disabled="installing" variant="tonal" @click="action(() => setRuntime(!snapshot?.online))">
        {{ snapshot.online ? '停止服务' : '启动服务' }}
      </v-btn>
    </div>
    <div v-if="directories" class="model-service-settings">
    <v-text-field v-model="modelDirectory" label="模型主目录" :placeholder="directories?.defaultModelRoot" hint="视频使用 video/minimax-h3，图像使用 image/comfyui。留空使用程序默认目录。" persistent-hint :disabled="busy || installing || snapshot?.online" @update:model-value="initialization = undefined" />
    <p v-if="directories" class="section-note">当前目录：{{ directories.effectiveModelRoot }}</p>
    <p v-if="directories?.modelRoot && directories.layout === 'flat'" class="section-note">当前为旧版平铺目录；保存主目录后按图像、视频分类查找。已有文件不会移动。</p>
    <v-btn variant="outlined" :disabled="busy || installing || snapshot?.online || !directories" @click="action(saveDirectory)">保存目录</v-btn>
    <v-btn class="ml-2" color="primary" :disabled="busy || installing || snapshot?.online || !directories || directoryChanged" @click="action(previewInitialization)">初始化服务器环境所需模型</v-btn>
    <p v-if="directoryChanged" class="section-note">请先保存模型主目录。</p>
    <v-card v-if="initialization" variant="outlined" class="mt-4 pa-3" aria-label="模型初始化空间确认">
      <p>下载目录：{{ initialization.modelRoot }}</p>
      <p>需要下载：{{ sizeLabel(initialization.downloadBytes) }} · 新增占用：{{ sizeLabel(initialization.additionalBytes) }} · 磁盘剩余：{{ sizeLabel(initialization.availableBytes) }}</p>
      <p class="section-note">只下载当前媒体服务清单中的缺失权重，共用文件只下载一次；不改动已有 TTS / ASR 配置。</p>
      <v-alert v-for="message in initialization.errors" :key="message" type="error" variant="tonal" class="my-2">{{ message }}</v-alert>
      <ul><li v-for="file in initialization.files.filter(file => !file.installed)" :key="file.relative">{{ file.relative }} · {{ sizeLabel(file.bytes) }} · {{ file.state === 'invalid' ? '文件损坏或大小不符' : '缺失' }}</li></ul>
      <p v-if="!initialization.downloadBytes">所需模型已齐全，无需下载。</p>
      <v-btn v-if="initialization.downloadBytes" color="primary" :disabled="busy || installing || snapshot?.online || !initialization.canDownload" @click="action(initializeModels)">开始下载</v-btn>
    </v-card>
    <v-divider class="my-5" />
    <div class="model-service-heading my-2"><strong>媒体运行环境</strong><v-btn :disabled="busy || installing || snapshot?.online || management?.runtimeInstalled" @click="action(() => install('/models/runtime'))">{{ management?.runtimeInstalled ? '已安装' : '安装运行环境' }}</v-btn></div>
    <p class="section-note">需要 NVIDIA CUDA 显卡。首次安装会下载 Python、ComfyUI 和推理依赖。</p>
    <div v-for="item in management?.models || []" :key="item.id" class="model-service-heading my-2"><div><strong>{{ item.label }}</strong><p>{{ sizeLabel(item.bytes) }} · {{ item.installed ? '已下载' : '部分依赖缺失' }}</p><p v-for="workflow in item.workflows || []" :key="workflow.id">{{ workflow.label }}：{{ workflow.installed ? '依赖齐全' : `缺少 ${workflow.missingFiles.join('、')}` }}</p><p v-for="file in item.files.filter(file => !file.installed)" :key="file.name" class="text-error">{{ file.state === 'invalid' ? '文件损坏或大小不符' : '缺失' }}：{{ file.name }}</p></div><v-btn :disabled="busy || installing || snapshot?.online || item.installed || directoryChanged" @click="action(() => install(`/models/${item.id}/download`))">{{ item.installed ? '已下载' : '下载模型' }}</v-btn></div>
    <v-progress-linear v-if="installing" :model-value="management?.job?.total ? management.job.bytes / management.job.total * 100 : 0" :indeterminate="!management?.job?.total" color="primary" />
    <p v-if="management?.job" role="status">{{ management.job.state === 'running' ? '正在安装，请保持程序运行' : management.job.state === 'completed' ? '安装完成' : management.job.message }}</p>
    <p v-if="installing && management?.job?.currentFile" role="status">{{ management.job.currentFile }} · {{ sizeLabel(management.job.bytes) }} / {{ sizeLabel(management.job.total) }}</p>
    <p v-if="snapshot?.online" class="section-note">停止视频服务后可以修改目录或安装。</p>
    </div>
    <v-btn class="mt-3" prepend-icon="mdi-refresh" variant="text" :disabled="busy" @click="action(loadModelService)">刷新状态</v-btn>
  </v-card>
</template>

<style scoped>
.model-service-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.model-service-settings ul { padding-inline-start: 22px; }
</style>
