<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import type { MessageAdapterType } from "../../../../../ribiwebgui/src/types";
import { adapterDefaultWebhookPath, adapterLabel, adapterSourceAliases } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { copyTextToClipboard } from "../../../../../ribiwebgui/src/clipboard";
import { publishedHttpCallbackUrl } from "../../../../../ribiwebgui/src/webhookRuntimeEndpoint";
import MessageEndpointDependencyPanel from "../../../../../ribiwebgui/src/messageEndpoints/MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();


const runtime = computed(() => store.selectedRuntime);

const gateway = computed(() => store.selectedGateway);

const copyResult = ref("");

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

function webhookPortFor(_type: MessageAdapterType): number { return Number(gateway.value?.rabiLinkWebhookPort ?? 0); }

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

function webhookUrl(type: MessageAdapterType = "rabilink"): string {
  return publishedHttpCallbackUrl(runtime.value, "rabilink", normalizedPath(webhookPathFor(type), "/rabilink"), webhookHostFor(type));
}

function callbackUrl(type: MessageAdapterType = "rabilink"): string {
  const published = webhookUrl(type);
  if (!published) return "";
  const url = new URL(published); url.hostname = callbackHostFor(type); return url.href;
}

function webhookTestEventType(_type: MessageAdapterType): string { return "rabilink.message"; }

function webhookCurl(type: MessageAdapterType = "rabilink"): string {
  if (!callbackUrl(type)) return "";
  const source = adapterSourceAliases(type)[0] || type;
  const eventType = webhookTestEventType(type);
  return `curl -X POST "${callbackUrl(type)}" -H "content-type: application/json" -d "{\"source\":\"${source}\",\"type\":\"${eventType}\",\"message\":\"hello from RabiRoute\"}"`;
}

function sourceTitle(type: MessageAdapterType): string {
  return adapterLabel(type);
}

async function copyText(text: string, message = "已复制"): Promise<void> {
  if (!text.trim()) { copyResult.value = "等待监听就绪"; return; }
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

defineExpose({ onEnabledChange: (enabled: boolean) => enabled ? bindMobileRecordingToCurrentRole() : undefined, onAdded: bindMobileRecordingToCurrentRole });

const endpointProps = defineProps<{ context?: import("../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCardContext").MessageEndpointCardContext }>();
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
                    <div class="status-row"><span>监听地址</span><b>{{ webhookUrl('rabilink') || "等待监听就绪" }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" :disabled="!callbackUrl('rabilink')" @click="copyText(callbackUrl('rabilink'), `已复制 ${sourceTitle('rabilink')} 回调地址`)">
                          复制回调
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-console" :disabled="!callbackUrl('rabilink')" @click="copyText(webhookCurl('rabilink'), '已复制 curl 示例')">
                          复制 curl
                        </v-btn>
                      </div>
                    </div>
                    <v-alert v-if="copyResult" type="success" variant="tonal" density="compact" class="mt-2">
                      {{ copyResult }}
                    </v-alert>
                  </template>
  </template>
</template>
