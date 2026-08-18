<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  SpeechManagedModel,
  SpeechManagedModelCapability,
  SpeechModelManagementJob,
  SpeechModelManagementSnapshot
} from "@shared/speechModelManagement";
import { managerEventSource } from "../managerApi";
import { useI18n } from "../i18n";
import { speechModelManagementClient } from "../speech/speechModelManagementClient";

type CapabilityFilter = "all" | SpeechManagedModelCapability;

const { isEnglish } = useI18n();
const snapshot = ref<SpeechModelManagementSnapshot>();
const loading = ref(false);
const actionError = ref("");
const search = ref("");
const capability = ref<CapabilityFilter>("all");
let managerEvents: EventSource | null = null;
let loadVersion = 0;

const copy = computed(() => isEnglish.value ? {
  refresh: "Refresh",
  runtimeTitle: "Speech environment",
  runtimeCopy: "Installs the private Python dependencies and Windows speech host. It does not download any model weights.",
  environment: "Dependencies",
  host: "Windows host",
  installed: "Installed",
  missing: "Not installed",
  unsupported: "Windows only",
  installRuntime: "Install speech environment",
  reinstallRuntime: "Reinstall speech environment",
  installingRuntime: "Installing environment",
  modelLibrary: "Model library",
  modelCount: "models",
  search: "Search name, family, or alias",
  all: "All",
  tts: "Text to speech",
  asr: "Speech recognition",
  speaker: "Speaker recognition",
  sizeUnknown: "Size not measured",
  coreRuntime: "Works with the core environment",
  isolatedRuntime: "Needs an additional isolated runtime",
  notDownloaded: "Not downloaded",
  downloaded: "Weights downloaded",
  failed: "Last download failed",
  downloading: "Downloading",
  download: "Download weights",
  redownload: "Download again",
  prepareFirst: "Install the speech environment first",
  empty: "No models match the current filters.",
  source: "Official source",
  boundaryTitle: "Downloaded does not mean ready to run",
  boundaryCopy: "The page verifies that model files were downloaded. Qwen3, CosyVoice, GPT-SoVITS, IndexTTS, SenseVoice, and FireRed still need their own isolated runtime before RabiSpeech can load them. Licensed ONNX-VITS packages must be imported manually and are not offered as a public download.",
  currentTask: "Current task",
  lastTask: "Last task",
  jobRunning: "Running",
  jobCompleted: "Completed",
  jobFailed: "Failed"
} : {
  refresh: "刷新",
  runtimeTitle: "语音运行环境",
  runtimeCopy: "安装私有 Python 依赖和 Windows 语音宿主，不会顺带下载任何模型权重。",
  environment: "运行依赖",
  host: "Windows 宿主",
  installed: "已安装",
  missing: "未安装",
  unsupported: "仅支持 Windows",
  installRuntime: "安装语音运行环境",
  reinstallRuntime: "重新安装语音运行环境",
  installingRuntime: "正在安装运行环境",
  modelLibrary: "模型库",
  modelCount: "个模型",
  search: "搜索名称、系列或别名",
  all: "全部",
  tts: "语音合成",
  asr: "语音识别",
  speaker: "说话人识别",
  sizeUnknown: "尚未测量大小",
  coreRuntime: "核心环境可直接使用",
  isolatedRuntime: "还需要单独安装隔离运行环境",
  notDownloaded: "未下载",
  downloaded: "权重已下载",
  failed: "上次下载失败",
  downloading: "正在下载",
  download: "下载权重",
  redownload: "重新下载",
  prepareFirst: "请先安装语音运行环境",
  empty: "没有符合当前筛选条件的模型。",
  source: "官方来源",
  boundaryTitle: "权重下载完成，不等于模型已经可以运行",
  boundaryCopy: "此页面只确认模型文件已经下载。Qwen3、CosyVoice、GPT-SoVITS、IndexTTS、SenseVoice 和 FireRed 仍需各自的隔离运行环境，RabiSpeech 才能加载。需要授权的 ONNX-VITS 模型包只能手动导入，不提供公开下载。",
  currentTask: "当前任务",
  lastTask: "最近任务",
  jobRunning: "执行中",
  jobCompleted: "已完成",
  jobFailed: "失败"
});

