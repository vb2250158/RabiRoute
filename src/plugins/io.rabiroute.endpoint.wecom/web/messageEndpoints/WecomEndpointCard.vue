<script setup lang="ts">
import { computed } from "vue";
import { useEndpointQrPairing } from "../../../../../ribiwebgui/src/messageEndpoints/useEndpointQrPairing";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { applyAdapterDefaults } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import MessageEndpointDependencyPanel from "../../../../../ribiwebgui/src/messageEndpoints/MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const runtime = computed(() => store.selectedRuntime);

const gateway = computed(() => store.selectedGateway);

const wecomState = computed(() => runtime.value.gatewayStatus?.messageAdapters?.wecom || runtime.value.gatewayStatus?.wecom || {} as Record<string, any>);

function touch(): void { if (gateway.value) applyAdapterDefaults(gateway.value); store.touch(); }
const endpointProps = defineProps<{ context?: import("../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

const { showingQr, qrImage, error: qrError, ready, scan, manual } = useEndpointQrPairing(
  "wecom", context, () => Boolean(gateway.value?.wecomBotId),
  async routeId => { if (store.dirty) await store.save(routeId); },
  () => store.load()
);
</script>
<template>
  <div v-if="gateway">
    <v-tabs v-if="context?.loginRequested" :model-value="showingQr ? 'qr' : 'manual'"
      class="mb-3" density="compact" color="primary" grow @update:model-value="mode => mode === 'qr' ? scan() : manual()">
      <v-tab value="qr">扫码登录</v-tab>
      <v-tab value="manual">手动填写</v-tab>
    </v-tabs>
    <div v-if="showingQr" class="endpoint-qr">
      <template v-if="qrImage">
        <p role="status" class="text-body-2 mb-0">用企业微信扫码授权机器人</p>
        <img :src="qrImage" width="192" height="192" alt="机器人接入二维码" />
      </template>
      <v-progress-circular v-else-if="!qrError" indeterminate color="primary" size="28" aria-label="正在获取二维码" />
      <p v-if="qrError" role="alert" class="text-error text-body-2 mb-0">{{ qrError }}</p>
      <v-btn v-if="qrError" size="small" variant="tonal" @click="scan">重新获取二维码</v-btn>
      <v-btn v-if="!context?.loginRequested" size="small" variant="text" @click="manual">手动填写</v-btn>
    </div>
    <template v-else>
      <v-btn v-if="!context?.loginRequested" size="small" variant="text" prepend-icon="mdi-qrcode-scan" @click="scan">扫码接入</v-btn>
      <p v-if="ready" class="text-body-2 mt-2">已授权</p>
    <div class="catalog-param-grid">
      <v-text-field v-model="gateway.wecomBotId" label="Bot ID" density="compact" hide-details @update:model-value="touch" />
      <v-text-field v-model="gateway.wecomBotSecret" label="Bot Secret" type="password" density="compact"
        hide-details @update:model-value="touch" />
    </div>
    <p v-if="wecomState.authenticated" class="text-body-2 mt-2 mb-0">已认证</p>
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading"
      :error="context?.scanError" @refresh="context?.refreshScan?.()" />
    </template>
  </div>
</template>
<style scoped>
.endpoint-qr {
  display: grid;
  justify-items: center;
  gap: 14px;
  padding: 24px 0;
}
.endpoint-qr img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  background: white;
}
</style>
