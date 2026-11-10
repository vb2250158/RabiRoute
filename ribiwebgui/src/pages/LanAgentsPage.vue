<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { agentInstanceDisplayName, type AgentInstance } from "@shared/agentInstance";
import InstanceAgentSettings from "../components/InstanceAgentSettings.vue";
import { routeScopedAdaptersPath } from "../routeScopedNavigation";
import { copyTextToClipboard } from "../clipboard";
import { managerAccessToken } from "../managerApi";
import { peerManagerPath } from "../peerManagerTarget";
import { buildLanAgentBootstrapPrompt, lanAgentBootstrapPlatforms, type LanAgentBootstrapPlatform } from "../lanAgentBootstrap";
import { useGatewayStore } from "../stores/gatewayStore";
const gatewayStore = useGatewayStore();
const route = useRoute();
const router = useRouter();
const ownerDeviceId = computed(() => typeof route.query.deviceId === "string" ? route.query.deviceId : "");
const hosts = ref<Array<{ deviceId: string; name: string; online: boolean }>>([]);
const hostError = ref("");
const hostItems = computed(() => {
  const items = [{ title: "本机", value: "" }, ...hosts.value.map(host => ({ title: `${host.name || host.deviceId}${host.online ? "" : "（离线）"}`, value: host.deviceId }))];
  if (ownerDeviceId.value && !items.some(item => item.value === ownerDeviceId.value)) items.push({ title: ownerDeviceId.value, value: ownerDeviceId.value });
  return items;
});
const selectedHostName = computed(() => hostItems.value.find(item => item.value === ownerDeviceId.value)?.title || "本机");
let refreshController: AbortController | undefined;
const instancePath = (instance: AgentInstance, suffix: string) => peerManagerPath(instance.ownerDeviceId || "", `/api/lan-agent/instances/${encodeURIComponent(instance.instanceId)}${suffix}`);
function agentRoutes(instance: AgentInstance, agentId: string, routeId?: string) {
  return gatewayStore.gateways.filter(route => instance.local && !instance.ownerDeviceId ? route.id === routeId : Object.values(route.agentInstanceBindings || {}).some(binding => (binding.ownerDeviceId || "") === (instance.ownerDeviceId || "") && binding.instanceId === instance.instanceId && binding.agentId === agentId));
}

