<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { requestPhoneFileOperation, type RabiLinkHomeDevice } from "../../../../../ribiwebgui/src/rabiLinkHomeClient";
import { ComputerControlFiles, type ComputerFileProgress } from "../computer/computerControlFiles";

const props = defineProps<{ device: RabiLinkHomeDevice; title: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
type Entry = { name: string; kind: "file" | "directory"; size: number; modifiedAt: number; version: string };
type Page = { entries: Entry[]; version: string; next: string | null };
type Edit = { action: "mkdir" | "rename" | "delete"; entry?: Entry };
type Transfer = { file: File; path: string; id: string; version?: string };

const directory = ref("");
const entries = ref<Entry[]>([]);
const next = ref<string | null>(null);
const listVersion = ref("");
const error = ref("");
const busy = ref(false);
const progress = ref<ComputerFileProgress>();
const edit = ref<Edit>();
const draft = ref("");
const transfer = shallowRef<Transfer>();
const activeTransfer = shallowRef<AbortController>();
const replace = ref<Entry>();
const picker = ref<HTMLInputElement>();
const status = ref("");
const pathLabel = computed(() => "/" + directory.value);
const current = new AbortController();
onBeforeUnmount(() => current.abort());

const errorMessages: Record<string, string> = {
  PHONE_FILES_NOT_CONNECTED: "手机文件操作暂不可用，请检查手机连接。",
  PHONE_FILES_DISABLED: "此手机已关闭文件操作。",
  PHONE_FILES_PERMISSION_REQUIRED: "请在手机端授予 Android 所有文件访问权限。",
  PHONE_FILE_ACCESS_DENIED: "Android 禁止访问此路径。",
  PHONE_FILES_DEVICE_UNKNOWN: "设备已变更，请刷新设备列表。",
  PHONE_FILE_EXISTS: "目标位置已有同名文件或文件夹。",
  PHONE_FILE_NOT_FOUND: "文件已移动或删除，请刷新目录。",
  PHONE_FILE_CHANGED: "文件或目录已变更，请刷新后再操作。",
  PHONE_FOLDER_NOT_EMPTY: "请先清空该文件夹。",
  PHONE_FILE_PATH_INVALID: "请输入手机内部存储中的有效路径。",
  PHONE_FILES_OUTCOME_UNCERTAIN: "手机可能已完成操作。请刷新目录或查询原传输再继续。",
  PHONE_FILES_TRANSPORT_UNCONFIRMED: "连接中断。请刷新目录或查询原传输再继续。",
  PHONE_FILES_TIMEOUT: "手机连接超时，请重试读取。",
  PHONE_UPLOAD_UNKNOWN: "手机已找不到原传输，请检查目标文件。",
  PHONE_STORAGE_FULL: "手机空间不足。"
};

const join = (name: string) => directory.value ? directory.value + "/" + name : name;

async function call(input: Record<string, unknown>, signal = current.signal): Promise<Record<string, unknown>> {
  try {
    return await requestPhoneFileOperation(props.device, input, signal);
  } catch (cause) {
    const key = cause instanceof Error ? cause.message : "";
    throw new Error(t(errorMessages[key] || "文件操作失败，请检查手机连接后重试。"));
  }
}

async function run(work: () => Promise<void>) {
  if (busy.value) return;
  error.value = "";
  status.value = "";
  busy.value = true;
  try { await work(); }
  catch (cause) {
    if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : t("文件操作失败，请检查手机连接后重试。");
  } finally { busy.value = false; }
}

async function runTransfer(work: (files: ComputerControlFiles, signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  activeTransfer.value = controller;
  const signal = AbortSignal.any([current.signal, controller.signal]);
  try { await work(new ComputerControlFiles(input => call(input, signal)), signal); }
  catch (cause) {
    if (!controller.signal.aborted) throw cause;
    status.value = t(transfer.value ? "已停止等待，可查询原传输。" : "下载已停止。");
  } finally { activeTransfer.value = undefined; }
}

async function readDirectory(path = directory.value, after?: string) {
  const result = await call({
    action: "file.list", path, ...(after ? { after, version: listVersion.value } : {})
  }) as Page;
  directory.value = path;
  entries.value = after ? [...entries.value, ...result.entries] : result.entries;
  listVersion.value = result.version;
  next.value = result.next;
}
onMounted(() => run(readDirectory));

function openEdit(action: Edit["action"], entry?: Entry) {
  draft.value = action === "rename" && entry ? join(entry.name) : "";
  edit.value = { action, entry };
}

function submitEdit() {
  const change = edit.value;
  if (!change) return;
  void run(async () => {
    const { entry } = change;
    if (change.action === "mkdir") {
      await call({ action: "file.mkdir", path: join(draft.value.trim()) });
    } else if (entry) {
      const target = { path: join(entry.name), version: entry.version };
      await call(change.action === "delete" ? { action: "file.delete", ...target }
        : { action: "file.rename", ...target, to: draft.value.trim() });
    }
    edit.value = undefined;
    await readDirectory();
  });
}

function chooseUpload(entry?: Entry) {
  replace.value = entry;
  if (picker.value) { picker.value.value = ""; picker.value.click(); }
}

function selectFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 512 * 1024 * 1024) { error.value = t("单个文件最多 512 MiB。"); return; }
  const entry = replace.value;
  transfer.value = { file, path: join(entry?.name ?? file.name), id: browserUuid(), version: entry?.version };
  progress.value = undefined;
  upload();
}

