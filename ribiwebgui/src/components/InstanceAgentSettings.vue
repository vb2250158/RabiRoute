<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { onMounted, ref, watch } from "vue";
import type { AgentInstance, InstanceAgent } from "@shared/agentInstance";
import { managerAccessToken } from "../managerApi";
type AuthorizationSnapshot = { nodes: Array<{ nodeId: string; enabledAgentIds: string[] }> };
const props = defineProps<{ instance: AgentInstance; agent: InstanceAgent; authorization?: AuthorizationSnapshot }>();
const emit = defineEmits<{ saved: [] }>();
const draft = ref({ ...props.agent });
const busy = ref(false);
const error = ref("");
const notice = ref("");
const sessions = ref<Array<{ id?: string; name: string }>>([]);
const models = ref<Array<{ id: string; name: string }>>([]);
const warnings = ref<string[]>([]);
const projects = ref<string[]>([]);
const authorizationBusy = ref(false);
const authorized = ref(false);
const enrolled = ref(false);
function applyAuthorization(snapshot?: AuthorizationSnapshot) {
  const node = snapshot?.nodes.find(node => node.nodeId === props.instance.instanceId);
  enrolled.value = Boolean(node);
  authorized.value = node?.enabledAgentIds.includes(props.agent.agentId) === true;
}
watch(() => [props.authorization, props.instance.instanceId, props.agent.agentId], () => applyAuthorization(props.authorization), { immediate: true });
watch(() => props.agent, value => { draft.value = { ...value }; });
onMounted(async () => {
  // Route settings also embed this component, without the parent catalog snapshot.
  if (props.instance.local || props.authorization || !props.agent.agentId) return;
  authorizationBusy.value = true;
  try {
    const access = await fetch("/api/webgui-access").then(response => response.json());
    const response = await fetch("/api/lan-agent/instances", { cache: "no-store", headers: { "x-rabiroute-webgui-token": access.data?.token || managerAccessToken() } });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.authorization) throw new Error(body.message || "无法读取总控启用状态，请刷新后再操作。");
    applyAuthorization(body.authorization);
    if (!enrolled.value) error.value = "此节点缺少独立凭据，请使用新的接入提示词重新接入；不能迁移旧 WebGUI token。";
  } catch (reason) { error.value = userFacingError(reason); }
  finally { authorizationBusy.value = false; }
});
function createAuthorizationKey(): string {
  const random = globalThis.crypto;
  if (typeof random?.randomUUID === "function") return random.randomUUID();
  if (typeof random?.getRandomValues !== "function") throw new Error("浏览器不支持安全随机数，无法修改启用状态；请使用支持 Web Crypto 的浏览器。");
  return Array.from(random.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function setAuthorization(enabled: boolean | null) {
  if (authorizationBusy.value || busy.value || !props.agent.agentId || props.instance.local || typeof enabled !== "boolean") return;
  const previous = authorized.value;
  // Freeze the displayed, saved binding before any await; never approve draft or newly fetched remote claims.
  const binding = enabled ? {
    provider: props.agent.provider,
    sessionId: props.agent.sessionId,
    managedSessionIds: [...(props.agent.managedSessionIds || [])]
  } : undefined;
  authorizationBusy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const idempotencyKey = createAuthorizationKey();
    const access = await fetch("/api/webgui-access").then(response => response.json());
    const headers = { "x-rabiroute-webgui-token": access.data?.token || managerAccessToken() };
    const catalogResponse = await fetch("/api/lan-agent/instances", { cache: "no-store", headers });
    const catalog = await catalogResponse.json();
    if (!catalogResponse.ok || catalog.code !== 0 || !catalog.authorization) throw new Error(catalog.message || "无法读取总控启用状态");
    applyAuthorization(catalog.authorization);
    if (!enrolled.value) throw new Error("此节点缺少独立凭据，请使用新的接入提示词重新接入；不能迁移旧 WebGUI token。");
    const etag = catalogResponse.headers.get("etag");
    if (!etag || !/^"[^"\x00-\x20\x7f]+"$/.test(etag)) throw new Error("总控未返回强 ETag，未修改启用状态，请刷新后重试。");
    const response = await fetch(`/api/lan-agent/instances/${encodeURIComponent(props.instance.instanceId)}/agents/${encodeURIComponent(props.agent.agentId)}/authorization`, {
      method: "PUT", headers: { ...headers, "content-type": "application/json", "If-Match": etag, "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ enabled, ...(binding ? { binding } : {}) })
    });
    if (response.status === 412) {
      const latestResponse = await fetch("/api/lan-agent/instances", { cache: "no-store", headers });
      const latest = await latestResponse.json();
      if (!latestResponse.ok || latest.code !== 0 || !latest.authorization) throw new Error("启用状态已被其他操作修改；刷新失败，请手动刷新后确认。未自动重试。");
      applyAuthorization(latest.authorization);
      error.value = "启用状态已被其他操作修改，已刷新当前状态。请确认后重新操作，未自动重试。";
      return;
    }
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error(body.message || "修改总控启用状态失败");
    if (!body.authorization) throw new Error("未收到启用状态，请刷新核对；不要直接重试。");
    applyAuthorization(body.authorization);
    notice.value = authorized.value ? "Agent 已启用" : "Agent 已停用";
  } catch (reason) {
    authorized.value = previous;
    error.value = `${userFacingError(reason)} 如请求已发出但回执不确定，请先刷新核对，不要直接重试。`;
  } finally {
    authorizationBusy.value = false;
  }
}
async function operate(operation: string, params: Record<string, unknown>): Promise<any> {
  if (busy.value || authorizationBusy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const access = await fetch("/api/webgui-access").then(response => response.json());
    const suffix = !props.agent.agentId && operation === "configure" ? "" : `/${encodeURIComponent(props.agent.agentId || "new-agent")}/${operation}`;
    const response = await fetch(`/api/lan-agent/instances/${encodeURIComponent(props.instance.instanceId)}/agents${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", "x-rabiroute-webgui-token": access.data?.token || managerAccessToken() }, body: JSON.stringify(params)
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error(body.message || "保存失败");
    if (body.result?.statusCode >= 400) throw new Error(body.result.data?.message || body.result.data?.error || "任务操作失败");
    return body.result;
  } catch (reason) { error.value = userFacingError(reason); }
  finally { busy.value = false; }
}
async function save() {
  // The Manager-owned switch uses the authorization endpoint; saving remote parameters must not change it.
  const params = props.instance.local ? draft.value : { ...draft.value, enabled: true };
  if (await operate("configure", params)) { notice.value = "已保存到实例"; emit("saved"); }
}
async function scan() {
  const result = await operate("scan", { provider: draft.value.provider === "codex-desktop" ? "codex" : draft.value.provider, dshBaseUrl: draft.value.dshBaseUrl });
  const scan = result?.agents?.[draft.value.provider === "codex-desktop" ? "codex" : draft.value.provider];
  if (scan) { sessions.value = scan.sessions || []; models.value = scan.models || []; warnings.value = scan.warnings || []; projects.value = (scan.projects || []).map((project: any) => project.path || project.projectPath).filter(Boolean); }
}
async function hooks() {
  const result = await operate("hooks", { provider: props.agent.provider === "codex-desktop" ? "codex" : props.agent.provider });
  if (result) notice.value = result.message;
}
async function openTask() {
  const result = await operate("threads", { action: "open", threadId: draft.value.sessionId, cwd: draft.value.workspace, agentAdapter: props.agent.provider === "codex-desktop" ? "codex" : props.agent.provider });
  if (result) notice.value = "已请求在此实例的任务宿主中打开任务";
}
async function initializeTask() {
  const result = await operate("threads", { action: "resolve", title: draft.value.name, cwd: draft.value.workspace, createIfMissing: true, agentAdapter: draft.value.provider === "codex-desktop" ? "codex" : draft.value.provider, dshBaseUrl: draft.value.dshBaseUrl });
  if (result?.data?.thread?.id) {
    draft.value.sessionId = result.data.thread.id;
    draft.value.workspace = result.data.thread.cwd || draft.value.workspace;
    notice.value = "任务已就绪，保存到实例后开始使用";
  }
}
</script>
<template>
  <div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="notice" type="info" variant="tonal" class="mb-3">{{ notice }}</v-alert>
    <v-switch v-if="instance.local" v-model="draft.enabled" label="是否启用Agent" :disabled="!instance.connected || busy" />
    <template v-else>
      <v-switch :model-value="authorized" label="是否启用Agent" :loading="authorizationBusy" :disabled="!agent.agentId || !enrolled || busy || authorizationBusy" @update:model-value="setAuthorization" />
      <v-alert v-if="agent.agentId && authorization && !enrolled" type="warning" variant="tonal" class="mb-3">此节点缺少独立凭据，请使用新的接入提示词重新接入，不能迁移旧 WebGUI token。</v-alert>
    </template>
    <v-text-field v-model="draft.name" label="Agent 名称" />
    <v-select v-if="!agent.agentId" v-model="draft.provider" label="此 Agent 的执行程序" :items="[{ title: 'Codex Desktop', value: 'codex-desktop' }, { title: 'DSH', value: 'dsh' }]" />
    <v-text-field v-if="draft.provider === 'dsh'" v-model="draft.dshBaseUrl" label="该电脑上的 DSH 服务地址" hint="使用该电脑实际运行的本机 DSH 地址" persistent-hint />
    <v-combobox v-model="draft.workspace" :items="projects" label="工作目录" />
    <v-combobox v-model="draft.sessionId" label="任务（名称与 ID）" :items="sessions.map(session => ({ title: `${session.name} · ${session.id}`, value: session.id }))" :return-object="false" />
    <v-combobox v-model="draft.model" label="模型" :items="models.map(model => ({ title: model.name, value: model.id }))" :return-object="false" />
    <v-combobox v-model="draft.reasoningEffort" label="推理强度" :items="['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']" />
    <v-btn :disabled="!instance.connected" :loading="busy" color="primary" @click="save">保存到实例</v-btn>
    <v-btn class="ml-2" :disabled="!instance.connected || busy" @click="scan">刷新任务与环境</v-btn>
    <v-btn class="ml-2" :disabled="!instance.connected || busy" @click="openTask">打开任务</v-btn>
    <v-btn class="ml-2" :disabled="!instance.connected || busy || !draft.name || !draft.workspace" @click="initializeTask">初始化任务</v-btn>
    <v-btn class="ml-2" :disabled="!instance.connected || busy" @click="hooks">更新 Hook</v-btn>
    <v-alert v-for="warning in warnings" :key="warning" type="warning" variant="tonal" class="mt-2">{{ warning }}</v-alert>
  </div>
</template>
