<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type {
  SpeechManagedModel,
  SpeechManagedModelCapability,
  SpeechModelManagementJob,
  SpeechModelManagementSnapshot,
  SpeechModelDirectorySettings
} from "@shared/speechModelManagement";
import { managerEventSource } from "../managerApi";
import { useI18n } from "../i18n/index";
import ModelLibraryTable from "../components/ModelLibraryTable.vue";
import ApiModelServices from "../components/ApiModelServices.vue";
import { speechLibraryAbilities } from "../components/modelLibraryPresentation";
import { speechModelManagementClient, SpeechModelManagementRequestError } from "../../../src/plugins/io.rabiroute.manager.speech/web/speech/speechModelManagementClient";

const WorkbenchModels = defineAsyncComponent(() => import("../../../src/plugins/io.rabiroute.manager.video/web/pages/WorkbenchModelService.vue"));
const SpeechDiagnostics = defineAsyncComponent(() => import("../../../src/plugins/io.rabiroute.manager.speech/web/pages/SpeechServicePage.vue"));

const { isEnglish } = useI18n();
const route = useRoute();
const router = useRouter();
const settings = computed(() => route.query.settings === "1");
const speechDiagnosticsOpen = computed(() => route.query.section === "speech-diagnostics");
function setSpeechDiagnostics(open: boolean) {
  void router.replace({ query: { ...route.query, section: open ? "speech-diagnostics" : undefined } });
}
type CapabilityFilter = SpeechManagedModelCapability | "image" | "video" | "llm" | "search";
const capability = computed<CapabilityFilter>(() => {
  const tab = route.query.tab;
  if (tab === "workbench") return "video";
  return tab === "asr" || tab === "speaker" || tab === "image" || tab === "video" || tab === "llm" || tab === "search" ? tab : "tts";
});
const mediaKind = computed(() => capability.value === "image" || capability.value === "video" ? capability.value : undefined);
function selectCapability(tab: CapabilityFilter) {
  void router.replace({ query: { ...route.query, tab } });
}
function openSettings(open: boolean) {
  const location = { query: { ...route.query, settings: open ? "1" : undefined, section: undefined } };
  if (open) void router.push(location);
  else void router.replace(location);
}
const snapshot = ref<SpeechModelManagementSnapshot>();
const loading = ref(false);
const actionError = ref("");
const search = ref("");
const directorySettings = ref<SpeechModelDirectorySettings>();
const directoryDraft = ref("");
const directoryLoading = ref(false);
const directorySaving = ref(false);
const directoryLocalOnly = ref(false);
const directoryError = ref("");
const directorySaved = ref(false);
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
  model: "Model",
  capability: "Model capabilities",
  size: "Size",
  runtime: "Runtime",
  action: "Action",
  close: "Close",
  search: "Search name, family, or alias",
  tts: "Text to speech",
  asr: "Speech recognition",
  speaker: "Speaker recognition",
  sizeUnknown: "Size not measured",
  coreRuntime: "Uses the core environment",
  isolatedRuntime: "Requires an isolated environment",
  downloading: "Downloading",
  download: "Download model",
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
  model: "模型",
  capability: "模型能力",
  size: "大小",
  runtime: "运行环境",
  action: "操作",
  close: "关闭",
  search: "搜索名称、系列或别名",
  tts: "语音合成",
  asr: "语音识别",
  speaker: "说话人识别",
  sizeUnknown: "尚未测量大小",
  coreRuntime: "使用核心环境",
  isolatedRuntime: "需独立环境",
  downloading: "正在下载",
  download: "下载模型",
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