function upload() {
  const job = transfer.value;
  if (!job) return;
  void run(() => runTransfer(async (files, signal) => {
    await files.upload(job.file, job.path, job.id, signal, value => { progress.value = value; }, job.version);
    transfer.value = undefined;
    status.value = t("上传完成");
    await readDirectory();
  }));
}

function checkUpload(abort = false) {
  const job = transfer.value;
  if (!job) return;
  void run(async () => {
    const receipt = await call({ action: abort ? "upload.abort" : "upload.status", uploadId: job.id }) as ComputerFileProgress;
    progress.value = receipt;
    if (receipt.state === "committed" || receipt.state === "aborted") {
      transfer.value = undefined;
      status.value = receipt.state === "committed" ? t("上传完成") : t("上传已取消");
      await readDirectory();
    }
  });
}

function download(entry: Entry) {
  void run(() => runTransfer(async (files, signal) => {
    progress.value = undefined;
    const file = await files.download(join(entry.name), signal, value => { progress.value = value; });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = entry.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.value = t("下载已校验");
  }));
}
</script>

<template>
  <v-dialog :model-value="true" :persistent="busy" max-width="760" @update:model-value="open => { if (!open) emit('close') }">
    <v-card>
      <v-card-title>{{ t('文件操作') }} · <span data-no-i18n>{{ title }}</span></v-card-title>
      <v-card-text class="phone-files">
        <div class="d-flex align-center flex-wrap ga-2">
          <v-btn size="small" variant="text" prepend-icon="mdi-arrow-up" :disabled="busy || !directory"
            @click="run(() => readDirectory(directory.split('/').slice(0, -1).join('/')))">{{ t('上一级') }}</v-btn>
          <span class="file-path">{{ t('内部存储') }}<code data-no-i18n>{{ pathLabel }}</code></span>
          <v-spacer />
          <v-btn size="small" variant="text" :disabled="busy" icon="mdi-refresh" :aria-label="t('刷新')" @click="run(readDirectory)" />
          <v-btn size="small" variant="tonal" :disabled="busy" @click="openEdit('mkdir')">{{ t('新建文件夹') }}</v-btn>
          <v-btn size="small" variant="tonal" :disabled="busy || !!transfer" @click="chooseUpload()">{{ t('上传') }}</v-btn>
          <input ref="picker" type="file" hidden @change="selectFile" />
        </div>
        <v-progress-linear v-if="busy" indeterminate color="primary" />
        <v-btn v-if="activeTransfer" size="small" variant="text" class="justify-self-start"
          @click="activeTransfer.abort()">{{ t('停止等待') }}</v-btn>
        <p v-if="progress" class="section-note" role="status">{{ progress.offset }} / {{ progress.size }} B</p>
        <p v-if="status" class="section-note" role="status">{{ status }}</p>
        <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
        <div v-if="transfer && !busy" class="d-flex flex-wrap ga-2">
          <v-btn size="small" @click="checkUpload()">{{ t('查询原传输') }}</v-btn>
          <v-btn size="small" @click="upload">{{ t('继续上传') }}</v-btn>
          <v-btn size="small" @click="checkUpload(true)">{{ t('取消传输') }}</v-btn>
          <v-btn size="small" variant="text" @click="transfer = undefined">{{ t('清除当前传输') }}</v-btn>
        </div>
        <v-form v-if="edit" class="d-flex flex-column ga-2" @submit.prevent="submitEdit">
          <p v-if="edit.action === 'delete'">{{ t('确认删除') }} <strong data-no-i18n>{{ edit.entry?.name }}</strong></p>
          <v-text-field v-else v-model="draft" :disabled="busy" density="compact" hide-details
            :label="edit.action === 'mkdir' ? t('文件夹名称') : t('新路径（相对于内部存储）')" />
          <div class="d-flex ga-2">
            <v-btn size="small" :disabled="busy" @click="edit = undefined">{{ t('取消') }}</v-btn>
            <v-btn size="small" type="submit" :color="edit.action === 'delete' ? 'error' : 'primary'"
              :disabled="busy || (edit.action !== 'delete' && !draft.trim())">{{ t('确认') }}</v-btn>
          </div>
        </v-form>
        <v-list v-if="entries.length" density="compact">
          <v-list-item v-for="entry in entries" :key="entry.name">
            <template #prepend><v-icon :icon="entry.kind === 'directory' ? 'mdi-folder-outline' : 'mdi-file-outline'" /></template>
            <v-list-item-title>
              <button v-if="entry.kind === 'directory'" type="button" class="directory-link" data-no-i18n :disabled="busy"
                @click="run(() => readDirectory(join(entry.name)))">{{ entry.name }}</button>
              <span v-else data-no-i18n>{{ entry.name }}</span>
            </v-list-item-title>
            <v-list-item-subtitle v-if="entry.kind === 'file'">{{ entry.size.toLocaleString() }} B</v-list-item-subtitle>
            <template #append>
              <v-menu>
                <template #activator="{ props: menuProps }">
                  <v-btn v-bind="menuProps" size="small" icon="mdi-dots-vertical" variant="text" :disabled="busy"
                    :aria-label="t('更多操作') + ' · ' + entry.name" />
                </template>
                <v-list density="compact">
                  <v-list-item v-if="entry.kind === 'file'" :title="t('下载')" @click="download(entry)" />
                  <v-list-item v-if="entry.kind === 'file'" :title="t('替换内容')" :disabled="!!transfer" @click="chooseUpload(entry)" />
                  <v-list-item :title="t('重命名或移动')" @click="openEdit('rename', entry)" />
                  <v-list-item :title="t('删除')" @click="openEdit('delete', entry)" />
                </v-list>
              </v-menu>
            </template>
          </v-list-item>
        </v-list>
        <p v-else-if="!busy && !error" class="section-note">{{ t('此文件夹为空') }}</p>
        <v-btn v-if="next" size="small" variant="text" :disabled="busy" @click="run(() => readDirectory(directory, next!))">{{ t('加载更多') }}</v-btn>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="busy" @click="emit('close')">{{ t('关闭') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.phone-files { display: grid; gap: 12px; }
.file-path { min-width: 0; overflow-wrap: anywhere; }
.directory-link { color: var(--rr-accent-text); text-align: start; }
.directory-link:hover { text-decoration: underline; }
</style>
