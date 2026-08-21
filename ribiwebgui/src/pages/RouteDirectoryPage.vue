<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { registerPageSaveAction } from "../pageSaveAction";

const routeDir = ref("");
const rolesDir = ref("");
const saving = ref(false);
const saved = ref(false);
const error = ref("");
const loaded = ref(false);
const dirty = ref(false);
const hydrating = ref(true);
let unregisterPageSaveAction: (() => void) | undefined;

async function load() {
  try {
    const res = await fetch("/manager-config");
    const data = await res.json();
    routeDir.value = data.routeDir ?? "";
    rolesDir.value = data.rolesDir ?? "";
    loaded.value = true;
    await nextTick();
  } catch (e) {
    error.value = String(e);
  } finally {
    hydrating.value = false;
  }
}

async function save(): Promise<void> {
  if (!loaded.value || saving.value) return;
  saving.value = true;
  hydrating.value = true;
  error.value = "";
  saved.value = false;
  try {
    const res = await fetch("/manager-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeDir: routeDir.value || undefined, rolesDir: rolesDir.value || undefined })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message || "保存失败");
    routeDir.value = data.routeDir ?? "";
    rolesDir.value = data.rolesDir ?? "";
    saved.value = true;
    await nextTick();
    dirty.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    saving.value = false;
    hydrating.value = false;
  }
}

watch([routeDir, rolesDir], () => {
  if (loaded.value && !hydrating.value) dirty.value = true;
});

onMounted(() => {
  unregisterPageSaveAction = registerPageSaveAction({ dirty, ready: loaded, saving, save });
  void load();
});
onBeforeUnmount(() => unregisterPageSaveAction?.());
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">航线与目录</h1>
        <div class="page-subtitle">全局目录设置，影响所有路由。</div>
      </div>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="saved" type="success" variant="tonal" class="mb-4">已保存，重启生效。</v-alert>

    <v-card class="app-card glass-card section-card">
      <div class="section-title-row">
        <div>
          <div class="section-title">目录配置</div>
          <div class="section-note">设置全局的路由数据目录和角色目录，空着则使用默认路径。修改后重启 Manager 生效。</div>
        </div>
      </div>
      <div class="form-grid">
        <v-text-field v-model="routeDir" label="路由数据目录" placeholder="data/route" />
        <v-text-field v-model="rolesDir" label="角色目录" placeholder="data/roles" />
      </div>
    </v-card>
  </div>
</template>
