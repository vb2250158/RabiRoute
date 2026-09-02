<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { DesktopPetBinding } from "@shared/desktopSettingsContract";
import { desktopPetClient, type DesktopPetPackSummary } from "../desktopPetClient";
import { registerPageSaveAction } from "../pageSaveAction";
import { useGatewayStore } from "../stores/gatewayStore";

const props = defineProps<{ personaId: string }>();
const store = useGatewayStore();
const binding = ref<DesktopPetBinding | null>(null);
const packs = ref<DesktopPetPackSummary[]>([]);
const loaded = ref(false);
const hydrating = ref(false);
const petDirty = ref(false);
const saving = ref(false);
const error = ref("");
const importFile = ref<File | null>(null);
const importPackId = ref("");
const importName = ref("");
const importing = ref(false);
const dirty = computed(() => store.dirty || petDirty.value);
const ready = computed(() => !petDirty.value || loaded.value);
const selectedPack = computed(() => packs.value.find(pack => pack.id === binding.value?.packId));
let loadRevision = 0;
let unregisterSaveAction: (() => void) | undefined;

function selectedImportFile(): File | null {
  const value = importFile.value as File | File[] | null;
  return Array.isArray(value) ? value[0] || null : value;
}

async function load(): Promise<void> {
  const personaId = props.personaId.trim();
  const revision = ++loadRevision;
  binding.value = null;
  packs.value = [];
  loaded.value = false;
  petDirty.value = false;
  error.value = "";
  if (!personaId) return;

  hydrating.value = true;
  try {
    const [nextBinding, catalog] = await Promise.all([
      desktopPetClient.binding(personaId),
      desktopPetClient.packs(personaId)
    ]);
    if (revision !== loadRevision) return;
    binding.value = nextBinding;
    packs.value = catalog.packs;
    error.value = catalog.diagnostics[0]?.message || "";
    loaded.value = true;
    await nextTick();
    petDirty.value = false;
  } catch (cause) {
    if (revision === loadRevision) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (revision === loadRevision) hydrating.value = false;
  }
}

async function importDesktopPetPack(): Promise<void> {
  const file = selectedImportFile();
  const packId = importPackId.value.trim();
  if (!file || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(packId)) {
    error.value = "请选择 GIF、PNG 或 ZIP，并填写只含字母、数字、点、横线、下划线的动作包 ID。";
    return;
  }
  importing.value = true;
  try {
    const pack = await desktopPetClient.importFile(props.personaId, file, {
      packId,
      state: "idle",
      name: importName.value.trim() || packId
    });
    packs.value = [...packs.value.filter(item => item.id !== pack.id), pack];
    if (binding.value) binding.value.packId = pack.id;
    importFile.value = null;
    importPackId.value = "";
    importName.value = "";
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    importing.value = false;
  }
}

