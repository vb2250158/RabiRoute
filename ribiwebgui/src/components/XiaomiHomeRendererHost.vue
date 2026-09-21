<script setup lang="ts">
import { ref } from "vue";
import type { WebRendererContribution } from "../pluginRenderers";
import TrustedWebRendererHost from "./TrustedWebRendererHost.vue";

defineProps<{
  renderers: readonly WebRendererContribution[];
  context?: unknown;
}>();

const activeTab = ref("setup");
const tabs = [
  { value: "setup", title: "Setup", rendererId: "builtin.xiaomi-home-auth.v1" },
  { value: "settings", title: "设置", rendererId: "builtin.xiaomi-home-message-endpoint.v1" }
] as const;
</script>

<template>
  <div class="xiaomi-home-tabs">
    <v-tabs v-model="activeTab" aria-label="米家" color="primary" class="mb-4">
      <v-tab v-for="tab in tabs" :key="tab.value" :value="tab.value">{{ tab.title }}</v-tab>
    </v-tabs>
    <section
      v-for="tab in tabs"
      v-show="activeTab === tab.value"
      :key="tab.value"
      :aria-label="tab.title"
    >
      <TrustedWebRendererHost
        :renderers="renderers.filter(renderer => renderer.rendererId === tab.rendererId)"
        :context="context"
      />
    </section>
  </div>
</template>
