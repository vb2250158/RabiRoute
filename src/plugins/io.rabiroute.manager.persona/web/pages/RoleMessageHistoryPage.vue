<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import PersonaMessageHistory from "../components/PersonaMessageHistory.vue";
import { providePersonaService } from "../persona/personaServiceClient";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";

const route = useRoute();
const { t } = useI18n();
const roleId = String(route.params.roleId || "");
const service = providePersonaService(String(route.query.source || ""));
const version = ref(0);
const messageVersion = ref(0);
let events: EventSource | undefined;
let connected = false;
onMounted(() => {
  if (!roleId) return;
  events = service.events("/api/events");
  events.addEventListener("ready", () => {
    if (connected) { version.value += 1; messageVersion.value += 1; }
    connected = true;
  });
  events.addEventListener("message_endpoint_history_changed", raw => {
    try {
      const data = JSON.parse((raw as MessageEvent).data);
      if (data.roleId === roleId) messageVersion.value += 1;
    } catch { /* Malformed invalidations do not alter the current conversation. */ }
  });
  events.addEventListener("persona_chat_history_changed", raw => {
    try {
      const data = JSON.parse((raw as MessageEvent).data);
      if (data.roleId === roleId) version.value += 1;
    } catch { /* Ignore malformed events; manual refresh remains available. */ }
  });
});
onBeforeUnmount(() => { events?.close(); });
</script>

<template>
  <div class="page-shell">
    <PersonaMessageHistory v-if="roleId" :key="roleId" :role-id="roleId" :version="version" :message-version="messageVersion" />
    <v-alert v-else type="info" variant="tonal">{{ t('请选择或新建角色。') }}</v-alert>
  </div>
</template>

<style scoped>
.page-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: calc(100dvh - 64px); min-height: 0; padding-bottom: 16px; }
</style>
