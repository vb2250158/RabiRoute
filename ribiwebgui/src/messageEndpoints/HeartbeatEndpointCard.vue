<script setup lang="ts">
import { computed, ref } from "vue";
import { userFacingError } from "../userFacingError";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import { normalizeAgentRecipients, resolveAgentDeliveryExecutor } from "@shared/agentDeliveryTarget";
import type { MessageAdapterType } from "../types";
import { adapterRuntimeKey, adapterErrorsFor, applyAdapterDefaults, configNameFor, isMessageInputsDisabled } from "../utils/gatewayHelpers";
import { routeScopedRuntimePath } from "../routeScopedNavigation";
import MessageEndpointDependencyPanel from "./MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const route = useRoute();

const router = useRouter();

const runtime = computed(() => store.selectedRuntime);

const gateway = computed(() => store.selectedGateway);

const messageInputsDisabled = computed(() => gateway.value ? isMessageInputsDisabled(gateway.value) : false);

const messageAdapterInactive = computed(() => Boolean(gateway.value?.enabled === false || runtime.value.enabled === false || messageInputsDisabled.value));

const heartbeatState = computed(() => runtime.value.gatewayStatus?.heartbeat || {} as Record<string, any>);

const adapterErrors = (type: MessageAdapterType) => gateway.value ? adapterErrorsFor(type, gateway.value, runtime.value) : [];

const triggeringHeartbeat = ref(false);

const heartbeatTriggerResult = ref<{ ok: boolean; message: string } | null>(null);

function adapterLogEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return runtime.value.adapterLogs?.[adapterRuntimeKey(type)]?.entries ?? [];
}

function adapterLogPaths(type: MessageAdapterType): string[] {
  return runtime.value.adapterLogs?.[adapterRuntimeKey(type)]?.paths ?? [];
}

function messageFileEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return runtime.value.messageFiles?.[adapterRuntimeKey(type)]?.entries ?? [];
}

function messageFilePaths(type: MessageAdapterType): string[] {
  return runtime.value.messageFiles?.[adapterRuntimeKey(type)]?.paths ?? [];
}

function formatLogTime(entry: Record<string, any>): string {
  const ms = Number(entry.timeMs || 0);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toLocaleString();
  }
  if (entry.time) return String(entry.time);
  return "-";
}

function logPreview(entry: Record<string, any>): string {
  const text = String(entry.text || entry.message || "");
  if (text) return text;
  try {
    return JSON.stringify(entry.raw ?? entry, null, 2);
  } catch {
    return String(entry.raw ?? "");
  }
}

function logEventTitle(entry: Record<string, any>): string {
  return [entry.level && entry.level !== "info" ? String(entry.level) : "", entry.event || entry.source || "log"]
    .filter(Boolean)
    .join(" · ");
}

function rawLogJson(entry: Record<string, any>): string {
  try {
    return JSON.stringify(entry.raw ?? entry, null, 2);
  } catch {
    return String(entry.raw ?? "");
  }
}

function touch(): void { if (gateway.value) applyAdapterDefaults(gateway.value); store.touch(); }

function openRuntimeLog(): void {
  const name = store.selectedGateway ? configNameFor(store.selectedGateway) : "";
  void router.push(routeScopedRuntimePath(name));
}

async function triggerHeartbeatNow(): Promise<void> {
  if (!gateway.value || triggeringHeartbeat.value) return;
  triggeringHeartbeat.value = true;
  heartbeatTriggerResult.value = null;
  try {
    const result = await store.manualTriggerGateway(gateway.value.id, {
      triggerId: "heartbeat-now",
      triggerName: "立即触发心跳",
      routeKind: "heartbeat",
      message: gateway.value.heartbeatMessage || "定时心跳巡检：请按当前计划、记忆和可用状态执行必要检查。"
    });
    heartbeatTriggerResult.value = {
      ok: true,
      message: result.alreadyRunning
        ? "这次心跳已经在后台投递中，没有重复启动；请到运行日志查看最终结果。"
        : "心跳已接受，正在后台投递；请到运行日志查看最终结果。"
    };
  } catch (e: unknown) {
    heartbeatTriggerResult.value = { ok: false, message: userFacingError(e) };
  } finally {
    triggeringHeartbeat.value = false;
  }
}

