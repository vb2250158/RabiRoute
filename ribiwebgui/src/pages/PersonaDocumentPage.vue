<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { renderMarkdownPreview } from "../markdownPreview";
import { personaOptionDisplayName } from "../personaPresentation";
import { loadPersonaDocument as readPersonaDocument } from "../persona/personaDocumentClient";
import { routeScopedPersonaPath } from "../routeScopedNavigation";
import { useRoleStore } from "../stores/roleStore";
import { configNameFor } from "../utils/gatewayHelpers";

const route = useRoute();
const store = useRoleStore();
const loadedPersonaSource = ref("");
const loadedPersonaError = ref("");
const personaLoading = ref(false);
let personaRequestVersion = 0;

const routeKey = computed(() => String(route.params.id || ""));
const gateway = computed(() => store.selectedGateway);
const runtime = computed(() => store.selectedRuntime);
const isRemotePersona = computed(() => Boolean(gateway.value?.agentRoleDeviceId));
const selectedRole = computed(() => {
  if (isRemotePersona.value) return undefined;
  const roleId = gateway.value?.agentRoleId || "";
  return (runtime.value?.roleInfo?.options || []).find(role => role.value === roleId);
});
const personaSource = computed(() => isRemotePersona.value ? loadedPersonaSource.value : loadedPersonaSource.value
  || selectedRole.value?.roleContent
  || runtime.value?.roleInfo?.selectedRoleContent
  || "");
const personaError = computed(() => isRemotePersona.value ? loadedPersonaError.value : loadedPersonaError.value
  || selectedRole.value?.roleError
  || runtime.value?.roleInfo?.selectedRoleError
  || "");
const personaPath = computed(() => isRemotePersona.value
  ? `远端 PC ${gateway.value?.agentRoleDeviceId} · ${gateway.value?.agentRoleId}/${gateway.value?.agentRoleFile || "persona.md"}`
  : selectedRole.value?.rolePath
  || runtime.value?.roleInfo?.selectedRolePath
  || "persona.md");
const personaName = computed(() => selectedRole.value
  ? personaOptionDisplayName(selectedRole.value)
  : gateway.value?.agentRoleId || "当前角色");
const renderedMarkdown = computed(() => renderMarkdownPreview(personaSource.value));
const backPath = computed(() => `/roles/${encodeURIComponent(store.selectedRoleId)}/config`);

async function loadPersonaDocument(): Promise<void> {
  const roleId = gateway.value?.agentRoleId || "";
  const fileName = gateway.value?.agentRoleFile || "persona.md";
  const requestVersion = ++personaRequestVersion;
  loadedPersonaSource.value = "";
  loadedPersonaError.value = "";
  personaLoading.value = false;
  if (!roleId) return;
  const embedded = isRemotePersona.value ? "" : selectedRole.value?.roleContent || runtime.value?.roleInfo?.selectedRoleContent || "";
  if (embedded) {
    loadedPersonaSource.value = embedded;
    return;
  }
  personaLoading.value = true;
  try {
    const result = await readPersonaDocument(roleId, fileName, gateway.value?.agentRoleDeviceId || "");
    if (requestVersion === personaRequestVersion) {
      loadedPersonaSource.value = result;
    }
  } catch (loadError) {
    if (requestVersion === personaRequestVersion) {
      loadedPersonaError.value = userFacingError(loadError);
    }
  } finally {
    if (requestVersion === personaRequestVersion) personaLoading.value = false;
  }
}

watch(
  [() => gateway.value?.agentRoleDeviceId, () => gateway.value?.agentRoleId, () => gateway.value?.agentRoleFile, () => selectedRole.value?.roleContent],
  () => { void loadPersonaDocument(); },
  { immediate: true }
);
</script>

<template>
  <div class="page-shell persona-document-page">
    <div class="page-header">
      <div>
        <h1 class="page-title">角色正文</h1>
        <div class="page-subtitle" data-no-i18n>{{ personaName }} · {{ personaPath }}</div>
      </div>
      <div class="page-actions">
        <v-btn :to="backPath" variant="tonal" prepend-icon="mdi-arrow-left">返回角色配置</v-btn>
      </div>
    </div>

    <v-card class="app-card glass-card section-card persona-document-stage">
      <div v-if="(store.loading && !gateway) || (personaLoading && !personaSource)" class="knowledge-plan-markdown-loading" aria-live="polite">
        <v-progress-circular indeterminate color="secondary" />
        <span>正在加载角色正文…</span>
      </div>
      <v-alert v-else-if="!gateway" type="warning" variant="tonal">
        没有找到这条路由，请返回角色配置页重新选择。
      </v-alert>
      <v-alert v-else-if="personaError" type="error" variant="tonal">{{ personaError }}</v-alert>
      <v-alert v-else-if="!personaSource" type="info" variant="tonal">角色正文为空。</v-alert>
      <article
        v-else
        class="knowledge-plan-markdown-document persona-markdown-document"
        data-no-i18n
        v-html="renderedMarkdown"
      />
    </v-card>
  </div>
</template>
