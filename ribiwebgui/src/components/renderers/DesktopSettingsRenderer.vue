<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopTheme } from "@shared/desktopSettingsContract";
import { resolveSelectionSpeechModel, type SelectionSpeechSettings } from "@shared/selectionSpeechContract";
import type { SpeechModel } from "@shared/speechControlContract";
import { desktopSettingsClient } from "../../desktopSettingsClient";
import { publishInterfaceTheme } from "../../interfaceTheme";
import { registerPageSaveAction } from "../../pageSaveAction";
import { pluginCatalogStore } from "../../pluginCatalogStore";
import { speechControlClient } from "../../speech/speechControlClient";
import {
  readStoredWebThemePreference,
  resolveWebThemeResource,
  writeStoredWebThemePreference,
  type WebThemeId
} from "../../pluginThemes";

const desktopScreenshotEnabled = ref(false);
const desktopScreenshotShortcut = ref("Ctrl+Shift+S");
const desktopScreenshotShortcutCapturing = ref(false);
const desktopScreenshotClipboardShortcut = ref("F3");
const desktopScreenshotClipboardShortcutCapturing = ref(false);
const desktopScreenshotAutoCopy = ref(true);
const desktopAutostart = ref(false);
const desktopTheme = ref<WebThemeId>("system");
const persistedDesktopTheme = ref<DesktopTheme>("system");
const selectionSpeechEnabled = ref(false);
const selectionReadAloudEnabled = ref(true);
const selectionSpeechAdvanced = ref(false);
const selectionSpeechModel = ref("");
const selectionSpeechModels = ref<SpeechModel[]>([]);
const selectionSpeechLoaded = ref(false);
const selectionSpeechError = ref("");
const loaded = ref(false);
const hydrating = ref(true);
const saving = ref(false);
const desktopDirty = ref(false);
const selectionSpeechDirty = ref(false);
const dirty = computed(() => desktopDirty.value || selectionSpeechDirty.value);
const error = ref("");
const themeOptions = computed(() => pluginCatalogStore.themes.value.options);
const ready = computed(() => loaded.value && (!selectionSpeechDirty.value || selectionSpeechLoaded.value));
let unregisterSaveAction: (() => void) | undefined;

