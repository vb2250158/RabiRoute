<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import { resolvePrimaryAgentTarget } from "@shared/routeAgentTargets";
import { managerEventSource } from "../managerApi";
import type { AgentAdapterType, AgentScanResult, AgentScanSession } from "../types";
import type { AgentAdapterCardContext } from './agentAdapterCardContext';

const props = defineProps<{ context: AgentAdapterCardContext }>();

const store = useGatewayStore();

const gateway = computed(() => store.selectedGateway?.id === props.context.routeId ? store.selectedGateway : undefined);

const runtime = computed(() => props.context.runtime);

const agentScan = computed(() => props.context.scanState);

const agent = { type: "copilotCli" as AgentAdapterType };

function touch(): void { props.context.touch(); }

async function runAgentScan(): Promise<void> { await props.context.refreshScan(); }

const copilotStatus = ref<{ installed?: boolean; binPath?: string; loggedIn?: boolean; copilotHome?: string } | null>(null);

const copilotInstalling = ref(false);

let loginEvents: ReturnType<typeof managerEventSource> | undefined;

let disposed = false;

onBeforeUnmount(() => { disposed = true; loginEvents?.close(); });

const copilotLoginState = ref<{ loading: boolean; code: string | null; url: string | null; done: boolean; error: string | null }>({
  loading: false, code: null, url: null, done: false, error: null
});

async function fetchCopilotStatus(): Promise<void> {
  try {
    const res = await fetch("/api/agent/copilot-status");
    copilotStatus.value = await res.json();
  } catch { /* ignore */ }
}

async function installCopilotCli(): Promise<void> {
  if (copilotInstalling.value) return;
  copilotInstalling.value = true;
  try {
    const res = await fetch("/api/agent/copilot-install", { method: "POST" });
    const data = await res.json();
    if (data.ok) await fetchCopilotStatus();
    else copilotLoginState.value.error = data.stderr || data.error || "安装失败";
  } catch (e) { copilotLoginState.value.error = String(e); }
  finally { copilotInstalling.value = false; }
}

async function startCopilotLogin(): Promise<void> {
  copilotLoginState.value = { loading: true, code: null, url: null, done: false, error: null };
  try {
    const res = await fetch("/api/agent/copilot-login", { method: "POST" });
    const data = await res.json();
    if (disposed) return;
    if (data.done) {
      copilotLoginState.value = { loading: false, code: null, url: null, done: true, error: null };
      await fetchCopilotStatus();
    } else if (data.code) {
      copilotLoginState.value = { loading: false, code: data.code, url: data.url, done: false, error: null };
      const events = managerEventSource("/api/events");
      loginEvents?.close();
      loginEvents = events;
      events.addEventListener("copilot_login_status", async (raw) => {
        const event = JSON.parse((raw as MessageEvent).data || "{}");
        events.close();
        if (event.done) {
          await fetchCopilotStatus();
          copilotLoginState.value.done = true;
          copilotLoginState.value.code = null;
        } else {
          copilotLoginState.value.error = event.error || "登录失败";
        }
      });
    } else {
      copilotLoginState.value = { loading: false, code: null, url: null, done: false, error: data.error || "启动失败" };
    }
  } catch (e) {
    copilotLoginState.value = { loading: false, code: null, url: null, done: false, error: String(e) };
  }
}

const primaryAgent = computed(() => gateway.value ? resolvePrimaryAgentTarget(gateway.value) : undefined);

const primaryLocalAgentType = computed(() => primaryAgent.value?.binding ? undefined : primaryAgent.value?.provider);

function agentStateFor(type: AgentAdapterType): Record<string, any> {
  // Provider-only runtime state belongs to the selected owner, not every same-provider card.
  if (primaryAgent.value?.binding || primaryLocalAgentType.value !== type) return {};
  return runtime.value.agentStates?.[type] ?? {};
}