const managedMessageAgentModeEnabled = computed(() => (
  gateway.value?.automationRules?.some(rule => {
    if (rule.enabled === false || rule.action.type !== "deliver_agent" || !rule.action.target) return false;
    try { return resolveAgentDeliveryExecutor(rule.action.target, normalizeAgentRecipients(gateway.value?.agentRecipients)) === "message_pool"; }
    catch { return false; }
  }) ?? false
));
const endpointProps = defineProps<{ context?: import("./messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

</script>
<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading" :error="context?.scanError" @refresh="context?.refreshScan?.()"  />
<div class="catalog-param-grid">
                    <v-alert v-if="managedMessageAgentModeEnabled" class="full-span" type="success" variant="tonal" density="compact">
                      Codex 消息处理 Agent已开启。heartbeat 会立即交给独立消息处理 Agent，不会因为主角色会话正在工作而跳过，也不进入聊天消息合并等待。
                    </v-alert>
                    <v-alert v-else class="full-span" type="info" variant="tonal" density="compact">
                      定时计划在“角色配置 / 消息模板规则”的 heartbeat 规则里维护。下面的忙时策略只影响 heartbeat，普通群聊、私聊和其他消息仍按正常路由直接投递。
                    </v-alert>
                    <v-switch
                      v-if="!managedMessageAgentModeEnabled"
                      v-model="gateway.heartbeatSkipWhenAgentBusy"
                      class="full-span"
                      color="primary"
                      label="会话工作中时跳过心跳"
                      hint="开启后，仅当 Agent 会话仍在工作时把本次 heartbeat 记为 skipped；普通消息不受影响。"
                      persistent-hint
                      @update:model-value="touch"
                    />
                  </div>
<template v-if="runtime.running !== undefined">
                    <v-alert v-if="adapterErrors('heartbeat').length" type="error" variant="tonal" density="compact" class="mt-2 mb-1">
                      <div v-for="reason in adapterErrors('heartbeat')" :key="reason" class="text-body-2">{{ reason }}</div>
                    </v-alert>
                    <div class="status-row"><span>运行状态</span><b :class="messageAdapterInactive ? 'route-config-muted-text' : ''">{{ gateway.enabled === false || runtime.enabled === false ? "已关闭" : runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>触发器状态</span><b :class="messageAdapterInactive ? 'route-config-muted-text' : heartbeatState.enabled === false ? 'text-error' : 'text-success'">{{ messageAdapterInactive ? "未启用" : heartbeatState.enabled === false ? "未启用" : "已启用" }}</b></div>
                    <div class="status-row"><span>计划数量</span><b>{{ heartbeatState.scheduleCount ?? "-" }}</b></div>
                    <div class="status-row"><span>下次触发</span><b>{{ heartbeatState.nextTickAt || "-" }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">立即触发会向当前 Agent 端投递一条心跳消息；日志页可看完整结果。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn
                          size="small"
                          variant="tonal"
                          color="secondary"
                          prepend-icon="mdi-play-circle-outline"
                          :loading="triggeringHeartbeat"
                          :disabled="triggeringHeartbeat || !runtime.running"
                          @click="triggerHeartbeatNow"
                        >
                          立即触发
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                    <v-alert
                      v-if="heartbeatTriggerResult"
                      :type="heartbeatTriggerResult.ok ? 'success' : 'error'"
                      variant="tonal"
                      density="compact"
                      class="mt-2"
                    >
                      {{ heartbeatTriggerResult.message }}
                    </v-alert>
                    <div class="adapter-log-panel mt-3">
                      <div class="section-title-row compact-row">
                        <div>
                          <div class="section-title small-title">适配器日志</div>
                          <div class="section-note">启用、tick 和投递过程日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="adapterLogEntries('heartbeat').length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in adapterLogEntries('heartbeat')"
                            :key="`${entry.path}-${entry.messageId || logIndex}`"
                          >
                            <v-expansion-panel-title>
                              <div class="adapter-log-title">
                                <span>{{ formatLogTime(entry) }}</span>
                                <b>{{ logEventTitle(entry) }}</b>
                                <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                              </div>
                            </v-expansion-panel-title>
                            <v-expansion-panel-text>
                              <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                              <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                              <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                            </v-expansion-panel-text>
                          </v-expansion-panel>
                        </v-expansion-panels>
                      </div>
                      <div v-else class="empty-state compact-empty">
                        <div>
                          <strong>暂无心跳适配器日志</strong>
                          <span>{{ adapterLogPaths('heartbeat').join(' / ') || '等待启动或触发后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">消息文件</div>
                        <div class="section-note">{{ messageFilePaths('heartbeat').join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="messageFileEntries('heartbeat').length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in messageFileEntries('heartbeat').slice(0, 3)"
                            :key="`${entry.path}-${entry.messageId || messageIndex}`"
                          >
                            {{ formatLogTime(entry) }} · {{ logPreview(entry) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </template>
  </template>
</template>
