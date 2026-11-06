<script setup lang="ts">
import { computed, ref } from "vue";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { useRouter } from "vue-router";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import type { MessageAdapterType } from "../../../../../ribiwebgui/src/types";
import { adapterDefaultWebhookPath, adapterLabel, adapterRuntimeKey, adapterSourceAliases, applyAdapterDefaults, configNameFor, isWebhookLikeAdapter } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { copyTextToClipboard } from "../../../../../ribiwebgui/src/clipboard";
import { routeScopedRuntimePath } from "../../../../../ribiwebgui/src/routeScopedNavigation";
import MessageEndpointDependencyPanel from "../../../../../ribiwebgui/src/messageEndpoints/MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const router = useRouter();

const runtime = computed(() => store.selectedRuntime);

const gateway = computed(() => store.selectedGateway);

const copyResult = ref("");

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

function normalizedPath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function webhookPortFor(_type: MessageAdapterType): number { return Number(gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790); }

function webhookPathFor(type: MessageAdapterType): string { return gateway.value?.webhookPath || adapterDefaultWebhookPath(type); }

function webhookHostFor(_type: MessageAdapterType): string { return "127.0.0.1"; }

function callbackHostFor(type: MessageAdapterType): string { const host = webhookHostFor(type); return host; }

function setWebhookPort(_type: MessageAdapterType, value: unknown): void { if (!gateway.value) return; gateway.value.webhookPort = Number(value || 0); touch(); }

function setWebhookPath(_type: MessageAdapterType, value: unknown): void { if (!gateway.value) return; gateway.value.webhookPath = String(value || ""); touch(); }

function webhookUrl(type: MessageAdapterType = "webhook"): string {
  return `http://${webhookHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function callbackUrl(type: MessageAdapterType = "webhook"): string {
  return `http://${callbackHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function webhookTestEventType(_type: MessageAdapterType): string { return "webhook.text"; }

function webhookCurl(type: MessageAdapterType = "webhook"): string {
  const source = adapterSourceAliases(type)[0] || type;
  const eventType = webhookTestEventType(type);
  return `curl -X POST "${callbackUrl(type)}" -H "content-type: application/json" -d "{\"source\":\"${source}\",\"type\":\"${eventType}\",\"message\":\"hello from RabiRoute\"}"`;
}

function sourceLogEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return adapterLogEntries(type);
}

function sourceMessageFileEntries(type: MessageAdapterType): Array<Record<string, any>> {
  return messageFileEntries(type);
}

function sourceTitle(type: MessageAdapterType): string {
  return adapterLabel(type);
}

async function copyText(text: string, message = "已复制"): Promise<void> {
  let result = message;
  try {
    await copyTextToClipboard(text);
  } catch (error) {
    result = `复制失败：${userFacingError(error)}`;
  }
  copyResult.value = result;
  window.setTimeout(() => {
    if (copyResult.value === result) copyResult.value = "";
  }, 1800);
}

function openRuntimeLog(): void {
  const name = store.selectedGateway ? configNameFor(store.selectedGateway) : "";
  void router.push(routeScopedRuntimePath(name));
}
const endpointProps = defineProps<{ context?: import("../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

</script>
<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading" :error="context?.scanError" @refresh="context?.refreshScan?.()"  />
<div class="catalog-param-grid">
                    <v-text-field :model-value="webhookPortFor('webhook')" type="number" :label="`${sourceTitle('webhook')} 监听端口`" @update:model-value="value => setWebhookPort('webhook', value)" />
                    <v-text-field :model-value="webhookPathFor('webhook')" :label="`${sourceTitle('webhook')} 路径`" :placeholder="adapterDefaultWebhookPath('webhook')" @update:model-value="value => setWebhookPath('webhook', value)" />
                  </div>
<template v-if="runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>监听地址</span><b>{{ webhookUrl('webhook') }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">{{ sourceTitle('webhook') }} 使用 HTTP 回调接收事件。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText(callbackUrl('webhook'), `已复制 ${sourceTitle('webhook')} 回调地址`)">
                          复制回调
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-console" @click="copyText(webhookCurl('webhook'), '已复制 curl 示例')">
                          复制 curl
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">
                          打开日志
                        </v-btn>
                      </div>
                    </div>
                    <v-alert v-if="copyResult" type="success" variant="tonal" density="compact" class="mt-2">
                      {{ copyResult }}
                    </v-alert>
                    <div class="adapter-log-panel mt-3">
                      <div class="section-title-row compact-row">
                        <div>
                          <div class="section-title small-title">{{ sourceTitle('webhook') }} 适配器日志</div>
                          <div class="section-note">按 voiceSource / source 匹配请求、接收、拒绝和错误等过程日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="sourceLogEntries('webhook').length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in sourceLogEntries('webhook')"
                            :key="`${entry.path}-${entry.messageId || logIndex}`"
                          >
                            <v-expansion-panel-title>
                              <div class="adapter-log-title">
                                <span>{{ formatLogTime(entry) }}</span>
                                <b>{{ logEventTitle(entry) }}</b>
                                <span>{{ entry.sender || "-" }}</span>
                                <span class="adapter-log-text">{{ logPreview(entry) }}</span>
                              </div>
                            </v-expansion-panel-title>
                            <v-expansion-panel-text>
                              <div class="status-row"><span>消息 ID</span><b>{{ entry.messageId || "-" }}</b></div>
                              <div class="status-row"><span>来源</span><b>{{ entry.sender || entry.target || "-" }}</b></div>
                              <div class="status-row"><span>日志文件</span><b>{{ entry.path }}</b></div>
                              <pre class="mono-box compact-mono">{{ rawLogJson(entry) }}</pre>
                            </v-expansion-panel-text>
                          </v-expansion-panel>
                        </v-expansion-panels>
                      </div>
                      <div v-else class="empty-state compact-empty">
                        <div>
                          <strong>暂无 {{ sourceTitle('webhook') }} 日志</strong>
                          <span>{{ adapterLogPaths('webhook').join(' / ') || '等待启动或收到请求后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">{{ sourceTitle('webhook') }} 消息文件</div>
                        <div class="section-note">{{ messageFilePaths('webhook').join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="sourceMessageFileEntries('webhook').length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in sourceMessageFileEntries('webhook').slice(0, 3)"
                            :key="`${entry.path}-${entry.messageId || messageIndex}`"
                          >
                            {{ formatLogTime(entry) }} · {{ entry.source }} · {{ logPreview(entry) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </template>
  </template>
</template>