const capabilityItems = computed(() => [
  { value: "all", label: copy.value.all, icon: "mdi-view-grid-outline" },
  { value: "tts", label: copy.value.tts, icon: "mdi-account-voice" },
  { value: "asr", label: copy.value.asr, icon: "mdi-waveform" },
  { value: "speaker", label: copy.value.speaker, icon: "mdi-account-search-outline" }
]);

const models = computed(() => snapshot.value?.models ?? []);
const filteredModels = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return models.value.filter(model => {
    if (capability.value !== "all" && model.capability !== capability.value) return false;
    if (!query) return true;
    return [model.name, model.family, model.alias, model.purposeZh, model.purposeEn]
      .some(value => value.toLocaleLowerCase().includes(query));
  });
});
const downloadedCount = computed(() => models.value.filter(model => model.downloaded).length);
const activeJob = computed(() => snapshot.value?.activeJob);
const displayedJob = computed(() => activeJob.value ?? snapshot.value?.lastJob);
const runtimeBusy = computed(() => activeJob.value?.kind === "runtime");

function capabilityLabel(value: SpeechManagedModelCapability): string {
  return value === "tts" ? copy.value.tts : value === "asr" ? copy.value.asr : copy.value.speaker;
}

function capabilityIcon(value: SpeechManagedModelCapability): string {
  return value === "tts" ? "mdi-account-voice" : value === "asr" ? "mdi-waveform" : "mdi-account-search-outline";
}

function capabilityColor(value: SpeechManagedModelCapability): string {
  return value === "tts" ? "primary" : value === "asr" ? "secondary" : "info";
}

function modelStatus(model: SpeechManagedModel): { label: string; color: string; icon: string } {
  if (model.status === "downloading") return { label: copy.value.downloading, color: "primary", icon: "mdi-progress-download" };
  if (model.status === "downloaded") return { label: copy.value.downloaded, color: "success", icon: "mdi-check-circle-outline" };
  if (model.status === "failed") return { label: copy.value.failed, color: "error", icon: "mdi-alert-circle-outline" };
  return { label: copy.value.notDownloaded, color: "grey", icon: "mdi-cloud-download-outline" };
}

function jobPresentation(job: SpeechModelManagementJob): { label: string; color: string; icon: string } {
  if (job.state === "running") return { label: copy.value.jobRunning, color: "primary", icon: "mdi-progress-clock" };
  if (job.state === "completed") return { label: copy.value.jobCompleted, color: "success", icon: "mdi-check-circle-outline" };
  return { label: copy.value.jobFailed, color: "error", icon: "mdi-alert-circle-outline" };
}

function jobMessage(job: SpeechModelManagementJob): string {
  if (job.state === "running") {
    if (job.kind === "runtime") return isEnglish.value ? "Installing the RabiSpeech environment." : "正在安装 RabiSpeech 语音运行环境。";
    return isEnglish.value ? `Downloading ${job.modelAlias}.` : `正在下载 ${job.modelAlias}。`;
  }
  if (job.state === "completed") {
    if (job.kind === "runtime") return isEnglish.value ? "The speech environment installation completed." : "语音运行环境安装完成。";
    return isEnglish.value ? `${job.modelAlias} download completed.` : `${job.modelAlias} 下载完成。`;
  }
  return isEnglish.value ? "The installation or download did not complete." : "安装或下载没有完成。";
}

function sizeLabel(model: SpeechManagedModel): string {
  return model.sizeGiB == null ? copy.value.sizeUnknown : `≈ ${model.sizeGiB.toFixed(2)} GiB`;
}

function runtimeLabel(model: SpeechManagedModel): string {
  return model.runtime === "core" ? copy.value.coreRuntime : copy.value.isolatedRuntime;
}

function purpose(model: SpeechManagedModel): string {
  return isEnglish.value ? model.purposeEn : model.purposeZh;
}

function modelActionLabel(model: SpeechManagedModel): string {
  if (model.status === "downloading") return copy.value.downloading;
  return model.downloaded ? copy.value.redownload : copy.value.download;
}