async function loadDesktopSettings(): Promise<void> {
  try {
    const settings = await desktopSettingsClient.read();
    desktopScreenshotEnabled.value = settings.screenshot.enabled;
    desktopScreenshotShortcut.value = settings.screenshot.shortcut;
    desktopScreenshotClipboardShortcut.value = settings.screenshot.clipboardShortcut;
    desktopScreenshotAutoCopy.value = settings.screenshot.autoCopy;
    desktopAutostart.value = settings.autostart;
    persistedDesktopTheme.value = settings.theme;
    const storedTheme = readStoredWebThemePreference();
    desktopTheme.value = themeOptions.value.some(option => option.themeId === storedTheme)
      ? storedTheme
      : resolveWebThemeResource(pluginCatalogStore.themes.value, settings.theme).themeId;
    loaded.value = true;
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function loadSelectionSpeechSettings(): Promise<void> {
  try {
    const [settings, modelPayload] = await Promise.all([
      speechControlClient.selectionReaderSettings(),
      speechControlClient.models()
    ]);
    selectionSpeechEnabled.value = settings.enabled;
    selectionReadAloudEnabled.value = settings.readAloudEnabled;
    selectionSpeechAdvanced.value = settings.advanced;
    selectionSpeechModel.value = settings.model;
    selectionSpeechModels.value = modelPayload.models || [];
    if (selectionSpeechAdvanced.value) {
      selectionSpeechModel.value = resolveSelectionSpeechModel(settings, selectionSpeechModels.value);
    }
    selectionSpeechLoaded.value = true;
    selectionSpeechError.value = "";
  } catch (cause) {
    selectionSpeechError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function load(): Promise<void> {
  hydrating.value = true;
  try {
    await Promise.all([loadDesktopSettings(), loadSelectionSpeechSettings()]);
    await nextTick();
    desktopDirty.value = false;
    selectionSpeechDirty.value = false;
  } finally {
    hydrating.value = false;
  }
}

async function saveDesktopSettings(): Promise<void> {
  const selectedTheme = resolveWebThemeResource(pluginCatalogStore.themes.value, desktopTheme.value);
  const nextDesktopTheme = selectedTheme.desktopTheme ?? persistedDesktopTheme.value;
  try {
    const settings = await desktopSettingsClient.update({
      screenshot: {
        enabled: desktopScreenshotEnabled.value,
        shortcut: desktopScreenshotShortcut.value,
        clipboardShortcut: desktopScreenshotClipboardShortcut.value,
        autoCopy: desktopScreenshotAutoCopy.value
      },
      autostart: desktopAutostart.value,
      theme: nextDesktopTheme
    });
    desktopScreenshotEnabled.value = settings.screenshot.enabled;
    desktopScreenshotShortcut.value = settings.screenshot.shortcut;
    desktopScreenshotClipboardShortcut.value = settings.screenshot.clipboardShortcut;
    desktopScreenshotAutoCopy.value = settings.screenshot.autoCopy;
    desktopAutostart.value = settings.autostart;
    persistedDesktopTheme.value = settings.theme;
    writeStoredWebThemePreference(selectedTheme.desktopTheme ? undefined : selectedTheme.themeId);
    desktopTheme.value = selectedTheme.themeId;
    publishInterfaceTheme(selectedTheme.themeId);
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    throw cause;
  }
}

async function saveSelectionSpeechSettings(): Promise<void> {
  const settings: SelectionSpeechSettings = {
    enabled: selectionSpeechEnabled.value,
    readAloudEnabled: selectionReadAloudEnabled.value,
    advanced: selectionSpeechAdvanced.value,
    model: selectionSpeechModel.value
  };
  try {
    const saved = await speechControlClient.updateSelectionReaderSettings(settings);
    selectionSpeechEnabled.value = saved.enabled;
    selectionReadAloudEnabled.value = saved.readAloudEnabled;
    selectionSpeechAdvanced.value = saved.advanced;
    selectionSpeechModel.value = saved.model;
    selectionSpeechError.value = "";
  } catch (cause) {
    selectionSpeechError.value = cause instanceof Error ? cause.message : String(cause);
    throw cause;
  }
}

async function save(): Promise<void> {
  if (!ready.value || saving.value) throw new Error("桌面设置尚未加载完成。");
  const tasks = [
    ...(desktopDirty.value ? [{ dirty: desktopDirty, run: saveDesktopSettings }] : []),
    ...(selectionSpeechDirty.value ? [{ dirty: selectionSpeechDirty, run: saveSelectionSpeechSettings }] : [])
  ];
  if (!tasks.length) return;

  saving.value = true;
  hydrating.value = true;
  try {
    const results = await Promise.allSettled(tasks.map(task => task.run()));
    const failures: string[] = [];
    results.forEach((result, index) => {
      const task = tasks[index];
      if (!task) return;
      if (result.status === "fulfilled") {
        task.dirty.value = false;
        return;
      }
      failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    });
    await nextTick();
    if (failures.length) throw new Error(failures.join("；"));
  } finally {
    hydrating.value = false;
    saving.value = false;
  }
}

function normalizeScreenshotShortcut(): void {
  desktopScreenshotShortcut.value = desktopScreenshotShortcut.value.trim().replace(/\s*\+\s*/g, "+");
}

function normalizeScreenshotClipboardShortcut(): void {
  desktopScreenshotClipboardShortcut.value = desktopScreenshotClipboardShortcut.value.trim().replace(/\s*\+\s*/g, "+");
}

function screenshotShortcutFromKeyEvent(event: KeyboardEvent): string | null {
  const key = event.key === " " ? "SPACE" : event.key.toUpperCase();
  const functionKey = /^(F[1-9]|F1[0-2])$/.test(key);
  const validKey = /^[A-Z0-9]$/.test(key) || functionKey || /^(SPACE|TAB|ENTER|ESCAPE)$/.test(key);
  if (!validKey) return null;
  const modifiers = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Win" : ""
  ].filter(Boolean);
  if (!modifiers.length && !functionKey) return null;
  return [...modifiers, key === "ESCAPE" ? "Esc" : key[0] + key.slice(1).toLowerCase()].join("+");
}

function captureShortcut(event: KeyboardEvent, target: "capture" | "clipboard"): void {
  const shortcut = screenshotShortcutFromKeyEvent(event);
  if (!shortcut) return;
  event.preventDefault();
  event.stopPropagation();
  if (target === "capture") {
    desktopScreenshotShortcut.value = shortcut;
    desktopScreenshotShortcutCapturing.value = false;
  } else {
    desktopScreenshotClipboardShortcut.value = shortcut;
    desktopScreenshotClipboardShortcutCapturing.value = false;
  }
}

watch([
  desktopScreenshotEnabled,
  desktopScreenshotShortcut,
  desktopScreenshotClipboardShortcut,
  desktopScreenshotAutoCopy,
  desktopAutostart,
  desktopTheme
], () => {
  if (!hydrating.value) desktopDirty.value = true;
});

watch([
  selectionSpeechEnabled,
  selectionReadAloudEnabled,
  selectionSpeechAdvanced,
  selectionSpeechModel
], () => {
  if (!hydrating.value && selectionSpeechLoaded.value) selectionSpeechDirty.value = true;
});

watch(themeOptions, options => {
  if (!loaded.value || options.some(option => option.themeId === desktopTheme.value)) return;
  desktopTheme.value = resolveWebThemeResource(pluginCatalogStore.themes.value, persistedDesktopTheme.value).themeId;
  writeStoredWebThemePreference(undefined);
  publishInterfaceTheme(desktopTheme.value);
});

onMounted(() => {
  unregisterSaveAction = registerPageSaveAction({ dirty, ready, saving, save });
  void load();
});

onBeforeUnmount(() => {
  unregisterSaveAction?.();
  unregisterSaveAction = undefined;
});
</script>

<template>
  <v-card class="app-card glass-card section-card">
    <div class="section-title-row">
      <div>
        <div class="section-title">RabiRoute 桌面功能</div>
        <div class="section-note">RabiRoute 在 Windows 中提供截图、系统划词、主题和登录启动设置。</div>
      </div>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <div class="section-title-row compact-row mb-2">
      <div>
        <div class="section-title small-title">界面主题</div>
        <div class="section-note">可信主题资源可以扩展 WebGUI；内置主题同时同步到桌面端。</div>
      </div>
      <v-btn-toggle v-model="desktopTheme" color="secondary" density="compact" mandatory divided :disabled="!loaded">
        <v-btn v-for="option in themeOptions" :key="option.webResourceId" :value="option.themeId" :prepend-icon="option.icon">
          {{ option.label }}
        </v-btn>
      </v-btn-toggle>
    </div>
    <v-divider class="my-4" />
    <div class="section-title-row compact-row mb-2">
      <div>
        <div class="section-title small-title">系统级截图</div>
        <div class="section-note">框选截图后可复制到剪贴板、贴到屏幕或发送给已激活人格；在截图窗口按 F2 发送，按 &lt; / &gt; 切换上一张和下一张。</div>
      </div>
      <v-switch v-model="desktopScreenshotEnabled" label="启用截图" color="success" density="compact" inset hide-details :disabled="!loaded" />
    </div>
    <v-text-field
      v-model="desktopScreenshotShortcut"
      label="截图快捷键"
      placeholder="Ctrl+Shift+S"
      :hint="desktopScreenshotShortcutCapturing ? '正在录入，按下要绑定的按键。' : '点击输入框后按下快捷键；可单独使用 F1-F12，或搭配 Ctrl、Alt、Shift、Win。'"
      persistent-hint density="compact" readonly
      :disabled="!loaded || !desktopScreenshotEnabled"
      @click="desktopScreenshotShortcutCapturing = true"
      @focus="desktopScreenshotShortcutCapturing = true"
      @keydown="captureShortcut($event, 'capture')"
      @blur="desktopScreenshotShortcutCapturing = false; normalizeScreenshotShortcut()"
    />
    <div class="section-title-row compact-row mb-2">
      <div>
        <div class="section-title small-title">自动复制选区</div>
        <div class="section-note">确认选区时自动复制到剪贴板；关闭后可按 Ctrl+C 或点击“复制”。</div>
      </div>
      <v-switch v-model="desktopScreenshotAutoCopy" label="自动复制" color="success" density="compact" inset hide-details :disabled="!loaded || !desktopScreenshotEnabled" />
    </div>
    <v-text-field
      v-model="desktopScreenshotClipboardShortcut"
      label="贴图快捷键"
      placeholder="F3"
      :hint="desktopScreenshotClipboardShortcutCapturing ? '正在录入，按下要绑定的按键。' : '截图窗口打开时，直接贴出框选区域；其他时候贴出剪贴板图片。默认 F3；可单独使用 F1-F12，或搭配 Ctrl、Alt、Shift、Win。'"
      persistent-hint density="compact" readonly
      :disabled="!loaded || !desktopScreenshotEnabled"
      @click="desktopScreenshotClipboardShortcutCapturing = true"
      @focus="desktopScreenshotClipboardShortcutCapturing = true"
      @keydown="captureShortcut($event, 'clipboard')"
      @blur="desktopScreenshotClipboardShortcutCapturing = false; normalizeScreenshotClipboardShortcut()"
    />
    <v-divider class="my-4" />
    <div class="section-title-row compact-row mb-2">
      <div>
        <div class="section-title small-title">滑词菜单</div>
        <div class="section-note">划选文字后显示“朗读”和“投递至”；划选本身不执行动作。</div>
      </div>
      <v-switch v-model="selectionSpeechEnabled" label="开启滑词菜单" color="success" density="compact" inset hide-details :disabled="!selectionSpeechLoaded" />
    </div>
    <v-alert v-if="selectionSpeechError" type="error" variant="tonal" density="compact" class="mb-3">{{ selectionSpeechError }}</v-alert>
    <template v-if="selectionSpeechEnabled">
      <div class="section-title-row compact-row mb-2">
        <div>
          <div class="section-title small-title">滑词朗读</div>
          <div class="section-note">点击“朗读”才会播放；关闭后悬浮条只保留“投递至”。</div>
        </div>
        <v-switch v-model="selectionReadAloudEnabled" label="滑词朗读" color="success" density="compact" inset hide-details :disabled="!selectionSpeechLoaded" />
      </div>
      <v-switch v-model="selectionSpeechAdvanced" label="高级选项" color="primary" density="compact" hide-details :disabled="!selectionSpeechLoaded || !selectionReadAloudEnabled" />
      <v-select
        v-if="selectionReadAloudEnabled && selectionSpeechAdvanced"
        v-model="selectionSpeechModel"
        class="mt-3"
        label="滑词朗读模型"
        :items="selectionSpeechModels.filter(item => item.capability === 'tts' && item.available)"
        item-title="name"
        item-value="id"
        :disabled="!selectionSpeechLoaded"
      >
        <template #item="{ props, item }"><v-list-item v-bind="props" :subtitle="item.raw.id" /></template>
      </v-select>
    </template>
    <v-divider class="my-4" />
    <div class="section-title-row compact-row">
      <div>
        <div class="section-title small-title">Windows 登录启动</div>
        <div class="section-note">登录 Windows 后自动启动 RabiRoute Desktop；后台运行时保留系统托盘入口。</div>
      </div>
      <v-switch v-model="desktopAutostart" label="登录后启动" color="success" density="compact" inset hide-details :disabled="!loaded" />
    </div>
  </v-card>
</template>
