<script setup lang="ts">
import { onMounted, ref } from "vue";
const directory = ref("");
const saved = ref("");
const busy = ref(true);
const error = ref("");
const notice = ref("");
async function load() {
  try {
    const response = await fetch("/api/resource-cache/settings");
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "读取失败");
    directory.value = saved.value = data.directory;
  } catch (value) { error.value = value instanceof Error ? value.message : String(value); }
  finally { busy.value = false; }
}
async function save() {
  busy.value = true; error.value = ""; notice.value = "";
  try {
    const response = await fetch("/api/resource-cache/settings", { method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ directory:directory.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "保存失败");
    directory.value = saved.value = data.directory;
    notice.value = "已保存，目录可写";
  } catch (value) { error.value = value instanceof Error ? value.message : String(value); }
  finally { busy.value = false; }
}
onMounted(load);
</script>

<template>
  <v-card class="app-card glass-card section-card">
    <div class="section-title">资源缓存服务</div>
    <div class="section-note mb-4">保存手机上传的录音、录像等资源。是否启用和本地保留时长在手机设置。</div>
    <v-text-field v-model="directory" label="电脑缓存路径" :disabled="busy" density="compact" hide-details="auto" />
    <div class="section-note my-3">修改后新资源写入新目录，旧资源继续从原目录读取。请保留原目录中的文件。</div>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" density="compact" class="mb-3">{{ notice }}</v-alert>
    <v-btn color="primary" variant="tonal" :loading="busy" :disabled="busy || directory === saved || !directory.trim()" @click="save">保存路径</v-btn>
  </v-card>
</template>
