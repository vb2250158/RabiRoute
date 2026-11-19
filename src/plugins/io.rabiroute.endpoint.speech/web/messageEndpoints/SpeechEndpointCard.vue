<script setup lang="ts">
import { computed, ref } from "vue";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { useSpeechStore } from "../../../../../ribiwebgui/src/stores/speechStore";
import { configNameFor } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import MessageEndpointDependencyPanel from "../../../../../ribiwebgui/src/messageEndpoints/MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const speech = useSpeechStore();

const speechAdapterActionError = ref("");

const gateway = computed(() => store.selectedGateway);

const personaConfigRoute = computed(() => gateway.value
  ? `/persona/${encodeURIComponent(configNameFor(gateway.value))}`
  : "/persona");

async function persistAndSyncSpeechAdapter(routeId = gateway.value?.id): Promise<void> {
  if (!routeId || gateway.value?.id !== routeId) return;
  speechAdapterActionError.value = "";
  try {
    await store.save(routeId);
    await speech.reconcileMicrophone();
  } catch (cause) {
    speechAdapterActionError.value = userFacingError(cause);
  }
}

defineExpose({ onEnabledChange: () => persistAndSyncSpeechAdapter() });

const endpointProps = defineProps<{ context?: import("../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

</script>
<template>
  <div v-if="gateway">
    <p class="text-body-2 mb-2">{{ gateway.agentRoleId || "未选择角色" }}</p>
    <v-alert v-if="speechAdapterActionError" type="error" variant="tonal" density="compact">
      {{ speechAdapterActionError }}
    </v-alert>
    <v-btn :to="personaConfigRoute" size="small" variant="tonal" prepend-icon="mdi-account-voice">角色语音设置</v-btn>
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading"
      :error="context?.scanError" @refresh="context?.refreshScan?.()" />
  </div>
</template>
