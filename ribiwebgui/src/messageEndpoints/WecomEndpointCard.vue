<script setup lang="ts">
import { computed } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import type { MessageAdapterType } from "../types";
import { adapterRuntimeKey, applyAdapterDefaults } from "../utils/gatewayHelpers";
import MessageEndpointDependencyPanel from "./MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const runtime = computed(() => store.selectedRuntime);

const gateway = computed(() => store.selectedGateway);

const wecomState = computed(() => runtime.value.gatewayStatus?.messageAdapters?.wecom || runtime.value.gatewayStatus?.wecom || {} as Record<string, any>);

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
const endpointProps = defineProps<{ context?: import("./messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

</script>
<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading" :error="context?.scanError" @refresh="context?.refreshScan?.()"  />
<div class="catalog-param-grid">
                    <v-text-field v-model="gateway.wecomBotId" label="企业微信 Bot ID" placeholder="可留空使用 WECOM_BOT_ID" @update:model-value="touch" />
                    <v-text-field v-model="gateway.wecomBotSecret" type="password" label="企业微信 Bot Secret" placeholder="可留空使用 WECOM_BOT_SECRET" @update:model-value="touch" />
                    <v-text-field v-model="gateway.wecomWsUrl" class="full-span" label="企业微信 WebSocket 地址" placeholder="留空使用 SDK 默认地址；私有部署时填写" @update:model-value="touch" />
                    <v-alert type="info" variant="tonal" density="compact" class="full-span">
                      企业微信消息端使用智能机器人 WebSocket 长连接，主场景是企业微信群聊；模板变量会尽量对齐 NapCat 的 groupId、userId、sender、message 和 messageId。
                    </v-alert>
                  </div>
<template v-if="runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>连接</span><b :class="wecomState.connected && wecomState.authenticated ? 'text-success' : 'text-warning'">{{ wecomState.connected && wecomState.authenticated ? "已认证" : wecomState.message || "未连接" }}</b></div>
                    <div class="status-row"><span>最近消息</span><b>{{ wecomState.lastMessageAt || "-" }}</b></div>
                    <div class="status-row"><span>消息数</span><b>{{ wecomState.messageCount ?? 0 }}</b></div>
                    <v-alert v-if="wecomState.lastError" type="error" variant="tonal" density="compact" class="mt-2">
                      {{ wecomState.lastError }}
                    </v-alert>
                    <div class="adapter-log-panel mt-3">
                      <div class="section-title-row compact-row">
                        <div>
                          <div class="section-title small-title">企业微信适配器日志</div>
                          <div class="section-note">连接、认证、消息接收和错误日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="adapterLogEntries('wecom').length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in adapterLogEntries('wecom')"
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
                          <strong>暂无企业微信适配器日志</strong>
                          <span>{{ adapterLogPaths('wecom').join(' / ') || '等待启动后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">消息文件</div>
                        <div class="section-note">{{ messageFilePaths('wecom').join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="messageFileEntries('wecom').length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in messageFileEntries('wecom').slice(0, 3)"
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
