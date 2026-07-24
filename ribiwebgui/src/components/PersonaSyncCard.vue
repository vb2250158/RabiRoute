<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { translateText } from "../i18n";
import {
  personaSyncClient,
  type PersonaSyncAutoStatus,
  type PersonaSyncConflict,
  type PersonaSyncContent,
  type PersonaSyncIndexStatus,
  type PersonaSyncPeer,
  type PersonaSyncResult
} from "../persona/personaSyncClient";

const props = withDefaults(defineProps<{
  roleId: string;
  manifestVersion?: number;
  peerVersion?: number;
}>(), {
  manifestVersion: 0,
  peerVersion: 0
});

const peers = ref<PersonaSyncPeer[]>([]);
const conflicts = ref<PersonaSyncConflict[]>([]);
const indexStatus = ref<PersonaSyncIndexStatus | null>(null);
const autoStatus = ref<PersonaSyncAutoStatus | null>(null);
const syncResult = ref<PersonaSyncResult | null>(null);
const peerLoading = ref(false);
const localLoading = ref(false);
const syncingPeerId = ref("");
const resolvingConflictId = ref("");
const peerError = ref("");
const localError = ref("");
const notice = ref("");
const previewOpen = ref(false);
const previewLoading = ref(false);
const previewError = ref("");
const previewConflict = ref<PersonaSyncConflict | null>(null);
const localPreview = ref("");
const remotePreview = ref("");

const syncablePeers = computed(() => peers.value.filter(peer => peer.online && peer.capabilities.includes("persona-sync")));
const semanticConflicts = computed(() => syncResult.value?.semanticConflicts || []);
const changedFiles = computed(() => syncResult.value?.files.filter(file => file.status !== "unchanged").length || 0);
const autoStatusLabel = computed(() => {
  switch (autoStatus.value?.state) {
    case "idle": return "自动对账已完成";
    case "scheduled": return "自动对账已排队";
    case "syncing": return "正在自动对账";
    case "waiting_relay": return "等待 Relay 恢复";
    case "waiting_peer": return "等待其它电脑上线";
    case "attention": return "自动对账需要确认";
    case "error": return "自动对账暂时失败";
    default: return "自动对账未运行";
  }
});
const autoStatusColor = computed(() => {
  switch (autoStatus.value?.state) {
    case "idle": return "success";
    case "attention":
    case "waiting_relay":
    case "waiting_peer": return "warning";
    case "error": return "error";
    default: return "info";
  }
});

function compactTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function previewText(content: PersonaSyncContent, relativePath: string): string {
  if (content.bytes.byteLength === 0) return "（空文件）";
  const textLike = /\.(?:md|txt|json|jsonl|ya?ml|csv|xml|toml|ini)$/i.test(relativePath);
  if (!textLike || content.bytes.byteLength > 2 * 1024 * 1024) {
    return `二进制或大型文件 · ${content.bytes.byteLength} bytes · 不在页面展开`;
  }
  return new TextDecoder().decode(content.bytes);
}

async function refreshPeers(): Promise<void> {
  if (!props.roleId) return;
  peerLoading.value = true;
  peerError.value = "";
  try {
    const result = await personaSyncClient.peers();
    peers.value = result.peers;
  } catch (error) {
    peers.value = [];
    peerError.value = error instanceof Error ? error.message : String(error);
  } finally {
    peerLoading.value = false;
  }
}

async function refreshLocalState(): Promise<void> {
  if (!props.roleId) return;
  localLoading.value = true;
  localError.value = "";
  try {
    const [status, automatic, conflictResult] = await Promise.all([
      personaSyncClient.indexStatus(),
      personaSyncClient.autoStatus(),
      personaSyncClient.conflicts(props.roleId)
    ]);
    indexStatus.value = status;
    autoStatus.value = automatic;
    conflicts.value = conflictResult.conflicts;
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  } finally {
    localLoading.value = false;
  }
}

async function refreshAll(): Promise<void> {
  notice.value = "";
  syncResult.value = null;
  await Promise.all([refreshPeers(), refreshLocalState()]);
}

async function syncPeer(peer: PersonaSyncPeer): Promise<void> {
  if (!props.roleId || syncingPeerId.value) return;
  syncingPeerId.value = peer.id;
  localError.value = "";
  notice.value = "";
  try {
    syncResult.value = await personaSyncClient.sync(peer.id, props.roleId);
    notice.value = syncResult.value.conflicts > 0
      ? "同步已完成传输，但仍有冲突需要确认。"
      : "当前人格已经和这台电脑收敛。";
    await refreshLocalState();
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  } finally {
    syncingPeerId.value = "";
  }
}

