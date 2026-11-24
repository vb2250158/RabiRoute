<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { useRoute, useRouter } from "vue-router";

const SpeechModels = defineAsyncComponent(() => import("../../../../../ribiwebgui/src/pages/ModelManagementPage.vue"));
const WorkbenchModels = defineAsyncComponent(() => import("../../../io.rabiroute.manager.video/web/pages/WorkbenchModelService.vue"));
const route = useRoute();
const router = useRouter();
const tab = computed(() => route.query.tab === "workbench" ? "workbench" : "speech");
</script>

<template>
  <div class="page-shell">
    <v-tabs :model-value="tab" color="primary" class="mb-4"
      @update:model-value="value => router.replace({ query: { ...route.query, tab: String(value) } })">
      <v-tab value="speech">语音模型</v-tab>
      <v-tab value="workbench">工作台模型</v-tab>
    </v-tabs>
    <SpeechModels v-if="tab === 'speech'" />
    <WorkbenchModels v-else />
  </div>
</template>