const capabilityItems = computed<{ value: CapabilityFilter; label: string; icon: string }[]>(() => [
  { value: "llm", label: isEnglish.value ? "Language models" : "大语言模型", icon: "mdi-chat-processing-outline" },
  { value: "tts", label: copy.value.tts, icon: "mdi-account-voice" },
  { value: "asr", label: copy.value.asr, icon: "mdi-waveform" },
  { value: "speaker", label: copy.value.speaker, icon: "mdi-account-search-outline" },
  { value: "image", label: isEnglish.value ? "Image generation" : "图片生成模型", icon: "mdi-image-outline" },
  { value: "video", label: isEnglish.value ? "Video generation" : "视频生成模型", icon: "mdi-video-outline" },
  { value: "search", label: isEnglish.value ? "Web search" : "联网搜索", icon: "mdi-web" }
]);
const settingsLabel = computed(() => isEnglish.value ? "Model service settings" : "模型服务设置");

const models = computed(() => (snapshot.value?.models ?? []).filter(model => model.capability === capability.value));
const speechRows = computed(() => {
  const query = (search.value ?? "").trim().toLocaleLowerCase();
  return models.value.flatMap(model => {
    const abilities = speechLibraryAbilities(model, capabilityLabel(model.capability), capabilityIcon(model.capability), isEnglish.value);
    if (query && ![model.name, model.family, model.alias, model.purposeZh, model.purposeEn, ...abilities.map(item => item.label)]
      .some(value => value.toLocaleLowerCase().includes(query))) return [];
    return [{ model, id: model.alias, name: model.name, family: model.family, size: sizeLabel(model), runtime: runtimeLabel(model),
      runtimeIcon: model.runtime === "core" ? "mdi-layers-outline" : "mdi-call-split", sourceUrl: model.sourceUrl, abilities, error: model.lastError }];
  });
});
const activeJob = computed(() => snapshot.value?.activeJob);
const displayedJob = computed(() => activeJob.value ?? snapshot.value?.lastJob);
const runtimeBusy = computed(() => activeJob.value?.kind === "runtime");

const directoryCopy = computed(() => isEnglish.value ? {
  title: "Model directory", label: "Model root (blank uses environment or default)",
  effective: "Effective directory", default: "Platform default", save: "Save directory",
  note: "Saving changes future downloads and file detection only; existing models are not moved. Blank removes the override: environment configuration takes precedence over the platform default.",
  localOnly: "Model directory settings are available on this computer only.", saved: "Directory saved.",
  configured: "Configured", environment: "Environment", fallback: "Default"
} : {
  title: "模型目录", label: "模型总目录（留空使用环境配置或默认值）",
  effective: "当前生效目录", default: "平台默认目录", save: "保存目录",
  note: "保存只改变后续下载和文件检测的位置，不会搬动已有模型。留空移除覆盖值：优先使用环境配置，否则使用平台默认目录。",
  localOnly: "模型目录仅可在本机设置。", saved: "目录已保存。",
  configured: "自定义", environment: "环境配置", fallback: "默认"
});
const directorySource = computed(() => directorySettings.value?.source === "configured" ? directoryCopy.value.configured
  : directorySettings.value?.source === "environment" ? directoryCopy.value.environment : directoryCopy.value.fallback);

async function loadDirectorySettings(): Promise<void> {
  if (directoryLoading.value || directorySaving.value) return;
  directoryLoading.value = true;
  directoryError.value = "";
  try {
    directorySettings.value = await speechModelManagementClient.directorySettings();
    directoryDraft.value = directorySettings.value.configuredModelRoot ?? "";
    directoryLocalOnly.value = false;
  } catch (error) {
    directorySettings.value = undefined;
    directoryLocalOnly.value = error instanceof SpeechModelManagementRequestError && error.status === 403;
    if (!directoryLocalOnly.value) directoryError.value = userFacingError(error);
  } finally {
    directoryLoading.value = false;
  }
}

