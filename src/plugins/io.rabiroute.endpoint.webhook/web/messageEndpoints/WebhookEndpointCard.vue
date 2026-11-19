<script setup lang="ts">
import { computed, ref } from "vue";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import type { MessageAdapterType } from "../../../../../ribiwebgui/src/types";
import { adapterDefaultWebhookPath, adapterLabel, adapterSourceAliases } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { copyTextToClipboard } from "../../../../../ribiwebgui/src/clipboard";
import MessageEndpointDependencyPanel from "../../../../../ribiwebgui/src/messageEndpoints/MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();


const runtime = computed(() => store.selectedRuntime);

const gateway = computed(() => store.selectedGateway);

const copyResult = ref("");

function normalizedPath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function webhookPortFor(_type: MessageAdapterType): number { return Number(gateway.value?.webhookPort || gateway.value?.gatewayPort || 8790); }

function webhookPathFor(type: MessageAdapterType): string { return gateway.value?.webhookPath || adapterDefaultWebhookPath(type); }

function webhookHostFor(_type: MessageAdapterType): string { return "127.0.0.1"; }

function callbackHostFor(type: MessageAdapterType): string { const host = webhookHostFor(type); return host; }

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

const endpointProps = defineProps<{ context?: import("../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

</script>
<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading" :error="context?.scanError" @refresh="context?.refreshScan?.()"  />
<template v-if="runtime.running !== undefined">
                    <div class="status-row"><span>监听地址</span><b>{{ webhookUrl('webhook') }}</b></div>
                    <div class="agent-action-bar mt-2">
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-copy" @click="copyText(callbackUrl('webhook'), `已复制 ${sourceTitle('webhook')} 回调地址`)">
                          复制回调
                        </v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-console" @click="copyText(webhookCurl('webhook'), '已复制 curl 示例')">
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