async function openConflict(conflict: PersonaSyncConflict): Promise<void> {
  previewConflict.value = conflict;
  previewOpen.value = true;
  previewLoading.value = true;
  previewError.value = "";
  localPreview.value = "";
  remotePreview.value = "";
  try {
    const localRequest = personaSyncClient.localContent(conflict);
    const remoteRequest: Promise<PersonaSyncContent | null> = conflict.remoteDeleted
      ? Promise.resolve(null)
      : personaSyncClient.remoteContent(conflict.conflictId);
    const [local, remote] = await Promise.allSettled([localRequest, remoteRequest] as const);
    localPreview.value = local.status === "fulfilled"
      ? previewText(local.value, conflict.path)
      : "本机文件当前不存在或已经变化；解决时仍会重新校验版本。";
    if (remote.status === "rejected") throw remote.reason;
    remotePreview.value = remote.value ? previewText(remote.value, conflict.path) : "对方已删除这个文件";
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : String(error);
  } finally {
    previewLoading.value = false;
  }
}

async function resolveConflict(action: "keep_local" | "use_remote"): Promise<void> {
  const conflict = previewConflict.value;
  if (!conflict || resolvingConflictId.value) return;
  const adoptingDeletion = action === "use_remote" && conflict.remoteDeleted;
  const question = action === "keep_local"
    ? "确认保留本机版本，并尝试把这个决定发布回来源电脑？"
    : adoptingDeletion
      ? "对方版本是删除。确认删除本机文件，并尝试把决定发布回来源电脑？"
      : "确认用对方版本替换本机文件，并尝试把决定发布回来源电脑？";
  if (!window.confirm(translateText(question))) return;
  resolvingConflictId.value = conflict.conflictId;
  previewError.value = "";
  notice.value = "";
  try {
    const result = await personaSyncClient.resolve(conflict, action);
    notice.value = result.publish.status === "published"
      ? `冲突已解决，并通过${result.publish.transport === "lan" ? "局域网" : " Relay"}发布回来源电脑。`
      : `本机冲突已解决；来源电脑暂未收敛：${result.publish.message || "稍后需要再次显式同步。"}`;
    previewOpen.value = false;
    await refreshLocalState();
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : String(error);
  } finally {
    resolvingConflictId.value = "";
  }
}

watch(() => props.roleId, roleId => {
  peers.value = [];
  conflicts.value = [];
  indexStatus.value = null;
  autoStatus.value = null;
  syncResult.value = null;
  notice.value = "";
  if (roleId) void refreshAll();
}, { immediate: true });

watch(() => props.manifestVersion, () => {
  if (props.roleId) void refreshLocalState();
});

watch(() => props.peerVersion, () => {
  if (props.roleId) void refreshPeers();
});
</script>