async function saveDirectorySettings(): Promise<void> {
  if (!directorySettings.value || directorySaving.value || activeJob.value) return;
  directorySaving.value = true;
  directorySaved.value = false;
  directoryError.value = "";
  try {
    directorySettings.value = await speechModelManagementClient.updateDirectorySettings({
      modelRoot: (directoryDraft.value ?? "").trim() || null,
      expectedRevision: directorySettings.value.revision
    });
    directoryDraft.value = directorySettings.value.configuredModelRoot ?? "";
    directorySaved.value = true;
    await loadSnapshot();
  } catch (error) {
    if (error instanceof SpeechModelManagementRequestError && error.status === 403) {
      directoryLocalOnly.value = true;
      directorySettings.value = undefined;
      directoryDraft.value = "";
    } else {
      directoryError.value = userFacingError(error);
    }
  } finally {
    directorySaving.value = false;
  }
}

function capabilityLabel(value: SpeechManagedModelCapability): string {
  return value === "tts" ? copy.value.tts : value === "asr" ? copy.value.asr : copy.value.speaker;
}

function capabilityIcon(value: SpeechManagedModelCapability): string {
  return value === "tts" ? "mdi-account-voice" : value === "asr" ? "mdi-waveform" : "mdi-account-search-outline";
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
    if (version === loadVersion) actionError.value = userFacingError(error);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

async function installRuntime(): Promise<void> {
  actionError.value = "";
  try {
    snapshot.value = await speechModelManagementClient.installRuntime();
  } catch (error) {
    actionError.value = userFacingError(error);
  }
}

async function installModel(model: SpeechManagedModel): Promise<void> {
  actionError.value = "";
  try {
    snapshot.value = await speechModelManagementClient.installModel(model.alias);
  } catch (error) {
    actionError.value = userFacingError(error);
  }
}

function connectEvents(): void {
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("ready", () => void loadSnapshot());
  managerEvents.addEventListener("speech_model_management_changed", () => void loadSnapshot());
}

onMounted(async () => {
  void loadDirectorySettings();
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

    <div v-if="settings" class="settings-header">
      <v-btn variant="text" prepend-icon="mdi-arrow-left" @click="openSettings(false)">{{ copy.modelLibrary }}</v-btn>
      <h2>{{ settingsLabel }}</h2>
    </div>
    <template v-if="settings">
    <section class="environment-bar" :aria-label="copy.runtimeTitle" :aria-busy="loading">
      <strong>{{ copy.runtimeTitle }}</strong>
      <div class="runtime-statuses">
        <span class="runtime-status">
          <v-icon size="18" :color="snapshot?.dependenciesInstalled ? 'success' : undefined">
            {{ snapshot?.dependenciesInstalled ? "mdi-check-circle-outline" : "mdi-circle-outline" }}
          </v-icon>
          {{ copy.environment }}: {{ snapshot ? (snapshot.dependenciesInstalled ? copy.installed : copy.missing) : '—' }}
        </span>
        <span class="runtime-status">
          <v-icon size="18" :color="snapshot?.windowsHostInstalled ? 'success' : undefined">
            {{ snapshot?.windowsHostInstalled ? "mdi-check-circle-outline" : "mdi-circle-outline" }}
          </v-icon>
          {{ copy.host }}: {{ snapshot ? (snapshot.windowsHostInstalled ? copy.installed : copy.missing) : '—' }}
        </span>
      </div>
      <div class="environment-actions">
        <v-btn
          color="primary"
          variant="tonal"
          prepend-icon="mdi-tools"
          :loading="runtimeBusy"
          :disabled="!snapshot?.platformSupported || Boolean(activeJob)"
          @click="installRuntime"
        >
          {{ !snapshot ? copy.runtimeTitle : !snapshot.platformSupported
            ? copy.unsupported
            : runtimeBusy
              ? copy.installingRuntime
              : snapshot.dependenciesInstalled && snapshot.windowsHostInstalled
                ? copy.reinstallRuntime
                : copy.installRuntime }}
        </v-btn>
        <v-btn icon="mdi-refresh" variant="text" :loading="loading" :aria-label="copy.refresh" @click="loadSnapshot" />
      </div>
    </section>

    </template>
    <section v-if="displayedJob && (settings || (!mediaKind && activeJob?.kind === 'model'))" class="job-row" role="status" aria-live="polite" aria-atomic="true">
      <span>{{ activeJob ? copy.currentTask : copy.lastTask }}</span>
      <v-chip size="small" :color="jobPresentation(displayedJob).color" variant="tonal" :prepend-icon="jobPresentation(displayedJob).icon">
        {{ jobPresentation(displayedJob).label }}
      </v-chip>
      <span class="job-message">{{ jobMessage(displayedJob) }}</span>
      <v-progress-linear v-if="displayedJob.state === 'running'" class="job-progress" indeterminate color="primary" :aria-label="copy.jobRunning" />
      <v-alert v-if="displayedJob.error" class="job-error" type="error" density="compact" variant="tonal">
        {{ displayedJob.error }}
      </v-alert>
    </section>

    <template v-if="settings">
    <details class="model-help directory-settings">
      <summary>{{ directoryCopy.title }}</summary>
      <p v-if="directoryLocalOnly">{{ directoryCopy.localOnly }}</p>
      <template v-else>
        <v-alert v-if="directoryError" type="error" density="compact" variant="tonal">{{ directoryError }}</v-alert>
        <div v-if="directorySettings" class="directory-editor">
          <p class="directory-path">{{ directoryCopy.effective }} ({{ directorySource }}): <code>{{ directorySettings.effectiveModelRoot }}</code></p>
          <p class="directory-path">{{ directoryCopy.default }}: <code>{{ directorySettings.defaultModelRoot }}</code></p>
          <form class="directory-form" @submit.prevent="saveDirectorySettings">
            <v-text-field v-model="directoryDraft" :label="directoryCopy.label" variant="outlined" density="compact" hide-details clearable :disabled="directorySaving || Boolean(activeJob)" @update:model-value="directorySaved = false" />
            <v-btn type="submit" color="primary" variant="tonal" :loading="directorySaving" :disabled="directoryLoading || Boolean(activeJob)">{{ directoryCopy.save }}</v-btn>
          </form>
          <p>{{ directoryCopy.note }}</p>
          <p v-if="directorySaved" role="status">{{ directoryCopy.saved }}</p>
        </div>
        <v-btn variant="text" prepend-icon="mdi-refresh" :loading="directoryLoading" :disabled="directorySaving" @click="loadDirectorySettings">{{ copy.refresh }}</v-btn>
      </template>
    </details>

    <details class="model-help">
      <summary>{{ copy.boundaryTitle }}</summary>
      <p>{{ copy.runtimeCopy }}</p>
      <p>{{ copy.boundaryCopy }}</p>
    </details>
    </template>

    <section v-if="!settings" class="library-section">
      <div class="library-header">
        <div>
          <h2>{{ copy.modelLibrary }}</h2>
        </div>
      </div>

      <div class="capability-filter" role="group" :aria-label="copy.modelLibrary">
        <v-btn
          v-for="item in capabilityItems"
          :key="item.value"
          :variant="capability === item.value ? 'flat' : 'text'"
          :color="capability === item.value ? 'primary' : undefined"
          :prepend-icon="item.icon"
          :aria-pressed="capability === item.value"
          @click="selectCapability(item.value)"
        >
          {{ item.label }}
        </v-btn>
        <v-text-field
          v-model="search"
          class="model-search"
          density="compact"
          variant="plain"
          single-line
          hide-details
          clearable
          prepend-inner-icon="mdi-magnify"
          :placeholder="copy.search"
          :aria-label="copy.search"
        />
        <v-btn class="library-settings" icon="mdi-cog-outline" size="small" variant="text"
          :title="settingsLabel" :aria-label="settingsLabel" @click="openSettings(true)" />
      </div>

      <ApiModelServices :kind="capability" :search="search ?? ''" />
      <h3 v-if="capability !== 'llm' && capability !== 'search'" class="local-model-heading">{{ isEnglish ? "Local models" : "本地模型" }}</h3>
      <WorkbenchModels v-if="mediaKind" :kind="mediaKind" :labels="copy" :english="isEnglish" :search="search ?? ''" />
      <ModelLibraryTable v-else-if="capability !== 'llm' && capability !== 'search'" :rows="speechRows" :labels="copy" :loading="loading">
        <template #action="{ row: { model } }">
          <v-tooltip v-if="!model.downloaded" :text="!snapshot?.dependenciesInstalled ? copy.prepareFirst : ''" location="top">
            <template #activator="{ props }">
              <span v-bind="props">
                <v-btn color="primary" variant="tonal" size="small" prepend-icon="mdi-download"
                  :loading="model.status === 'downloading'" :disabled="modelActionDisabled(model)" @click="installModel(model)">
                  {{ model.status === 'downloading' ? copy.downloading : copy.download }}
                </v-btn>
              </span>
            </template>
          </v-tooltip>
        </template>
      </ModelLibraryTable>
    </section>
    <v-expansion-panels v-if="settings" :model-value="speechDiagnosticsOpen ? 'diagnostics' : undefined"
      @update:model-value="setSpeechDiagnostics($event === 'diagnostics')">
      <v-expansion-panel value="diagnostics">
        <v-expansion-panel-title>
          {{ isEnglish ? "Speech service diagnostics" : "语音服务诊断" }}
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <SpeechDiagnostics v-if="speechDiagnosticsOpen" />
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
    <WorkbenchModels v-if="settings" settings :labels="copy" :english="isEnglish" />
  </div>
</template>

<style scoped>
.model-management-page {
  --model-ink: var(--rr-heading);
  min-width: 0;
  gap: 12px;
  color: var(--rr-text);
}
.local-model-heading { margin: 0; font-size: 16px; }

.environment-bar, .job-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 8px 12px; border: 1px solid var(--rr-border); border-radius: 8px; background: var(--rr-surface); }
.environment-bar > strong { color: var(--model-ink); }
.runtime-statuses, .environment-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.environment-actions { margin-left: auto; gap: 8px; }
.runtime-status { display: inline-flex; align-items: center; gap: 6px; color: var(--rr-muted-soft); font-size: 13px; }
.job-row { color: var(--rr-muted-soft); font-size: 13px; }
.job-message { flex: 1 1 220px; overflow-wrap: anywhere; }
.job-progress, .job-error { flex-basis: 100%; min-width: 0; }
.job-error { overflow-wrap: anywhere; }
.model-help { color: var(--rr-muted-soft); font-size: 13px; }
.model-help summary { cursor: pointer; padding: 8px 0; }
.model-help p { margin: 4px 0 8px; line-height: 1.6; }
.model-help summary:focus-visible { outline: 2px solid var(--rr-accent); outline-offset: 2px; }
.directory-editor, .directory-path { min-width: 0; overflow-wrap: anywhere; }
.directory-form { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.directory-form :deep(.v-input) { flex: 1 1 280px; min-width: 0; }
.library-section { display: grid; min-width: 0; gap: 12px; }
.settings-header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.library-settings { flex: 0 0 auto; }
.library-header h2 { margin: 0; color: var(--model-ink); font-size: 20px; }
.model-search { flex: 1 1 200px; min-width: 120px; max-width: 390px; margin-inline-start: auto; padding-inline: 6px; }
.model-search :deep(.v-field) { --v-field-padding-top: 0px; --v-field-padding-bottom: 0px; }
.capability-filter { display: flex; align-items: center; gap: 6px; overflow-x: auto; padding: 5px; border: 1px solid var(--rr-border); border-radius: 8px; background: var(--rr-input); }
@media (max-width: 900px) {
  .capability-filter { flex-wrap: wrap; }
  .model-search { flex: 1 1 160px; margin-inline-start: 0; }
}
@media (max-width: 640px) {
  .model-management-page { padding: 16px; }
  .environment-actions { margin-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .model-row { transition: none; }
}
</style>
