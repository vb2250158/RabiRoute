<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { HomeAssistantDeploymentSnapshot } from "@shared/homeAssistantDeploymentContract";
import { homeAssistantDeploymentClient as client } from "../../homeAssistantDeploymentClient";
import { userFacingError } from "../../userFacingError";

const snapshot = ref<HomeAssistantDeploymentSnapshot>();
const emit = defineEmits<{ state: [value: HomeAssistantDeploymentSnapshot] }>();
watch(snapshot, value => { if (value) emit("state", value); });
const mode = ref<"external" | "docker">("external");
const containerName = ref("homeassistant");
const autoStart = ref(true);
const busy = ref(false);
const error = ref("");
const installationLabel = computed(() => ({ installed: "已安装", not_found: "未找到安装", unknown: "安装状态未知", external: "外部服务" })[snapshot.value?.installation || "unknown"]);
const dirty = computed(() => !snapshot.value || mode.value !== snapshot.value.config.mode || containerName.value.trim() !== snapshot.value.config.containerName || (mode.value === "docker" && autoStart.value !== snapshot.value.config.autoStart));

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
onMounted(async () => {
  await refresh();
  if (snapshot.value) {
    mode.value = snapshot.value.config.mode;
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
    <v-select v-model="mode" label="部署方式" :disabled="busy" :items="[{ title: '本机 Docker 容器', value: 'docker' }, { title: '外部服务 / 自行管理的虚拟机', value: 'external' }]" />
    <template v-if="mode === 'docker'">
      <v-text-field v-model="containerName" label="Home Assistant 容器名称" :disabled="busy" />
      <v-switch v-model="autoStart" label="启动 Rabi 时自动启动 Home Assistant" :disabled="busy" color="primary" hide-details />
    </template>
    <v-alert v-if="snapshot" :type="snapshot.state === 'ready' ? 'success' : 'info'" density="compact" variant="tonal">{{ snapshot.message }}</v-alert>
    <dl v-if="snapshot?.installation === 'installed'" class="deployment-paths">
      <dt>安装目录（Docker 引擎内）</dt><dd>{{ snapshot.installationPath }}</dd>
      <dt>镜像</dt><dd>{{ snapshot.image }}</dd>
      <dt>配置目录（/config）</dt><dd>{{ snapshot.configPath || '未挂载持久配置目录' }}</dd>
      <dt>访问地址</dt><dd>{{ snapshot.baseUrl }}</dd>
    </dl>
    <div class="deployment-actions">
      <v-btn variant="tonal" :disabled="busy || !dirty" @click="save">保存启动配置</v-btn>
      <v-btn variant="text" :disabled="busy" @click="refresh">重新检测</v-btn>
      <v-btn v-if="mode === 'docker'" color="primary" :loading="busy" :disabled="dirty || !snapshot?.canStart" @click="start">启动并检查</v-btn>
      <v-btn href="https://www.home-assistant.io/installation/" target="_blank" rel="noopener noreferrer" variant="text">安装 Home Assistant</v-btn>
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