<template>
  <v-card class="app-card glass-card section-card persona-sync-card">
    <div class="section-title-row">
      <div>
        <div class="section-title">多电脑人格同步</div>
        <div class="section-note">同一应用 token 自动发现电脑；文件变化、电脑上线和 Relay 重连会自动对账，手动同步仍可立即执行。</div>
      </div>
      <div class="d-flex ga-2 flex-wrap">
        <v-chip v-if="indexStatus" size="small" :color="indexStatus.state === 'ready' ? 'success' : indexStatus.state === 'fallback' ? 'warning' : undefined" variant="tonal">
          {{ indexStatus.watchMode === "recursive" ? "文件事件索引" : indexStatus.watchMode === "query_reconcile" ? "查询时校准" : "索引只读" }}
        </v-chip>
        <v-chip v-if="autoStatus" size="small" :color="autoStatusColor" variant="tonal">
          {{ autoStatusLabel }}
        </v-chip>
        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="peerLoading || localLoading" @click="refreshAll">刷新设备</v-btn>
      </div>
    </div>

    <v-alert v-if="peerError" type="warning" variant="tonal" density="compact" class="mb-3">
      {{ peerError }}
      <div class="mt-1">请先在全局设置中启用 RabiLink Relay，并让其它电脑使用同一个应用 token。</div>
    </v-alert>
    <v-alert v-if="localError" type="error" variant="tonal" density="compact" class="mb-3">{{ localError }}</v-alert>
    <v-alert v-if="autoStatus?.lastError" type="warning" variant="tonal" density="compact" class="mb-3">
      自动对账保留了待同步标记，将在连接事件或有界重试时继续：{{ autoStatus.lastError }}
    </v-alert>
    <v-alert v-if="notice" :type="syncResult?.conflicts ? 'warning' : 'success'" variant="tonal" density="compact" class="mb-3">{{ notice }}</v-alert>

    <div class="sync-stat-strip">
      <div><span>可同步电脑</span><b>{{ syncablePeers.length }}</b></div>
      <div><span>本机人格文件</span><b>{{ indexStatus?.files ?? "-" }}</b></div>
      <div><span>待解决文件冲突</span><b>{{ conflicts.length }}</b></div>
    </div>

    <div v-if="peerLoading && peers.length === 0" class="sync-loading-row">
      <v-progress-circular indeterminate size="22" width="2" />
      <span>正在发现同应用电脑…</span>
    </div>
    <div v-else-if="peers.length === 0 && !peerError" class="empty-state compact-empty mt-3">
      <div>
        <strong>暂未发现其它电脑</strong>
        <span>设备上线或 Relay 重连后会事件刷新；也可以手动点击“刷新设备”补查一次。</span>
      </div>
    </div>
    <div v-else class="sync-peer-list mt-3">
      <article v-for="peer in peers" :key="peer.guid || peer.id" class="sync-peer-row">
        <div class="sync-peer-mark" :class="{ online: peer.online }"><v-icon size="18">mdi-laptop</v-icon></div>
        <div class="sync-peer-copy">
          <strong data-no-i18n>{{ peer.name }}</strong>
          <span>{{ peer.online ? (peer.capabilities.includes("persona-sync") ? "在线 · 支持人格同步" : "在线 · 客户端版本不支持同步") : "离线" }}</span>
        </div>
        <v-btn
          size="small"
          color="secondary"
          variant="tonal"
          prepend-icon="mdi-folder-sync-outline"
          :loading="syncingPeerId === peer.id"
          :disabled="!peer.online || !peer.capabilities.includes('persona-sync') || Boolean(syncingPeerId)"
          @click="syncPeer(peer)"
        >
          同步当前人格
        </v-btn>
      </article>
    </div>

    <div v-if="syncResult" class="sync-result mt-3">
      <div class="sync-result-head">
        <div>
          <strong>{{ syncResult.transport === "lan" ? "局域网直连" : "Relay 中转" }}</strong>
          <span data-no-i18n>{{ syncResult.peer.name }}</span>
        </div>
        <v-chip size="small" :color="syncResult.conflicts ? 'warning' : 'success'" variant="tonal">
          {{ changedFiles }} 个变化 · {{ syncResult.conflicts }} 个冲突
        </v-chip>
      </div>
      <div class="sync-direction-grid">
        <div><span>拉取</span><b>{{ syncResult.files.filter(file => file.direction === "pull").length }}</b></div>
        <div><span>推送</span><b>{{ syncResult.files.filter(file => file.direction === "push").length }}</b></div>
        <div><span>已一致</span><b>{{ syncResult.files.filter(file => file.direction === "converged").length }}</b></div>
      </div>
    </div>

    <div v-if="conflicts.length || semanticConflicts.length" class="sync-conflicts mt-4">
      <div class="sync-subtitle">
        <div><strong>需要人工确认</strong><span>不会使用最后写入者覆盖，也不会后台自动决定。</span></div>
      </div>
      <button v-for="conflict in conflicts" :key="conflict.conflictId" type="button" class="sync-conflict-row" @click="openConflict(conflict)">
        <v-icon color="warning" size="20">mdi-file-alert-outline</v-icon>
        <span class="sync-conflict-copy">
          <strong data-no-i18n>{{ conflict.path }}</strong>
          <small>{{ conflict.remoteDeleted ? "对方删除 / 本机保留" : "双方文件都发生了修改" }} · {{ compactTime(conflict.createdAt) }}</small>
        </span>
        <v-icon size="18">mdi-chevron-right</v-icon>
      </button>
      <div v-for="conflict in semanticConflicts" :key="`${conflict.sourceHostId}:${conflict.voiceprintId}`" class="sync-conflict-row semantic-row">
        <v-icon color="warning" size="20">mdi-account-voice</v-icon>
        <span class="sync-conflict-copy">
          <strong>声纹关系存在多电脑分支</strong>
          <small>请在下方“人格声纹归类”中重新确认，这是收敛身份分支的唯一入口。</small>
        </span>
      </div>
    </div>

    <v-alert class="mt-3" type="info" variant="tonal" density="compact">
      本机文件变化、同应用电脑上下线和 Relay 重连会触发一次自动对账；事件只负责唤醒，随后按 manifest 查询补漏。没有固定后台轮询，也不会把 Relay 当作服务器端主人格仓库。
    </v-alert>

    <v-dialog v-model="previewOpen" max-width="1120">
      <v-card class="app-card sync-preview-dialog">
        <v-card-title class="d-flex justify-space-between align-center ga-3">
          <div class="min-w-0">
            <div class="section-title">确认文件冲突</div>
            <div class="section-note text-truncate" data-no-i18n>{{ previewConflict?.path }}</div>
          </div>
          <v-btn icon="mdi-close" variant="text" @click="previewOpen = false" />
        </v-card-title>
        <v-card-text>
          <v-alert v-if="previewError" type="error" variant="tonal" density="compact" class="mb-3">{{ previewError }}</v-alert>
          <div v-if="previewLoading" class="sync-loading-row"><v-progress-circular indeterminate size="24" width="2" /><span>正在读取本机和对方证据…</span></div>
          <div v-else class="sync-preview-grid">
            <section>
              <div class="sync-preview-title"><strong>本机版本</strong><span>当前人格文件</span></div>
              <pre data-no-i18n>{{ localPreview }}</pre>
            </section>
            <section>
              <div class="sync-preview-title"><strong>对方版本</strong><span>{{ previewConflict?.remoteDeleted ? "删除意图" : "冲突证据" }}</span></div>
              <pre data-no-i18n>{{ remotePreview }}</pre>
            </section>
          </div>
        </v-card-text>
        <v-card-actions class="px-6 pb-5 flex-wrap">
          <span class="section-note">需要手工合并正文时，仍可让本机 Agent 调用 <code>use_merged</code> 接口。</span>
          <v-spacer />
          <v-btn variant="tonal" :loading="resolvingConflictId === previewConflict?.conflictId" @click="resolveConflict('keep_local')">保留本机</v-btn>
          <v-btn color="warning" variant="tonal" :loading="resolvingConflictId === previewConflict?.conflictId" @click="resolveConflict('use_remote')">
            {{ previewConflict?.remoteDeleted ? "采用对方删除" : "采用对方版本" }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.persona-sync-card {
  position: relative;
  overflow: hidden;
}

.persona-sync-card::after {
  content: "";
  position: absolute;
  inset: 0 0 auto auto;
  width: 180px;
  height: 180px;
  background: radial-gradient(circle at top right, rgba(var(--v-theme-secondary), .13), transparent 68%);
  pointer-events: none;
}

.sync-stat-strip,
.sync-direction-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.sync-stat-strip > div,
.sync-direction-grid > div {
  padding: 12px 14px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 14px;
  background: rgba(var(--v-theme-surface), .48);
}

.sync-stat-strip span,
.sync-direction-grid span,
.sync-peer-copy span,
.sync-result-head span,
.sync-subtitle span {
  display: block;
  color: rgba(var(--v-theme-on-surface), .62);
  font-size: 12px;
}

.sync-stat-strip b,
.sync-direction-grid b {
  display: block;
  margin-top: 4px;
  font-size: 20px;
}

.sync-loading-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 96px;
  color: rgba(var(--v-theme-on-surface), .66);
}

