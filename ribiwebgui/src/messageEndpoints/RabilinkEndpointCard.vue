<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { userFacingError } from "../userFacingError";
import { useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import type { MessageAdapterType } from "../types";
import { adapterDefaultWebhookPath, adapterLabel, adapterRuntimeKey, adapterSourceAliases, configNameFor, isWebhookLikeAdapter } from "../utils/gatewayHelpers";
import { copyTextToClipboard } from "../clipboard";
import { routeScopedRuntimePath } from "../routeScopedNavigation";
import MessageEndpointDependencyPanel from "./MessageEndpointDependencyPanel.vue";

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

const mobileRecordingInfo = ref<{
  devices: Array<{ id: string; lastReceivedAt: number }>;
  loading: boolean;
}>({ devices: [], loading: false });

async function loadMobileRecordingInfo(): Promise<void> {
  const roleId = gateway.value?.agentRoleId;
  if (!roleId) return;
  mobileRecordingInfo.value.loading = true;
  try {
    const res = await fetch(`/api/roles/${encodeURIComponent(roleId)}/all-day-recording`);
    if (res.ok) {
      const json = await res.json();
      if (gateway.value?.agentRoleId === roleId && json.code === 0 && json.data) {
        mobileRecordingInfo.value.devices = json.data.devices || [];
      }
    }
  } catch (err) {
    console.error("Failed to load mobile recording info:", err);
  } finally {
    if (gateway.value?.agentRoleId === roleId) mobileRecordingInfo.value.loading = false;
  }
}

async function bindMobileRecordingToCurrentRole(): Promise<void> {
  const roleId = gateway.value?.agentRoleId;
  if (!roleId) return;
  try {
    const res = await fetch(`/api/roles/${encodeURIComponent(roleId)}/all-day-recording`);
    if (!res.ok) return;
    const json = await res.json();
    if (json.code !== 0 || !json.data) return;
    const snapshot = json.data;
    const devices: Array<{ id: string }> = snapshot.devices || [];
    const currentDeviceIds: string[] = snapshot.settings?.mobileDeviceIds || [];
    const allDeviceIds = [...new Set([...currentDeviceIds, ...devices.map(d => d.id)])];

    if (allDeviceIds.length > currentDeviceIds.length) {
      await fetch(`/api/roles/${encodeURIComponent(roleId)}/all-day-recording/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...snapshot.settings,
          mobileDeviceIds: allDeviceIds
        })
      });
    }
    await loadMobileRecordingInfo();
  } catch (err) {
    console.error("Failed to bind mobile recording devices:", err);
  }
}

function normalizedPath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function webhookPortFor(_type: MessageAdapterType): number { return Number(gateway.value?.rabiLinkWebhookPort || gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790); }

function webhookPathFor(type: MessageAdapterType): string { return gateway.value?.rabiLinkWebhookPath || adapterDefaultWebhookPath(type); }

function webhookHostFor(_type: MessageAdapterType): string { return gateway.value?.rabiLinkWebhookHost || "0.0.0.0"; }

function isUnspecifiedHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function localCallbackHost(): string {
  const browserHost = window.location.hostname;
  if (browserHost && !isUnspecifiedHttpHost(browserHost) && browserHost !== "localhost" && !browserHost.startsWith("127.")) {
    return browserHost;
  }
  return store.networkOptions.localAddresses?.find((item) => item.address)?.address || "127.0.0.1";
}

function callbackHostFor(type: MessageAdapterType): string { const host = webhookHostFor(type); return isUnspecifiedHttpHost(host) ? localCallbackHost() : host; }

function webhookUrl(type: MessageAdapterType = "webhook"): string {
  return `http://${webhookHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function callbackUrl(type: MessageAdapterType = "webhook"): string {
  return `http://${callbackHostFor(type)}:${webhookPortFor(type)}${normalizedPath(webhookPathFor(type), adapterDefaultWebhookPath(type))}`;
}

function webhookTestEventType(_type: MessageAdapterType): string { return "rabilink.message"; }

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
defineExpose({ onEnabledChange: (enabled: boolean) => enabled ? bindMobileRecordingToCurrentRole() : undefined, onAdded: bindMobileRecordingToCurrentRole });

const endpointProps = defineProps<{ context?: import("./messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);
watch([() => endpointProps.context?.routeId, () => endpointProps.context?.active],
  ([, active]) => { if (active) void loadMobileRecordingInfo(); }, { immediate: true });

</script>
<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading" :error="context?.scanError" @refresh="context?.refreshScan?.()"  />
<template>
                    <div class="status-row"><span>绑定人员</span><b>{{ gateway?.agentRoleId || "未绑定" }}</b></div>
                    <div class="status-row"><span>已关联手机设备</span>
                      <b>
                        <span v-if="mobileRecordingInfo.devices.length">
                          {{ mobileRecordingInfo.devices.map(d => `手机 ${d.id.slice(0, 8)} (${new Date(d.lastReceivedAt).toLocaleString()})`).join('、') }}
                        </span>
                        <span v-else class="muted">尚未收到手机事件或暂无发现的设备</span>
                      </b>
                    </div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">移动端（手机、手环或眼镜）通过 RabiLink 上传的全天记录事件将汇流并绑定到当前人员。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-timeline-clock-outline" :to="`/routes/${encodeURIComponent(gateway?.agentRoleId || '')}/persona`">
                          前往全天记录
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="mobileRecordingInfo.loading" @click="loadMobileRecordingInfo">
                          刷新设备
                        </v-btn>
                      </div>
                    </div>
                  </template>
<template v-if="runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>监听地址</span><b>{{ webhookUrl('rabilink') }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="agent-action-status">
                        <span class="section-note">{{ sourceTitle('rabilink') }} 使用 HTTP 回调接收事件。</span>
                      </div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText(callbackUrl('rabilink'), `已复制 ${sourceTitle('rabilink')} 回调地址`)">
                          复制回调
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-console" @click="copyText(webhookCurl('rabilink'), '已复制 curl 示例')">
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
                          <div class="section-title small-title">{{ sourceTitle('rabilink') }} 适配器日志</div>
                          <div class="section-note">按 voiceSource / source 匹配请求、接收、拒绝和错误等过程日志。</div>
                        </div>
                        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.load">刷新</v-btn>
                      </div>
                      <div v-if="sourceLogEntries('rabilink').length" class="adapter-log-list">
                        <v-expansion-panels variant="accordion" density="compact">
                          <v-expansion-panel
                            v-for="(entry, logIndex) in sourceLogEntries('rabilink')"
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
                          <strong>暂无 {{ sourceTitle('rabilink') }} 日志</strong>
                          <span>{{ adapterLogPaths('rabilink').join(' / ') || '等待启动或收到请求后生成日志。' }}</span>
                        </div>
                      </div>
                      <div class="adapter-message-file-panel mt-2">
                        <div class="section-title small-title">{{ sourceTitle('rabilink') }} 消息文件</div>
                        <div class="section-note">{{ messageFilePaths('rabilink').join(' / ') || '尚未生成消息文件。' }}</div>
                        <div v-if="sourceMessageFileEntries('rabilink').length" class="adapter-message-preview">
                          <div
                            v-for="(entry, messageIndex) in sourceMessageFileEntries('rabilink').slice(0, 3)"
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
