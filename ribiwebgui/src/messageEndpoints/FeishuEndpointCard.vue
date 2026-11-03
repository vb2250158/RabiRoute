<script setup lang="ts">
import { computed } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import type { MessageAdapterType } from "../types";
import { adapterDefaultWebhookPath, applyAdapterDefaults } from "../utils/gatewayHelpers";
import MessageEndpointDependencyPanel from "./MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const runtime = computed(() => store.selectedRuntime);

const gateway = computed(() => store.selectedGateway);

const feishuState = computed(() => runtime.value.gatewayStatus?.messageAdapters?.feishu || runtime.value.gatewayStatus?.feishu || {} as Record<string, any>);

function touch(): void { if (gateway.value) applyAdapterDefaults(gateway.value); store.touch(); }

function webhookPortFor(_type: MessageAdapterType): number { return Number(gateway.value?.feishuWebhookPort || gateway.value?.gatewayPort || 8790); }

function webhookPathFor(type: MessageAdapterType): string { return gateway.value?.feishuWebhookPath || adapterDefaultWebhookPath(type); }

function setWebhookPort(_type: MessageAdapterType, value: unknown): void { if (!gateway.value) return; gateway.value.feishuWebhookPort = Number(value || 0); touch(); }

function setWebhookPath(_type: MessageAdapterType, value: unknown): void { if (!gateway.value) return; gateway.value.feishuWebhookPath = String(value || ""); touch(); }
const endpointProps = defineProps<{ context?: import("./messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

</script>
<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading" :error="context?.scanError" @refresh="context?.refreshScan?.()"  />
<div class="catalog-param-grid">
                    <v-text-field v-model="gateway.feishuAppId" label="飞书 App ID" placeholder="cli_xxx" @update:model-value="touch" />
                    <v-text-field v-model="gateway.feishuAppSecret" type="password" label="飞书 App Secret" @update:model-value="touch" />
                    <v-text-field v-model="gateway.feishuVerificationToken" type="password" label="Verification Token" @update:model-value="touch" />
                    <v-text-field v-model="gateway.feishuEncryptKey" type="password" label="Encrypt Key" @update:model-value="touch" />
                    <v-text-field :model-value="webhookPortFor('feishu')" type="number" label="本机回调端口" @update:model-value="value => setWebhookPort('feishu', value)" />
                    <v-text-field :model-value="webhookPathFor('feishu')" label="独立回调路径" placeholder="/feishu" @update:model-value="value => setWebhookPath('feishu', value)" />
                    <v-switch
                      v-model="gateway.feishuEventSubscriptionEnabled"
                      class="full-span"
                      color="primary"
                      density="compact"
                      hide-details
                      label="已在飞书应用中配置公网 HTTPS 回调并订阅 im.message.receive_v1"
                      @update:model-value="touch"
                    />
                    <v-alert type="warning" variant="tonal" density="compact" class="full-span">
                      这里仅接受飞书应用凭据与事件订阅配置。群机器人 Webhook 属于通用 Webhook 预留，不能作为飞书消息端。
                    </v-alert>
                    <v-alert type="info" variant="tonal" density="compact" class="full-span">
                      未同时配置 App ID、App Secret、Verification Token、Encrypt Key，并勾选事件订阅确认时，监听和出站都会保持关闭。
                    </v-alert>
                  </div>
<template v-if="runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>回调监听</span><b :class="feishuState.listenerReady ? 'text-success' : 'text-warning'">{{ feishuState.listenerReady ? "已监听" : feishuState.message || "保持关闭" }}</b></div>
                    <div class="status-row"><span>订阅验证</span><b :class="feishuState.subscriptionVerified ? 'text-success' : 'text-warning'">{{ feishuState.subscriptionVerified ? "已收到验证/事件" : "尚未验证" }}</b></div>
                    <div class="status-row"><span>最近消息</span><b>{{ feishuState.lastMessageAt || "-" }}</b></div>
                    <div class="status-row"><span>最近事件 ID</span><b>{{ feishuState.lastEventId || "-" }}</b></div>
                  </template>
  </template>
</template>
