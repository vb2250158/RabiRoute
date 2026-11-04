<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import type { AgentAdapterType, AgentScanResult } from "../types";
import type { AgentAdapterCardContext } from './agentAdapterCardContext';

const props = defineProps<{ context: AgentAdapterCardContext }>();

const store = useGatewayStore();

const gateway = computed(() => store.selectedGateway?.id === props.context.routeId ? store.selectedGateway : undefined);

const agentScan = computed(() => props.context.scanState);

const agent = { type: "astrbot" as AgentAdapterType };

function touch(): void { props.context.touch(); }

async function runAgentScan(): Promise<void> { await props.context.refreshScan(); }

const route = useRoute();

const testingAstrbotLogin = ref(false);

const astrbotLoginResult = ref<{ ok: boolean; message: string } | null>(null);

function agentScanFor(type: AgentAdapterType): AgentScanResult | undefined {
  const scan = agentScan.value.agents[type];
  if (type !== "astrbot" || !gateway.value) return scan;

  const localUrl = gateway.value.astrbotUrl?.trim();
  const localPassword = gateway.value.astrbotPassword?.trim();
  const endpoints = [...(scan?.endpoints ?? [])];
  if (localUrl && !endpoints.some(endpoint => endpoint.url === localUrl)) {
    endpoints.unshift({ label: "当前 AstrBot", url: localUrl });
  }

  if (!scan) {
    return {
      type: "astrbot",
      label: "AstrBot",
      maturity: "experimental",
      installed: false,
      auth: {
        required: true,
        loggedIn: false,
        message: localPassword ? "已填写本地 AstrBot 密码，保存后写入 route 配置。" : "缺少 AstrBot 密码；请填写本地配置或设置 ASTRBOT_PASSWORD。"
      },
      endpoints,
      warnings: []
    };
  }

  return {
    ...scan,
    endpoints,
    auth: localPassword
      ? {
          ...(scan.auth ?? { required: true }),
          required: true,
          loggedIn: scan.auth?.loggedIn,
          message: scan.auth?.loggedIn ? scan.auth.message : (scan.auth?.message || "已填写本地 AstrBot 密码，尚未验证登录。")
        }
      : scan.auth
  };
}

function astrbotProjectItems(): Array<{ title: string; value: string; path?: string }> {
  return (agentScanFor("astrbot")?.projects ?? []).map(project => ({
    title: project.label || project.path || project.id || "未命名项目",
    value: project.id || project.path,
    path: project.path
  }));
}

function astrbotSessionItems(): Array<{ title: string; value: string; subtitle?: string }> {
  const projectId = gateway.value?.astrbotProjectId || "";
  return (agentScanFor("astrbot")?.sessions ?? [])
    .filter(session => !projectId || session.projectId === projectId)
    .map(session => ({
      title: session.name,
      value: session.id || session.name,
      subtitle: session.projectPath || session.updatedAt
    }));
}

function selectAstrbotProject(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.astrbotProjectId = String(value || "");
  const sessions = astrbotSessionItems();
  if (gateway.value.astrbotSessionId && !sessions.some(session => session.value === gateway.value?.astrbotSessionId)) {
    gateway.value.astrbotSessionId = "";
  }
  touch();
}

function selectAstrbotSession(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.astrbotSessionId = String(value || "");
  const selected = (agentScanFor("astrbot")?.sessions ?? []).find(session => (session.id || session.name) === gateway.value?.astrbotSessionId);
  if (selected?.projectId && !gateway.value.astrbotProjectId) {
    gateway.value.astrbotProjectId = selected.projectId;
  }
  touch();
}

async function testAstrbotLogin(): Promise<void> {
  if (!gateway.value) return;
  testingAstrbotLogin.value = true;
  astrbotLoginResult.value = null;
  try {
    const resp = await fetch("/api/agent/astrbot-login-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: gateway.value.astrbotUrl,
        username: gateway.value.astrbotUsername,
        password: gateway.value.astrbotPassword
      })
    });
    const body = await resp.json().catch(() => ({}));
    astrbotLoginResult.value = {
      ok: Boolean(body.ok),
      message: body.message || (resp.ok ? "AstrBot 登录验证成功。" : "AstrBot 登录验证失败。")
    };
  } catch (e: unknown) {
    astrbotLoginResult.value = { ok: false, message: userFacingError(e) };
  } finally {
    testingAstrbotLogin.value = false;
  }
}
</script>
<template>
  <div v-if="gateway">