.sync-peer-list {
  display: grid;
  gap: 8px;
}

.sync-peer-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 15px;
}

.sync-peer-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  color: rgba(var(--v-theme-on-surface), .45);
  background: rgba(var(--v-theme-on-surface), .06);
}

.sync-peer-mark.online {
  color: rgb(var(--v-theme-success));
  background: rgba(var(--v-theme-success), .12);
}

.sync-peer-copy {
  min-width: 0;
}

.sync-peer-copy strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-result {
  padding: 14px;
  border: 1px solid rgba(var(--v-theme-secondary), .28);
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(var(--v-theme-secondary), .09), rgba(var(--v-theme-surface), .35));
}

.sync-result-head,
.sync-subtitle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.sync-result-head strong,
.sync-result-head span {
  display: inline;
  margin-right: 8px;
}

.sync-conflicts {
  display: grid;
  gap: 8px;
}

.sync-conflict-row {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 12px;
  color: inherit;
  text-align: left;
  border: 1px solid rgba(var(--v-theme-warning), .24);
  border-radius: 14px;
  background: rgba(var(--v-theme-warning), .07);
}

button.sync-conflict-row {
  cursor: pointer;
  transition: transform .16s ease, border-color .16s ease, background .16s ease;
}

button.sync-conflict-row:hover {
  transform: translateY(-1px);
  border-color: rgba(var(--v-theme-warning), .46);
  background: rgba(var(--v-theme-warning), .11);
}

.semantic-row {
  grid-template-columns: auto minmax(0, 1fr);
}

.sync-conflict-copy strong,
.sync-conflict-copy small {
  display: block;
}

.sync-conflict-copy small {
  margin-top: 2px;
  color: rgba(var(--v-theme-on-surface), .62);
}

.sync-preview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.sync-preview-grid section {
  min-width: 0;
}

.sync-preview-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.sync-preview-title span {
  color: rgba(var(--v-theme-on-surface), .58);
  font-size: 12px;
}

.sync-preview-grid pre {
  min-height: 340px;
  max-height: 58vh;
  overflow: auto;
  margin: 0;
  padding: 14px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 14px;
  background: rgba(6, 12, 20, .78);
  color: #d8e6ef;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.6 "Cascadia Mono", Consolas, monospace;
}

@media (max-width: 820px) {
  .sync-stat-strip,
  .sync-direction-grid,
  .sync-preview-grid {
    grid-template-columns: 1fr;
  }

  .sync-peer-row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .sync-peer-row .v-btn {
    grid-column: 1 / -1;
  }
}
</style>
