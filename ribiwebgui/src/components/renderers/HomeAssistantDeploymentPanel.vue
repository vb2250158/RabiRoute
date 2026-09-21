<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { HomeAssistantDeploymentConfig, HomeAssistantDeploymentSnapshot } from "@shared/homeAssistantDeploymentContract";
import { homeAssistantDeploymentClient as client } from "../../homeAssistantDeploymentClient";
import { userFacingError } from "../../userFacingError";

const snapshot = ref<HomeAssistantDeploymentSnapshot>();
const emit = defineEmits<{ state: [value: HomeAssistantDeploymentSnapshot] }>();
watch(snapshot, value => { if (value) emit("state", value); });
const mode = ref<HomeAssistantDeploymentConfig["mode"]>("haos");
const containerName = ref("homeassistant");
const autoStart = ref(true);
const busy = ref(false);
const installing = ref(false);
const error = ref("");
const installationLabel = computed(() => ({ installed: "已安装", not_found: "未找到安装", unknown: "安装状态未知", external: "外部服务" })[snapshot.value?.installation || "unknown"]);
const dirty = computed(() => !snapshot.value || mode.value !== snapshot.value.config.mode || containerName.value.trim() !== snapshot.value.config.containerName || (mode.value !== "external" && autoStart.value !== snapshot.value.config.autoStart));

async function refresh() {
  busy.value = true;
  try {
    snapshot.value = await client.read();
    error.value = "";
  } catch (cause) { error.value = userFacingError(cause); }
  finally { busy.value = false; }
}
async function save() {
  if (!snapshot.value) return;
  busy.value = true;
  try {
    snapshot.value = await client.save({ mode: mode.value, containerName: containerName.value.trim(), autoStart: autoStart.value }, snapshot.value.revision);
    error.value = "";
  } catch (cause) { error.value = userFacingError(cause); }
  finally { busy.value = false; }
}
async function start() {
  if (!snapshot.value || dirty.value) return;
  busy.value = true;
  try {
    snapshot.value = await client.start(snapshot.value.revision);
    error.value = "";
  } catch (cause) { error.value = userFacingError(cause); }
  finally { busy.value = false; }
}
async function install() {
  if (!snapshot.value || busy.value) return;
  busy.value = true;
  installing.value = true;
  try {
    if (dirty.value) snapshot.value = await client.save({ mode: mode.value, containerName: containerName.value.trim(), autoStart: autoStart.value }, snapshot.value.revision);
    snapshot.value = await client.install(snapshot.value.revision);
    error.value = "";
  } catch (cause) { error.value = userFacingError(cause); }
  finally { installing.value = false; busy.value = false; }
}
onMounted(async () => {
  await refresh();
  if (snapshot.value) {
    mode.value = snapshot.value.config.mode;
    if (mode.value === "docker" && snapshot.value.installation === "not_found") mode.value = "haos";
    containerName.value = snapshot.value.config.containerName;
    autoStart.value = !snapshot.value.configured || snapshot.value.config.mode === "external" ? true : snapshot.value.config.autoStart;
  }
});
</script>

<template>
  <section class="deployment-panel">
    <div class="section-title-row">
      <div class="section-title small-title">Home Assistant 安装与启动</div>
      <v-chip size="small" :color="snapshot?.installation === 'installed' ? 'success' : 'info'">{{ installationLabel }}</v-chip>
    </div>
    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-select v-model="mode" label="部署方式" :disabled="busy" :items="[{ title: 'Home Assistant OS（Hyper-V，推荐）', value: 'haos' }, { title: '已有 Docker 容器', value: 'docker' }, { title: '外部服务 / 自行管理的虚拟机', value: 'external' }]" />
    <template v-if="mode === 'docker'">
      <v-text-field v-model="containerName" label="Home Assistant 容器名称" :disabled="busy" />
      <v-switch v-model="autoStart" label="启动 Rabi 时自动启动 Home Assistant" :disabled="busy" color="primary" hide-details />
    </template>
    <template v-if="mode === 'haos'">
      <v-text-field :model-value="snapshot?.haosInstallPath" label="预设安装路径" readonly hide-details />
      <v-switch v-model="autoStart" label="随 Windows 启动虚拟机" :disabled="busy" color="primary" hide-details />
      <div class="section-note">需要 Windows 专业版、企业版或教育版及至少 40 GiB 可用空间。安装时会请求管理员确认；需要重启时会暂停，重启后再次点击安装继续。</div>
      <div class="section-note">服务仅开放到本机 http://127.0.0.1:8123；虚拟机使用 2 核 CPU、2 GiB 内存。启动选项在安装或“启动并检查”时应用。</div>
    </template>
    <v-alert v-if="installing" type="info" density="compact" variant="tonal">正在安装，请确认 Windows 管理员提示。首次下载和初始化可能需要较长时间。</v-alert>
    <v-alert v-else-if="snapshot && mode === snapshot.config.mode" :type="snapshot.state === 'ready' ? 'success' : snapshot.state === 'error' ? 'error' : 'info'" density="compact" variant="tonal">{{ snapshot.message }}</v-alert>
    <dl v-if="snapshot && mode === snapshot.config.mode && (snapshot.installation === 'installed' || mode === 'haos')" class="deployment-paths">
      <dt>{{ mode === 'haos' ? '虚拟机安装目录' : '安装目录（Docker 引擎内）' }}</dt><dd>{{ snapshot.installationPath }}</dd>
      <template v-if="snapshot.image"><dt>镜像</dt><dd>{{ snapshot.image }}</dd></template>
      <template v-if="mode !== 'haos'"><dt>配置目录（/config）</dt><dd>{{ snapshot.configPath || '未挂载持久配置目录' }}</dd></template>
      <dt>访问地址</dt><dd>{{ snapshot.baseUrl }}</dd>
    </dl>
    <div class="deployment-actions">
      <v-btn variant="tonal" :disabled="busy || !dirty" @click="save">保存启动配置</v-btn>
      <v-btn variant="text" :disabled="busy" @click="refresh">重新检测</v-btn>
      <v-btn v-if="mode === 'haos'" color="primary" :loading="installing" :disabled="busy || !snapshot" @click="install">{{ snapshot?.state === 'reboot_required' ? '重启后继续安装' : '安装 Home Assistant OS' }}</v-btn>
      <v-btn v-if="mode !== 'external'" color="primary" :loading="busy && !installing" :disabled="busy || dirty || !snapshot?.canStart" @click="start">启动并检查</v-btn>
      <v-btn href="https://www.home-assistant.io/installation/windows" target="_blank" rel="noopener noreferrer" variant="text">查看安装文档</v-btn>
    </div>
    <div v-if="dirty" class="section-note">部署方式或启动配置尚未保存。</div>
  </section>
</template>

<style scoped>
.deployment-panel { display: grid; gap: 12px; margin-bottom: 20px; }
.deployment-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.deployment-paths { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; font-size: .875rem; }
.deployment-paths dd { margin: 0; overflow-wrap: anywhere; }
</style>