function normalizeClientPath(value?: string): string {
  return (value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function samePath(left?: string, right?: string): boolean {
  const a = normalizeClientPath(left);
  const b = normalizeClientPath(right);
  return Boolean(a && b && a === b);
}

function agentScanFor(type: AgentAdapterType): AgentScanResult | undefined { return agentScan.value.agents[type]; }

function currentAgentProject(_type: AgentAdapterType): string { return gateway.value?.copilotCwd || ""; }

function agentProjectItems(type: AgentAdapterType): string[] {
  const projects = agentScanFor(type)?.projects ?? [];
  if (projects.length) return projects.map(project => project.path);
  return agentScan.value.cwdOptions;
}

function agentSessions(_type: AgentAdapterType): AgentScanSession[] {
  return agentScan.value.agents.copilotCli?.sessions ?? agentScan.value.copilotSessions.map(session => ({ name: session.name, projectPath: session.cwd, userNamed: session.userNamed }));
}

function sessionNamesFor(type: AgentAdapterType): string[] {
  const selectedProject = currentAgentProject(type);
  return [...new Set(agentSessions(type)
    .filter(session => !selectedProject || !session.projectPath || samePath(session.projectPath, selectedProject))
    .map(session => session.name))];
}

function selectCopilotSession(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.copilotThreadName = String(value || "");
  touch();
  const selected = agentSessions("copilotCli").find(session => session.name === gateway.value?.copilotThreadName);
  if (selected?.projectPath && !gateway.value.copilotCwd) {
    gateway.value.copilotCwd = selected.projectPath;
  }
}

onMounted(() => { void fetchCopilotStatus(); });
</script>
<template>
  <div v-if="gateway">
<div class="catalog-param-grid">
                    <v-combobox v-model="gateway.copilotCliBin" :items="agentScan.copilotBins" label="CLI 可执行路径" placeholder="copilot" hint="留空则使用 PATH 中的 copilot" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.copilotBins.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.copilotCwd" :items="agentProjectItems('copilotCli')" label="工作目录 (-C)" placeholder="留空则使用 RabiRoute 根目录" hint="copilot -C &lt;目录&gt;，影响会话分组" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentProjectItems('copilotCli').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                    <v-combobox v-model="gateway.copilotThreadName" :items="sessionNamesFor('copilotCli')" label="会话线程名" placeholder="Rabi" hint="Copilot CLI session 名称（--name 参数）" persistent-hint @update:model-value="selectCopilotSession">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="sessionNamesFor('copilotCli').length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div><!-- 安装/登录操作区 --><div class="agent-action-bar mt-2">
                    <div class="agent-action-status">
                      <span v-if="copilotStatus === null" class="section-note">检测中…</span>
                      <template v-else>
                        <v-chip size="x-small" :color="copilotStatus.installed ? 'success' : 'error'" variant="tonal" class="mr-1">
                          {{ copilotStatus.installed ? '已安装' : '未安装' }}
                        </v-chip>
                        <v-chip size="x-small" :color="copilotStatus.loggedIn ? 'success' : 'warning'" variant="tonal">
                          {{ copilotStatus.loggedIn ? '已登录' : '未登录' }}
                        </v-chip>
                      </template>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-btn v-if="copilotStatus && !copilotStatus.installed" size="small" variant="tonal" color="primary"
                        :loading="copilotInstalling" prepend-icon="mdi-download" @click="installCopilotCli">
                        安装 Copilot CLI
                      </v-btn>
                      <v-btn v-if="copilotStatus && copilotStatus.installed && !copilotStatus.loggedIn && !copilotLoginState.code"
                        size="small" variant="tonal" color="secondary"
                        :loading="copilotLoginState.loading" prepend-icon="mdi-login" @click="startCopilotLogin">
                        登录
                      </v-btn>
                      <v-btn v-if="copilotStatus" size="small" variant="text" icon="mdi-refresh" @click="fetchCopilotStatus" title="刷新状态" />
                    </div>
                  </div><!-- 登录 device code --><v-alert v-if="copilotLoginState.code" type="info" variant="tonal" density="compact" class="mt-2">
                    <div class="d-flex align-center justify-space-between flex-wrap ga-2">
                      <div>
                        在浏览器访问 <a :href="copilotLoginState.url ?? 'https://github.com/login/device'" target="_blank">github.com/login/device</a>，输入验证码：
                        <strong class="ml-1" style="font-size:1.1em;letter-spacing:2px">{{ copilotLoginState.code }}</strong>
                      </div>
                      <v-chip size="small" color="info" variant="tonal">等待授权…</v-chip>
                    </div>
                  </v-alert><v-alert v-if="copilotLoginState.done" type="success" variant="tonal" density="compact" class="mt-2">登录成功</v-alert><v-alert v-if="copilotLoginState.error" type="error" variant="tonal" density="compact" class="mt-2">{{ copilotLoginState.error }}</v-alert><!-- 运行时诊断 --><template v-if="runtime.running !== undefined">
                    <div class="mt-2">
                      <template v-if="agentStateFor('copilotCli').lastNotificationError">
                        <v-alert type="warning" variant="tonal" density="compact" class="mb-1">
                          {{ agentStateFor('copilotCli').lastNotificationError }}
                        </v-alert>
                      </template>
                      <div class="status-row"><span>最后成功</span><b>{{ agentStateFor('copilotCli').lastNotificationAt || "-" }}</b></div>
                      <div class="status-row"><span>来源</span><b>{{ agentStateFor('copilotCli').monitorThreadSource || "-" }}</b></div>
                      <div class="status-row"><span>状态文件</span><b>{{ agentStateFor('copilotCli').statePath || "-" }}</b></div>
                    </div>
                  </template>
  </div>
</template>
