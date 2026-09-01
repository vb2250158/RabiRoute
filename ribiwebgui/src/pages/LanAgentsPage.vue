<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

type NodeStatus = {
  nodeId: string;
  version: string;
  platform: string;
  agentTypes?: string[];
  allowedWorkspaces?: string[];
  connected: boolean;
  connectedAt?: string;
  lastSeenAt?: string;
  targetVersion?: string;
  updateState?: string;
  lastUpdateAt?: string;
  lastUpdateError?: string;
};

type Task = {
  taskId: string;
  nodeId: string;
  targetAgent: string;
  status: string;
  updatedAt: string;
  result?: string;
  error?: string;
};

const nodes = ref<NodeStatus[]>([]);
const tasks = ref<Task[]>([]);
const releaseVersion = ref("");
const releasePublicKeySha256 = ref("");
const loading = ref(false);
const updatingNodeId = ref("");
const error = ref("");

const onlineCount = computed(() => nodes.value.filter(node => node.connected).length);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatTime(value: string | undefined): string {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || body.code !== 0) throw new Error(text(body.message) || `请求失败：HTTP ${response.status}`);
  return body;
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const body = await readJson(await fetch("/api/lan-agent/nodes", { cache: "no-store" }));
    nodes.value = Array.isArray(body.nodes) ? body.nodes as NodeStatus[] : [];
    tasks.value = Array.isArray(body.tasks) ? body.tasks as Task[] : [];
    releaseVersion.value = text(body.releaseVersion);
    releasePublicKeySha256.value = text(body.releasePublicKeySha256);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

async function requestUpdate(node: NodeStatus): Promise<void> {
  updatingNodeId.value = node.nodeId;
  error.value = "";
  try {
    await readJson(await fetch(`/api/lan-agent/nodes/${encodeURIComponent(node.nodeId)}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: releaseVersion.value || undefined })
    }));
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    updatingNodeId.value = "";
  }
}

onMounted(() => { void refresh(); });
</script>

<template>
  <v-container class="lan-agents-page" fluid>
    <div class="d-flex flex-wrap align-center justify-space-between ga-3 mb-5">
      <div>
        <h1 class="text-h5">局域网 Rabi Agent</h1>
        <p class="text-body-2 lan-muted mb-0">在线 {{ onlineCount }} / {{ nodes.length }} 个节点。发布版本：{{ releaseVersion || "未发布" }}。</p>
        <p v-if="releasePublicKeySha256" class="text-caption lan-muted mb-0 fingerprint">发布公钥 SHA-256：{{ releasePublicKeySha256 }}</p>
      </div>
      <v-btn :loading="loading" prepend-icon="mdi-refresh" variant="tonal" @click="refresh">刷新</v-btn>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="!loading && !nodes.length" type="info" variant="tonal" class="mb-4">
      暂无已接入节点。新电脑完成 Rabi Agent 自助接入后会显示在这里。
    </v-alert>

    <v-row>
      <v-col v-for="node in nodes" :key="node.nodeId" cols="12" md="6" xl="4">
        <v-card variant="outlined" height="100%">
          <v-card-title class="d-flex align-center justify-space-between ga-2">
            <span class="text-truncate">{{ node.nodeId }}</span>
            <v-chip :color="node.connected ? 'success' : 'default'" size="small">{{ node.connected ? "在线" : "离线" }}</v-chip>
          </v-card-title>
          <v-card-text class="pt-1">
            <div class="detail-row"><span>当前版本</span><b>{{ node.version }}</b></div>
            <div class="detail-row"><span>平台</span><b>{{ node.platform }}</b></div>
            <div class="detail-row"><span>本机 Agent</span><b>{{ node.agentTypes?.join("、") || "未声明" }}</b></div>
            <div class="detail-row"><span>最后在线</span><b>{{ formatTime(node.lastSeenAt) }}</b></div>
            <div class="detail-row"><span>更新状态</span><b>{{ node.updateState || "idle" }}</b></div>
            <div v-if="node.lastUpdateError" class="text-error text-body-2 mt-2">{{ node.lastUpdateError }}</div>
          </v-card-text>
          <v-card-actions>
            <v-btn
              color="primary"
              :disabled="!node.connected || !releaseVersion"
              :loading="updatingNodeId === node.nodeId"
              prepend-icon="mdi-update"
              @click="requestUpdate(node)"
            >更新到 {{ releaseVersion || "当前版本" }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <v-card class="mt-6" variant="outlined">
      <v-card-title>最近任务</v-card-title>
      <v-table density="comfortable">
        <thead><tr><th>节点</th><th>目标 Agent</th><th>状态</th><th>更新时间</th><th>结果</th></tr></thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.taskId">
            <td>{{ task.nodeId }}</td><td>{{ task.targetAgent }}</td><td>{{ task.status }}</td><td>{{ formatTime(task.updatedAt) }}</td><td>{{ task.error || task.result || "—" }}</td>
          </tr>
          <tr v-if="!tasks.length"><td colspan="5" class="lan-muted">暂无任务记录。</td></tr>
        </tbody>
      </v-table>
    </v-card>
  </v-container>
</template>

<style scoped>
.lan-agents-page { max-width: 1480px; }
.detail-row { display: grid; grid-template-columns: minmax(0, 110px) minmax(0, 1fr); gap: 12px; margin: 8px 0; }
.lan-muted { color: var(--rr-muted) !important; opacity: 1 !important; }
.detail-row span { color: var(--rr-muted-soft); opacity: 1; }
.detail-row b { overflow-wrap: anywhere; }
.fingerprint { overflow-wrap: anywhere; }
</style>