<v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    AstrBot 必须绑定 ChatUI 项目和会话；消息只通过 /api/chat/send 投递。
                  </v-alert><div class="catalog-param-grid">
                    <v-combobox
                      v-model="gateway.astrbotUrl"
                      :items="agentScanFor('astrbot')?.endpoints?.map(endpoint => endpoint.url) ?? []"
                      label="AstrBot 地址"
                      placeholder="http://127.0.0.1:6185"
                      hint="AstrBot ChatUI 地址；消息只通过 /api/chat/send 投递"
                      persistent-hint
                      @update:model-value="touch"
                    >
                    </v-combobox>
                    <v-text-field
                      v-model="gateway.astrbotUsername"
                      label="AstrBot 用户名"
                      placeholder="留空使用环境变量 ASTRBOT_USERNAME"
                      hint="不填则默认沿用适配器默认用户名"
                      persistent-hint
                      @update:model-value="touch"
                    />
                    <v-text-field
                      v-model="gateway.astrbotPassword"
                      type="password"
                      label="AstrBot 密码"
                      placeholder="留空则使用环境变量 ASTRBOT_PASSWORD"
                      hint="仅写入本地 route 配置；也可用私有环境变量提供"
                      persistent-hint
                      @update:model-value="touch"
                    />
                    <v-select
                      v-model="gateway.astrbotProjectId"
                      :items="astrbotProjectItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 项目"
                      placeholder="可选：先选项目再筛选会话"
                      hint="来自 AstrBot ChatUI 项目列表；没有项目也可以直接选会话"
                      persistent-hint
                      clearable
                      @update:model-value="selectAstrbotProject"
                    >
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-select>
                    <v-select
                      v-model="gateway.astrbotSessionId"
                      :items="astrbotSessionItems()"
                      item-title="title"
                      item-value="value"
                      label="AstrBot 会话"
                      placeholder="选择一个 ChatUI 会话"
                      hint="选择后消息通过 /api/chat/send 投递；未选择时不可用"
                      persistent-hint
                      clearable
                      @update:model-value="selectAstrbotSession"
                    >
                      <template #item="{ props, item }">
                        <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
                      </template>
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else icon="mdi-refresh" size="18" class="scan-btn" title="重新扫描" @click.stop="runAgentScan" />
                      </template>
                    </v-select>
                  </div><div class="mt-2">
                    <div
                      v-for="endpoint in agentScanFor('astrbot')?.endpoints ?? []"
                      :key="endpoint.url"
                      class="status-row"
                    >
                      <span>{{ endpoint.label }}</span>
                      <b :class="endpoint.healthy ? 'text-success' : 'text-warning'">{{ endpoint.url }} · {{ endpoint.healthy ? "可访问" : "未响应" }}</b>
                    </div>
                    <div class="status-row">
                      <span>鉴权</span>
                      <b :class="agentScanFor('astrbot')?.auth?.loggedIn ? 'text-success' : 'text-warning'">
                        {{ agentScanFor('astrbot')?.auth?.message || "-" }}
                      </b>
                    </div>
                    <div class="status-row">
                      <span>ChatUI 会话</span>
                      <b :class="astrbotSessionItems().length ? 'text-success' : 'text-warning'">
                        {{ astrbotSessionItems().length ? `可选 ${astrbotSessionItems().length} 个` : "未读取到会话" }}
                      </b>
                    </div>
                    <div
                      v-for="plugin in agentScanFor('astrbot')?.plugins ?? []"
                      :key="plugin.id"
                      class="status-row"
                    >
                      <span>{{ plugin.name }}</span>
                      <b :class="plugin.installed ? 'text-success' : 'text-warning'">{{ plugin.installed ? "已安装" : "未安装" }}</b>
                    </div>
                  </div><div class="agent-action-bar mt-2">
                    <div class="agent-action-status">
                      <span class="section-note">用当前填写的地址、用户名和密码请求 AstrBot 登录接口。</span>
                    </div>
                    <v-btn
                      size="small"
                      variant="tonal"
                      color="secondary"
                      prepend-icon="mdi-login-variant"
                      :loading="testingAstrbotLogin"
                      :disabled="testingAstrbotLogin"
                      @click="testAstrbotLogin"
                    >
                      验证登录
                    </v-btn>
                  </div><v-alert
                    v-if="astrbotLoginResult"
                    :type="astrbotLoginResult.ok ? 'success' : 'error'"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                  >
                    {{ astrbotLoginResult.message }}
                  </v-alert>
  </div>
</template>