type NodeStatus = {
  nodeId: string;
  remoteAddress?: string;
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
const instances = ref<AgentInstance[]>([]);
const addingInstanceId = ref("");
const tasks = ref<Task[]>([]);
const releaseVersion = ref("");
const releasePublicKeySha256 = ref("");
const loading = ref(false);
const updatingNodeId = ref("");
const error = ref("");
const copied = ref(false);
const enrollmentOpen = ref(false);
const issuingTicket = ref(false);
const ticketExpiresAt = ref("");
const targetPlatform = ref<LanAgentBootstrapPlatform>();
const managerUrl = ref(window.location.origin);
const connectionToken = ref("");
const connectionAvailable = ref(false);
const namingInstance = ref<AgentInstance>();
const nodeName = ref("");
const savingName = ref(false);
const nameError = ref("");

function editName(instance: AgentInstance): void {
  namingInstance.value = instance;
  nodeName.value = instance.name || "";
  nameError.value = "";
}

async function saveName(): Promise<void> {
  const instance = namingInstance.value;
  if (!instance || savingName.value) return;
  savingName.value = true;
  nameError.value = "";
  try {
    await readJson(await fetch(instancePath(instance, "/name"), {
      method: "PUT",
      headers: { "content-type": "application/json", "x-rabiroute-webgui-token": connectionToken.value },
      body: JSON.stringify({ name: nodeName.value, expectedName: instance.name || "" })
    }));
    await refresh();
    if (error.value) throw new Error(error.value);
    if ((instances.value.find(item => item.instanceId === instance.instanceId)?.name || "") !== nodeName.value.trim()) {
      throw new Error("名称保存结果未确认，请刷新后核对。");
    }
    namingInstance.value = undefined;
  } catch (reason) {
    nameError.value = userFacingError(reason);
  } finally {
    savingName.value = false;
  }
}


async function copyInstallPrompt(): Promise<void> {
  if (issuingTicket.value) return;
  if (!targetPlatform.value) { error.value = "请先选择目标电脑系统。"; return; }
  const platform = targetPlatform.value;
  const target = { deviceId: ownerDeviceId.value, managerUrl: managerUrl.value, publicKeySha256: releasePublicKeySha256.value };
  error.value = "";
  copied.value = false;
  issuingTicket.value = true;
  try {
    const body = await readJson(await fetch(peerManagerPath(target.deviceId, "/api/lan-agent/enrollments"), {
      method: "POST", headers: { "x-rabiroute-webgui-token": connectionToken.value }
    }));
    const data = body.data as { ticket?: string; expiresAt?: number };
    if (target.deviceId !== ownerDeviceId.value) return;
    if (!data?.ticket || !Number.isFinite(data.expiresAt) || data.expiresAt! <= Date.now()) throw new Error("未取得有效的一次性接入票据，请刷新后重试。");
    ticketExpiresAt.value = new Date(data.expiresAt!).toISOString();
    await copyTextToClipboard(buildLanAgentBootstrapPrompt({ managerUrl: target.managerUrl, token: data.ticket, expiresAt: ticketExpiresAt.value, publicKeySha256: target.publicKeySha256, platform }));
    copied.value = true;
  } catch (reason) {
    error.value = userFacingError(reason);
  } finally {
    issuingTicket.value = false;
  }
}

const onlineCount = computed(() => instances.value.filter(instance => instance.connected).length);

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
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  const deviceId = ownerDeviceId.value;
  loading.value = true;
  error.value = "";
  releasePublicKeySha256.value = "";
  try {
    const access = await readJson(await fetch("/api/webgui-access", { cache: "no-store", signal: controller.signal }));
    if (controller.signal.aborted) return;
    const data = access.data as { enabled?: boolean; token?: string; listeningOnLan?: boolean; urls?: { url: string }[] };
    connectionToken.value = data.token || managerAccessToken();
    connectionAvailable.value = !deviceId && data.enabled === true && data.listeningOnLan === true;
    const init = { cache: "no-store" as const, signal: controller.signal, headers: { "x-rabiroute-webgui-token": connectionToken.value } };
    const [catalog, nodeCatalog, directory, meta] = await Promise.allSettled([
      fetch(peerManagerPath(deviceId, "/api/lan-agent/instances"), init).then(readJson),
      fetch(peerManagerPath(deviceId, "/api/lan-agent/nodes"), init).then(readJson),
      fetch("/api/rabilink/peer/servers", init).then(async response => { if (!response.ok) throw new Error("读取主机列表失败"); return response.json(); }),
      fetch(peerManagerPath(deviceId, "/meta"), init).then(async response => { if (!response.ok) throw new Error("读取主机状态失败"); return response.json(); })
    ]);
    if (controller.signal.aborted) return;
    if (directory.status === "fulfilled") {
      hosts.value = (directory.value.peers || []).filter((host: { deviceId: string }) => host.deviceId !== gatewayStore.meta.rabiLinkRelay?.deviceId);
      hostError.value = "";
    } else hostError.value = userFacingError(directory.reason);
    if (catalog.status === "rejected") throw catalog.reason;
    instances.value = (catalog.value.instances as AgentInstance[]).map(instance => ({ ...instance, ...(deviceId ? { ownerDeviceId: deviceId } : {}) }));
    if (meta.status === "fulfilled") {
      const lan = meta.value.webguiLan;
      connectionAvailable.value = deviceId ? lan?.enabled === true && lan?.listeningOnLan === true : connectionAvailable.value;
      const address = meta.value.lanDiscovery?.interfaces?.[0]?.address;
      if (address && meta.value.managerPort) managerUrl.value = `http://${address.includes(":") ? `[${address}]` : address}:${meta.value.managerPort}`;
      else if (deviceId) connectionAvailable.value = false;
    } else if (!deviceId && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) && data.urls?.[0]) managerUrl.value = new URL(data.urls[0].url).origin;
    if (nodeCatalog.status === "rejected") { nodes.value = []; tasks.value = []; error.value = userFacingError(nodeCatalog.reason); return; }
    const body = nodeCatalog.value;
    nodes.value = Array.isArray(body.nodes) ? body.nodes as NodeStatus[] : [];
    tasks.value = Array.isArray(body.tasks) ? body.tasks as Task[] : [];
    releaseVersion.value = text(body.releaseVersion);
    releasePublicKeySha256.value = text(body.releasePublicKeySha256);
  } catch (reason) {
    if (!controller.signal.aborted) error.value = userFacingError(reason);
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

async function requestUpdate(node: NodeStatus): Promise<void> {
  updatingNodeId.value = node.nodeId;
  error.value = "";
  try {
    await readJson(await fetch(peerManagerPath(ownerDeviceId.value, `/api/lan-agent/nodes/${encodeURIComponent(node.nodeId)}/update`), {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabiroute-webgui-token": connectionToken.value },
      body: JSON.stringify({ version: releaseVersion.value || undefined })
    }));
    await refresh();
  } catch (reason) {
    error.value = userFacingError(reason);
  } finally {
    updatingNodeId.value = "";
  }
}

watch(ownerDeviceId, () => {
  managerUrl.value = ""; releaseVersion.value = ""; releasePublicKeySha256.value = ""; connectionAvailable.value = false;
  copied.value = false; ticketExpiresAt.value = ""; enrollmentOpen.value = false;
  instances.value = []; nodes.value = []; tasks.value = [];
  namingInstance.value = undefined; addingInstanceId.value = "";
  void refresh();
});
onMounted(() => { void refresh(); });
onBeforeUnmount(() => { refreshController?.abort(); });
</script>

<template>
  <v-container class="lan-agents-page" fluid>
    <div class="d-flex flex-wrap align-center justify-space-between ga-2 mb-3">
      <div>
        <h2 class="text-subtitle-1 font-weight-bold">远端智能体</h2>
        <p class="text-body-2 lan-muted mb-0">{{ selectedHostName }} · 在线 {{ onlineCount }} / {{ instances.length }} 个执行实例。</p>
      </div>
      <div class="d-flex flex-wrap ga-2">
        <v-btn prepend-icon="mdi-plus" color="primary" @click="enrollmentOpen = true">接入一台电脑</v-btn>
        <v-btn :loading="loading" prepend-icon="mdi-refresh" variant="tonal" @click="refresh">刷新</v-btn>
      </div>
    </div>

    <v-select :model-value="ownerDeviceId" :items="hostItems" label="电脑主机" density="compact" :disabled="savingName || !!updatingNodeId || issuingTicket" @update:model-value="value => router.replace({ query: { ...route.query, deviceId: value || undefined } })" />
    <v-alert v-if="hostError" type="info" variant="tonal" class="mb-3">{{ hostError }}</v-alert>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-dialog :model-value="!!namingInstance" :persistent="savingName" max-width="480" @update:model-value="value => { if (!value && !savingName) namingInstance = undefined; }">
      <v-card title="修改名称">
        <v-card-text>
          <p class="text-caption mb-3">{{ namingInstance?.address || namingInstance?.instanceId }}</p>
          <v-text-field v-model="nodeName" label="电脑名称" :placeholder="namingInstance?.hostname || namingInstance?.instanceId" hint="留空使用电脑名；离线也可修改。" persistent-hint maxlength="80" counter="80" autofocus :disabled="savingName" @keydown.enter.prevent="saveName" />
          <v-alert v-if="nameError" type="error" variant="tonal" class="mt-3">{{ nameError }}</v-alert>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="savingName" @click="namingInstance = undefined">取消</v-btn><v-btn color="primary" :loading="savingName" @click="saveName">保存名称</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="enrollmentOpen" max-width="760">
    <v-card>
      <v-card-title>接入一台电脑</v-card-title>
      <v-card-text>
        <ol class="pl-5 mb-3">
          <li>选择目标电脑系统，复制对应的接入提示词。</li>
          <li>粘贴给目标电脑上的智能体，先检查已有安装，再接入、恢复或升级。</li>
          <li>电脑上线后可直接使用电脑接口；每次调用明确指定 Agent 类型和完整会话 ID。</li>
        </ol>
        <v-text-field v-model="managerUrl" label="目标电脑可访问的 RabiRoute 地址" hint="使用本机 RabiRoute 的局域网地址" density="compact" persistent-hint class="mb-2" />
        <v-select v-model="targetPlatform" :items="lanAgentBootstrapPlatforms" label="目标电脑系统" placeholder="请选择 Windows、Mac 或 Linux" item-title="title" item-value="value" :disabled="issuingTicket" density="compact" @update:model-value="copied = false" />
        <p class="text-caption mb-3">已有安装保留节点、凭据、任务和工作目录；验证新版运行后清理旧程序与重复启动项。首次接入只安装电脑客户端，无需登记或绑定智能体。</p>
        <v-btn prepend-icon="mdi-content-copy" color="primary" :loading="issuingTicket" :disabled="loading || issuingTicket || !targetPlatform || !connectionAvailable || !connectionToken || !releasePublicKeySha256" @click="copyInstallPrompt">复制接入提示词</v-btn>
        <p v-if="!connectionAvailable" class="text-caption mt-2">接入其他电脑前，请在设置中开启局域网访问，然后重启 RabiRoute。</p>
        <p class="text-caption mt-2">提示词含一次性票据，30 分钟内有效，成功兑换后立即失效。只粘贴到目标电脑的私密智能体任务中，无需手填管理密钥。</p>
        <v-alert v-if="copied" type="success" variant="tonal" density="compact" class="mt-2">已复制完整提示词（含 30 分钟一次性票据），有效期至 {{ formatTime(ticketExpiresAt) }}。请粘贴给目标电脑上的智能体，成功兑换后票据立即失效。</v-alert>
      </v-card-text>
      <v-card-actions><v-spacer /><v-btn @click="enrollmentOpen = false">关闭</v-btn></v-card-actions>
    </v-card>
    </v-dialog>
    <v-expansion-panels class="mb-4">
      <v-expansion-panel title="高级信息">
        <v-expansion-panel-text>
          <p>发布版本：{{ releaseVersion || "未发布" }}</p>
          <p v-if="releasePublicKeySha256" class="text-caption fingerprint">发布公钥 SHA-256：{{ releasePublicKeySha256 }}</p>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
    <v-alert v-if="!loading && !nodes.length" type="info" variant="tonal" class="mb-4">
      当前主机的终端与电脑能力可直接使用。只运行轻量客户端的其他电脑，可通过“接入一台电脑”加入此主机。
    </v-alert>

    <v-expansion-panels multiple>
      <v-expansion-panel v-for="instance in instances" :key="instance.instanceId">
        <v-expansion-panel-title>
          <span class="instance-title">{{ instance.local ? `实例：${selectedHostName}` : `${agentInstanceDisplayName(instance)}（${instance.address || "离线"}）` }}</span>
          <v-chip class="ml-3" size="small" :color="instance.connected ? 'success' : 'default'">{{ instance.connected ? "在线" : "离线" }}</v-chip>
          <v-btn v-if="!instance.local" class="ml-2" icon="mdi-pencil" size="small" variant="text" title="修改名称" aria-label="修改名称" @click.stop="editName(instance)" />
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <v-expansion-panels multiple>
            <v-expansion-panel v-for="agent in instance.agents" :key="agent.agentId">
              <v-expansion-panel-title>{{ agent.name }}</v-expansion-panel-title>
              <v-expansion-panel-text>
                <InstanceAgentSettings v-if="!instance.local || ['codex-desktop', 'dsh'].includes(agent.provider)" :instance="instance" :agent="agent" @saved="refresh" />
                <v-btn v-for="route in agentRoutes(instance, agent.agentId, agent.routeId)" :key="route.id" class="mt-3 mr-2" :to="routeScopedAdaptersPath(route.id)">{{ route.routeName || route.id }}：路由与智能体设置</v-btn>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
          <p v-if="!instance.agents.length" class="text-body-2 my-3">{{ instance.local ? '此实例还没有智能体。' : '按每次请求的 Agent 类型和完整会话 ID 使用执行程序；可按需配置连接参数。' }}</p>
          <v-btn class="mt-3 mr-2" variant="tonal" prepend-icon="mdi-monitor" :to="{path:'/rabilink',query:{tab:'computer',deviceId:instance.ownerDeviceId || undefined,instanceId:instance.instanceId}}">前往电脑控制</v-btn>
          <template v-if="!instance.local">
            <v-btn class="mt-3 mr-2" :disabled="!instance.connected" @click="addingInstanceId = addingInstanceId === instance.instanceId ? '' : instance.instanceId">配置执行程序</v-btn>
            <InstanceAgentSettings v-if="addingInstanceId === instance.instanceId" class="mt-4" :instance="instance" :agent="{ agentId: '', name: 'Agent', provider: instance.agents[0]?.provider || 'codex-desktop', enabled: true }" @saved="addingInstanceId = ''; refresh()" />
            <v-btn v-for="node in nodes.filter(node => node.nodeId === instance.instanceId)" :key="node.nodeId" class="mt-3" :disabled="!node.connected" :loading="updatingNodeId === node.nodeId" @click="requestUpdate(node)">更新连接程序至 {{ releaseVersion }}</v-btn>
          </template>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <v-card class="mt-3" variant="outlined">
      <v-card-title class="text-subtitle-1">最近任务</v-card-title>
      <v-table density="compact">
        <thead><tr><th>节点</th><th>状态</th><th>更新时间</th><th>结果</th></tr></thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.taskId">
            <td :title="task.nodeId">{{ agentInstanceDisplayName(instances.find(instance => instance.instanceId === task.nodeId) || { instanceId: task.nodeId }) }}</td><td>{{ task.status }}</td><td>{{ formatTime(task.updatedAt) }}</td><td>{{ task.error || task.result || "—" }}</td>
          </tr>
          <tr v-if="!tasks.length"><td colspan="4" class="lan-muted">暂无任务记录。</td></tr>
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
.instance-title { overflow-wrap: anywhere; }
</style>