async function save(): Promise<void> {
  if (!ready.value || saving.value) throw new Error("人格虚拟形象尚未加载完成。");
  saving.value = true;
  try {
    if (store.dirty) await store.save();
    if (petDirty.value && binding.value) {
      binding.value = await desktopPetClient.update(props.personaId, binding.value);
      petDirty.value = false;
      error.value = "";
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    throw cause;
  } finally {
    saving.value = false;
  }
}

watch(() => props.personaId, () => { void load(); }, { immediate: true });
watch(binding, () => {
  if (!hydrating.value && loaded.value) petDirty.value = true;
}, { deep: true });

unregisterSaveAction = registerPageSaveAction({ dirty, ready, saving, save });

onBeforeUnmount(() => {
  loadRevision += 1;
  unregisterSaveAction?.();
  unregisterSaveAction = undefined;
});
</script>

<template>
  <div class="virtual-avatar-layout">
    <v-card class="app-card glass-card section-card">
      <div class="section-title-row virtual-avatar-heading">
        <div>
          <div class="section-title">桌宠</div>
          <div class="section-note">
            动作素材保存在 <span data-no-i18n>{{ personaId }}</span> 人格目录；任务结束时只响应这个人格。
          </div>
        </div>
        <v-switch
          v-if="binding"
          v-model="binding.enabled"
          label="在本机启用"
          color="success"
          density="compact"
          inset
          hide-details
          :disabled="!loaded || !binding.packId"
        />
      </div>

      <v-alert v-if="error" type="warning" variant="tonal" density="compact" class="mb-4">{{ error }}</v-alert>
      <div v-if="!loaded && !error" class="virtual-avatar-loading" aria-live="polite">
        <v-progress-circular indeterminate color="secondary" size="24" />
        <span>正在读取虚拟形象…</span>
      </div>

      <template v-if="binding">
        <v-select
          v-model="binding.packId"
          label="动作素材"
          :items="packs"
          item-title="name"
          item-value="id"
          clearable
          no-data-text="当前人格还没有动作素材"
          :disabled="!loaded"
        />
        <div v-if="selectedPack" class="virtual-avatar-pack-summary mb-4">
          <v-icon size="20">mdi-animation-play-outline</v-icon>
          <span>{{ selectedPack.name }}</span>
          <small data-no-i18n>{{ selectedPack.id }}</small>
        </div>
        <v-alert v-else type="info" variant="tonal" density="compact" class="mb-4">
          先选择或导入动作素材，再开启桌宠。
        </v-alert>

        <div class="section-title small-title mb-2">导入动作素材</div>
        <div class="section-note mb-3">单个 GIF 或 PNG 会作为待机动作；ZIP 需要包含 pet-pack.json。</div>
        <div class="desktop-pet-import-grid">
          <v-file-input
            v-model="importFile"
            label="选择 GIF、PNG 或 ZIP"
            accept=".gif,.png,.zip,image/gif,image/png,application/zip"
            density="compact"
            hide-details
          />
          <v-text-field v-model="importPackId" label="动作包 ID" placeholder="library-default" density="compact" hide-details />
          <v-text-field v-model="importName" label="显示名称" :placeholder="`${personaId} · 日常`" density="compact" hide-details />
          <v-btn
            color="secondary"
            variant="outlined"
            :loading="importing"
            :disabled="!importFile || !importPackId.trim()"
            @click="importDesktopPetPack"
          >导入并选用</v-btn>
        </div>
      </template>
    </v-card>

    <v-card class="app-card glass-card section-card">
      <div class="section-title-row">
        <div>
          <div class="section-title">本机显示方式</div>
          <div class="section-note">大小、位置和窗口行为只影响这台电脑，不随人格同步。</div>
        </div>
      </div>
      <div
        v-if="binding"
        class="virtual-avatar-display-controls"
        :class="{ 'virtual-avatar-controls-disabled': !binding.enabled }"
      >
        <div class="desktop-pet-slider-grid">
          <div>
            <div class="virtual-avatar-field-label">大小：{{ Math.round(binding.scale * 100) }}%</div>
            <v-slider v-model="binding.scale" :min="0.1" :max="2" :step="0.05" color="secondary" hide-details :disabled="!binding.enabled" />
          </div>
          <div>
            <div class="virtual-avatar-field-label">透明度：{{ Math.round(binding.opacity * 100) }}%</div>
            <v-slider v-model="binding.opacity" :min="0.2" :max="1" :step="0.05" color="secondary" hide-details :disabled="!binding.enabled" />
          </div>
        </div>
        <div class="desktop-pet-switch-grid">
          <v-switch v-model="binding.alwaysOnTop" label="总在最前" color="secondary" density="compact" hide-details :disabled="!binding.enabled" />
          <v-switch v-model="binding.clickThrough" label="鼠标点透" color="secondary" density="compact" hide-details :disabled="!binding.enabled" />
          <v-switch v-model="binding.locked" label="锁定位置" color="secondary" density="compact" hide-details :disabled="!binding.enabled" />
          <v-switch v-model="binding.hideOnFullscreen" label="全屏时隐藏" color="secondary" density="compact" hide-details :disabled="!binding.enabled" />
          <v-switch v-model="binding.bubbleEnabled" label="显示结果气泡" color="secondary" density="compact" hide-details :disabled="!binding.enabled" />
        </div>
        <div class="virtual-avatar-field-label mt-4 mb-2">动画帧率</div>
        <v-btn-toggle v-model="binding.fpsCap" color="secondary" density="compact" mandatory divided :disabled="!binding.enabled">
          <v-btn v-for="fps in [6, 12, 15, 24]" :key="fps" :value="fps">{{ fps }} FPS</v-btn>
        </v-btn-toggle>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.virtual-avatar-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(320px, .8fr);
  gap: 18px;
  align-items: start;
}

.virtual-avatar-heading {
  align-items: flex-start;
}

.virtual-avatar-heading :deep(.v-switch) {
  flex: 0 0 auto;
}

.virtual-avatar-loading,
.virtual-avatar-pack-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--rr-muted);
}

.virtual-avatar-pack-summary {
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--rr-border-soft);
  border-radius: var(--rr-card-radius, 8px);
  background: var(--rr-subtle);
}

.virtual-avatar-pack-summary span {
  color: var(--rr-heading);
  font-weight: 800;
}

.virtual-avatar-pack-summary small {
  margin-left: auto;
}

.desktop-pet-slider-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.virtual-avatar-display-controls {
  transition: opacity 160ms ease, filter 160ms ease;
}

.virtual-avatar-controls-disabled {
  opacity: .58;
  filter: grayscale(1);
}

.desktop-pet-switch-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 14px;
}

.desktop-pet-import-grid {
  display: grid;
  grid-template-columns: minmax(220px, 2fr) minmax(150px, 1fr) minmax(180px, 1fr) auto;
  gap: 10px;
  align-items: center;
}

.desktop-pet-import-grid :deep(.v-btn) {
  min-height: 44px;
}

.virtual-avatar-field-label {
  display: block;
  margin-bottom: 5px;
  color: var(--rr-muted);
  font-size: 12px;
  font-weight: 800;
}

@media (max-width: 1100px) {
  .virtual-avatar-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .desktop-pet-slider-grid,
  .desktop-pet-switch-grid,
  .desktop-pet-import-grid {
    grid-template-columns: 1fr;
  }
}
</style>
