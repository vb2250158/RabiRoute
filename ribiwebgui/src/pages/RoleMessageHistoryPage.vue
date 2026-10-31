<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import PersonaChatHistory from "../components/PersonaChatHistory.vue";
import { providePersonaService } from "../persona/personaServiceClient";
import { useI18n } from "../i18n";

const route = useRoute();
const { t } = useI18n();
const roleId = String(route.params.roleId || "");
const service = providePersonaService(String(route.query.source || ""));
const version = ref(0);
let events: EventSource | undefined;
onMounted(() => {
  if (!roleId) return;
  events = service.events("/api/events");
  events.addEventListener("ready", () => { version.value += 1; });
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
    <PersonaChatHistory v-if="roleId" :role-id="roleId" :version="version" />
    <v-alert v-else type="info" variant="tonal">{{ t('请选择或新建角色。') }}</v-alert>
  </div>
</template>