function modelActionDisabled(model: SpeechManagedModel): boolean {
  return !snapshot.value?.platformSupported
    || !snapshot.value?.dependenciesInstalled
    || Boolean(activeJob.value)
    || model.status === "downloading";
}

async function loadSnapshot(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  actionError.value = "";
  try {
    const next = await speechModelManagementClient.snapshot();
    if (version === loadVersion) snapshot.value = next;
  } catch (error) {
    if (version === loadVersion) actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

async function installRuntime(): Promise<void> {
  actionError.value = "";
  try {
    snapshot.value = await speechModelManagementClient.installRuntime();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

async function installModel(model: SpeechManagedModel): Promise<void> {
  actionError.value = "";
  try {
    snapshot.value = await speechModelManagementClient.installModel(model.alias);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

function connectEvents(): void {
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("ready", () => void loadSnapshot());
  managerEvents.addEventListener("speech_model_management_changed", () => void loadSnapshot());
}

onMounted(async () => {
  await loadSnapshot();
  connectEvents();
});

onBeforeUnmount(() => managerEvents?.close());
</script>

<template>
  <div class="page-shell model-management-page">
    <v-alert v-if="actionError" type="error" variant="tonal" closable @click:close="actionError = ''">
      {{ actionError }}
    </v-alert>

    <section class="runtime-grid">
      <v-card class="runtime-card app-card glass-card" variant="flat">
        <v-card-text>
          <div class="section-heading">
            <div>
              <div class="section-kicker">01 / RUNTIME</div>
              <h2>{{ copy.runtimeTitle }}</h2>
              <p>{{ copy.runtimeCopy }}</p>
            </div>
            <v-btn icon="mdi-refresh" variant="text" :loading="loading" :aria-label="copy.refresh" @click="loadSnapshot" />
          </div>

          <div class="runtime-statuses">
            <div class="runtime-status">
              <v-icon :color="snapshot?.dependenciesInstalled ? 'success' : 'grey'">
                {{ snapshot?.dependenciesInstalled ? "mdi-check-decagram" : "mdi-circle-outline" }}
              </v-icon>
              <div><span>{{ copy.environment }}</span><b>{{ snapshot?.dependenciesInstalled ? copy.installed : copy.missing }}</b></div>
            </div>
            <div class="runtime-status">
              <v-icon :color="snapshot?.windowsHostInstalled ? 'success' : 'grey'">
                {{ snapshot?.windowsHostInstalled ? "mdi-check-decagram" : "mdi-circle-outline" }}
              </v-icon>
              <div><span>{{ copy.host }}</span><b>{{ snapshot?.windowsHostInstalled ? copy.installed : copy.missing }}</b></div>
            </div>
          </div>

          <v-btn
            color="primary"
            prepend-icon="mdi-tools"
            :loading="runtimeBusy"
            :disabled="!snapshot?.platformSupported || Boolean(activeJob)"
            @click="installRuntime"
          >
            {{ !snapshot?.platformSupported
              ? copy.unsupported
              : runtimeBusy
                ? copy.installingRuntime
                : snapshot?.dependenciesInstalled && snapshot?.windowsHostInstalled
                  ? copy.reinstallRuntime
                  : copy.installRuntime }}
          </v-btn>
        </v-card-text>
      </v-card>

      <v-card v-if="displayedJob" class="job-card app-card" variant="flat">
        <v-card-text>
          <div class="section-kicker">02 / TASK</div>
          <div class="job-heading">
            <div>
              <span>{{ activeJob ? copy.currentTask : copy.lastTask }}</span>
              <h2>{{ displayedJob.kind === "model" ? displayedJob.modelAlias : copy.runtimeTitle }}</h2>
            </div>
            <v-chip
              :color="jobPresentation(displayedJob).color"
              variant="tonal"
              :prepend-icon="jobPresentation(displayedJob).icon"
            >
              {{ jobPresentation(displayedJob).label }}
            </v-chip>
          </div>
          <p>{{ jobMessage(displayedJob) }}</p>
          <v-progress-linear v-if="displayedJob.state === 'running'" indeterminate color="primary" rounded />
          <v-alert v-if="displayedJob.error" type="error" density="compact" variant="tonal" class="mt-3">
            {{ displayedJob.error }}
          </v-alert>
        </v-card-text>
      </v-card>

      <v-card v-else class="job-card job-card-idle app-card" variant="flat">
        <v-card-text>
          <div class="section-kicker">02 / TASK</div>
          <v-icon size="34" color="primary">mdi-download-circle-outline</v-icon>
          <h2>{{ isEnglish ? "Ready for an on-demand download" : "可以按需下载" }}</h2>
          <p>{{ isEnglish ? "Choose one model below. The Manager will keep its state updated without periodic polling." : "在下方选择一个模型。Manager 会通过事件更新任务状态，不会定时轮询。" }}</p>
        </v-card-text>
      </v-card>
    </section>

    <v-alert type="info" variant="tonal" class="boundary-alert" icon="mdi-information-slab-circle-outline">
      <div class="font-weight-bold mb-1">{{ copy.boundaryTitle }}</div>
      <div>{{ copy.boundaryCopy }}</div>
    </v-alert>

    <section class="library-section">
      <div class="library-header">
        <div>
          <div class="section-kicker">03 / CATALOG</div>
          <h2>{{ copy.modelLibrary }}</h2>
          <p>{{ downloadedCount }} / {{ models.length }} {{ copy.modelCount }}</p>
        </div>
        <v-text-field
          v-model="search"
          class="model-search"
          density="compact"
          variant="solo-filled"
          flat
          hide-details
          clearable
          prepend-inner-icon="mdi-magnify"
          :placeholder="copy.search"
        />
      </div>

      <div class="capability-filter" role="group" :aria-label="copy.modelLibrary">
        <v-btn
          v-for="item in capabilityItems"
          :key="item.value"
          :variant="capability === item.value ? 'flat' : 'text'"
          :color="capability === item.value ? 'primary' : undefined"
          :prepend-icon="item.icon"
          @click="capability = item.value as CapabilityFilter"
        >
          {{ item.label }}
        </v-btn>
      </div>

      <div v-if="filteredModels.length" class="model-grid">
        <article v-for="model in filteredModels" :key="model.alias" class="model-card app-card">
          <div class="model-card-topline">
            <v-chip :color="capabilityColor(model.capability)" size="small" variant="tonal" :prepend-icon="capabilityIcon(model.capability)">
              {{ capabilityLabel(model.capability) }}
            </v-chip>
            <v-chip :color="modelStatus(model).color" size="small" variant="text" :prepend-icon="modelStatus(model).icon">
              {{ modelStatus(model).label }}
            </v-chip>
          </div>
          <div class="model-title-block">
            <span>{{ model.family }}</span>
            <h3>{{ model.name }}</h3>
            <code>{{ model.alias }}</code>
          </div>
          <p class="model-purpose">{{ purpose(model) }}</p>
          <div class="model-meta">
            <div><v-icon size="16">mdi-harddisk</v-icon><span>{{ sizeLabel(model) }}</span></div>
            <div :class="{ 'isolated-runtime': model.runtime === 'isolated' }">
              <v-icon size="16">{{ model.runtime === "core" ? "mdi-check-network-outline" : "mdi-call-split" }}</v-icon>
              <span>{{ runtimeLabel(model) }}</span>
            </div>
          </div>
          <v-alert v-if="model.lastError" type="error" density="compact" variant="tonal" class="model-error">
            {{ model.lastError }}
          </v-alert>
          <div class="model-card-actions">
            <v-btn variant="text" size="small" append-icon="mdi-open-in-new" :href="model.sourceUrl" target="_blank" rel="noreferrer">
              {{ copy.source }}
            </v-btn>
            <v-tooltip :text="!snapshot?.dependenciesInstalled ? copy.prepareFirst : ''" location="top">
              <template #activator="{ props }">
                <span v-bind="props">
                  <v-btn
                    color="primary"
                    variant="tonal"
                    size="small"
                    prepend-icon="mdi-download"
                    :loading="model.status === 'downloading'"
                    :disabled="modelActionDisabled(model)"
                    @click="installModel(model)"
                  >
                    {{ modelActionLabel(model) }}
                  </v-btn>
                </span>
              </template>
            </v-tooltip>
          </div>
        </article>
      </div>
      <v-empty-state v-else icon="mdi-cube-off-outline" :title="copy.empty" />
    </section>
  </div>
</template>

<style scoped>
.model-management-page {
  --model-ink: #102033;
  --model-cyan: #19bfc1;
  --model-blue: #2463eb;
  gap: 20px;
}

.section-kicker { color: var(--model-cyan); font-size: 11px; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }

.runtime-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, .65fr); gap: 20px; }
.runtime-card, .job-card { min-height: 250px; }
.runtime-card :deep(.v-card-text), .job-card :deep(.v-card-text) { height: 100%; padding: 26px; }
.section-heading, .job-heading, .library-header { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
.section-heading h2, .job-heading h2, .library-header h2, .job-card-idle h2 { margin: 5px 0 6px; color: var(--model-ink); font-size: 24px; }
.section-heading p, .job-card p, .library-header p { margin: 0; color: #66758a; line-height: 1.65; }
.runtime-statuses { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 22px 0; }
.runtime-status { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid rgba(16,32,51,.1); border-radius: 7px; background: #f8fafc; }
.runtime-status div { display: grid; gap: 2px; }
.runtime-status span { color: #718096; font-size: 12px; }
.runtime-status b { color: var(--model-ink); font-size: 14px; }
.job-card { color: white; background: linear-gradient(145deg, #17375b, #102238) !important; }
.job-card h2, .job-card p { color: white; }
.job-card p { opacity: .72; margin: 18px 0; }
.job-card .section-kicker { color: #77e8e9; }
.job-card-idle :deep(.v-card-text) { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; }

.boundary-alert { border: 1px solid rgba(36,99,235,.15); }
.library-section { display: grid; gap: 16px; padding-top: 6px; }
.library-header { align-items: flex-end; }
.model-search { width: min(390px, 100%); flex: 0 1 390px; }
.capability-filter { display: flex; gap: 6px; overflow-x: auto; padding: 5px; border: 1px solid rgba(16,32,51,.08); border-radius: 8px; background: rgba(255,255,255,.7); }
.model-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.model-card { display: flex; flex-direction: column; min-width: 0; padding: 20px; background: rgba(255,255,255,.94); transition: transform .18s ease, box-shadow .18s ease; }
.model-card:hover { transform: translateY(-2px); box-shadow: 0 14px 34px rgba(15,23,42,.11) !important; }
.model-card-topline, .model-card-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.model-title-block { margin-top: 18px; }
.model-title-block > span { color: #758296; font-size: 12px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
.model-title-block h3 { margin: 5px 0 8px; color: var(--model-ink); font-size: 20px; line-height: 1.25; }
.model-title-block code { display: inline-block; max-width: 100%; overflow: hidden; color: #3a5872; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.model-purpose { min-height: 48px; margin: 18px 0; color: #5b6b7e; line-height: 1.55; }
.model-meta { display: grid; gap: 8px; margin-bottom: 18px; }
.model-meta > div { display: flex; align-items: center; gap: 8px; color: #536477; font-size: 12px; }
.model-meta .isolated-runtime { color: #a15313; }
.model-error { margin-bottom: 14px; overflow-wrap: anywhere; }
.model-card-actions { margin-top: auto; padding-top: 14px; border-top: 1px solid rgba(16,32,51,.08); }

@media (max-width: 1120px) {
  .model-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 820px) {
  .runtime-grid { grid-template-columns: 1fr; }
  .library-header { align-items: stretch; flex-direction: column; }
  .model-search { width: 100%; flex-basis: auto; }
}

@media (max-width: 640px) {
  .model-management-page { padding: 16px; }
  .runtime-statuses, .model-grid { grid-template-columns: 1fr; }
  .capability-filter { align-items: stretch; flex-direction: column; }
  .model-card-actions { align-items: stretch; flex-direction: column-reverse; }
  .model-card-actions :deep(.v-btn) { width: 100%; }
}
</style>
